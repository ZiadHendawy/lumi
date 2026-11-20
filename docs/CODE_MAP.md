# Code map

A guided tour of the code for someone opening it for the first time. Read the first three sections for the shape of the system, then use the file sections as a reference. Names in `code` are real function, constant and file names, so you can search for them.

1. [The big picture](#the-big-picture): what runs where
2. [The one idea](#the-one-idea): the model talks, code owns the data
3. [Life of one voice turn](#life-of-one-voice-turn): one sentence, end to end
4. [The agent, file by file](#the-agent-file-by-file)
5. [The web app, file by file](#the-web-app-file-by-file)
6. [The agent and browser contract](#the-agent-and-browser-contract): every message between them
7. [Three paths worth knowing](#three-paths-worth-knowing): how a change reaches the screen, typed memory edits, why web text can't delete
8. [Tests](#tests), [CI/CD](#cicd), and [where to look when you want to change something](#where-to-look)

## The big picture

Two programs, each on its own free host, talking through a LiveKit room.

```mermaid
flowchart LR
  subgraph browser["Browser: web/ on Vercel"]
    UI["Next.js page<br/>VoiceSession + Board"]
    Token["/api/token<br/>the only backend route"]
  end
  subgraph lk["LiveKit Cloud"]
    Room["Room<br/>audio + data streams"]
    subgraph agent["Agent: agent/"]
      Voice["Deepgram STT → LLM chain → Deepgram Aura TTS"]
      Tools["tools.py<br/>7 tools"]
    end
  end
  LLM["Groq gpt-oss-120b<br/>→ gpt-oss-20b<br/>→ Gemini Flash-Lite"]
  DB[("Neon Postgres<br/>tasks · facts · metrics")]
  Tavily["Tavily<br/>web search"]
  Stats["/stats page"]

  UI -- "anonymous id" --> Token
  Token -- "signed token,<br/>agent dispatch inside" --> UI
  UI <-- "mic audio, Lumi's voice,<br/>board pushes, RPCs" --> Room
  Room <--> agent
  Voice --> LLM
  Tools --> DB
  Tools --> Tavily
  Stats -. "read-only role" .-> DB
```

- **The browser never touches the database.** It gets a token, joins a room, and from then on only talks to the agent.
- **The agent is the only writer.** It runs on LiveKit Cloud, one job per room, and reads and writes Postgres with plain SQL.
- **Identity is an anonymous UUID** kept in `localStorage` (`lib/userId.ts`). The token makes it the participant identity, and the agent uses it as `user_id` in every query. There is no login.

## The one idea

**The model only turns words into tool calls. Code owns the data.**

```mermaid
flowchart LR
  Words["What the user said"] --> Model["LLM<br/>picks a tool + arguments"]
  Model --> Tool["Tool in tools.py<br/>checks the arguments,<br/>writes with SQL"]
  Tool --> DB[("Postgres")]
  DB -- "read back once" --> Screen["Whole board<br/>pushed to the browser"]
  DB -- "same rows" --> Prompt["Prompt re-rendered<br/>for the next request"]
  DB -- "the stored row" --> Result["Tool result text"]
  Result --> Model
  Model --> Spoken["Spoken confirmation"]
```

What follows from it:

- **The screen shows what was stored, not what the model said.** After every change the agent reads the board back and pushes it, *before* Lumi speaks.
- **Wrong values can't get in.** Priority is an enum in the tool schema and a SQL `CHECK`. Dates are parsed in code (`parse_date`). Facts have length and count caps.
- **The model doesn't do date arithmetic.** The prompt lists the next 14 days with their dates, so "next Friday" is a lookup.
- **The confirmation is built from the stored row** (`describe`), so Lumi can't claim a change it didn't make.

## Life of one voice turn

Example: on Friday 2026-11-27 the user says "Add a task to call the bank tomorrow, high priority."

```mermaid
sequenceDiagram
  autonumber
  participant B as Browser<br/>VoiceSession
  participant A as Agent<br/>agent.py
  participant M as LLM chain
  participant T as tools.py
  participant D as Postgres

  Note over B,D: Page load, before the user talks
  B->>B: show the cached board ("Last seen")
  B->>A: join the room, mic off
  A->>D: connect, read board and facts
  A-->>B: lumi.board with change null
  B->>A: lantern tap, lumi.start RPC with timezone
  A-->>B: greeting: fixed text, no model, about 0.35 s

  Note over B,D: One voice turn
  B->>A: audio
  A->>A: speech to text, end of turn, llm_node
  A->>M: prompt, last 20 chat items, 7 tool schemas
  M-->>A: create_task(title, priority high, date 2026-11-28)
  A-->>B: lumi.activity started
  A->>T: create_task
  T->>D: INSERT ... RETURNING
  T->>D: read board and facts once
  T-->>B: lumi.board with change created
  Note over B: the card lights up now,<br/>before Lumi speaks
  T->>T: refresh_instructions, also sent on lumi.prompt
  T-->>A: tool result built from the stored row
  A->>M: second request with the tool result
  M-->>A: "Done, Call the bank is on for tomorrow..."
  A-->>B: Aura voice and captions
  A-->>B: lumi.turn with the stage timings
```

| Step | What happens | Where |
|---|---|---|
| 1–2 | The page shows last visit's board at once, then connects with the mic off, so the agent's cold start (10–20 s when idle) overlaps the user reading. | `VoiceSession.tsx` `useSession`, `loadCachedBoard` |
| 3–4 | The agent connects to Neon while it joins the room, reads the board once, pushes it, and renders the prompt from the same rows. | `agent.py` `entrypoint` |
| 5–6 | The tap unlocks audio, turns the mic on and sends the timezone. The greeting is coded text, so it works even with every model capped. | `startTalking`, `on_start`, `prompt.greeting` |
| 7–8 | Silero VAD, Deepgram Nova-3 and the `v1-mini` turn detector decide the user has finished. Preemptive generation starts the LLM early. | LiveKit `AgentSession`, built in `entrypoint` |
| 8 | Before every LLM request: is it an exact fixed phrase ("thanks")? Then answer with no model. Otherwise trim the chat to 20 items and sign tool calls for Gemini. | `Lumi.llm_node` |
| 9–10 | The fallback chain tries each model in turn when one errors or rate-limits. The model reads the calendar in the prompt and picks the date. | `config.build_llm` |
| 11 | The lantern says "Adding it to the board…" while the tool runs. | `show_tool_activity` |
| 12–14 | The tool validates the arguments, writes the row, and reads the board back once: three queries per change. | `tools.create_task`, `publish` |
| 15 | The board reaches the browser, which parses, caches and animates the change and shows a receipt toast, before Lumi speaks. | `Board.tsx` |
| 16–17 | The prompt is re-rendered from the same rows, and the tool's result is built from the stored row. | `refresh_instructions`, `describe` |
| 18–20 | The model turns the tool result into one short sentence, Aura speaks it, and the caption highlights the word being spoken. | `Captions` |
| 21 | The turn's timings go to the browser (X-ray), the logs and the `turn_metrics` table (`/stats`). | `log_turn_latency` |

## The agent, file by file

`agent/` is a Python [LiveKit Agents](https://docs.livekit.io/agents/) worker. Five modules, each with one job:

```mermaid
flowchart TD
  agent["agent.py<br/>entry point, the Lumi agent,<br/>RPCs, logs and metrics"]
  tools["tools.py<br/>the 7 tools, guards,<br/>publish to the browser"]
  prompt["prompt.py<br/>what the model reads"]
  memory["memory.py<br/>all SQL"]
  config["config.py<br/>providers and limits"]
  schema[("schema.sql")]
  agent --> tools
  agent --> prompt
  agent --> memory
  agent --> config
  tools --> prompt
  tools --> memory
  tools --> config
  prompt --> config
  memory --> schema
```

| File | Lines | Its job |
|---|---|---|
| `agent.py` | 345 | Starts a session per room, the `Lumi` agent, the two RPCs, logging and metrics |
| `tools.py` | 537 | The tools the model can call, their guards, and pushing the board to the browser |
| `memory.py` | 217 | Every database query, plain SQL with `psycopg`, no LiveKit imports |
| `prompt.py` | 128 | The persona and rules, the rendered prompt, the greeting, fixed replies |
| `config.py` | 108 | Every provider, model and tunable number in one place |
| `schema.sql` | 64 | Four tables, applied at the start of every session |
| `bench_latency.py` | 319 | The offline latency benchmark from the deep dive |

### `agent.py`

**`Lumi`**, the agent. It lists the seven tools (`create_task`, `update_task`, `delete_task`, `restore_task`, `remember_fact`, `forget_fact`, `look_up`) and overrides `llm_node`, which runs before every LLM request. In order, `llm_node`:

1. sets `searched_this_turn` from `tools.search_ran_this_turn`, so the deleting tools know whether web text is in play ([why](#web-text-cant-delete));
2. if the user's message is exactly one of `prompt.FIXED_REPLIES`, says it with `say_fixed` and calls no model (`last_reply_fixed` makes the metrics say "fixed reply");
3. otherwise sends a copy of the chat cut to the last `MAX_HISTORY_ITEMS` (20), with tool calls signed for Gemini (`config.sign_tool_calls_for_gemini`).

**`prewarm`** loads the Silero VAD once per worker process.

**`entrypoint`** runs once per room:

1. starts the Neon connect (`memory.connect`) while the room connect runs, so they overlap;
2. builds the `AgentSession` from `config.py`, with the local `v1-mini` turn detector;
3. waits for the browser and builds the per-session `tools.SessionState` with its identity as the user id;
4. reads the board and facts once, pushes them (`change: None`), and renders the prompt from the same rows;
5. starts the session, then registers the RPCs.

**The two RPCs** (the browser calls these):

- `on_start` (`lumi.start`): reads the timezone (`parse_timezone`, UTC if bad), re-renders the prompt for the user's "today", and says `prompt.greeting(...)` with no model call.
- `on_memory_edit` (`lumi.memory`): a typed edit from the memory panel. It refuses any caller but the session's user, runs `tools.edit_memory`, and turns a `MemoryEditRefused` into an `RpcError` with code `MEMORY_EDIT_REFUSED` (2000, since LiveKit reserves 1001–1999), so the panel can show why. It logs the payload's size, never the fact.

**Session event handlers:**

| Event | Handler | What it does |
|---|---|---|
| `conversation_item_added` | `log_turn_latency` | Logs `turn latency` and `user turn latency`, saves the turn to `turn_metrics`, sends it on `lumi.turn` |
| `function_tools_executed` | `log_tool_time` | Logs `tool call` with its time |
| `tool_execution_updated` | `show_tool_activity` | Sends `lumi.activity` when a tool starts and ends |
| `agent_state_changed` | `log_screen_lead` | Logs `board push to speech`: how far the screen led the voice |
| `session_usage_updated` | `record_usage` | Saves only what changed (`usage_delta`) to `provider_usage` |
| `user_state_changed` | `end_when_idle` | Ends after 3 min of silence (a `call_later` timer also caps a session at 10 min) |
| `error` | `apologise_if_no_model_answered` | Says a fixed sorry line when every model in the chain failed |

Metrics writes go through `write_metrics`, which uses `run_beside`: they run beside the conversation, so no turn waits on them, and a failure is logged, not raised.

### `tools.py`

The model decides what the user meant; this file owns the data.

- **`SessionState`**: what the tools share for one session: user id, DB connection, room, timezone, `pushed_at`, a lock, and `recent_creates` for the duplicate guard.
- **Task tools:**
  - `create_task` refuses a repeat of the same title within `DUPLICATE_CREATE_SECONDS` (10).
  - `update_task` raises a `ToolError` when no field is given, and compares with the stored row so `fields` lists only real changes.
  - `delete_task` is a soft delete; `restore_task` is undo (no id means the latest delete).
- **Fact tools:** `remember_fact` and `forget_fact`. `fact_key` turns "Favorite Color" into `favorite_color`; `fact_problem` refuses an empty or too-long fact before it's saved.
- **Web search:** `look_up` calls `search_web` (one `aiohttp` POST to Tavily). With a `task_id` it checks the task exists first, so a wrong id spends no credit, then appends the answer and two source links to the task's notes. Any failure is a `ToolError`.
- **Guard:** `search_ran_this_turn` and `refuse_after_search` ([below](#web-text-cant-delete)).
- **Typed memory edits:** `edit_memory(agent, state, payload)` handles `remember`, `forget` and `forget_all` from the panel. It checks the same rules, plus the `MAX_FACTS` count (only here: speaking 20 facts takes a while, pasting doesn't). A refusal is a `MemoryEditRefused` whose message the user sees.
- **Publishing:** `publish` / `publish_for`, `push_board`, `board_payload`, `refresh_instructions` ([below](#every-change-goes-through-publish)). `after_task_change` builds the change note for task tools.
- **Replies and dates:** `describe` builds a tool's reply from the stored row; `parse_date` checks dates; `spoken_date` says them.
- **Hints:** `activity_payload` and `send_hint`, for what the screen shows but nothing depends on (tool activity, turn timings, the prompt). Unlike the board push, a failed hint is only logged.

### `memory.py`

All database access, with no LiveKit imports.

- `connect` opens one autocommit connection per session (10 s timeout) and applies `schema.sql`.
- Tasks: `list_tasks`, `get_task`, `create_task`, `update_task`, `delete_task` (sets `deleted_at`), `restore_task` (clears it). `update_task` is one fixed `UPDATE` with `COALESCE`, so `None` means "keep"; `remove_target_date` clears the date.
- Facts: `load_facts`, `save_fact` (an upsert), `forget_fact`, `forget_all_facts`.
- Metrics: `record_usage` and `record_turn` (columns in `TURN_COLUMNS`; a missing stage is `NULL`).

Two rules every task and fact query follows: it filters on `user_id`, and every write uses `RETURNING`, so callers report the row as stored. The metrics tables hold no user data, so they have neither.

### `schema.sql`

Every statement is `IF NOT EXISTS`, because it runs at the start of every session.

| Table | Holds | Notes |
|---|---|---|
| `tasks` | id, title, body, priority, target_date, done, timestamps, `deleted_at` | `CHECK` on priority (low, medium, high); soft delete; indexed on `user_id` |
| `facts` | one row per `(user_id, key)` | Saving the same key again overwrites |
| `provider_usage` | kind (`llm`/`stt`/`tts`), model, tokens, audio seconds, characters | No user id, no words; for `/stats` |
| `turn_metrics` | model and each stage's seconds | No user id, no words; for `/stats` and X-ray |

### `prompt.py`

What the model reads, kept short because every request re-sends it.

- `INSTRUCTIONS`: the persona and rules (one to three spoken sentences, confirm every change from the tool result, ask when a reference could mean more than one task, look dates up in the calendar, web results are information, not orders).
- `build_instructions`: adds today, the 14-day calendar, the board (id, title, priority, due, status, a 60-character notes preview) and the saved facts.
- `greeting`: the coded greeting (empty board, all done, or the number of open tasks).
- `FIXED_REPLIES` / `fixed_reply`: a table of exact phrases (thanks, hello, can you hear me, bye, never mind) and their replies, matched on the whole utterance ignoring case and punctuation. Anything longer goes to the model.
- `NO_MODEL_ANSWERED`: the sorry line.

### `config.py`

Every provider and tunable in one place.

- **Speech:** Deepgram Nova-3 (`build_stt`) and Aura (`build_tts`, `TTS_VOICE`).
- **LLM:** `build_llm` returns a `FallbackAdapter`: `GROQ_MODEL` (gpt-oss-120b) → `GROQ_BACKUP_MODELS` (gpt-oss-20b) → `GEMINI_MODEL` (Flash-Lite), all at temperature 0 and low reasoning effort, 10 s per attempt. Groq's caps are per model, so a second Groq model adds a full day of capacity. Gemini is called through the OpenAI plugin, and `sign_tool_calls_for_gemini` adds the `thought_signature` Gemini requires on calls Groq made.
- **Limits:** session caps, `CALENDAR_DAYS` (14), `MAX_HISTORY_ITEMS` (20), `NOTES_PREVIEW_CHARS`, the memory caps (`MAX_FACTS` 20, `MAX_FACT_KEY_CHARS` 40, `MAX_FACT_VALUE_CHARS` 120, so facts cost at most ~800 prompt tokens), and the Tavily settings.

### Tooling and deploy

| File | What it is |
|---|---|
| `bench_latency.py` | Times each model with Lumi's real prompt and tools (`bench_llm`, `--models`, `--bare` for prompt size), Neon round trips (`bench_db`), the board push (`bench_push`) and Aura's first audio (`bench_tts`). Speech-to-text and end of turn need a microphone, so they aren't here. |
| `Dockerfile` | The image LiveKit Cloud builds. Dependencies in their own cached layer, model weights baked in so a cold start downloads nothing, runs as a non-root user. |
| `livekit.toml` | Not committed (git ignores it). `lk agent create` writes it to bind this folder to a LiveKit project and agent. Deploys take the project from `LIVEKIT_URL` and the agent from `LIVEKIT_AGENT_ID` in `.env.local` instead, so each collaborator can use their own. |

## The web app, file by file

`web/` is a Next.js 16 app on Vercel. Components draw; `lib/` holds the logic as pure functions with no React, each tested on its own.

```mermaid
flowchart TD
  page["app/page.tsx<br/>masthead + VoiceSession"]
  VS["VoiceSession.tsx<br/>connection, streams, lantern,<br/>captions, keys, end card"]
  Board["Board.tsx<br/>lanes, cards, toasts"]
  XRay["XRay.tsx<br/>timings + the prompt"]
  Memory["Memory.tsx<br/>shelf + edit panel"]
  Calendar["Calendar.tsx<br/>14-day strip + month"]
  Conn["Connections.tsx<br/>.ics + Google link"]
  token["app/api/token/route.ts"]
  Paused["PausedBoard.tsx<br/>sample board, voice off"]
  lib["lib/: board.ts · turns.ts · calendar.ts · paused.ts · userId.ts<br/>pure helpers, no React"]

  page --> VS
  page -. "NEXT_PUBLIC_VOICE_PAUSED=1" .-> Paused
  Paused --> Board
  VS --> Board
  VS --> XRay
  Board --> Memory
  Board --> Calendar
  Board --> Conn
  VS -. "POST on page load" .-> token
  VS -.-> lib
  Board -.-> lib
```

| File | Lines | Its job |
|---|---|---|
| `app/api/token/route.ts` | 44 | Refuses while voice is paused; otherwise signs a 15-minute LiveKit token for the anonymous id, with the `lumi` agent dispatch inside |
| `components/VoiceSession.tsx` | 460 | The whole live session: connects, listens to every stream, holds the state |
| `components/Board.tsx` | 235 | Draws the board: lanes, cards, change animations, toasts, the day filter |
| `components/Memory.tsx` | 186 | The memory shelf and the panel to edit it |
| `components/Calendar.tsx` | 123 | The 14-day strip and the month view; days are clickable |
| `components/Connections.tsx` | 139 | Calendar export and the "Coming soon" integrations |
| `components/XRay.tsx` | 82 | The deep dives live: timings, models, screen lead, the prompt |
| `components/PausedBoard.tsx` | 108 | The page while voice is paused: the real `Board` on sample data, and a popup on arrival that says so (the dim lantern reopens it) |
| `lib/board.ts` | 487 | Payload types and every board helper |
| `lib/turns.ts` | 141 | Turn timings and the end-of-session tally |
| `lib/calendar.ts` | 107 | The Google Calendar link and the `.ics` file |
| `lib/paused.ts` | 39 | The voice switch and the sample board |
| `app/stats/page.tsx`, `lib/stats.ts`, `proxy.ts` | | The password-protected `/stats` dashboard |
| `app/globals.css` | 2326 | "The lantern board": every style and animation |

### `app/api/token/route.ts`

The only backend. `POST` first refuses with a 503 while voice is paused (`voicePaused`), so a direct call can't start a room either. Then it checks the anonymous id is a UUID, signs a 15-minute token with it as the participant identity, and puts the `lumi` agent dispatch into the token's room config. The server picks the room and the agent, not the client.

### `components/VoiceSession.tsx`

The whole client session, and the only component that talks to LiveKit.

- **Connecting:** `useSession` connects on page load with the mic off. It registers the `lumi.board` handler *before* connecting, so the first push can't arrive with no listener. `wakeAgain` starts a fresh room after an end or failure.
- **Starting:** `startTalking` (the lantern tap, or Space): unlock audio, mic on, then `lumi.start` with the browser's timezone.
- **State it keeps, and where each piece comes from:**

| State | Comes from | Shown in |
|---|---|---|
| The board, facts and recent changes | `lumi.board` → `parseBoard`, `saveCachedBoard`, `addChange` | `Board` |
| Which facts just changed | `changedFacts`, `describeFactChanges` against the previous push | The memory shelf's glow |
| `running` (tools running now) | `lumi.activity` → `parseActivity`, `applyActivity` | The status line and the breathing card |
| `turns` | `lumi.turn` → `parseTurn` | X-ray |
| The prompt | `lumi.prompt` | X-ray, "What Lumi sees" |
| `leads` (screen lead, measured here) | `boardAt` to the agent's state turning "speaking" | X-ray |
| `tally` | `addToTally`, inside the board updater | The end-of-session card |
| The agent's state | `useAgent` | The lantern and the tab title |

- **The first live push only replaces the cached copy:** it doesn't light facts or count in the tally, so a reload looks calm.
- **Small components inside:** `Lantern` pulses with `useTrackVolume` (its own component, so only it re-renders 30 times a second). `Captions` shows the user's turn (`userCaption`) and Lumi's line; the last word (`splitLastWord`) is highlighted, and tasks whose titles Lumi has said (`spokenTaskIds`) light up (read-along). Before the user speaks, `Captions` shows up to three `suggestions`. `SessionEnd` replaces the captions when a session ends (`tallyLines`).
- **Memory edits:** `editMemory` sends the `lumi.memory` RPC. The board gets it only while an agent can take it, `null` otherwise.
- **Keys:** Space talks or mutes, Esc ends, X opens X-ray (ignored with a modifier, on a focused control, or inside a dialog).

### `components/Board.tsx`

A pure view of the board. All animation is CSS, chosen by class names.

- **Layout:** open tasks in date lanes (`groupTasks`), done tasks in a collapsible Done list, "Last seen" until the first live push.
- **Change animations:** `renderCard` sets `data-changed` from the change's fields, so CSS flashes only the parts that changed, and gives a changed card a fresh key so its animation restarts. A deleted card stays as a "ghost" until it has drifted away (`withGhosts`, `onGhostGone`). The changed card is scrolled into view.
- **Toasts:** one receipt per change, stacked, each removed when it fades (`onReceiptDone`). The same sentences go to a hidden `aria-live` region for screen readers.
- **Live hints:** `is-working` while a tool runs on the card (`ACTIVITY_TEXT`), `is-spoken` while Lumi says its title.
- **Day filter:** the day picked on the `Calendar` (`day`) narrows the lanes to `tasksOnDay`, with a bar (`dayFilterText`) and "Show all". A board push with a change clears the filter, so the card Lumi is changing is never hidden.
- **Notes:** `Notes` renders a card's notes through `splitLinks`: text stays text, and each http(s) link becomes a `.source-chip` naming the site. Never HTML, because search answers come from the web.
- **End of the day:** when `todayAllDone`, "All of today's lanterns are out."

### `components/Memory.tsx`

What Lumi remembers, and the user's control over it.

- **The shelf:** every fact as a chip (`factLabel`), lit when the latest push changed it, and an Edit (or Add) button.
- **The panel** (a native `<dialog>`): what is kept, where, and who reads it, with a link to the prompt in X-ray. Change and Forget per fact, a name and value form, and "Forget everything" behind a confirm.
- **Nothing is applied in the browser.** Every edit goes to `onEdit` (the RPC), and the chips change only when the agent's board push brings the stored facts back, exactly as for a spoken fact. While `onEdit` is `null`, the controls are disabled and the note says why.

### `components/Calendar.tsx`

- **The strip** ("Next 14 days", `nightStrip`): the same 14 days the model reads in its prompt, one dot per open task lit like its card's priority, and an "N overdue" chip.
- **The month** (`monthGrid`): Monday-first weeks with prev/next arrows. Whether it's open is kept in `localStorage`.
- **Every day is a button** (`aria-pressed`): clicking calls `onSelect`, clicking again clears. One `renderDay` draws both views; a dot flares when a task just landed on that day (`dotIgnites`).

### `components/Connections.tsx`

The Connections button and its `<dialog>`, as rows in two groups:

- **Works today:** the calendar file (`downloadIcs` downloads `boardToIcs(...)` as `lumi-tasks.ics`) and Google Calendar (the link on each dated card).
- **Coming soon:** two-way calendar sync and a phone call, with a pill and no button, so nothing pretends to work.

`CalendarLink` is the per-card "Add to Google Calendar" link (`googleCalendarUrl`).

### `components/XRay.tsx`

Opens only on request (X, or the button). The last reply's stages (`STAGES`) as bars, the model that answered, the screen lead (as the agent measured it and as this browser did), "This session" (median time to voice, changes, undos, models), and "What Lumi sees": the prompt exactly as the model reads it.

### `lib/` helpers

| File | Helpers, grouped by what they serve |
|---|---|
| `board.ts` | **Payload:** `Task`, `Change`, `BoardPayload`, `parseBoard` (facts default to `{}`), `loadCachedBoard` / `saveCachedBoard`. **Lanes and dates:** `daysFromToday`, `groupOf`, `groupTasks`, `friendlyDate`, all as local calendar days. **Changes:** `describeChange`, `addChange`, `cardChange`, `withGhosts`. **Memory:** `factLabel`, `changedFacts`, `describeFactChanges`. **Captions and read-along:** `userCaption`, `spokenTaskIds`, `splitLastWord`. **Tool activity:** `parseActivity`, `applyActivity`, `ACTIVITY_TEXT`, `activityText`. **Calendar:** `nightOf`, `nightStrip`, `monthGrid`, `tasksOnDay`, `dayFilterText`, `nightLabel`, `dotIgnites`. **Other:** `suggestions`, `todayAllDone`, `splitLinks`. |
| `turns.ts` | `Turn`, `parseTurn`, `STAGES`, `median`, `seconds`, `shortModel`, `sessionSummary`. The tally: `Tally`, `EMPTY_TALLY`, `addToTally`, `tallyLines`, `tallyTotal`. |
| `calendar.ts` | `calendarTasks`, `googleCalendarUrl` (Google's undocumented prefilled link), `boardToIcs` (RFC 5545, all-day events, stable `UID`s, lines folded at 75 bytes so Arabic is never cut). |
| `userId.ts` | `getUserId`: a random UUID kept in `localStorage`, the user's only identity. |
| `paused.ts` | `voicePaused` reads the `NEXT_PUBLIC_VOICE_PAUSED` switch (only `1` or `true` pause, so a missing setting keeps voice on). `demoBoard(now)` builds the sample board, dated from `now` so it never goes overdue. |

Two date rules run through `board.ts` and `calendar.ts`: days are built with the `Date` constructor so month and year ends roll over, and an ISO date is built from local parts, never `toISOString` (which is UTC and can shift the day).

### The `/stats` dashboard

- **`proxy.ts`** (Next 16's middleware) asks for a password on `/stats` only (`STATS_PASSWORD`, HTTP Basic).
- **`app/stats/page.tsx`** is a server component. It loads seven sources in parallel, each through `orNull` so one failure blanks only its own card: LLM and speech usage, recent turns, live sessions (LiveKit `listRooms`), Tavily credits, the Deepgram balance, and the month's usage for the cost section. It reads Neon with `STATS_DATABASE_URL`, a role that can only `SELECT` the metrics tables.
- **`lib/stats.ts`** holds the logic: `LLM_LIMITS`, `isAuthorized`, `levelOf`, `percentile` (the same interpolation as Postgres), `summarize`, and the cost model (`PRICES` with a source each, `costOf`, `costSummary`, `dollars`).

### The rest of `app/`

| File | What it is |
|---|---|
| `page.tsx` | The masthead and `VoiceSession`, loaded client-only because `localStorage` doesn't exist on the server. While voice is paused it shows `PausedBoard` instead, also client-only so the sample dates follow the visitor's today |
| `layout.tsx` | The HTML shell; the two fonts through `next/font`, served from our own domain |
| `components/LanternMark.tsx` | The lantern as an inline SVG, shared by the masthead, the home-screen icon and the link preview |
| `icon.svg` | The browser-tab icon, a static copy of the lantern, since Next serves this file as is |
| `apple-icon.tsx`, `opengraph-image.tsx` | The home-screen icon and the link-preview card, drawn at build time with `ImageResponse` |
| `manifest.ts` | The web app manifest, so Lumi can be added to a phone's home screen |
| `globals.css` | Dark only. A card's priority is how brightly it glows. One keyframe per kind of change (`ignite`, `ember-away`, `pop`, `chip-slide`, `shimmer`, `extinguish`), only on transform, opacity, box-shadow and filter so they stay smooth, with gentler versions under `prefers-reduced-motion`. A 640 px phone layout. |

## The agent and browser contract

The only coupling between `agent/` and `web/`. Tests on both sides pin it (`test_board_payload_matches_the_web_contract`, `test_board_push_sends_the_contract_payload`, the `parseBoard` tests).

```mermaid
flowchart LR
  B["Browser"]
  A["Agent"]
  B -- "lumi.start RPC<br/>lumi.memory RPC<br/>mic audio" --> A
  A -- "lumi.board<br/>lumi.activity · lumi.turn · lumi.prompt<br/>voice + captions" --> B
```

Only `lumi.board` is the truth. `lumi.activity`, `lumi.turn` and `lumi.prompt` are hints: if one is lost, nothing breaks.

| Channel | Direction | Payload | When |
|---|---|---|---|
| Agent name `lumi` | token → LiveKit | `RoomAgentDispatch({agentName: 'lumi'})` | Every token. Must match `config.AGENT_NAME`. |
| Participant identity | browser → agent | The anonymous UUID from `getUserId` | Used as `user_id` in every query |
| `lumi.board` stream | agent → browser | `{"tasks": [{id, title, body, priority, target_date, done, updated_at}], "facts": {key: value}, "change": {action, task_id, title, fields} \| null}` | When the user joins (`change: null`), after every task change, and after every fact change (`change: null`; the browser compares the facts). `action` is `created`, `updated`, `deleted` or `restored`; `fields` is filled only for `updated`. |
| `lumi.activity` stream | agent → browser | `{"status": "started", "call_id", "tool", "task_id": int \| null}` or `{"status": "ended", "call_id"}` | When a tool starts (the model has chosen, the tool hasn't run) and ends |
| `lumi.turn` stream | agent → browser | `{e2e_latency, end_of_turn_delay, transcription_delay, llm_ttft, tool_seconds, tts_ttfb, board_lead, model}`, in seconds, `null` for a stage that didn't happen | After each spoken reply (not the greeting). The same row as `turn_metrics`. |
| `lumi.prompt` stream | agent → browser | `{"instructions": "<the prompt>"}` | After every prompt refresh |
| `lumi.start` RPC | browser → agent | `{"timezone": "<IANA name>"}`, returns `"ok"` | The lantern tap |
| `lumi.memory` RPC | browser → agent | `{"action": "remember", "key", "value"}`, `{"action": "forget", "key"}` or `{"action": "forget_all"}`. Returns `"ok"` or an `RpcError` (code 2000) with a message for the user. | A typed edit in the memory panel. The new facts come back on `lumi.board`. |
| Captions | both | LiveKit's standard transcription streams | Always |

## Three paths worth knowing

### Every change goes through `publish`

Spoken or typed, a task or a fact: every change ends in the same function, so the screen and the prompt can never disagree with the database.

```mermaid
flowchart TD
  T["Spoken task change<br/>create / update / delete / restore_task"] --> ATC["after_task_change<br/>builds the change note"]
  F["Spoken fact<br/>remember_fact / forget_fact"] --> P
  E["Typed edit in the memory panel<br/>lumi.memory → on_memory_edit → edit_memory"] --> PF["publish_for"]
  ATC --> P["publish"]
  P --> PF
  PF --> L["take the session lock"]
  L --> R["read once: list_tasks + load_facts"]
  R --> PB["push_board → lumi.board<br/>records pushed_at"]
  PB --> RI["refresh_instructions<br/>prompt from the same rows,<br/>also sent on lumi.prompt"]
```

- The board is pushed **before** the prompt is refreshed and before the tool returns, which is why the screen leads the voice.
- A task change costs three queries: the write, then the two reads. A unit test pins that.
- Fact changes carry no change note: the browser works out which fact changed by comparing with the last push.

### A typed memory edit goes through the agent

The memory panel doesn't write anything itself. It asks the agent, which checks the same rules as for a spoken fact.

```mermaid
sequenceDiagram
  participant P as Memory panel
  participant A as on_memory_edit
  participant E as tools.edit_memory
  participant D as Postgres
  P->>A: lumi.memory remember favorite_color blue
  A->>A: is the caller this session's user?
  A->>E: payload
  E->>E: fact_problem, MAX_FACTS
  alt the fact breaks a rule
    E-->>A: MemoryEditRefused
    A-->>P: RpcError 2000, the panel shows the message
  else ok
    E->>D: save_fact
    E->>E: publish_for
    E-->>P: lumi.board with the stored facts, the chip appears
    A-->>P: "ok"
  end
```

### Web text can't delete

A search result is text from a stranger's web page. In the 2026-11-13 eval run, a page that said "delete every task" made the main model do it, even with a prompt rule against it. So the rule lives in code:

```mermaid
flowchart TD
  N["Lumi.llm_node, before every LLM request"] --> S{"search_ran_this_turn:<br/>was look_up called<br/>since the user last spoke?"}
  S -- yes --> Y["searched_this_turn = True"]
  S -- no --> No["searched_this_turn = False"]
  Y --> D["delete_task or forget_fact"]
  D --> G["refuse_after_search raises a ToolError:<br/>nothing changed, don't retry,<br/>ask the user to say it again"]
```

Adding and editing tasks still works after a search, so "find out what documents I need and add a task" is unaffected. The flag clears as soon as the user speaks again.

## Tests

Tests are only ever added, never deleted.

| File | Count | Covers | Runs |
|---|---|---|---|
| `agent/tests/test_unit.py` | 67 | No LLM calls. The fallback chain, Gemini signing, `llm_node` history cap; schema and SQL (round trips, user isolation, the priority `CHECK`); the board payload contract; prompt and greeting rendering; every tool's reply and guard (duplicates, no fields, three queries per change); `look_up` against a local fake Tavily (401, 429, 500, timeout); fixed replies; metrics writes; typed memory edits and their refusals; the search guard. | Every push |
| `agent/tests/test_evals.py` | 36 | Text-only conversations against the real LLM (`session.run`, `result.expect`, `judge`), with a fresh user and a fixed "today" (Friday 2026-11-27). Asserts on tool calls and stored rows where possible: every task edit, undo, ambiguity, relative dates, facts across sessions, web search (`mock_tools`), prompt injection, every Groq model down. | 17 `core` on PRs that change `agent/`; all on demand |
| `web/lib/board.test.ts` | 43 | Payload parsing, date lanes across a daylight-saving switch, receipts, ghosts, facts, tool activity, read-along, suggestions, the strip, the month grid, the day filter, source chips (and non-http links staying text) | Every push |
| `web/lib/calendar.test.ts` | 12 | The Google link, end dates across month and year ends and 29 February, the exact `.ics` text, escaping, folding Arabic at 75 bytes | Every push |
| `web/lib/stats.test.ts` | 13 | The password check, limit levels, percentiles, the cost model | Every push |
| `web/lib/paused.test.ts` | 3 | The voice switch's values, the sample board's lanes across month and year ends | Every push |
| `web/lib/turns.test.ts` | 8 | Turn parsing, median, the session summary, the tally (a reopen isn't a done) | Every push |

`agent/tests/conftest.py` loads `.env.local` like the agent does, skips database tests without `TEST_DATABASE_URL` (`needs_db`), and hands out fresh user ids whose rows are deleted afterwards (`new_user`), so tests never see each other's data.

## CI/CD

One workflow, `.github/workflows/ci.yml`, with four jobs:

```mermaid
flowchart LR
  Push["Push or PR"] --> AgentJob["agent<br/>ruff + unit tests<br/>on the Neon test branch"]
  Push --> WebJob["web<br/>typecheck, build, npm test"]
  AgentJob --> Evals["evals<br/>PR that changes agent/: core tier<br/>Run workflow: full suite"]
  AgentJob --> Deploy["deploy-agent<br/>main only, agent/ changed:<br/>lk agent deploy"]
  Push -. "Vercel's Git integration" .-> Vercel["web/ deploys on its own"]
```

The full eval suite costs about 100K Groq tokens, half a model's daily cap, so it runs only on demand.

## Where to look

| You want to… | Start at |
|---|---|
| Change what Lumi says, or its rules | `prompt.INSTRUCTIONS` |
| Add a phrase that skips the model | `prompt.FIXED_REPLIES` |
| Add a tool | `tools.py`, then add it to `Lumi`'s list in `agent.py`, then an eval in `test_evals.py` |
| Change a model, the fallback order or a limit | `config.py` |
| Change a query or a table | `memory.py`, `schema.sql` |
| Change what the board sends | `tools.board_payload` and `lib/board.ts` `parseBoard`, plus both contract tests |
| Change how a card looks or animates | `Board.tsx` `renderCard`, `globals.css` |
| Find out why a reply was slow | X-ray on the page, `lk agent logs` (`turn latency`), `/stats` |
| See exactly what the model read | X-ray, "What Lumi sees" |
