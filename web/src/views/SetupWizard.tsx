/**
 * Setup wizard.
 *
 * Shown when a save has no world yet. The sequence is the design: every question
 * is one the player can actually answer, and the cost of an ingest is on screen
 * before anything is spent.
 */
import { useEffect, useRef, useState } from 'react';
import {
  api,
  type CandidateCharacter,
  type CharacterSketch,
  type IngestPlan,
  type Job,
  type PreviewResult,
  type StyleContract,
  type WikiCandidate,
} from '../api.ts';

type Step = 'source' | 'universe' | 'wish' | 'plan' | 'preview' | 'running' | 'cast' | 'ready';

export function SetupWizard({ onDone }: { onDone: () => void | Promise<void> }) {
  const [step, setStep] = useState<Step>('source');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [universe, setUniverse] = useState('');
  const [candidates, setCandidates] = useState<WikiCandidate[]>([]);
  const [wiki, setWiki] = useState<WikiCandidate | null>(null);
  const [wish, setWish] = useState('');
  const [plan, setPlan] = useState<IngestPlan | null>(null);
  const [preview, setPreview] = useState<PreviewResult | null>(null);
  const [job, setJob] = useState<Job | null>(null);
  const [customDesc, setCustomDesc] = useState('');
  const [cast, setCast] = useState<CandidateCharacter[]>([]);
  const [opening, setOpening] = useState('');

  const guard = async (fn: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    try {
      await fn();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
    setBusy(false);
  };

  // Poll a running job. Progress is stages plus counts, never a fake percentage.
  const pollRef = useRef<number | null>(null);
  useEffect(() => {
    if (!job || job.status !== 'running') return;
    const tick = async () => {
      try {
        const next = await api.setup.job(job.id);
        setJob(next);
        if (next.status === 'done') {
          const result = next.result as { opening?: string } | null;
          setOpening(result?.opening ?? '');
          setCast(await api.setup.characters());
          setStep('cast');
        } else if (next.status === 'failed') {
          setError(next.error ?? 'the job failed');
        }
      } catch {
        // A dropped poll is not fatal; the next tick retries.
      }
    };
    pollRef.current = window.setInterval(tick, 700);
    return () => {
      if (pollRef.current) window.clearInterval(pollRef.current);
    };
  }, [job]);

  return (
    <div className="wizard">
      <div className="wizard-shell">
        {/* The only screen with no topbar, so it carries the masthead. */}
        <p className="wizard-mark">Fabulist</p>
        <div className="wizard-card">
          <div className="wizard-head">
            <h2>Where are we playing?</h2>
            {step !== 'source' && step !== 'running' ? (
              <button className="link" onClick={() => setStep('source')}>start over</button>
            ) : null}
          </div>

        {error ? <div className="wizard-error">{error}</div> : null}

        {/* ---------------------------------------------------------- source */}
        {step === 'source' ? (
          <div className="choices">
            <button
              className="choice"
              onClick={() => setStep('universe')}
            >
              <b>An existing world</b>
              <span>A book, film, game or show. I'll find its wiki and read enough of it to run a game there.</span>
            </button>
            <button className="choice" onClick={() => setStep('wish')}>
              <b>A world I describe</b>
              <span>Tell me the premise and I'll invent the places, factions and cast, with tensions already running.</span>
            </button>
            <button
              className="choice"
              disabled={busy}
              onClick={() =>
                void guard(async () => {
                  const res = await api.setup.sample();
                  setOpening(res.opening);
                  setStep('ready');
                })
              }
            >
              <b>Use the built-in example</b>
              <span>Saint Verrow: a monastery under a secular garrison. Fastest way to see how this plays.</span>
            </button>
          </div>
        ) : null}

        {/* -------------------------------------------------------- universe */}
        {step === 'universe' ? (
          <>
            <label className="field">
              <span>Which universe?</span>
              <input
                autoFocus
                value={universe}
                placeholder="The Witcher, Discworld, Dune, a wiki URL…"
                onChange={(e) => setUniverse(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && universe.trim()) {
                    void guard(async () => {
                      const res = await api.setup.resolve(universe);
                      setCandidates(res.candidates);
                      if (!res.candidates.length) setError('I could not find a wiki for that. Try another name, or paste a wiki URL.');
                    });
                  }
                }}
              />
            </label>
            <div className="row">
              <button
                className="primary"
                disabled={busy || !universe.trim()}
                onClick={() =>
                  void guard(async () => {
                    const res = await api.setup.resolve(universe);
                    setCandidates(res.candidates);
                    if (!res.candidates.length) setError('I could not find a wiki for that. Try another name, or paste a wiki URL.');
                  })
                }
              >
                {busy ? 'looking…' : 'find it'}
              </button>
            </div>

            {candidates.length ? (
              <div className="list">
                {candidates.map((c) => (
                  <button
                    key={c.baseUrl}
                    className={`choice small${wiki?.baseUrl === c.baseUrl ? ' selected' : ''}`}
                    onClick={() => {
                      setWiki(c);
                      setStep('wish');
                    }}
                  >
                    <b>{c.name}</b>
                    <span>
                      {c.articles.toLocaleString()} articles · {c.baseUrl.replace(/^https?:\/\//, '')}
                      {c.via === 'slug' || c.via === 'search' ? ' · a guess' : ''}
                    </span>
                  </button>
                ))}
              </div>
            ) : null}
          </>
        ) : null}

        {/* ------------------------------------------------------------ wish */}
        {step === 'wish' && wiki ? (
          <>
            <p className="dim small">
              {wiki.name} · {wiki.articles.toLocaleString()} articles
            </p>
            <label className="field">
              <span>Where and when in it, and who are you?</span>
              <textarea
                autoFocus
                rows={4}
                value={wish}
                placeholder="Around the Blood and Wine story, in Toussaint. I want to play a minor knight with a debt, not a famous character. Read it fairly thoroughly."
                onChange={(e) => setWish(e.target.value)}
              />
            </label>
            <p className="hint">
              Say as much or as little as you like. Anything you leave out I'll propose, and you can change it before
              anything is read.
            </p>
            <div className="row">
              <button
                className="primary"
                disabled={busy || !wish.trim()}
                onClick={() =>
                  void guard(async () => {
                    const p = await api.setup.plan(wish, wiki);
                    setPlan(p);
                    setStep('plan');
                  })
                }
              >
                {busy ? 'thinking…' : 'plan it'}
              </button>
            </div>
          </>
        ) : null}

        {/* --------------------------------------------- wish (custom world) */}
        {step === 'wish' && !wiki ? (
          <>
            <label className="field">
              <span>Describe the world</span>
              <textarea
                autoFocus
                rows={5}
                value={customDesc}
                placeholder="A city where the weights-and-measures office quietly decides what may be sold. My character is a junior assayer who has started reading the ledgers too closely."
                onChange={(e) => setCustomDesc(e.target.value)}
              />
            </label>
            <p className="hint">
              I'll build a dozen or so places, factions and people, with a tension already under strain. You can edit
              all of it afterwards.
            </p>
            <div className="row">
              <button
                className="primary"
                disabled={busy || customDesc.trim().length < 20}
                onClick={() =>
                  void guard(async () => {
                    setJob(await api.setup.custom(customDesc));
                    setStep('running');
                  })
                }
              >
                {busy ? 'starting…' : 'build it'}
              </button>
            </div>
          </>
        ) : null}

        {/* ------------------------------------------------------------ plan */}
        {step === 'plan' && plan && wiki ? (
          <>
            <p className="dim small">{plan.reasoning}</p>

            <div className="field">
              <span>What I'll read</span>
              <div className="chips">
                {plan.startingPoints.slice(0, 18).map((sp) => {
                  const on = plan.seeds.includes(sp.title);
                  return (
                    <button
                      key={sp.title}
                      className={`chip${on ? ' on' : ''}`}
                      onClick={() =>
                        setPlan({
                          ...plan,
                          seeds: on ? plan.seeds.filter((s) => s !== sp.title) : [...plan.seeds, sp.title],
                        })
                      }
                    >
                      {sp.title}
                      {sp.members ? <i> {sp.members}</i> : null}
                    </button>
                  );
                })}
              </div>
              <p className="hint">Tap to add or remove. Fewer, tighter starting points make a better game than a broad sweep.</p>
            </div>

            <div className="field">
              <span>How much of it</span>
              <div className="row">
                {(['skim', 'mid', 'deep'] as const).map((m) => (
                  <button key={m} className={plan.mode === m ? 'primary' : ''} onClick={() => setPlan({ ...plan, mode: m })}>
                    {m}
                  </button>
                ))}
              </div>
              <p className="hint">
                {plan.mode === 'skim'
                  ? 'A quick read: names, places and the shape of things. Minutes, near free.'
                  : plan.mode === 'mid'
                    ? 'Enough for a campaign: relationships and voices for the main cast.'
                    : 'Everything in scope, including minor characters and the timeline. Slow, and it costs real money.'}
              </p>
            </div>

            <CharacterEditor sketch={plan.character} onChange={(character) => setPlan({ ...plan, character })} />
            <StyleEditor style={plan.style} onChange={(style) => setPlan({ ...plan, style })} />

            <div className="row">
              <button
                className="primary"
                disabled={busy || plan.seeds.length === 0}
                onClick={() =>
                  void guard(async () => {
                    const p = await api.setup.preview(wiki.baseUrl, plan.seeds, plan.mode, plan.excludeCategories, wiki.name);
                    setPreview(p);
                    setStep('preview');
                  })
                }
              >
                {busy ? 'checking…' : 'see what that costs'}
              </button>
            </div>
          </>
        ) : null}

        {/* --------------------------------------------------------- preview */}
        {step === 'preview' && preview && plan ? (
          <>
            <div className="stats">
              <div>
                <b>{preview.preview.candidatePages}</b>
                <span>pages</span>
              </div>
              <div>
                <b>{preview.estimatedSeconds < 90 ? `${preview.estimatedSeconds}s` : `${Math.round(preview.estimatedSeconds / 60)}m`}</b>
                <span>roughly</span>
              </div>
              <div>
                <b>${preview.preview.estimatedCostUsd.toFixed(2)}</b>
                <span>estimated</span>
              </div>
            </div>

            {preview.preview.characters.length ? (
              <div className="field">
                <span>People I found</span>
                <p className="small dim">{preview.preview.characters.slice(0, 14).join(', ')}</p>
              </div>
            ) : null}
            {preview.preview.factions.length ? (
              <div className="field">
                <span>Factions</span>
                <p className="small dim">{preview.preview.factions.slice(0, 10).join(', ')}</p>
              </div>
            ) : null}
            {preview.preview.locations.length ? (
              <div className="field">
                <span>Places</span>
                <p className="small dim">{preview.preview.locations.slice(0, 10).join(', ')}</p>
              </div>
            ) : null}

            <p className="hint">
              If that looks like the wrong corner of the world, go back and change what I read. Nothing has been
              stored yet.
            </p>

            <div className="row">
              <button onClick={() => setStep('plan')}>back</button>
              <button
                className="primary"
                disabled={busy}
                onClick={() =>
                  void guard(async () => {
                    setJob(await api.setup.ingest(preview.previewKey, plan.character, plan.style, plan.opening));
                    setStep('running');
                  })
                }
              >
                read it and begin
              </button>
            </div>
          </>
        ) : null}

        {/* --------------------------------------------------------- running */}
        {step === 'running' && job ? (
          <>
            <div className="progress">
              <div className="progress-stage">{job.progress.stage}</div>
              {job.progress.detail ? <div className="dim small">{job.progress.detail}</div> : null}
              {job.progress.total ? (
                <>
                  <div className="bar">
                    <i style={{ width: `${Math.min(100, (job.progress.current / job.progress.total) * 100)}%` }} />
                  </div>
                  <div className="dimmer small mono">
                    {job.progress.current} / {job.progress.total}
                  </div>
                </>
              ) : (
                <div className="spinner" />
              )}
            </div>

            <details className="log">
              <summary className="small dim">what it's doing</summary>
              <pre>{job.log.slice(-24).join('\n')}</pre>
            </details>

            {job.status === 'running' ? (
              <div className="row">
                <button onClick={() => void api.setup.cancel(job.id)}>stop, keep what's read</button>
              </div>
            ) : null}
          </>
        ) : null}

        {/* ------------------------------------------------------------ cast */}
        {step === 'cast' ? (
          <>
            <p className="dim small">
              The world is in place. Who are you? I've already placed the character from your plan, but you can play
              someone {wiki ? 'the wiki already knows' : 'from the world I just built'} instead.
            </p>
            <div className="list scroll">
              {cast.slice(0, 24).map((c) => (
                <button
                  key={c.id}
                  className="choice small"
                  disabled={busy}
                  onClick={() =>
                    void guard(async () => {
                      const res = await api.setup.setPlayer({ existing: c.name });
                      setOpening(res.opening);
                      setStep('ready');
                    })
                  }
                >
                  <b>
                    {c.name} {c.hasVows ? <span className="tag">has vows</span> : null}
                  </b>
                  <span>
                    {c.summary?.slice(0, 110) || 'no description'} · {c.connections} connections
                  </span>
                </button>
              ))}
            </div>
            <div className="row">
              <button className="primary" onClick={() => setStep('ready')}>
                keep the character from my plan
              </button>
            </div>
          </>
        ) : null}

        {/* ----------------------------------------------------------- ready */}
        {step === 'ready' ? (
          <>
            <h3 className="opening-label">Where we begin</h3>
            <p className="opening">{opening || 'Somewhere with a decision already waiting.'}</p>
            <div className="row">
              <button className="primary" disabled={busy} onClick={() => void guard(async () => { await onDone(); })}>
                begin
              </button>
            </div>
          </>
        ) : null}
        </div>
      </div>
    </div>
  );
}

/** The vows matter most here: they are what let the game master refuse an action. */
function CharacterEditor({ sketch, onChange }: { sketch: CharacterSketch; onChange: (s: CharacterSketch) => void }) {
  return (
    <div className="field">
      <span>Who you play</span>
      {sketch.existing ? (
        <p className="small">
          <b>{sketch.existing}</b> <span className="dim">— an existing character from this world</span>
        </p>
      ) : (
        <div className="row">
          <input value={sketch.name} placeholder="name" onChange={(e) => onChange({ ...sketch, name: e.target.value })} />
          <input value={sketch.role} placeholder="who they are" onChange={(e) => onChange({ ...sketch, role: e.target.value })} />
        </div>
      )}

      <div className="vows">
        <div className="small dim">
          Lines they won't cross. I'll stop you and ask before writing them across one of these.
        </div>
        {sketch.vows.map((v, i) => (
          <div className="row" key={i}>
            <input
              value={v.text}
              onChange={(e) => {
                const vows = [...sketch.vows];
                vows[i] = { ...v, text: e.target.value };
                onChange({ ...sketch, vows });
              }}
            />
            <button onClick={() => onChange({ ...sketch, vows: sketch.vows.filter((_, j) => j !== i) })}>×</button>
          </div>
        ))}
        {sketch.vows.length < 4 ? (
          <button onClick={() => onChange({ ...sketch, vows: [...sketch.vows, { text: '', rank: sketch.vows.length + 1 }] })}>
            add a line
          </button>
        ) : null}
        {sketch.vows.length === 0 ? (
          <p className="hint warn">Without any, I'll never refuse an action on your character's behalf.</p>
        ) : null}
      </div>
    </div>
  );
}

function StyleEditor({ style, onChange }: { style: StyleContract; onChange: (s: StyleContract) => void }) {
  return (
    <div className="field">
      <span>How it should read</span>
      <div className="row wrap">
        <select value={style.pov} onChange={(e) => onChange({ ...style, pov: e.target.value as StyleContract['pov'] })}>
          <option value="first">first person</option>
          <option value="third-limited">third, close</option>
          <option value="third-omniscient">third, wide</option>
          <option value="second">second person</option>
        </select>
        <select value={style.tense} onChange={(e) => onChange({ ...style, tense: e.target.value as StyleContract['tense'] })}>
          <option value="past">past tense</option>
          <option value="present">present tense</option>
        </select>
        <input
          value={style.genreLens}
          placeholder="genre"
          onChange={(e) => onChange({ ...style, genreLens: e.target.value })}
        />
      </div>
      <input
        defaultValue={style.comparables.join(', ')}
        placeholder="books or films to echo — this carries more weight than any adjective"
        onBlur={(e) => onChange({ ...style, comparables: e.target.value.split(',').map((s) => s.trim()).filter(Boolean) })}
      />
    </div>
  );
}
