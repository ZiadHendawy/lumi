# Lumi — Tech Stack Decisions

A short comparison for each layer in [PROJECT_PLAN.md](PROJECT_PLAN.md). ✅ marks the proposed pick. Free-tier and pricing details change often, so check them before committing.

**What drives the choices:** (1) low time-to-first-audio, (2) code we own and can explain in the review, (3) $0 cost, (4) shippable in 2 days, (5) keeps every deep-dive option open.

## Free-tier check (checked 2026-11-11)
Figures come mostly from third-party pricing write-ups and need a final check in each provider's console at signup.

| Service | Role | Free? | Free allowance | Catch |
|---|---|---|---|---|
| LiveKit Cloud (Build) | Realtime audio + agent hosting | ✅ Free | About 1,000 agent-session min/month (third-party figure), 5 concurrent sessions, 1 hosted agent | **The free agent scales to zero, so the first connection after idle has a 10–20 s cold start.** Stops at the limit, no surprise bill. |
| Deepgram | STT (and TTS, see below) | ✅ Free credit | $200 credit, no card needed | One-time credit, not a monthly plan. More than enough for this project. |
| Cartesia | TTS (alternative) | ⚠️ Too small | About 20k credits/month ≈ 20–25 min of audio, non-commercial | Development and demos would use it up. **No longer the default.** |
| Groq | LLM | ✅ Free | **Measured on our key (2026-11-11): 1,000 requests/day and 8,000 tokens/min per model.** Chat models offered: `openai/gpt-oss-120b`, `openai/gpt-oss-20b`, `qwen/qwen3.8-27b` (`llama-3.3-70b` is gone). | **8K tokens/min is about 3–5 voice turns a minute** before we fall back to Gemini. Keep prompts short. A task turn costs two LLM calls (tool call + reply). |
| Cerebras | LLM fallback (previous pick) | ❌ Card required | Free tier needs a credit card to get an API key | **Dropped.** |
| Gemini (Google AI Studio) | LLM fallback / vision | ✅ Free, no card | **Flash-Lite:** ~10–15 req/min, ~500 req/day. Flash: ~5 req/min, ~20 req/day (third-party figures, Oct 2026) | Too small as the main LLM, enough as a fallback. Use Flash-Lite, not Flash. |
| Neon | Postgres (memory) | ✅ Free | 1 GB storage, 100 compute-hours/project | Scales to zero after 5 min and **wakes automatically** (adds ~0.5 s to the first query) |
| Supabase | Postgres (previous pick) | ⚠️ Free but risky | 500 MB DB, 2 projects | **Pauses after 7 days idle and needs a manual restore.** A visitor may open the demo after that. |
| Vercel (Hobby) | Frontend | ✅ Free | About 100 GB transfer/month | Personal / non-commercial use only (a side project qualifies) |
| GitHub Actions | CI | ✅ Free | Unlimited on public repos, 2,000 min/month on private | — |
| Fly.io | Agent hosting fallback (previous pick) | ❌ **Not free** | New orgs get only a tiny trial credit | **Dropped.** |
| Langfuse (optional) | Tracing | ✅ Free | Hobby tier | — |

**What changed because of this check:**
- **Hosting fallback:** Fly.io is dropped. LiveKit Cloud is the only free host. To hide its cold start, the frontend starts the agent when the page loads, not when the user presses "talk". See §9.
- **TTS:** Deepgram Aura is now the default, paid for by the same $200 credit. Cartesia and ElevenLabs are not used: their free tiers are too small, and we decided to stay on free tiers.
- **Database:** Neon replaces Supabase, because Neon wakes up on its own and Supabase needs a manual restore after a week idle.
- **LLM fallback:** Gemini Flash-Lite. Cerebras was dropped because it needs a card. Other no-card options checked on 2026-11-11: SambaNova (~20 req/day), OpenRouter free models (50/day) and GitHub Models (50–150/day, possibly retired) are too small. Mistral's free plan is large but may train on prompts unless you opt out, and our prompts contain users' saved facts.
- **Groq limits (measured):** our key allows 8K tokens/min and 1,000 requests/day per model. The per-minute cap is the one a voice session will hit. Main model: `gpt-oss-120b` with `reasoning_effort="low"`. It made correct tool calls in testing (~0.85 s). `qwen3.8-27b` was ~0.2 s faster with equally correct tool calls, so it's the first thing to try in a latency deep dive. `gpt-oss-20b` spent its whole token budget reasoning on a trivial prompt.
- **Free tiers only (decided 2026-11-12).** Everything runs on our own free tiers, so the demo doesn't depend on someone else's account. Rate-limit risk is handled with short prompts and automatic fallbacks instead.

---

## 0. The big decision: build the pipeline ourselves or use a hosted voice-agent platform

| Approach | Examples | Pros | Cons |
|---|---|---|---|
| ✅ **Open-source framework (we own the pipeline)** | LiveKit Agents, Pipecat | Full control over STT/LLM/TTS, memory and tools. Latency can be measured per stage. The code is ours to explain. Any provider can be swapped in. | More setup and more things to deploy |
| Hosted voice-agent platform | ElevenLabs Agents, Vapi, Retell | Fastest to a demo. Polished voices. Telephony built in. | Black box: weak latency breakdown, limited control over memory and guardrails, little code to show. Close to a "one-shot" demo with little of our own. Paid. |
| Speech-to-speech model | OpenAI Realtime, Gemini Live | Can have very low latency. Simplest pipeline. Handles tone and prosody natively. | Locked to one model. No per-stage visibility. Fewer voice choices. Harder to add guardrails between stages. |

**Why not ElevenLabs?** The ElevenLabs *Agents platform* would do the orchestration for us. That leaves little engineering to show and little control for a deep dive. ElevenLabs *TTS* is still an option *inside* our pipeline (see §3). Gemini Live is a strong fallback if latency becomes the only goal.

---

## 1. Realtime transport and agent framework

| Option | Pros | Cons |
|---|---|---|
| ✅ **LiveKit (Cloud) + LiveKit Agents (Python)** | WebRTC (echo cancellation, jitter handling, works on mobile). Built-in VAD, turn-detection model and barge-in. Large provider plugin ecosystem. Rooms give multiplayer almost for free. SIP for telephony. React components and starter templates. Free cloud tier. | Two pieces to run (media server + worker). Framework concepts to learn. |
| Pipecat (Daily) | Very flexible frame-based pipeline. Python. Many provider integrations. | The transport needs Daily or a self-run WebRTC setup. Weaker multiparty support. Frontend SDKs less mature than LiveKit's. |
| Custom WebSocket (FastAPI + browser audio) | Full control, no vendor | We'd build VAD, barge-in, echo cancellation and audio buffering ourselves. Not realistic in a 2-day build. TCP adds jitter. |

**Pick: LiveKit.** It gives the best latency and reliability out of the box, and it doesn't rule out any deep dive (multiplayer, telephony, latency).

**Version notes (livekit-agents 1.8, checked 2026-11-11):**
- The current starter defaults to **LiveKit Inference** (models billed through LiveKit). We don't use it. We call Deepgram, Groq and Gemini directly with their own keys and free credits.
- **Turn detection:** `inference.TurnDetector(version="v1-mini")` runs on the worker itself, so it's $0. The old `livekit-plugins-turn-detector` package is deprecated. The default `v1` model uses LiveKit's cloud gateway when hosted, which may draw on quota. Try it in a latency deep dive.
- **Latency metrics:** the `metrics_collected` event is deprecated. Per-turn timings (`e2e_latency`, `llm_node_ttft`, `tts_node_ttfb`, ...) now come from `ChatMessage.metrics`.
- **Intel Mac:** recent onnxruntime has no macOS x86_64 wheel, so `pyproject.toml` sets uv `required-environments`, which resolves to a version that installs both on the dev Mac and on Linux.

---

## 2. Speech-to-text (STT)

| Option | Pros | Cons |
|---|---|---|
| ✅ **Deepgram (Nova, streaming)** | True streaming with fast interim results and endpointing. Good accuracy. Free credits. First-class LiveKit plugin. | Paid after the credits run out |
| Groq Whisper | Very fast. Generous free tier. Multilingual (useful for Arabic). | Batch only, not streaming: it transcribes after the user stops talking, which adds latency |
| AssemblyAI Universal-Streaming | Good streaming accuracy. Good turn detection. | Another vendor. Smaller free tier. |
| Browser Web Speech API | Free. Zero setup. | Inconsistent across browsers (poor on Safari/Firefox). No control. Audio goes to Google/Apple. |

**Pick: Deepgram**, with Groq Whisper as a free fallback via config.

---

## 3. Text-to-speech (TTS)

| Option | Pros | Cons |
|---|---|---|
| ✅ **Deepgram Aura** | Same vendor and $200 credit as STT (one key, $0). Fast. LiveKit plugin. | Less expressive than Cartesia/ElevenLabs |
| Cartesia (Sonic) | Among the lowest time-to-first-byte. Streams over WebSockets. Natural voices. | Free tier is only about 20–25 min of audio a month |
| ElevenLabs (Flash/Turbo) | The most expressive voices. Voice cloning (good for a "personal" touch). | Pricier. Small free quota. Its low-latency models give up some quality. |
| OpenAI TTS | Simple API. Decent quality. | Higher latency. Paid. Not on the free-tier shortlist. |

**Pick: Deepgram Aura** to stay at $0. Switching to Cartesia (latency) or ElevenLabs (expressiveness) would be a one-line change in `config.py` if a paid key were ever available.

---

## 4. LLM

| Option | Pros | Cons |
|---|---|---|
| ✅ **Groq (open-weight models such as Llama / GPT-OSS)** | Very low time to first token. Generous free tier. OpenAI-compatible API. Function calling. | Strict free-tier rate limits. Smaller model choice. Tool-calling quality varies by model. |
| Cerebras | Highest tokens/sec | Fewer models. Free tier needs a credit card. |
| Gemini Flash / Flash-Lite | Strong tool use. Multimodal (images, useful for a vision deep dive). Large context. No card. OpenAI-compatible endpoint, so no extra package. | Higher time to first token than Groq. Small free tier (Flash-Lite ~500 req/day). |
| Claude (Haiku 5.5) / GPT | Best tool-use reliability and instruction following (good for guardrails and multistep flows) | Paid. Slower first token. Not on the free-tier shortlist. |

**Pick: Groq** as the main model, with **Gemini Flash-Lite** as the automatic fallback (LiveKit `FallbackAdapter`, called through the OpenAI plugin). Revisit if the deep dive is guardrails or multistep flows, where reliability matters more than speed.

---

## 5. Backend API

| Option | Pros | Cons |
|---|---|---|
| ✅ **Next.js API route (from agent-starter-react)** | Already in the starter. No extra service to deploy. Enough for issuing LiveKit tokens and dispatching the agent. | Not a place for heavy backend logic |
| FastAPI (Python, next to the agent) | One language for agent, memory and tools. Async. Generates OpenAPI docs. | One more service to build and deploy, and nothing needs it yet. The agent reads and writes memory in Neon directly. |
| Node / Express | One language with the frontend | Extra service. The agent is Python anyway. |

**Pick: the Next.js API route.** The task dashboard still doesn't need a backend. The agent already holds the user's DB connection, so it pushes the board to the browser over LiveKit (§14) instead of the browser fetching it from an API.

---

## 6. Memory store

| Option | Pros | Cons |
|---|---|---|
| ✅ **Neon Postgres, simple `facts` table** | Enough for "what's my favorite color?". SQL is easy to explain. Free tier wakes on its own after idle. pgvector can be added later in the same database. | No semantic recall at first. Semantic recall needs an embeddings provider (Groq doesn't offer one). |
| Supabase (Postgres) | Built-in auth. Nice dashboard. | Free project pauses after 7 days idle and needs a manual restore, which could break the demo during review |
| Mem0 / Zep (managed memory) | Extraction and recall out of the box | Black box. Extra vendor. Less to show. |
| Redis | Very fast key-value store | Not suited to long-term durable memory or semantic search without add-ons |
| SQLite | Zero setup | Hard to persist on ephemeral hosts. No managed option. |

**Pick: a Neon Postgres `facts` table.** Add pgvector only if the deep dive needs semantic recall.

---

## 7. Identity

| Option | Pros | Cons |
|---|---|---|
| ✅ **Anonymous ID in localStorage** | No friction for a first-time user. Ships in minutes. | Memory is tied to one browser and lost if site data is cleared |
| Auth.js (magic link / OAuth, data in Neon) | Memory follows the user across devices. Free. No extra vendor. | Adds a login step for new users |
| Clerk / Auth0 | Polished UI. Free tiers. | Extra vendor. Overkill here. |

**Pick: anonymous** (decided 2026-11-12). A new user opens the URL and talks, with no sign-up. Auth.js would be the next step if the board had to follow a user across devices.

---

## 8. Frontend

| Option | Pros | Cons |
|---|---|---|
| ✅ **Minimal Next.js + TypeScript app (Vercel), built with LiveKit React hooks** | About 4 files we write and can explain. The token route lives in the same app. Zero-config Vercel deploys with preview URLs. | We build the UI ourselves (we'd restyle the starter anyway) |
| Use `agent-starter-react` as-is | Polished UI on day 1 | A large app with many files we didn't write, which is hard to explain to a new reader, and it looks like every other LiveKit demo |
| Vite + React SPA | Lightweight. Fast dev server. | Needs a separate place for the token route |
| SvelteKit | Small bundles. Nice developer experience. | Fewer LiveKit and voice UI examples |

**Pick: a minimal Next.js app on Vercel.** Use the React starter only as a reference.

---

## 9. Agent hosting

The worker is a long-running Python process, so serverless platforms are out.

| Option | Pros | Cons |
|---|---|---|
| ✅ **LiveKit Cloud agent hosting (Build, free)** | $0. Runs next to the media server (lowest network hop). One vendor. Deploys with `lk agent create`. | Free tier scales to zero, so a cold start adds 10–20 s. One deployment, 5 concurrent sessions. |
| Free always-on VM (Oracle Cloud Always Free / GCP e2-micro) | $0 and always warm (the worker only makes outbound connections to LiveKit) | We manage the VM ourselves. Signup needs a card. Small RAM (GCP). Not checked in detail. |
| Fly.io | Docker. Can keep an instance warm. | **Not free** for new orgs |
| Railway / Koyeb | Easy setup | Trial only / free tier can't run workers |
| Render | Simple | Free tier spins down when idle |

**Pick: LiveKit Cloud (free)**, deployed to `us-east` next to Groq, Deepgram, Gemini and Neon (`aws-us-east-1`). The region can't be changed after creation. To hide the cold start, the frontend connects and dispatches the agent **when the page loads** and shows a "waking up" state. Lumi greets the user after they click "Start", because browsers block audio before a click. Fallback: a free always-on VM. A paid plan (LiveKit Ship, which stays warm) is a last resort.

---

## 10. Observability

| Option | Pros | Cons |
|---|---|---|
| ✅ **Structured logs + LiveKit Agents metrics** | Per-stage latency (end of speech → STT → LLM first token → TTS first byte) built in. Free. | No UI on top of it |
| Langfuse | LLM traces, prompt and tool-call inspection. Free cloud tier. | Another vendor. Mostly covers LLM calls only. |
| OpenTelemetry + Grafana | Industry standard. Rich dashboards. | Setup cost too high for a 2-day build |

**Pick: logs + built-in metrics.** Add Langfuse if the deep dive is guardrails or latency.

---

## 11. CI/CD

| Option | Pros | Cons |
|---|---|---|
| ✅ **Vercel Git integration (web) + GH Actions lint & tests + `lk agent deploy` (agent)** | Free. Preview URL per PR. Almost no setup. | Agent deploy is a manual CLI step |
| GitHub Actions deploying everything | Fully automated | Setup time we don't need for a 2-day build |

**Pick: Vercel Git deploys (web) + GitHub Actions for lint, tests and agent deploys.** A `deploy-agent` job runs `lk agent deploy` on pushes to `main` that change `agent/`, after the agent tests pass. We added it in M0 so a pushed agent fix can't sit undeployed. It authenticates with the project API key and secret (GitHub secrets) and uses a pinned `lk` release.

---

## 12. Testing & evals

| Option | Pros | Cons |
|---|---|---|
| ✅ **pytest + LiveKit Agents' built-in testing helpers** | Same language and runner for unit tests and agent evals. Runs text-only conversations and asserts on tool calls and LLM-judged replies. No extra vendor. | Evals use LLM quota. Needs care to avoid flaky tests. |
| Promptfoo / DeepEval | Rich eval reports and dashboards | Another tool and config format to explain. Doesn't drive the actual agent session. |
| Manual testing only | Zero setup | Regressions slip in while iterating across milestones |
| End-to-end voice tests (simulated audio, e.g. Playwright + audio injection) | Tests the real voice path | Slow, brittle and hard to build in 2 days |

**Pick: pytest for everything** (unit tests on every push, agent evals on PR), plus a 5-minute manual voice smoke checklist per milestone. To keep evals stable, assert on tool calls rather than exact wording, and use temperature 0.

---

## 13. External API

| Option | Pros | Cons |
|---|---|---|
| ✅ **Tavily web search** | Built for LLM agents: one POST returns a short written answer plus source URLs, so the model reads a few sentences, not web pages. Free "Researcher" plan: 1,000 credits a month, no credit card; a basic search costs 1 credit. | Needs a key (our own, kept in LiveKit Cloud secrets; visitors never see it). Adds about 1–3 s to a turn. Web text is untrusted. |
| Open-Meteo weather (used until 2026-11-12) | Free, no key, no account | A side question that never changes the board, and a demo cliché |
| Aladhan (Hijri dates, prayer times) | Free, no key, fits users in the Gulf | The user preferred not to |
| Nager.Date (public holidays) | Free, no key | No Saudi data: `PublicHolidays/2026/SA` returns 204 (checked 2026-11-12) |
| ntfy.sh (phone reminders) | Free, no key, an action rather than a lookup | Each user must install the app and subscribe to a topic; tasks have no times; public-server delay cap |
| Google Calendar | Very on-theme for a task board | OAuth consent screen for every user, verification, and token storage: a lot of code to explain for a small project |

**Pick: Tavily.** It lets Lumi do the first step of a task, not just store it: "find out what I need to renew my passport" saves a short answer and two source links into that task's notes, and Lumi says one line. Called with `aiohttp`, which `livekit-agents` already installs: `POST https://api.tavily.com/search` with `Authorization: Bearer <TAVILY_API_KEY>`, `search_depth: basic`, `include_answer: basic`. We don't use Tavily's SDK, CLI or MCP server: one HTTP call is easier to explain. A 5 s timeout. Every failure (401 bad key, 429 rate limit, 432 credits used up, timeout, no answer) is a tool error, so Lumi says it couldn't look it up and never invents an answer.

## 14. Agent → browser board sync

| Option | Pros | Cons |
|---|---|---|
| ✅ **LiveKit text stream (`send_text`, topic `lumi.board`), the whole board as JSON** | Reuses the WebRTC connection we already have. No new service, no DB access from Vercel, one code path for SQL. No size cap. React side is one `registerTextStreamHandler`. | The board only updates while a session is connected (fine: changes only happen by voice, inside a session) |
| Next.js `/api/tasks` route reading Neon | Board loads without the agent | The same SQL twice in two languages, a new DB driver dependency, and the browser polling or refreshing after each change |
| LiveKit RPC agent → browser | Request/response, with acknowledgement | 15 KB payload cap. We don't need an answer back. |
| Participant attributes | Automatically synced state | Small size limits. Meant for small key/value data, not lists. |

**Pick: text stream, whole board each time.** The browser replaces its state with what arrives, so it can never drift from the database. A tiny `change` field tells it which card and which fields to animate. The browser also caches the last board in `localStorage` to cover the agent's cold start.
