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

export type BoardPayload = { tasks: Task[]; change: Change | null };

// The stream is text from the network, so check its shape before trusting it.
export function parseBoard(text: string): BoardPayload | null {
  try {
    const data = JSON.parse(text);
    if (!Array.isArray(data?.tasks)) return null;
    return { tasks: data.tasks, change: data.change ?? null };
  } catch {
    return null;
  }
}

// --- Cache: the last board this browser saw, so a reload isn't blank during the agent's cold start.
// localStorage can throw (private mode, storage full), and a cache miss is harmless, so errors are ignored.

const cacheKey = (userId: string) => `lumi.board.${userId}`;

export function loadCachedTasks(userId: string): Task[] | null {
  try {
    const text = localStorage.getItem(cacheKey(userId));
    return text ? parseBoard(text)?.tasks ?? null : null;
  } catch {
    return null;
  }
}

export function saveCachedTasks(userId: string, tasks: Task[]) {
  try {
    // Stored without the change, so a reload doesn't replay the last animation.
    localStorage.setItem(cacheKey(userId), JSON.stringify({ tasks, change: null }));
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
