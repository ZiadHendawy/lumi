'use client';

import { useEffect, useRef, useState } from 'react';
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
import { SessionReceipt, XRay } from '@/components/XRay';
import {
  type Activity,
  type Facts,
  type RecentChange,
  type Task,
  activityText,
  addChange,
  applyActivity,
  changedFacts,
  describeFactChanges,
  loadCachedBoard,
  parseActivity,
  parseBoard,
  saveCachedBoard,
  splitLastWord,
  spokenTaskIds,
  suggestions,
  userCaption,
} from '@/lib/board';
import { type Turn, parseTurn } from '@/lib/turns';
import { getUserId } from '@/lib/userId';

const tokenSource = TokenSource.endpoint('/api/token');
const BOARD_TOPIC = 'lumi.board'; // must match the topic the agent sends on
const ACTIVITY_TOPIC = 'lumi.activity'; // which tool the agent is running
const TURN_TOPIC = 'lumi.turn'; // where the time went in each reply
const PROMPT_TOPIC = 'lumi.prompt'; // the instructions as the model reads them

type BoardState = {
  tasks: Task[];
  facts: Facts;
  recent: RecentChange[];
  // The facts the latest push changed, so only their chips light up; `seq` restarts the glow.
  factsChanged: { keys: string[]; seq: number; text: string[] };
  seq: number;
  live: boolean;
  // This session's tally for the receipt. Kept here so the updater below can count from
  // the previous board, and stays a pure function of it.
  changes: number;
  undos: number;
};

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
  const [running, setRunning] = useState<Activity[]>([]); // tools running right now

  // Start from the board cached on the last visit, so it's there during the agent's cold start.
  const [board, setBoard] = useState<BoardState>(() => {
    const cached = loadCachedBoard(userId);
    return {
      tasks: cached?.tasks ?? [],
      facts: cached?.facts ?? {},
      recent: [],
      factsChanged: { keys: [], seq: 0, text: [] },
      seq: 0,
      live: false,
      changes: 0,
      undos: 0,
    };
  });
  const [turns, setTurns] = useState<Turn[]>([]); // this session's replies, from the agent
  const [leads, setLeads] = useState<number[]>([]); // board ahead of voice, measured here
  const [prompt, setPrompt] = useState<string | null>(null);
  const [xray, setXray] = useState(false);
  const [spoken, setSpoken] = useState<number[]>([]); // tasks Lumi is talking about
  // When the last changed board arrived, until Lumi starts speaking about it.
  const boardAt = useRef<number | null>(null);

  // The agent sends the whole board as one JSON text stream after every change (and once when
  // we join). Registered before connecting so the first board can't arrive with no listener.
  // The handler stays on the Room object, so it survives an End + talk-again.
  useEffect(() => {
    const room = session.room;
    room.registerTextStreamHandler(BOARD_TOPIC, async (reader) => {
      const payload = parseBoard(await reader.readAll());
      if (!payload) return;
      saveCachedBoard(userId, payload.tasks, payload.facts);
      if (payload.change) boardAt.current = performance.now();
      setBoard((prev) => {
        const seq = prev.seq + 1;
        const recent = payload.change ? addChange(prev.recent, seq, payload.change, prev.tasks, payload.tasks) : prev.recent;
        // The first live push only replaces the cached copy: nothing was just remembered.
        const factsChanged = prev.live
          ? {
              keys: changedFacts(prev.facts, payload.facts),
              seq,
              text: describeFactChanges(prev.facts, payload.facts),
            }
          : prev.factsChanged;
        const factChanges = prev.live ? describeFactChanges(prev.facts, payload.facts).length : 0;
        return {
          tasks: payload.tasks,
          facts: payload.facts,
          recent,
          factsChanged,
          seq,
          live: true,
          changes: prev.changes + (payload.change ? 1 : 0) + factChanges,
          undos: prev.undos + (payload.change?.action === 'restored' ? 1 : 0),
        };
      });
    });
    // A tool starting or ending, so the screen can say what Lumi is doing during a slow one.
    room.registerTextStreamHandler(ACTIVITY_TOPIC, async (reader) => {
      const event = parseActivity(await reader.readAll());
      if (event) setRunning((prev) => applyActivity(prev, event));
    });
    // Each reply's timings and the prompt as the model reads it, for the X-ray panel.
    room.registerTextStreamHandler(TURN_TOPIC, async (reader) => {
      const turn = parseTurn(await reader.readAll());
      if (turn) setTurns((prev) => [...prev, turn]);
    });
    room.registerTextStreamHandler(PROMPT_TOPIC, async (reader) => {
      const text = await reader.readAll();
      try {
        setPrompt(JSON.parse(text).instructions ?? null);
      } catch {
        // A broken hint is just not shown.
      }
    });
    return () => {
      for (const topic of [BOARD_TOPIC, ACTIVITY_TOPIC, TURN_TOPIC, PROMPT_TOPIC]) room.unregisterTextStreamHandler(topic);
    };
  }, [session.room, userId]);

  // Tools only run while Lumi is thinking. Clearing on any other state means a lost
  // "ended" message (a dropped connection) can't leave a card shimmering forever.
  useEffect(() => {
    if (agent.state !== 'thinking') setRunning([]);
    // The screen-lead, measured where the user is: a changed board arriving -> Lumi's state
    // turning "speaking" (its state attribute, which travels with the audio). Listening means a
    // new turn has begun, so an old board time must not count against it.
    if (agent.state === 'speaking' && boardAt.current !== null) {
      const lead = (performance.now() - boardAt.current) / 1000;
      setLeads((prev) => [...prev, lead]);
    }
    if (agent.state === 'speaking' || agent.state === 'listening') boardAt.current = null;
  }, [agent.state]);


  // Connect (and dispatch the agent) on page load, so the cold start overlaps with the
  // user reading the page. The mic stays off until they tap the lantern.
  useEffect(() => {
    session.start({ tracks: { microphone: { enabled: false } } });
    return () => {
      session.end();
    };
  }, []); // eslint-disable-line -- run once per page load, not on every session object change

  // The board calls these when an animation ends, so each change leaves the screen on its own time.
  function ghostGone(seq: number) {
    setBoard((prev) => ({ ...prev, recent: prev.recent.map((r) => (r.seq === seq ? { ...r, ghost: null } : r)) }));
  }
  function receiptDone(seq: number) {
    setBoard((prev) => ({ ...prev, recent: prev.recent.filter((r) => r.seq !== seq) }));
  }

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
    // A new session starts a new receipt.
    setTurns([]);
    setLeads([]);
    setBoard((prev) => ({ ...prev, changes: 0, undos: 0 }));
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

  // The tab says what Lumi is doing, so a session in a background tab isn't forgotten.
  useEffect(() => {
    document.title = state === 'listening' || state === 'thinking' || state === 'speaking' ? `${STATUS_TEXT[state]} · Lumi` : 'Lumi';
  }, [state]);

  const talking = state === 'listening' || state === 'thinking' || state === 'speaking' || state === 'muted';
  const onLanternClick = state === 'ready' ? startTalking : state === 'ended' || state === 'failed' ? wakeAgain : undefined;

  // Keyboard: Space does what the lantern does (start, or mute and unmute while talking), Esc
  // ends the session, X opens the X-ray panel. Ignored with a modifier (browser shortcuts), on a
  // focused control (Space already clicks it) and while the Connections dialog is open.
  // Re-registered each render, so it always sees the current state.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.metaKey || e.ctrlKey || e.altKey || e.repeat) return;
      if (e.target instanceof HTMLElement && e.target.closest('button, a, input, textarea, dialog')) return;
      if (e.key === ' ') {
        e.preventDefault(); // otherwise the page scrolls
        if (talking) toggleMute();
        else onLanternClick?.();
      } else if (e.key === 'Escape' && talking) {
        session.end();
      } else if (e.key.toLowerCase() === 'x') {
        setXray((open) => !open);
      }
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  // The lantern pulses with whoever is talking: the user's mic while listening, Lumi's voice while speaking.
  const volumeTrack =
    state === 'listening' ? session.local.microphoneTrack : state === 'speaking' ? agent.microphoneTrack : undefined;

  return (
    <SessionProvider session={session}>
      <RoomAudioRenderer />
      {/* The warm light the lantern casts on the page; its strength follows the lantern state in CSS. */}
      <div className="room-light" data-state={state} aria-hidden="true" />

      <Board
        tasks={board.tasks}
        facts={board.facts}
        factsChanged={board.factsChanged}
        recent={board.recent}
        seq={board.seq}
        live={board.live}
        working={running}
        // Only while Lumi's voice is playing: the caption stays up afterwards, the spotlight doesn't.
        spoken={state === 'speaking' ? spoken : []}
        onGhostGone={ghostGone}
        onReceiptDone={receiptDone}
      />

      <button
        className="xray-toggle"
        onClick={() => setXray(!xray)}
        aria-pressed={xray}
        title="How Lumi works, live (X). Space talks or mutes, Esc ends."
      >
        X-ray
      </button>
      {xray && <XRay turns={turns} leads={leads} prompt={prompt} onClose={() => setXray(false)} />}

      <div className="dock" data-state={state}>
        {state === 'ended' ? (
          <SessionReceipt turns={turns} leads={leads} changes={board.changes} undos={board.undos} />
        ) : (
          <Captions
            session={session}
            tasks={board.tasks}
            onSpoken={setSpoken}
            // Ideas for what to say before the user has said anything. An empty board lists its own.
            hints={
              (state === 'ready' || state === 'listening') && board.tasks.length > 0
                ? suggestions(board.tasks, board.facts, new Date())
                : []
            }
          />
        )}
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
          {error ?? (state === 'thinking' ? activityText(running) : null) ?? STATUS_TEXT[state]}
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

// The user's latest turn (dim) and Lumi's current line (bright), so a misheard word is easy to spot.
// Lumi's line arrives in step with the audio (LiveKit syncs the transcript to the speech), so its
// last word is the one being spoken: it gets the highlight, and the tasks named so far light up.
function Captions(props: {
  session: UseSessionReturn;
  tasks: Task[];
  onSpoken: (ids: number[]) => void;
  hints: string[];
}) {
  const { session, tasks, onSpoken, hints } = props;
  const { messages } = useSessionMessages(session);
  const user = userCaption(messages);
  const userAt = messages.findLastIndex((m) => m.type === 'userTranscript');
  const lumiAt = messages.findLastIndex((m) => m.type === 'agentTranscript');
  // Hide Lumi's previous reply once the user has said something newer; it would read as an answer.
  const lumi = lumiAt > userAt ? messages[lumiAt] : undefined;
  const ids = lumi ? spokenTaskIds(lumi.message, tasks) : [];
  const idsKey = ids.join(',');
  // Tell the board only when the set changes, not on every word.
  useEffect(() => {
    onSpoken(idsKey ? idsKey.split(',').map(Number) : []);
  }, [idsKey, onSpoken]);
  const [said, now] = splitLastWord(lumi?.message ?? '');
  return (
    <div className="captions" aria-live="polite">
      {!user && !lumi && hints.length > 0 && (
        <p className="hints">
          <span className="hints-label">Try</span>
          {hints.map((h) => (
            <span key={h} className="hint">
              {h}
            </span>
          ))}
        </p>
      )}
      {user && (
        <p key={user.id} className="caption caption-user">
          {user.text}
        </p>
      )}
      {lumi && (
        <p key={lumi.id} className="caption caption-lumi">
          <span>
            {said}
            <span className="word-now">{now}</span>
          </span>
        </p>
      )}
    </div>
  );
}
