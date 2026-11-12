'use client';

import { useRef, type ReactNode } from 'react';
import type { Task } from '@/lib/board';
import { boardToIcs, calendarTasks, googleCalendarUrl } from '@/lib/calendar';

// Only integrations live here; the wider roadmap (Arabic, a family board, reminders...) is in the
// README. What works has a button or a "Works today" pill. What doesn't is a quieter row with a
// "Coming soon" pill and no button, so the panel never promises something that isn't there.

// Small generic glyphs (no brand logos), stroked in currentColor so they follow the row's colour.
const GLYPHS = {
  file: 'M5 2.5h6l4 4v11H5zM11 2.5v4h4M10 9v5.5M7.5 12 10 14.5l2.5-2.5',
  calendar: 'M3.5 4.5h13v12h-13zM3.5 8h13M7 2.5v3M13 2.5v3',
  sync: 'M15.5 8A6 6 0 0 0 4.8 6.2M4.5 3v3.5H8M4.5 12a6 6 0 0 0 10.7 1.8M15.5 17v-3.5H12',
  phone: 'M6.5 3h-2A1.5 1.5 0 0 0 3 4.6 13 13 0 0 0 15.4 17a1.5 1.5 0 0 0 1.6-1.5v-2l-3.3-1.4-1.6 1.6a9 9 0 0 1-4.8-4.8l1.6-1.6z',
};

// One integration: glyph, name, one short line, and on the right a button or a status pill.
// `title` is the tooltip with what an unbuilt one would take.
function Row(props: { glyph: keyof typeof GLYPHS; name: string; line: string; title?: string; children: ReactNode }) {
  return (
    <li className="connections-row" title={props.title}>
      <svg className="connections-glyph" viewBox="0 0 20 20" width="20" height="20" aria-hidden="true">
        <path d={GLYPHS[props.glyph]} />
      </svg>
      <div className="connections-body">
        <p className="connections-name">{props.name}</p>
        <p className="connections-line">{props.line}</p>
      </div>
      {props.children}
    </li>
  );
}

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

          <h3 className="connections-group">Works today</h3>
          <ul className="connections-list">
            <Row glyph="file" name="Calendar file (.ics)" line="For Apple Calendar, Outlook or Google Calendar.">
              <div className="connections-action">
                <button
                  className="connections-download"
                  onClick={downloadIcs}
                  disabled={datedCount === 0}
                  aria-describedby="connections-count"
                >
                  Download .ics
                </button>
                <span id="connections-count" className="connections-note">
                  {datedCount === 0 ? 'No dated tasks yet' : `${datedCount} dated ${datedCount === 1 ? 'task' : 'tasks'}`}
                </span>
              </div>
            </Row>
            <Row glyph="calendar" name="Google Calendar" line="Use the calendar icon on any dated card.">
              <span className="connections-tag is-ready">Works today</span>
            </Row>
          </ul>

          <h3 className="connections-group">Coming soon</h3>
          <ul className="connections-list is-soon">
            <Row
              glyph="sync"
              name="Calendar sync"
              line="Two-way with Google Calendar and Outlook."
              title="Needs OAuth sign-in, tokens stored per user, and your events read into Lumi’s prompt."
            >
              <span className="connections-tag">Coming soon</span>
            </Row>
            <Row
              glyph="phone"
              name="Phone call"
              line="Call Lumi from any phone."
              title="LiveKit SIP would route a phone number to the same agent."
            >
              <span className="connections-tag">Coming soon</span>
            </Row>
          </ul>
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
