# Lumi — Project Plan

**Goal:** A deployed, delightful voice assistant that listens, talks back, remembers the user across sessions, and calls at least one external API, plus one deep dive done well. **Every line of code should be easy to explain to someone new to it.**
**Timebox:** 2 days (about 15–21 focused hours) + half a day of buffer. **Budget:** $0. **Deliverables:** live URL, GitHub repo, short PRD/write-up, optional demo video.

## Product (decided 2026-11-12)
**Lumi runs your task board by voice.** One button starts the conversation. While you talk, your board ("Lumi's board") updates live: create or delete a task, rename it, add or change its notes (body), change its priority, set, move or remove its target date, and mark it done. English only for now.

- **Why a task board:** voice is fastest for capturing things ("add call the bank, Friday, high priority"), and a screen is better for reviewing them. Pairing the two shows off both, and each change is easy to demo and to verify.
- **The core requirements:** *memory* = the board plus a small facts store ("What's my favorite color?"), both in Postgres, so they survive sessions. The *external API* is the Open-Meteo weather forecast, tied to target dates (see decision log). *Deployed* = the same Vercel + LiveKit Cloud setup as M0.
- **The look, "the lantern board":** a dark, warm board where **priority is how brightly a card glows**. The talk button is the lantern itself and reacts to your voice and Lumi's. Done tasks are "extinguished".

## Decision log (why we chose what we chose)
| Decision | Choice | Why (and what we rejected) |
|---|---|---|
| How the board reaches the browser | The **agent** is the only thing that talks to the database. After every change it reads the board back from Postgres and sends the whole board to the browser on a LiveKit **text stream** (topic `lumi.board`). | No second backend and no DB access from Vercel. The screen shows what is *in the database*, not what the LLM says it did, which is the core of the correctness story. We rejected a Next.js `/api/tasks` route, because that means two code paths with the same SQL in two languages plus a new DB driver. We rejected RPC to the browser, because of its 15 KB payload cap. |
| Board while the agent cold-starts | The browser keeps the last board in `localStorage` and shows it straight away, marked "last seen", until the live board arrives | The free agent can take 10–20 s to wake. A blank board would feel broken. Zero dependencies. |
| Send the whole board, or diffs? | The whole board, plus a small `change` note (which task, which fields) for the animation | The browser never has to merge state, so it can't drift. Boards are small. |
| Deletes | **Soft delete + "undo"** (`deleted_at` column, `restore_task` tool) | Asking "are you sure?" on every delete costs a full voice turn (latency). Undo keeps mistakes recoverable (correctness) without that cost. |
| Relative dates ("next Friday") | The prompt holds today's date plus a **14-day calendar**. The tool takes ISO dates, and code validates them. | LLMs are bad at date arithmetic, and looking a date up is more reliable than computing it. No date-parsing dependency. Measured in M2. |
| Which task "the groceries one" means | The current board (ids + titles) is in the prompt and gets refreshed after every change. Tools take `task_id`. If two tasks match, Lumi asks. | The model never has to *remember* the board, because it can always *see* it. |
| External API | **Open-Meteo** forecast + geocoding (free, no key, no account) | Tasks have target dates, and many depend on the weather ("wash the car Saturday", "pick up the kids"). Asking "will it rain on Saturday?" while planning the week is a natural use. Zero signup risk for anyone running it. |
| Facts memory | Kept (`facts` table, `remember_fact` / `forget_fact`) | The classic test is "What's my favorite color?". It's also used for `home_city` so the weather doesn't keep asking. |
| Identity | Anonymous browser UUID (unchanged) | No login friction for a first-time user. |
| Languages | English only | The user's call for this version. Deepgram Aura has no Arabic voice on our free tier (see TECH_STACK). |
| Deep dives | **Latency + correctness + voice-to-screen sync** (one theme: *voice control you can trust*) | See M2 below. One done well beats several shallow ones. We chose three angles on a single question, *can you trust a voice-only edit?*, rather than three unrelated features. |

## Guiding principles
1. **Infra first.** Get a working voice loop deployed end to end before any product work.
2. **Simple enough to explain.** Prefer boring, explicit code over clever abstractions (rules below).
3. **Tests from M0.** Every milestone adds tests and none get deleted, so we can iterate without breaking earlier work.
4. **Defer product decisions until the end of M0.** The tool, deep dive, UI and persona plug in without rework.
5. **One deep dive, done well.**

## Simplicity rules
- **Use the framework, don't wrap it.** No custom registries, adapters or base classes on top of LiveKit. Tools are plain `@function_tool` functions, and providers are configured in one place.
- **Few files, one job each.** The agent fits in about 5 files and the web app in about 4. Keep each file small enough to read in one sitting.
- **No ORM.** Use plain SQL in one `memory.py` and one `schema.sql`.
- **Use the starters as a reference.** The Python agent starter is small, so we keep it and trim it. The React starter is a big app, so we write a **minimal frontend** with LiveKit's React hooks and borrow only the token route.
- **Comments explain *why*, not *what*.**
- **`docs/CODE_MAP.md`:** one paragraph per file, plus the life of one voice turn. This doubles as onboarding for new contributors.

## Architecture
Comparisons and reasoning for each choice: [TECH_STACK.md](TECH_STACK.md).

```
Browser (Next.js) ──token──▶ /api/token (Next.js route, Vercel)
   │ WebRTC audio  ▲ text stream "lumi.board" (whole board as JSON after every change)
   ▼               │
LiveKit Cloud ◀──▶ Agent worker (Python, LiveKit Cloud)
                     STT Deepgram → LLM Groq (fallback Gemini) → TTS Deepgram Aura
                     tools: tasks + facts (Neon Postgres), weather (Open-Meteo)
```

**Life of one voice turn:** user speaks → VAD/turn detector decides they've finished → Deepgram transcript → Groq LLM (may call a tool) → tool writes to Postgres and pushes the board to the browser → Deepgram Aura streams the spoken confirmation back. Each stage's latency is logged, including how far the board update lands ahead of the voice.

**Agent ↔ browser contract** (the only coupling between `agent/` and `web/`):
1. `lumi.board` text stream, agent → browser: `{"tasks": [{id, title, body, priority, target_date, done, updated_at}], "change": {action, task_id, title, fields} | null}`. It's sent when the user joins (at page load) and after every change.
2. `lumi.start` RPC, browser → agent, on click: payload `{"timezone": "<IANA name>"}`, so "today" and "tomorrow" mean the user's day.
3. Captions use LiveKit's standard transcription streams.

| Layer | Choice | Why |
|---|---|---|
| Realtime + agent | **LiveKit** Cloud (free) + LiveKit Agents (Python) | Handles audio, turn-taking and interruptions for us |
| STT / LLM / TTS | Deepgram / Groq (fallback Gemini Flash-Lite) / Deepgram Aura | Fast and $0. Swappable through config. |
| Token API | One Next.js API route | No separate backend |
| Memory | Neon Postgres, one `facts` table | Persists across sessions. Plain SQL. |
| Identity | Anonymous UUID in localStorage | No login for a first-time user |
| Frontend | Minimal Next.js app (LiveKit React hooks), Vercel | Few files, fully ours |
| Hosting | Vercel (web) + LiveKit Cloud (agent) | Both free |
| CI/CD | GitHub Actions (lint + unit tests every push, evals on PR, agent deploy on `main` when `agent/` changes) + Vercel Git deploys | Catches regressions. Nothing ships by hand. |

**Repo layout:** `agent/` (Python, uv) and `web/` (Next.js, npm) in one repo. CI lives in `.github/workflows/ci.yml`.
**Planned files (agent):** `agent.py` (session setup, persona, prompt with board + calendar, board push), `memory.py` (plain async SQL for tasks and facts, no LiveKit imports), `tools.py` (the `@function_tool` functions: task tools, fact tools, weather), `config.py` (providers, env vars), `schema.sql`, `tests/`, `Dockerfile`.
**Planned files (web):** `app/page.tsx`, `app/api/token/route.ts`, `components/VoiceSession.tsx` (session, lantern button, captions), `components/Board.tsx` (cards, groups, change animations), `lib/board.ts` (payload types + pure date helpers), `lib/userId.ts`, plus the `app/layout.tsx` + `app/globals.css` shell that Next.js requires.

**Cold start and greeting:** the page connects on load with the mic off, which dispatches the agent. On "Start" the browser unlocks audio, turns the mic on and calls the agent's `lumi.start` RPC, and the agent then greets the user. The agent also enforces the session caps: it shuts down after 3 min of user silence or 10 min total.

**Memory:** the `facts` table has (user_id, key, value, updated_at), one row per user and key, so new values overwrite old ones. The `tasks` table has (id, user_id, title, body, priority low/medium/high, target_date, done, created_at, updated_at, deleted_at). Both load into the prompt at session start, and the board is re-rendered into the prompt after every change.

## Testing & evals (set up in M0, grown every milestone)
| Layer | What | Tool | When it runs |
|---|---|---|---|
| **Unit tests** | Memory SQL (save, overwrite, forget, load), external API tool with mocked HTTP | pytest + a Neon `test` branch + mocked HTTP | Every push (fast, free) |
| **Agent evals** | Text-only conversations against the real LLM: does Lumi call the right tool with the right arguments, and does an LLM judge accept the reply? | LiveKit Agents' built-in testing helpers (pytest) | On PR and on demand (uses Groq quota) |
| **Voice smoke check** | 5-minute manual checklist on the live URL: connect, talk, interrupt, memory, tool | `docs/SMOKE_TEST.md` | End of each milestone |

**Eval scenarios** live in one file. They only ever get added:
- M0: Lumi greets the user and replies in persona.
- M1: "My favorite color is blue" → `remember_fact` is called. A **new session** then answers "blue". A new value overwrites the old one. "Forget it" → `forget_fact` is called. Each task action calls the right tool with the right arguments: create, rename, set body, change priority, move or remove the date, mark done, delete, undo. The weather tool is called with the right city and date, and a tool error gets a graceful reply, not made-up data.
- M2 (correctness): relative dates resolve to the right ISO date for a fixed "today". An ambiguous reference makes Lumi ask instead of guessing. An unknown task gets no fake success. One sentence with two tasks makes two creates.

To keep evals stable, use a fixed model and temperature 0, and assert on **tool calls** wherever possible (they're deterministic) instead of exact wording.

## Milestones
| # | Milestone | Scope | Done when | Effort | Day |
|---|---|---|---|---|---|
| **M0** | **Infra, skeleton & test harness** | Create accounts (LiveKit, Deepgram, Groq, Google AI Studio for Gemini, Neon, Vercel, GitHub), trim the agent starter, minimal web app, providers, Neon schema, deploy, secrets, CI, latency logging, "waking up" UI state, **pytest + eval harness + smoke checklist** | Anyone can talk to Lumi on the live URL. CI is green. **Product decisions are made.** | 3–5 h | 1 |
| **M1** | **Core requirements** | `tasks` + `facts` schema, task tools (create, update, delete, undo), fact tools, weather tool, board push to the browser, persona prompt, tool-error handling, plus their tests and evals | M1 evals pass. Board and facts survive a new session. | 3–4 h | 1 |
| **M2** | **Deep dives** | Correctness, latency and voice-to-screen sync (below), plus their evals and measurements, written up in `docs/DEEP_DIVE.md` | Measurable results. All earlier evals still pass. | 4–6 h | 2 |
| **M3** | **Frontend & delight** | The lantern board: lantern talk button with live states, cards grouped by date, priority as glow, change animations, live captions, mobile layout | Distinct from a one-shot build. Smoke check passes on desktop + mobile. | 2–3 h | 2 |
| **M4** | **Presentation** | README, `CODE_MAP.md`, write-up (API justification, deep-dive findings), **reader-facing doc tidy-up** (see below), demo video (also the backup demo), code walkthrough rehearsal, launch | Launched, with the repo public | 2–3 h | 2 / buffer |

**M4 doc tidy-up (reader-facing).** The planning docs stay in the repo, because they show the plan came before the code. We don't add a second PRD next to them, since two plans drift apart. Instead:
- Rewrite `README.md` as the front door: what Lumi is, the live URL, how it works, the deep dive, and a "How I planned this" link to the docs below.
- Move `PROJECT_PLAN.md` and `TECH_STACK.md` into `docs/`, and fix every link to them (README, CLAUDE.md, CODE_MAP, and each other).
- Reword the lines written for us rather than an outside reader (CLAUDE.md, CODE_MAP).
- Close or answer every open question in the plan, so a new reader doesn't see unresolved items.

**M2 deep dives: one theme, *voice control you can trust*.** A voice-only edit has three ways to fail. It's slow, so you wait. It's wrong, so the wrong task changes. Or it's invisible, so you can't tell what happened. We take on one failure mode per angle:
1. **Correctness:** code owns state, and the model only maps words to tool calls. Ground truth sits in the prompt (the current board and a 14-day calendar). Priority is an enum in both the tool schema and a SQL `CHECK`. Dates are validated, every query is scoped to the user, and the spoken confirmation is built from the row actually stored. Deletes are soft, with undo. Measured by the eval suite's pass rate, including dates with and without the calendar.
2. **Latency:** time from the user stopping talking to Lumi's first audio, broken down by stage. A tool turn costs two LLM calls, so it's measured separately from a plain reply. Things we try: model choice, preemptive generation, endpointing delay, warming the DB connection, prompt size. Findings go in `docs/DEEP_DIVE.md`.
3. **Voice-to-screen sync** (our "something else", tied to the UI/UX goals): every change appears on the board, highlighted, *before* Lumi finishes confirming it out loud. The changed card and fields animate, deletes show an undo toast, and live captions show what Lumi heard. Measured as how far the board push lands ahead of the start of Lumi's speech.

**Definition of done for every milestone:** CI green + evals pass + smoke check passes + `CODE_MAP.md` updated + you can explain the change in two minutes.

**How work ships (from M1 on):** one PR per related unit of change (e.g. "schema + SQL layer", "task tools + board push", "weather tool", "lantern board UI"), never one PR per milestone. Each PR carries its own tests and evals, and any CI change it needs (a new env var, a new test step), so CI grows with the code. PRs are stacked when one builds on another and get merged in order. The PR's CI run, with evals on PRs, is the evidence that the unit works on its own.

**Communication:** keep a short daily log of progress and blockers. Everything runs on our own free tiers.

## Risks & mitigations
- **Public URL burning free credits:** cap sessions at about 10 min, auto-disconnect after about 3 min of silence, and rely on LiveKit's 5-session concurrency cap. No extra rate-limit service, to keep it simple.
- **Groq rate limits:** our free key allows **8K tokens/min** (about 3–5 voice turns a minute) and 1,000 requests/day per model, shared by testing, evals and live users. Keep prompts small (short tool docstrings, notes truncated in the prompt) and fall back to Gemini Flash-Lite automatically (covered by an eval). A task turn costs two LLM calls (one for the tool call, one for the reply), so a busy user hits the cap sooner than with chat alone. Evals run on PR, not on every push.
- **Flaky LLM evals:** assert on tool calls, use temperature 0, and keep judge criteria narrow.
- **Cold start (10–20 s) on the free agent:** connect when the page loads and show a "waking up" state.
- **Browser autoplay rules:** Lumi greets after the user clicks "Start".
- **Network distance:** put the agent in a region near the providers, and measure it.
- **Scope creep:** product choices are locked at the end of M0. No new features after M3.

## Open questions
Answered on 2026-11-12 (reasons in the decision log above):
1. ~~Deep dive~~: latency + correctness + voice-to-screen sync.
2. ~~External API~~: Open-Meteo weather, tied to task target dates.
3. ~~Frontend direction~~: the lantern board (a voice button plus a live task board and captions).
4. ~~Persona~~: Lumi keeps your board. Calm, brisk and warm, with a touch of dry wit. It confirms every change in a few words that name the task, because you may not be looking at the screen.
5. ~~Languages~~: English only.
6. ~~Identity~~: anonymous per-browser UUID.
7. ~~Providers~~: no paid keys. Free tiers only.
8. **Repo visibility:** public or private? **Still open; decided at launch.**
9. ~~Memory scope~~: explicit facts plus the task board. No semantic recall.
