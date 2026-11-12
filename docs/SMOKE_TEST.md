# Voice smoke check (about 5 min)

Run on the **live URL** at the end of each milestone, on desktop Chrome and one phone. Write the date and result in the log at the bottom.

## M0
- [ ] Open the URL in a fresh tab. It shows "Lumi is waking up…", then "Lumi is ready." Note the cold-start time.
- [ ] Click **Start talking** and allow the mic. Lumi greets you out loud.
- [ ] Ask a question. Lumi answers by voice in one to three sentences.
- [ ] Interrupt Lumi mid-sentence. It stops and listens.
- [ ] Click **End**. The status shows "Session ended".
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
- [ ] Weather: "Will it rain in Riyadh on Saturday?" A real forecast comes back. "What's the weather in Atlantis?" gets a graceful "couldn't find it".

## M2/M3: deep dives and polish
- [ ] Ambiguous: with two "call" tasks, "delete the call one" makes Lumi ask which one.
- [ ] Interrupt Lumi mid-confirmation: it stops, and the board change stays.
- [ ] Lantern states: waking → ready → listening (reacts to your voice) → thinking → speaking (reacts to Lumi's voice).
- [ ] Captions show what you said and what Lumi is saying.
- [ ] Phone (390 px wide): no horizontal scroll, and the lantern never covers the last card.
- [ ] `lk agent logs`: `turn latency` lines, tool timings, and `board ahead of voice` lines.

## Log
| Date | Milestone | Desktop | Mobile | Cold start | Notes |
|---|---|---|---|---|---|
| 2026-11-11 | M0 | ✅ Chrome: connect, greet, Q&A and interrupt all work | ✅ passed | warm (agent already up) | ❌→✅ "Do you hear me?" got "I can only use text". Fixed in the prompt and covered by a 5-phrasing eval. Latency over 13 turns: user stops talking → reply starts 0.63–2.56 s (median ~0.9 s), LLM first token ~0.3 s, TTS first audio ~0.06 s |
