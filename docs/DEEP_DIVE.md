# Deep dive

## Latency

Goal: get time-to-first-audio as low as possible, measure it, and say where the time goes.

All numbers below were measured on 2026-11-12. Two sources:

- **Offline**: `agent/bench_latency.py`, run on the dev Mac (Cairo, about 220 ms from `us-east`). It sends Lumi's real prompt and tool schemas to one model at a time, and times Neon, the board push and Aura. It can't time speech-to-text or end of turn, because those need a microphone.
- **Live**: one end-to-end run with real audio through Chrome. The agent ran **locally on the dev Mac**, not on LiveKit Cloud, so every database query paid the 220 ms round trip. gpt-oss-120b was at its daily cap, so turns ran on qwen or Gemini.

Groq's free tier was the constraint all day. gpt-oss-120b was at its 200K tokens/day cap (a rolling 24 h window, used up by CI and dev). The other models kept hitting 7–8K tokens/min because CI shared them. So samples are small (n = 3–8), and some cells say "not measured (quota)".

### Where the time goes

**A task turn** ("add buy milk for next Friday"), live run, qwen path. e2e was 3.8 s and 4.3 s; one update turn took 2.5 s.

| Stage | Time | Source |
|---|---|---|
| End of speech → transcript → turn detector decides | part of the ~1.9 s not covered by the rows below (not split in the live log; now logged, see "Next") | live |
| LLM call 1: model emits the tool call | qwen 0.58 s (0.45–1.86, n=3) | offline |
| Failed attempt on gpt-oss-120b first (429) | ~0.2 s per request | live log |
| Tool: SQL + board push | 0.96–1.34 s live; 4 queries × 220 ms from the Mac | live, offline |
| LLM call 2: first token of the reply | 0.64 s live; qwen 0.40 s (0.37–0.44, n=3) offline | live, offline |
| TTS first audio (Aura) | 0.25–0.30 s live; 0.35 s (0.34–0.92, n=8) offline | live, offline |

**A plain reply** ("what's on my board?") skips the tool and the second call. Offline first token on qwen: 0.53 s (0.41–0.63, n=3). The M0 smoke test, with a smaller prompt and no tools, saw e2e 0.63–2.56 s (median ~0.9 s).

**Per model**, offline, with the real prompt (~1.5K input tokens, 7 tools), connection already warm:

| Model | Plain reply, first token | Tool call emitted | Reply after tool | Tool call correct? |
|---|---|---|---|---|
| gpt-oss-120b (low) | not measured (quota) | not measured (quota); ~0.85 s on 2026-11-11 | not measured (quota) | yes (evals) |
| gpt-oss-20b (low) | not measured (quota); 0.35–1.9 s for the old greeting request (n=3) | ~0.3 s (reliability PR) | not measured (quota) | yes (evals) |
| qwen3.8-27b | 0.53 s (0.41–0.63) | 0.58 s (0.45–1.86) | 0.40 s (0.37–0.44) | **no, 0/6**: left out priority and date |
| Gemini flash-lite-latest | 9.2 s (8.3–10.2, n=5) | 4.1 s (4.1–7.8, n=3) | 3.7 s (0.9–7.7, n=3) | yes, 3/3 |

Live, Gemini turns took 5.1–10.3 s end to end (LLM first token 2.7–5.5 s). Gemini's free tier is slow at random rather than slow because of the model: a three-word prompt took 0.9–10.8 s across four Flash-Lite versions, with some 503s. It can only be a last resort.

**Our own code**, offline:

| What | Time | Note |
|---|---|---|
| One Neon query from the dev Mac | 220 ms median (n=8) | about 1–2 ms when the agent runs in `us-east` next to Neon (expected, not measured) |
| Task tool SQL, before → after this PR | 876 → 689 ms (n=8) | 4 queries → 3 |
| Neon connect + schema | 1.6–2.5 s from the Mac | runs while the room connects |
| Board push: `send_text` returns | 2 ms (n=8) | the tool doesn't wait on delivery |
| Board push: browser has it | 204 ms (n=8) | Mac → LiveKit Cloud → Mac |
| First request on a cold connection vs warm | 0.67 vs 0.46 s (qwen, n=5) | AgentSession prewarms only the first model |
| Prompt size: 330 tokens, no tools vs full 1.5K + tools | 0.27 vs 0.53 s (qwen) | ~0.2 ms per input token |

**The screen leads the voice.** In every live turn the board reached the browser 1.3–6.4 s before Lumi started talking (`board push to speech`). The push happens inside the tool, before the second LLM call and TTS.

### What the prompt is made of

| Part | Size |
|---|---|
| Persona | ~310 tokens |
| Tool schemas (7) | ~680 tokens (the biggest part) |
| Calendar (14 days) | ~60 tokens |
| Board (3 tasks) + facts | ~60 tokens |
| Chat history | grew ~150 tokens a turn in the live run (2.0K → 2.9K per request) |

### What I changed, and the effect

| Change | Effect | Commit |
|---|---|---|
| **Greeting is said, not generated** (`prompt.greeting`, `session.say`) | First audio is Aura alone: 0.35 s, vs 0.35–1.9 s of LLM first token plus Aura on gpt-oss-20b. The old request had only system messages, which qwen and Gemini reject (HTTP 400), so with gpt-oss capped the user heard **no greeting at all**. Saves ~1.5K tokens per session. | `Agent: say the greeting instead of generating it` |
| **One board read per task change**, shared by the screen and the prompt | Tool SQL 876 → 689 ms from the Mac (4 → 3 queries). Deployed, it's ~1 ms per query, so the win is small there. | `Tools: read the board once per change…` |
| **Each LLM request carries only the last 20 chat items** | Stops requests from growing every turn. At ~0.2 ms per token, a 20-turn session's extra ~3K tokens would add ~0.6 s to every first token, and two such requests use the whole 8K tokens/min. Not measured live (quota). | `Agent: send only the last 20 chat items…` |
| **Logs for the gaps**: startup timings (`database connected`, `room connected`, `session ready`), `start clicked` with timezone, and `user turn latency` (`transcription_delay`, `end_of_turn_delay`) | The next live run can split the ~1.9 s before the first LLM call, and show whether Neon holds up the Start button. | `Agent: log startup timings`, `Agent: log transcription and end-of-turn delay…` |

A side effect of the greeting fix: in the live log, every request tried gpt-oss-120b first and paid a ~0.2 s 429. The greeting had failed on all three models, which put the `FallbackAdapter` into its "all failed" state. In that state it tries every model in order on each request, and a model that answers is not marked available again. With no LLM greeting, a session can't start in that state.

### What I tried and didn't keep

| Idea | Finding | Decision |
|---|---|---|
| Put qwen first (it was ~0.2 s faster on 2026-11-11) | Same speed as before (0.53 s plain), but it called `create_task` with priority and date set to null in 5/5 bench runs and in 1 AgentSession run. It then told the user "high priority for Friday" anyway. It passed the same eval once with board ids from the database, so it's sensitive to the prompt. | Rejected. The reliability PR already moved it behind gpt-oss-20b. |
| Prewarm every fallback model, not only the first | Saves ~0.2 s, once per session, only if the fallback comes within ~2 min (the HTTP keep-alive). | Not done: too little for the extra code. Worth another look if gpt-oss-120b stays capped. |
| Turn on preemptive generation | It's **already on** by default in Agents 1.8. The LLM starts on the final transcript, before the turn detector commits. The live log shows it used 9 times and thrown away 0 times. | Kept the default. |
| Lower the endpointing delay | With the `v1-mini` turn detector the defaults are already the tighter streaming ones: `min_delay` 0.3 s, `max_delay` 2.5 s (not the 0.5/3.0 the docs list). Deepgram's own endpointing is 25 ms. Lower would cut people off mid-thought, and this can't be measured without audio. | Left as is. |
| `preemptive_tts` (start TTS before the turn is confirmed) | Could save up to one TTS first-audio time (~0.3 s) on plain replies. It only costs Deepgram credit, not Groq tokens. Needs a live A/B. | Not done (couldn't measure). |
| Shorten the calendar or the notes preview | The calendar is ~60 of ~1.5K tokens: ~10 ms at 0.2 ms per token. | Not worth it. |
| Start the session before the database connects | The Neon connect already runs alongside the room connect. Reordering would let a Start click arrive before the user's board is loaded (a race to handle). | Not done. The new startup logs will show if it matters. |
| A different Gemini model | Every Flash-Lite version was erratic (0.9–10.8 s for three words). | No change. Gemini stays the last resort. |

### What I'd do next with another week

1. **Measure deployed, not local.** Run the same e2e on LiveKit Cloud (`us-east`, next to Neon and Groq). Tool time should drop from ~1 s to tens of ms. Then read the new `user turn latency` lines to split end of turn from transcription.
2. **A paid or higher-limit LLM** (Groq Dev tier, Cerebras). Most of today's slow turns were the free tier, not the pipeline: gpt-oss-120b was capped, so turns fell to qwen (wrong tool calls) or Gemini (5–10 s).
3. **Skip the second LLM call on simple task changes.** The tool already writes the confirmation ("Created task 4 'Buy milk', high priority…"). Speaking it straight away would save the whole call 2 (~0.4–0.6 s). The catch: replies get stiffer, and multi-task turns need care.
4. **A short spoken filler** ("On it.") while a tool runs, so a 1 s tool doesn't sound like silence.
5. **Smaller tool schemas.** They are almost half the prompt. Merge `restore_task` into `update_task`, or give a phase only the tools it can use.
6. **Prompt caching.** Keep the static persona and tools as a fixed prefix where the provider caches it (Groq reported 0 cached tokens for qwen today).
7. **A speech-to-speech model** (Gemini Live, OpenAI Realtime) for the lowest possible latency, at the cost of per-stage visibility and guardrails between stages.

### How to reproduce

```bash
cd agent && uv sync
uv run python bench_latency.py db --runs 8        # Neon (needs TEST_DATABASE_URL)
uv run python bench_latency.py push --runs 8      # board push (needs LIVEKIT_*)
uv run python bench_latency.py tts --runs 8       # Aura first audio for the greeting
uv run python bench_latency.py llm --runs 3 --pause 20               # every model in the chain
uv run python bench_latency.py llm --runs 3 --models qwen --pause 20 # one model
uv run python bench_latency.py llm --runs 5 --models qwen --bare     # persona only, no tools
```

The LLM runs cost ~5K Groq tokens each (three requests of ~1.5K), and the free tier is 8K a minute per model, so keep `--runs` small and `--pause` long. In a live session, `lk agent logs` shows `turn latency`, `user turn latency`, `tool call`, `board push to speech`, and the startup lines.

## Correctness

(see PR description; written up in the final docs PR)

## Voice-to-screen sync

(see PR description; written up in the final docs PR)
