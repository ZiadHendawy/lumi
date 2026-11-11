# Lumi — Project Plan

**Goal:** A deployed, delightful voice assistant that listens, talks back, remembers the user across sessions, and calls at least one external API, plus one deep dive done well. **Every line of code should be easy to explain to someone new to it.**
**Timebox:** 2 days (about 15–21 focused hours) + half a day of buffer. **Budget:** $0. **Deliverables:** live URL, GitHub repo, short PRD/write-up, optional demo video.

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
   │ WebRTC audio
   ▼
LiveKit Cloud ◀──▶ Agent worker (Python, LiveKit Cloud)
                     STT Deepgram → LLM Groq (fallback Gemini) → TTS Deepgram Aura
                     tools: memory (Neon Postgres), external API
```

**Life of one voice turn:** user speaks → VAD/turn detector decides they've finished → Deepgram transcript → Groq LLM (may call a tool) → Deepgram Aura streams audio back. Each stage's latency is logged.

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
**Planned files (agent):** `agent.py` (session setup + persona), `memory.py` (SQL + `save_fact` / `forget_fact` tools), `tools.py` (external API tool), `config.py` (providers, env vars), `schema.sql`, `tests/`, `Dockerfile`.
**Planned files (web):** `app/page.tsx`, `app/api/token/route.ts`, `components/VoiceSession.tsx`, `lib/userId.ts`, plus the `app/layout.tsx` + `app/globals.css` shell that Next.js requires.

**Cold start and greeting:** the page connects on load with the mic off, which dispatches the agent. On "Start" the browser unlocks audio, turns the mic on and calls the agent's `lumi.start` RPC, and the agent then greets the user. The agent also enforces the session caps: it shuts down after 3 min of user silence or 10 min total.

**Memory:** the `facts` table has (user_id, key, value, updated_at), one row per user and key, so new values overwrite old ones. Facts load into the prompt at session start.

## Testing & evals (set up in M0, grown every milestone)
| Layer | What | Tool | When it runs |
|---|---|---|---|
| **Unit tests** | Memory SQL (save, overwrite, forget, load), external API tool with mocked HTTP | pytest + a Neon `test` branch + mocked HTTP | Every push (fast, free) |
| **Agent evals** | Text-only conversations against the real LLM: does Lumi call the right tool with the right arguments, and does an LLM judge accept the reply? | LiveKit Agents' built-in testing helpers (pytest) | On PR and on demand (uses Groq quota) |
| **Voice smoke check** | 5-minute manual checklist on the live URL: connect, talk, interrupt, memory, tool | `docs/SMOKE_TEST.md` | End of each milestone |

**Eval scenarios** live in one file. They only ever get added:
- M0: Lumi greets the user and replies in persona.
- M1: "My favorite color is blue" → `save_fact` is called. A **new session** then answers "blue". A new value overwrites the old one. "Forget it" → `forget_fact` is called. The external tool is called with correct arguments, and a tool error gets a graceful reply, not made-up data.
- M2/M3: scenarios for the deep dive (e.g. off-script recovery, guardrail refusals, latency budget).

To keep evals stable, use a fixed model and temperature 0, and assert on **tool calls** wherever possible (they're deterministic) instead of exact wording.

## Milestones
| # | Milestone | Scope | Done when | Effort | Day |
|---|---|---|---|---|---|
| **M0** | **Infra, skeleton & test harness** | Create accounts (LiveKit, Deepgram, Groq, Google AI Studio for Gemini, Neon, Vercel, GitHub), trim the agent starter, minimal web app, providers, Neon schema, deploy, secrets, CI, latency logging, "waking up" UI state, **pytest + eval harness + smoke checklist** | Anyone can talk to Lumi on the live URL. CI is green. **Product decisions are made.** | 3–5 h | 1 |
| **M1** | **Core requirements** | Memory tools, persona prompt, external API tool, tool-error handling, plus their tests and evals | M1 evals pass. Memory survives a new session. | 3–4 h | 1 |
| **M2** | **Deep dive** | Chosen track, plus its evals and measurements | Measurable results. All earlier evals still pass. | 4–6 h | 2 |
| **M3** | **Frontend & delight** | Final UI direction, its own look (not the stock starter), voice polish, edge cases | Distinct from a one-shot build. Smoke check passes on desktop + mobile. | 2–3 h | 2 |
| **M4** | **Presentation** | README, `CODE_MAP.md`, write-up (API justification, deep-dive findings), **reader-facing doc tidy-up** (see below), demo video (also the backup demo), code walkthrough rehearsal, launch | Launched, with the repo public | 2–3 h | 2 / buffer |

**M4 doc tidy-up (reader-facing).** The planning docs stay in the repo, because they show the plan came before the code. We don't add a second PRD next to them, since two plans drift apart. Instead:
- Rewrite `README.md` as the front door: what Lumi is, the live URL, how it works, the deep dive, and a "How I planned this" link to the docs below.
- Move `PROJECT_PLAN.md` and `TECH_STACK.md` into `docs/`, and fix every link to them (README, CLAUDE.md, CODE_MAP, and each other).
- Reword the lines written for us rather than an outside reader (CLAUDE.md, CODE_MAP).
- Close or answer every open question in the plan, so a new reader doesn't see unresolved items.

**Definition of done for every milestone:** CI green + evals pass + smoke check passes + `CODE_MAP.md` updated + you can explain the change in two minutes.

**Communication:** keep a short daily log of progress and blockers.

## Risks & mitigations
- **Public URL burning free credits:** cap sessions at about 10 min, auto-disconnect after about 3 min of silence, and rely on LiveKit's 5-session concurrency cap. No extra rate-limit service, to keep it simple.
- **Groq rate limits:** our free key allows **8K tokens/min** (about 3–5 voice turns a minute) and 1,000 requests/day per model, shared by testing, evals and live users. Keep prompts small, fall back to Gemini Flash-Lite automatically (covered by an eval). Evals run on PR, not on every push.
- **Flaky LLM evals:** assert on tool calls, use temperature 0, and keep judge criteria narrow.
- **Cold start (10–20 s) on the free agent:** connect when the page loads and show a "waking up" state.
- **Browser autoplay rules:** Lumi greets after the user clicks "Start".
- **Network distance:** put the agent in a region near the providers, and measure it.
- **Scope creep:** product choices are locked at the end of M0. No new features after M3.

## Open questions
1. **Deep dive** (**decide by end of M0**): Latency, UI/UX & multimodal, guardrails, multistep workflow, multiplayer, or something else (e.g. bilingual Arabic/English, telephony)?
2. **External API** (**decide by end of M0**): Weather, calendar, maps, transit or something else? (Needs a 2–3 sentence justification.)
3. **Frontend direction** (**decide by end of M0**): minimal voice orb, avatar, live captions with word highlighting, or chat + voice hybrid?
4. **Persona** (**decide by end of M0**): who is Lumi (personality, tone, voice)? It should feel creative and personal.
5. **Languages:** English only, or Arabic too? Arabic would likely change the STT/TTS picks; check each provider's Arabic support.
6. **Identity:** anonymous per-browser memory, or a lightweight login so memory follows the user across devices?
7. **Providers:** do we need paid keys (Groq, Gemini, Sambanova, Cerebras, and Cartesia/ElevenLabs for TTS)? Higher-limit keys would remove the main free-tier risks.
8. **Repo visibility:** public or private?
9. **Memory scope:** default is explicit facts saved by the LLM through `save_fact`. Do we need automatic preference extraction or semantic recall (pgvector + an embeddings provider)?
