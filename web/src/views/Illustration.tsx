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
import { keepPreviousData, useMutation, useQuery } from '@tanstack/react-query';
import { api, getSelectedStoryId, VISUAL_STYLES, type ComposedPrompt, type Illustration, type Sheet, type VisualStyle } from '../api.ts';
import { queryKeys } from '../query-keys.ts';

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
 * Whether a real image provider is configured right now. Every consumer of
 * this hook (the portrait panel, every scene panel in a long book) needs the
 * same answer, so it reads one shared query instead of each panel probing —
 * and none of them has to coordinate the fetch with its siblings.
 */
function useImageProviderReady(): boolean | null {
  const storyId = getSelectedStoryId();
  // Shared key: every portrait and scene panel on screen asks the same
  // question, so they all read one cached answer instead of probing each.
  const query = useQuery({
    queryKey: queryKeys.imagesStatus(storyId),
    queryFn: () => api.images.status(),
  });
  // The old probe's catch set ready to false, not null — a failed status call
  // reads as "no image model" so the prompt fallback still shows.
  if (query.error) return false;
  return query.data?.ready ?? null;
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
  const [error, setError] = useState<string | null>(null);
  const [prompt, setPrompt] = useState<ComposedPrompt | null>(null);
  const [showPrompt, setShowPrompt] = useState(false);
  const ready = useImageProviderReady();

  // The old mount load is now the query's initial fetch; keepPreviousData holds
  // the previous character's gallery until the new one lands, like the old
  // setGallery-only-on-success.
  const storyId = getSelectedStoryId();
  const galleryQuery = useQuery({
    queryKey: queryKeys.illustrationGallery(storyId, sheet.entityId),
    queryFn: () => api.illustrate.forEntity(sheet.entityId),
    placeholderData: keepPreviousData,
  });
  const gallery = galleryQuery.data ?? [];

  const current = gallery.find((i) => i.status === 'done');

  const generate = useMutation({
    mutationFn: () => api.illustrate.portrait(sheet.entityId, style),
    onMutate: () => setError(null),
    onSuccess: () => {
      // Fire-and-forget like the old load(); a failed reload keeps the list.
      void galleryQuery.refetch();
      onChanged();
    },
    onError: (e) => setError(e instanceof Error ? e.message : String(e)),
  });

  const loadPrompt = useMutation({
    mutationFn: () => api.illustrate.portraitPrompt(sheet.entityId, style),
    onSuccess: (p) => {
      setPrompt(p);
      setShowPrompt(true);
    },
  });

  const discard = useMutation({
    mutationFn: async () => {
      if (!current) return;
      await api.illustrate.remove(current.id);
      // The reference this portrait set is now gone; clear it rather than
      // leaving `Appearance` pointing at a file that no longer exists.
      if (sheet.appearance.referenceImagePath) {
        await api.saveSheet(sheet.entityId, { appearance: { ...sheet.appearance, referenceImagePath: null, seed: null } });
      }
    },
    onSuccess: () => {
      void galleryQuery.refetch();
      onChanged();
    },
  });

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
        <StylePicker value={style} onChange={setStyle} disabled={generate.isPending} />
        <div className="row" style={{ marginTop: 'var(--s2)' }}>
          {ready ? (
            <button disabled={generate.isPending} onClick={() => generate.mutate()}>
              {generate.isPending ? 'generating…' : current ? 'regenerate' : 'generate portrait'}
            </button>
          ) : null}
          <button onClick={() => (showPrompt ? setShowPrompt(false) : loadPrompt.mutate())}>
            {showPrompt ? 'hide prompt' : ready ? 'copy prompt instead' : 'copy prompt'}
          </button>
          {current ? <button onClick={() => discard.mutate()}>discard</button> : null}
          {gallery.length > 1 ? <span className="small dimmer">{gallery.length} generated</span> : null}
        </div>
        <StatusLine illus={current ?? null} busy={generate.isPending} error={error} />
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

  const save = useMutation({
    mutationFn: () =>
      api.saveSheet(sheet.entityId, {
        appearance: { ...sheet.appearance, description, attire, markers: markers.split(';').map((m) => m.trim()).filter(Boolean) },
      }),
    onSuccess: (updated) => onSaved(updated),
  });

  return (
    <div className="appearance-editor">
      <label className="field-row block">
        <span>description</span>
        <textarea
          rows={2}
          value={description}
          placeholder="build, face, colouring, bearing — what stays true in every image"
          onChange={(e) => setDescription(e.target.value)}
          onBlur={() => save.mutate()}
        />
      </label>
      <label className="field-row block">
        <span>attire</span>
        <input value={attire} placeholder="what they wear by default" onChange={(e) => setAttire(e.target.value)} onBlur={() => save.mutate()} />
      </label>
      <label className="field-row block">
        <span>markers</span>
        <input
          value={markers}
          placeholder="scars, tattoos — separated by ;"
          onChange={(e) => setMarkers(e.target.value)}
          onBlur={() => save.mutate()}
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
  const [error, setError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState(false);
  const [prompt, setPrompt] = useState<ComposedPrompt | null>(null);
  const [showPrompt, setShowPrompt] = useState(false);
  const ready = useImageProviderReady();
  const storyId = getSelectedStoryId();

  // The old code fetched once per turn and then lived entirely in local state —
  // it never reloaded after generate or discard. Keep that: the query only
  // seeds `illus`, and the mutations below own every later change. A refetch
  // here would resurface a second illustration where the old code showed none.
  const illustrationsQuery = useQuery({
    queryKey: queryKeys.sceneIllustrations(storyId, turnId),
    queryFn: () => api.illustrate.forTurn(turnId),
  });

  useEffect(() => {
    const list = illustrationsQuery.data;
    if (!list) return;
    const done = list.find((i) => i.status === 'done') ?? list[0] ?? null;
    setIllus(done);
    if (done) setExpanded(true);
  }, [illustrationsQuery.data]);

  const generate = useMutation({
    mutationFn: () => api.illustrate.scene(turnId, style),
    onMutate: () => setError(null),
    onSuccess: (created) => {
      setIllus(created);
      setExpanded(true);
    },
    onError: (e) => setError(e instanceof Error ? e.message : String(e)),
  });

  const loadPrompt = useMutation({
    mutationFn: () => api.illustrate.scenePrompt(turnId, style),
    onSuccess: (p) => {
      setPrompt(p);
      setShowPrompt(true);
    },
  });

  const discard = useMutation({
    mutationFn: () => api.illustrate.remove(illus!.id),
    onSuccess: () => setIllus(null),
  });

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
          <button className="scene-illustrate-toggle" onClick={() => discard.mutate()}>discard</button>
        </>
      ) : (
        <>
          <div className="row" style={{ marginBottom: 'var(--s2)' }}>
            <StylePicker value={style} onChange={setStyle} disabled={generate.isPending} />
            {ready ? (
              <button disabled={generate.isPending} onClick={() => generate.mutate()}>
                {generate.isPending ? 'generating…' : 'generate'}
              </button>
            ) : null}
            <button onClick={() => (showPrompt ? setShowPrompt(false) : loadPrompt.mutate())}>
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
      <StatusLine illus={illus} busy={generate.isPending} error={error} />
    </div>
  );
}
