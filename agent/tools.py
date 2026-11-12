"""Lumi's tools, plus the per-session state they share.

The model decides *what* the user meant; this code owns the data. Tools validate
their input, write through memory.py, and report the row as stored. A ToolError's
message goes back to the model so it can recover, instead of claiming a success.
"""

import asyncio
import datetime
import json
import logging
import time
from dataclasses import dataclass, field
from typing import Literal
from zoneinfo import ZoneInfo

import aiohttp
import psycopg
from livekit import rtc
from livekit.agents import Agent, RunContext, ToolError, function_tool

import config
import memory
import prompt

logger = logging.getLogger("lumi")

BOARD_TOPIC = "lumi.board"  # the browser listens on this text-stream topic
# A create with the same title this soon after another is treated as a repeat call.
DUPLICATE_CREATE_SECONDS = 10

# A Literal becomes an enum in the tool's JSON schema, so the model can't invent
# "urgent". The CHECK in schema.sql backs it up.
Priority = Literal["low", "medium", "high"]


@dataclass
class SessionState:
    user_id: str  # the browser's participant identity (an anonymous UUID)
    db: psycopg.AsyncConnection
    room: rtc.Room | None = None  # None in text-only tests: board pushes are skipped
    timezone: str = "UTC"  # the browser's, sent with lumi.start
    fixed_today: datetime.date | None = None  # tests pin "today" so date evals repeat
    pushed_at: float | None = None  # when the board last reached the browser
    # Parallel tool calls ("add eggs and bread") each re-read and publish the board. The
    # lock stops an older read from reaching the screen or prompt after a newer one.
    lock: asyncio.Lock = field(default_factory=asyncio.Lock)
    # title (lowercased) -> (when, task), for the duplicate-create guard in create_task
    recent_creates: dict[str, tuple[float, dict]] = field(default_factory=dict)

    def today(self) -> datetime.date:
        return self.fixed_today or datetime.datetime.now(ZoneInfo(self.timezone)).date()


# --- Keeping the prompt and the screen in sync with the database --------------


async def refresh_instructions(agent: Agent, state: SessionState) -> None:
    """Re-render the board and facts into the prompt, so the model reads the truth
    instead of remembering it."""
    tasks = await memory.list_tasks(state.db, state.user_id)
    facts = await memory.load_facts(state.db, state.user_id)
    await agent.update_instructions(
        prompt.build_instructions(state.today(), tasks, facts)
    )


def board_payload(tasks: list[dict], change: dict | None) -> dict:
    """The JSON the browser renders. Its shape is a contract with web/."""
    rows = []
    for t in tasks:
        due = t["target_date"]
        rows.append(
            {
                "id": t["id"],
                "title": t["title"],
                "body": t["body"],
                "priority": t["priority"],
                "target_date": due.isoformat() if due else None,
                "done": t["done"],
                "updated_at": t["updated_at"].isoformat(),
            }
        )
    return {"tasks": rows, "change": change}


async def push_board(state: SessionState, change: dict | None) -> None:
    if state.room is None:
        return
    tasks = await memory.list_tasks(state.db, state.user_id)
    try:
        await state.room.local_participant.send_text(
            json.dumps(board_payload(tasks, change)), topic=BOARD_TOPIC
        )
        state.pushed_at = time.monotonic()
    except Exception:
        # The change is already saved; a screen that missed one update must not turn
        # it into a reported failure.
        logger.warning("board push failed", exc_info=True)


async def after_task_change(
    context: RunContext[SessionState], action: str, task: dict, fields: list[str]
) -> None:
    state = context.userdata
    change = {
        "action": action,
        "task_id": task["id"],
        "title": task["title"],
        "fields": fields,
    }
    async with state.lock:
        # Screen first, so it can update before Lumi starts speaking.
        await push_board(state, change)
        await refresh_instructions(context.session.current_agent, state)


# --- How tools talk about dates and tasks -------------------------------------


def parse_date(text: str) -> datetime.date:
    try:
        return datetime.date.fromisoformat(text)
    except ValueError:
        raise ToolError(
            f"{text!r} is not a date. Pass YYYY-MM-DD from the calendar."
        ) from None


def spoken_date(day: datetime.date) -> str:
    return f"{day.strftime('%A %B')} {day.day}"  # "Friday December 4"


def describe(task: dict) -> str:
    """A stored task in words, so Lumi's confirmation repeats what was saved."""
    due = task["target_date"]
    parts = [
        f'task {task["id"]} "{task["title"]}"',
        f"{task['priority']} priority",
        f"due {spoken_date(due)}" if due else "no due date",
        "done" if task["done"] else "not done",
    ]
    if task["body"]:
        parts.append(f"notes: {task['body']}")
    return ", ".join(parts)


def no_such_task(task_id: int) -> ToolError:
    return ToolError(f"There is no task {task_id} on the board. Nothing was changed.")


# --- Task tools ----------------------------------------------------------------
# Docstrings are the tool descriptions the model sees on every request: keep them short.


@function_tool
async def create_task(
    context: RunContext[SessionState],
    title: str,
    priority: Priority = "medium",
    target_date: str | None = None,
    body: str = "",
) -> str:
    """Add one task. target_date is YYYY-MM-DD; body is optional notes."""
    state = context.userdata
    if not title.strip():
        raise ToolError("A task needs a title.")
    key = title.strip().lower()
    seen = state.recent_creates.get(key)
    if seen and time.monotonic() - seen[0] < DUPLICATE_CREATE_SECONDS:
        # gpt-oss-20b (our first backup model) called create_task a second time after
        # reading the first result, every time (2026-11-12). The same title seconds
        # later is the same request, so code refuses the duplicate, not the prompt.
        return f"Already created {describe(seen[1])}. Don't create it again."
    day = parse_date(target_date) if target_date else None
    task = await memory.create_task(
        state.db, state.user_id, title.strip(), body.strip(), priority, day
    )
    state.recent_creates[key] = (time.monotonic(), task)
    await after_task_change(context, "created", task, [])
    return f"Created {describe(task)}."


@function_tool
async def update_task(
    context: RunContext[SessionState],
    task_id: int,
    title: str | None = None,
    body: str | None = None,
    priority: Priority | None = None,
    target_date: str | None = None,
    remove_target_date: bool = False,
    done: bool | None = None,
) -> str:
    """Change a task. Set only the fields that change; leave the rest null.
    body "" clears the notes."""
    state = context.userdata
    asked = (title, body, priority, target_date, done)
    if all(v is None for v in asked) and not remove_target_date:
        # Seen live on a backup model: a call with every field null. Answering
        # "nothing needed changing" made Lumi report success for "make it low".
        raise ToolError("No field was given. Pass the field to change, e.g. priority.")
    if title is not None and not title.strip():
        raise ToolError("A task's title can't be empty.")
    if target_date and remove_target_date:
        raise ToolError("Either set target_date or remove it, not both.")
    current = await memory.get_task(state.db, state.user_id, task_id)
    if current is None:
        raise no_such_task(task_id)

    changes = {}
    if title is not None:
        changes["title"] = title.strip()
    if body is not None:
        changes["body"] = body.strip()
    if priority is not None:
        changes["priority"] = priority
    if done is not None:
        changes["done"] = done
    if remove_target_date:
        changes["target_date"] = None
    elif target_date:
        changes["target_date"] = parse_date(target_date)
    # The model often restates values that aren't changing, so compare with what is
    # stored: only real differences count (they are what the browser highlights).
    fields = [name for name, value in changes.items() if value != current[name]]
    if not fields:
        return f"Nothing needed changing: {describe(current)}."

    task = await memory.update_task(
        state.db,
        state.user_id,
        task_id,
        title=changes.get("title"),
        body=changes.get("body"),
        priority=changes.get("priority"),
        target_date=changes.get("target_date"),
        remove_target_date=remove_target_date,
        done=changes.get("done"),
    )
    if task is None:  # deleted in the meantime
        raise no_such_task(task_id)
    await after_task_change(context, "updated", task, fields)
    return f"Updated {describe(task)}."


# Deletes are soft (deleted_at is set, the row stays) and happen without an "are you
# sure?" turn. A confirmation turn would add a full round trip of latency to every
# delete; keeping the row makes a mistaken delete a one-word fix ("undo") instead.
@function_tool
async def delete_task(context: RunContext[SessionState], task_id: int) -> str:
    """Delete a task. It can be restored."""
    state = context.userdata
    task = await memory.delete_task(state.db, state.user_id, task_id)
    if task is None:
        raise no_such_task(task_id)
    await after_task_change(context, "deleted", task, [])
    return f"Deleted {describe(task)}. It can be restored."


@function_tool
async def restore_task(
    context: RunContext[SessionState], task_id: int | None = None
) -> str:
    """Bring back a deleted task (undo). Omit task_id for the most recent delete."""
    state = context.userdata
    task = await memory.restore_task(state.db, state.user_id, task_id)
    if task is None:
        raise ToolError("There is no deleted task to bring back. Nothing was changed.")
    await after_task_change(context, "restored", task, [])
    return f"Restored {describe(task)}."


# --- Facts -------------------------------------------------------------------


def fact_key(key: str) -> str:
    # "Favorite Color" and "favorite_color" must land on the same row, or an update
    # becomes a second, contradicting fact.
    return key.strip().lower().replace(" ", "_")


@function_tool
async def remember_fact(context: RunContext[SessionState], key: str, value: str) -> str:
    """Save a fact about the user for future sessions, e.g. key favorite_color.
    Saving an existing key replaces its value."""
    state = context.userdata
    fact = await memory.save_fact(state.db, state.user_id, fact_key(key), value.strip())
    async with state.lock:
        await refresh_instructions(context.session.current_agent, state)
    return f"Saved {fact['key']} = {fact['value']}."


@function_tool
async def forget_fact(context: RunContext[SessionState], key: str) -> str:
    """Delete a saved fact."""
    state = context.userdata
    if not await memory.forget_fact(state.db, state.user_id, fact_key(key)):
        raise ToolError(
            f"No fact called {fact_key(key)} is saved. Nothing was changed."
        )
    async with state.lock:
        await refresh_instructions(context.session.current_agent, state)
    return f"Forgot {fact_key(key)}."


# --- Weather (Open-Meteo) ------------------------------------------------------

# WMO weather codes, grouped: each entry covers the codes up to and including its number.
WEATHER_WORDS = [
    (0, "clear skies"),
    (3, "some clouds"),
    (48, "fog"),
    (57, "drizzle"),
    (67, "rain"),
    (77, "snow"),
    (82, "rain showers"),
    (86, "snow showers"),
    (99, "thunderstorms"),
]


@function_tool
async def get_weather(context: RunContext[SessionState], city: str, date: str) -> str:
    """Weather forecast for a city on a date (YYYY-MM-DD)."""
    day = parse_date(date)
    today = context.userdata.today()
    if not today <= day <= today + datetime.timedelta(days=config.FORECAST_DAYS_AHEAD):
        raise ToolError(
            f"Forecasts only cover today to {config.FORECAST_DAYS_AHEAD} days ahead."
        )
    # The geocoder matches place names only: "Paris, France" finds nothing.
    name = city.split(",")[0].strip()
    timeout = aiohttp.ClientTimeout(total=config.WEATHER_TIMEOUT_SECONDS)
    try:
        async with aiohttp.ClientSession(timeout=timeout) as http:
            async with http.get(
                config.GEOCODING_URL, params={"name": name, "count": 1}
            ) as resp:
                resp.raise_for_status()
                places = (await resp.json()).get("results")
            if not places:
                raise ToolError(f"Couldn't find a place called {city}.")
            place = places[0]
            async with http.get(
                config.FORECAST_URL,
                params={
                    "latitude": place["latitude"],
                    "longitude": place["longitude"],
                    "daily": "weather_code,temperature_2m_max,temperature_2m_min,"
                    "precipitation_probability_max",
                    "timezone": "auto",
                    "start_date": day.isoformat(),
                    "end_date": day.isoformat(),
                },
            ) as resp:
                resp.raise_for_status()
                daily = (await resp.json())["daily"]
            code = daily["weather_code"][0]
            high = round(daily["temperature_2m_max"][0])
            low = round(daily["temperature_2m_min"][0])
            rain = daily["precipitation_probability_max"][0]
            words = next(w for top, w in WEATHER_WORDS if code <= top)
    except (
        aiohttp.ClientError,
        TimeoutError,
        LookupError,
        TypeError,
        StopIteration,
    ) as e:
        # Covers a down or slow service and an answer missing the data we need. Either
        # way the model must not fill the gap with a made-up forecast.
        logger.warning("weather lookup failed", exc_info=True)
        raise ToolError(
            "The weather service didn't answer. No forecast is known."
        ) from e

    report = (
        f"{place['name']}, {spoken_date(day)}: {words}, high {high}, low {low} Celsius"
    )
    if rain is not None:
        report += f", {rain} percent chance of rain"
    return report + "."
