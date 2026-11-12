// The /stats page: how close each free plan is to its limit, and where the time goes
// in a voice turn. A server component: provider keys and the database URL never reach
// the browser. Rendered on every request, so a refresh shows the latest numbers.
import { neon } from '@neondatabase/serverless';
import { RoomServiceClient } from 'livekit-server-sdk';
import { headers } from 'next/headers';
import { notFound } from 'next/navigation';
import { LLM_LIMITS, SESSION_LIMIT, type StageSummary, isAuthorized, levelOf, summarize } from '@/lib/stats';
import styles from './stats.module.css';

export const metadata = { title: 'Lumi stats', robots: { index: false } };

// --- Data ----------------------------------------------------------------------
// Each source is fetched on its own and returns null on failure, so one provider being
// down blanks its own section, not the page.

const sql = () => neon(process.env.STATS_DATABASE_URL!);

type LlmRow = {
  model: string;
  requests_minute: number;
  tokens_minute: number;
  requests_day: number;
  tokens_day: number;
};
type SpeechRow = {
  kind: 'stt' | 'tts';
  model: string;
  audio_day: number;
  audio_month: number;
  chars_day: number;
  chars_month: number;
};
type TurnRow = {
  at: string;
  model: string | null;
  e2e_latency: number | null;
  transcription_delay: number | null;
  end_of_turn_delay: number | null;
  llm_ttft: number | null;
  tts_ttfb: number | null;
  tool_seconds: number | null;
  board_lead: number | null;
};

async function llmUsage() {
  // Groq's daily caps are a rolling 24 h window, so "day" here is the last 24 h too.
  return (await sql()`
    SELECT model,
      count(*) FILTER (WHERE at > now() - interval '1 minute')::int AS requests_minute,
      coalesce(sum(input_tokens + output_tokens)
        FILTER (WHERE at > now() - interval '1 minute'), 0)::int AS tokens_minute,
      count(*)::int AS requests_day,
      coalesce(sum(input_tokens + output_tokens), 0)::int AS tokens_day
    FROM provider_usage
    WHERE kind = 'llm' AND at > now() - interval '24 hours'
    GROUP BY model`) as LlmRow[];
}

async function speechUsage() {
  return (await sql()`
    SELECT kind, model,
      coalesce(sum(audio_seconds) FILTER (WHERE at > now() - interval '24 hours'), 0)::float AS audio_day,
      coalesce(sum(audio_seconds), 0)::float AS audio_month,
      coalesce(sum(characters) FILTER (WHERE at > now() - interval '24 hours'), 0)::int AS chars_day,
      coalesce(sum(characters), 0)::int AS chars_month
    FROM provider_usage
    WHERE kind IN ('stt', 'tts') AND at > now() - interval '30 days'
    GROUP BY kind, model
    ORDER BY kind`) as SpeechRow[];
}

async function recentTurns() {
  return (await sql()`
    SELECT at, model, e2e_latency, transcription_delay, end_of_turn_delay,
      llm_ttft, tts_ttfb, tool_seconds, board_lead
    FROM turn_metrics
    WHERE at > now() - interval '7 days'
    ORDER BY at DESC
    LIMIT 2000`) as TurnRow[];
}

async function liveSessions() {
  // One room is one visitor, with one agent session in it.
  const rooms = new RoomServiceClient(
    process.env.LIVEKIT_URL!,
    process.env.LIVEKIT_API_KEY,
    process.env.LIVEKIT_API_SECRET,
  );
  return (await rooms.listRooms()).length;
}

async function getJson(url: string, authorization: string) {
  const response = await fetch(url, {
    headers: { Authorization: authorization },
    cache: 'no-store',
    signal: AbortSignal.timeout(5_000),
  });
  if (!response.ok) throw new Error(`${url}: HTTP ${response.status}`);
  return response.json();
}

async function searchCredits() {
  // Tavily's usage check is free: it spends no search credit.
  const data = await getJson('https://api.tavily.com/usage', `Bearer ${process.env.TAVILY_API_KEY}`);
  return { used: data.account.plan_usage as number, limit: data.account.plan_limit as number };
}

async function deepgramCredit() {
  // Needs a key with the usage and billing read scopes (DEEPGRAM_USAGE_KEY), separate
  // from the agent's speech key, which can only transcribe and speak.
  const key = process.env.DEEPGRAM_USAGE_KEY;
  if (!key) return null;
  const auth = `Token ${key}`;
  const { projects } = await getJson('https://api.deepgram.com/v1/projects', auth);
  const { balances } = await getJson(`https://api.deepgram.com/v1/projects/${projects[0].project_id}/balances`, auth);
  return balances[0] as { amount: number; units: string };
}

async function orNull<T>(load: () => Promise<T>): Promise<T | null> {
  try {
    return await load();
  } catch (error) {
    console.error('stats source failed', error);
    return null;
  }
}

// --- Page ----------------------------------------------------------------------

export default async function StatsPage() {
  // proxy.ts already asked for the password; checking again here means the data can't
  // leak if the proxy's matcher is ever changed by mistake.
  if (!isAuthorized((await headers()).get('authorization'), process.env.STATS_PASSWORD)) notFound();

  const [llm, speech, turns, sessions, search, credit] = await Promise.all([
    orNull(llmUsage),
    orNull(speechUsage),
    orNull(recentTurns),
    orNull(liveSessions),
    orNull(searchCredits),
    orNull(deepgramCredit),
  ]);

  return (
    <main className={styles.page}>
      <header className={styles.header}>
        <h1>Lumi stats</h1>
        <p className={styles.muted}>
          Free-plan limits and voice latency for the live demo, as of{' '}
          {new Date().toLocaleTimeString('en-GB', { timeZone: 'UTC' })} UTC. Refresh for new numbers.
        </p>
      </header>

      <section className={styles.section}>
        <h2>Right now</h2>
        <div className={styles.grid}>
          <Card title="Live sessions" note="LiveKit Cloud. A page left open holds a session until it times out.">
            {sessions === null ? <Unavailable /> : <Meter used={sessions} limit={SESSION_LIMIT} unit="sessions" />}
          </Card>
        </div>
      </section>

      <section className={styles.section}>
        <h2>Language models</h2>
        <p className={styles.muted}>
          Tried in this order; a model is only used when the ones above it fail. &ldquo;Day&rdquo; is the last 24 hours.
        </p>
        {llm === null ? (
          <Unavailable />
        ) : (
          <div className={styles.grid}>
            {Object.entries(LLM_LIMITS).map(([model, limits]) => {
              const row = llm.find((r) => r.model === model);
              const about = limits.approximate ? ' (approximate cap)' : '';
              return (
                <Card
                  key={model}
                  title={model}
                  note={limits.approximate ? `${limits.provider}. Caps are third-party figures.` : limits.provider}
                >
                  {limits.tokensPerMinute && (
                    <Meter
                      label="Tokens, last minute"
                      used={row?.tokens_minute ?? 0}
                      limit={limits.tokensPerMinute}
                      unit="tokens"
                    />
                  )}
                  {limits.requestsPerMinute && (
                    <Meter
                      label={`Requests, last minute${about}`}
                      used={row?.requests_minute ?? 0}
                      limit={limits.requestsPerMinute}
                      unit="requests"
                    />
                  )}
                  <Meter
                    label={`Requests, day${about}`}
                    used={row?.requests_day ?? 0}
                    limit={limits.requestsPerDay}
                    unit="requests"
                  />
                  {limits.tokensPerDay && (
                    <Meter label="Tokens, day" used={row?.tokens_day ?? 0} limit={limits.tokensPerDay} unit="tokens" />
                  )}
                </Card>
              );
            })}
          </div>
        )}
      </section>

      <section className={styles.section}>
        <h2>Speech and search</h2>
        <div className={styles.grid}>
          <Card title="Deepgram credit" note="Pays for both speech-to-text and the voice. A one-time $200 credit.">
            {credit === null ? (
              <p className={styles.muted}>Add a DEEPGRAM_USAGE_KEY (usage and billing read) to see the balance.</p>
            ) : (
              <p className={styles.figure}>
                {credit.amount.toLocaleString('en-US', { maximumFractionDigits: 2 })} {credit.units.toUpperCase()} left
              </p>
            )}
          </Card>
          {speech === null ? (
            <Card title="Speech use">
              <Unavailable />
            </Card>
          ) : (
            <Card title="Speech use" note="Counted by the agent itself, last 24 hours and last 30 days.">
              {speech.length === 0 && <p className={styles.muted}>Nothing yet.</p>}
              {speech.map((row) => (
                <div key={row.kind + row.model} className={styles.usage}>
                  <p>
                    {row.kind === 'stt' ? 'Speech-to-text' : 'Voice'}
                    <span className={styles.hint}>{row.model}</span>
                  </p>
                  <p className={styles.usageValue}>
                    {row.kind === 'stt'
                      ? `${minutes(row.audio_day)} · ${minutes(row.audio_month)}`
                      : `${chars(row.chars_day)} · ${chars(row.chars_month)}`}
                  </p>
                </div>
              ))}
            </Card>
          )}
          <Card title="Web search" note="Tavily, this month.">
            {search === null ? <Unavailable /> : <Meter used={search.used} limit={search.limit} unit="searches" />}
          </Card>
        </div>
      </section>

      <section className={styles.section}>
        <h2>Latency</h2>
        {turns === null ? <Unavailable /> : <Latency turns={turns} />}
      </section>
    </main>
  );
}

function Latency({ turns }: { turns: TurnRow[] }) {
  if (turns.length === 0) return <p className={styles.muted}>No turns in the last 7 days.</p>;
  const plain = turns.filter((t) => t.tool_seconds === null);
  const withTool = turns.filter((t) => t.tool_seconds !== null);
  // In the order they happen in a turn. A tool turn makes two LLM calls, so its total
  // is shown apart from a plain reply's.
  const stages: [string, string, StageSummary][] = [
    ['Transcript ready', 'after you stop talking', summarize(turns.map((t) => t.transcription_delay))],
    ['End of turn', 'wait before deciding you finished', summarize(turns.map((t) => t.end_of_turn_delay))],
    ['LLM first token', '', summarize(turns.map((t) => t.llm_ttft))],
    ['Tools', 'SQL, board push, web search', summarize(turns.map((t) => t.tool_seconds))],
    ['Voice first audio', '', summarize(turns.map((t) => t.tts_ttfb))],
    ['Board ahead of voice', 'how far the screen leads', summarize(turns.map((t) => t.board_lead))],
    ['Whole turn, plain reply', 'you stop talking → Lumi speaks', summarize(plain.map((t) => t.e2e_latency))],
    ['Whole turn, with a tool', 'you stop talking → Lumi speaks', summarize(withTool.map((t) => t.e2e_latency))],
  ];
  return (
    <>
      <p className={styles.muted}>{turns.length} turns in the last 7 days. Seconds.</p>
      <div className={styles.scroll}>
        <table className={styles.table}>
          <thead>
            <tr>
              <th scope="col">Stage</th>
              <th scope="col" className={styles.num}>
                Median
              </th>
              <th scope="col" className={styles.num}>
                90th %
              </th>
              <th scope="col" className={styles.num}>
                Slowest
              </th>
              <th scope="col" className={styles.num}>
                Turns
              </th>
            </tr>
          </thead>
          <tbody>
            {stages.map(([name, hint, s]) => (
              <tr key={name} className={name.startsWith('Whole') ? styles.total : undefined}>
                <th scope="row">
                  {name}
                  {hint && <span className={styles.hint}>{hint}</span>}
                </th>
                <td className={styles.num}>{seconds(s.median)}</td>
                <td className={styles.num}>{seconds(s.p90)}</td>
                <td className={styles.num}>{seconds(s.max)}</td>
                <td className={styles.num}>{s.count}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <h3 className={styles.subhead}>Last 20 turns</h3>
      <div className={styles.scroll}>
        <table className={styles.table}>
          <thead>
            <tr>
              <th scope="col">Time (UTC)</th>
              <th scope="col">Model</th>
              <th scope="col" className={styles.num}>
                Whole turn
              </th>
              <th scope="col" className={styles.num}>
                LLM
              </th>
              <th scope="col" className={styles.num}>
                Tools
              </th>
              <th scope="col" className={styles.num}>
                Voice
              </th>
            </tr>
          </thead>
          <tbody>
            {turns.slice(0, 20).map((t, i) => (
              <tr key={i}>
                <td>
                  {new Date(t.at).toLocaleString('en-GB', {
                    timeZone: 'UTC',
                    day: 'numeric',
                    month: 'short',
                    hour: '2-digit',
                    minute: '2-digit',
                  })}
                </td>
                <td>{t.model ?? '—'}</td>
                <td className={styles.num}>{seconds(t.e2e_latency)}</td>
                <td className={styles.num}>{seconds(t.llm_ttft)}</td>
                <td className={styles.num}>{seconds(t.tool_seconds)}</td>
                <td className={styles.num}>{seconds(t.tts_ttfb)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}

// --- Small pieces --------------------------------------------------------------

const LEVEL_WORDS = { ok: '', near: 'Near the limit', over: 'At the limit' };

// A cap as a bar. The number and the words carry the meaning; the colour only repeats it.
function Meter({ label, used, limit, unit }: { label?: string; used: number; limit: number; unit: string }) {
  const level = levelOf(used, limit);
  const share = Math.min(used / limit, 1);
  return (
    <div className={styles.meter}>
      {label && <p className={styles.meterLabel}>{label}</p>}
      <div
        className={styles.track}
        role="meter"
        aria-valuemin={0}
        aria-valuemax={limit}
        aria-valuenow={used}
        aria-label={`${label ?? unit}: ${used} of ${limit}`}
      >
        <div className={`${styles.fill} ${styles[level]}`} style={{ width: `${share * 100}%` }} />
      </div>
      <p className={styles.meterValue}>
        <span>
          {used.toLocaleString('en-US')} / {limit.toLocaleString('en-US')} {unit} · {Math.round((used / limit) * 100)}%
        </span>
        {LEVEL_WORDS[level] && <span className={`${styles.flag} ${styles[level]}`}>{LEVEL_WORDS[level]}</span>}
      </p>
    </div>
  );
}

function Card({ title, note, children }: { title: string; note?: string; children: React.ReactNode }) {
  return (
    <article className={styles.card}>
      <h3>{title}</h3>
      {note && <p className={styles.note}>{note}</p>}
      {children}
    </article>
  );
}

function Unavailable() {
  return <p className={styles.muted}>Couldn&rsquo;t load this right now.</p>;
}

const seconds = (value: number | null) => (value === null ? '—' : value.toFixed(2));
const minutes = (secs: number) => `${(secs / 60).toLocaleString('en-US', { maximumFractionDigits: 1 })} min`;
const chars = (count: number) => `${count.toLocaleString('en-US')} chars`;
