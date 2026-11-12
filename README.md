# Lumi

**A task board you run by voice.** Tap the lantern and talk: "add call the bank tomorrow, high priority", "move it to next Friday", "mark it done", "undo". The board on screen changes while Lumi is still confirming out loud. It remembers your board and a few facts about you across sessions ("what's my favorite color?"), and it can look things up on the web and save the answer, with sources, into a task's notes.

The look is "the lantern board": a dark board where a card's priority is how brightly it glows, done tasks are put out, and the talk button is a lantern that reacts to your voice and Lumi's.

## On the page

- **The board** lights the card that changed, and only the field that changed, before Lumi finishes saying it. A delete drifts away with an undo hint.
- **Lumi remembers** shows the facts Lumi keeps across sessions, and the one just remembered lights up. **Edit** opens the memory panel: add, change or forget a fact by typing (it goes through Lumi, like a spoken one), forget everything, and read what is kept, where, and a link to the exact prompt.
- **The calendar** ("Next 14 days") shows the same days the model reads to turn "next Friday" into a date, one glowing dot per task. "Month" opens the whole month, and clicking any day shows only that day's tasks.
- **Source chips:** links from a web search show as small chips naming the site.
- **Read-along:** the caption highlights the word being spoken, and a card lights up while Lumi says its title.
- **Tool activity:** the lantern says "Searching the web…" during a search, and the card being searched breathes.
- **X-ray** (press X, or the button top right) is for anyone curious how it works: the last reply's timing stages, the model that answered, how far the screen led the voice, this session's medians, and the prompt exactly as the model reads it. It only opens on request.
- **End of a session:** one line in your words: "3 tasks added · 2 done · 1 new thing remembered". The engineering numbers for the session (median time to voice, screen lead, models) are in X-ray.
- **Connections:** download your dated tasks as `.ics` or add one to Google Calendar, with no sign-in. Calendar sync and phone calls are marked "Coming soon".
- **End of the day:** when everything due today is done, "All of today's lanterns are out."
- **Keys:** Space talks or mutes, Esc ends, X opens X-ray. Before you speak, the dock suggests phrases that fit your board.

## How it works

```
Browser (Next.js, Vercel) ──token──▶ /api/token
   │ WebRTC audio        ▲ "lumi.board" text stream: the whole board after every change
   ▼                     │
LiveKit Cloud ◀──▶ Agent (Python, LiveKit Agents, LiveKit Cloud)
                     Deepgram STT → Groq gpt-oss-120b → gpt-oss-20b → Gemini Flash-Lite → Deepgram Aura TTS
                     tools: tasks and facts (Neon Postgres), web search (Tavily)
```

The model only maps words to tool calls. Code owns the data: the agent is the only thing that touches the database, and after every change it reads the board back and pushes it to the browser. So the screen shows what was stored, not what the model said.

```
agent/   Python LiveKit Agents worker (runs on LiveKit Cloud)
web/     Next.js app + /api/token route (runs on Vercel)
docs/    deep dives, code map, smoke checklist
```

## Read next

| Doc | What's in it |
|---|---|
| [docs/DEEP_DIVE.md](docs/DEEP_DIVE.md) | One theme, *voice control you can trust*, from three angles: [latency](docs/DEEP_DIVE.md#latency) (slow), [correctness](docs/DEEP_DIVE.md#correctness) (wrong), [voice-to-screen sync](docs/DEEP_DIVE.md#voice-to-screen-sync) (invisible). Measured results, what didn't work, how to reproduce. |
| [docs/CODE_MAP.md](docs/CODE_MAP.md) | One paragraph per file, the agent-browser contract, and the life of one voice turn |
| [PROJECT_PLAN.md](PROJECT_PLAN.md) | Milestones, the decision log (why each choice), risks |
| [TECH_STACK.md](TECH_STACK.md) | Options compared for each layer, free-tier limits as measured |
| [docs/SMOKE_TEST.md](docs/SMOKE_TEST.md) | The 5-minute manual voice check, and its log |

## Run locally

```bash
# agent: fill agent/.env.local from agent/.env.example
cd agent
uv sync
uv run -m livekit.agents download-files   # VAD + turn-detector weights, once
uv run agent.py dev                       # connects to your LiveKit Cloud project

# web: create web/.env.local with LIVEKIT_URL, LIVEKIT_API_KEY and LIVEKIT_API_SECRET
cd web
npm install
npm run dev                               # http://localhost:3000
```

## Tests

| Command | What | Cost |
|---|---|---|
| `cd agent && uv run pytest` | Unit tests, no LLM. The DB tests need `TEST_DATABASE_URL` (a Neon `test` branch) and are skipped without it. | Free. Runs on every push. |
| `cd agent && uv run pytest -m "eval and core"` | The core conversation evals against the real LLM (17). Needs `GROQ_API_KEY`, `GEMINI_API_KEY`, `TEST_DATABASE_URL`. | Groq quota. Runs on PRs that change `agent/`. |
| `cd agent && uv run pytest -m eval` | The full eval suite (35) | ~100K Groq tokens, half the daily cap. On demand only: Actions → CI → Run workflow. |
| `cd web && npm test` | Board helpers: payload parsing, date lanes, receipts, captions. Stats helpers: the password check, limit levels, percentiles. Calendar export: the Google link and the `.ics` file | Free. Runs on every push. |

## Deploy

- **Agent:** deploys automatically. CI runs `lk agent deploy` on every push to `main` that changes `agent/`, once the agent tests pass. Manual fallback: `cd agent && lk agent deploy`. Secrets live in LiveKit Cloud, not in the repo: the provider keys, `DATABASE_URL` and **`TAVILY_API_KEY`** (web search, free tier at app.tavily.com, no card). Add a missing one with `lk agent update-secrets --secrets KEY=VALUE`, and check with `lk agent secrets`.
- **Web:** import the repo in Vercel with root directory `web/`, then set `LIVEKIT_URL`, `LIVEKIT_API_KEY` and `LIVEKIT_API_SECRET`. Every push deploys.
- **Stats page (`/stats`):** free-plan limits and per-stage latency, behind a password. Vercel also needs `STATS_PASSWORD`, `STATS_DATABASE_URL` (the read-only `stats_reader` role on the production database, which can only `SELECT` the two metrics tables), `TAVILY_API_KEY`, and optionally `DEEPGRAM_USAGE_KEY` (a Deepgram key with `usage:read` and `billing:read`) for the credit balance.

## Roadmap

Works today: dated tasks go to a calendar with no sign-in. Each dated card has an "Add to Google Calendar" link, and **Connections** downloads the board as an `.ics` file for Apple Calendar, Outlook or Google Calendar.

Planned (the first two are also in the app's Connections panel, as "Coming soon"):

- **Google Calendar & Outlook two-way sync:** OAuth sign-in, tokens stored per user, and today's events read into Lumi's prompt.
- **Call Lumi from a phone:** LiveKit SIP routes a phone number to the same agent.
- **Arabic:** Deepgram Nova-3 already understands it; the voice (Aura) has no Arabic yet, so it needs another TTS.
- **A shared family board:** several people in one LiveKit room, each change pushed to everyone.
- **Reminders at a time:** tasks have dates, not times, yet; then a push notification.
- **Sign in on any device:** the board is tied to this browser today (an anonymous id).
- **Recurring tasks:** "every Sunday" as a repeat rule on the task.

## How the work is split

One PR per related unit of change (for example "tasks SQL", "task tools and board push", "lantern board UI"), never one PR per milestone. Each PR carries its own tests, evals and CI changes, so its CI run shows the unit works on its own. PRs are stacked and merged in order:

- **Base:** #1 plan → #10 LLM fallback → #6 CI
- **Agent:** #7 → #9 → #11 → #12 → #13 → #14 → #16 → #17 → #18 → #19
- **Web:** #2 → #3 → #4 → #5 → #15
- **Polish, after M3** (one PR each, merged as they were done): #21 full notes, #22–#23 /stats, #24 memory shelf, #25 lantern icon, #26 cost model, #27 tool activity, #28 X-ray and receipt, #29 calendars and Connections, #30 read-along, #31 keys and suggestions, #32 fixed replies, #33 night strip and source chips, then the end-of-day line.

Everything runs on free tiers.
