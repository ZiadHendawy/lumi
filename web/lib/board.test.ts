// Unit tests for the pure board helpers. Run with `npm test` (Node's built-in runner;
// Node 24 runs TypeScript directly by stripping the types, so no test dependency is needed).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { type Task, daysFromToday, describeChange, friendlyDate, groupOf, groupTasks, parseBoard } from './board.ts';

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
  assert.deepEqual(board, { tasks: [task(1)], change: null });
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
