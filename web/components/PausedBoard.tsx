'use client';

import { useState } from 'react';
import Board from '@/components/Board';
import { demoBoard } from '@/lib/paused';

const REPO_URL = 'https://github.com/ZiadHendawy/lumi';
const PROMPT_URL = `${REPO_URL}/blob/main/agent/prompt.py`;

// Things a visitor could say, as the same chips the live dock shows.
const PHRASES = ['“Add a task to call mom tomorrow”', '“Make it high priority”', '“Find out what I need to renew my passport”'];

// The page while voice is paused (lib/paused.ts): the real board, drawn from a sample, with a
// dimmed lantern that says why it can't be tapped. It never connects, so it uses no quota.
export default function PausedBoard() {
  // Built once, so the board doesn't change under the visitor while they read it.
  const [sample] = useState(() => demoBoard(new Date()));

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

      <div className="dock" data-state="paused">
        <section className="paused-note" aria-label="Voice is paused">
          <p className="paused-title">This is a sample board</p>
          <p className="paused-text">
            Normally you tap the lantern and talk. Lumi changes the board as it answers out loud, and remembers what
            you tell it.{' '}
            <a href={REPO_URL} target="_blank" rel="noopener noreferrer">
              See how it’s built
            </a>
          </p>
          <p className="hints">
            <span className="hints-label">You could say</span>
            {PHRASES.map((p) => (
              <span key={p} className="hint">
                {p}
              </span>
            ))}
          </p>
        </section>
        <div className="lantern-row">
          {/* Not a button: there is nothing to tap. Same markup as the live lantern, so it looks the same. */}
          <div className="lantern" data-state="paused" aria-hidden="true">
            <span className="lantern-halo" />
            <span className="lantern-glass">
              <span className="lantern-flame" />
            </span>
          </div>
        </div>
        <p className="lantern-status" role="status">
          Voice is paused for now · back soon
        </p>
      </div>
    </>
  );
}
