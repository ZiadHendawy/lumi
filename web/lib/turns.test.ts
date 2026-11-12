// Unit tests for the turn timings helpers (X-ray panel, session receipt). Run with `npm test`.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { type Turn, median, parseTurn, seconds, sessionSummary, shortModel } from './turns.ts';

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
