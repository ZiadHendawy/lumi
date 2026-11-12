// Unit tests for the turn timings helpers (X-ray panel, session receipt). Run with `npm test`.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  EMPTY_TALLY,
  type Turn,
  addToTally,
  median,
  parseTurn,
  seconds,
  sessionSummary,
  shortModel,
  tallyLines,
  tallyTotal,
} from './turns.ts';
import type { Change, Task } from './board.ts';

function turn(e2e: number, model: string | null = 'openai/gpt-oss-120b'): Turn {
  return {
    e2e_latency: e2e,
    end_of_turn_delay: null,
    transcription_delay: null,
    llm_ttft: null,
    tool_seconds: null,
    tts_ttfb: null,
    board_lead: null,
    model,
  };
}

test('parseTurn keeps the stages that happened and nulls the rest', () => {
  const text = JSON.stringify({ e2e_latency: 0.9, llm_ttft: 0.4, tool_seconds: 'x', model: 'openai/gpt-oss-20b' });
  assert.deepEqual(parseTurn(text), { ...turn(0.9, 'openai/gpt-oss-20b'), llm_ttft: 0.4 });
});

test('parseTurn rejects a row without the whole-reply time, and broken JSON', () => {
  assert.equal(parseTurn(JSON.stringify({ llm_ttft: 0.4 })), null);
  assert.equal(parseTurn('{nope'), null);
});

test('median handles odd, even and empty lists', () => {
  assert.equal(median([3, 1, 2]), 2);
  assert.equal(median([4, 1, 3, 2]), 2.5);
  assert.equal(median([]), null);
});

test('seconds shows two decimals, or a dash for a stage that did not happen', () => {
  assert.equal(seconds(0.8456), '0.85 s');
  assert.equal(seconds(null), '—');
});

test('sessionSummary counts replies and lists each model once, first one first', () => {
  const turns = [turn(1.0), turn(3.0, 'openai/gpt-oss-20b'), turn(2.0), turn(0.5, null)];
  assert.deepEqual(sessionSummary(turns, [1.2, 2.0], 3, 1), {
    replies: 4,
    medianReply: 1.5,
    changes: 3,
    undos: 1,
    medianLead: 1.6,
    models: ['openai/gpt-oss-120b', 'openai/gpt-oss-20b'],
  });
  assert.equal(sessionSummary([], [], 0, 0).medianReply, null);
});

test('shortModel drops the provider prefix', () => {
  assert.equal(shortModel('openai/gpt-oss-120b'), 'gpt-oss-120b');
  assert.equal(shortModel('gemini-flash-lite-latest'), 'gemini-flash-lite-latest');
});

const task = (id: number, done = false): Task => ({ id, title: `Task ${id}`, body: '', priority: 'medium', target_date: null, done, updated_at: '' });
const change = (action: Change['action'], fields: string[] = []): Change => ({ action, task_id: 1, title: 'Task 1', fields });

test('addToTally counts each push in the user\'s terms', () => {
  let t = addToTally(EMPTY_TALLY, change('created'), [task(1)], {}, {});
  t = addToTally(t, change('updated', ['done']), [task(1, true)], {}, {});
  t = addToTally(t, change('updated', ['done']), [task(1, false)], {}, {}); // reopened: a change, not a done
  t = addToTally(t, change('updated', ['priority']), [task(1)], {}, {});
  t = addToTally(t, change('deleted'), [], {}, {});
  t = addToTally(t, change('restored'), [task(1)], {}, {});
  t = addToTally(t, null, [task(1)], { city: 'Riyadh', color: 'red' }, { color: 'blue', pet: 'cat' });
  assert.deepEqual(t, { added: 1, done: 1, edited: 2, deleted: 1, restored: 1, remembered: 2, forgot: 1 });
  assert.equal(tallyTotal(t), 9);
});

test('tallyLines names only what happened, singular or plural', () => {
  assert.deepEqual(tallyLines(EMPTY_TALLY), []);
  assert.deepEqual(tallyLines({ ...EMPTY_TALLY, added: 3, done: 1, remembered: 1 }), [
    '3 tasks added',
    '1 done',
    '1 new thing remembered',
  ]);
});
