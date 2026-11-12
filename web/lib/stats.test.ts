// Unit tests for the /stats helpers. Run with `npm test`.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  PRICES,
  REPLIES_PER_CONVERSATION,
  type UsageSum,
  costOf,
  costSummary,
  dollars,
  isAuthorized,
  levelOf,
  percentile,
  summarize,
} from './stats.ts';

const basic = (userAndPassword: string) => `Basic ${btoa(userAndPassword)}`;

test('the stats password is checked, the user name is not', () => {
  assert.equal(isAuthorized(basic('anyone:admin'), 'admin'), true);
  assert.equal(isAuthorized(basic(':admin'), 'admin'), true);
  assert.equal(isAuthorized(basic('anyone:wrong'), 'admin'), false);
  assert.equal(isAuthorized(basic('admin'), 'admin'), false); // no colon: no password sent
});

test('a password with a colon in it still works', () => {
  assert.equal(isAuthorized(basic('me:a:b'), 'a:b'), true);
});

test('no header, a non-Basic header or bad base64 is refused', () => {
  assert.equal(isAuthorized(null, 'admin'), false);
  assert.equal(isAuthorized('Bearer admin', 'admin'), false);
  assert.equal(isAuthorized('Basic !!!', 'admin'), false);
});

test('with no password configured, nobody gets in', () => {
  assert.equal(isAuthorized(basic('anyone:'), ''), false);
  assert.equal(isAuthorized(basic('anyone:admin'), undefined), false);
});

test('levels: under 70% is ok, from 70% near, from 90% over', () => {
  assert.equal(levelOf(0, 100), 'ok');
  assert.equal(levelOf(69, 100), 'ok');
  assert.equal(levelOf(70, 100), 'near');
  assert.equal(levelOf(90, 100), 'over');
  assert.equal(levelOf(150, 100), 'over');
});

test('percentile interpolates like Postgres percentile_cont', () => {
  assert.equal(percentile([], 0.5), null);
  assert.equal(percentile([2], 0.9), 2);
  assert.equal(percentile([4, 1, 3, 2], 0.5), 2.5); // sorted first
  assert.ok(Math.abs(percentile([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 0.9)! - 9.1) < 1e-9);
});

test('a stage that did not happen is left out, not counted as zero', () => {
  assert.deepEqual(summarize([null, 1, null, 3]), { median: 2, p90: 2.8, max: 3, count: 2 });
  assert.deepEqual(summarize([null, null]), { median: null, p90: null, max: null, count: 0 });
});

const usage = (row: Partial<UsageSum> & Pick<UsageSum, 'kind' | 'model'>): UsageSum => ({
  input_tokens: 0,
  output_tokens: 0,
  audio_seconds: 0,
  characters: 0,
  ...row,
});
const close = (actual: number | null, expected: number) => assert.ok(Math.abs(actual! - expected) < 1e-12);

test('an LLM costs its input and output prices per million tokens', () => {
  // 120b: $0.15 in, $0.60 out per million.
  close(costOf(usage({ kind: 'llm', model: 'openai/gpt-oss-120b', input_tokens: 2_000_000, output_tokens: 500_000 })), 0.6);
});

test('speech-to-text costs per minute and the voice per 1,000 characters', () => {
  close(costOf(usage({ kind: 'stt', model: 'nova-3', audio_seconds: 120 })), 2 * PRICES.sttPerMinute);
  close(costOf(usage({ kind: 'tts', model: 'aura-2-andromeda-en', characters: 3000 })), 3 * PRICES.ttsPerThousandChars);
});

test('a model with no list price is named, not counted as free', () => {
  assert.equal(costOf(usage({ kind: 'llm', model: 'qwen/qwen3.8-27b', input_tokens: 1000 })), null);
  const summary = costSummary([usage({ kind: 'llm', model: 'qwen/qwen3.8-27b', input_tokens: 1000 })], 0, 1);
  assert.deepEqual(summary.unpriced, ['qwen/qwen3.8-27b']);
  assert.equal(summary.total, 0);
});

test('the summary adds every provider, and divides by the replies', () => {
  const summary = costSummary(
    [
      usage({ kind: 'llm', model: 'openai/gpt-oss-20b', input_tokens: 1_000_000, output_tokens: 1_000_000 }), // $0.375
      usage({ kind: 'stt', model: 'nova-3', audio_seconds: 600 }), // 10 min
      usage({ kind: 'tts', model: 'aura-2-andromeda-en', characters: 10_000 }),
    ],
    5,
    10,
  );
  close(summary.llm, 0.375);
  close(summary.stt, 10 * PRICES.sttPerMinute);
  close(summary.tts, 10 * PRICES.ttsPerThousandChars);
  close(summary.search, 5 * PRICES.searchPerCredit);
  close(summary.agent, 10 * PRICES.agentPerMinute); // agent minutes = speech-to-text minutes
  close(summary.total, summary.llm + summary.stt + summary.tts + summary.search + summary.agent);
  close(summary.perReply, summary.total / 10);
  close(summary.perThousandConversations, (summary.total / 10) * REPLIES_PER_CONVERSATION * 1000);
});

test('with no replies the per-reply figures are blank, not a division by zero', () => {
  const summary = costSummary([], 0, 0);
  assert.equal(summary.total, 0);
  assert.equal(summary.perReply, null);
  assert.equal(summary.perThousandConversations, null);
  assert.equal(dollars(summary.perReply), '—');
});

test('dollars: cents for normal amounts, two significant digits under a cent', () => {
  assert.equal(dollars(0), '$0.00');
  assert.equal(dollars(12.345), '$12.35');
  assert.equal(dollars(1234.5), '$1,234.50');
  assert.equal(dollars(0.00041234), '$0.00041');
  assert.equal(dollars(null), '—');
});
