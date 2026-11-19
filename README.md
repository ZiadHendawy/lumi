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
| `docs/` | Account setup, the deep dives, a guided code tour, the plan and decision log, the stack comparison, and the smoke checklist |

New to the code? Start with [docs/CODE_MAP.md](docs/CODE_MAP.md).

## Run it yourself

### 0. Install the tools

- [uv](https://docs.astral.sh/uv/getting-started/installation/) for the Python agent (it installs Python 3.12 for you)
- [Node.js 24](https://nodejs.org/) for the web app
- The [LiveKit CLI](https://github.com/livekit/livekit-cli) (`brew install livekit-cli` on macOS). You only need it for deploying.

### 1. Get your own keys

Every collaborator uses their own keys, and every service here has a free tier. **New to these services?** [docs/SETUP.md](docs/SETUP.md) walks through signing up for each one, where to find each key, and which `.env.local` line it goes on.

| Variable | Required? | Where to get it | Goes in |
|---|---|---|---|
| `LIVEKIT_URL`, `LIVEKIT_API_KEY`, `LIVEKIT_API_SECRET` | **Yes** | [LiveKit Cloud](https://cloud.livekit.io): create a project, then **Settings → API keys** | `agent/` and `web/` |
| `DEEPGRAM_API_KEY` | **Yes** | [Deepgram console](https://console.deepgram.com) (speech to text and the voice) | `agent/` |
| `GROQ_API_KEY` | **Yes** | [Groq console](https://console.groq.com/keys) (the main LLMs) | `agent/` |
| `GEMINI_API_KEY` | **Yes** | [Google AI Studio](https://aistudio.google.com/apikey) (the fallback LLM) | `agent/` |
| `DATABASE_URL` | **Yes** | [Neon](https://console.neon.tech): create a project and copy its connection string | `agent/` |
| `TAVILY_API_KEY` | For web search | [Tavily](https://app.tavily.com). Without it, the board works, but "find out..." requests fail | `agent/` |
| `TEST_DATABASE_URL` | No | A second Neon branch (Neon console → **Branches** → new branch, e.g. `test`), so tests never touch your real board. Without it, the database tests are skipped | `agent/` |
| `LIVEKIT_AGENT_ID` | Only to deploy | Printed by `lk agent create` (see [Deploy your own](#deploy-your-own)) | `agent/` |
| `STATS_*`, `DEEPGRAM_USAGE_KEY` | No | Only for the password-protected `/stats` page. See the comments in `web/.env.example` | `web/` |

### 2. Fill in your env files

Each app has a `.env.example` listing every variable it reads, with empty values and a comment saying where each one comes from. Copy both from the repo root:

```bash
cp agent/.env.example agent/.env.local
cp web/.env.example web/.env.local
```

Then paste your keys after the `=` signs:

- **`agent/.env.local`:** every **Yes** row above, plus any optional ones you have.
- **`web/.env.local`:** only the three `LIVEKIT_*` values, the same as the agent's.
- Leave optional lines empty if you don't use them. Don't type placeholder text like `your-key-here`: the code treats any text as a real value, while an empty value means "not set".
- Both `.env.local` files are ignored by git, so your keys stay on your machine. Never commit them, and never put a real key in a `.env.example`.

The agent creates its database tables the first time it connects.

### 3. Start the agent and the web app

Each one keeps running, so use two terminals, both starting from the repo root.

Terminal 1, the agent:
```bash
cd agent
uv sync
uv run -m livekit.agents download-files   # VAD and turn-detector weights, once
uv run agent.py dev                       # joins the LiveKit project in .env.local
```

Terminal 2, the web app:
```bash
cd web
npm install
npm run dev                               # open http://localhost:3000 and tap the lantern
```

### Deploy your own

The agent's deploy target comes from `agent/.env.local`: `LIVEKIT_URL` picks the project and `LIVEKIT_AGENT_ID` picks the agent. There's no committed `livekit.toml`. Each command below loads `.env.local` with `uv run --env-file`, so the `lk` CLI acts on the project in your file, not on whichever project it was last set to. Run them from `agent/`.

> **Check your shell first:** a variable already set in your shell wins over `.env.local`. If `echo $LIVEKIT_URL` prints anything (say, from another project in your `.zshrc`), run `unset LIVEKIT_URL LIVEKIT_API_KEY LIVEKIT_API_SECRET` before these commands. Otherwise they act on that other project.

1. **Create the agent (once):**
   ```bash
   uv run --env-file .env.local -- lk agent create --region us-east .
   ```
   Copy the `CA_...` ID it prints into `LIVEKIT_AGENT_ID` in `.env.local`. It also writes a `livekit.toml`, which git ignores.
2. **Give the deployed agent its keys (once, and again whenever a key changes):**
   ```bash
   uv run --env-file .env.local -- sh -c 'lk agent update-secrets --id "$LIVEKIT_AGENT_ID" \
     --secrets "DEEPGRAM_API_KEY=$DEEPGRAM_API_KEY" --secrets "GROQ_API_KEY=$GROQ_API_KEY" \
     --secrets "GEMINI_API_KEY=$GEMINI_API_KEY" --secrets "TAVILY_API_KEY=$TAVILY_API_KEY" \
     --secrets "DATABASE_URL=$DATABASE_URL"'
   ```
   The values come from `.env.local`, so they never appear in your shell history. LiveKit sets the `LIVEKIT_*` values itself.
3. **Deploy (after every change to `agent/`):**
   ```bash
   uv run --env-file .env.local -- sh -c 'lk agent deploy --id "$LIVEKIT_AGENT_ID"'
   ```

CI can do step 3 on every push to `main` once the repository has `LIVEKIT_URL`, `LIVEKIT_API_KEY`, `LIVEKIT_API_SECRET` and `LIVEKIT_AGENT_ID` secrets. Without them, the deploy step is skipped.

**Web:** import the repo into Vercel with `web/` as the root directory, and add the three `LIVEKIT_*` variables under **Settings → Environment Variables**. For `/stats`, also add `STATS_PASSWORD`, `STATS_DATABASE_URL` (a read-only role) and `TAVILY_API_KEY`.

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
