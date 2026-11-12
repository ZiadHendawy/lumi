// Unit tests for the calendar export helpers. Run with `npm test` (Node's built-in runner).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Task } from './board.ts';
import { boardToIcs, calendarTasks, googleCalendarUrl } from './calendar.ts';

// A fixed "now" for DTSTAMP: 12 November 2026, 15:30:00 UTC.
const NOW = new Date(Date.UTC(2026, 10, 12, 15, 30, 0));

function task(id: number, overrides: Partial<Task> = {}): Task {
  return {
    id,
    title: `Task ${id}`,
    body: '',
    priority: 'medium',
    target_date: '2026-11-14',
    done: false,
    updated_at: '2026-11-12T10:00:00Z',
    ...overrides,
  };
}

function params(url: string | null): URLSearchParams {
  assert.ok(url);
  const parsed = new URL(url);
  assert.equal(parsed.origin + parsed.pathname, 'https://calendar.google.com/calendar/render');
  return parsed.searchParams;
}

// --- Google Calendar link

test('googleCalendarUrl makes a one-day all-day event that ends on the next day', () => {
  const p = params(googleCalendarUrl(task(1, { title: 'Call the bank', target_date: '2026-11-14' })));
  assert.equal(p.get('action'), 'TEMPLATE');
  assert.equal(p.get('text'), 'Call the bank');
  assert.equal(p.get('dates'), '20261114/20261115');
});

test('googleCalendarUrl rolls the end date over a month end, a year end and 29 February', () => {
  assert.equal(params(googleCalendarUrl(task(1, { target_date: '2026-11-30' }))).get('dates'), '20261130/20261201');
  assert.equal(params(googleCalendarUrl(task(1, { target_date: '2026-12-31' }))).get('dates'), '20261231/20270101');
  assert.equal(params(googleCalendarUrl(task(1, { target_date: '2028-02-28' }))).get('dates'), '20280228/20280229');
  assert.equal(params(googleCalendarUrl(task(1, { target_date: '2028-02-29' }))).get('dates'), '20280229/20280301');
});

test('googleCalendarUrl encodes the title and notes so "&", "#" and line breaks survive', () => {
  const url = googleCalendarUrl(
    task(1, { title: 'Milk & eggs #2', body: 'Ask about the trip?\nhttps://example.com/a?b=c', priority: 'high' }),
  );
  assert.ok(url && !url.includes(' ') && !url.includes('\n'), 'no raw spaces or newlines in the link');
  const p = params(url);
  assert.equal(p.get('text'), 'Milk & eggs #2');
  assert.equal(p.get('details'), 'High priority, from Lumi.\n\nAsk about the trip?\nhttps://example.com/a?b=c');
});

test('googleCalendarUrl gives a task with no notes just its priority line', () => {
  assert.equal(params(googleCalendarUrl(task(1, { priority: 'low' }))).get('details'), 'Low priority, from Lumi.');
});

test('googleCalendarUrl returns null for a task with no date', () => {
  assert.equal(googleCalendarUrl(task(1, { target_date: null })), null);
});

// --- .ics file

test('boardToIcs writes one all-day VEVENT per open dated task, inside a VCALENDAR', () => {
  const ics = boardToIcs([task(7, { title: 'Renew passport', target_date: '2026-12-31' })], NOW);
  assert.equal(
    ics,
    [
      'BEGIN:VCALENDAR',
      'VERSION:2.0',
      'PRODID:-//Lumi//Task board//EN',
      'CALSCALE:GREGORIAN',
      'BEGIN:VEVENT',
      'UID:task-7@lumi',
      'DTSTAMP:20261112T153000Z',
      'DTSTART;VALUE=DATE:20261231',
      'DTEND;VALUE=DATE:20270101',
      'SUMMARY:Renew passport',
      'DESCRIPTION:Medium priority\\, from Lumi.',
      'END:VEVENT',
      'END:VCALENDAR',
      '',
    ].join('\r\n'),
  );
});

test('boardToIcs uses CRLF line endings everywhere, ending with one', () => {
  const ics = boardToIcs([task(1, { body: 'line one\nline two' }), task(2)], NOW);
  assert.ok(ics.endsWith('END:VCALENDAR\r\n'));
  assert.equal(ics.replaceAll('\r\n', '').includes('\n'), false, 'no bare LF');
  assert.equal(ics.replaceAll('\r\n', '').includes('\r'), false, 'no bare CR');
});

test('boardToIcs skips done and undated tasks', () => {
  const ics = boardToIcs(
    [task(1), task(2, { done: true }), task(3, { target_date: null }), task(4, { target_date: '2026-11-30' })],
    NOW,
  );
  assert.equal(ics.match(/BEGIN:VEVENT/g)?.length, 2);
  assert.ok(ics.includes('UID:task-1@lumi'));
  assert.ok(ics.includes('UID:task-4@lumi'));
  assert.ok(ics.includes('DTEND;VALUE=DATE:20261201'), 'month end rolls over');
  assert.ok(!ics.includes('task-2@') && !ics.includes('task-3@'));
});

test('boardToIcs is a valid empty calendar when nothing has a date', () => {
  assert.equal(
    boardToIcs([task(1, { target_date: null })], NOW),
    'BEGIN:VCALENDAR\r\nVERSION:2.0\r\nPRODID:-//Lumi//Task board//EN\r\nCALSCALE:GREGORIAN\r\nEND:VCALENDAR\r\n',
  );
});

test('boardToIcs escapes backslash, semicolon, comma and line breaks in TEXT', () => {
  const ics = boardToIcs([task(1, { title: 'a\\b; c, d', body: 'one\ntwo\r\nthree' })], NOW);
  assert.ok(ics.includes('SUMMARY:a\\\\b\\; c\\, d\r\n'));
  assert.ok(ics.includes('DESCRIPTION:Medium priority\\, from Lumi.\\n\\none\\ntwo\\nthree\r\n'));
});

test('boardToIcs folds lines longer than 75 octets, without splitting a character', () => {
  const ics = boardToIcs([task(1, { title: 'x'.repeat(200), body: 'ملاحظة '.repeat(30) })], NOW);
  const encoder = new TextEncoder();
  for (const line of ics.split('\r\n')) {
    assert.ok(encoder.encode(line).length <= 75, `line too long: ${line}`);
  }
  // Unfolding (remove CRLF + one space) gives back the whole values.
  const unfolded = ics.replaceAll('\r\n ', '');
  assert.ok(unfolded.includes(`SUMMARY:${'x'.repeat(200)}\r\n`));
  assert.ok(unfolded.includes(`\\n\\n${'ملاحظة '.repeat(30)}\r\n`));
  assert.ok(!unfolded.includes('�'), 'no broken characters');
});

test('calendarTasks keeps only open tasks with a date', () => {
  const tasks = [task(1), task(2, { done: true }), task(3, { target_date: null })];
  assert.deepEqual(
    calendarTasks(tasks).map((t) => t.id),
    [1],
  );
});
