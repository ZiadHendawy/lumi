# Code map

One paragraph per file, then the life of one voice turn. Updated every milestone.

## Agent (`agent/`, Python, runs on LiveKit Cloud)

**`agent.py`**: the worker entry point. `prewarm` loads the Silero VAD once per process. `entrypoint` runs once per room: it builds an `AgentSession` from the providers in `config.py`, uses the local `v1-mini` turn detector (free, runs on the worker), and starts the `Lumi` agent (persona prompt only for now). It also logs per-turn latency from each assistant message's `metrics`, shuts down after 3 min of user silence or 10 min total (to protect free-tier minutes on a public URL), and registers the `lumi.start` RPC that the browser calls on click, so the greeting plays only once audio is allowed.

**`config.py`**: every provider and tunable in one place. Deepgram Nova-3 (STT), Groq → Gemini Flash-Lite via LiveKit's `FallbackAdapter` (LLM, temperature 0), and Deepgram Aura (TTS). Gemini is called through the OpenAI plugin, because Gemini offers an OpenAI-compatible endpoint. It also holds the agent name and session caps. Model names can be overridden by env var, so changing a vendor or model means editing one line.

**`schema.sql`**: the `facts` table, one row per `(user_id, key)`, so saving a fact again overwrites it. It's idempotent (`IF NOT EXISTS`), so it's safe to re-run.

**`tests/test_unit.py`**: fast tests with no LLM calls, run on every push. M0 checks that the LLM fallback order is Groq first, and that the schema can be applied twice and enforces one row per user and key. The DB test needs `TEST_DATABASE_URL` (a Neon `test` branch) and is skipped without it.

**`tests/test_evals.py`**: text-only conversations against the real LLM using LiveKit's testing helpers (`session.run`, `result.expect`, LLM `judge`). They only run with `pytest -m eval` because they spend Groq quota. M0 has three: Lumi answers in persona; Lumi still answers when Groq fails (a bad Groq key forces the Gemini fallback); and Lumi says it can hear you (five phrasings of "can you hear me?", added after the first smoke test, when it claimed it could only read text). Scenarios are only ever added.

**`livekit.toml`**: written by `lk agent create`. It binds this folder to the LiveKit Cloud project and agent ID, so `lk agent deploy/logs/status` need no flags. It holds no secrets: those live in LiveKit Cloud and are uploaded from `.env.local`.

**`Dockerfile`**: the image LiveKit Cloud builds, trimmed from the starter. Dependencies get their own cached layer, and model weights are baked in at build time so a cold start doesn't download them.

## Web (`web/`, Next.js on Vercel)

**`app/api/token/route.ts`**: the only backend. It checks that the browser's anonymous id is a UUID, signs a 15-minute LiveKit token with that id as the participant identity, and puts the Lumi agent dispatch into the token's room config. The server decides the dispatch, not the client.

**`components/VoiceSession.tsx`**: the whole client session. `useSession` connects on page load with the mic off, which hides the agent's cold start behind a "waking up" state. On click it unlocks audio, turns the mic on and calls `lumi.start`. `useAgent` drives the status text, and `RoomAudioRenderer` plays Lumi's voice.

**`lib/userId.ts`**: creates and remembers a random UUID in `localStorage`. This is the user's identity for memory, with no login.

**`app/page.tsx`**, **`app/layout.tsx`**, **`app/globals.css`**: the page shell. The session is loaded client-only, because `localStorage` doesn't exist during server rendering. The styling is a bare placeholder until the M3 UI direction is chosen.

## Life of one voice turn
1. **Page load:** `VoiceSession` POSTs to `/api/token`, then connects to LiveKit. LiveKit dispatches a `lumi` job, and the worker runs `entrypoint` (cold start if it was idle).
2. **Click "Start talking":** audio unlocks, the mic publishes, and RPC `lumi.start` makes the agent say its greeting.
3. **User speaks:** audio streams over WebRTC to the worker. Silero VAD detects speech, and Deepgram streams the transcript.
4. **End of turn:** the turn detector decides the user has finished (`end_of_turn_delay`).
5. **Think:** the transcript and chat history go to Groq (Gemini if Groq fails), and the first token arrives (`llm_ttft`).
6. **Speak:** sentences stream into Deepgram Aura, and the first audio byte comes back (`tts_ttfb`). Audio plays in the browser through `RoomAudioRenderer`.
7. **Log:** when the assistant message is committed, `agent.py` logs `e2e_latency`, `llm_ttft` and `tts_ttfb` for that turn.
