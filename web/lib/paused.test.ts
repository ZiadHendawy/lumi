// Unit tests for paused mode. Run with `npm test` (Node's built-in runner).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { groupTasks } from './board.ts';
import { demoBoard, voicePaused } from './paused.ts';

test('voice is paused only when the switch is set to 1 or true', () => {
  assert.equal(voicePaused('1'), true);
  assert.equal(voicePaused('true'), true);
  // Unset, empty or anything else keeps voice on, so a missing setting can't take the demo down.
  assert.equal(voicePaused(undefined), false);
  assert.equal(voicePaused(''), false);
  assert.equal(voicePaused('0'), false);
  assert.equal(voicePaused('false'), false);
});

test('the sample board fills every lane but Overdue, on any day', () => {
  // A normal day, a month end and a year end, where the dates roll over.
  for (const now of [new Date(2026, 10, 20, 9), new Date(2026, 10, 30, 23, 30), new Date(2026, 11, 31, 12)]) {
    const { tasks } = demoBoard(now);
    const lanes = groupTasks(tasks, now).map((lane) => lane.key);
    assert.deepEqual(lanes, ['today', 'tomorrow', 'week', 'later', 'someday']);
    assert.equal(tasks.filter((t) => t.done).length, 1);
  }
});

test('the sample board has unique ids and some remembered facts', () => {
  const { tasks, facts } = demoBoard(new Date(2026, 10, 20));
  assert.equal(new Set(tasks.map((t) => t.id)).size, tasks.length);
  assert.ok(Object.keys(facts).length > 0);
});
