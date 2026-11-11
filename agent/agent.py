import asyncio
import logging

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

load_dotenv(".env.local")
logger = logging.getLogger("lumi")

# Placeholder persona. The real one is decided at the end of M0 (open question 4).
INSTRUCTIONS = """\
You are Lumi, a warm and quick-witted voice assistant.
This is a live spoken conversation: you hear the user's voice and they hear yours.
If they ask whether you can hear them, say yes. Never say you are reading text.
Reply in one to three short sentences of plain speech: no markdown, lists, emojis
or symbols. Ask at most one question at a time.
"""
# Why spell out "you hear them": the LLM only ever receives a transcript, so without
# this it truthfully concludes it is reading text and says so (smoke test 2026-11-11).

GREETING = "Greet the user in one short, friendly sentence and ask how you can help."


class Lumi(Agent):
    def __init__(self) -> None:
        super().__init__(instructions=INSTRUCTIONS)


def prewarm(proc: JobProcess) -> None:
    # Loading the VAD model takes ~1 s; do it once per worker process, not per call.
    proc.userdata["vad"] = silero.VAD.load()


server = AgentServer(setup_fnc=prewarm)


@server.rtc_session(agent_name=config.AGENT_NAME)
async def entrypoint(ctx: JobContext) -> None:
    ctx.log_context_fields = {"room": ctx.room.name}

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

    # The browser connects on page load to hide the cold start, but it can't play
    # audio until the user clicks. It calls this RPC on click, so the greeting is heard.
    async def on_start(_: rtc.RpcInvocationData) -> str:
        session.generate_reply(instructions=GREETING)
        return "ok"

    await session.start(agent=Lumi(), room=ctx.room)
    await ctx.connect()
    # Only possible once connected: the local participant doesn't exist before that.
    # The browser shows Start only after the agent has joined, so a click can't beat this.
    ctx.room.local_participant.register_rpc_method("lumi.start", on_start)

    # Hard cap per visitor, also covers someone who loads the page and never clicks Start.
    asyncio.get_running_loop().call_later(
        config.MAX_SESSION_SECONDS, ctx.shutdown, "max session length"
    )


if __name__ == "__main__":
    cli.run_app(server)
