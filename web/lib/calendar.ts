// Taking dated tasks to a calendar without OAuth: a prefilled Google Calendar link per task,
// and an .ics file of the whole board that Apple Calendar, Outlook and Google Calendar import.
// Both are built in the browser, so there is no sign-in, no token to store and no new service.
// No React here, so each function can be tested on its own (lib/calendar.test.ts).
import type { Task } from './board';

// A task has a day but no time, so every calendar entry is an all-day event. Calendars treat an
// all-day event's end as exclusive (the event ends at the start of that day), so a one-day event
// ends on the next day. Date.UTC rolls 30 Nov + 1 over to 1 Dec and 31 Dec over to 1 Jan, and
// UTC has no daylight-saving hour that could shift the day.
function nextDay(date: string): string {
  const [y, m, d] = date.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d + 1)).toISOString().slice(0, 10);
}

// 'YYYY-MM-DD' to the 'YYYYMMDD' both formats use for a whole day.
const compact = (date: string) => date.replaceAll('-', '');

const PRIORITY_WORDS = { high: 'High', medium: 'Medium', low: 'Low' };

// The event's description: the priority (a calendar has no glow), then the task's notes.
function details(task: Task): string {
  const line = `${PRIORITY_WORDS[task.priority]} priority, from Lumi.`;
  return task.body ? `${line}\n\n${task.body}` : line;
}

// The open tasks that can go on a calendar: done tasks are finished and undated ones have no day.
export function calendarTasks(tasks: Task[]): Task[] {
  return tasks.filter((t) => !t.done && t.target_date);
}

// Google's "add event" page, prefilled; the user still presses Save, so nothing is written for them.
// Google doesn't officially document this URL, but it is widely used, and third-party write-ups
// agree that an all-day event is `dates=YYYYMMDD/YYYYMMDD` with the day after as the end.
// Google reads `details` as basic HTML, so a "<" in the notes may be taken as markup.
// Returns null for a task with no date, which has nothing to put on a calendar.
export function googleCalendarUrl(task: Task): string | null {
  if (!task.target_date) return null;
  const params = new URLSearchParams({
    action: 'TEMPLATE',
    text: task.title,
    dates: `${compact(task.target_date)}/${compact(nextDay(task.target_date))}`,
    details: details(task),
  });
  return `https://calendar.google.com/calendar/render?${params}`;
}

// --- .ics (RFC 5545 iCalendar)

// TEXT values escape backslash first (so the escapes added after it aren't doubled), then the
// separators ";" and ",", and turn each line break into the two characters "\n".
function escapeText(text: string): string {
  return text
    .replaceAll('\\', '\\\\')
    .replaceAll(';', '\\;')
    .replaceAll(',', '\\,')
    .replace(/\r\n|\r|\n/g, '\\n');
}

const utf8 = new TextEncoder();

// RFC 5545 caps a line at 75 octets (bytes, not characters); a longer one continues on the next
// line after a single space, which readers remove. Counting each character's UTF-8 bytes means
// Arabic or an emoji (2-4 bytes) is never cut in half. Continuation lines hold 74 more octets
// because the leading space is one of their 75.
function fold(line: string): string {
  const lines: string[] = [];
  let current = '';
  let octets = 0;
  for (const char of line) {
    const size = utf8.encode(char).length;
    if (octets + size > 75) {
      lines.push(current);
      current = ' ';
      octets = 1;
    }
    current += char;
    octets += size;
  }
  lines.push(current);
  return lines.join('\r\n');
}

// One all-day VEVENT per open dated task. `now` is the DTSTAMP (when the file was made), passed
// in so tests are repeatable. The UID is stable per task, so apps that honour it update the same
// event when the file is imported again instead of adding a copy.
export function boardToIcs(tasks: Task[], now: Date): string {
  // '2026-11-12T15:30:00.000Z' to '20261112T153000Z', the UTC form DTSTAMP requires.
  const stamp = now.toISOString().replace(/[-:]/g, '').slice(0, 15) + 'Z';
  const lines = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Lumi//Task board//EN', 'CALSCALE:GREGORIAN'];
  for (const task of calendarTasks(tasks)) {
    const day = task.target_date as string; // calendarTasks keeps only dated tasks
    lines.push(
      'BEGIN:VEVENT',
      `UID:task-${task.id}@lumi`,
      `DTSTAMP:${stamp}`,
      `DTSTART;VALUE=DATE:${compact(day)}`,
      `DTEND;VALUE=DATE:${compact(nextDay(day))}`,
      `SUMMARY:${escapeText(task.title)}`,
      `DESCRIPTION:${escapeText(details(task))}`,
      'END:VEVENT',
    );
  }
  lines.push('END:VCALENDAR');
  // The format requires CRLF after every line, the last one included.
  return lines.map(fold).join('\r\n') + '\r\n';
}
