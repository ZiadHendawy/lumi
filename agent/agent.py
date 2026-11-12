import asyncio
import json
import logging
import os
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

from dotenv import load_dotenv
from livekit import rtc
from livekit.agents import (
    Agent,
    AgentServer,
    AgentSession,
    ConversationItemAddedEvent,
    JobContext,
    JobProcess,
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
                tools.get_weather,
            ],
        )

    def llm_node(self, chat_ctx, tools, model_settings):
        # Runs before every LLM request; see config.sign_tool_calls_for_gemini for why.
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


def prewarm(proc: JobProcess) -> None:
    # Loading the VAD model takes ~1 s; do it once per worker process, not per call.
    proc.userdata["vad"] = silero.VAD.load()


server = AgentServer(setup_fnc=prewarm)


@server.rtc_session(agent_name=config.AGENT_NAME)
async def entrypoint(ctx: JobContext) -> None:
    ctx.log_context_fields = {"room": ctx.room.name}

    # Neon scales to zero, and waking it adds ~0.5 s to the first query. Start now so
    # that happens while the room connects, not on the user's first request.
    db_connecting = asyncio.create_task(memory.connect(os.environ["DATABASE_URL"]))

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

    @session.on("conversation_item_added")
    def log_turn_latency(ev: ConversationItemAddedEvent) -> None:
        # Each finished assistant message carries the per-stage timings for its turn.
        item = ev.item
        if item.type == "message" and item.role == "assistant" and item.metrics:
            m = item.metrics
            logger.info(
                "turn latency",
                extra={
                    "e2e_latency": m.get("e2e_latency"),
                    "llm_ttft": m.get("llm_node_ttft"),
                    "tts_ttfb": m.get("tts_node_ttfb"),
                    "llm_model": (m.get("llm_metadata") or {}).get("model_name"),
                },
            )

    @session.on("user_state_changed")
    def end_when_idle(ev: UserStateChangedEvent) -> None:
        if ev.new_state == "away":
            ctx.shutdown(reason="user idle")

    await ctx.connect()
    # The browser's participant identity is its anonymous user id.
    participant = await ctx.wait_for_participant()
    state = tools.SessionState(
        user_id=participant.identity, db=await db_connecting, room=ctx.room
    )
    ctx.add_shutdown_callback(state.db.close)
    session.userdata = state

    # Fill the board on screen now, before the user clicks Start.
    await tools.push_board(state, change=None)
    agent = Lumi()
    await tools.refresh_instructions(agent, state)

    # The browser connects on page load to hide the cold start, but it can't play
    # audio until the user clicks. It calls this RPC on click, so the greeting is heard.
    async def on_start(data: rtc.RpcInvocationData) -> str:
        state.timezone = parse_timezone(data.payload)
        # "Today" and the calendar depend on the user's timezone.
        await tools.refresh_instructions(agent, state)
        session.generate_reply(instructions=prompt.GREETING)
        return "ok"

    await session.start(agent=agent, room=ctx.room)
    # The browser shows Start once the session is running (agent state "listening"),
    # so a click can't arrive before this is registered.
    ctx.room.local_participant.register_rpc_method("lumi.start", on_start)

    # Hard cap per visitor, also covers someone who loads the page and never clicks Start.
    asyncio.get_running_loop().call_later(
        config.MAX_SESSION_SECONDS, ctx.shutdown, "max session length"
    )


if __name__ == "__main__":
    cli.run_app(server)
