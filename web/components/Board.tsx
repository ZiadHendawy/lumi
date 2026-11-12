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
  dotIgnites,
  factLabel,
  friendlyDate,
  groupTasks,
  nightLabel,
  nightStrip,
  splitLinks,
  withGhosts,
} from '@/lib/board';
import Connections, { CalendarLink } from './Connections';

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
};

const PRIORITY_LABELS = { high: 'High', medium: 'Medium', low: 'Low' };

// Pure view of the board. All animation is CSS, chosen by class names derived from `recent`.
export default function Board({ tasks, facts, factsChanged, recent, seq, live, working, spoken, onGhostGone, onReceiptDone }: Props) {
  const [showDone, setShowDone] = useState(false);
  const now = new Date();

  const visible = withGhosts(tasks, recent);
  const lanes = groupTasks(visible, now);
  const done = visible.filter((t) => t.done);
  // The change carried by the newest board, if it had one.
  const change = recent.find((r) => r.seq === seq)?.change;
  const changedTask = change ? visible.find((t) => t.id === change.task_id) : undefined;

  // Voice-to-screen sync: bring whatever Lumi just changed into view, so the user sees it
  // happen while Lumi is still saying it.
  useEffect(() => {
    if (!change) return;
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

      <Memory facts={facts} changed={factsChanged} />

      {!isEmpty && <NightStrip tasks={tasks} recent={recent} now={now} />}

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

// The memory shelf: the facts Lumi keeps across sessions, so "remembers you" is visible,
// not only something Lumi says. A fact that just changed lights up like a new card.
function Memory({ facts, changed }: { facts: Facts; changed: Props['factsChanged'] }) {
  const keys = Object.keys(facts);
  return (
    <section className="memory" aria-label="What Lumi remembers">
      <h2 className="memory-title">Lumi remembers</h2>
      {keys.length === 0 ? (
        <p className="memory-hint">nothing yet · try “my favorite color is blue”</p>
      ) : (
        <ul className="memory-facts">
          {keys.map((key) => {
            const lit = changed.keys.includes(key);
            return (
              // A fresh key restarts the glow when the same fact changes twice in a row.
              <li key={lit ? `${key}-${changed.seq}` : key} className={lit ? 'fact is-lit' : 'fact'}>
                <span className="fact-key">{factLabel(key)}</span>
                <span className="fact-value">{facts[key]}</span>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}

// The night strip: the same 14-day calendar the model reads in its prompt (prompt.build_instructions),
// drawn so the user can see the days Lumi resolves "next Friday" against. One dot per open task,
// as bright as its priority.
function NightStrip({ tasks, recent, now }: { tasks: Task[]; recent: RecentChange[]; now: Date }) {
  const { nights, overdue } = nightStrip(tasks, now);
  return (
    <section className="nights" aria-label="The next 14 days">
      {overdue > 0 && <p className="nights-overdue">{overdue} overdue</p>}
      {/* Only this row scrolls sideways on a phone, never the page. */}
      <ol className="nights-row">
        {nights.map((night) => {
          const label = nightLabel(night);
          const classes = ['night'];
          if (night.isToday) classes.push('is-today');
          if (night.isWeekend) classes.push('is-weekend');
          return (
            <li key={night.date} className={classes.join(' ')} title={label}>
              <span className="night-weekday" aria-hidden="true">{night.weekday}</span>
              <span className="night-day" aria-hidden="true">{night.day}</span>
              <span className="night-dots" aria-hidden="true">
                {night.tasks.map((task) => {
                  const changed = cardChange(recent, task.id);
                  const ignites = dotIgnites(changed);
                  return (
                    <span
                      // A fresh key restarts the ignite animation, like a changed card.
                      key={ignites ? `${task.id}-${changed!.seq}` : task.id}
                      className={`night-dot prio-${task.priority}${ignites ? ' is-igniting' : ''}`}
                    />
                  );
                })}
              </span>
              <span className="sr-only">{label}</span>
            </li>
          );
        })}
      </ol>
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
