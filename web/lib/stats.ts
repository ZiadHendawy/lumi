// Pure helpers for the /stats page, with no React and no network, so each one can be
// tested on its own (lib/stats.test.ts).

// The free-plan caps, from TECH_STACK.md. Groq's were measured on our key
// (2026-11-12); Gemini's are third-party figures, so the page labels them "about".
// Keys are the model names the agent records (config.py).
export type LlmLimits = {
  provider: string;
  tokensPerMinute?: number;
  requestsPerMinute?: number;
  requestsPerDay: number;
  tokensPerDay?: number;
  approximate?: boolean;
};

const GROQ_FREE: LlmLimits = {
  provider: 'Groq',
  tokensPerMinute: 8_000,
  requestsPerDay: 1_000,
  tokensPerDay: 200_000,
};

// In fallback order: the agent only reaches a model once the ones above it fail.
export const LLM_LIMITS: Record<string, LlmLimits> = {
  'openai/gpt-oss-120b': GROQ_FREE,
  'openai/gpt-oss-20b': GROQ_FREE,
  'gemini-flash-lite-latest': {
    provider: 'Gemini',
    requestsPerMinute: 15,
    requestsPerDay: 500,
    approximate: true,
  },
};

// LiveKit Cloud's free plan runs at most this many agent sessions at once.
export const SESSION_LIMIT = 5;

// Basic auth: the browser sends "Basic base64(user:password)". Any user name works;
// only the password is checked. With no password configured, nobody gets in.
export function isAuthorized(header: string | null, password: string | undefined): boolean {
  if (!password || !header?.startsWith('Basic ')) return false;
  let decoded: string;
  try {
    decoded = atob(header.slice('Basic '.length));
  } catch {
    return false; // not valid base64
  }
  const colon = decoded.indexOf(':');
  return colon !== -1 && decoded.slice(colon + 1) === password;
}

export type Level = 'ok' | 'near' | 'over';

// How close a usage is to its cap: the meter's colour and its word.
export function levelOf(used: number, limit: number): Level {
  const share = used / limit;
  if (share >= 0.9) return 'over';
  if (share >= 0.7) return 'near';
  return 'ok';
}

// Linear interpolation between the closest ranks, the same as Postgres percentile_cont.
export function percentile(values: number[], p: number): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const rank = p * (sorted.length - 1);
  const low = Math.floor(rank);
  const high = Math.ceil(rank);
  return sorted[low] + (sorted[high] - sorted[low]) * (rank - low);
}

export type StageSummary = { median: number | null; p90: number | null; max: number | null; count: number };

// One latency stage across many turns. A turn where the stage didn't happen
// (NULL in turn_metrics) is left out, not counted as zero.
export function summarize(values: (number | null)[]): StageSummary {
  const present = values.filter((v): v is number => v !== null);
  return {
    median: percentile(present, 0.5),
    p90: percentile(present, 0.9),
    max: present.length ? Math.max(...present) : null,
    count: present.length,
  };
}

// --- Cost at list prices -------------------------------------------------------
// Lumi runs on free plans, so these are what the same traffic would cost at each
// provider's pay-as-you-go price. USD, checked on PRICES_CHECKED; the table with
// sources is in TECH_STACK.md §15.
export const PRICES_CHECKED = '2026-11-12';

export const PRICES = {
  // Per million tokens. Keys are the model names the agent records (config.py).
  llm: {
    // Groq on-demand, console.groq.com/docs/models.
    'openai/gpt-oss-120b': { input: 0.15, output: 0.6 },
    'openai/gpt-oss-20b': { input: 0.075, output: 0.3 },
    // Google paid tier, ai.google.dev/gemini-api/docs/pricing. Approximate: Google
    // doesn't say which model the "-latest" alias points to, so it is priced as the
    // newest Flash-Lite (gemini-3.5-flash-lite), the dearest of them.
    'gemini-flash-lite-latest': { input: 0.3, output: 2.5 },
  } as Record<string, { input: number; output: number }>,
  // Deepgram pay-as-you-go, deepgram.com/pricing: Nova-3 streaming per minute, and
  // Aura-2 per 1,000 characters.
  sttPerMinute: 0.0077,
  ttsPerThousandChars: 0.03,
  // Tavily pay-as-you-go, tavily.com/pricing. A basic search is one credit.
  searchPerCredit: 0.008,
  // LiveKit Cloud agent session minutes beyond those included (Ship and Scale plans),
  // livekit.com/pricing. The free Build plan has no overage: it just stops.
  agentPerMinute: 0.01,
};

// Sessions aren't recorded (the metrics tables have no session id), so "a
// conversation" is this many spoken replies: an assumption, stated on the page.
export const REPLIES_PER_CONVERSATION = 8;

// One provider_usage sum: one kind and model over the window.
export type UsageSum = {
  kind: 'llm' | 'stt' | 'tts';
  model: string;
  input_tokens: number;
  output_tokens: number;
  audio_seconds: number;
  characters: number;
};

// Dollars for one usage sum, or null when the model has no list price here, so the
// page can name it instead of quietly counting it as free.
export function costOf(usage: UsageSum): number | null {
  if (usage.kind === 'stt') return (usage.audio_seconds / 60) * PRICES.sttPerMinute;
  if (usage.kind === 'tts') return (usage.characters / 1000) * PRICES.ttsPerThousandChars;
  const price = PRICES.llm[usage.model];
  if (!price) return null;
  return (usage.input_tokens * price.input + usage.output_tokens * price.output) / 1_000_000;
}

export type CostSummary = {
  llm: number;
  stt: number;
  tts: number;
  search: number;
  agent: number;
  total: number;
  perReply: number | null;
  perThousandConversations: number | null;
  unpriced: string[];
};

// The whole cost section from the usage sums, the search credits used and the number
// of spoken replies. With no replies, the per-reply figures are null (shown as "—"),
// not a division by zero.
export function costSummary(usage: UsageSum[], searches: number, replies: number): CostSummary {
  const byKind = { llm: 0, stt: 0, tts: 0 };
  const unpriced: string[] = [];
  let audioSeconds = 0;
  for (const row of usage) {
    const cost = costOf(row);
    if (cost === null) unpriced.push(row.model);
    else byKind[row.kind] += cost;
    if (row.kind === 'stt') audioSeconds += row.audio_seconds;
  }
  const search = searches * PRICES.searchPerCredit;
  // Agent minutes aren't recorded either. The agent streams the microphone to
  // Deepgram while it is on, so speech-to-text minutes stand in for them. That is a
  // low estimate: a session that waits before Start has its mic off.
  const agent = (audioSeconds / 60) * PRICES.agentPerMinute;
  const total = byKind.llm + byKind.stt + byKind.tts + search + agent;
  const perReply = replies > 0 ? total / replies : null;
  return {
    ...byKind,
    search,
    agent,
    total,
    perReply,
    perThousandConversations: perReply === null ? null : perReply * REPLIES_PER_CONVERSATION * 1000,
    unpriced,
  };
}

// A reply costs a fraction of a cent, so amounts under a cent keep two significant
// digits instead of rounding to $0.00.
export function dollars(value: number | null): string {
  if (value === null) return '—';
  const small = value > 0 && value < 0.01;
  return value.toLocaleString('en-US', {
    style: 'currency',
    currency: 'USD',
    ...(small ? { maximumSignificantDigits: 2 } : {}),
  });
}
