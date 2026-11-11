# Lumi

A voice assistant that listens, talks back, and remembers you. Plan: [PROJECT_PLAN.md](PROJECT_PLAN.md) · Stack: [TECH_STACK.md](TECH_STACK.md) · Code walkthrough: [docs/CODE_MAP.md](docs/CODE_MAP.md)

```
agent/   Python LiveKit Agents worker (runs on LiveKit Cloud)
web/     Next.js app + /api/token route (runs on Vercel)
```

## Run locally
```bash
# agent: fill agent/.env.local from agent/.env.example
cd agent
uv sync
uv run -m livekit.agents download-files   # VAD + turn-detector weights, once
uv run agent.py dev              # connects to your LiveKit Cloud project

# web: fill web/.env.local from web/.env.example
cd web
npm install
npm run dev                      # http://localhost:3000
```

## Tests
```bash
cd agent
uv run pytest          # unit tests (DB test needs TEST_DATABASE_URL)
uv run pytest -m eval  # conversation evals against the real LLM (needs GROQ_API_KEY)
```
Manual voice check: [docs/SMOKE_TEST.md](docs/SMOKE_TEST.md).

## Deploy
- **Agent:** `cd agent && lk agent create` the first time (it registers the agent and writes `livekit.toml`), then `lk agent deploy`. Secrets: `lk agent update-secrets --secrets-file .env.local`.
- **Web:** import the repo in Vercel with root directory `web/`, then set `LIVEKIT_URL`, `LIVEKIT_API_KEY` and `LIVEKIT_API_SECRET`. Every push deploys.
