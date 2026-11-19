# Setting up your accounts

**These are your own keys, for running Lumi on your machine.** They never reach the shared app. Its production keys stay in the maintainer's Vercel, LiveKit and GitHub settings and are never shared. To ship a change, open a pull request: see [How changes ship](../README.md#how-changes-ship).

Lumi uses six services. Each one has a free tier. This page covers signing up, where each key is, and which line of which `.env.local` it goes on. Fill in `agent/.env.local` and `web/.env.local` as you go. The [README](../README.md#2-fill-in-your-env-files) shows how to create them.

Dashboards change. If a button below has moved, the official page linked in each section has the current steps.

**Never paste a key into an issue, a chat or a commit.** Keys go only into your `.env.local` files, which git ignores.

---

## 1. LiveKit Cloud (voice transport and agent hosting)

**Gives you:** `LIVEKIT_URL`, `LIVEKIT_API_KEY`, `LIVEKIT_API_SECRET`

1. Sign up at [cloud.livekit.io](https://cloud.livekit.io) and create a project (any name, e.g. `lumi`).
2. In the project, open **Settings → API keys** and create a key.
3. You get three values. Copy all three:
   - the URL, which looks like `wss://<your-project>.livekit.cloud`, into **`LIVEKIT_URL`**
   - the API key, which starts with `API`, into **`LIVEKIT_API_KEY`**
   - the API secret into **`LIVEKIT_API_SECRET`**
4. Put the same three values in **both** `agent/.env.local` and `web/.env.local`: the web app signs room tokens that the agent's project has to accept.

You don't need `lk cloud auth` or the LiveKit CLI for local development. With your own LiveKit project, your local agent and web app talk only to each other, never to the shared app.

Official docs: [LiveKit CLI authentication](https://docs.livekit.io/reference/developer-tools/livekit-cli/auth/)

## 2. Deepgram (speech to text, and Lumi's voice)

**Gives you:** `DEEPGRAM_API_KEY`

1. Sign up at [console.deepgram.com](https://console.deepgram.com/signup). New accounts come with free credit ($200 at the time of writing). Signing up creates your first project.
2. Pick your project from the **Projects** drop-down (top left), then open **Settings → API Keys**.
3. Select **Create a New API Key**. Give it a name (e.g. `lumi-dev`). Member permissions are enough. Select **Create Key**.
4. Copy the key straight away: Deepgram shows it only once. Paste it into **`DEEPGRAM_API_KEY`** in `agent/.env.local`.

Official docs: [Create API keys](https://developers.deepgram.com/docs/create-additional-api-keys)

## 3. Groq (the main LLMs)

**Gives you:** `GROQ_API_KEY`

1. Sign up at [console.groq.com](https://console.groq.com).
2. Open [**API Keys**](https://console.groq.com/keys) and create a key.
3. Copy it straight away (you may not be able to see it again) into **`GROQ_API_KEY`** in `agent/.env.local`.

The free tier limits tokens per model per day (see [TECH_STACK.md](TECH_STACK.md)). The agent falls back to a second Groq model, then to Gemini, when one runs out.

Official docs: [Groq quickstart](https://console.groq.com/docs/quickstart)

## 4. Google AI Studio (Gemini, the fallback LLM)

**Gives you:** `GEMINI_API_KEY`

1. Sign in at [aistudio.google.com](https://aistudio.google.com) with a Google account and accept the terms.
2. Open [**API Keys**](https://aistudio.google.com/apikey) and select **Create API key**.
3. Copy it into **`GEMINI_API_KEY`** in `agent/.env.local`.

If you've never used Google Cloud, AI Studio creates a default project for the key automatically. If you already have Google Cloud projects, it may ask you to pick or import one first (**Dashboard → Projects → Import projects**).

Official docs: [Using Gemini API keys](https://ai.google.dev/gemini-api/docs/api-key)

## 5. Tavily (web search)

**Gives you:** `TAVILY_API_KEY`

1. Sign up at [app.tavily.com](https://app.tavily.com). The free plan has 1,000 credits a month and needs no card. A basic search (what Lumi uses) costs 1 credit.
2. Your API key is on the dashboard after you sign in. It starts with `tvly-`.
3. Copy it into **`TAVILY_API_KEY`** in `agent/.env.local`. To see search usage on `/stats`, also put it in `web/.env.local`.

Without this key everything else works, but "find out..." requests fail.

Official docs: [Tavily quickstart](https://docs.tavily.com/documentation/quickstart)

## 6. Neon (Postgres for the board and memory)

**Gives you:** `DATABASE_URL`, and optionally `TEST_DATABASE_URL`

### The main database

1. Sign up at [console.neon.tech](https://console.neon.tech) and create a project. Pick the region closest to where your agent runs: **AWS US East (N. Virginia)** if you deploy the agent to LiveKit's `us-east`.
2. On the project's dashboard, select **Connect**. In the dialog, **turn off "Connection pooling"**. Lumi holds one connection per voice session and is tested with a direct connection. The host in the string should *not* contain `-pooler`.
3. Copy the connection string (`postgresql://...`) into **`DATABASE_URL`** in `agent/.env.local`.

You don't need to create any tables: the agent creates them the first time it connects.

### A test branch (optional)

The database tests write and delete rows, so they run against a separate branch, never your real board. Without `TEST_DATABASE_URL` they're skipped, and every other test still runs.

1. In your Neon project, open **Branches → New branch**. Name it `test`. Its parent is your main branch.
2. **Uncheck "Automatically delete branch after"**. It's on by default (1 day), and the branch would disappear.
3. Select **Create**, then **Connect**, choose the `test` branch, turn off connection pooling again, and copy the string into **`TEST_DATABASE_URL`** in `agent/.env.local`.

Official docs: [Connect from any app](https://neon.com/docs/connect/connect-from-any-app), [Branches](https://neon.com/docs/manage/branches)

### A read-only role for `/stats` (optional)

Only needed for the password-protected `/stats` page. Run this in Neon's **SQL Editor** on your main branch, *after* the agent has connected once (so the tables exist). Choose your own password:

```sql
CREATE ROLE stats_reader WITH LOGIN PASSWORD 'choose-a-long-random-password';
GRANT USAGE ON SCHEMA public TO stats_reader;
GRANT SELECT ON provider_usage, turn_metrics TO stats_reader;
```

This role can read only the two metrics tables, not your tasks or facts. Take your `DATABASE_URL`, replace the user and password with `stats_reader` and the password you chose, and put the result in **`STATS_DATABASE_URL`** in `web/.env.local`. Then set **`STATS_PASSWORD`** to any password you like: it's what the browser asks for at `/stats`.

---

## Check you have everything

**`agent/.env.local`:** `LIVEKIT_URL`, `LIVEKIT_API_KEY`, `LIVEKIT_API_SECRET`, `DEEPGRAM_API_KEY`, `GROQ_API_KEY`, `GEMINI_API_KEY`, `TAVILY_API_KEY`, `DATABASE_URL` (plus `TEST_DATABASE_URL` if you made the branch).

**`web/.env.local`:** `LIVEKIT_URL`, `LIVEKIT_API_KEY`, `LIVEKIT_API_SECRET` (plus the `STATS_*` lines if you want `/stats`).

Then go back to the [README](../README.md#3-start-the-agent-and-the-web-app) and start the agent and the web app.
