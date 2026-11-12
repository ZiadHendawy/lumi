// Unit tests for the pure board helpers. Run with `npm test` (Node's built-in runner;
// Node 24 runs TypeScript directly by stripping the types, so no test dependency is needed).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  type Change,
  type Task,
  addChange,
  cardChange,
  changedFacts,
  describeFactChanges,
  factLabel,
  daysFromToday,
  describeChange,
  friendlyDate,
  groupOf,
  groupTasks,
  parseBoard,
  userCaption,
  withGhosts,
} from './board.ts';

// A fixed "now": Thursday 12 November 2026, mid-afternoon local time.
const NOW = new Date(2026, 10, 12, 15, 30);

function task(id: number, overrides: Partial<Task> = {}): Task {
  return {
    id,
    title: `Task ${id}`,
    body: '',
    priority: 'medium',
    target_date: null,
    done: false,
    updated_at: '2026-11-12T10:00:00Z',
    ...overrides,
  };
}

test('parseBoard accepts a board and defaults a missing change to null', () => {
  const board = parseBoard(JSON.stringify({ tasks: [task(1)] }));
  assert.deepEqual(board, { tasks: [task(1)], facts: {}, change: null });
});

test('parseBoard keeps the facts, and ignores facts of the wrong shape', () => {
  const facts = { favorite_color: 'blue' };
  assert.deepEqual(parseBoard(JSON.stringify({ tasks: [], facts }))?.facts, facts);
  assert.deepEqual(parseBoard(JSON.stringify({ tasks: [], facts: ['blue'] }))?.facts, {});
});

test('parseBoard keeps the change', () => {
  const change = { action: 'deleted', task_id: 1, title: 'Task 1', fields: [] };
  assert.deepEqual(parseBoard(JSON.stringify({ tasks: [], change }))?.change, change);
});

test('parseBoard rejects broken JSON and the wrong shape instead of throwing', () => {
  assert.equal(parseBoard('{not json'), null);
  assert.equal(parseBoard('null'), null);
  assert.equal(parseBoard(JSON.stringify({ tasks: 'nope' })), null);
});

test('daysFromToday counts calendar days in local time, ignoring the time of day', () => {
  assert.equal(daysFromToday('2026-11-12', NOW), 0);
  assert.equal(daysFromToday('2026-11-13', NOW), 1);
  assert.equal(daysFromToday('2026-11-11', NOW), -1);
  assert.equal(daysFromToday('2026-12-12', NOW), 30);
  // Just before midnight is still today.
  assert.equal(daysFromToday('2026-11-12', new Date(2026, 10, 12, 23, 59)), 0);
});

test('daysFromToday is not thrown off by a daylight-saving switch', () => {
  const original = process.env.TZ;
  process.env.TZ = 'America/New_York'; // clocks go forward on 8 March 2026: that day is 23 hours long
  try {
    assert.equal(daysFromToday('2026-03-09', new Date(2026, 2, 7, 12)), 2);
  } finally {
    process.env.TZ = original;
  }
});

test('groupOf puts each date in the right lane', () => {
  const lane = (target_date: string | null) => groupOf(task(1, { target_date }), NOW);
  assert.equal(lane('2026-11-10'), 'overdue');
  assert.equal(lane('2026-11-12'), 'today');
  assert.equal(lane('2026-11-13'), 'tomorrow');
  assert.equal(lane('2026-11-14'), 'week');
  assert.equal(lane('2026-11-18'), 'week'); // 6 days away
  assert.equal(lane('2026-11-19'), 'later'); // 7 days away
  assert.equal(lane(null), 'someday');
});

test('groupTasks leaves out done tasks and empty lanes, in board order', () => {
  const groups = groupTasks(
    [
      task(1, { target_date: null }),
      task(2, { target_date: '2026-11-12' }),
      task(3, { target_date: '2026-11-01' }),
      task(4, { target_date: '2026-11-12', done: true }),
    ],
    NOW,
  );
  assert.deepEqual(
    groups.map((g) => [g.key, g.tasks.map((t) => t.id)]),
    [
      ['overdue', [3]],
      ['today', [2]],
      ['someday', [1]],
    ],
  );
});

test('groupTasks orders a lane by priority, then date, then id', () => {
  const [lane] = groupTasks(
    [
      task(1, { priority: 'low', target_date: '2026-11-14' }),
      task(2, { priority: 'medium', target_date: '2026-11-16' }),
      task(3, { priority: 'high', target_date: '2026-11-17' }),
      task(4, { priority: 'medium', target_date: '2026-11-15' }),
      task(5, { priority: 'medium', target_date: '2026-11-15' }),
    ],
    NOW,
  );
  assert.equal(lane.key, 'week');
  assert.deepEqual(
    lane.tasks.map((t) => t.id),
    [3, 4, 5, 2, 1],
  );
});

test('friendlyDate reads like "Sat 14 Nov"', () => {
  assert.equal(friendlyDate('2026-11-14'), 'Sat 14 Nov');
  assert.equal(friendlyDate('2027-01-01'), 'Fri 1 Jan');
});

test('describeChange says what happened in plain words', () => {
  const change = (action: 'created' | 'updated' | 'deleted' | 'restored', fields: string[] = []) => ({
    action,
    task_id: 1,
    title: 'Call mom',
    fields,
  });
  assert.equal(describeChange(change('created'), task(1)), 'Added “Call mom”');
  assert.equal(describeChange(change('deleted'), undefined), 'Deleted “Call mom” — say “undo” to bring it back');
  assert.equal(describeChange(change('restored'), task(1)), 'Brought back “Call mom”');
  assert.equal(
    describeChange(change('updated', ['priority', 'target_date']), task(1)),
    'Changed the priority and date of “Call mom”',
  );
  assert.equal(describeChange(change('updated', ['done']), task(1, { done: true })), 'Marked “Call mom” done');
  assert.equal(describeChange(change('updated', ['done']), task(1, { done: false })), 'Reopened “Call mom”');
});

// Shaped like the messages useSessionMessages returns.
const said = (id: string, message: string) => ({ id, type: 'userTranscript', message });
const replied = (id: string, message: string) => ({ id, type: 'agentTranscript', message });

test('userCaption joins a turn that the speech-to-text split into several segments', () => {
  // Seen in an end-to-end run: only "High priority." was shown.
  const messages = [said('u1', 'Add a task to call the bank tomorrow.'), said('u2', 'High priority.')];
  assert.deepEqual(userCaption(messages), {
    id: 'u1',
    text: 'Add a task to call the bank tomorrow. High priority.',
  });
});

test('userCaption starts after the last thing Lumi said', () => {
  const messages = [said('u1', 'Add milk.'), replied('a1', 'Added milk.'), said('u2', 'Make it'), said('u3', ' high. ')];
  assert.deepEqual(userCaption(messages), { id: 'u2', text: 'Make it high.' });
});

test('userCaption keeps showing the turn Lumi is answering', () => {
  const messages = [said('u1', 'Add milk.'), said('u2', 'And eggs.'), replied('a1', 'Done.')];
  assert.deepEqual(userCaption(messages), { id: 'u1', text: 'Add milk. And eggs.' });
});

test('userCaption skips empty segments and chat messages, and is null before the user speaks', () => {
  assert.equal(userCaption([]), null);
  assert.equal(userCaption([replied('a1', 'Hi, I am Lumi.')]), null);
  const chat = { id: 'c1', message: 'typed text' }; // a chat message has no transcript type
  assert.deepEqual(userCaption([said('u1', 'Hello.'), chat, said('u2', '  ')]), { id: 'u1', text: 'Hello.' });
});

const changeOf = (action: Change['action'], task_id: number, title: string, fields: string[] = []): Change => ({
  action,
  task_id,
  title,
  fields,
});

test('addChange keeps an earlier change animating when another task changes right after', () => {
  // Seen in an end-to-end run: "add eggs and bread" sent two boards 0.6 s apart, and the
  // second one cut "Buy eggs"'s glow and receipt short.
  const eggs = task(1, { title: 'Buy eggs' });
  const bread = task(2, { title: 'Buy bread' });
  let recent = addChange([], 1, changeOf('created', 1, 'Buy eggs'), [], [eggs]);
  recent = addChange(recent, 2, changeOf('created', 2, 'Buy bread'), [eggs], [eggs, bread]);
  assert.deepEqual(
    recent.map((r) => r.text),
    ['Added “Buy eggs”', 'Added “Buy bread”'],
  );
  assert.equal(cardChange(recent, 1)?.seq, 1);
  assert.equal(cardChange(recent, 2)?.seq, 2);
  assert.equal(cardChange(recent, 3), undefined);
});

test('addChange lets a newer change to the same task take over its card, but keeps both receipts', () => {
  const added = task(1, { title: 'Buy eggs' });
  const raised = task(1, { title: 'Buy eggs', priority: 'high' });
  let recent = addChange([], 1, changeOf('created', 1, 'Buy eggs'), [], [added]);
  recent = addChange(recent, 2, changeOf('updated', 1, 'Buy eggs', ['priority']), [added], [raised]);
  assert.equal(cardChange(recent, 1)?.change.action, 'updated');
  assert.deepEqual(
    recent.map((r) => r.text),
    ['Added “Buy eggs”', 'Changed the priority of “Buy eggs”'],
  );
});

test('addChange words each receipt when it arrives', () => {
  const open = task(1, { title: 'Call mom' });
  const done = task(1, { title: 'Call mom', done: true });
  let recent = addChange([], 1, changeOf('updated', 1, 'Call mom', ['done']), [open], [done]);
  recent = addChange(recent, 2, changeOf('updated', 1, 'Call mom', ['done']), [done], [open]);
  assert.deepEqual(
    recent.map((r) => r.text),
    ['Marked “Call mom” done', 'Reopened “Call mom”'],
  );
});

test('withGhosts keeps every deleted task on the board until it has drifted away', () => {
  const eggs = task(1, { title: 'Buy eggs' });
  const bread = task(2, { title: 'Buy bread' });
  const milk = task(3, { title: 'Buy milk' });
  let recent = addChange([], 1, changeOf('deleted', 1, 'Buy eggs'), [eggs, bread, milk], [bread, milk]);
  recent = addChange(recent, 2, changeOf('deleted', 2, 'Buy bread'), [bread, milk], [milk]);
  assert.deepEqual(
    withGhosts([milk], recent).map((t) => t.id),
    [3, 1, 2],
  );
  assert.equal(cardChange(recent, 1)?.change.action, 'deleted');
});

test('a restore ends the ghost of the delete it undoes', () => {
  const eggs = task(1, { title: 'Buy eggs' });
  let recent = addChange([], 1, changeOf('deleted', 1, 'Buy eggs'), [eggs], []);
  recent = addChange(recent, 2, changeOf('restored', 1, 'Buy eggs'), [], [eggs]);
  assert.deepEqual(
    withGhosts([eggs], recent).map((t) => t.id),
    [1],
  );
  assert.equal(cardChange(recent, 1)?.change.action, 'restored');
  // The "say undo" receipt still fades out on its own time.
  assert.equal(recent.length, 2);
});

test('changedFacts lists new and changed facts, not the unchanged ones', () => {
  const before = { favorite_color: 'blue', home_city: 'Riyadh' };
  const after = { favorite_color: 'green', home_city: 'Riyadh', pet: 'cat' };
  assert.deepEqual(changedFacts(before, after), ['favorite_color', 'pet']);
  assert.deepEqual(changedFacts(after, after), []);
});

test('describeFactChanges words what was remembered and forgotten', () => {
  assert.equal(factLabel('favorite_color'), 'favorite color');
  assert.deepEqual(describeFactChanges({ home_city: 'Riyadh' }, { favorite_color: 'blue' }), [
    'Remembered your favorite color: blue',
    'Forgot your home city',
  ]);
});
