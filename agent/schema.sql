-- Applied at the start of every session, so every statement must be safe to re-run.

-- One row per (user, key): saving a fact again overwrites it instead of piling up
-- contradictory versions.
CREATE TABLE IF NOT EXISTS facts (
    user_id    TEXT        NOT NULL,
    key        TEXT        NOT NULL,
    value      TEXT        NOT NULL,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (user_id, key)
);

CREATE TABLE IF NOT EXISTS tasks (
    id          BIGINT      GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    user_id     TEXT        NOT NULL,
    title       TEXT        NOT NULL,
    body        TEXT        NOT NULL DEFAULT '',
    -- The tool schema already limits priority to these values; the CHECK means a bad
    -- value can't get in even if a tool or a hand-written query has a bug.
    priority    TEXT        NOT NULL DEFAULT 'medium'
                            CHECK (priority IN ('low', 'medium', 'high')),
    target_date DATE,
    done        BOOLEAN     NOT NULL DEFAULT false,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    -- Soft delete: a deleted task keeps its row so "undo" can bring it back.
    deleted_at  TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS tasks_user_id ON tasks (user_id);

-- Metrics for the /stats page. No user_id and no words, only counts and timings,
-- so the page can be read by someone who isn't the user.

-- What each provider was asked to do, one row per change in a session's running
-- totals (for the LLM, that is one row per request). The free caps are per model,
-- per minute and per day, so the page sums these over those windows.
CREATE TABLE IF NOT EXISTS provider_usage (
    id            BIGINT      GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    at            TIMESTAMPTZ NOT NULL DEFAULT now(),
    kind          TEXT        NOT NULL CHECK (kind IN ('llm', 'stt', 'tts')),
    model         TEXT        NOT NULL,
    input_tokens  INT         NOT NULL DEFAULT 0,
    output_tokens INT         NOT NULL DEFAULT 0,
    audio_seconds REAL        NOT NULL DEFAULT 0,
    characters    INT         NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS provider_usage_at ON provider_usage (at);

-- Where the time went in one spoken reply, in seconds. NULL means the stage didn't
-- happen in that turn (no tool call, no board change).
CREATE TABLE IF NOT EXISTS turn_metrics (
    id                  BIGINT      GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    at                  TIMESTAMPTZ NOT NULL DEFAULT now(),
    model               TEXT,
    e2e_latency         REAL,
    transcription_delay REAL,
    end_of_turn_delay   REAL,
    llm_ttft            REAL,
    tts_ttfb            REAL,
    tool_seconds        REAL,
    board_lead          REAL
);
CREATE INDEX IF NOT EXISTS turn_metrics_at ON turn_metrics (at);
