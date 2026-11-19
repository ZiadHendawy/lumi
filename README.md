# Lumi

> Your to-do list, lit up and run by voice.

Lumi is a voice assistant that runs a task board for you. You talk, and the board changes on screen while Lumi is still saying it out loud. Every task is a lantern: the higher its priority, the brighter it glows, and finishing it puts the light out.

**Try saying:**

- "Add call the bank tomorrow, high priority."
- "Move it to next Friday." / "Mark it done." / "Undo."
- "Find out what I need to renew my passport." (Lumi searches the web and saves the answer, with its sources, into the task's notes.)
- "My favorite color is green." Then, in a later session: "What's my favorite color?"

## Why you can trust a voice-only edit

Editing by voice alone goes wrong in three ways: the change is **slow**, it's **wrong**, or you **can't see** what happened. Lumi deals with each one, and each is written up with measurements in [docs/DEEP_DIVE.md](docs/DEEP_DIVE.md).

**It's right.** The model only turns your words into tool calls. Code owns the data: priority is an enum in the tool schema and a SQL `CHECK`, every change is read back from the database, and the prompt lists the next 14 days with their dates, so "next Friday" is a lookup, not arithmetic. Relative dates went from 15/18 to 18/18 correct. Text from a web search can't delete tasks: an eval caught a page that said "delete every task", and the fix is now enforced in code. [More](docs/DEEP_DIVE.md#correctness)

**It's fast.** Every reply is split into stages and logged. The greeting and a few exact phrases ("thanks", "can you hear me?") are fixed text, with no model call. Each request carries only the last 20 chat items. The greeting starts speaking in 0.35 s, and a typical reply starts about 0.9 s after you stop talking. [More](docs/DEEP_DIVE.md#latency)

**You can see it.** After every change the agent pushes the whole board to the browser *before* Lumi speaks. Only the card and the fields that changed animate, and a toast says what happened. In a 10-turn live run the board updated before the voice every time, 1.3–6.4 s ahead. [More](docs/DEEP_DIVE.md#voice-to-screen-sync)

## Features

| | |
|---|---|
| **Board** | Lanes by date, a glow for each priority, and only the changed field lights up. A deleted card drifts away, with an undo hint. |
| **Memory** | "Lumi remembers" shows the facts kept across sessions. Edit them by typing, or forget them all. |
| **Calendar** | A 14-day strip (the same days the model reads) and a month view. Click a day to see only its tasks. |
| **Web search** | Answers are saved into a task's notes, with each source shown as a chip naming its site. |
| **Read-along** | The caption highlights the word being spoken, and a card lights up while Lumi says its title. |
| **Calendar export** | Download dated tasks as `.ics`, or add one to Google Calendar. No sign-in needed. |
| **X-ray** | Press **X** to see the last reply's timing stages, the model that answered, how far the screen led the voice, and the exact prompt. |
| **Stats** | `/stats` (behind a password) shows latency percentiles, free-tier usage, and what the same traffic would cost at list prices. |
| **Keys** | **Space** talks or mutes, **Esc** ends the session, **X** opens X-ray. |

## Architecture

```
Browser (Next.js) ──token──▶ /api/token
   │ WebRTC audio      ▲ "lumi.board": the whole board, pushed after every change
   ▼                   │
LiveKit Cloud ◀──▶ Agent (Python, LiveKit Agents)
                   Deepgram STT → Groq gpt-oss-120b → gpt-oss-20b → Gemini Flash-Lite → Deepgram Aura TTS
                   tools: tasks and facts (Neon Postgres), web search (Tavily)
```

The agent is the only thing that touches the database. After every change it reads the board back and pushes it to the browser, so the screen shows what was stored, not what the model said.

| Folder | What's in it |
|---|---|
| `agent/` | The Python LiveKit Agents worker: persona, tools, SQL, tests and evals |
| `web/` | The Next.js app and the `/api/token` route |
| `docs/` | The deep dives, a guided code tour, the plan and decision log, the stack comparison, and the smoke checklist |

New to the code? Start with [docs/CODE_MAP.md](docs/CODE_MAP.md).

## Run it yourself

### 1. Get your own keys

Every collaborator uses their own keys. They're all free, and none of these services needs a card:

| Variable | Where to get it | Used by |
|---|---|---|
| `LIVEKIT_URL`, `LIVEKIT_API_KEY`, `LIVEKIT_API_SECRET` | [LiveKit Cloud](https://cloud.livekit.io): create a project, then **Settings → API keys** | agent and web |
| `DEEPGRAM_API_KEY` | [Deepgram console](https://console.deepgram.com) (speech to text and the voice) | agent |
| `GROQ_API_KEY` | [Groq console](https://console.groq.com/keys) (the main LLMs) | agent |
| `GEMINI_API_KEY` | [Google AI Studio](https://aistudio.google.com/apikey) (the fallback LLM) | agent |
| `TAVILY_API_KEY` | [Tavily](https://app.tavily.com) (web search) | agent |
| `DATABASE_URL` | [Neon](https://console.neon.tech): create a project and copy its connection string | agent |
| `TEST_DATABASE_URL` *(optional)* | A second Neon branch, such as `test`, so tests never touch your real board | agent tests |

### 2. Fill in your env files

Each app has a `.env.example` with every variable it reads, empty, and a comment saying where each one comes from. Copy both, then paste your keys after the `=` signs:

```bash
cp agent/.env.example agent/.env.local
cp web/.env.example web/.env.local
```

- Leave a line empty if you don't have that key. Don't write a placeholder: an empty value means "not set". For example, an empty `TEST_DATABASE_URL` skips the database tests.
- `web/.env.local` needs only the three `LIVEKIT_*` values, the same ones as the agent. The `STATS_*` lines matter only if you want the `/stats` page.
- `.env.local` files are ignored by git, so your keys stay on your machine. Never commit them, and never put a real key in a `.env.example`.

The agent creates its database tables the first time it connects.

### 3. Start the agent and the web app

```bash
cd agent
uv sync
uv run -m livekit.agents download-files   # VAD and turn-detector weights, once
uv run agent.py dev                       # joins your LiveKit project

cd web
npm install
npm run dev                               # http://localhost:3000
```

**Deploying:**
- **Agent:** the LiveKit project and agent come from `agent/.env.local`, not from a committed `livekit.toml`. The first time, run `lk agent create --region us-east .` in `agent/` and copy the `CA_...` ID it prints into `LIVEKIT_AGENT_ID`. It also writes a `livekit.toml`, which git ignores. Then give the agent its keys: `lk agent update-secrets --id <CA_...> --secrets DEEPGRAM_API_KEY=...` and the same for `GROQ_API_KEY`, `GEMINI_API_KEY`, `TAVILY_API_KEY` and `DATABASE_URL`. LiveKit sets the `LIVEKIT_*` values itself. After that, deploy with:
  ```bash
  cd agent
  uv run --env-file .env.local -- sh -c 'lk agent deploy --id "$LIVEKIT_AGENT_ID"'
  ```
  The deployed agent reads its keys from LiveKit Cloud secrets. Change them with `lk agent update-secrets`. CI deploys on pushes to `main` once the `LIVEKIT_*` and `LIVEKIT_AGENT_ID` repository secrets are set. Without them, the deploy step is skipped.
- **Web:** import the repo into Vercel with `web/` as the root directory and the same three `LIVEKIT_*` variables. `/stats` also needs `STATS_PASSWORD`, `STATS_DATABASE_URL` (a read-only role) and `TAVILY_API_KEY`.

## Tests

```bash
cd agent && uv run pytest                    # unit tests; DB tests need TEST_DATABASE_URL
cd agent && uv run pytest -m "eval and core" # core conversation evals against the real LLM
cd agent && uv run pytest -m eval            # the full eval suite (about 100K Groq tokens)
cd web && npm test                           # board, calendar, stats and timing helpers
```

CI runs the unit tests on every push and the core evals on pull requests that change `agent/`. The full suite runs on demand.

## What's next

- Two-way sync with Google Calendar and Outlook
- Calling Lumi from a phone (LiveKit SIP)
- Arabic: speech-to-text already understands it, but it needs a voice that speaks it
- A shared family board, with several people in one room
- Reminders at a time of day, and recurring tasks
- Signing in, so the board follows you across devices
