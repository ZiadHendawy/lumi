"""Fast tests with no LLM calls. Run on every push."""

import os
from pathlib import Path

import psycopg
import pytest
from livekit.agents import llm
from livekit.plugins import groq

import config

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


@pytest.mark.skipif(not os.getenv("TEST_DATABASE_URL"), reason="no TEST_DATABASE_URL")
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
