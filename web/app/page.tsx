'use client';

import dynamic from 'next/dynamic';
import LanternMark from '@/components/LanternMark';
import { voicePaused } from '@/lib/paused';

// Client-only: the session reads the anonymous user id from localStorage, which
// doesn't exist during server rendering.
const VoiceSession = dynamic(() => import('@/components/VoiceSession'), { ssr: false });
// Client-only too: its sample dates are counted from the visitor's today, not the build's.
const PausedBoard = dynamic(() => import('@/components/PausedBoard'), { ssr: false });

// Written out in full so Next.js can copy the value in at build time.
const paused = voicePaused(process.env.NEXT_PUBLIC_VOICE_PAUSED);

export default function Page() {
  return (
    <main className="app">
      <header className="masthead">
        {/* The mark is aria-hidden, so the heading still reads as just "Lumi". */}
        <h1 className="wordmark">
          <LanternMark className="wordmark-lantern" />
          Lumi
        </h1>
        <p className="tagline">a task board you run by voice</p>
      </header>
      {/* Paused never connects, so a visit starts no room and no agent. */}
      {paused ? <PausedBoard /> : <VoiceSession />}
    </main>
  );
}
