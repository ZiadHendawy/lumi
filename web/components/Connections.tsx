'use client';

import { useRef } from 'react';
import type { Task } from '@/lib/board';
import { boardToIcs, calendarTasks, googleCalendarUrl } from '@/lib/calendar';

// What's built is a button; what's planned is a greyed line saying what it would take. No fake
// buttons, so the panel never promises something that isn't there.
const PLANNED = [
  {
    name: 'Google Calendar & Outlook two-way sync',
    takes: 'OAuth sign-in, tokens stored per user, and today’s events read into Lumi’s prompt so it can plan around them.',
  },
  {
    name: (
      <>
        <span lang="ar" dir="rtl">
          العربية
        </span>{' '}
        (Arabic)
      </>
    ),
    takes: 'Deepgram Nova-3 already understands Arabic; the voice (Aura) has no Arabic yet, so it needs another TTS.',
  },
  { name: 'Call Lumi from a phone', takes: 'LiveKit SIP routes a phone number to the same agent.' },
  { name: 'A shared family board', takes: 'Several people in one LiveKit room, each change pushed to everyone.' },
  { name: 'Reminders at a time', takes: 'Tasks have dates, not times, yet; then a push notification.' },
  { name: 'Sign in on any device', takes: 'The board is tied to this browser today (an anonymous id).' },
  { name: 'Recurring tasks', takes: '“Every Sunday” as a repeat rule on the task.' },
];

// The "Connections" button for the board's meta row, and the panel it opens.
export default function Connections({ tasks }: { tasks: Task[] }) {
  // A native <dialog> opened with showModal(): the browser gives focus trapping, Escape to close
  // and the backdrop for free, so there is no open/closed state to keep in React.
  const dialog = useRef<HTMLDialogElement>(null);
  const datedCount = calendarTasks(tasks).length;

  function downloadIcs() {
    const blob = new Blob([boardToIcs(tasks, new Date())], { type: 'text/calendar;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = 'lumi-tasks.ics';
    link.click();
    // Freed a little later, because Safari can still be reading the URL right after the click.
    setTimeout(() => URL.revokeObjectURL(url), 10_000);
  }

  return (
    <>
      <button className="connections-open" onClick={() => dialog.current?.showModal()}>
        Connections
      </button>
      <dialog
        ref={dialog}
        className="connections"
        aria-labelledby="connections-title"
        // A click on the backdrop lands on the <dialog> itself; clicks inside land on its content.
        onClick={(e) => {
          if (e.target === e.currentTarget) dialog.current?.close();
        }}
      >
        <div className="connections-inner">
          <header className="connections-head">
            <h2 id="connections-title" className="connections-title">
              Connections
            </h2>
            <button className="connections-close" onClick={() => dialog.current?.close()}>
              Close
            </button>
          </header>

          <section className="connections-section" aria-labelledby="connections-calendar">
            <h3 id="connections-calendar" className="connections-name">
              Calendar <span className="connections-tag is-ready">Works today</span>
            </h3>
            <p className="connections-text">
              Your dated tasks as all-day events, for Apple Calendar, Outlook or Google Calendar.
            </p>
            <button className="connections-download" onClick={downloadIcs} disabled={datedCount === 0}>
              Download .ics
            </button>
            <p className="connections-note">
              {datedCount === 0
                ? 'No open task has a date yet. Give one a day, then download.'
                : `${datedCount} ${datedCount === 1 ? 'task' : 'tasks'} with a date. Open the file to import it.`}
            </p>
            <p className="connections-text">Each dated card also has its own “Add to Google Calendar” link.</p>
          </section>

          <section className="connections-section" aria-labelledby="connections-planned">
            <h3 id="connections-planned" className="connections-name">
              Planned
            </h3>
            <ul className="connections-planned">
              {PLANNED.map((item, i) => (
                <li key={i}>
                  <p className="connections-item">
                    {item.name} <span className="connections-tag">Planned</span>
                  </p>
                  <p className="connections-text">{item.takes}</p>
                </li>
              ))}
            </ul>
          </section>
        </div>
      </dialog>
    </>
  );
}

// The quiet per-card link: Google's prefilled "add event" page for one dated task.
export function CalendarLink({ task }: { task: Task }) {
  const url = googleCalendarUrl(task);
  if (!url) return null;
  const label = `Add “${task.title}” to Google Calendar`;
  return (
    <a className="card-calendar" href={url} target="_blank" rel="noopener noreferrer" aria-label={label} title={label}>
      {/* A small calendar page with a plus, drawn in currentColor so it follows the link's colour. */}
      <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">
        <rect x="2" y="3" width="12" height="11" rx="2" fill="none" stroke="currentColor" strokeWidth="1.3" />
        <path d="M2 6.5h12M5.5 1.5v3M10.5 1.5v3M8 8.5v3.5M6.25 10.25h3.5" stroke="currentColor" strokeWidth="1.3" />
      </svg>
    </a>
  );
}
