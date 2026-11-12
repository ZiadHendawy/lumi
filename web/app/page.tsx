'use client';

import dynamic from 'next/dynamic';

// Client-only: the session reads the anonymous user id from localStorage, which
// doesn't exist during server rendering.
const VoiceSession = dynamic(() => import('@/components/VoiceSession'), { ssr: false });

export default function Page() {
  return (
    <main className="app">
      <header className="masthead">
        <h1 className="wordmark">Lumi</h1>
        <p className="tagline">a task board you run by voice</p>
      </header>
      <VoiceSession />
    </main>
  );
}
