'use client';

import { useEffect, useState } from 'react';
import { type Change, type Task, GROUP_LABELS, describeChange, friendlyDate, groupTasks } from '@/lib/board';

type Props = {
  tasks: Task[];
  change: Change | null; // the change that produced this board, or null for a plain refresh
  seq: number; // bumps on every board the agent sends, so the same change twice still animates
  ghost: Task | null; // a just-deleted task, kept for one animation so it can drift away
  live: boolean; // false while showing the cached board from the last visit
};

const PRIORITY_LABELS = { high: 'High', medium: 'Medium', low: 'Low' };

// Pure view of the board. All animation is CSS, chosen by class names derived from `change`.
export default function Board({ tasks, change, seq, ghost, live }: Props) {
  const [showDone, setShowDone] = useState(false);
  // The seq whose ghost finished drifting away; past that point it is no longer drawn.
  const [ghostGoneAt, setGhostGoneAt] = useState(-1);
  const now = new Date();

  const showGhost = ghost !== null && ghostGoneAt !== seq;
  const visible = ghost && showGhost ? [...tasks, ghost] : tasks;
  const lanes = groupTasks(visible, now);
  const done = visible.filter((t) => t.done);
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
    const changed = change?.task_id === task.id ? change : null;
    const isGhost = showGhost && task.id === ghost?.id;
    const classes = ['card', `prio-${task.priority}`];
    if (task.done) classes.push('is-done');
    if (changed) classes.push(`is-${changed.action}`);
    return (
      <article
        // A changed card gets a fresh key, so React re-creates it and its CSS animation
        // restarts even when the same task changes twice in a row.
        key={changed ? `${task.id}-${seq}` : task.id}
        id={`task-${task.id}`}
        className={classes.join(' ')}
        // Lets CSS flash only the parts that changed, e.g. [data-changed~="priority"] .prio
        data-changed={changed?.action === 'updated' ? changed.fields.join(' ') : undefined}
        onAnimationEnd={(e) => {
          if (isGhost && e.animationName === 'ember-away') setGhostGoneAt(seq);
        }}
      >
        <div className="card-top">
          <span className="prio">
            <span className="prio-flame" aria-hidden="true" />
            {task.done ? 'Done' : PRIORITY_LABELS[task.priority]}
          </span>
          {task.target_date && (
            <time className="chip" dateTime={task.target_date}>
              {friendlyDate(task.target_date)}
            </time>
          )}
        </div>
        <h3 className="card-title">{task.title}</h3>
        {task.body && <p className="card-body">{task.body}</p>}
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
      </div>

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

      {change && (
        // A new key per board restarts the toast's fade-in / fade-out animation.
        <p key={seq} className={`toast toast-${change.action}`} aria-hidden="true">
          {describeChange(change, changedTask)}
        </p>
      )}
      {/* The toast is decorative; screen readers hear the same sentence from here. */}
      <p className="sr-only" aria-live="polite">
        {change ? describeChange(change, changedTask) : ''}
      </p>
    </section>
  );
}
