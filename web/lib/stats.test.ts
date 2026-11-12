// Unit tests for the /stats helpers. Run with `npm test`.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isAuthorized, levelOf, percentile, summarize } from './stats.ts';

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
