'use client';

import dynamic from 'next/dynamic';

// Client-only: the session reads the anonymous user id from localStorage, which
// doesn't exist during server rendering.
const VoiceSession = dynamic(() => import('@/components/VoiceSession'), { ssr: false });

export default function Page() {
  return (
    <main>
      <h1>Lumi</h1>
      <VoiceSession />
    </main>
  );
}
