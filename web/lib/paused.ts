// Paused mode: voice switched off with NEXT_PUBLIC_VOICE_PAUSED=1, so the public link can't use
// the LiveKit, Deepgram and Groq free tiers (they are shared with another demo). The page shows a
// sample board instead, and /api/token refuses, so no room and no agent are started.
// No React here, so each function can be tested on its own (lib/paused.test.ts).
import { type Facts, type Task, isoDay } from './board.ts';

// One name for both sides. NEXT_PUBLIC_ means Next.js copies it into the page at build time,
// and the server reads the same name, so the page and the token route can't disagree.
// Changing it on Vercel takes a redeploy, which is fine for a switch flipped once.
export function voicePaused(value: string | undefined): boolean {
  return value === '1' || value === 'true';
}

// A board that shows what Lumi does: every lane, a done task, a web-search note with its source
// chip, and remembered facts. Dates are counted from `now`, so it never turns "Overdue".
export function demoBoard(now: Date): { tasks: Task[]; facts: Facts } {
  const day = (offset: number) => isoDay(new Date(now.getFullYear(), now.getMonth(), now.getDate() + offset));
  const updated_at = now.toISOString();
  const task = (id: number, title: string, priority: Task['priority'], offset: number | null, body = '', done = false): Task => ({
    id,
    title,
    body,
    priority,
    target_date: offset === null ? null : day(offset),
    done,
    updated_at,
  });
  return {
    tasks: [
      task(1, 'Call the bank about the card', 'high', 0, 'Ask why Tuesday’s payment was declined.'),
      task(2, 'Book a dentist appointment', 'medium', 1),
      task(3, 'Buy a laptop stand', 'medium', 3, 'Adjustable height, under 150 SAR. Sources: https://www.ikea.com/sa/en/'),
      task(4, 'Plan the weekend trip to AlUla', 'low', 9, 'Check the weather first.'),
      task(5, 'Read about voice agent latency', 'low', null),
      task(6, 'Send the invoice to Sara', 'high', 0, '', true),
    ],
    facts: { home_city: 'Riyadh', favorite_coffee: 'flat white', work_hours: '9 to 5' },
  };
}
