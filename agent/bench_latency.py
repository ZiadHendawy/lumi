"""Offline latency benchmark for the parts of a turn we can time without a microphone.

    uv run python bench_latency.py llm --runs 5   # each model in config.build_llm()
    uv run python bench_latency.py llm --bare     # persona only, no tools: prompt size
    uv run python bench_latency.py db --runs 5    # Neon round trips (TEST_DATABASE_URL)
    uv run python bench_latency.py push --runs 5  # board push through LiveKit Cloud

The LLM part sends Lumi's real instructions and tool schemas (built by prompt.py and
the Lumi agent), but to one model at a time, so models can be compared. Each run is
a plain reply plus a tool turn (call 1 emits create_task, call 2 speaks the result),
which costs ~5K Groq tokens: keep --runs small, the free tier is 8K tokens/min.
Speech-to-text, end of turn and text-to-speech need real audio: read those from the
"turn latency" lines of a live session instead.
"""

import argparse
import asyncio
import json
import os
import statistics
import time
import uuid
from datetime import date, datetime

from dotenv import load_dotenv
from livekit import api, rtc
from livekit.agents import APIConnectOptions, llm

import config
import memory
import prompt
import tools
from agent import Lumi

load_dotenv(".env.local")

TODAY = date(2026, 11, 27)


def task(id: int, title: str, priority: str = "medium", due: date | None = None):
    return {
        "id": id,
        "title": title,
        "priority": priority,
        "target_date": due,
        "body": "",
        "done": False,
    }


# The board the evals seed, so the prompt is the size the model really sees.
BOARD = [
    task(1, "Buy groceries", "high"),
    task(2, "Dentist appointment", due=date(2026, 12, 1)),
    task(3, "Finish the report", due=date(2026, 11, 30)),
]
FACTS = {"home_city": "Cairo"}
PLAIN = "Hi Lumi, what's on my board?"
TOOL = "Add buy milk for next Friday, high priority"
# No retries: a rate-limited call should show up as an error, not as a slow call.
NO_RETRY = APIConnectOptions(max_retry=0)


def summary(seconds: list[float]) -> str:
    if not seconds:
        return "no data"
    ms = sorted(round(s * 1000) for s in seconds)
    return f"median {round(statistics.median(ms))} ms, min {ms[0]}, max {ms[-1]}, n={len(ms)}"


async def timed_chat(model: llm.LLM, ctx: llm.ChatContext, fns: list) -> dict:
    """One streamed request: time to the first token (or tool call) and to the end."""
    start = time.perf_counter()
    first = None
    text, calls, usage = "", [], None
    async with model.chat(chat_ctx=ctx, tools=fns, conn_options=NO_RETRY) as stream:
        async for chunk in stream:
            if first is None and chunk.has_response():
                first = time.perf_counter() - start
            if chunk.delta:
                text += chunk.delta.content or ""
                calls += chunk.delta.tool_calls
            usage = chunk.usage or usage
    return {
        "ttft": first,
        "total": time.perf_counter() - start,
        "text": text,
        "calls": calls,
        "tokens": usage.total_tokens if usage else 0,
        "out": usage.completion_tokens if usage else 0,
        "cached": usage.prompt_cached_tokens if usage else 0,
    }


def context(board: list[dict], user_text: str, bare: bool) -> llm.ChatContext:
    ctx = llm.ChatContext()
    text = (
        prompt.INSTRUCTIONS if bare else prompt.build_instructions(TODAY, board, FACTS)
    )
    ctx.add_message(role="system", content=text)
    ctx.add_message(role="user", content=user_text)
    return ctx


def after_tool_context(call: llm.FunctionToolCall) -> llm.ChatContext:
    """The second request of a tool turn, as the session sends it: the call, its
    result, and the instructions re-rendered with the new task on the board."""
    new = task(4, "Buy milk", "high", date(2026, 12, 4))
    ctx = context(BOARD + [new], TOOL, bare=False)
    ctx.items.append(
        llm.FunctionCall(call_id=call.call_id, name=call.name, arguments=call.arguments)
    )
    ctx.items.append(
        llm.FunctionCallOutput(
            call_id=call.call_id,
            name=call.name,
            output=f"Created {tools.describe(new)}.",
            is_error=False,
        )
    )
    config.sign_tool_calls_for_gemini(ctx)
    return ctx


async def bench_llm(runs: int, pause: float, only: str, bare: bool) -> None:
    # The models exactly as config builds them (the unit tests read this list too).
    models = [m for m in config.build_llm()._llm_instances if only in m.model]
    fns = [] if bare else Lumi().tools
    # A live session opens its connection to the model before the first turn
    # (AgentSession calls prewarm), so don't count TLS setup in the first request here.
    for model in models:
        model.prewarm()
    await asyncio.sleep(2)
    results: dict[tuple[str, str], list[float]] = {}
    tokens: dict[str, int] = {}

    def record(model: llm.LLM, kind: str, r: dict) -> None:
        tokens[model.model] = tokens.get(model.model, 0) + r["tokens"]
        results.setdefault((model.model, kind), []).append(r["ttft"] or r["total"])
        said = r["text"].strip().replace("\n", " ")[:70]
        called = ", ".join(f"{c.name}{c.arguments}" for c in r["calls"])[:120]
        print(
            f"{model.model:28} {kind:18} first {r['ttft'] or 0:.3f}s"
            f" total {r['total']:.3f}s tokens {r['tokens']} (out {r['out']},"
            f" cached {r['cached']})"
            f" | {called or said}"
        )

    for _ in range(runs):
        # Interleave models, so a slow minute on the network hits all of them alike.
        for model in models:
            try:
                record(
                    model,
                    "plain reply",
                    await timed_chat(model, context(BOARD, PLAIN, bare), fns),
                )
                await asyncio.sleep(pause)
                if bare:
                    continue
                ctx = context(BOARD, TOOL, bare)
                first = await timed_chat(model, ctx, fns)
                record(model, "tool call emitted", first)
                if not first["calls"]:
                    continue
                await asyncio.sleep(pause)
                ctx = after_tool_context(first["calls"][0])
                record(model, "reply after tool", await timed_chat(model, ctx, fns))
            except Exception as e:
                # Usually a 429: the free tier is shared with CI. Let the minute pass.
                print(f"{model.model:28} error: {str(e)[:160]}")
                await asyncio.sleep(30)
            await asyncio.sleep(pause)

    print("\nTime to first token (or to the complete tool call):")
    for (name, kind), seconds in results.items():
        print(f"  {name:28} {kind:18} {summary(seconds)}")
    print("Tokens spent:", tokens)


async def bench_db(runs: int) -> None:
    url = os.environ["TEST_DATABASE_URL"]
    start = time.perf_counter()
    conn = await memory.connect(url)
    print(f"first connect (incl. schema): {time.perf_counter() - start:.3f}s")
    start = time.perf_counter()
    second = await memory.connect(url)
    print(f"second connect (Neon awake):  {time.perf_counter() - start:.3f}s")
    await second.close()

    user = f"bench-{uuid.uuid4()}"
    times: dict[str, list[float]] = {}

    async def timed(name: str, coro):
        start = time.perf_counter()
        result = await coro
        times.setdefault(name, []).append(time.perf_counter() - start)
        return result

    try:
        for _ in range(runs):
            await timed("round trip (SELECT 1)", conn.execute("SELECT 1"))
            task = await timed(
                "create_task SQL", memory.create_task(conn, user, "Bench")
            )
            await timed(
                "update_task SQL",
                memory.update_task(conn, user, task["id"], priority="high"),
            )
            await timed("list_tasks SQL", memory.list_tasks(conn, user))
            await timed("load_facts SQL", memory.load_facts(conn, user))
            # What the create_task tool waits on: insert, push_board's list, then
            # refresh_instructions' list and facts. Four round trips, one after another.
            start = time.perf_counter()
            await memory.create_task(conn, user, "Bench")
            await memory.list_tasks(conn, user)
            await memory.list_tasks(conn, user)
            await memory.load_facts(conn, user)
            times.setdefault("create_task tool, all SQL", []).append(
                time.perf_counter() - start
            )
    finally:
        await conn.execute("DELETE FROM tasks WHERE user_id = %s", (user,))
        await conn.close()
    for name, seconds in times.items():
        print(f"  {name:28} {summary(seconds)}")


def token(identity: str, room: str) -> str:
    grant = api.VideoGrants(room_join=True, room=room)
    return api.AccessToken().with_identity(identity).with_grants(grant).to_jwt()


async def bench_push(runs: int) -> None:
    # Two participants in a throwaway room: "agent" sends the board, "browser" gets it.
    # No agent is dispatched: Lumi only joins rooms that ask for it by name.
    name = f"bench-{uuid.uuid4()}"
    url = os.environ["LIVEKIT_URL"]
    sender, receiver = rtc.Room(), rtc.Room()
    received: asyncio.Queue[float] = asyncio.Queue()

    async def read(reader: rtc.TextStreamReader) -> None:
        await reader.read_all()
        received.put_nowait(time.perf_counter())

    receiver.register_text_stream_handler(
        tools.BOARD_TOPIC, lambda reader, _who: asyncio.create_task(read(reader))
    )
    await receiver.connect(url, token("browser", name))
    await sender.connect(url, token("agent", name))
    await asyncio.sleep(2)  # let both sides see each other
    board = [t | {"updated_at": datetime.now()} for t in BOARD]
    payload = json.dumps(tools.board_payload(board, None))
    print(f"board payload: {len(payload)} bytes")
    awaited, delivered = [], []
    try:
        for _ in range(runs):
            start = time.perf_counter()
            await sender.local_participant.send_text(payload, topic=tools.BOARD_TOPIC)
            awaited.append(time.perf_counter() - start)
            delivered.append(await asyncio.wait_for(received.get(), 10) - start)
            await asyncio.sleep(0.5)
    finally:
        await sender.disconnect()
        await receiver.disconnect()
    print(f"  send_text returns (tool waits on this)  {summary(awaited)}")
    print(f"  browser has the whole board             {summary(delivered)}")


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("part", choices=["llm", "db", "push"])
    parser.add_argument("--runs", type=int, default=5)
    parser.add_argument(
        "--pause", type=float, default=8, help="seconds between LLM calls"
    )
    parser.add_argument("--models", default="", help="only models whose name has this")
    parser.add_argument("--bare", action="store_true", help="persona only, no tools")
    args = parser.parse_args()
    if args.part == "llm":
        asyncio.run(bench_llm(args.runs, args.pause, args.models, args.bare))
    elif args.part == "db":
        asyncio.run(bench_db(args.runs))
    else:
        asyncio.run(bench_push(args.runs))


if __name__ == "__main__":
    main()
