# Voice smoke check (about 5 min)

Run on the **live URL** at the end of each milestone, on desktop Chrome and one phone. Write the date and result in the log at the bottom.

## M0
- [ ] Open the URL in a fresh tab. It shows "Lumi is waking up…", then "Lumi is ready." Note the cold-start time.
- [ ] Click **Start talking** and allow the mic. Lumi greets you out loud.
- [ ] Ask a question. Lumi answers by voice in one to three sentences.
- [ ] Interrupt Lumi mid-sentence. It stops and listens.
- [ ] Click **End**. The status shows "Session ended".
- [ ] `lk agent logs` shows `turn latency` lines with `e2e_latency`, `llm_ttft` and `tts_ttfb`.

## M1 (add when M1 lands)
- [ ] Memory: "My favorite color is blue." End, refresh, start: "What's my favorite color?" The answer is blue.
- [ ] External API tool answers with real data, and a bad input gets a graceful reply.

## Log
| Date | Milestone | Desktop | Mobile | Cold start | Notes |
|---|---|---|---|---|---|
| 2026-11-11 | M0 | ✅ Chrome: connect, greet, Q&A and interrupt all work | ✅ passed | warm (agent already up) | ❌→✅ "Do you hear me?" got "I can only use text". Fixed in the prompt and covered by a 5-phrasing eval. Latency over 13 turns: user stops talking → reply starts 0.63–2.56 s (median ~0.9 s), LLM first token ~0.3 s, TTS first audio ~0.06 s |
