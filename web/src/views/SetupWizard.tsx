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
  type AppConfig,
  type CandidateCharacter,
  type CharacterSketch,
  type ConfigBundle,
  type DiscoverResult,
  type IngestPlan,
  type Job,
  type PreviewResult,
  type ProvidersReport,
  type StyleContract,
  type ValidationIssue,
  type WikiCandidate,
} from '../api.ts';
import { ProvidersEditor } from './ConfigPanels.tsx';
import { Mark } from '../Mark.tsx';

type Step = 'source' | 'models' | 'universe' | 'wish' | 'plan' | 'discovering' | 'preview' | 'running' | 'cast' | 'ready';

const blankSketch = (): CharacterSketch => ({ existing: null, name: '', role: '', goals: [], vows: [] });

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
  const [refined, setRefined] = useState(false);
  const [job, setJob] = useState<Job | null>(null);
  const [customDesc, setCustomDesc] = useState('');
  const [cast, setCast] = useState<CandidateCharacter[]>([]);
  const [castSketch, setCastSketch] = useState<CharacterSketch | null>(null);
  const [opening, setOpening] = useState('');

  // Half-closed already: settings can switch profile live, but the wizard used
  // to build the world silently on the mock regardless. A first-time visitor
  // meets deliberately plain prose at exactly the moment they are deciding
  // whether any of this is good, so offer the better model up front instead.
  const [providers, setProviders] = useState<ProvidersReport | null>(null);
  const [switchingProfile, setSwitchingProfile] = useState(false);
  const [dismissedOffer, setDismissedOffer] = useState(false);

  useEffect(() => {
    void api.providers().then(setProviders).catch(() => {});
  }, []);

  const betterProfiles = (providers?.usableProfiles ?? []).filter((p) => p !== 'mock' && p !== providers?.profile);

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
  // Two job kinds land here: `discover` (the crawl+preview, feeding back into
  // the still-editable plan) and `ingest`/`custom-world` (the actual write).
  // They resolve to different steps, so the branch is on `job.kind` rather than
  // a single fixed "done → cast" path.
  const pollRef = useRef<number | null>(null);
  useEffect(() => {
    if (job?.status !== 'running') return;
    const tick = async () => {
      try {
        const next = await api.setup.job(job.id);
        setJob(next);
        if (next.status === 'done') {
          if (next.kind === 'discover') {
            const result = next.result as DiscoverResult;
            setPreview(result);
            setRefined(true);
            setPlan((p) => (p ? { ...p, character: result.character } : p));
            setStep('preview');
          } else {
            const result = next.result as { opening?: string } | null;
            setOpening(result?.opening ?? '');
            setCast(await api.setup.characters());
            setStep('cast');
          }
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
        <p className="wizard-mark"><Mark size={14} />Fabulist</p>
        <div className="wizard-card">
          <div className="wizard-head">
            {/*
              The heading follows the step. "Where are we playing?" is wrong on
              the models step, which is about how it gets written rather than
              where — and a heading that contradicts the screen under it reads
              as a bug.
            */}
            <h2>{step === 'models' ? 'Which model writes?' : 'Where are we playing?'}</h2>
            {step !== 'source' && step !== 'running' && step !== 'discovering' ? (
              <button className="link" onClick={() => setStep('source')}>
                {step === 'models' ? 'back' : 'start over'}
              </button>
            ) : null}
          </div>

        {error ? <div className="wizard-error">{error}</div> : null}

        {/* ---------------------------------------------------------- source */}
        {step === 'source' ? (
          <>
            {/*
              Which model is writing, stated before anything is built rather
              than discovered afterwards. Three cases, and all three end in a
              route to the models step — the previous version offered a
              one-click switch only when a better profile *already* happened to
              be usable, which meant a machine with nothing configured got no
              offer at all and silently built a world on the mock.
            */}
            {providers?.profile === 'mock' && betterProfiles.length && !dismissedOffer ? (
              <div className="wizard-provider-offer">
                <p className="small">
                  This machine can also run on <b>{betterProfiles.join(', ')}</b> instead of the built-in mock.
                  The mock proves the machinery, not the prose — worth switching before you judge either.
                </p>
                <div className="row wrap">
                  {betterProfiles.map((name) => (
                    <button
                      key={name}
                      disabled={switchingProfile}
                      onClick={() =>
                        void guard(async () => {
                          setSwitchingProfile(true);
                          try {
                            const res = await api.setProfile(name);
                            if (res.ok) setProviders(await api.providers());
                            else setError(res.notes.join(' ') || `could not switch to ${name}`);
                          } finally {
                            setSwitchingProfile(false);
                          }
                        })
                      }
                    >
                      use {name}
                    </button>
                  ))}
                  <button onClick={() => setStep('models')}>set up a model…</button>
                  <button className="link" onClick={() => setDismissedOffer(true)}>
                    stay on the mock
                  </button>
                </div>
              </div>
            ) : providers?.profile === 'mock' && !dismissedOffer ? (
              // Nothing usable found. This is the case that used to be silent,
              // and it is the one where saying so matters most: the prose the
              // mock writes is deliberately plain, so a first-time visitor
              // judging the app on it is judging the wrong thing.
              <div className="wizard-provider-offer">
                <p className="small">
                  No model is configured yet, so the built-in <b>mock</b> will write — deterministic placeholder prose
                  that proves the machinery and nothing else. A local server or an AWS/Google login is enough.
                </p>
                <div className="row wrap">
                  <button className="primary" onClick={() => setStep('models')}>set up a model…</button>
                  <button className="link" onClick={() => setDismissedOffer(true)}>
                    continue on the mock
                  </button>
                </div>
              </div>
            ) : providers && providers.profile !== 'mock' ? (
              <p className="small dim wizard-provider-note">
                writing with <b>{providers.profile}</b>{' '}
                <button className="link" onClick={() => setStep('models')}>change</button>
              </p>
            ) : null}
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
          </>
        ) : null}

        {/* ---------------------------------------------------------- models */}
        {step === 'models' ? (
          <ModelsStep
            providers={providers}
            onProvidersChanged={async () => setProviders(await api.providers())}
            onBack={() => setStep('source')}
          />
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
                    setRefined(false);
                    const j = await api.setup.discover(wiki.baseUrl, plan.seeds, plan.mode, plan.character, plan.excludeCategories, wiki.name);
                    setJob(j);
                    setStep('discovering');
                  })
                }
              >
                see what that costs
              </button>
            </div>
          </>
        ) : null}

        {/* ---------------------------------------------------- discovering */}
        {step === 'discovering' && job ? (
          <>
            <p className="hint">
              Reading the wiki's map before anything is spent — page counts, cost and your character all come from
              what's actually there.
            </p>
            <JobProgress job={job} />
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

            {refined ? (
              <>
                <p className="dim small">
                  Now that I've actually read this, here's your character again — sharpened against what's really
                  there. Still yours to change.
                </p>
                <CharacterEditor sketch={plan.character} onChange={(character) => setPlan({ ...plan, character })} />
              </>
            ) : null}

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
            <JobProgress job={job} />

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
                      const detail = await api.entity(c.id);
                      setCastSketch({
                        existing: c.name,
                        name: c.name,
                        role: detail.entity.summary ?? '',
                        goals: detail.sheet?.identity.goals ?? [],
                        vows: (detail.sheet?.contract.vows ?? []).map((v) => ({ text: v.text, rank: v.rank })),
                      });
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
              <button className="primary" onClick={() => setCastSketch(plan?.character ?? blankSketch())}>
                keep the character from my plan
              </button>
            </div>

            {castSketch ? (
              <>
                <CharacterEditor sketch={castSketch} onChange={setCastSketch} />
                <div className="row">
                  <button
                    className="primary"
                    disabled={busy}
                    onClick={() =>
                      void guard(async () => {
                        const res = await api.setup.setPlayer(castSketch);
                        setOpening(res.opening);
                        setStep('ready');
                      })
                    }
                  >
                    play as this character
                  </button>
                </div>
              </>
            ) : null}
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

/**
 * Renders a job's progress: stage, detail, a real bar when a total is known,
 * an indeterminate spinner when it isn't, and the tail of the log. Shared by
 * `discovering` (the crawl) and `running` (the actual write) — the two were
 * visually identical already for `running`; the fix here is giving
 * `discovering` the same treatment instead of a bare button label, not
 * inventing a new look.
 */
function JobProgress({ job }: { job: Job }) {
  return (
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
    </>
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

/**
 * The provider step: which model writes, decided before a world exists.
 *
 * This closes what the source step's note used to concede as "half-closed".
 * Settings could always switch profile live, and the wizard could offer a
 * one-click switch — but only when a better profile *already* happened to be
 * usable. On a machine with nothing configured there was no offer and no route
 * to one, so the world got built on the mock and the plainness of mock prose
 * was discovered afterwards, at exactly the moment a first-time visitor is
 * deciding whether any of this is good.
 *
 * Deliberately not a gate. The mock is a legitimate choice — it is how the
 * machinery is meant to be inspected offline — so this step is reachable,
 * skippable, and never blocks. It refuses to pretend, which is different from
 * refusing to continue.
 *
 * The editor is `ConfigPanels`' own `ProvidersEditor`, not a copy: the
 * kind-to-fields mapping and the test-before-keep flow are exactly what a
 * first-run user needs to get right, and two implementations would drift.
 */
function ModelsStep({
  providers,
  onProvidersChanged,
  onBack,
}: {
  providers: ProvidersReport | null;
  onProvidersChanged: () => Promise<void>;
  onBack: () => void;
}) {
  const [bundle, setBundle] = useState<ConfigBundle | null>(null);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);

  const reload = async () => {
    try {
      setBundle(await api.config.get());
    } catch (e) {
      setNote(e instanceof Error ? e.message : String(e));
    }
  };

  // Load the config once on entering the step. `reload` is redefined every
  // render, so depending on it would refetch continuously.
  useEffect(() => {
    void reload();
  }, []);

  const apply = async (fn: () => Promise<{ config: AppConfig; issues: ValidationIssue[]; registryRebuilt: boolean }>) => {
    setBusy(true);
    setNote(null);
    try {
      await fn();
      await reload();
      // A newly kept provider can make a profile usable, so re-probe rather
      // than leaving the list below stale.
      await onProvidersChanged();
    } catch (e) {
      setNote(e instanceof Error ? e.message : String(e));
    }
    setBusy(false);
  };

  const usable = providers?.usableProfiles ?? [];
  const current = providers?.profile ?? 'mock';

  return (
    <>
      <p className="hint">
        Which model writes the prose. The mock is deterministic placeholder text — fine for seeing how the machinery
        works, misleading as a sample of the writing.
      </p>

      {note ? <div className="wizard-error">{note}</div> : null}

      <h3 className="eyebrow rule">profile</h3>
      {!providers ? (
        <p className="small dimmer">checking what this machine can run…</p>
      ) : (
        <>
          <div className="row wrap">
            {(usable.includes('mock') ? usable : [...usable, 'mock']).map((name) => (
              <button
                key={name}
                className={name === current ? 'primary' : ''}
                aria-pressed={name === current}
                disabled={busy || name === current}
                onClick={() =>
                  void (async () => {
                    setBusy(true);
                    setNote(null);
                    try {
                      const res = await api.setProfile(name);
                      if (!res.ok) setNote(res.notes.join(' ') || `could not switch to ${name}`);
                      await onProvidersChanged();
                    } catch (e) {
                      setNote(e instanceof Error ? e.message : String(e));
                    }
                    setBusy(false);
                  })()
                }
              >
                {name}
              </button>
            ))}
          </div>
          <p className="small dimmer" style={{ marginTop: 'var(--s2)' }}>
            {usable.filter((p) => p !== 'mock').length === 0
              ? 'Only the mock is usable right now. Add a model below — a local server needs no key at all.'
              : `Ready to use: ${usable.filter((p) => p !== 'mock').join(', ')}.`}
          </p>
        </>
      )}

      {providers?.results.length ? (
        <details style={{ marginTop: 'var(--s3)' }}>
          <summary className="small dim" style={{ cursor: 'pointer' }}>
            what this machine can reach ({providers.results.filter((r) => r.status === 'ready').length} ready of{' '}
            {providers.results.length})
          </summary>
          <div style={{ marginTop: 'var(--s2)' }}>
            {providers.results.map((r) => (
              <div key={r.key} className="provider">
                <span className="provider-status">
                  <span className={r.status === 'ready' ? 'status fired' : 'status pending'}>
                    {r.status === 'ready' ? 'ready' : r.status === 'unknown' ? 'unknown' : 'not set'}
                  </span>
                </span>
                <span className="mono">{r.key}</span>
                {r.detail ? <span className="provider-detail">{r.detail}</span> : null}
                {r.fix ? <span className="provider-fix">→ {r.fix}</span> : null}
              </div>
            ))}
          </div>
        </details>
      ) : null}

      {bundle ? (
        <div style={{ marginTop: 'var(--s4)' }}>
          <ProvidersEditor bundle={bundle} busy={busy} apply={apply} reload={reload} />
        </div>
      ) : null}

      <div className="row" style={{ marginTop: 'var(--s4)' }}>
        <button className="primary" onClick={onBack}>
          {current === 'mock' ? 'continue on the mock' : `continue with ${current}`}
        </button>
      </div>
    </>
  );
}
