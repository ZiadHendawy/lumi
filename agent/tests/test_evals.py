"""Text-only conversations against the real LLM. Scenarios are only ever added.

Run with: uv run pytest -m eval
We assert on tool calls where possible (deterministic) and keep judge intents narrow.
"""

import os

import pytest
from livekit.agents import AgentSession

import config
from agent import Lumi

pytestmark = [
    pytest.mark.eval,
    pytest.mark.skipif(not os.getenv("GROQ_API_KEY"), reason="no GROQ_API_KEY"),
]


def judge():
    # Same fallback chain as Lumi: on the free tier a rate-limited judge would
    # otherwise fail evals whose reply was fine.
    return config.build_llm()


# --- M0 ---------------------------------------------------------------------


async def test_greets_in_persona():
    async with judge() as judge_llm, AgentSession(llm=config.build_llm()) as session:
        await session.start(Lumi())
        result = await session.run(user_input="Hi there, who are you?")
        await (
            result.expect.next_event()
            .is_message(role="assistant")
            .judge(
                judge_llm,
                intent="Friendly reply that introduces itself as Lumi, in at most "
                "three short sentences of plain speech with no markdown or lists.",
            )
        )
        result.expect.no_more_events()


async def test_still_answers_when_groq_fails(monkeypatch):
    # A bad Groq key makes every Groq call fail, so the reply must come from Gemini.
    monkeypatch.setenv("GROQ_API_KEY", "invalid")
    async with AgentSession(llm=config.build_llm()) as session:
        await session.start(Lumi())
        result = await session.run(user_input="Hi, what's your name?")
        result.expect.next_event().is_message(role="assistant")
        result.expect.no_more_events()


# Smoke test 2026-11-11: asked "do you hear me?", Lumi said it could only use text.
# Before the prompt fix, 2 of these 5 phrasings got "I can't hear you" / "I'm reading text".
@pytest.mark.parametrize(
    "question",
    [
        "Can you hear me?",
        "do you hear me",
        "Can you hear my voice?",
        "Wait, are you actually hearing me or reading text?",
        "Hello? Do you hear me?",
    ],
)
async def test_knows_it_is_a_voice_conversation(question):
    async with judge() as judge_llm, AgentSession(llm=config.build_llm()) as session:
        await session.start(Lumi())
        result = await session.run(user_input=question)
        await (
            result.expect.next_event()
            .is_message(role="assistant")
            .judge(
                judge_llm,
                intent="Confirms it can hear the user. Must not claim it can only "
                "read or communicate through text.",
            )
        )
        result.expect.no_more_events()
