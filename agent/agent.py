import asyncio
import json
import logging
import os
import time
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

from dotenv import load_dotenv
from livekit import rtc
from livekit.agents import (
    Agent,
    AgentServer,
    AgentSession,
    AgentStateChangedEvent,
    ConversationItemAddedEvent,
    ErrorEvent,
    FunctionToolsExecutedEvent,
    JobContext,
    JobProcess,
    SessionUsageUpdatedEvent,
    TurnHandlingOptions,
    UserStateChangedEvent,
    cli,
    inference,
)
from livekit.plugins import silero

import config
import memory
import prompt
import tools

load_dotenv(".env.local")
logger = logging.getLogger("lumi")


class Lumi(Agent):
    def __init__(self) -> None:
        # Starts with the bare persona; tools.refresh_instructions adds the board,
        # calendar and facts once we know who the user is.
        super().__init__(
            instructions=prompt.INSTRUCTIONS,
            tools=[
                tools.create_task,
                tools.update_task,
                tools.delete_task,
                tools.restore_task,
                tools.remember_fact,
                tools.forget_fact,
                tools.look_up,
            ],
        )

    def llm_node(self, chat_ctx, tools, model_settings):
        # Runs before every LLM request. Every request re-sends the whole conversation,
        # which grew ~150 tokens a turn in a live run (2.0K -> 2.9K input tokens), and
        # more tokens mean a slower first token and the 8K tokens/min cap sooner. Old
        # turns aren't needed: the board and facts in the instructions are the truth.
        # Truncating a copy keeps the session's own history whole.
        chat_ctx = chat_ctx.copy().truncate(max_items=config.MAX_HISTORY_ITEMS)
        # See config.sign_tool_calls_for_gemini for why.
        config.sign_tool_calls_for_gemini(chat_ctx)
        return Agent.default.llm_node(self, chat_ctx, tools, model_settings)


def parse_timezone(payload: str) -> str:
    """The IANA timezone from the lumi.start payload, or UTC if it's missing or bad."""
    try:
        name = json.loads(payload)["timezone"]
        ZoneInfo(name)  # raises if the name is unknown
        return name
    except (ValueError, TypeError, KeyError, ZoneInfoNotFoundError):
        return "UTC"


def apologise_if_no_model_answered(session: AgentSession, ev: ErrorEvent) -> None:
    # A non-recoverable LLM error means every model in the fallback chain failed, retries
    # included (free-tier caps). LiveKit then drops the turn without a word: live, the
    # lantern sat on "thinking" for 33 s and went quiet (2026-11-12). A fixed line needs
    # no LLM, and it stays out of the chat history so the model never sees it as a reply.
    if ev.error.type == "llm_error" and not ev.error.recoverable:
        session.say(prompt.NO_MODEL_ANSWERED, add_to_chat_ctx=False)


def usage_delta(before, after) -> dict | None:
    """What one model used between two of a session's running totals (a row of
    provider_usage), or None if nothing changed. `before` is None the first time."""

    def change(field: str):
        # A field one kind lacks (an LLM has no audio) counts as 0.
        return getattr(after, field, 0) - (getattr(before, field, 0) if before else 0)

    row = {
        "kind": after.type.removesuffix("_usage"),
        "model": after.model,
        "input_tokens": change("input_tokens"),
        "output_tokens": change("output_tokens"),
        "audio_seconds": round(change("audio_duration"), 3),
        "characters": change("characters_count"),
    }
    used = row["input_tokens"] or row["output_tokens"] or row["audio_seconds"]
    return row if used or row["characters"] else None


# Metrics writes run beside the conversation, so a turn never waits on them. The set
# holds a reference to each pending write, so it can't be garbage-collected midway.
_metrics_writes: set[asyncio.Task] = set()


def write_metrics(write, conn, row: dict) -> None:
    task = asyncio.create_task(write(conn, row))
    _metrics_writes.add(task)
    task.add_done_callback(_metrics_write_done)


def _metrics_write_done(task: asyncio.Task) -> None:
    _metrics_writes.discard(task)
    # A lost metrics row is not worth failing or slowing a conversation over.
    if not task.cancelled() and task.exception() is not None:
        logger.warning("metrics write failed", exc_info=task.exception())


def prewarm(proc: JobProcess) -> None:
    # Loading the VAD model takes ~1 s; do it once per worker process, not per call.
    proc.userdata["vad"] = silero.VAD.load()


server = AgentServer(setup_fnc=prewarm)


@server.rtc_session(agent_name=config.AGENT_NAME)
async def entrypoint(ctx: JobContext) -> None:
    ctx.log_context_fields = {"room": ctx.room.name}

    # Neon scales to zero, and waking it adds ~0.5 s to the first query. Start now so
    # that happens while the room connects, not on the user's first request.
    job_started = time.monotonic()
    db_connecting = asyncio.create_task(memory.connect(os.environ["DATABASE_URL"]))
    # Startup timings: if "database connected" lands after the room connects, the
    # database is what keeps the Start button waiting.
    db_connecting.add_done_callback(
        lambda _: logger.info(
            "database connected",
            extra={"seconds": round(time.monotonic() - job_started, 3)},
        )
    )

    session = AgentSession(
        stt=config.build_stt(),
        llm=config.build_llm(),
        tts=config.build_tts(),
        vad=ctx.proc.userdata["vad"],
        # v1-mini runs on the worker itself, so it's free. The default v1 goes through
        # LiveKit's cloud inference gateway when hosted, which may count against quota.
        turn_handling=TurnHandlingOptions(
            turn_detection=inference.TurnDetector(version="v1-mini")
        ),
        user_away_timeout=config.IDLE_TIMEOUT_SECONDS,
    )

    # The stages of the current turn, gathered from several events and saved to
    # turn_metrics (for the /stats page) when Lumi's reply is added.
    turn: dict = {}

    @session.on("conversation_item_added")
    def log_turn_latency(ev: ConversationItemAddedEvent) -> None:
        # Each finished assistant message carries the per-stage timings for its turn.
        item = ev.item
        if item.type == "message" and item.role == "assistant" and item.metrics:
            m = item.metrics
            timings = {
                "e2e_latency": m.get("e2e_latency"),
                "llm_ttft": m.get("llm_node_ttft"),
                "tts_ttfb": m.get("tts_node_ttfb"),
                "model": (m.get("llm_metadata") or {}).get("model_name"),
            }
            logger.info("turn latency", extra=timings)
            # Only replies to the user: the greeting is said, with no turn to time.
            if timings["e2e_latency"] is not None:
                write_metrics(memory.record_turn, session.userdata.db, turn | timings)
            turn.clear()
        # The user's message carries the stages before the LLM: how long the final
        # transcript took, and how long the turn detector waited before replying.
        if item.type == "message" and item.role == "user" and item.metrics:
            m = item.metrics
            turn["transcription_delay"] = m.get("transcription_delay")
            turn["end_of_turn_delay"] = m.get("end_of_turn_delay")
            logger.info("user turn latency", extra=turn)

    @session.on("function_tools_executed")
    def log_tool_time(ev: FunctionToolsExecutedEvent) -> None:
        # From the LLM emitting the call to its result being ready: our code's share
        # of the turn (SQL, board push, web search).
        for call, output in ev.zipped():
            seconds = round(output.created_at - call.created_at, 3)
            logger.info(
                "tool call",
                extra={"tool": call.name, "seconds": seconds, "error": output.is_error},
            )
            turn["tool_seconds"] = turn.get("tool_seconds", 0) + seconds

    session.on("error", lambda ev: apologise_if_no_model_answered(session, ev))

    # Running totals per model, as of the last update.
    totals: dict = {}

    @session.on("session_usage_updated")
    def record_usage(ev: SessionUsageUpdatedEvent) -> None:
        # Fires after every metric (VAD ones included) with the session's running
        # totals, so only the models whose totals moved get a row.
        for after in ev.usage.model_usage:
            if after.type not in ("llm_usage", "stt_usage", "tts_usage"):
                continue
            key = (after.type, after.provider, after.model)
            row = usage_delta(totals.get(key), after)
            totals[key] = after
            if row:
                write_metrics(memory.record_usage, session.userdata.db, row)

    @session.on("user_state_changed")
    def end_when_idle(ev: UserStateChangedEvent) -> None:
        if ev.new_state == "away":
            ctx.shutdown(reason="user idle")

    await ctx.connect()
    logger.info(
        "room connected", extra={"seconds": round(time.monotonic() - job_started, 3)}
    )
    # The browser's participant identity is its anonymous user id.
    participant = await ctx.wait_for_participant()
    state = tools.SessionState(
        user_id=participant.identity, db=await db_connecting, room=ctx.room
    )
    ctx.add_shutdown_callback(state.db.close)
    session.userdata = state

    @session.on("agent_state_changed")
    def log_screen_lead(ev: AgentStateChangedEvent) -> None:
        # How far the screen is ahead of the voice: board pushed -> Lumi starts talking.
        if ev.new_state == "speaking" and state.pushed_at is not None:
            lead = time.monotonic() - state.pushed_at
            logger.info("board push to speech", extra={"seconds": round(lead, 3)})
            turn["board_lead"] = round(lead, 3)
            state.pushed_at = None  # once per turn

    # Fill the board on screen now, before the user clicks Start.
    tasks = await memory.list_tasks(state.db, state.user_id)
    await tools.push_board(state, tasks, change=None)
    agent = Lumi()
    await tools.refresh_instructions(agent, state, tasks)

    # The browser connects on page load to hide the cold start, but it can't play
    # audio until the user clicks. It calls this RPC on click, so the greeting is heard.
    async def on_start(data: rtc.RpcInvocationData) -> str:
        state.timezone = parse_timezone(data.payload)
        logger.info("start clicked", extra={"timezone": state.timezone})
        # "Today" and the calendar depend on the user's timezone.
        tasks = await memory.list_tasks(state.db, state.user_id)
        await tools.refresh_instructions(agent, state, tasks)
        # Said, not generated: no LLM call, so the first word comes as fast as the
        # voice can start, and it works even when every Groq model is rate-limited.
        session.say(prompt.greeting(tasks))
        return "ok"

    await session.start(agent=agent, room=ctx.room)
    logger.info(
        "session ready", extra={"seconds": round(time.monotonic() - job_started, 3)}
    )
    # The browser shows Start once the session is running (agent state "listening"),
    # so a click can't arrive before this is registered.
    ctx.room.local_participant.register_rpc_method("lumi.start", on_start)

    # Hard cap per visitor, also covers someone who loads the page and never clicks Start.
    asyncio.get_running_loop().call_later(
        config.MAX_SESSION_SECONDS, ctx.shutdown, "max session length"
    )


if __name__ == "__main__":
    cli.run_app(server)
