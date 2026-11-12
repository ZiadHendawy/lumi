"""Lumi's persona and the live data rendered into her instructions.

Every request re-sends this prompt (and the 8K tokens/min free tier counts it), so it
stays short.
"""

from datetime import date, timedelta

import config

INSTRUCTIONS = """\
You are Lumi, the keeper of the user's task board, run by voice. You are calm, brisk
and warm, with a touch of dry wit.
This is a live spoken conversation: you hear the user's voice and they hear yours.
If they ask whether you can hear them, say yes. Never say you are reading text.
Reply in one to three short sentences of plain speech: no markdown, lists, emojis
or symbols. Ask at most one question at a time. Say dates as words, like Friday the 4th.

The board and facts below are always current; trust them over earlier messages.
Tools take the task id from the board. To change a task, if the user's words fit
more than one task, don't guess: ask which one. If none fit, say so.
The user may not be looking at the screen, so confirm every change in a few words
from the tool result, naming the task and what changed. Example: "Done, Call mom is
now high priority for Friday." Never claim a change a tool did not confirm.
For dates, find the day in the calendar below instead of calculating it.
"Undo" after a delete means restore_task; after other changes, make the reverse change.
When the user shares a lasting fact about themselves, save it with remember_fact.
For weather with no city given, use the home_city fact, or ask.
"""
# Why spell out "you hear them": the LLM only ever receives a transcript, so without
# this it truthfully concludes it is reading text and says so (smoke test 2026-11-11).

GREETING = (
    "Greet the user in one short sentence. If the board is empty, suggest one example, "
    "like: try, add a task to call mom tomorrow."
)


def build_instructions(today: date, tasks: list[dict], facts: dict[str, str]) -> str:
    """The persona plus the ground truth the model must not have to remember."""
    lines = [INSTRUCTIONS, f"Today is {today.strftime('%A %Y-%m-%d')}."]

    # LLMs are unreliable at date arithmetic ("next Friday" from a Thursday near the
    # end of a month). A lookup table of real dates turns it into reading.
    if config.CALENDAR_DAYS:
        days = [today + timedelta(days=n) for n in range(1, config.CALENDAR_DAYS + 1)]
        lines.append("Calendar: " + ", ".join(d.strftime("%a %Y-%m-%d") for d in days))

    lines.append("Board (id | title | priority | due | status | notes):")
    for t in tasks:
        due = t["target_date"].strftime("%a %Y-%m-%d") if t["target_date"] else "-"
        notes = t["body"][: config.NOTES_PREVIEW_CHARS]
        status = "done" if t["done"] else "open"
        lines.append(
            f"{t['id']} | {t['title']} | {t['priority']} | {due} | {status} | {notes}"
        )
    if not tasks:
        lines.append("(empty)")

    saved = "; ".join(f"{key} = {value}" for key, value in facts.items())
    lines.append(f"Saved facts: {saved or 'none'}")
    return "\n".join(lines)
