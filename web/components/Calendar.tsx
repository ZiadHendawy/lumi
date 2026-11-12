'use client';

import { useEffect, useState } from 'react';
import {
  type MonthDay,
  type Night,
  type RecentChange,
  type Task,
  cardChange,
  dotIgnites,
  monthGrid,
  nightLabel,
  nightStrip,
} from '@/lib/board';

type Props = {
  tasks: Task[];
  recent: RecentChange[];
  now: Date;
  selected: string | null; // the day the board is filtered to, 'YYYY-MM-DD'
  onSelect: (date: string | null) => void;
};

const WEEKDAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
const monthTitle = new Intl.DateTimeFormat('en-GB', { month: 'long', year: 'numeric' });
const MONTH_KEY = 'lumi.calendarMonth';

// The calendar above the lanes. By default it is the night strip: the same 14-day calendar the
// model reads in its prompt (prompt.build_instructions), so the user can see the days Lumi
// resolves "next Friday" against. "Month" opens the whole month. Clicking a day filters the board.
export default function Calendar({ tasks, recent, now, selected, onSelect }: Props) {
  const [monthOpen, setMonthOpen] = useState(false);
  // The month shown, as its 1st day, so the arrows are plain Date arithmetic.
  const [shown, setShown] = useState(() => new Date(now.getFullYear(), now.getMonth(), 1));
  const { nights, overdue } = nightStrip(tasks, now);

  // Remember whether the month was open. Read after mounting, and localStorage can throw
  // (private mode), so a failure just means the strip.
  useEffect(() => {
    try {
      setMonthOpen(localStorage.getItem(MONTH_KEY) === '1');
    } catch {}
  }, []);
  function toggleMonth() {
    setMonthOpen(!monthOpen);
    try {
      localStorage.setItem(MONTH_KEY, monthOpen ? '0' : '1');
    } catch {}
  }

  // Clicking the selected day again shows the whole board.
  const pick = (date: string) => onSelect(date === selected ? null : date);
  const moveMonth = (by: number) => setShown(new Date(shown.getFullYear(), shown.getMonth() + by, 1));

  function renderDay(night: Night | MonthDay) {
    const label = nightLabel(night);
    const classes = ['night'];
    if ('inMonth' in night) {
      if (!night.inMonth) classes.push('is-outside');
      if (night.isPast) classes.push('is-past'); // its open tasks are overdue
    }
    if (night.isToday) classes.push('is-today');
    if (night.isWeekend) classes.push('is-weekend');
    if (night.date === selected) classes.push('is-selected');
    return (
      <li key={night.date}>
        <button className={classes.join(' ')} title={label} aria-pressed={night.date === selected} onClick={() => pick(night.date)}>
          {!monthOpen && <span className="night-weekday" aria-hidden="true">{night.weekday}</span>}
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
        </button>
      </li>
    );
  }

  return (
    <section className={monthOpen ? 'nights is-month' : 'nights'} aria-label="Calendar">
      <div className="nights-head">
        {monthOpen ? (
          <div className="month-nav">
            <button className="month-arrow" aria-label="Previous month" onClick={() => moveMonth(-1)}>‹</button>
            <h2 className="nights-title">{monthTitle.format(shown)}</h2>
            <button className="month-arrow" aria-label="Next month" onClick={() => moveMonth(1)}>›</button>
          </div>
        ) : (
          <h2 className="nights-title">Next 14 days</h2>
        )}
        {overdue > 0 && <p className="nights-overdue">{overdue} overdue</p>}
        <button className="nights-toggle" aria-expanded={monthOpen} onClick={toggleMonth}>
          {monthOpen ? '2 weeks' : 'Month'}
        </button>
      </div>
      {monthOpen ? (
        <>
          <p className="month-weekdays" aria-hidden="true">
            {WEEKDAYS.map((d) => <span key={d}>{d}</span>)}
          </p>
          <ol className="month-grid">
            {monthGrid(tasks, shown.getFullYear(), shown.getMonth(), now)
              .flat()
              .map(renderDay)}
          </ol>
        </>
      ) : (
        // Only this row scrolls sideways on a phone, never the page.
        <ol className="nights-row">{nights.map(renderDay)}</ol>
      )}
    </section>
  );
}
