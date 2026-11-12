// Unit tests for the pure board helpers. Run with `npm test` (Node's built-in runner;
// Node 24 runs TypeScript directly by stripping the types, so no test dependency is needed).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  type Change,
  type Task,
  addChange,
  activityText,
  applyActivity,
  cardChange,
  parseActivity,
  changedFacts,
  describeFactChanges,
  factLabel,
  daysFromToday,
  describeChange,
  friendlyDate,
  groupOf,
  groupTasks,
  parseBoard,
  suggestions,
  todayAllDone,
  splitLastWord,
  spokenTaskIds,
  userCaption,
  withGhosts,
  dotIgnites,
  nightLabel,
  nightStrip,
  monthGrid,
  tasksOnDay,
  dayFilterText,
  splitLinks,
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

test('spokenTaskIds lights the tasks whose whole title Lumi has said', () => {
  const tasks = [
    task(1, { title: 'Call the bank' }),
    task(2, { title: 'Buy eggs' }),
    task(3, { title: 'Go' }),
    task(4, { title: 'اتصل بأمي' }),
  ];
  assert.deepEqual(spokenTaskIds('First, call the bank. Then', tasks), [1]);
  assert.deepEqual(spokenTaskIds('You have Call the bank and buy eggs, then go.', tasks), [1, 2]);
  assert.deepEqual(spokenTaskIds('Buy eggshells', tasks), []); // whole words only
  assert.deepEqual(spokenTaskIds('Call the', tasks), []); // not yet said in full
  assert.deepEqual(spokenTaskIds('ثم اتصل بأمي', tasks), [4]); // any script
});

test('splitLastWord separates the word being spoken', () => {
  assert.deepEqual(splitLastWord('Done, call the bank '), ['Done, call the ', 'bank']);
  assert.deepEqual(splitLastWord('Done'), ['', 'Done']);
});

test('suggestions come from the board, at most three', () => {
  // NOW is Thursday 12 November 2026.
  assert.deepEqual(suggestions([], {}, NOW), ['Add a task to call mom tomorrow', 'My favorite color is blue']);
  const board = [
    task(1, { title: 'Book dentist', target_date: '2026-11-11' }),
    task(2, { title: 'Call the bank', target_date: '2026-11-12' }),
    task(3, { title: 'Plan the trip' }),
  ];
  assert.deepEqual(suggestions(board, {}, NOW), ['What’s overdue?', 'Brief me on today', 'Move “Plan the trip” to Friday']);
  assert.deepEqual(suggestions([task(3, { title: 'Plan the trip' })], { home_city: 'Riyadh' }, NOW), [
    'Move “Plan the trip” to Friday',
  ]);
  assert.deepEqual(suggestions([task(4, { title: 'Pay rent', target_date: '2026-11-20' })], {}, NOW), [
    'Mark “Pay rent” done',
    'My favorite color is blue',
  ]);
  assert.deepEqual(suggestions([task(5, { done: true })], { a: 'b' }, NOW).length, 2); // all done: start fresh
});

test('todayAllDone needs a task due today, all of them done, and nothing overdue', () => {
  const today = '2026-11-12';
  assert.equal(todayAllDone([], NOW), false);
  assert.equal(todayAllDone([task(1, { target_date: today, done: true })], NOW), true);
  assert.equal(todayAllDone([task(1, { target_date: today, done: true }), task(2, { target_date: today })], NOW), false);
  const late = task(3, { target_date: '2026-11-11' });
  assert.equal(todayAllDone([task(1, { target_date: today, done: true }), late], NOW), false);
  // Undated and later tasks don't count against today.
  assert.equal(todayAllDone([task(1, { target_date: today, done: true }), task(4), task(5, { target_date: '2026-11-20' })], NOW), true);
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

test('parseActivity reads a start and an end, and rejects anything else', () => {
  assert.deepEqual(parseActivity('{"status":"started","call_id":"c1","tool":"look_up","task_id":4}'), {
    status: 'started',
    call_id: 'c1',
    tool: 'look_up',
    task_id: 4,
  });
  assert.deepEqual(parseActivity('{"status":"started","call_id":"c1","tool":"look_up","task_id":"4"}')?.status, 'started');
  assert.equal((parseActivity('{"status":"started","call_id":"c1","tool":"x","task_id":"4"}') as { task_id: unknown }).task_id, null);
  assert.deepEqual(parseActivity('{"status":"ended","call_id":"c1"}'), { status: 'ended', call_id: 'c1' });
  assert.equal(parseActivity('{"status":"started"}'), null);
  assert.equal(parseActivity('nope'), null);
});

test('applyActivity tracks parallel tools until each one ends', () => {
  const start = (call_id: string, tool: string) => ({ status: 'started' as const, call_id, tool, task_id: null });
  let running = applyActivity([], start('a', 'create_task'));
  running = applyActivity(running, start('b', 'look_up'));
  assert.equal(activityText(running), 'Searching the web…');
  running = applyActivity(running, { status: 'ended', call_id: 'b' });
  assert.equal(activityText(running), 'Adding it to the board…');
  running = applyActivity(running, { status: 'ended', call_id: 'a' });
  assert.equal(activityText(running), null);
  assert.equal(activityText([{ call_id: 'x', tool: 'new_tool', task_id: null }]), 'Working on it…');
});

test('nightStrip draws today and the next 13 days, with weekends marked', () => {
  const { nights, overdue } = nightStrip([], NOW);
  assert.equal(nights.length, 14);
  assert.equal(overdue, 0);
  assert.deepEqual(nights[0], {
    date: '2026-11-12',
    weekday: 'Thu',
    day: 12,
    isToday: true,
    isWeekend: false,
    tasks: [],
  });
  assert.equal(nights[13].date, '2026-11-25');
  assert.equal(nights.filter((n) => n.isToday).length, 1);
  assert.deepEqual(
    nights.filter((n) => n.isWeekend).map((n) => `${n.weekday} ${n.day}`),
    ['Sat 14', 'Sun 15', 'Sat 21', 'Sun 22'],
  );
});

test('nightStrip rolls over a month end and a year end in local days', () => {
  const nights = nightStrip([], new Date(2026, 11, 25, 23, 59)).nights;
  assert.deepEqual(
    nights.slice(5, 9).map((n) => n.date),
    ['2026-12-30', '2026-12-31', '2027-01-01', '2027-01-02'],
  );
  assert.equal(nights[7].day, 1);
});

test('nightStrip puts each open task on its night, brightest first, and counts the overdue ones', () => {
  const { nights, overdue } = nightStrip(
    [
      task(1, { priority: 'low', target_date: '2026-11-14' }),
      task(2, { priority: 'high', target_date: '2026-11-14' }),
      task(3, { priority: 'high', target_date: '2026-11-14', done: true }), // done: no dot
      task(4, { target_date: '2026-11-12' }),
      task(5, { target_date: '2026-11-26' }), // 14 days away: past the strip
      task(6, { target_date: null }),
      task(7, { target_date: '2026-11-10' }),
      task(8, { target_date: '2026-11-11' }),
      task(9, { target_date: '2026-11-01', done: true }), // done and late: not overdue
    ],
    NOW,
  );
  assert.deepEqual(
    nights.map((n) => n.tasks.map((t) => t.id)),
    [[4], [], [2, 1], [], [], [], [], [], [], [], [], [], [], []],
  );
  assert.equal(overdue, 2);
});

test('nightLabel lists the tasks on a night, or says nothing is due', () => {
  const { nights } = nightStrip(
    [
      task(1, { title: 'Buy milk', priority: 'low', target_date: '2026-11-13' }),
      task(2, { title: 'Call the bank', priority: 'high', target_date: '2026-11-13' }),
    ],
    NOW,
  );
  assert.equal(nightLabel(nights[1]), 'Fri 13 Nov: Call the bank (high), Buy milk (low)');
  assert.equal(nightLabel(nights[2]), 'Sat 14 Nov: nothing due');
});

test('dotIgnites for a new task or a moved date, not for other edits', () => {
  const recent = (change: Change) => addChange([], 1, change, [], [task(1)])[0];
  assert.equal(dotIgnites(undefined), false);
  assert.equal(dotIgnites(recent(changeOf('created', 1, 'Task 1'))), true);
  assert.equal(dotIgnites(recent(changeOf('updated', 1, 'Task 1', ['target_date', 'priority']))), true);
  assert.equal(dotIgnites(recent(changeOf('updated', 1, 'Task 1', ['priority']))), false);
  assert.equal(dotIgnites(recent(changeOf('deleted', 1, 'Task 1'))), false);
});

test('monthGrid lays a month out in whole weeks, Monday first, with the edge days marked', () => {
  const weeks = monthGrid([], 2026, 10, NOW); // November 2026 starts on a Sunday
  assert.equal(weeks.length, 6);
  assert.ok(weeks.every((week) => week.length === 7));
  assert.deepEqual(weeks[0].map((d) => d.weekday), ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun']);
  assert.equal(weeks[0][0].date, '2026-10-26');
  assert.equal(weeks[0][6].date, '2026-11-01');
  assert.equal(weeks[5][6].date, '2026-12-06');
  const days = weeks.flat();
  assert.equal(days.filter((d) => d.inMonth).length, 30);
  assert.deepEqual(days.filter((d) => d.isToday).map((d) => d.date), ['2026-11-12']);
  assert.equal(days.find((d) => d.date === '2026-11-11')!.isPast, true);
  assert.equal(days.find((d) => d.date === '2026-11-12')!.isPast, false);
});

test('monthGrid needs only as many weeks as the month covers, across a year end', () => {
  assert.equal(monthGrid([], 2027, 1, NOW).length, 4); // February 2027: Monday 1st to Sunday 28th
  const december = monthGrid([], 2026, 11, NOW);
  assert.equal(december.length, 5);
  assert.equal(december[4][6].date, '2027-01-03');
  assert.equal(december[4][6].inMonth, false);
});

test('monthGrid puts open tasks on their day, overdue ones included, brightest first', () => {
  const days = monthGrid(
    [
      task(1, { priority: 'low', target_date: '2026-11-20' }),
      task(2, { priority: 'high', target_date: '2026-11-20' }),
      task(3, { target_date: '2026-11-20', done: true }), // done: no dot
      task(4, { target_date: '2026-11-03' }), // overdue: still on its day
      task(5, { target_date: null }),
    ],
    2026,
    10,
    NOW,
  ).flat();
  assert.deepEqual(days.find((d) => d.date === '2026-11-20')!.tasks.map((t) => t.id), [2, 1]);
  assert.deepEqual(days.find((d) => d.date === '2026-11-03')!.tasks.map((t) => t.id), [4]);
  assert.equal(days.reduce((n, d) => n + d.tasks.length, 0), 3);
});

test('tasksOnDay keeps every task dated that day, open and done', () => {
  const tasks = [
    task(1, { target_date: '2026-11-20' }),
    task(2, { target_date: '2026-11-20', done: true }),
    task(3, { target_date: '2026-11-21' }),
    task(4, { target_date: null }),
  ];
  assert.deepEqual(tasksOnDay(tasks, '2026-11-20').map((t) => t.id), [1, 2]);
  assert.deepEqual(tasksOnDay(tasks, '2026-11-22'), []);
});

test('dayFilterText counts the day\'s tasks, or suggests what to say on a day still to come', () => {
  assert.equal(dayFilterText('2026-11-20', 2, NOW), 'Showing Fri 20 Nov · 2 tasks');
  assert.equal(dayFilterText('2026-11-20', 1, NOW), 'Showing Fri 20 Nov · 1 task');
  assert.equal(dayFilterText('2026-11-20', 0, NOW), 'Nothing on Fri 20 Nov. Try saying “add … on Friday”.');
  assert.equal(dayFilterText('2026-11-12', 0, NOW), 'Nothing on Thu 12 Nov. Try saying “add … on Thursday”.');
  assert.equal(dayFilterText('2026-11-10', 0, NOW), 'Nothing on Tue 10 Nov.');
});

test('splitLinks leaves plain text as one piece', () => {
  assert.deepEqual(splitLinks('Bring two photos.\nAnd the old passport.'), [
    { text: 'Bring two photos.\nAnd the old passport.' },
  ]);
  assert.deepEqual(splitLinks(''), []);
});

test('splitLinks turns one URL into a site chip and keeps the text around it', () => {
  assert.deepEqual(splitLinks('Open until 10 pm. Sources: https://www.ikea.com/sa/en/stores/'), [
    { text: 'Open until 10 pm. Sources: ' },
    { url: 'https://www.ikea.com/sa/en/stores/', site: 'ikea.com' },
  ]);
});

test('splitLinks splits two sources, as look_up saves them', () => {
  assert.deepEqual(splitLinks('Sources: https://www.gov.sa/en/passports http://travel.state.gov/x?a=1&b=2'), [
    { text: 'Sources: ' },
    { url: 'https://www.gov.sa/en/passports', site: 'gov.sa' },
    { text: ' ' },
    { url: 'http://travel.state.gov/x?a=1&b=2', site: 'travel.state.gov' },
  ]);
});

test('splitLinks leaves the punctuation after a URL as text', () => {
  assert.deepEqual(splitLinks('See https://a.com/page. Then (https://b.org/x), done'), [
    { text: 'See ' },
    { url: 'https://a.com/page', site: 'a.com' },
    { text: '. Then (' },
    { url: 'https://b.org/x', site: 'b.org' },
    { text: '), done' },
  ]);
  // A bracket the URL itself opened is part of it.
  assert.deepEqual(splitLinks('https://en.wikipedia.org/wiki/Mercury_(planet).'), [
    { url: 'https://en.wikipedia.org/wiki/Mercury_(planet)', site: 'en.wikipedia.org' },
    { text: '.' },
  ]);
});

test('splitLinks links only http and https: other schemes stay text', () => {
  for (const text of ['javascript:alert(1)', 'ftp://files.example.com/a', 'data:text/html,<b>hi</b>', 'mailto:a@b.com']) {
    assert.deepEqual(splitLinks(text), [{ text }]);
  }
  // A URL that doesn't parse stays text too.
  assert.deepEqual(splitLinks('https://[broken'), [{ text: 'https://[broken' }]);
});
