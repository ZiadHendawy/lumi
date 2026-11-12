'use client';

import { STAGES, type Tally, type Turn, seconds, sessionSummary, shortModel, tallyTotal } from '@/lib/turns';

// The X-ray panel (press X): the deep dives, live, for whoever wants to see how it works. It only
// opens on request, so these engineering numbers never sit in a user's way. Where the last reply's
// time went, which model answered, how far the screen led the voice, the session so far, and the
// prompt exactly as the model reads it.
export function XRay(props: { turns: Turn[]; leads: number[]; tally: Tally; prompt: string | null; onClose: () => void }) {
  const last = props.turns[props.turns.length - 1];
  const s = sessionSummary(props.turns, props.leads, tallyTotal(props.tally), props.tally.restored);
  return (
    <aside className="xray" aria-label="X-ray: how Lumi works">
      <div className="xray-head">
        <h2>X-ray</h2>
        <button className="xray-close" onClick={props.onClose} aria-label="Close the X-ray panel">
          ×
        </button>
      </div>

      {last ? (
        <>
          <p className="xray-total">
            Last reply in <strong>{seconds(last.e2e_latency)}</strong>
            {last.model && <span className="xray-model">{shortModel(last.model)}</span>}
          </p>
          <ul className="xray-stages">
            {STAGES.map(({ key, label }) => {
              const value = last[key];
              // Each stage against the whole reply; they can overlap, so they aren't stacked.
              const width = value === null ? 0 : Math.min(100, (value / last.e2e_latency) * 100);
              return (
                <li key={key} className={value === null ? 'xray-stage is-skipped' : 'xray-stage'}>
                  <span className="xray-label">{label}</span>
                  <span className="xray-bar" style={{ width: `${width}%` }} />
                  <span className="xray-value">{seconds(value)}</span>
                </li>
              );
            })}
          </ul>
          <p className="xray-line">
            Screen ahead of voice: <strong>{seconds(last.board_lead)}</strong> (agent)
            {props.leads.length > 0 && (
              <>
                {' · '}
                <strong>{seconds(props.leads[props.leads.length - 1])}</strong> (this browser)
              </>
            )}
          </p>
          <h3 className="xray-subtitle">This session</h3>
          <ul className="xray-session">
            <li>
              {s.replies} {s.replies === 1 ? 'reply' : 'replies'}, median <strong>{seconds(s.medianReply)}</strong> to
              Lumi’s voice
            </li>
            <li>
              {s.changes} {s.changes === 1 ? 'change' : 'changes'}
              {s.undos > 0 && `, ${s.undos} undone`}, each read back from the database
            </li>
            {s.medianLead !== null && (
              <li>
                The board led the voice by <strong>{seconds(s.medianLead)}</strong> (median, this browser)
              </li>
            )}
            {s.models.length > 0 && <li>Answered by {s.models.map(shortModel).join(', then ')}</li>}
          </ul>
        </>
      ) : (
        <p className="xray-line">Talk to Lumi: each reply’s timings land here.</p>
      )}

      <details className="xray-prompt">
        <summary>What Lumi sees</summary>
        <p className="xray-note">
          The instructions sent with every request, re-rendered after each change. The model never has to
          remember the board: it reads it. (Plus the tool definitions and the last 20 chat items.)
        </p>
        <pre>{props.prompt ?? 'Waiting for Lumi to wake up…'}</pre>
      </details>
    </aside>
  );
}
