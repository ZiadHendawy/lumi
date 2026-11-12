// Where the time went in each spoken reply (the `lumi.turn` stream), and the numbers the
// X-ray panel and the end-of-session receipt show. Pure functions, tested in turns.test.ts.

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
