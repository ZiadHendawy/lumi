// The board payload the agent sends on the `lumi.board` text stream, plus pure helpers
// for showing it. No React here, so every function can be read (and tested) on its own.

export type Priority = 'high' | 'medium' | 'low';

export type Task = {
  id: number;
  title: string;
  body: string;
  priority: Priority;
  target_date: string | null; // 'YYYY-MM-DD', a calendar day with no time zone
  done: boolean;
  updated_at: string;
};

export type Change = {
  action: 'created' | 'updated' | 'deleted' | 'restored';
  task_id: number;
  title: string;
  fields: string[]; // which fields an 'updated' change touched, e.g. ['priority']
};

// What Lumi remembers about the user, e.g. { favorite_color: 'blue' }.
export type Facts = Record<string, string>;

export type BoardPayload = { tasks: Task[]; facts: Facts; change: Change | null };

// The stream is text from the network, so check its shape before trusting it.
export function parseBoard(text: string): BoardPayload | null {
  try {
    const data = JSON.parse(text);
    if (!Array.isArray(data?.tasks)) return null;
    // An older agent sends no facts; an empty shelf is the honest default.
    const facts = data.facts && typeof data.facts === 'object' && !Array.isArray(data.facts) ? data.facts : {};
    return { tasks: data.tasks, facts, change: data.change ?? null };
  } catch {
    return null;
  }
}

// --- Cache: the last board this browser saw, so a reload isn't blank during the agent's cold start.
// localStorage can throw (private mode, storage full), and a cache miss is harmless, so errors are ignored.

const cacheKey = (userId: string) => `lumi.board.${userId}`;

export function loadCachedBoard(userId: string): BoardPayload | null {
  try {
    const text = localStorage.getItem(cacheKey(userId));
    return text ? parseBoard(text) : null;
  } catch {
    return null;
  }
}

export function saveCachedBoard(userId: string, tasks: Task[], facts: Facts) {
  try {
    // Stored without the change, so a reload doesn't replay the last animation.
    localStorage.setItem(cacheKey(userId), JSON.stringify({ tasks, facts, change: null }));
  } catch {
    // Ignore: the live board still arrives from the agent.
  }
}

// --- Grouping by target date, relative to the user's local today.

export type GroupKey = 'overdue' | 'today' | 'tomorrow' | 'week' | 'later' | 'someday';

export const GROUP_LABELS: Record<GroupKey, string> = {
  overdue: 'Overdue',
  today: 'Today',
  tomorrow: 'Tomorrow',
  week: 'This week',
  later: 'Later',
  someday: 'Someday',
};

const GROUP_ORDER: GroupKey[] = ['overdue', 'today', 'tomorrow', 'week', 'later', 'someday'];
const PRIORITY_RANK: Record<Priority, number> = { high: 0, medium: 1, low: 2 };

// 'YYYY-MM-DD' parsed as local midnight. `new Date('2026-11-14')` would mean UTC midnight,
// which is the previous evening west of Greenwich.
function localDay(date: string): Date {
  const [y, m, d] = date.split('-').map(Number);
  return new Date(y, m - 1, d);
}

export function daysFromToday(date: string, now: Date): number {
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  // Rounded because a day across a daylight-saving switch is 23 or 25 hours long.
  return Math.round((localDay(date).getTime() - today.getTime()) / 86_400_000);
}

export function groupOf(task: Task, now: Date): GroupKey {
  if (!task.target_date) return 'someday';
  const days = daysFromToday(task.target_date, now);
  if (days < 0) return 'overdue';
  if (days === 0) return 'today';
  if (days === 1) return 'tomorrow';
  if (days < 7) return 'week';
  return 'later';
}

// Brightest first inside a lane, then soonest, then oldest. A priority change visibly moves the card.
function compareTasks(a: Task, b: Task): number {
  return (
    PRIORITY_RANK[a.priority] - PRIORITY_RANK[b.priority] ||
    (a.target_date ?? '9999').localeCompare(b.target_date ?? '9999') ||
    a.id - b.id
  );
}

// Open tasks split into lanes; empty lanes are left out so the board stays small.
export function groupTasks(tasks: Task[], now: Date): { key: GroupKey; tasks: Task[] }[] {
  const open = tasks.filter((t) => !t.done).sort(compareTasks);
  return GROUP_ORDER.map((key) => ({ key, tasks: open.filter((t) => groupOf(t, now) === key) })).filter(
    (group) => group.tasks.length > 0,
  );
}

// en-GB gives the day before the month: "Fri 14 Nov". Some browsers add a comma after the
// weekday, so it is stripped to look the same everywhere.
const dayFormat = new Intl.DateTimeFormat('en-GB', { weekday: 'short', day: 'numeric', month: 'short' });

export function friendlyDate(date: string): string {
  return dayFormat.format(localDay(date)).replace(',', '');
}

// --- One sentence per change, used for the on-screen receipt and the screen-reader announcement.

const FIELD_NAMES: Record<string, string> = {
  title: 'title',
  body: 'notes',
  priority: 'priority',
  target_date: 'date',
  done: 'status',
};

function listOf(words: string[]): string {
  if (words.length <= 1) return words.join('');
  return `${words.slice(0, -1).join(', ')} and ${words[words.length - 1]}`;
}

export function describeChange(change: Change, task: Task | undefined): string {
  const name = `“${change.title}”`;
  switch (change.action) {
    case 'created':
      return `Added ${name}`;
    case 'deleted':
      return `Deleted ${name} — say “undo” to bring it back`;
    case 'restored':
      return `Brought back ${name}`;
    case 'updated':
      if (change.fields.length === 1 && change.fields[0] === 'done') {
        return task?.done ? `Marked ${name} done` : `Reopened ${name}`;
      }
      return `Changed the ${listOf(change.fields.map((f) => FIELD_NAMES[f] ?? f))} of ${name}`;
  }
}

// --- Recent changes: each one keeps its card animation and its receipt until they have played out.

// One request can make several changes ~0.6 s apart ("add eggs and bread" is two board pushes),
// so the screen keeps a list of recent changes, not only the last one. Otherwise the second push
// cuts the first card's glow and receipt short. Each entry is dropped when its receipt fades.
export type RecentChange = {
  seq: number; // the board push that carried it: unique, so it doubles as a React key
  change: Change;
  text: string; // the receipt, worded on arrival so a later change to the task can't make it untrue
  onCard: boolean; // false once a newer change to the same task takes over that card's animation
  ghost: Task | null; // a deleted task's last copy, drawn until it has drifted away
};

// `before` and `after` are the boards either side of the push that carried `change`.
export function addChange(
  recent: RecentChange[],
  seq: number,
  change: Change,
  before: Task[],
  after: Task[],
): RecentChange[] {
  // A newer change to the same task restarts its card's animation (and a restore ends a
  // delete's ghost), but the older receipt stays up for its full time.
  const older = recent.map((r) => (r.change.task_id === change.task_id ? { ...r, onCard: false, ghost: null } : r));
  // A deleted task is no longer in `after`; keep its last copy so it can animate out.
  const ghost = change.action === 'deleted' ? (before.find((t) => t.id === change.task_id) ?? null) : null;
  const text = describeChange(change, after.find((t) => t.id === change.task_id));
  return [...older, { seq, change, text, onCard: true, ghost }];
}

// The change a card is animating, if any.
export function cardChange(recent: RecentChange[], taskId: number): RecentChange | undefined {
  return recent.find((r) => r.onCard && r.change.task_id === taskId);
}

// The board's tasks plus the deleted ones that are still drifting away.
export function withGhosts(tasks: Task[], recent: RecentChange[]): Task[] {
  return [...tasks, ...recent.flatMap((r) => (r.ghost ? [r.ghost] : []))];
}

// --- Memory shelf: the facts Lumi keeps, shown beside the board.

// "favorite_color" -> "favorite color": keys are stored in snake case (tools.fact_key).
export function factLabel(key: string): string {
  return key.replaceAll('_', ' ');
}

// The keys that are new or hold a new value, so only those chips light up.
export function changedFacts(before: Facts, after: Facts): string[] {
  return Object.keys(after).filter((key) => before[key] !== after[key]);
}

// One sentence per fact that changed, for screen readers (the chip itself is the visual).
export function describeFactChanges(before: Facts, after: Facts): string[] {
  const remembered = changedFacts(before, after).map((key) => `Remembered your ${factLabel(key)}: ${after[key]}`);
  const forgot = Object.keys(before)
    .filter((key) => !(key in after))
    .map((key) => `Forgot your ${factLabel(key)}`);
  return [...remembered, ...forgot];
}

// --- Captions: what the user said in their latest turn.

// The fields of a LiveKit session message that the caption needs. Chat messages have no `type`.
type TranscriptMessage = { id: string; type?: string; message: string };

// Deepgram can end one spoken turn in several final segments ("Add a task to call the bank
// tomorrow." + "High priority."), so the caption is the whole run of user segments since Lumi
// last spoke, not only the newest one. While Lumi answers, it still shows the turn being answered.
// The id is the run's first segment, so the caption fades in once per turn, not once per segment.
export function userCaption(messages: TranscriptMessage[]): { id: string; text: string } | null {
  const last = messages.findLastIndex((m) => m.type === 'userTranscript');
  if (last === -1) return null;
  let first = last;
  while (first > 0 && messages[first - 1].type !== 'agentTranscript') first--;
  const segments = messages.slice(first, last + 1).filter((m) => m.type === 'userTranscript');
  const text = segments
    .map((m) => m.message.trim())
    .filter((words) => words !== '')
    .join(' ');
  return { id: segments[0].id, text };
}
