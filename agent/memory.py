"""All database access: plain SQL, no LiveKit imports.

Every task and fact query filters on user_id, so one user can never read or change
another's rows. Every task and fact change uses RETURNING, so callers report the row
as actually stored, not as they asked for it. The metrics tables at the end hold no
user data, so they have neither.
"""

from datetime import date
from pathlib import Path

import psycopg
from psycopg.rows import dict_row

SCHEMA = (Path(__file__).parent / "schema.sql").read_text()

# The columns the board shows. created_at and deleted_at stay internal.
TASK_COLUMNS = "id, title, body, priority, target_date, done, updated_at"


async def connect(url: str) -> psycopg.AsyncConnection:
    # autocommit: every change is a single statement, so each one commits on its own
    # and there is no transaction to forget to close. The timeout turns a stuck network
    # (seen once in tests) into an error instead of a session that never starts; it
    # leaves room for Neon waking from scale-to-zero, which takes about a second.
    conn = await psycopg.AsyncConnection.connect(
        url, autocommit=True, row_factory=dict_row, connect_timeout=10
    )
    await conn.execute(SCHEMA)
    return conn


# --- Tasks -------------------------------------------------------------------


async def list_tasks(conn: psycopg.AsyncConnection, user_id: str) -> list[dict]:
    cur = await conn.execute(
        f"SELECT {TASK_COLUMNS} FROM tasks"
        " WHERE user_id = %s AND deleted_at IS NULL ORDER BY id",
        (user_id,),
    )
    return await cur.fetchall()


async def get_task(
    conn: psycopg.AsyncConnection, user_id: str, task_id: int
) -> dict | None:
    cur = await conn.execute(
        f"SELECT {TASK_COLUMNS} FROM tasks"
        " WHERE id = %s AND user_id = %s AND deleted_at IS NULL",
        (task_id, user_id),
    )
    return await cur.fetchone()


async def create_task(
    conn: psycopg.AsyncConnection,
    user_id: str,
    title: str,
    body: str = "",
    priority: str = "medium",
    target_date: date | None = None,
) -> dict:
    cur = await conn.execute(
        "INSERT INTO tasks (user_id, title, body, priority, target_date)"
        f" VALUES (%s, %s, %s, %s, %s) RETURNING {TASK_COLUMNS}",
        (user_id, title, body, priority, target_date),
    )
    return await cur.fetchone()


async def update_task(
    conn: psycopg.AsyncConnection,
    user_id: str,
    task_id: int,
    *,
    title: str | None = None,
    body: str | None = None,
    priority: str | None = None,
    target_date: date | None = None,
    remove_target_date: bool = False,
    done: bool | None = None,
) -> dict | None:
    """None means "leave as is". Returns None if the user has no such task."""
    # COALESCE keeps the current value for every field passed as None, so one fixed
    # statement covers every combination of edits. A date can't be cleared with None
    # (None already means "keep"), hence the separate remove_target_date flag.
    cur = await conn.execute(
        "UPDATE tasks SET"
        " title = COALESCE(%(title)s, title),"
        " body = COALESCE(%(body)s, body),"
        " priority = COALESCE(%(priority)s, priority),"
        " target_date = CASE WHEN %(remove_target_date)s THEN NULL"
        "   ELSE COALESCE(%(target_date)s, target_date) END,"
        " done = COALESCE(%(done)s, done),"
        " updated_at = now()"
        " WHERE id = %(id)s AND user_id = %(user_id)s AND deleted_at IS NULL"
        f" RETURNING {TASK_COLUMNS}",
        {
            "title": title,
            "body": body,
            "priority": priority,
            "target_date": target_date,
            "remove_target_date": remove_target_date,
            "done": done,
            "id": task_id,
            "user_id": user_id,
        },
    )
    return await cur.fetchone()


async def delete_task(
    conn: psycopg.AsyncConnection, user_id: str, task_id: int
) -> dict | None:
    cur = await conn.execute(
        "UPDATE tasks SET deleted_at = now(), updated_at = now()"
        " WHERE id = %s AND user_id = %s AND deleted_at IS NULL"
        f" RETURNING {TASK_COLUMNS}",
        (task_id, user_id),
    )
    return await cur.fetchone()


async def restore_task(
    conn: psycopg.AsyncConnection, user_id: str, task_id: int | None = None
) -> dict | None:
    """Undo a delete. With no task_id, restores the most recently deleted task."""
    # The subquery picks the target; the outer user_id check is what keeps another
    # user's task out of reach even when task_id is given.
    cur = await conn.execute(
        "UPDATE tasks SET deleted_at = NULL, updated_at = now()"
        " WHERE user_id = %(user_id)s AND id = ("
        "   SELECT id FROM tasks"
        "   WHERE user_id = %(user_id)s AND deleted_at IS NOT NULL"
        "     AND (%(id)s::bigint IS NULL OR id = %(id)s)"
        "   ORDER BY deleted_at DESC LIMIT 1)"
        f" RETURNING {TASK_COLUMNS}",
        {"user_id": user_id, "id": task_id},
    )
    return await cur.fetchone()


# --- Facts -------------------------------------------------------------------


async def load_facts(conn: psycopg.AsyncConnection, user_id: str) -> dict[str, str]:
    cur = await conn.execute(
        "SELECT key, value FROM facts WHERE user_id = %s ORDER BY key", (user_id,)
    )
    return {row["key"]: row["value"] for row in await cur.fetchall()}


async def save_fact(
    conn: psycopg.AsyncConnection, user_id: str, key: str, value: str
) -> dict:
    cur = await conn.execute(
        "INSERT INTO facts (user_id, key, value) VALUES (%s, %s, %s)"
        " ON CONFLICT (user_id, key)"
        " DO UPDATE SET value = EXCLUDED.value, updated_at = now()"
        " RETURNING key, value",
        (user_id, key, value),
    )
    return await cur.fetchone()


async def forget_fact(conn: psycopg.AsyncConnection, user_id: str, key: str) -> bool:
    """Returns False if there was no such fact."""
    cur = await conn.execute(
        "DELETE FROM facts WHERE user_id = %s AND key = %s RETURNING key",
        (user_id, key),
    )
    return await cur.fetchone() is not None


# --- Metrics for the /stats page ----------------------------------------------


async def record_usage(conn: psycopg.AsyncConnection, usage: dict) -> None:
    """One row of provider_usage: kind, model, and what was used since the last row."""
    await conn.execute(
        "INSERT INTO provider_usage"
        " (kind, model, input_tokens, output_tokens, audio_seconds, characters)"
        " VALUES (%(kind)s, %(model)s, %(input_tokens)s, %(output_tokens)s,"
        " %(audio_seconds)s, %(characters)s)",
        usage,
    )


TURN_COLUMNS = (
    "model",
    "e2e_latency",
    "transcription_delay",
    "end_of_turn_delay",
    "llm_ttft",
    "tts_ttfb",
    "tool_seconds",
    "board_lead",
)


async def record_turn(conn: psycopg.AsyncConnection, turn: dict) -> None:
    """One row of turn_metrics. A stage missing from `turn` is stored as NULL."""
    await conn.execute(
        "INSERT INTO turn_metrics (model, e2e_latency, transcription_delay,"
        " end_of_turn_delay, llm_ttft, tts_ttfb, tool_seconds, board_lead)"
        " VALUES (%(model)s, %(e2e_latency)s, %(transcription_delay)s,"
        " %(end_of_turn_delay)s, %(llm_ttft)s, %(tts_ttfb)s, %(tool_seconds)s,"
        " %(board_lead)s)",
        {column: turn.get(column) for column in TURN_COLUMNS},
    )
