'use client';

import dynamic from 'next/dynamic';
import LanternMark from '@/components/LanternMark';

// Client-only: the session reads the anonymous user id from localStorage, which
// doesn't exist during server rendering.
const VoiceSession = dynamic(() => import('@/components/VoiceSession'), { ssr: false });

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
      <VoiceSession />
    </main>
  );
}
