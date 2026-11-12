"""Fast tests with no LLM calls. Run on every push."""

import os
from datetime import date
from pathlib import Path

import psycopg
import pytest
from conftest import needs_db
from livekit.agents import llm
from livekit.plugins import groq

import config
import memory

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
