"""Text-only conversations against the real LLM. Scenarios are only ever added.

Run with: uv run pytest -m eval
We assert on tool calls where possible (deterministic) and keep judge intents narrow.
"""

import json
import os
from contextlib import asynccontextmanager
from datetime import date

import pytest
from conftest import needs_db
from livekit.agents import AgentSession, ToolError, mock_tools

import config
import memory
import tools
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


@pytest.mark.core
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


@pytest.mark.core
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


# --- M1: the task board ------------------------------------------------------
# These run against the test database with a fresh user each, and a fixed "today":
# a Friday near a month end, where date arithmetic is easiest to get wrong.

TODAY = date(2026, 11, 27)


@asynccontextmanager
async def lumi(db, user):
    """A text-only Lumi session for this user, set up the way entrypoint does it."""
    state = tools.SessionState(user_id=user, db=db, fixed_today=TODAY)
    agent = Lumi()
    await tools.refresh_instructions(agent, state)
    async with AgentSession(llm=config.build_llm(), userdata=state) as session:
        await session.start(agent)
        yield session


async def seed_board(db, user) -> dict[str, dict]:
    """Three tasks with distinct names, so every reference below is unambiguous."""
    return {
        "groceries": await memory.create_task(
            db, user, "Buy groceries", priority="high"
        ),
        "dentist": await memory.create_task(
            db, user, "Dentist appointment", target_date=date(2026, 12, 1)
        ),
        "report": await memory.create_task(
            db, user, "Finish the report", target_date=date(2026, 11, 30)
        ),
    }


def call_args(call_assert) -> dict:
    return json.loads(call_assert.event().item.arguments)


@needs_db
@pytest.mark.core
async def test_creates_a_task_with_priority_and_relative_date(db, new_user):
    async with judge() as judge_llm, lumi(db, new_user()) as session:
        result = await session.run(
            user_input="Add buy milk for next Friday, high priority"
        )
        args = call_args(
            result.expect.next_event().is_function_call(name="create_task")
        )
        assert "milk" in args["title"].lower()
        assert (args["priority"], args["target_date"]) == ("high", "2026-12-04")
        result.expect.next_event().is_function_call_output(is_error=False)
        await (
            result.expect.next_event()
            .is_message(role="assistant")
            .judge(
                judge_llm,
                intent="Briefly confirms a milk task was added, high priority, "
                "for Friday.",
            )
        )
        result.expect.no_more_events()


# Each edit must change only what the user meant. We check the stored row, not the
# arguments: the model may restate unchanged values, and that is fine.
@needs_db
@pytest.mark.parametrize(
    "utterance, task, expected",
    [
        ("Rename the groceries task to groceries and snacks", "groceries", {"title": "snacks"}),
        ("Add a note to the dentist task: bring the insurance card", "dentist", {"body": "insurance card"}),
        ("Make the report low priority", "report", {"priority": "low"}),
        ("Move the dentist appointment to Wednesday", "dentist", {"target_date": date(2026, 12, 2)}),
        ("The report doesn't have a deadline anymore", "report", {"target_date": None}),
        ("I bought the groceries, tick that off", "groceries", {"done": True}),
    ],
    ids=["rename", "notes", "priority", "move-date", "remove-date", "done"],
)  # fmt: skip
@pytest.mark.core
async def test_edits_only_what_was_asked(db, new_user, utterance, task, expected):
    user = new_user()
    seeded = (await seed_board(db, user))[task]
    async with lumi(db, user) as session:
        result = await session.run(user_input=utterance)
        result.expect.next_event().is_function_call(
            name="update_task", arguments={"task_id": seeded["id"]}
        )
        result.expect.next_event().is_function_call_output(is_error=False)
        result.expect.next_event().is_message(role="assistant")
        result.expect.no_more_events()

    stored = await memory.get_task(db, user, seeded["id"])
    for key in ["title", "body", "priority", "target_date", "done"]:
        want = expected.get(key, seeded[key])
        if key in expected and key in ("title", "body"):
            assert want in stored[key].lower(), key  # wording may vary
        else:
            assert stored[key] == want, key


# The prompt shows only the first 60 characters of notes. If the model restated the
# notes it sees while editing another field, it would cut them short.
@needs_db
async def test_editing_one_field_keeps_long_notes(db, new_user):
    user = new_user()
    notes = "Ask about the crown on the upper left molar, and whether the night guard still fits."
    task = await memory.create_task(db, user, "Dentist appointment", body=notes)
    async with lumi(db, user) as session:
        await session.run(user_input="Make the dentist appointment high priority")
    stored = await memory.get_task(db, user, task["id"])
    assert (stored["priority"], stored["body"]) == ("high", notes)


@needs_db
@pytest.mark.core
async def test_deletes_a_task_by_description(db, new_user):
    user = new_user()
    board = await seed_board(db, user)
    async with lumi(db, user) as session:
        result = await session.run(user_input="Delete the dentist one")
        result.expect.next_event().is_function_call(
            name="delete_task", arguments={"task_id": board["dentist"]["id"]}
        )
        result.expect.next_event().is_function_call_output(is_error=False)
        result.expect.next_event().is_message(role="assistant")
        result.expect.no_more_events()
    assert await memory.get_task(db, user, board["dentist"]["id"]) is None


@needs_db
@pytest.mark.core
async def test_undo_brings_a_deleted_task_back(db, new_user):
    user = new_user()
    board = await seed_board(db, user)
    async with lumi(db, user) as session:
        await session.run(user_input="Delete the report task")
        result = await session.run(user_input="Oops, undo that")
        result.expect.next_event().is_function_call(name="restore_task")
        result.expect.next_event().is_function_call_output(is_error=False)
        result.expect.next_event().is_message(role="assistant")
        result.expect.no_more_events()
    assert await memory.get_task(db, user, board["report"]["id"]) is not None


# Not in the core tier on purpose: the model still guesses about 1 run in 4 (3/4 and
# 3/3 passes on gpt-oss-20b, 2026-11-12), and only the model can see that "the call"
# is ambiguous, so code can't guard it. A flaky required check teaches people to
# ignore red CI; the pass rate is tracked in docs/DEEP_DIVE.md instead.
@needs_db
async def test_asks_which_task_when_the_reference_is_ambiguous(db, new_user):
    user = new_user()
    await memory.create_task(db, user, "Call mom")
    await memory.create_task(db, user, "Call the bank")
    async with judge() as judge_llm, lumi(db, user) as session:
        result = await session.run(user_input="Mark the call as done")
        await (
            result.expect.next_event()  # a message, not a guessed tool call
            .is_message(role="assistant")
            .judge(
                judge_llm,
                intent="Asks which task the user means, mom or the bank, "
                "without marking anything done.",
            )
        )
        result.expect.no_more_events()
    assert not any(t["done"] for t in await memory.list_tasks(db, user))


@needs_db
@pytest.mark.core
async def test_does_not_fake_a_change_to_a_task_that_does_not_exist(db, new_user):
    user = new_user()
    await seed_board(db, user)
    async with judge() as judge_llm, lumi(db, user) as session:
        result = await session.run(user_input="Delete the gym task")
        await (
            result.expect[-1]
            .is_message(role="assistant")
            .judge(
                judge_llm,
                intent="Says there is no gym task on the board (it may ask what the user "
                "meant). Does not claim that anything was deleted.",
            )
        )
    assert len(await memory.list_tasks(db, user)) == 3


@needs_db
@pytest.mark.core
async def test_one_sentence_can_add_several_tasks(db, new_user):
    user = new_user()
    async with lumi(db, user) as session:
        result = await session.run(user_input="Add eggs and bread")
        result.expect.contains_function_call(name="create_task")
    titles = sorted(t["title"].lower() for t in await memory.list_tasks(db, user))
    assert len(titles) == 2
    assert "eggs" in titles[1] and "bread" in titles[0]


# The correctness deep dive measures these with and without the calendar in the
# prompt: CALENDAR_DAYS=0 uv run pytest -m eval -k due_date
@needs_db
@pytest.mark.parametrize(
    "when, expected",
    [
        ("tomorrow", "2026-11-28"),
        ("next Friday", "2026-12-04"),
        ("on Wednesday", "2026-12-02"),
        ("this coming Sunday", "2026-11-29"),
        ("in ten days", "2026-12-07"),
        ("two weeks from today", "2026-12-11"),
        ("on the 3rd", "2026-12-03"),
    ],
)
async def test_due_date_from_relative_words(db, new_user, when, expected):
    async with lumi(db, new_user()) as session:
        result = await session.run(user_input=f"Add a task to renew my passport {when}")
        args = call_args(
            result.expect.next_event().is_function_call(name="create_task")
        )
        assert args["target_date"] == expected


# --- M1: memory across sessions ---------------------------------------------


@needs_db
@pytest.mark.core
async def test_remembers_a_fact_in_a_new_session(db, new_user):
    user = new_user()
    async with lumi(db, user) as session:
        result = await session.run(user_input="My favorite color is blue")
        result.expect.contains_function_call(name="remember_fact")
    assert "blue" in [v.lower() for v in (await memory.load_facts(db, user)).values()]

    async with judge() as judge_llm, lumi(db, user) as session:
        result = await session.run(user_input="What's my favorite color?")
        await (
            result.expect.next_event()
            .is_message(role="assistant")
            .judge(judge_llm, intent="Says the user's favorite color is blue.")
        )
        result.expect.no_more_events()


@needs_db
async def test_a_new_value_replaces_the_old_fact(db, new_user):
    user = new_user()
    await memory.save_fact(db, user, "favorite_color", "blue")
    async with lumi(db, user) as session:
        result = await session.run(
            user_input="Actually, my favorite color is green now"
        )
        args = call_args(
            result.expect.next_event().is_function_call(name="remember_fact")
        )
        assert tools.fact_key(args["key"]) == "favorite_color"
    assert (await memory.load_facts(db, user))["favorite_color"].lower() == "green"


@needs_db
async def test_forgets_a_fact(db, new_user):
    user = new_user()
    await memory.save_fact(db, user, "favorite_color", "blue")
    async with lumi(db, user) as session:
        result = await session.run(user_input="Forget my favorite color")
        result.expect.next_event().is_function_call(name="forget_fact")
    assert await memory.load_facts(db, user) == {}


# --- M1: weather (the tool is mocked; its HTTP is covered by unit tests) ---------


def fake_weather(city: str, date: str) -> str:
    return f"{city}, {date}: thunderstorms, high 33, low 24 Celsius."


def weather_down(city: str, date: str) -> str:
    raise ToolError("The weather service didn't answer. No forecast is known.")


@needs_db
@pytest.mark.core
async def test_weather_uses_the_city_and_date_asked_for(db, new_user):
    async with judge() as judge_llm, lumi(db, new_user()) as session:
        with mock_tools(Lumi, {"get_weather": fake_weather}):
            result = await session.run(
                user_input="What's the weather in Jeddah tomorrow?"
            )
        args = call_args(
            result.expect.next_event().is_function_call(name="get_weather")
        )
        assert "jeddah" in args["city"].lower()
        assert args["date"] == "2026-11-28"
        result.expect.next_event().is_function_call_output(is_error=False)
        await (
            result.expect.next_event()
            .is_message(role="assistant")
            .judge(judge_llm, intent="Says to expect thunderstorms in Jeddah.")
        )
        result.expect.no_more_events()


@needs_db
async def test_weather_falls_back_to_the_saved_home_city(db, new_user):
    user = new_user()
    await memory.save_fact(db, user, "home_city", "Riyadh")
    async with lumi(db, user) as session:
        with mock_tools(Lumi, {"get_weather": fake_weather}):
            result = await session.run(user_input="Will it rain tomorrow?")
        args = call_args(
            result.expect.next_event().is_function_call(name="get_weather")
        )
        assert "riyadh" in args["city"].lower()


@needs_db
@pytest.mark.core
async def test_weather_failure_gets_an_honest_reply(db, new_user):
    async with judge() as judge_llm, lumi(db, new_user()) as session:
        with mock_tools(Lumi, {"get_weather": weather_down}):
            result = await session.run(
                user_input="What's the weather in Jeddah tomorrow?"
            )
        result.expect.next_event().is_function_call(name="get_weather")
        result.expect.next_event().is_function_call_output(is_error=True)
        await (
            result.expect.next_event()
            .is_message(role="assistant")
            .judge(
                judge_llm,
                # About meaning, not wording: a judge on a backup model once failed
                # "couldn't reach the weather service for Jeddah tomorrow" for not
                # saying "right now".
                intent="Says it couldn't get the forecast. Gives no temperatures "
                "or conditions.",
            )
        )
        result.expect.no_more_events()


# --- Reliability (2026-11-12) -------------------------------------------------
# Found while running the M1 evals: once Groq hit its daily cap, every tool turn failed
# on Gemini ("missing thought_signature", then timeouts), while the plain-reply fallback
# eval above still passed. This one covers a whole task turn, stored in the DB, with
# every Groq model down.


@needs_db
@pytest.mark.core
async def test_task_turn_still_works_when_groq_fails(db, new_user, monkeypatch):
    monkeypatch.setenv("GROQ_API_KEY", "invalid")
    user = new_user()
    async with lumi(db, user) as session:
        result = await session.run(user_input="Add a task to call the bank")
        result.expect.next_event().is_function_call(name="create_task")
        result.expect.next_event().is_function_call_output(is_error=False)
        result.expect.next_event().is_message(role="assistant")
        result.expect.no_more_events()
    assert [t["title"].lower() for t in await memory.list_tasks(db, user)] == [
        "call the bank"
    ]
