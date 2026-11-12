'use client';

import { useEffect, useState } from 'react';
import {
  ACTIVITY_TEXT,
  type Activity,
  type Facts,
  type RecentChange,
  type Task,
  GROUP_LABELS,
  cardChange,
  dayFilterText,
  friendlyDate,
  groupTasks,
  splitLinks,
  tasksOnDay,
  todayAllDone,
  withGhosts,
} from '@/lib/board';
import Calendar from './Calendar';
import Connections, { CalendarLink } from './Connections';
import Memory, { type MemoryEdit } from './Memory';

type Props = {
  tasks: Task[];
  facts: Facts; // what Lumi remembers about the user
  factsChanged: { keys: string[]; seq: number; text: string[] }; // lit by the latest push
  recent: RecentChange[]; // changes still animating, oldest first
  seq: number; // bumps on every board the agent sends
  live: boolean; // false while showing the cached board from the last visit
  working: Activity[]; // tools running now; a card with a running tool shimmers
  spoken: number[]; // tasks Lumi is naming right now (read-along)
  onGhostGone: (seq: number) => void; // a deleted card has drifted away
  onReceiptDone: (seq: number) => void; // a receipt toast has faded out
  onEditMemory: ((edit: MemoryEdit) => Promise<void>) | null; // null while no agent can take it
  onShowPrompt: () => void; // opens X-ray at "What Lumi sees"
};

const PRIORITY_LABELS = { high: 'High', medium: 'Medium', low: 'Low' };

// Pure view of the board. All animation is CSS, chosen by class names derived from `recent`.
export default function Board(props: Props) {
  const { tasks, facts, factsChanged, recent, seq, live, working, spoken, onGhostGone, onReceiptDone } = props;
  const [showDone, setShowDone] = useState(false);
  const [day, setDay] = useState<string | null>(null); // a day picked on the calendar
  const now = new Date();

  const visible = withGhosts(tasks, recent);
  const shown = day ? tasksOnDay(visible, day) : visible;
  const lanes = groupTasks(shown, now);
  const done = shown.filter((t) => t.done);
  // The change carried by the newest board, if it had one.
  const change = recent.find((r) => r.seq === seq)?.change;
  const changedTask = change ? visible.find((t) => t.id === change.task_id) : undefined;

  // Voice-to-screen sync: bring whatever Lumi just changed into view, so the user sees it
  // happen while Lumi is still saying it.
  useEffect(() => {
    if (!change) return;
    setDay(null); // a day filter could hide the card Lumi is changing while it says so
    if (changedTask?.done) setShowDone(true); // otherwise "mark it done" would vanish into a closed list
    // Wait one frame so a just-opened Done list is on screen before scrolling to it.
    requestAnimationFrame(() => {
      const reduceMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;
      document
        .getElementById(`task-${change.task_id}`)
        ?.scrollIntoView({ block: 'nearest', behavior: reduceMotion ? 'auto' : 'smooth' });
    });
  }, [seq]); // eslint-disable-line -- run once per board from the agent, not on every render

  function renderCard(task: Task) {
    const changed = cardChange(recent, task.id);
    const classes = ['card', `prio-${task.priority}`];
    if (task.done) classes.push('is-done');
    if (changed) classes.push(`is-${changed.change.action}`);
    const busy = working.find((a) => a.task_id === task.id);
    if (busy) classes.push('is-working');
    if (spoken.includes(task.id)) classes.push('is-spoken');
    return (
      <article
        // A changed card gets a fresh key, so React re-creates it and its CSS animation
        // restarts even when the same task changes twice in a row.
        key={changed ? `${task.id}-${changed.seq}` : task.id}
        id={`task-${task.id}`}
        className={classes.join(' ')}
        // Lets CSS flash only the parts that changed, e.g. [data-changed~="priority"] .prio
        data-changed={changed?.change.action === 'updated' ? changed.change.fields.join(' ') : undefined}
        onAnimationEnd={(e) => {
          // Takes the ghost out of the layout, so the lane closes up behind it.
          if (changed?.ghost && e.animationName === 'ember-away') onGhostGone(changed.seq);
        }}
      >
        <div className="card-top">
          <span className="prio">
            <span className="prio-flame" aria-hidden="true" />
            {task.done ? 'Done' : PRIORITY_LABELS[task.priority]}
          </span>
          {!task.done && <CalendarLink task={task} />}
          {task.target_date && (
            <time className="chip" dateTime={task.target_date}>
              {friendlyDate(task.target_date)}
            </time>
          )}
        </div>
        <h3 className="card-title">{task.title}</h3>
        {task.body && <p className="card-body"><Notes text={task.body} /></p>}
        {/* CSS shows this only after a moment, so a fast tool doesn't flash it. */}
        {busy && <p className="card-working">{ACTIVITY_TEXT[busy.tool] ?? 'Working on it…'}</p>}
      </article>
    );
  }

  const openCount = visible.length - done.length;
  const isEmpty = visible.length === 0;

  return (
    <section className={live ? 'board' : 'board is-stale'} aria-label="Lumi's board">
      <div className="board-meta">
        <p className="board-date">
          {now.toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long' })}
        </p>
        {!isEmpty && (
          <p className="board-count">
            {live ? `${openCount} lit · ${done.length} done` : 'Last seen'}
          </p>
        )}
        <Connections tasks={tasks} />
      </div>

      <Memory facts={facts} changed={factsChanged} onEdit={props.onEditMemory} onShowPrompt={props.onShowPrompt} />

      {!isEmpty && (
        <Calendar
          tasks={tasks}
          recent={recent}
          now={now}
          selected={day}
          onSelect={(date) => {
            setDay(date);
            if (date) setShowDone(true); // the day's finished tasks are part of its answer
          }}
        />
      )}

      {/* A small reward for finishing the day. It glows once when a "done" put the last one out. */}
      {todayAllDone(tasks, now) && (
        <p className={change?.action === 'updated' && change.fields.includes('done') ? 'all-out is-new' : 'all-out'}>
          All of today’s lanterns are out. Well done.
        </p>
      )}

      {day && !isEmpty && (
        <div className="day-filter">
          <p className="day-filter-text">{dayFilterText(day, shown.length, now)}</p>
          <button className="day-filter-clear" onClick={() => setDay(null)}>Show all</button>
        </div>
      )}

      {isEmpty ? (
        <div className="empty">
          <p className="empty-title">Your board is dark.</p>
          <p className="empty-hint">Tap the lantern and try saying</p>
          <ul className="empty-phrases">
            <li>“Add a task to call mom tomorrow”</li>
            <li>“Make it high priority”</li>
            <li>“Add a note: ask about the trip”</li>
          </ul>
        </div>
      ) : (
        <div className="lanes">
          {lanes.map((lane) => (
            <section key={lane.key} className={`lane lane-${lane.key}`} aria-label={GROUP_LABELS[lane.key]}>
              <h2 className="lane-title">
                {GROUP_LABELS[lane.key]}
                <span className="lane-count">{lane.tasks.length}</span>
              </h2>
              <div className="lane-cards">{lane.tasks.map(renderCard)}</div>
            </section>
          ))}
        </div>
      )}

      {done.length > 0 && (
        <section className="done" aria-label="Done">
          <button className="done-toggle" aria-expanded={showDone} onClick={() => setShowDone(!showDone)}>
            <span className="done-chevron" aria-hidden="true" />
            Done
            <span className="lane-count">{done.length}</span>
          </button>
          {showDone && <div className="done-cards">{done.map(renderCard)}</div>}
        </section>
      )}

      {/* One receipt per recent change, stacked oldest first, each up for its full time. A change
          is forgotten when its receipt has faded, which is after its card animation has ended. */}
      <div className="toasts" aria-hidden="true">
        {recent.map((r) => (
          <p
            key={r.seq}
            className={`toast toast-${r.change.action}`}
            onAnimationEnd={(e) => {
              if (e.animationName === 'toast') onReceiptDone(r.seq);
            }}
          >
            {r.text}
          </p>
        ))}
      </div>
      {/* The toasts are decorative; screen readers hear each new sentence from here. */}
      <div className="sr-only" aria-live="polite">
        {recent.map((r) => (
          <p key={r.seq}>{r.text}</p>
        ))}
        {factsChanged.text.map((line) => (
          <p key={`${factsChanged.seq}-${line}`}>{line}</p>
        ))}
      </div>
    </section>
  );
}

// A card's notes with each web link shown as a small chip naming the site. Every piece is a
// text node or an <a>, never HTML, because search answers come from the web. The "Sources:"
// label the agent writes is kept: it says what the chips are, and the notes stay as stored.
function Notes({ text }: { text: string }) {
  return splitLinks(text).map((piece, i) =>
    'url' in piece ? (
      <a key={i} className="source-chip" href={piece.url} title={piece.url} target="_blank" rel="noopener noreferrer">
        {piece.site}
      </a>
    ) : (
      piece.text
    ),
  );
}
