# Lumi — Project Plan

**Goal:** A deployed, delightful voice assistant that listens, talks back, remembers the user across sessions, and calls at least one external API, plus one deep dive done well. **Every line of code should be easy to explain to someone new to it.**
**Timebox:** 2 days (about 15–21 focused hours) + half a day of buffer. **Budget:** $0. **Deliverables:** live URL, GitHub repo, short PRD/write-up, optional demo video.

## Product (decided 2026-11-12)
**Lumi runs your task board by voice.** One button starts the conversation. While you talk, your board ("Lumi's board") updates live: create or delete a task, rename it, add or change its notes (body), change its priority, set, move or remove its target date, and mark it done. English only for now.

- **Why a task board:** voice is fastest for capturing things ("add call the bank, Friday, high priority"), and a screen is better for reviewing them. Pairing the two shows off both, and each change is easy to demo and to verify.
- **The core requirements:** *memory* = the board plus a small facts store ("What's my favorite color?"), both in Postgres, so they survive sessions. The *external API* is Tavily web search, which can save what it finds into a task's notes (see decision log). *Deployed* = the same Vercel + LiveKit Cloud setup as M0.
- **The look, "the lantern board":** a dark, warm board where **priority is how brightly a card glows**. The talk button is the lantern itself and reacts to your voice and Lumi's. Done tasks are "extinguished".

## Decision log (why we chose what we chose)
| Decision | Choice | Why (and what we rejected) |
|---|---|---|
| How the board reaches the browser | The **agent** is the only thing that talks to the database. After every change it reads the board back from Postgres and sends the whole board to the browser on a LiveKit **text stream** (topic `lumi.board`). | No second backend and no DB access from Vercel. The screen shows what is *in the database*, not what the LLM says it did, which is the core of the correctness story. We rejected a Next.js `/api/tasks` route, because that means two code paths with the same SQL in two languages plus a new DB driver. We rejected RPC to the browser, because of its 15 KB payload cap. |
| Board while the agent cold-starts | The browser keeps the last board in `localStorage` and shows it straight away, marked "last seen", until the live board arrives | The free agent can take 10–20 s to wake. A blank board would feel broken. Zero dependencies. |
| Send the whole board, or diffs? | The whole board, plus a small `change` note (which task, which fields) for the animation | The browser never has to merge state, so it can't drift. Boards are small. |
| Deletes | **Soft delete + "undo"** (`deleted_at` column, `restore_task` tool) | Asking "are you sure?" on every delete costs a full voice turn (latency). Undo keeps mistakes recoverable (correctness) without that cost. |
| Relative dates ("next Friday") | The prompt holds today's date plus a **14-day calendar**. The tool takes ISO dates, and code validates them. | LLMs are bad at date arithmetic, and looking a date up is more reliable than computing it. No date-parsing dependency. Measured in M2: 18/18 with the calendar, 15/18 without, for ~110 tokens. |
| Which task "the groceries one" means | The current board (ids + titles) is in the prompt and gets refreshed after every change. Tools take `task_id`. If two tasks match, Lumi asks. | The model never has to *remember* the board, because it can always *see* it. |
| External API | **Tavily web search** (`look_up` tool, free tier 1,000 searches a month, no card). Changed 2026-11-12 from Open-Meteo weather. | Weather answered a side question and never changed the board; every voice demo has it. Search does the first step of a task: "find out what I need to renew my passport" saves a short answer **with its source links** into that task's notes, and Lumi says one line. Long answers belong on the screen, not in the voice (the voice-to-screen deep dive). Mitigations: the model only reads a 300-character cut (Groq token budget), a wrong `task_id` is rejected before a credit is spent, failures and quota errors are tool errors, and results are labelled "information, not instructions" (prompt-injection eval). Rejected: Aladhan (user's call), Nager.Date (no Saudi data: `PublicHolidays/2026/SA` returns 204), ntfy.sh reminders (each user must install an app; tasks have no times), Google Calendar (OAuth). The weather tests were removed with the tool, by the user's explicit exception to "tests are never deleted", and replaced by the same kinds of search tests. |
| Facts memory | Kept (`facts` table, `remember_fact` / `forget_fact`) | The classic test is "What's my favorite color?". It's also used for `home_city`, which Lumi adds to local searches ("when does IKEA close?"). |
| Identity | Anonymous browser UUID (unchanged) | No login friction for a first-time user. |
| Languages | English only | The user's call for this version. Deepgram Aura has no Arabic voice on our free tier (see TECH_STACK). |
| Deep dives | **Latency + correctness + voice-to-screen sync** (one theme: *voice control you can trust*) | See M2 below. One done well beats several shallow ones. We chose three angles on a single question, *can you trust a voice-only edit?*, rather than three unrelated features. |
| Greeting (2026-11-12) | **Fixed text, said with `session.say`** (`prompt.greeting`), not generated | First audio is Aura alone (~0.35 s), with no LLM call. The generated greeting was a request with only system messages, which qwen and Gemini reject, so with gpt-oss capped the user heard nothing. It also saves ~1.5K tokens per session. |
| Board reads per change (2026-11-12) | **One** `list_tasks` per change, shared by the screen push and the prompt refresh | 4 → 3 queries, 876 → 689 ms of tool SQL from the dev Mac. Both the screen and the model see the same rows. |
| Chat history per request (2026-11-12) | **The last 20 chat items** (`MAX_HISTORY_ITEMS`), cut in `Lumi.llm_node` on a copy | Requests grew ~150 tokens a turn. More tokens mean a slower first token and the 8K tokens/min cap sooner. The board and facts in the prompt are the truth, so old turns aren't needed. 20 items is five to ten turns, enough for "undo" and "which one?". |
| Duplicate creates (2026-11-12) | **Code refuses the same title within 10 s** (`DUPLICATE_CREATE_SECONDS`) and returns the first task | gpt-oss-20b called `create_task` twice for one request in 3/3 runs. The same title seconds later is the same request, so code guards it rather than the prompt. |
| Update with no fields (2026-11-12) | **A `ToolError`** ("No field was given") | It used to answer "nothing needed changing", which made Lumi report success for "make it low priority" after an all-null call. |
| LLM chain (2026-11-12) | **gpt-oss-120b → gpt-oss-20b → Gemini Flash-Lite**, all at low reasoning effort, `attempt_timeout` 10 s. **qwen dropped.** | Groq's caps are per model (200K tokens/day each), so a second Groq model adds a day of capacity. qwen was tried as a backup, but it sent `create_task` with priority and date null in 6/6 runs and then confirmed them out loud, and passed the ambiguity and priority evals 2/6 (gpt-oss-20b: 6/6). A wrong change confirmed out loud is worse than a slow Gemini answer. Details: TECH_STACK §4. |
| When every model fails (2026-11-12) | **A fixed sorry line** (`prompt.NO_MODEL_ANSWERED`), kept out of the chat history | Without it LiveKit dropped the turn without a word: live, the lantern sat on "thinking" for 33 s. A fixed line needs no LLM, which is exactly what is unavailable then. |
| Evals in CI (2026-11-12) | **PRs run a `core` tier** (`pytest -m "eval and core"`, 17 of 35) and **skip evals when `agent/` didn't change**. The full suite runs on demand. | A full run costs ~100K Groq tokens, half the daily cap that the live demo also needs. Each feature's PR adds one or two core evals. |
| Ambiguity eval (2026-11-12) | **Kept out of the core tier**, runs in the full suite | It passes ~75–80% of runs on gpt-oss-20b, and only the model can see that "the call" is ambiguous, so code can't guard it. A flaky required check teaches people to ignore red CI. Its pass rate is tracked in docs/DEEP_DIVE.md instead. |
| Memory on screen (2026-11-12) | **The saved facts ride in every `lumi.board` push** and show as a "Lumi remembers" shelf. Fact changes push with `change: null`; the browser compares old and new facts to light the chip. | Memory is a core feature, but it was only audible. Same channel and same three queries per change (the facts were already read for the prompt). No new change-note kinds, so the task contract stays as it was. |
| Icon and link preview (2026-11-12) | A lantern mark as `app/icon.svg`, generated `apple-icon` and `opengraph-image` with `next/og`, and a `manifest.ts` | The tab, the home screen and the link preview someone pastes are the first things a visitor sees, before any voice turn. Next's file conventions add the `<head>` tags themselves and `next/og` ships with Next, so no dependency. The masthead, apple icon and preview share one `LanternMark` component; `icon.svg` is a static copy because Next serves it as a file. |
| Cost model (2026-11-12) | **A "What it would cost" section on `/stats`**: the last 30 days at pay-as-you-go list prices (`PRICES` in `web/lib/stats.ts`, sources in TECH_STACK §15), split by provider, per spoken reply and per 1,000 conversations (assumed 8 replies each) | It turns the free-tier usage we already record into the number a buyer asks about. No new data and no new dependency: it reuses `provider_usage`, `turn_metrics` and Tavily's usage count. The assumptions (agent minutes from speech-to-text minutes, replies per conversation) are stated on the page rather than hidden. |
| Showing tool activity (2026-11-12) | **Forward LiveKit's `tool_execution_updated` (start, end) on a `lumi.activity` text stream.** The lantern says "Searching the web…"; a card being looked up breathes light. | A web search takes 1–3 s that used to be a silent "thinking". The event fires when the model has decided, before the tool runs, so it is the earliest honest signal. No tool code changed: the session event covers every tool. The board push stays the only truth; activity is cleared whenever Lumi isn't thinking. |
| X-ray and session receipt (2026-11-12) | **The agent sends each reply's timings (`lumi.turn`) and the rendered prompt (`lumi.prompt`); the browser measures its own screen lead.** Press X for a live timing chart, the model that answered and "What Lumi sees"; End shows a one-card receipt. | The deep dives were in logs and on `/stats`, which a visitor may never open. Now they are on the page while you talk. No new data: the turn row is the one already saved to `turn_metrics`. The browser's own lead (board arriving → Lumi speaking) closes the sync deep dive's "browser-side timing in production" item. |
| Calendars (2026-11-12) | **Real today without OAuth:** a per-task Google Calendar link and a whole-board `.ics` download, both built in the browser (`web/lib/calendar.ts`). Two-way sync is listed as planned, in a "Connections" panel with the other planned integrations. | Calendars are the obvious next integration for a task board. A prefilled link and a file need no OAuth consent screen, no token storage and no new service, and those are why Google Calendar was rejected as the external API (TECH_STACK §13). Planned items are labelled "Planned" with one line on what each would take, not shown as fake buttons, so the panel never promises something that isn't there. |
| Connections panel (2026-11-13) | **The panel lists only integrations:** the calendar file and the per-card Google Calendar link under "Works today", two-way calendar sync and phone calls under "Coming soon". Each is one row: a generic glyph, a name, one short line, and a button or a status pill. | Owner feedback: the panel had too much in it and read as long paragraphs of equal weight. Arabic, a family board, reminders, sign-in and recurring tasks are the roadmap, not connections, so they live only in the README "Roadmap". What an unbuilt item would take is a tooltip, not a paragraph. |
| Read-along (2026-11-12) | **Lumi's caption highlights the word being spoken, and a card lights up while Lumi says its title.** Matched in the browser on whole words from LiveKit's audio-synced transcript. | Captions with word-level highlighting are a well-known voice UI pattern. LiveKit already sends the agent transcript in step with the audio, so the newest word is the spoken one, with no TTS change. Aura only aligns per sentence, so word timing is estimated from the speech rate; exact word timing needs Cartesia or ElevenLabs, which are not free enough. Matching on whole titles keeps it simple and never lights the wrong card; a paraphrased title just doesn't light up. |
| Keys and suggestions (2026-11-12) | **Space talks or mutes, Esc ends, X opens X-ray. Before the first words, up to three phrases picked from the board** ("What's overdue?", "Move “Plan the trip” to Friday"). | A first-time user sees what Lumi can do with *their* board, not a fixed list, which shortens the "what do I say?" pause. Keys make a desk demo faster. Both are pure browser code; the suggestions are a tested function of the board. |
| Fixed replies, a $0 classifier (2026-11-12) | **A table of exact phrases** ("thanks", "can you hear me?", "hi", "bye", "never mind") **answered in `Lumi.llm_node` with no model call.** Only the whole utterance counts; anything longer goes to the model. | Each of these costs ~1.5K input tokens of the 8K/min cap and a 0.4–1 s model wait, for an answer that never changes. `llm_node` runs before every request, the preemptive one included, so no tokens are spent (the `on_user_turn_completed` hook runs after the preemptive request has already gone out). Rejected: an embedding "semantic router" (Groq has no embeddings; a local model adds a download and cold start), an LLM as classifier (spends the tokens it saves), routing whole commands like "undo" (their meaning depends on context, which is the model's job). |
| Night strip and source chips (2026-11-12) | **A 14-day strip above the lanes** (today + 13 days, a dot per open task lit by priority, an overdue count) and **web-search links in notes shown as site-name chips**. Both are pure helpers in `web/lib/board.ts` (`nightStrip`, `splitLinks`), with no dependency. | The strip draws the same 14-day calendar the model reads in its prompt, so the correctness story (15/18 → 18/18 on relative dates) is visible: you see which Friday "next Friday" became. Raw URLs in a card were long and unreadable; a chip names the source Lumi speaks ("ikea.com"). Notes come from the web, so links are only http(s) and nothing is rendered as HTML. |
| Clickable calendar and month view (2026-11-13) | **Every day in the strip is a button that filters the board to that day** (open and done tasks, a "Showing Fri 20 Nov · 2 tasks / Show all" bar), and **"Month" swaps the strip for a Monday-first month grid** with the same dots (past days' open tasks in the overdue colour). The filter clears whenever the agent sends a change. | Owner feedback: 14 unclickable days were confusing. The strip stays the default because it is the prompt's calendar (the correctness story); the month is one click away. Pure helpers (`monthGrid`, `tasksOnDay`, `dayFilterText`) share one per-day builder with `nightStrip`, so both views agree, and are tested. The filter clears on an agent change because the voice-to-screen sync promise is that you see the changed card while Lumi says it; a filtered board could hide it. No date-picker dependency. |
| End of the day, and what we left out (2026-11-12) | **"All of today's lanterns are out"** when every task due today is done and nothing is overdue. **Not built:** sound cues and a persistent change log. | The line is a small reward that fits the lantern idea, as a tested function of the board. Sounds were dropped because a chime the page plays can reach the microphone and be heard as the user interrupting (barge-in), and that can't be checked without live audio. A `task_events` audit table would add a query to every change (the three-query budget) and a history view to show it; soft deletes already keep the rows, so it is the next step if an audit trail is needed. |
| End-of-session card (2026-11-13) | **In the user's words:** "3 tasks added · 2 done · 1 new thing remembered", and "Saved to your board for next time." **The timings, the screen lead and the models moved into the X-ray panel's "This session".** | The first receipt showed every user median latency, screen lead and model names: engineering numbers, not something a user asked for. X-ray only opens on request (button or X), so the deep dives stay one click away for the curious without sitting in a user's way. The tally is counted per push in the board updater (`addToTally` in `lib/turns.ts`). |
| Editable memory (2026-11-13) | **The memory panel (Edit on the shelf) adds, changes and forgets facts through the agent, on a `lumi.memory` RPC**, and says what is kept, where and who reads it, with a link to the prompt in X-ray. **Capped at 20 facts of 40 + 120 characters.** | The user should control and see what Lumi keeps, not only speak it. Going through the agent keeps it the database's only writer, and the same `publish` path re-renders the prompt, so a typed fact is usable in the next reply and the chips show what was stored. The cost: editing needs the agent connected (it is, from page load, after its cold start). A Next.js route writing the table was rejected: a second writer, a new write-capable database role on Vercel, and the agent would need telling mid-session. The caps exist because every fact rides in every prompt. |

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
                     STT Deepgram → LLM Groq gpt-oss-120b → gpt-oss-20b → Gemini → TTS Deepgram Aura
                     tools: tasks + facts (Neon Postgres), web search (Tavily)
```

**Life of one voice turn:** user speaks → VAD/turn detector decides they've finished → Deepgram transcript → Groq LLM (may call a tool) → tool writes to Postgres and pushes the board to the browser → Deepgram Aura streams the spoken confirmation back. Each stage's latency is logged, including how far the board update lands ahead of the voice.

**Agent ↔ browser contract** (the only coupling between `agent/` and `web/`):
1. `lumi.board` text stream, agent → browser: `{"tasks": [{id, title, body, priority, target_date, done, updated_at}], "facts": {key: value}, "change": {action, task_id, title, fields} | null}`. It's sent when the user joins (at page load) and after every change, facts included.
2. `lumi.activity` text stream, agent → browser: `{status: "started", call_id, tool, task_id}` when the model picks a tool (before it runs) and `{status: "ended", call_id}` after. Only a hint for the screen; the board stays the truth.
3. `lumi.turn` and `lumi.prompt` text streams, agent → browser: each reply's stage timings (the `turn_metrics` row) and the rendered instructions, for the X-ray panel.
4. `lumi.memory` RPC, browser → agent: a typed memory edit (`remember`, `forget`, `forget_all`). The agent writes it and the facts come back on `lumi.board`.
5. `lumi.start` RPC, browser → agent, on click: payload `{"timezone": "<IANA name>"}`, so "today" and "tomorrow" mean the user's day.
6. Captions use LiveKit's standard transcription streams.

| Layer | Choice | Why |
|---|---|---|
| Realtime + agent | **LiveKit** Cloud (free) + LiveKit Agents (Python) | Handles audio, turn-taking and interruptions for us |
| STT / LLM / TTS | Deepgram / Groq gpt-oss-120b → gpt-oss-20b → Gemini Flash-Lite / Deepgram Aura | Fast and $0. Swappable through config. |
| Token API | One Next.js API route | No separate backend |
| Memory | Neon Postgres, `tasks` and `facts` tables | Persists across sessions. Plain SQL. |
| Identity | Anonymous UUID in localStorage | No login for a first-time user |
| Frontend | Minimal Next.js app (LiveKit React hooks), Vercel | Few files, fully ours |
| Hosting | Vercel (web) + LiveKit Cloud (agent) | Both free |
| CI/CD | GitHub Actions (lint + unit tests every push, evals on PR, agent deploy on `main` when `agent/` changes) + Vercel Git deploys | Catches regressions. Nothing ships by hand. |

**Repo layout:** `agent/` (Python, uv) and `web/` (Next.js, npm) in one repo. CI lives in `.github/workflows/ci.yml`.
**Planned files (agent):** `agent.py` (session setup, persona, prompt with board + calendar, board push), `memory.py` (plain async SQL for tasks and facts, no LiveKit imports), `tools.py` (the `@function_tool` functions: task tools, fact tools, web search), `config.py` (providers, env vars), `schema.sql`, `tests/`, `Dockerfile`.
**Planned files (web):** `app/page.tsx`, `app/api/token/route.ts`, `components/VoiceSession.tsx` (session, lantern button, captions), `components/Board.tsx` (cards, groups, change animations), `lib/board.ts` (payload types + pure date helpers), `lib/userId.ts`, plus the `app/layout.tsx` + `app/globals.css` shell that Next.js requires.

**Cold start and greeting:** the page connects on load with the mic off, which dispatches the agent. On "Start" the browser unlocks audio, turns the mic on and calls the agent's `lumi.start` RPC, and the agent then greets the user. The agent also enforces the session caps: it shuts down after 3 min of user silence or 10 min total.

**Memory:** the `facts` table has (user_id, key, value, updated_at), one row per user and key, so new values overwrite old ones. The `tasks` table has (id, user_id, title, body, priority low/medium/high, target_date, done, created_at, updated_at, deleted_at). Both load into the prompt at session start, and the board is re-rendered into the prompt after every change.

## Testing & evals (set up in M0, grown every milestone)
| Layer | What | Tool | When it runs |
|---|---|---|---|
| **Unit tests** | Memory SQL (save, overwrite, forget, load), tools, the board contract, external API tool against a local fake server; web board helpers | pytest + a Neon `test` branch; Node's built-in test runner for `web/lib` | Every push (fast, free) |
| **Agent evals** | Text-only conversations against the real LLM: does Lumi call the right tool with the right arguments, and does an LLM judge accept the reply? | LiveKit Agents' built-in testing helpers (pytest) | Core tier on PRs that change `agent/`, full suite on demand (uses Groq quota) |
| **Voice smoke check** | 5-minute manual checklist on the live URL: connect, talk, interrupt, memory, tool | `docs/SMOKE_TEST.md` | End of each milestone |

**Eval scenarios** live in one file. They only ever get added:
- M0: Lumi greets the user and replies in persona.
- M1: "My favorite color is blue" → `remember_fact` is called. A **new session** then answers "blue". A new value overwrites the old one. "Forget it" → `forget_fact` is called. Each task action calls the right tool with the right arguments: create, rename, set body, change priority, move or remove the date, mark done, delete, undo. `look_up` is called with the right task (or none for a quick question, with the home city added), a tool error gets a graceful reply, not made-up data, and instructions inside a search result are not followed.
- M2 (correctness): relative dates resolve to the right ISO date for a fixed "today". An ambiguous reference makes Lumi ask instead of guessing. An unknown task gets no fake success. One sentence with two tasks makes two creates.

To keep evals stable, use a fixed model and temperature 0, and assert on **tool calls** wherever possible (they're deterministic) instead of exact wording.

## Milestones
| # | Milestone | Scope | Done when | Effort | Day |
|---|---|---|---|---|---|
| **M0** | **Infra, skeleton & test harness** | Create accounts (LiveKit, Deepgram, Groq, Google AI Studio for Gemini, Neon, Vercel, GitHub), trim the agent starter, minimal web app, providers, Neon schema, deploy, secrets, CI, latency logging, "waking up" UI state, **pytest + eval harness + smoke checklist** | Anyone can talk to Lumi on the live URL. CI is green. **Product decisions are made.** | 3–5 h | 1 |
| **M1** | **Core requirements** | `tasks` + `facts` schema, task tools (create, update, delete, undo), fact tools, web search tool, board push to the browser, persona prompt, tool-error handling, plus their tests and evals | M1 evals pass. Board and facts survive a new session. | 3–4 h | 1 |
| **M2** | **Deep dives** | Correctness, latency and voice-to-screen sync (below), plus their evals and measurements, written up in `docs/DEEP_DIVE.md` | Measurable results. All earlier evals still pass. | 4–6 h | 2 |
| **M3** | **Frontend & delight** | The lantern board: lantern talk button with live states, cards grouped by date, priority as glow, change animations, live captions, mobile layout | Distinct from a one-shot build. Smoke check passes on desktop + mobile. | 2–3 h | 2 |
| **M4** | **Presentation** | README, `CODE_MAP.md`, write-up (API justification, deep-dive findings), **reader-facing doc tidy-up** (see below), demo video (also the backup demo), code walkthrough rehearsal, launch | Launched, with the repo public | 2–3 h | 2 / buffer |

**Status (2026-11-13).** Every unit ships as its own PR, stacked and merged in order (see "How work ships" below).

| # | Status | PRs |
|---|---|---|
| M0 | Done 2026-11-11. Deployed, smoke check passed. | (on `main`) |
| — | Plan, LLM fallback chain, CI eval tiers | #1 plan → #10 LLM fallback → #6 CI |
| M1 | Done: tasks SQL, task tools and board push, facts, web search (replaced the weather tool of #12) | #7 → #9 → #11 → #12 → #19 |
| M2 | Done: correctness (#13), sync logs (#14), reliability eval (#16), latency (#17), drop qwen and the sorry line (#18). Write-up in docs/DEEP_DIVE.md. | #13, #14, #16, #17, #18 |
| M3 | Done: board helpers, board stream, lantern board, lantern button and captions, fixes from the live end-to-end run | #2 → #3 → #4 → #5 → #15 |
| Polish | Done, after M3, at the owner's request: full notes, /stats, memory shelf, icon, cost model, tool activity, X-ray, calendars, read-along, keys, fixed replies, night strip, end of day (2026-11-12); then plain end-of-session card, Connections tidy-up, editable memory, clickable calendar with a month view (2026-11-13). Shipped one PR each without CI runs to save quota, with the same checks run locally. | #21–#38 |
| M4 | In progress: final docs, then the doc tidy-up below, demo video, launch | — |

"Done" here means the code, tests and docs are written and the unit tests pass. Everything is merged and deployed. Still left: the full voice smoke check on the live URL and a phone (docs/SMOKE_TEST.md), and a full eval run once the quota allows; the polish PRs (#21–#38) shipped without CI evals. The live-audio run on 2026-11-12 was against a local agent (docs/SMOKE_TEST.md). CI evals were red on 2026-11-12 because the whole LLM chain was at its daily quota, not because of code.

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

**How work ships (from M1 on):** one PR per related unit of change (e.g. "schema + SQL layer", "task tools + board push", "web search tool", "lantern board UI"), never one PR per milestone. Each PR carries its own tests and evals, and any CI change it needs (a new env var, a new test step), so CI grows with the code. PRs are stacked when one builds on another and get merged in order. The PR's CI run, with evals on PRs, is the evidence that the unit works on its own.

**Communication:** keep a short daily log of progress and blockers. Everything runs on our own free tiers.

## Risks & mitigations
- **Public URL burning free credits:** cap sessions at about 10 min, auto-disconnect after about 3 min of silence, and rely on LiveKit's 5-session concurrency cap. No extra rate-limit service, to keep it simple.
- **Groq rate limits:** our free key allows, per model, **8K tokens/min** (about 3 tool turns a minute at ~2.5K tokens each), 1,000 requests/day and **200K tokens/day on a rolling 24 h window**, shared by testing, evals and live users. Keep prompts small (short tool docstrings, notes truncated, the last 20 chat items only), use two Groq models before Gemini (per-model caps), and fall back automatically (covered by evals, including a whole task turn with every Groq model down). Evals run as a core tier on PRs that change `agent/`; the full suite is on demand.
- **Quota used up before a demo (happened on 2026-11-12):** dev, three parallel agents and CI used the whole chain's daily quota, and CI evals went red for quota (every model failed within 0.05 s). Because the window is rolling, it doesn't come back at midnight. Plan: no full eval or bench runs in the 24 h before a demo. The greeting and the sorry line need no LLM, so even a capped demo still speaks. A paid or higher-limit LLM tier would remove the risk, but the $0 budget rules it out.
- **Flaky LLM evals:** assert on tool calls, use temperature 0, and keep judge criteria narrow.
- **Cold start (10–20 s) on the free agent:** connect when the page loads and show a "waking up" state.
- **Browser autoplay rules:** Lumi greets after the user clicks "Start".
- **Network distance:** put the agent in a region near the providers, and measure it.
- **Scope creep:** product choices are locked at the end of M0. After M3 only polish the owner asked for, each one a small PR with its own tests and docs, and nothing that adds a service or a dependency.

## Open questions
Answered on 2026-11-12 (reasons in the decision log above):
1. ~~Deep dive~~: latency + correctness + voice-to-screen sync.
2. ~~External API~~: Tavily web search, saved into task notes (changed from Open-Meteo weather on 2026-11-12).
3. ~~Frontend direction~~: the lantern board (a voice button plus a live task board and captions).
4. ~~Persona~~: Lumi keeps your board. Calm, brisk and warm, with a touch of dry wit. It confirms every change in a few words that name the task, because you may not be looking at the screen.
5. ~~Languages~~: English only.
6. ~~Identity~~: anonymous per-browser UUID.
7. ~~Providers~~: no paid keys. Free tiers only.
8. **Repo visibility:** public or private? **Still open; decided at launch.**
9. ~~Memory scope~~: explicit facts plus the task board. No semantic recall.
