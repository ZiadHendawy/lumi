"""Fast tests with no LLM calls. Run on every push."""

import asyncio
import json
import os
from datetime import UTC, date, datetime
from pathlib import Path
from types import SimpleNamespace

import psycopg
import pytest
from aiohttp import web
from aiohttp.test_utils import TestServer
from conftest import needs_db
from livekit.agents import ToolError, llm
from livekit.plugins import groq

import config
import memory
import prompt
import tools
from agent import Lumi, parse_timezone

SCHEMA = (Path(__file__).parent.parent / "schema.sql").read_text()


def test_llm_prefers_groq_then_falls_back(monkeypatch):
    monkeypatch.setenv("GROQ_API_KEY", "test")
    monkeypatch.setenv("GEMINI_API_KEY", "test")
    model = config.build_llm()
    assert isinstance(model, llm.FallbackAdapter)
    # 2026-11-12: two more Groq models sit between Groq and Gemini (per-model caps).
    assert len(model._llm_instances) == 4
    assert all(isinstance(m, groq.LLM) for m in model._llm_instances[:3])
    assert [m.model for m in model._llm_instances[1:3]] == config.GROQ_BACKUP_MODELS
    assert model._attempt_timeout == 10
    fallback = model._llm_instances[-1]
    assert fallback.model == config.GEMINI_MODEL
    assert "generativelanguage.googleapis.com" in str(fallback._client.base_url)


def test_gemini_fallback_thinks_briefly(monkeypatch):
    # With default thinking Gemini missed the fallback's 5 s attempt limit in CI.
    monkeypatch.setenv("GROQ_API_KEY", "test")
    monkeypatch.setenv("GEMINI_API_KEY", "test")
    gemini = config.build_llm()._llm_instances[-1]
    assert gemini._opts.reasoning_effort == "low"


def test_tool_calls_from_groq_get_a_gemini_signature_and_gemini_keeps_its_own():
    ctx = llm.ChatContext()
    from_groq = llm.FunctionCall(call_id="a", name="create_task", arguments="{}")
    from_gemini = llm.FunctionCall(
        call_id="b",
        name="create_task",
        arguments="{}",
        extra={"google": {"thought_signature": "real-signature"}},
    )
    ctx.items.extend([from_groq, from_gemini])
    config.sign_tool_calls_for_gemini(ctx)
    assert from_groq.extra["google"]["thought_signature"] == (
        config.GEMINI_PLACEHOLDER_SIGNATURE
    )
    assert from_gemini.extra["google"]["thought_signature"] == "real-signature"


def test_lumi_signs_tool_calls_before_every_llm_request():
    # The signing only helps if Lumi really overrides llm_node; a misplaced method
    # is still valid Python, so nothing else would notice it going missing.
    from agent import Lumi

    assert "llm_node" in Lumi.__dict__


def test_signed_tool_calls_reach_the_request():
    # The signature only helps if LiveKit actually sends it to the provider.
    ctx = llm.ChatContext()
    ctx.add_message(role="user", content="add milk")
    ctx.items.append(llm.FunctionCall(call_id="a", name="create_task", arguments="{}"))
    ctx.items.append(
        llm.FunctionCallOutput(
            call_id="a", name="create_task", output="ok", is_error=False
        )
    )
    config.sign_tool_calls_for_gemini(ctx)
    messages, _ = ctx.to_provider_format("openai")
    call = next(m for m in messages if m.get("tool_calls"))["tool_calls"][0]
    assert call["extra_content"]["google"]["thought_signature"] == (
        config.GEMINI_PLACEHOLDER_SIGNATURE
    )


@needs_db
def test_schema_is_idempotent_and_keys_on_user_and_key():
    with psycopg.connect(os.environ["TEST_DATABASE_URL"]) as conn:
        conn.execute("DROP TABLE IF EXISTS facts")
        conn.execute(SCHEMA)
        conn.execute(SCHEMA)  # deploys re-run it, so a second run must be a no-op
        conn.execute(
            "INSERT INTO facts (user_id, key, value) VALUES ('u1', 'color', 'blue')"
        )
        with pytest.raises(psycopg.errors.UniqueViolation):
            conn.execute(
                "INSERT INTO facts (user_id, key, value) VALUES ('u1', 'color', 'red')"
            )
        conn.rollback()


# --- M1: tasks and facts in SQL ---------------------------------------------


@needs_db
def test_tasks_schema_is_idempotent_and_checks_priority():
    with psycopg.connect(os.environ["TEST_DATABASE_URL"]) as conn:
        conn.execute("DROP TABLE IF EXISTS tasks")
        conn.execute(SCHEMA)
        conn.execute(SCHEMA)
        row = conn.execute(
            "INSERT INTO tasks (user_id, title) VALUES ('u1', 'Buy milk')"
            " RETURNING body, priority, target_date, done, deleted_at"
        ).fetchone()
        assert row == ("", "medium", None, False, None)
        with pytest.raises(psycopg.errors.CheckViolation):
            conn.execute(
                "INSERT INTO tasks (user_id, title, priority) VALUES ('u1', 'x', 'urgent')"
            )
        conn.rollback()


@needs_db
async def test_task_round_trip(db, new_user):
    user = new_user()
    friday = date(2026, 12, 4)
    task = await memory.create_task(
        db, user, "Buy milk", priority="high", target_date=friday
    )
    assert task["title"] == "Buy milk"
    assert (task["priority"], task["target_date"], task["done"]) == (
        "high",
        friday,
        False,
    )
    assert [t["id"] for t in await memory.list_tasks(db, user)] == [task["id"]]
    assert await memory.get_task(db, user, task["id"]) == task

    # Only the fields passed change; the rest stay as stored.
    task = await memory.update_task(db, user, task["id"], body="2 litres", done=True)
    assert (task["title"], task["body"], task["done"]) == ("Buy milk", "2 litres", True)
    assert task["target_date"] == friday
    task = await memory.update_task(db, user, task["id"], remove_target_date=True)
    assert task["target_date"] is None
    assert task["priority"] == "high"

    deleted = await memory.delete_task(db, user, task["id"])
    assert deleted["id"] == task["id"]
    assert await memory.list_tasks(db, user) == []
    assert await memory.get_task(db, user, task["id"]) is None
    assert await memory.update_task(db, user, task["id"], title="x") is None
    assert await memory.delete_task(db, user, task["id"]) is None

    restored = await memory.restore_task(db, user)  # no id: the latest delete
    assert restored["id"] == task["id"]
    assert len(await memory.list_tasks(db, user)) == 1
    assert await memory.restore_task(db, user, task["id"]) is None  # not deleted now


@needs_db
async def test_list_is_ordered_by_id(db, new_user):
    user = new_user()
    first = await memory.create_task(db, user, "First")
    second = await memory.create_task(db, user, "Second")
    await memory.update_task(db, user, first["id"], title="First, edited")
    assert [t["id"] for t in await memory.list_tasks(db, user)] == [
        first["id"],
        second["id"],
    ]


@needs_db
async def test_users_cannot_touch_each_others_tasks(db, new_user):
    alice, bob = new_user(), new_user()
    task = await memory.create_task(db, alice, "Alice's task")

    assert await memory.list_tasks(db, bob) == []
    assert await memory.get_task(db, bob, task["id"]) is None
    assert await memory.update_task(db, bob, task["id"], title="hacked") is None
    assert await memory.delete_task(db, bob, task["id"]) is None
    await memory.delete_task(db, alice, task["id"])
    assert await memory.restore_task(db, bob, task["id"]) is None
    assert await memory.restore_task(db, bob) is None

    restored = await memory.restore_task(db, alice, task["id"])
    assert restored["title"] == "Alice's task"


@needs_db
async def test_facts_upsert_load_and_forget(db, new_user):
    user, other = new_user(), new_user()
    await memory.save_fact(db, user, "favorite_color", "blue")
    saved = await memory.save_fact(db, user, "favorite_color", "green")
    assert saved == {"key": "favorite_color", "value": "green"}
    await memory.save_fact(db, user, "home_city", "Riyadh")
    assert await memory.load_facts(db, user) == {
        "favorite_color": "green",
        "home_city": "Riyadh",
    }
    assert await memory.load_facts(db, other) == {}
    assert await memory.forget_fact(db, user, "favorite_color") is True
    assert await memory.forget_fact(db, user, "favorite_color") is False
    assert await memory.load_facts(db, user) == {"home_city": "Riyadh"}


# --- M1: tools, board push and prompt --------------------------------------

FRIDAY = date(2026, 11, 27)  # a fixed "today", near a month end


def fake_context(state):
    """Just what our tools touch on a RunContext: the session state and the agent."""
    return SimpleNamespace(
        userdata=state, session=SimpleNamespace(current_agent=Lumi())
    )


def test_board_payload_matches_the_web_contract():
    updated = datetime(2026, 11, 27, 9, 30, tzinfo=UTC)
    tasks = [
        {
            "id": 12,
            "title": "Buy groceries",
            "body": "",
            "priority": "high",
            "target_date": date(2026, 11, 28),
            "done": False,
            "updated_at": updated,
        },
        {
            "id": 13,
            "title": "Call mom",
            "body": "about Sunday",
            "priority": "medium",
            "target_date": None,
            "done": True,
            "updated_at": updated,
        },
    ]
    change = {
        "action": "updated",
        "task_id": 12,
        "title": "Buy groceries",
        "fields": ["priority"],
    }
    payload = json.loads(json.dumps(tools.board_payload(tasks, change)))
    assert payload == {
        "tasks": [
            {
                "id": 12,
                "title": "Buy groceries",
                "body": "",
                "priority": "high",
                "target_date": "2026-11-28",
                "done": False,
                "updated_at": "2026-11-27T09:30:00+00:00",
            },
            {
                "id": 13,
                "title": "Call mom",
                "body": "about Sunday",
                "priority": "medium",
                "target_date": None,
                "done": True,
                "updated_at": "2026-11-27T09:30:00+00:00",
            },
        ],
        "change": change,
    }
    assert tools.board_payload([], None) == {"tasks": [], "change": None}


def test_instructions_show_today_board_and_facts():
    tasks = [
        {
            "id": 7,
            "title": "Dentist",
            "body": "x" * 100,
            "priority": "high",
            "target_date": date(2026, 12, 2),
            "done": False,
        }
    ]
    text = prompt.build_instructions(FRIDAY, tasks, {"home_city": "Riyadh"})
    assert text.startswith(prompt.INSTRUCTIONS)
    assert "Today is Friday 2026-11-27." in text
    assert f"7 | Dentist | high | Wed 2026-12-02 | open | {'x' * 60}\n" in text
    assert "x" * 61 not in text  # long notes are cut
    assert "Saved facts: home_city = Riyadh" in text


def test_greeting_suggests_a_first_task_on_an_empty_board():
    assert "add a task to call mom tomorrow" in prompt.greeting([])


def test_greeting_counts_open_tasks():
    tasks = [{"done": False}, {"done": False}, {"done": True}]
    assert "2 open tasks" in prompt.greeting(tasks)
    assert "one open task" in prompt.greeting(tasks[1:])
    assert "Everything on your board is done" in prompt.greeting(tasks[2:])


def test_instructions_for_an_empty_board():
    text = prompt.build_instructions(FRIDAY, [], {})
    assert "(empty)" in text
    assert "Saved facts: none" in text


def test_instructions_list_the_next_14_days():
    text = prompt.build_instructions(FRIDAY, [], {})
    # Starts tomorrow, crosses into December, and stops after 14 days.
    assert "Calendar: Sat 2026-11-28, Sun 2026-11-29," in text
    assert "Fri 2026-12-11" in text
    assert "2026-12-12" not in text


def test_calendar_can_be_turned_off(monkeypatch):
    # The deep-dive measurement runs the date evals this way.
    monkeypatch.setattr(config, "CALENDAR_DAYS", 0)
    assert "Calendar" not in prompt.build_instructions(FRIDAY, [], {})


@pytest.mark.parametrize(
    "payload, expected",
    [
        ('{"timezone": "Asia/Riyadh"}', "Asia/Riyadh"),
        ('{"timezone": "Not/AZone"}', "UTC"),
        ('{"timezone": null}', "UTC"),
        ("{}", "UTC"),
        ("", "UTC"),
        ('"Asia/Riyadh"', "UTC"),
    ],
)
def test_timezone_from_start_payload(payload, expected):
    assert parse_timezone(payload) == expected


@needs_db
async def test_task_tools_report_what_was_stored_and_refresh_the_prompt(db, new_user):
    state = tools.SessionState(user_id=new_user(), db=db, fixed_today=FRIDAY)
    ctx = fake_context(state)

    reply = await tools.create_task(
        ctx, title=" Buy milk ", priority="high", target_date="2026-12-04"
    )
    task_id = (await memory.list_tasks(db, state.user_id))[0]["id"]
    assert reply == (
        f'Created task {task_id} "Buy milk", high priority, due Friday December 4, not done.'
    )
    # No room in tests, so the push is skipped, but the prompt shows the new task.
    assert f"{task_id} | Buy milk | high | Fri 2026-12-04 | open" in (
        ctx.session.current_agent.instructions
    )

    reply = await tools.update_task(
        ctx, task_id=task_id, remove_target_date=True, done=True
    )
    assert "no due date, done" in reply

    with pytest.raises(ToolError, match="not a date"):
        await tools.update_task(ctx, task_id=task_id, target_date="next friday")
    with pytest.raises(ToolError, match="no task"):
        await tools.update_task(ctx, task_id=task_id + 1000, priority="low")
    # Restating stored values is a no-op, not an error and not a change.
    reply = await tools.update_task(ctx, task_id=task_id, priority="high", done=True)
    assert reply.startswith("Nothing needed changing:")
    with pytest.raises(ToolError, match="no task"):
        await tools.delete_task(ctx, task_id=task_id + 1000)

    await tools.delete_task(ctx, task_id=task_id)
    assert "(empty)" in ctx.session.current_agent.instructions
    assert "Restored" in await tools.restore_task(ctx)
    with pytest.raises(ToolError, match="no deleted task"):
        await tools.restore_task(ctx)


@needs_db
async def test_a_repeated_create_returns_the_first_task(db, new_user):
    # gpt-oss-20b called create_task twice for one request in every eval run.
    state = tools.SessionState(user_id=new_user(), db=db, fixed_today=FRIDAY)
    ctx = fake_context(state)
    await tools.create_task(ctx, title="Buy milk", priority="high")
    reply = await tools.create_task(ctx, title="buy milk ", priority="high")
    assert reply.startswith("Already created")
    assert len(await memory.list_tasks(db, state.user_id)) == 1
    # A different title is a different task.
    await tools.create_task(ctx, title="Buy bread")
    assert len(await memory.list_tasks(db, state.user_id)) == 2


@needs_db
async def test_an_update_with_no_fields_is_an_error_not_a_success(db, new_user):
    state = tools.SessionState(user_id=new_user(), db=db, fixed_today=FRIDAY)
    ctx = fake_context(state)
    await tools.create_task(ctx, title="Call the bank", priority="high")
    task_id = (await memory.list_tasks(db, state.user_id))[0]["id"]
    with pytest.raises(ToolError, match="No field"):
        await tools.update_task(ctx, task_id=task_id)


@needs_db
async def test_board_push_sends_the_contract_payload(db, new_user):
    sent = []

    async def send_text(text, *, topic):
        sent.append((topic, json.loads(text)))

    room = SimpleNamespace(local_participant=SimpleNamespace(send_text=send_text))
    state = tools.SessionState(user_id=new_user(), db=db, room=room, fixed_today=FRIDAY)
    ctx = fake_context(state)
    await tools.create_task(ctx, title="Call mom")
    task_id = sent[0][1]["tasks"][0]["id"]
    # The model restates the unchanged title; only real changes are reported.
    await tools.update_task(
        ctx,
        task_id=task_id,
        title="Call mom",
        priority="high",
        target_date="2026-11-28",
    )

    assert [topic for topic, _ in sent] == ["lumi.board", "lumi.board"]
    assert sent[0][1]["change"] == {
        "action": "created",
        "task_id": task_id,
        "title": "Call mom",
        "fields": [],
    }
    assert sent[1][1]["change"]["fields"] == ["priority", "target_date"]
    assert sent[1][1]["tasks"][0]["priority"] == "high"
    assert state.pushed_at is not None


@needs_db
async def test_a_task_change_costs_three_queries(db, new_user, monkeypatch):
    # Each query is a network round trip the user waits through before Lumi speaks
    # (~220 ms each from the dev machine): the insert, one board read shared by the
    # screen and the prompt, and the facts. It was four before the read was shared.
    async def send_text(text, *, topic):
        pass

    room = SimpleNamespace(local_participant=SimpleNamespace(send_text=send_text))
    state = tools.SessionState(user_id=new_user(), db=db, room=room, fixed_today=FRIDAY)
    ctx = fake_context(state)
    queries = []
    execute = db.execute

    async def counting_execute(query, params=None):
        queries.append(query)
        return await execute(query, params)

    monkeypatch.setattr(db, "execute", counting_execute)
    await tools.create_task(ctx, title="Call mom")
    assert len(queries) == 3
    assert "Call mom" in ctx.session.current_agent.instructions


@needs_db
async def test_fact_tools_normalise_keys(db, new_user):
    state = tools.SessionState(user_id=new_user(), db=db, fixed_today=FRIDAY)
    ctx = fake_context(state)
    await tools.remember_fact(ctx, key="Favorite Color", value="blue")
    await tools.remember_fact(ctx, key="favorite_color", value="green")
    assert await memory.load_facts(db, state.user_id) == {"favorite_color": "green"}
    assert "favorite_color = green" in ctx.session.current_agent.instructions
    assert (
        await tools.forget_fact(ctx, key="favorite color") == "Forgot favorite_color."
    )
    with pytest.raises(ToolError, match="No fact"):
        await tools.forget_fact(ctx, key="favorite_color")


# --- M1: weather, against a local fake of Open-Meteo -------------------------


@pytest.fixture
async def open_meteo(monkeypatch):
    """A local HTTP server standing in for Open-Meteo. Set .forecast_status to fail it."""
    fake = SimpleNamespace(forecast_status=200, delay=0, requests=[])

    async def search(request):
        fake.requests.append(dict(request.query))
        if request.query["name"] != "Jeddah":
            return web.json_response({"generationtime_ms": 0.1})  # no "results"
        return web.json_response(
            {"results": [{"name": "Jeddah", "latitude": 21.5, "longitude": 39.2}]}
        )

    async def forecast(request):
        fake.requests.append(dict(request.query))
        await asyncio.sleep(fake.delay)
        if fake.forecast_status != 200:
            return web.json_response({"error": True}, status=fake.forecast_status)
        return web.json_response(
            {
                "daily": {
                    "time": [request.query["start_date"]],
                    "weather_code": [95],
                    "temperature_2m_max": [32.6],
                    "temperature_2m_min": [23.9],
                    "precipitation_probability_max": [93],
                }
            }
        )

    app = web.Application()
    app.router.add_get("/search", search)
    app.router.add_get("/forecast", forecast)
    server = TestServer(app)
    await server.start_server()
    monkeypatch.setattr(config, "GEOCODING_URL", str(server.make_url("/search")))
    monkeypatch.setattr(config, "FORECAST_URL", str(server.make_url("/forecast")))
    yield fake
    await server.close()


def weather_context():
    return fake_context(tools.SessionState(user_id="u", db=None, fixed_today=FRIDAY))


async def test_weather_reports_the_forecast(open_meteo):
    reply = await tools.get_weather(
        weather_context(), city="Jeddah, Saudi Arabia", date="2026-11-28"
    )
    assert reply == (
        "Jeddah, Saturday November 28: thunderstorms, high 33, low 24 Celsius,"
        " 93 percent chance of rain."
    )
    assert open_meteo.requests[0]["name"] == "Jeddah"
    assert open_meteo.requests[1]["start_date"] == "2026-11-28"


async def test_weather_service_failure_is_a_tool_error(open_meteo):
    open_meteo.forecast_status = 500
    with pytest.raises(ToolError, match="didn't answer"):
        await tools.get_weather(weather_context(), city="Jeddah", date="2026-11-28")


async def test_weather_timeout_is_a_tool_error(open_meteo, monkeypatch):
    monkeypatch.setattr(config, "WEATHER_TIMEOUT_SECONDS", 0.1)
    open_meteo.delay = 1
    with pytest.raises(ToolError, match="didn't answer"):
        await tools.get_weather(weather_context(), city="Jeddah", date="2026-11-28")


async def test_weather_unknown_city_is_a_tool_error(open_meteo):
    with pytest.raises(ToolError, match="Couldn't find"):
        await tools.get_weather(weather_context(), city="Atlantis", date="2026-11-28")


@pytest.mark.parametrize("day", ["2026-11-26", "2026-12-13", "tomorrow"])
async def test_weather_rejects_dates_it_cannot_forecast(open_meteo, day):
    with pytest.raises(ToolError):
        await tools.get_weather(weather_context(), city="Jeddah", date=day)
    assert open_meteo.requests == []  # rejected before any HTTP call
