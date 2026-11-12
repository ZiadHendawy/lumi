'use client';

import { useEffect, useState } from 'react';
import { TokenSource } from 'livekit-client';
import {
  RoomAudioRenderer,
  SessionProvider,
  type TrackReference,
  type UseSessionReturn,
  useAgent,
  useSession,
  useSessionMessages,
  useTrackVolume,
} from '@livekit/components-react';
import Board from '@/components/Board';
import { type Change, type Task, loadCachedTasks, parseBoard, saveCachedTasks } from '@/lib/board';
import { getUserId } from '@/lib/userId';

const tokenSource = TokenSource.endpoint('/api/token');
const BOARD_TOPIC = 'lumi.board'; // must match the topic the agent sends on

type BoardState = { tasks: Task[]; change: Change | null; seq: number; ghost: Task | null; live: boolean };

type LanternState =
  | 'waking'
  | 'ready'
  | 'starting'
  | 'listening'
  | 'thinking'
  | 'speaking'
  | 'muted'
  | 'ended'
  | 'failed';

const STATUS_TEXT: Record<LanternState, string> = {
  waking: 'Lumi is waking up…',
  ready: 'Tap the lantern to talk',
  starting: 'Lighting the lantern…',
  listening: 'Listening',
  thinking: 'Thinking',
  speaking: 'Lumi is speaking',
  muted: 'Muted — Lumi can’t hear you',
  ended: 'Session ended · tap to talk again',
  failed: 'Lumi couldn’t wake up · tap to try again',
};

export default function VoiceSession() {
  const [userId] = useState(getUserId);
  const session = useSession(tokenSource, {
    participantIdentity: userId,
    agentName: 'lumi',
    // The free LiveKit Cloud agent scales to zero; a cold start can take 10-20 s.
    agentConnectTimeoutMilliseconds: 45_000,
  });
  const agent = useAgent(session);
  // idle: connected but not talking yet; starting: the click is in flight; talking: mic is live.
  const [phase, setPhase] = useState<'idle' | 'starting' | 'talking'>('idle');
  const [muted, setMuted] = useState(false);
  const [error, setError] = useState<string | null>(null);

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
  // user reading the page. The mic stays off until they tap the lantern.
  useEffect(() => {
    session.start({ tracks: { microphone: { enabled: false } } });
    return () => {
      session.end();
    };
  }, []); // eslint-disable-line -- run once per page load, not on every session object change

  async function startTalking() {
    setPhase('starting');
    setError(null);
    try {
      // Browsers only allow audio playback after a user gesture, so this must run on click.
      await session.room.startAudio();
      await session.room.localParticipant.setMicrophoneEnabled(true);
      // Tells the agent to greet; it also needs the user's time zone to resolve "tomorrow".
      await session.room.localParticipant.performRpc({
        destinationIdentity: agent.identity!,
        method: 'lumi.start',
        payload: JSON.stringify({ timezone: Intl.DateTimeFormat().resolvedOptions().timeZone }),
      });
      setMuted(false);
      setPhase('talking');
    } catch {
      setError('Couldn’t start. Allow the microphone, then tap again.');
      setPhase('idle');
    }
  }

  // A fresh room and a fresh agent, without reloading the page. The user taps once more when it's ready.
  async function wakeAgain() {
    setPhase('idle');
    setError(null);
    await session.end();
    await session.start({ tracks: { microphone: { enabled: false } } });
  }

  async function toggleMute() {
    await session.room.localParticipant.setMicrophoneEnabled(muted);
    setMuted(!muted);
  }

  let state: LanternState;
  if (agent.state === 'failed') state = 'failed';
  else if (phase === 'talking' && agent.isFinished) state = 'ended';
  else if (!agent.isConnected) state = 'waking';
  else if (phase === 'starting') state = 'starting';
  else if (phase === 'idle') state = 'ready';
  else if (muted) state = 'muted';
  else state = agent.state; // listening | thinking | speaking

  const talking = state === 'listening' || state === 'thinking' || state === 'speaking' || state === 'muted';
  const onLanternClick = state === 'ready' ? startTalking : state === 'ended' || state === 'failed' ? wakeAgain : undefined;
  // The lantern pulses with whoever is talking: the user's mic while listening, Lumi's voice while speaking.
  const volumeTrack =
    state === 'listening' ? session.local.microphoneTrack : state === 'speaking' ? agent.microphoneTrack : undefined;

  return (
    <SessionProvider session={session}>
      <RoomAudioRenderer />
      {/* The warm light the lantern casts on the page; its strength follows the lantern state in CSS. */}
      <div className="room-light" data-state={state} aria-hidden="true" />

      <Board tasks={board.tasks} change={board.change} seq={board.seq} ghost={board.ghost} live={board.live} />

      <div className="dock" data-state={state}>
        <Captions session={session} />
        <div className="lantern-row">
          <Lantern state={state} track={volumeTrack} onClick={onLanternClick} />
          {talking && (
            <div className="controls">
              <button className="control" onClick={toggleMute} aria-pressed={muted}>
                {muted ? 'Unmute' : 'Mute'}
              </button>
              <button className="control" onClick={() => session.end()}>
                End
              </button>
            </div>
          )}
        </div>
        <p className="lantern-status" role="status">
          {error ?? STATUS_TEXT[state]}
        </p>
      </div>
    </SessionProvider>
  );
}

// What tapping the lantern does, for screen readers. In other states the button is disabled.
const LANTERN_LABELS: Partial<Record<LanternState, string>> = {
  ready: 'Start talking to Lumi',
  ended: 'Wake Lumi again',
  failed: 'Wake Lumi again',
};

// Its own component because the volume updates ~30 times a second; only the lantern re-renders, not the board.
function Lantern(props: { state: LanternState; track?: TrackReference; onClick?: () => void }) {
  const volume = useTrackVolume(props.track);
  // Speech sits around 0.1-0.4; stretch it so a normal voice visibly moves the flame.
  const level = Math.min(1, volume * 2.5);
  return (
    <button
      className="lantern"
      data-state={props.state}
      style={{ '--level': level } as React.CSSProperties}
      onClick={props.onClick}
      disabled={!props.onClick}
      aria-label={LANTERN_LABELS[props.state] ?? 'Lumi’s lantern'}
    >
      <span className="lantern-halo" />
      <span className="lantern-glass">
        <span className="lantern-flame" />
      </span>
    </button>
  );
}

// The latest thing the user said (dim) and Lumi's current line (bright), so a misheard word is easy to spot.
function Captions({ session }: { session: UseSessionReturn }) {
  const { messages } = useSessionMessages(session);
  const userAt = messages.findLastIndex((m) => m.type === 'userTranscript');
  const lumiAt = messages.findLastIndex((m) => m.type === 'agentTranscript');
  const user = messages[userAt];
  // Hide Lumi's previous reply once the user has said something newer; it would read as an answer.
  const lumi = lumiAt > userAt ? messages[lumiAt] : undefined;
  return (
    <div className="captions" aria-live="polite">
      {user && (
        <p key={user.id} className="caption caption-user">
          {user.message}
        </p>
      )}
      {lumi && (
        <p key={lumi.id} className="caption caption-lumi">
          {lumi.message}
        </p>
      )}
    </div>
  );
}
