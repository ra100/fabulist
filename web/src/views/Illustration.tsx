/**
 * Illustration widgets: the portrait panel (cast tab), the scene-image panel
 * (book tab), the visual-style picker they both share, and the prompt
 * fallback that makes this useful even with no image model attached.
 *
 * Kept as its own module, the way `GraphView.tsx` and `SetupWizard.tsx` are —
 * substantial enough UI that it does not belong folded into `App.tsx`, and
 * self-contained enough that neither of those two files needs to know how an
 * image gets generated, only that this component handles it.
 */
import { useEffect, useState } from 'react';
import { api, VISUAL_STYLES, type ComposedPrompt, type Illustration, type Sheet, type VisualStyle } from '../api.ts';

/**
 * The five-way style picker asked for directly: realistic, drawing, sketch,
 * draft, animation. Drawn as a row of small toggle buttons rather than a
 * `<select>`, matching the lineage rule against native form chrome that
 * every other picker in this app (POV, tense, register…) already follows.
 */
export function StylePicker({ value, onChange, disabled }: { value: VisualStyle; onChange: (v: VisualStyle) => void; disabled?: boolean }) {
  return (
    <div className="style-picker" role="radiogroup" aria-label="illustration style">
      {VISUAL_STYLES.map((s) => (
        <button
          key={s.key}
          type="button"
          role="radio"
          aria-checked={value === s.key}
          className={value === s.key ? 'primary' : ''}
          disabled={disabled}
          onClick={() => onChange(s.key)}
        >
          {s.label}
        </button>
      ))}
    </div>
  );
}

/**
 * Whether a real image provider is configured right now. Checked once per
 * mount rather than threaded down as a prop, because every consumer of this
 * hook (the portrait panel, every scene panel in a long book) needs the same
 * answer and none of them should have to coordinate a shared fetch.
 */
function useImageProviderReady(): boolean | null {
  const [ready, setReady] = useState<boolean | null>(null);
  useEffect(() => {
    void api.images
      .providers()
      .then((r) => setReady(r.profile !== 'none'))
      .catch(() => setReady(false));
  }, []);
  return ready;
}

/**
 * The fallback this whole feature was asked to have: with no vision model
 * available, the composed prompt itself — positive and negative — rendered
 * as plain text with a copy button, ready to paste into any image tool.
 * Shown automatically when there is no provider, and reachable by hand even
 * when there is one, via `PromptFallback`'s toggle in the parent panels,
 * since "give me the prompt anyway" is a reasonable thing to want even with
 * a provider configured — a different tool, a higher-resolution render, a
 * second opinion.
 */
function PromptText({ prompt }: { prompt: ComposedPrompt }) {
  const [copied, setCopied] = useState<'prompt' | 'negative' | null>(null);
  const copy = async (text: string, which: 'prompt' | 'negative') => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(which);
      setTimeout(() => setCopied(null), 1400);
    } catch {
      // Clipboard access denied (permissions, non-secure context): the text
      // is still selectable and visible, so nothing is actually lost.
    }
  };
  return (
    <div className="prompt-text">
      <div className="prompt-text-block">
        <div className="row baseline">
          <span className="eyebrow" style={{ marginBottom: 0 }}>prompt</span>
          <span className="grow" />
          <button onClick={() => void copy(prompt.prompt, 'prompt')}>{copied === 'prompt' ? 'copied' : 'copy'}</button>
        </div>
        <p className="mono small">{prompt.prompt}</p>
      </div>
      <div className="prompt-text-block">
        <div className="row baseline">
          <span className="eyebrow" style={{ marginBottom: 0 }}>negative prompt</span>
          <span className="grow" />
          <button onClick={() => void copy(prompt.negativePrompt, 'negative')}>{copied === 'negative' ? 'copied' : 'copy'}</button>
        </div>
        <p className="mono small dimmer">{prompt.negativePrompt}</p>
      </div>
    </div>
  );
}

function StatusLine({ illus, busy, error }: { illus: Illustration | null; busy: boolean; error: string | null }) {
  if (busy) return <div className="illus-status dim small">generating…</div>;
  if (error) return <div className="illus-status warn small">{error}</div>;
  if (illus?.status === 'failed') return <div className="illus-status warn small">{illus.error ?? 'generation failed'}</div>;
  if (illus?.status === 'pending') return <div className="illus-status dim small">pending…</div>;
  return null;
}

/**
 * Portrait panel for one character: the current reference image (or an
 * empty frame), the style picker, and a generate/regenerate control. Lives
 * inside `CastTab`'s expanded sheet.
 */
export function PortraitPanel({ sheet, onChanged }: { sheet: Sheet; onChanged: () => void }) {
  const [style, setStyle] = useState<VisualStyle>('drawing');
  const [gallery, setGallery] = useState<Illustration[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [prompt, setPrompt] = useState<ComposedPrompt | null>(null);
  const [showPrompt, setShowPrompt] = useState(false);
  const ready = useImageProviderReady();

  const load = () => void api.illustrate.forEntity(sheet.entityId).then(setGallery);
  useEffect(load, [sheet.entityId]);

  const current = gallery.find((i) => i.status === 'done');

  async function generate() {
    setBusy(true);
    setError(null);
    try {
      await api.illustrate.portrait(sheet.entityId, style);
      load();
      onChanged();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
    setBusy(false);
  }

  async function loadPrompt() {
    setPrompt(await api.illustrate.portraitPrompt(sheet.entityId, style));
    setShowPrompt(true);
  }

  async function discard() {
    if (!current) return;
    await api.illustrate.remove(current.id);
    // The reference this portrait set is now gone; clear it rather than
    // leaving `Appearance` pointing at a file that no longer exists.
    if (sheet.appearance.referenceImagePath) {
      await api.saveSheet(sheet.entityId, { appearance: { ...sheet.appearance, referenceImagePath: null, seed: null } });
    }
    load();
    onChanged();
  }

  return (
    <div className="portrait-panel">
      <div className="portrait-frame">
        {current ? (
          <img src={api.illustrate.imageUrl(current.id)} alt={`portrait of ${sheet.entityId}`} />
        ) : (
          <div className="portrait-empty" aria-hidden="true" />
        )}
      </div>
      <div className="portrait-controls">
        <StylePicker value={style} onChange={setStyle} disabled={busy} />
        <div className="row" style={{ marginTop: 'var(--s2)' }}>
          {ready ? (
            <button disabled={busy} onClick={() => void generate()}>
              {busy ? 'generating…' : current ? 'regenerate' : 'generate portrait'}
            </button>
          ) : null}
          <button onClick={() => (showPrompt ? setShowPrompt(false) : void loadPrompt())}>
            {showPrompt ? 'hide prompt' : ready ? 'copy prompt instead' : 'copy prompt'}
          </button>
          {current ? <button onClick={() => void discard()}>discard</button> : null}
          {gallery.length > 1 ? <span className="small dimmer">{gallery.length} generated</span> : null}
        </div>
        <StatusLine illus={current ?? null} busy={busy} error={error} />
        {ready === false ? (
          <p className="small dimmer" style={{ marginTop: 'var(--s2)' }}>            No image model configured (see settings → illustration) — copy the prompt into whatever image tool you
            have instead.
          </p>
        ) : null}
        {!sheet.appearance.description ? (
          <p className="small dimmer" style={{ marginTop: 'var(--s2)' }}>
            No appearance described yet — the prompt will fall back to the entity's summary. Write one below for a
            steadier likeness across regenerations.
          </p>
        ) : null}
        {showPrompt && prompt ? <PromptText prompt={prompt} /> : null}
      </div>
    </div>
  );
}

/**
 * Editable fields for `Appearance.description`/`attire`/`markers` — the text
 * every later portrait and every scene this character appears in gets
 * restated from (see `illustration/composer.ts`). Deliberately plain text
 * inputs, not a rich form: this is prose the composer quotes verbatim, and
 * the player should be able to see and edit exactly what will be quoted.
 */
export function AppearanceEditor({ sheet, onSaved }: { sheet: Sheet; onSaved: (s: Sheet) => void }) {
  const [description, setDescription] = useState(sheet.appearance.description);
  const [attire, setAttire] = useState(sheet.appearance.attire);
  const [markers, setMarkers] = useState(sheet.appearance.markers.join('; '));

  async function save() {
    const updated = await api.saveSheet(sheet.entityId, {
      appearance: { ...sheet.appearance, description, attire, markers: markers.split(';').map((m) => m.trim()).filter(Boolean) },
    });
    onSaved(updated);
  }

  return (
    <div className="appearance-editor">
      <label className="field-row block">
        <span>description</span>
        <textarea
          rows={2}
          value={description}
          placeholder="build, face, colouring, bearing — what stays true in every image"
          onChange={(e) => setDescription(e.target.value)}
          onBlur={save}
        />
      </label>
      <label className="field-row block">
        <span>attire</span>
        <input value={attire} placeholder="what they wear by default" onChange={(e) => setAttire(e.target.value)} onBlur={save} />
      </label>
      <label className="field-row block">
        <span>markers</span>
        <input
          value={markers}
          placeholder="scars, tattoos — separated by ;"
          onChange={(e) => setMarkers(e.target.value)}
          onBlur={save}
        />
      </label>
    </div>
  );
}

/**
 * Scene-image panel: one illustration per turn, shown inline in the book
 * once generated. Not auto-generated on every turn — that would spend a
 * provider call nobody asked for — so this starts as a quiet button and
 * becomes an image once used.
 */
export function SceneIllustration({ turnId, defaultStyle }: { turnId: string; defaultStyle: VisualStyle }) {
  const [illus, setIllus] = useState<Illustration | null>(null);
  const [style, setStyle] = useState<VisualStyle>(defaultStyle);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState(false);
  const [prompt, setPrompt] = useState<ComposedPrompt | null>(null);
  const [showPrompt, setShowPrompt] = useState(false);
  const ready = useImageProviderReady();

  useEffect(() => {
    void api.illustrate.forTurn(turnId).then((list) => {
      const done = list.find((i) => i.status === 'done') ?? list[0] ?? null;
      setIllus(done);
      if (done) setExpanded(true);
    });
  }, [turnId]);

  async function generate() {
    setBusy(true);
    setError(null);
    try {
      const created = await api.illustrate.scene(turnId, style);
      setIllus(created);
      setExpanded(true);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
    setBusy(false);
  }

  async function loadPrompt() {
    setPrompt(await api.illustrate.scenePrompt(turnId, style));
    setShowPrompt(true);
  }

  async function discard() {
    if (!illus) return;
    await api.illustrate.remove(illus.id);
    setIllus(null);
  }

  if (!expanded) {
    return (
      <button className="scene-illustrate-toggle" onClick={() => setExpanded(true)}>
        illustrate this scene
      </button>
    );
  }

  return (
    <div className="scene-illustration">
      {illus?.status === 'done' ? (
        <>
          <img src={api.illustrate.imageUrl(illus.id)} alt="scene illustration" />
          <button className="scene-illustrate-toggle" onClick={() => void discard()}>discard</button>
        </>
      ) : (
        <>
          <div className="row" style={{ marginBottom: 'var(--s2)' }}>
            <StylePicker value={style} onChange={setStyle} disabled={busy} />
            {ready ? <button disabled={busy} onClick={() => void generate()}>{busy ? 'generating…' : 'generate'}</button> : null}
            <button onClick={() => (showPrompt ? setShowPrompt(false) : void loadPrompt())}>
              {showPrompt ? 'hide prompt' : ready ? 'copy prompt instead' : 'copy prompt'}
            </button>
          </div>
          {ready === false ? (
            <p className="small dimmer" style={{ marginBottom: 'var(--s2)' }}>
              No image model configured (settings → illustration) — copy the prompt into whatever image tool you have
              instead.
            </p>
          ) : null}
          {showPrompt && prompt ? <PromptText prompt={prompt} /> : null}
        </>
      )}
      <StatusLine illus={illus} busy={busy} error={error} />
    </div>
  );
}
