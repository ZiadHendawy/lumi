'use client';

import { useEffect, useState } from 'react';
import { TokenSource } from 'livekit-client';
import { RoomAudioRenderer, SessionProvider, useAgent, useSession } from '@livekit/components-react';
import Board from '@/components/Board';
import { type Change, type Task, loadCachedTasks, parseBoard, saveCachedTasks } from '@/lib/board';
import { getUserId } from '@/lib/userId';

const tokenSource = TokenSource.endpoint('/api/token');
const BOARD_TOPIC = 'lumi.board'; // must match the topic the agent sends on

type BoardState = { tasks: Task[]; change: Change | null; seq: number; ghost: Task | null; live: boolean };

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

  // Start from the board cached on the last visit, so it's there during the agent's cold start.
  const [board, setBoard] = useState<BoardState>(() => ({
    tasks: loadCachedTasks(userId) ?? [],
    change: null,
    seq: 0,
    ghost: null,
    live: false,
  }));

  // The agent sends the whole board as one JSON text stream after every change (and once when
  // we join). Registered before connecting so the first board can't arrive with no listener.
  // The handler stays on the Room object, so it survives an End + talk-again.
  useEffect(() => {
    const room = session.room;
    room.registerTextStreamHandler(BOARD_TOPIC, async (reader) => {
      const payload = parseBoard(await reader.readAll());
      if (!payload) return;
      saveCachedTasks(userId, payload.tasks);
      setBoard((prev) => {
        const change = payload.change;
        // A deleted task is no longer in `tasks`; keep its last copy so it can animate out.
        const ghost = change?.action === 'deleted' ? (prev.tasks.find((t) => t.id === change.task_id) ?? null) : null;
        return { tasks: payload.tasks, change, ghost, seq: prev.seq + 1, live: true };
      });
    });
    return () => room.unregisterTextStreamHandler(BOARD_TOPIC);
  }, [session.room, userId]);

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
    // Tells the agent to greet; it also needs the user's time zone to resolve "tomorrow".
    await session.room.localParticipant.performRpc({
      destinationIdentity: agent.identity!,
      method: 'lumi.start',
      payload: JSON.stringify({ timezone: Intl.DateTimeFormat().resolvedOptions().timeZone }),
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
      <Board tasks={board.tasks} change={board.change} seq={board.seq} ghost={board.ghost} live={board.live} />
      {/* Interim controls; the lantern replaces them. */}
      <div className="session-bar">
        <p className="status">{status}</p>
        {agent.isConnected && !started && <button onClick={start}>Start talking</button>}
        {started && !agent.isFinished && <button onClick={() => session.end()}>End</button>}
      </div>
    </SessionProvider>
  );
}
