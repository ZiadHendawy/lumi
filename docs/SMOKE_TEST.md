# Voice smoke check (about 5 min)

Run on the **live URL** at the end of each milestone, on desktop Chrome and one phone. Write the date and result in the log at the bottom.

## M0
- [ ] Open the URL in a fresh tab. It shows "Lumi is waking up…", then "Tap the lantern to talk". Note the cold-start time.
- [ ] Tap the lantern and allow the mic. Lumi greets you out loud.
- [ ] Ask a question. Lumi answers by voice in one to three sentences.
- [ ] Interrupt Lumi mid-sentence. It stops and listens.
- [ ] Click **End**. The status shows "Session ended · tap to talk again".
- [ ] `lk agent logs` shows `turn latency` lines with `e2e_latency`, `llm_ttft` and `tts_ttfb`.

## M1: the board by voice
- [ ] Fresh browser: the board shows the empty state with example phrases.
- [ ] "Add a task to call the bank tomorrow, high priority." The card appears under **Tomorrow**, glowing bright, before Lumi finishes confirming.
- [ ] "Add a note to it: ask about the card fee." The body appears on that card, and only the notes area flashes.
- [ ] "Rename it to call the bank about fees." The title changes in place.
- [ ] "Move it to next Friday." The card moves to the right group, and the date chip shows the right Friday.
- [ ] "Actually, remove the date." The card moves to **Someday**.
- [ ] "Make it low priority." The glow dims.
- [ ] "Mark it done." The card is extinguished and moves to **Done**.
- [ ] "Delete it." The card drifts away and the undo toast shows. "Undo." It comes back.
- [ ] "Add eggs and bread." Two cards appear.
- [ ] Refresh the page: the last board shows at once (marked as last seen), then the live board replaces it.
- [ ] Memory: "My favorite color is blue." End, refresh, start: "What's my favorite color?" The answer is blue.
- [ ] Web search: "What time does IKEA Riyadh close tonight?" A short answer that names its source site. "Add renew passport, and find out what documents I need" puts an answer and source links in the card's notes, and Lumi says only one line.

## M2/M3: deep dives and polish
- [ ] Ambiguous: with two "call" tasks, "delete the call one" makes Lumi ask which one.
- [ ] Interrupt Lumi mid-confirmation: it stops, and the board change stays.
- [ ] Lantern states: waking → ready → listening (reacts to your voice) → thinking → speaking (reacts to Lumi's voice).
- [ ] Captions show what you said and what Lumi is saying.
- [ ] Phone (390 px wide): no horizontal scroll, and the lantern never covers the last card.
- [ ] `lk agent logs`: `turn latency` lines, `tool call` lines with their time, and `board push to speech` lines (how far the screen led the voice).

## Polish (#21–#38)
- [ ] **Memory panel:** "Edit" on the shelf opens it. Add "home city: Riyadh": the chip lights up within a second. Ask "where do I live?": Lumi says Riyadh. Change it, Forget it, then "Forget everything" (it asks first).
- [ ] **Calendar:** click a day with a dot; only that day's tasks show, with "Show all". "Month" opens the whole month; click a past day with an overdue task. With a day picked, say "add a task for next Monday": the filter clears and the new card lights up.
- [ ] **Connections:** two groups, "Works today" and "Coming soon". Download .ics opens in your calendar app; the calendar icon on a dated card opens Google Calendar prefilled.
- [ ] **X-ray (press X):** after a task turn, the stage bars, the model, the screen lead and "This session". "What Lumi sees" shows the board and facts as text.
- [ ] **End a session:** the card says what got done ("2 tasks added · 1 done"), with no timings.
- [ ] **Fixed replies:** "Thanks." Lumi answers at once, and X-ray shows the model as "fixed reply".
- [ ] **Read-along:** while Lumi reads the board, the spoken word is highlighted and each card lights as its title is said.
- [ ] **Keys:** Space starts and mutes, Esc ends.

## Reliability, logs and secrets
- [ ] `lk agent secrets` lists `TAVILY_API_KEY` (with the provider keys and `DATABASE_URL`). If it's missing, add it before deploying: `lk agent update-secrets --secrets TAVILY_API_KEY=...`.
- [ ] Startup lines in the logs, in order: `database connected`, `room connected`, `session ready`, then `start clicked` with the browser's timezone on the tap. If `database connected` comes after `room connected`, Neon is what keeps the lantern waiting.
- [ ] Every user turn logs `user turn latency` (`transcription_delay`, `end_of_turn_delay`), and every reply logs `turn latency` with the model that answered.
- [ ] Every board change logs `board push to speech` with a positive number of seconds (the board landed before the voice).
- [ ] Greeting with gpt-oss capped (local): `GROQ_API_KEY=invalid uv run agent.py dev`, open the local web app and tap the lantern. Lumi still greets you at once (fixed text, no LLM call). "Add a task to call the bank" still works, on Gemini, more slowly.
- [ ] Sorry line when every model fails (local): `GROQ_API_KEY=invalid GEMINI_API_KEY=invalid uv run agent.py dev`, tap the lantern, say anything. Lumi says "Sorry, my thinking is overloaded for a moment…" and the lantern goes back to listening, instead of sitting on "thinking".

## Voice paused (`NEXT_PUBLIC_VOICE_PAUSED=1`)
- [ ] The live URL opens with the "Voice is paused for now" popup over the sample board. **Look around**, Esc and a click outside each close it. Tapping the dim lantern opens it again.
- [ ] DevTools → Network shows no request to `/api/token`. `curl -X POST <url>/api/token` returns 503.
- [ ] On a phone, the last card scrolls clear of the note and the lantern.

## Log
| Date | Milestone | Desktop | Mobile | Cold start | Notes |
|---|---|---|---|---|---|
| 2026-11-11 | M0 | ✅ Chrome: connect, greet, Q&A and interrupt all work | ✅ passed | warm (agent already up) | ❌→✅ "Do you hear me?" got "I can only use text". Fixed in the prompt and covered by a 5-phrasing eval. Latency over 13 turns: user stops talking → reply starts 0.63–2.56 s (median ~0.9 s), LLM first token ~0.3 s, TTS first audio ~0.06 s |
| 2026-11-12 | M1–M3, **local agent, not the deployed URL** | Chrome driven by Playwright, real audio (macOS `say` WAVs through a `getUserMedia` stand-in), 10 turns. gpt-oss-120b was capped, so turns ran on qwen or Gemini. | not recorded | no cold start (local agent). Reload: cached board at once, live board 8.8 s later | The board reached the screen before Lumi's voice in every turn, by 1.3–6.4 s (agent log and browser agree). Board changed 2.2–4.4 s after the user stopped talking; speech started 3.2–10.8 s after. The database matched the screen after create, note, move, done, delete and undo. Found and fixed: no greeting on fallback models (#17), silence when every model failed (#18), caption showed only the last segment (#15), back-to-back changes wiped each other's highlight (#15). Still to do: this checklist on the deployed URL and a phone. |
| 2026-11-13 | Memory panel, **deployed URL, scripted, no voice** | Headless Chrome against the live site with a fresh anonymous user: the panel enabled after a 7.1 s cold start, a typed fact came back as a chip in 0.54 s (RPC to the deployed agent, then the board push), a 121-character value was refused with the agent's message, and "Forget everything" emptied the shelf. | not recorded | 7.1 s | Not a voice run: the Polish checklist above still needs a person with a mic. |
