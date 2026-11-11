'use client';

import { useEffect, useState } from 'react';
import { TokenSource } from 'livekit-client';
import { RoomAudioRenderer, SessionProvider, useAgent, useSession } from '@livekit/components-react';
import { getUserId } from '@/lib/userId';

const tokenSource = TokenSource.endpoint('/api/token');

// Placeholder UI for M0: proves the loop works. The real look is decided at the end of M0.
export default function VoiceSession() {
  const [userId] = useState(getUserId);
  const session = useSession(tokenSource, {
    participantIdentity: userId,
    agentName: 'lumi',
    // The free LiveKit Cloud agent scales to zero; a cold start can take 10-20 s.
    agentConnectTimeoutMilliseconds: 45_000,
  });
  const agent = useAgent(session);
  const [started, setStarted] = useState(false);

  // Connect (and dispatch the agent) on page load, so the cold start overlaps with the
  // user reading the page. The mic stays off until they click Start.
  useEffect(() => {
    session.start({ tracks: { microphone: { enabled: false } } });
    return () => {
      session.end();
    };
  }, []); // eslint-disable-line -- run once per page load, not on every session object change

  async function start() {
    // Browsers only allow audio playback after a user gesture, so this must run on click.
    await session.room.startAudio();
    await session.room.localParticipant.setMicrophoneEnabled(true);
    await session.room.localParticipant.performRpc({
      destinationIdentity: agent.identity!,
      method: 'lumi.start',
      payload: '',
    });
    setStarted(true);
  }

  let status: string;
  if (agent.state === 'failed') status = 'Lumi could not wake up. Refresh to try again.';
  else if (agent.isFinished) status = 'Session ended. Refresh to talk again.';
  else if (!agent.isConnected) status = 'Lumi is waking up…';
  else if (!started) status = 'Lumi is ready.';
  else status = agent.state; // listening | thinking | speaking

  return (
    <SessionProvider session={session}>
      <RoomAudioRenderer />
      <p className="status">{status}</p>
      {agent.isConnected && !started && <button onClick={start}>Start talking</button>}
      {started && !agent.isFinished && <button onClick={() => session.end()}>End</button>}
    </SessionProvider>
  );
}
