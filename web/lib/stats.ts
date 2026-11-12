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
