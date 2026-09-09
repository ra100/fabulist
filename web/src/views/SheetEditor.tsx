/**
 * Editable identity, contract (vows/drives) and voice — the read-only half of
 * §11's "editable, with lock toggles per field" gap. `AppearanceEditor`
 * (`Illustration.tsx`) already covers the visual half; this covers the
 * rest, including vows, which is the one field the integrity gate actually
 * enforces and so the one most worth being able to fix by hand when the
 * extractor got it wrong.
 *
 * Same on-blur-saves-immediately shape as `AppearanceEditor`: no separate
 * save button, no draft state that can be lost by navigating away. Vow rows
 * are the exception — add/remove/toggle-broken write immediately since
 * there is no natural "blur" for a button.
 */
import { useState } from 'react';
import { api, type Sheet, type Vow } from '../api.ts';

const list = (s: string) => s.split(';').map((x) => x.trim()).filter(Boolean);

/** A blur-to-save text field, the same contract `AppearanceEditor`'s rows use. */
function TextField({
  label, value, placeholder, onSave, multiline,
}: { label: string; value: string; placeholder?: string; onSave: (v: string) => void; multiline?: boolean }) {
  const [v, setV] = useState(value);
  return (
    <label className="field-row block">
      <span>{label}</span>
      {multiline ? (
        <textarea rows={2} value={v} placeholder={placeholder} onChange={(e) => setV(e.target.value)} onBlur={() => onSave(v)} />
      ) : (
        <input value={v} placeholder={placeholder} onChange={(e) => setV(e.target.value)} onBlur={() => onSave(v)} />
      )}
    </label>
  );
}

/** A `;`-joined list field, the same convention `AppearanceEditor`'s `markers` row uses. */
function ListField({
  label, value, placeholder, onSave,
}: { label: string; value: string[]; placeholder?: string; onSave: (v: string[]) => void }) {
  const [v, setV] = useState(value.join('; '));
  return (
    <label className="field-row block">
      <span>{label}</span>
      <input value={v} placeholder={placeholder} onChange={(e) => setV(e.target.value)} onBlur={() => onSave(list(v))} />
    </label>
  );
}

/** Newline-separated, unlike `ListField`'s `;` join: sample dialogue lines are prose and may contain semicolons themselves. */
function LinesField({
  label, value, placeholder, onSave,
}: { label: string; value: string[]; placeholder?: string; onSave: (v: string[]) => void }) {
  const [v, setV] = useState(value.join('\n'));
  return (
    <label className="field-row block">
      <span>{label}</span>
      <textarea
        rows={3} value={v} placeholder={placeholder}
        onChange={(e) => setV(e.target.value)}
        onBlur={() => onSave(v.split('\n').map((x) => x.trim()).filter(Boolean))}
      />
    </label>
  );
}

/** One vow row: rank and broken-toggle write immediately, text is blur-to-save like every other field here. */
function VowRow({
  vow, currentScene, onSave, onRemove,
}: { vow: Vow; currentScene: number; onSave: (v: Vow) => void; onRemove: () => void }) {
  const [text, setText] = useState(vow.text);
  return (
    <div className="row">
      <button
        className={vow.broken ? 'primary' : ''}
        title={vow.broken ? 'mark held again' : 'mark broken'}
        onClick={() => onSave({ ...vow, broken: !vow.broken, brokenScene: vow.broken ? null : currentScene })}
      >
        {vow.broken ? 'broken' : 'held'}
      </button>
      <input
        className="mono"
        style={{ width: '3rem', flexShrink: 0 }}
        type="number" min={1} value={vow.rank}
        aria-label={`rank for ${vow.text || 'this vow'}`}
        onChange={(e) => onSave({ ...vow, rank: Number(e.target.value) || vow.rank })}
      />
      <input
        className="grow"
        value={text}
        placeholder="what they will not do"
        aria-label="vow text"
        onChange={(e) => setText(e.target.value)}
        onBlur={() => { if (text !== vow.text) onSave({ ...vow, text }); }}
      />
      <button aria-label={`remove vow: ${vow.text || 'untitled'}`} onClick={onRemove}>
        ×
      </button>
    </div>
  );
}

export function SheetEditor({ sheet, currentScene, onSaved }: { sheet: Sheet; currentScene: number; onSaved: (s: Sheet) => void }) {
  async function save(patch: Partial<Sheet>) {
    onSaved(await api.saveSheet(sheet.entityId, patch));
  }

  const vows = sheet.contract.vows;
  function saveVows(next: Vow[]) {
    return save({ contract: { ...sheet.contract, vows: next } });
  }

  return (
    <div className="sheet-editor">
      <h3 className="eyebrow rule">vows</h3>
      <div className="small dimmer" style={{ marginBottom: 'var(--s2)' }}>
        Ranked hard lines — 1 is most inviolable. This is what the integrity gate defends.
      </div>
      <div className="vows">
        {[...vows].sort((a, b) => a.rank - b.rank).map((v) => (
          <VowRow key={v.id} vow={v} currentScene={currentScene} onSave={(next) => saveVows(vows.map((x) => (x.id === v.id ? next : x)))} onRemove={() => saveVows(vows.filter((x) => x.id !== v.id))} />
        ))}
        <button
          onClick={() =>
            saveVows([
              ...vows,
              { id: `vow:${Date.now().toString(36)}`, text: '', rank: vows.length + 1, broken: false, brokenScene: null },
            ])
          }
        >
          add a vow
        </button>
        {vows.length === 0 ? (
          <p className="hint warn">Without any vows the integrity gate has nothing to defend.</p>
        ) : null}
      </div>

      <TextField label="breaking point" value={sheet.contract.breakingPoint} placeholder="what would actually break them"
        onSave={(v) => save({ contract: { ...sheet.contract, breakingPoint: v } })} />
      <TextField label="cost of break" value={sheet.contract.costOfBreak} placeholder="what it costs them to cross a vow"
        onSave={(v) => save({ contract: { ...sheet.contract, costOfBreak: v } })} />
      <ListField label="drives" value={sheet.contract.drives} placeholder="what pushes them forward — separated by ;"
        onSave={(v) => save({ contract: { ...sheet.contract, drives: v } })} />

      <h3 className="eyebrow rule" style={{ marginTop: 'var(--s4)' }}>identity</h3>
      <ListField label="goals" value={sheet.identity.goals} placeholder="separated by ;" onSave={(v) => save({ identity: { ...sheet.identity, goals: v } })} />
      <ListField label="wounds" value={sheet.identity.wounds} placeholder="separated by ;" onSave={(v) => save({ identity: { ...sheet.identity, wounds: v } })} />
      <ListField label="fears" value={sheet.identity.fears} placeholder="separated by ;" onSave={(v) => save({ identity: { ...sheet.identity, fears: v } })} />
      <ListField label="secrets" value={sheet.identity.secrets} placeholder="separated by ;" onSave={(v) => save({ identity: { ...sheet.identity, secrets: v } })} />
      <ListField label="allegiances" value={sheet.identity.allegiances} placeholder="separated by ;" onSave={(v) => save({ identity: { ...sheet.identity, allegiances: v } })} />
      <ListField label="competencies" value={sheet.identity.competencies} placeholder="separated by ;" onSave={(v) => save({ identity: { ...sheet.identity, competencies: v } })} />
      <TextField label="arc" value={sheet.identity.arc} placeholder="where this character is headed" multiline
        onSave={(v) => save({ identity: { ...sheet.identity, arc: v } })} />

      <h3 className="eyebrow rule" style={{ marginTop: 'var(--s4)' }}>voice</h3>
      <TextField label="diction" value={sheet.voice.diction} placeholder="how they speak" multiline
        onSave={(v) => save({ voice: { ...sheet.voice, diction: v } })} />
      <LinesField label="samples" value={sheet.voice.samples} placeholder="one line of theirs per row"
        onSave={(v) => save({ voice: { ...sheet.voice, samples: v } })} />
      <ListField label="tics" value={sheet.voice.tics} placeholder="verbal habits — separated by ;" onSave={(v) => save({ voice: { ...sheet.voice, tics: v } })} />
      <ListField label="never" value={sheet.voice.never} placeholder="what they would never say — separated by ;" onSave={(v) => save({ voice: { ...sheet.voice, never: v } })} />
    </div>
  );
}
