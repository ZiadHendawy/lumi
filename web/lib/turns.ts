// This session in numbers. Where the time went in each spoken reply (the `lumi.turn` stream),
// for the X-ray panel; and what the user got done, in their own words, for the card shown when
// a session ends. Pure functions, tested in turns.test.ts.
import type { Change, Facts, Task } from './board';

// One reply's stages in seconds, as the agent measured them (agent.py `log_turn_latency`,
// the same row it saves to turn_metrics). A stage that didn't happen is null.
export type Turn = {
  e2e_latency: number; // the user stopped talking -> Lumi's first audio
  end_of_turn_delay: number | null;
  transcription_delay: number | null;
  llm_ttft: number | null;
  tool_seconds: number | null;
  tts_ttfb: number | null;
  board_lead: number | null;
  model: string | null; // which model in the fallback chain answered
};

// A number from the network, or null for anything else (a missing stage is null).
const num = (value: unknown) => (typeof value === 'number' ? value : null);

export function parseTurn(text: string): Turn | null {
  try {
    const data = JSON.parse(text);
    if (typeof data?.e2e_latency !== 'number') return null;
    return {
      e2e_latency: data.e2e_latency,
      end_of_turn_delay: num(data.end_of_turn_delay),
      transcription_delay: num(data.transcription_delay),
      llm_ttft: num(data.llm_ttft),
      tool_seconds: num(data.tool_seconds),
      tts_ttfb: num(data.tts_ttfb),
      board_lead: num(data.board_lead),
      model: typeof data.model === 'string' ? data.model : null,
    };
  } catch {
    return null;
  }
}

// The stages in the order they happen. They are each measured on their own and some
// overlap (the model starts on the transcript before the turn detector commits), so the
// panel draws each against the whole reply instead of stacking them.
export const STAGES: { key: 'end_of_turn_delay' | 'transcription_delay' | 'llm_ttft' | 'tool_seconds' | 'tts_ttfb'; label: string }[] = [
  { key: 'end_of_turn_delay', label: 'Deciding you’d finished' },
  { key: 'transcription_delay', label: 'Final transcript' },
  { key: 'llm_ttft', label: 'Model’s first word' },
  { key: 'tool_seconds', label: 'Tools (database, search)' },
  { key: 'tts_ttfb', label: 'Voice’s first audio' },
];

export function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

// "openai/gpt-oss-120b" -> "gpt-oss-120b": the provider prefix is noise on screen.
export function shortModel(model: string): string {
  return model.split('/').pop() ?? model;
}

export function seconds(value: number | null): string {
  return value === null ? '—' : `${value.toFixed(2)} s`;
}

export type SessionSummary = {
  replies: number;
  medianReply: number | null; // seconds from the user stopping to Lumi's voice
  changes: number; // board and memory changes
  undos: number;
  medianLead: number | null; // how far the board led the voice, measured in this browser
  models: string[]; // every model that answered, first one first
};

// `leads` are this browser's own measurements: a changed board arriving -> Lumi starting to speak.
export function sessionSummary(turns: Turn[], leads: number[], changes: number, undos: number): SessionSummary {
  const models: string[] = [];
  for (const t of turns) if (t.model && !models.includes(t.model)) models.push(t.model);
  return {
    replies: turns.length,
    medianReply: median(turns.map((t) => t.e2e_latency)),
    changes,
    undos,
    medianLead: median(leads),
    models,
  };
}

// --- What the user got done this session, for the card shown when it ends. Counted in the
// user's terms (added, done, remembered), not the engineering ones: timings and models are for
// the X-ray panel, which only opens on request.

export type Tally = {
  added: number;
  done: number;
  edited: number;
  deleted: number;
  restored: number;
  remembered: number; // facts that are new or hold a new value
  forgot: number;
};

export const EMPTY_TALLY: Tally = { added: 0, done: 0, edited: 0, deleted: 0, restored: 0, remembered: 0, forgot: 0 };

// One board push: the task change it carried (if any) and the facts either side of it.
// `after` is the board the push brought, to tell "marked done" from "reopened".
export function addToTally(tally: Tally, change: Change | null, after: Task[], factsBefore: Facts, factsAfter: Facts): Tally {
  const next = { ...tally };
  if (change?.action === 'created') next.added++;
  else if (change?.action === 'deleted') next.deleted++;
  else if (change?.action === 'restored') next.restored++;
  else if (change?.action === 'updated') {
    const task = after.find((t) => t.id === change.task_id);
    if (change.fields.includes('done') && task?.done) next.done++;
    else next.edited++;
  }
  next.remembered += Object.keys(factsAfter).filter((key) => factsBefore[key] !== factsAfter[key]).length;
  next.forgot += Object.keys(factsBefore).filter((key) => !(key in factsAfter)).length;
  return next;
}

// "3 tasks added", "1 done", ... Only what happened, in the order a user thinks of it.
export function tallyLines(tally: Tally): string[] {
  const lines: [number, string, string][] = [
    [tally.added, 'task added', 'tasks added'],
    [tally.done, 'done', 'done'],
    [tally.edited, 'task changed', 'tasks changed'],
    [tally.deleted, 'deleted', 'deleted'],
    [tally.restored, 'brought back', 'brought back'],
    [tally.remembered, 'new thing remembered', 'new things remembered'],
    [tally.forgot, 'thing forgotten', 'things forgotten'],
  ];
  return lines.filter(([n]) => n > 0).map(([n, one, many]) => `${n} ${n === 1 ? one : many}`);
}

// Every change in the tally, for the X-ray panel's engineering line ("each read back from the database").
export function tallyTotal(tally: Tally): number {
  return Object.values(tally).reduce((sum, n) => sum + n, 0);
}
