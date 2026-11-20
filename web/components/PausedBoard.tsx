'use client';

import { useEffect, useRef, useState } from 'react';
import Board from '@/components/Board';
import { demoBoard } from '@/lib/paused';

const REPO_URL = 'https://github.com/ZiadHendawy/lumi';
const PROMPT_URL = `${REPO_URL}/blob/main/agent/prompt.py`;

// Things a visitor could say, as the same chips the live dock shows.
const PHRASES = ['“Add a task to call mom tomorrow”', '“Make it high priority”', '“Find out what I need to renew my passport”'];

// The page while voice is paused (lib/paused.ts): the real board, drawn from a sample, and a
// popup that says so before anyone tries the lantern. It never connects, so it uses no quota.
export default function PausedBoard() {
  // Built once, so the board doesn't change under the visitor while they read it.
  const [sample] = useState(() => demoBoard(new Date()));
  // A native <dialog>, like Memory and Connections: focus trapping, Esc and the backdrop for free.
  const dialog = useRef<HTMLDialogElement>(null);

  // Open on arrival: a status line under the lantern was easy to miss, and a dim lantern that
  // does nothing looks broken.
  useEffect(() => {
    dialog.current?.showModal();
  }, []);

  return (
    <>
      <div className="room-light" data-state="paused" aria-hidden="true" />

      <Board
        tasks={sample.tasks}
        facts={sample.facts}
        factsChanged={{ keys: [], seq: 0, text: [] }}
        recent={[]}
        seq={0}
        live
        working={[]}
        spoken={[]}
        onGhostGone={() => {}}
        onReceiptDone={() => {}}
        // The memory panel shows this as its error, so an edit explains itself instead of doing nothing.
        onEditMemory={async () => {
          throw new Error('Voice is paused, so Lumi can’t save changes right now.');
        }}
        // There is no live prompt to show, so "see what Lumi reads" opens the code that writes it.
        onShowPrompt={() => window.open(PROMPT_URL, '_blank', 'noopener,noreferrer')}
      />

      <dialog
        ref={dialog}
        className="paused-dialog"
        aria-labelledby="paused-title"
        onClick={(e) => {
          if (e.target === e.currentTarget) dialog.current?.close();
        }}
      >
        <div className="paused-inner">
          <h2 id="paused-title" className="paused-title">
            Voice is paused for now
          </h2>
          <p className="paused-text">
            Lumi is a task board you run by voice: you talk, and the board changes while Lumi answers out loud.
          </p>
          <p className="paused-text">
            Voice is switched off for a few days, so this is a <strong>sample board</strong> you can look around. Back
            soon.
          </p>
          <p className="hints">
            <span className="hints-label">You could say</span>
            {PHRASES.map((p) => (
              <span key={p} className="hint">
                {p}
              </span>
            ))}
          </p>
          <div className="paused-actions">
            {/* autoFocus: the dialog focuses this on open, so Enter or Space gets straight to the board. */}
            <button className="paused-ok" onClick={() => dialog.current?.close()} autoFocus>
              Look around
            </button>
            <a className="paused-link" href={REPO_URL} target="_blank" rel="noopener noreferrer">
              See how it’s built
            </a>
          </div>
        </div>
      </dialog>

      <div className="dock" data-state="paused">
        <div className="lantern-row">
          {/* Same markup as the live lantern, so it looks the same. Tapping it says why it's dim. */}
          <button
            className="lantern"
            data-state="paused"
            onClick={() => dialog.current?.showModal()}
            aria-label="Why voice is paused"
          >
            <span className="lantern-halo" />
            <span className="lantern-glass">
              <span className="lantern-flame" />
            </span>
          </button>
        </div>
        <p className="lantern-status">Voice paused · tap the lantern</p>
      </div>
    </>
  );
}
