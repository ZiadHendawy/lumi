-- One row per (user, key): saving a fact again overwrites it instead of piling up
-- contradictory versions. Safe to run repeatedly.
CREATE TABLE IF NOT EXISTS facts (
    user_id    TEXT        NOT NULL,
    key        TEXT        NOT NULL,
    value      TEXT        NOT NULL,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (user_id, key)
);
