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
