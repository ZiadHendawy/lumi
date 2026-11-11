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
    assert len(model._llm_instances) == 2
    assert isinstance(model._llm_instances[0], groq.LLM)
    fallback = model._llm_instances[1]
    assert fallback.model == config.GEMINI_MODEL
    assert "generativelanguage.googleapis.com" in str(fallback._client.base_url)


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
