'use client';

import { useRef, useState } from 'react';
import { type Facts, factLabel } from '@/lib/board';

// One typed edit, sent to the agent on the `lumi.memory` RPC (agent/tools.py `edit_memory`).
export type MemoryEdit =
  | { action: 'remember'; key: string; value: string }
  | { action: 'forget'; key: string }
  | { action: 'forget_all' };

// The agent enforces these (config.py MAX_FACT_*); here they only stop typing early.
const MAX_KEY = 40;
const MAX_VALUE = 120;
const MAX_FACTS = 20;

type Props = {
  facts: Facts;
  changed: { keys: string[]; seq: number }; // lit by the latest push
  // Null while there is no agent to send an edit to: the agent is the only thing that
  // writes to the database, so the panel can show the facts but not change them.
  onEdit: ((edit: MemoryEdit) => Promise<void>) | null;
  onShowPrompt: () => void; // opens X-ray, where the prompt is shown as the model reads it
};

// The memory shelf, and the panel where the user sees, adds, changes and deletes what Lumi
// keeps about them. An edit is not applied here: it goes to the agent, which saves it and
// pushes the board back, so the chips always show what is stored, as they do for a spoken fact.
export default function Memory({ facts, changed, onEdit, onShowPrompt }: Props) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [label, setLabel] = useState('');
  const [value, setValue] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const keys = Object.keys(facts);

  async function send(edit: MemoryEdit) {
    if (!onEdit) return;
    setBusy(true);
    setError(null);
    try {
      await onEdit(edit);
      if (edit.action === 'remember') {
        setLabel('');
        setValue('');
      }
    } catch (e) {
      // The agent's refusal ("Keep a fact short…") arrives as the RPC error's message.
      setError(e instanceof Error && e.message ? e.message : 'That didn’t save. Try again.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="memory" aria-label="What Lumi remembers">
      <h2 className="memory-title">Lumi remembers</h2>
      {keys.length === 0 ? (
        <p className="memory-hint">nothing yet · say “my favorite color is blue”, or add it here</p>
      ) : (
        <ul className="memory-facts">
          {keys.map((key) => {
            const lit = changed.keys.includes(key);
            return (
              // A fresh key restarts the glow when the same fact changes twice in a row.
              <li key={lit ? `${key}-${changed.seq}` : key} className={lit ? 'fact is-lit' : 'fact'}>
                <span className="fact-key">{factLabel(key)}</span>
                <span className="fact-value">{facts[key]}</span>
              </li>
            );
          })}
        </ul>
      )}
      <button className="memory-open" onClick={() => dialog.current?.showModal()}>
        {keys.length === 0 ? 'Add' : 'Edit'}
      </button>

      {/* A native <dialog>, like Connections: focus trapping, Esc and the backdrop for free. */}
      <dialog
        ref={dialog}
        className="memory-panel"
        aria-labelledby="memory-panel-title"
        onClick={(e) => {
          if (e.target === e.currentTarget) dialog.current?.close();
        }}
      >
        <div className="memory-panel-inner">
          <header className="memory-panel-head">
            <h2 id="memory-panel-title" className="memory-panel-title">
              What Lumi remembers
            </h2>
            <button className="memory-panel-close" onClick={() => dialog.current?.close()}>
              Close
            </button>
          </header>

          {/* Transparency first: what is kept, where, who reads it, and how to remove it. */}
          <ul className="memory-panel-about">
            <li>Lumi reads these before every reply, so it can use them when you talk.</li>
            <li>They’re saved in Lumi’s database under this browser’s anonymous ID. Nothing else about you is kept, apart from your tasks.</li>
            <li>Add or change them here, or just say “remember that…” or “forget my…”.</li>
          </ul>
          <button
            className="memory-panel-link"
            // Closed first: a modal dialog sits above everything, the X-ray panel included.
            onClick={() => {
              dialog.current?.close();
              onShowPrompt();
            }}
          >
            See exactly what Lumi reads: X-ray, then “What Lumi sees”
          </button>

          {keys.length > 0 && (
            <ul className="memory-panel-facts">
              {keys.map((key) => (
                <li key={key}>
                  <span className="fact-key">{factLabel(key)}</span>
                  <span className="fact-value">{facts[key]}</span>
                  <button
                    className="memory-panel-small"
                    // Fills the form, so changing a fact is saving it again under the same name.
                    onClick={() => {
                      setLabel(factLabel(key));
                      setValue(facts[key]);
                    }}
                    disabled={!onEdit || busy}
                    aria-label={`Change ${factLabel(key)}`}
                  >
                    Change
                  </button>
                  <button
                    className="memory-panel-small"
                    onClick={() => send({ action: 'forget', key })}
                    disabled={!onEdit || busy}
                    aria-label={`Forget ${factLabel(key)}`}
                  >
                    Forget
                  </button>
                </li>
              ))}
            </ul>
          )}

          <form
            className="memory-panel-form"
            onSubmit={(e) => {
              e.preventDefault();
              send({ action: 'remember', key: label, value });
            }}
          >
            <label>
              <span>Name</span>
              <input value={label} onChange={(e) => setLabel(e.target.value)} maxLength={MAX_KEY} placeholder="home city" required />
            </label>
            <label>
              <span>Value</span>
              <input value={value} onChange={(e) => setValue(e.target.value)} maxLength={MAX_VALUE} placeholder="Riyadh" required />
            </label>
            <button type="submit" className="memory-panel-save" disabled={!onEdit || busy}>
              {busy ? 'Saving…' : 'Remember'}
            </button>
          </form>
          <p className="memory-panel-note" role="status">
            {error ??
              (onEdit
                ? `${keys.length} of ${MAX_FACTS}. Saving a name that exists replaces its value.`
                : 'Editing opens once Lumi is connected, because Lumi saves the change. If the session ended, tap the lantern.')}
          </p>

          {keys.length > 0 && (
            <button
              className="memory-panel-forget-all"
              disabled={!onEdit || busy}
              onClick={() => {
                if (confirm('Forget everything Lumi remembers about you? Your tasks stay.')) send({ action: 'forget_all' });
              }}
            >
              Forget everything
            </button>
          )}
        </div>
      </dialog>
    </section>
  );
}
