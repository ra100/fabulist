import { Fragment, useCallback, useEffect, useRef, useState } from 'react';
import {
  api,
  checkServerFreshness,
  setSelectedStoryId,
  type BookTurn,
  type Consequence,
  type CurrentUser,
  type DepthMode,
  type Edge,
  type Entity,
  type EntityDetail,
  type Fact,
  type ImageProvidersReport,
  type IngestHealth,
  type Interrupt,
  type Job,
  type Sheet,
  type PlayResponse,
  type ProvidersReport,
  type StaleServer,
  type State,
  type Story,
  type Thread,
  type Timeline,
  type TurnMeta,
  type WorldSummary,
} from './api.ts';
import { GraphView } from './views/GraphView.tsx';
import { SetupWizard } from './views/SetupWizard.tsx';
import { ConfigPanels } from './views/ConfigPanels.tsx';
import { AppearanceEditor, PortraitPanel, SceneIllustration, StylePicker } from './views/Illustration.tsx';
import { SheetEditor } from './views/SheetEditor.tsx';
import { PRESETS, resolvePalette, savePalette } from './palette.ts';
import { Mark } from './Mark.tsx';

type Tab = 'book' | 'timeline' | 'graph' | 'cast' | 'threads' | 'causality' | 'facts' | 'library' | 'settings';

/** Scene numbers read as roman, the way a book numbers its parts. */
function roman(n: number): string {
  if (n < 1) return String(n);
  const table: Array<[number, string]> = [
    [1000, 'm'], [900, 'cm'], [500, 'd'], [400, 'cd'], [100, 'c'], [90, 'xc'],
    [50, 'l'], [40, 'xl'], [10, 'x'], [9, 'ix'], [5, 'v'], [4, 'iv'], [1, 'i'],
  ];
  let out = '';
  let left = n;
  for (const [v, s] of table) {
    while (left >= v) {
      out += s;
      left -= v;
    }
  }
  return out;
}

/** 12,483 -> "12.5k". Full precision is in the tooltip; the topbar needs a glance. */
function formatTokens(n: number): string {
  if (n < 1000) return String(n);
  if (n < 1_000_000) return `${(n / 1000).toFixed(1)}k`;
  return `${(n / 1_000_000).toFixed(2)}m`;
}

export function App() {
  const [tab, setTab] = useState<Tab>('book');
  const [state, setState] = useState<State | null>(null);
  const [error, setError] = useState<string | null>(null);
  // null while unknown, so the wizard does not flash before the check returns.
  const [fresh, setFresh] = useState<boolean | null>(null);
  /**
   * null while unknown. `false` means this book has canon but no protagonist —
   * what a freshly ingested world or an MCP-created story looks like. The
   * server has always reported it (`/api/setup/status`) and nothing rendered
   * it, so the symptom was an ordinary-looking empty book with no explanation.
   */
  const [hasPlayer, setHasPlayer] = useState<boolean | null>(null);
  // Non-null when the server predates this bundle. See `checkServerFreshness`.
  const [stale, setStale] = useState<StaleServer | null>(null);
  // null while unknown, `{ user: null }` when login is off or this browser
  // has no session — SettingsTab reads `.isAdmin` off this to decide
  // whether to render the system-wide panels at all (the actual boundary
  // is server-side: `requireAdmin` in `src/server/api.ts` 403s those routes
  // regardless of what this renders).
  const [currentUser, setCurrentUser] = useState<CurrentUser | null>(null);

  const refresh = useCallback(async () => {
    try {
      // Freshness is re-checked on every refresh, not just at mount. Switching
      // worlds can move you into an *empty* world, and that has to open the
      // setup wizard — a mount-only check left you looking at a book view with
      // no canon, no cast and no way to start one, which is indistinguishable
      // from the app being broken. Both reads happen together so the wizard
      // decision and the state it is deciding about cannot disagree.
      const [nextState, status] = await Promise.all([
        api.state(),
        api.setup.status().catch(() => null),
      ]);
      setState(nextState);
      // Null means the setup routes are disabled; leave the current answer
      // alone rather than guessing a world exists.
      if (status) {
        setFresh(status.fresh);
        setHasPlayer(status.hasPlayer);
      }
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, []);

  useEffect(() => {
    void (async () => {
      try {
        setFresh((await api.setup.status()).fresh);
      } catch {
        // Setup routes disabled: assume there is a world and let the views say otherwise.
        setFresh(false);
      }
      await refresh();
    })();
  }, [refresh]);

  // Independent of the world check: a stale server is worth saying even when
  // everything else looks fine, because the symptom appears later and elsewhere.
  useEffect(() => {
    void checkServerFreshness().then(setStale).catch(() => {});
  }, []);

  // Also independent of the world check: who is signed in has nothing to do
  // with which world/story is open, and must not block first paint on it.
  useEffect(() => {
    void api.auth.me().then((r) => setCurrentUser(r.user)).catch(() => setCurrentUser(null));
  }, []);

  if (fresh === null) return <div className="wizard"><div className="wizard-card dim">loading…</div></div>;

  if (fresh) {
    return (
      <SetupWizard
        onDone={async () => {
          // Load the new world *before* leaving the wizard, or the app renders
          // one frame of stale state - the previous world's name in the header.
          await refresh();
          setFresh(false);
        }}
      />
    );
  }

  return (
    <div className="app">
      <header className="topbar">
        <h1>
          {/* The shipped icon itself, as a 30px badge, taller than the 18px title so it
              reads as a logo rather than an ornament beside a word. Pointing at the real
              file rather than redrawing it means the masthead and the browser tab cannot
              drift apart — and the mark is a corner crop, so it needs the tile's bounds
              and cannot be inlined as artwork on transparency. */}
          <img className="masthead-badge" src="/favicon.svg" width={30} height={30} alt="" />
          {state?.worldTitle ?? 'Fabulist'}
        </h1>
        {state ? (
          <div className="meta">
            <span>scene <b>{state.session.scene}·{state.session.turn}</b></span>
            <span title="entities and live edges in the world model">
              <b>{state.counts.entities}</b> entities <b>{state.counts.edges}</b> edges
            </span>
            <span title="pending consequences"><b>{state.pendingConsequences}</b> in motion</span>
            {state.hiddenFired > 0 ? (
              <span className="warn" title="fired offscreen and still unseen">
                <b>{state.hiddenFired}</b> unseen
              </span>
            ) : null}
            {state.usage.calls > 0 ? (
              <span
                className="mono dimmer"
                title={`${state.usage.calls} provider call(s) this session · ${state.usage.tokensIn.toLocaleString()} in / ${state.usage.tokensOut.toLocaleString()} out`}
              >
                {formatTokens(state.usage.tokensIn + state.usage.tokensOut)} tok
              </span>
            ) : null}
          </div>
        ) : null}
        <nav className="tabs">
          {(['book', 'timeline', 'graph', 'cast', 'threads', 'causality', 'facts', 'library', 'settings'] as Tab[]).map((t) => (
            <button key={t} className={tab === t ? 'active' : ''} onClick={() => setTab(t)}>
              {t}
            </button>
          ))}
        </nav>
      </header>

      {stale ? (
        <div className="card warn" style={{ margin: 12 }}>
          <b>This page is newer than the server.</b>{' '}
          <span className="small">
            {stale.missing.length} route{stale.missing.length === 1 ? '' : 's'} this build needs
            {stale.missing.length ? <> — including <span className="mono">{stale.missing[0]}</span></> : null}
            {stale.missing.length > 1 ? <> and {stale.missing.length - 1} more</> : null}{' '}
            {stale.missing.length === 1 ? 'is' : 'are'} missing, so some controls will fail with a 404 rather than
            work. Restart it: <span className="mono">pnpm serve</span>
          </span>
        </div>
      ) : null}

      {error ? <div className="card warn" style={{ margin: 12 }}>{error}</div> : null}

      {tab === 'book' ? <BookTab state={state} hasPlayer={hasPlayer} onChanged={refresh} /> : null}
      {tab === 'timeline' ? <TimelineTab /> : null}
      {tab === 'graph' ? <GraphTab /> : null}
      {tab === 'cast' ? <CastTab state={state} /> : null}
      {tab === 'threads' ? <ThreadsTab state={state} onChanged={refresh} /> : null}
      {tab === 'causality' ? <CausalityTab /> : null}
      {tab === 'facts' ? <FactsTab /> : null}
      {tab === 'library' ? (
        <StoriesTab
          currentSceneTurn={state ? `${state.session.scene}·${state.session.turn}` : '?'}
          onSwitched={() => {
            setTab('book');
            void refresh();
          }}
          onResetToWizard={() => setFresh(true)}
          currentUser={currentUser}
        />
      ) : null}
      {tab === 'settings' ? <SettingsTab state={state} onChanged={refresh} currentUser={currentUser} /> : null}
    </div>
  );
}

/**
 * How often views re-read server state they did not change themselves.
 *
 * The app was built as "the browser is the only writer": every view reloaded
 * after its own action and never otherwise. That stopped being true the moment
 * the MCP connector could play turns — a story being written by a connected
 * model appeared nowhere until the tab was manually reloaded, which reads as
 * the app being broken rather than merely stale. 3s is slow enough to be free
 * against a local SQLite read and fast enough that a turn arriving from
 * elsewhere feels live.
 */
const LIVE_POLL_MS = 3000;

/**
 * Runs `tick` on an interval while the tab is actually visible and nothing
 * local is mid-flight.
 *
 * `paused` is what keeps this from fighting the optimistic UI: a poll landing
 * between "the player pressed send" and "the committed turn arrived" would
 * replace the streaming prose with a book that does not contain it yet.
 * `document.hidden` is honoured because a backgrounded tab polling forever is
 * how a local tool ends up on a battery-usage list.
 */
function useLivePoll(tick: () => void | Promise<void>, paused: boolean): void {
  const latest = useRef(tick);
  latest.current = tick;
  useEffect(() => {
    if (paused) return;
    let stop = false;
    const id = window.setInterval(() => {
      if (stop || document.hidden) return;
      void latest.current();
    }, LIVE_POLL_MS);
    return () => {
      stop = true;
      window.clearInterval(id);
    };
  }, [paused]);
}

/**
 * A job's completion percentage, or null when the server reported no real
 * total — a live crawl with no page ceiling has an honest count but no honest
 * fraction, and inventing one is worse than showing a spinner.
 */
function jobPercent(job: Job): number | null {
  const { current, total } = job.progress;
  if (!total || total <= 0) return null;
  return Math.min(100, Math.floor((current / total) * 100));
}

// ---------------------------------------------------------------------- book

function BookTab({ state, hasPlayer, onChanged }: { state: State | null; hasPlayer: boolean | null; onChanged: () => void }) {
  const [turns, setTurns] = useState<BookTurn[]>([]);
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const [interrupt, setInterrupt] = useState<{ interrupt: Interrupt; input: string } | null>(null);
  const [lastMeta, setLastMeta] = useState<TurnMeta | null>(null);
  const [notes, setNotes] = useState<string[]>([]);
  // Prose as it arrives, plus which gate the turn is currently passing through.
  const [streaming, setStreaming] = useState('');
  const [stage, setStage] = useState('');
  const bottom = useRef<HTMLDivElement>(null);
  /** The words already committed, waiting for their prose. */
  const [awaiting, setAwaiting] = useState<string | null>(null);
  /** Which turn just landed, so only that one animates in. */
  const [arrivingId, setArrivingId] = useState<string | null>(null);
  const seenIds = useRef<Set<string> | null>(null);
  const [closingScene, setClosingScene] = useState(false);
  /** Which turn's reroll note field is open, if any — one at a time. */
  const [rerollOpenId, setRerollOpenId] = useState<string | null>(null);
  const [rerollNote, setRerollNote] = useState('');
  /** Which turn is mid-reroll, so its button can say so and nothing else races it. */
  const [regeneratingId, setRegeneratingId] = useState<string | null>(null);
  /**
   * Only reachable below 960px, where `.side-toggle` is a real disclosure
   * rather than the `display: contents` pass-through it is on desktop — see
   * the comment on `.side-toggle` in styles.css. Closed by default there:
   * a phone screen shorter than this panel's natural height was forcing the
   * book itself to 0px height, which is the bug this whole toggle exists
   * to fix.
   */
  const [sideOpen, setSideOpen] = useState(false);
  /** Rollback panel: closed by default, since it destroys or forks committed prose and should never be one accidental click away. */
  const [rollbackOpen, setRollbackOpen] = useState(false);
  const [rollbackBusy, setRollbackBusy] = useState(false);
  const [chapters, setChapters] = useState<Array<{ chapter: number; title: string; summary: string }>>([]);

  const load = useCallback(async () => {
    const book = await api.book();
    setTurns(book.turns);
    // The why panel reads the last turn's stored meta rather than holding its
    // own copy, so a reload or a tab switch does not lose it — the meta was
    // already persisted with the turn; only the read was missing.
    const last = book.turns[book.turns.length - 1];
    if (last) {
      try {
        setLastMeta((await api.turn(last.id)).meta);
      } catch {
        // A stale panel is better than a crashed book view.
      }
    } else {
      setLastMeta(null);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  // Turns can arrive from outside this browser — the MCP connector plays into
  // the same story — so the book re-reads itself on a timer as well as after
  // its own actions. Paused while a local turn is in flight (`busy`), or the
  // poll would overwrite the streaming prose with a book that does not have it
  // yet, and while a reroll is running for the same reason.
  useLivePoll(() => {
    void load();
    onChanged();
  }, busy || regeneratingId !== null || closingScene);

  // The first render is history, not an arrival, so it does not animate.
  useEffect(() => {
    if (seenIds.current === null) {
      seenIds.current = new Set(turns.map((t) => t.id));
      return;
    }
    const fresh = turns.filter((t) => !seenIds.current!.has(t.id));
    for (const t of fresh) seenIds.current.add(t.id);
    if (!fresh.length) return;
    setArrivingId(fresh[fresh.length - 1]!.id);
    const h = window.setTimeout(() => setArrivingId(null), 600);
    return () => window.clearTimeout(h);
  }, [turns]);

  useEffect(() => {
    bottom.current?.scrollIntoView({ behavior: 'smooth' });
  }, [turns.length, awaiting]);

  async function play(text: string, override = false) {
    if (!text.trim() || busy) return;
    setBusy(true);
    setNotes([]);
    setStreaming('');
    setStage('');
    // The ruling waits ~150ms: under that it would only flash. It covers the
    // stretch where the gates run and no prose exists yet.
    const revealAwaiting = window.setTimeout(() => setAwaiting(text), 150);

    const finish = async (res: PlayResponse) => {
      const o = res.outcome;

      if (o.kind === 'interrupted') {
        setInterrupt({ interrupt: o.interrupt, input: text });
        return;
      }

      setInterrupt(null);
      if (o.kind === 'narrated') {
        setInput('');
        const meta = (await api.turn(o.turn.id)).meta;
        setLastMeta(meta);
        const n: string[] = [];
        if (res.seeded) n.push(`${res.seeded} consequence${res.seeded === 1 ? '' : 's'} set in motion`);
        for (const f of res.tick?.fired ?? []) {
          if (f.event.visibility === 'onscreen') n.push(f.event.text);
        }
        if (res.tick?.transmissions.length) n.push(`${res.tick.transmissions.length} rumour(s) travelled`);
        setNotes(n);
        await load();
        onChanged();
      } else if (o.kind === 'answered') {
        setNotes([o.text]);
      } else if (o.kind === 'blocked') {
        setNotes([`the world model refused that: ${o.reason}`, ...o.validation.issues.filter((i) => !i.repaired).map((i) => `${i.tier}: ${i.message}`)]);
      }
    };

    try {
      await api.playStream(text, override, {
        onStage: setStage,
        onToken: (chunk) => setStreaming((prev) => prev + chunk),
        onDone: (res) => void finish(res),
        onError: (message) => setNotes([message]),
      });
    } catch (e) {
      setNotes([e instanceof Error ? e.message : String(e)]);
    }
    // The committed turn is now in the book, so the provisional copy can go.
    window.clearTimeout(revealAwaiting);
    setAwaiting(null);
    setStreaming('');
    setStage('');
    setBusy(false);
  }

  /**
   * The CLI has had `/scene` since the start; the UI had nothing, so
   * hierarchical compaction was built, tested, and never ran in normal use.
   * This calls the exact same compaction path.
   */
  async function closeScene() {
    if (busy || closingScene || !turns.length) return;
    setClosingScene(true);
    try {
      const res = await api.closeScene();
      const n = [`scene ${res.closedScene} closed, now scene ${res.nowScene}`];
      if (res.summary) n.push(res.summary);
      if (res.chaptersSummarised.length) n.push(`chapter ${res.chaptersSummarised[0]} rolled up`);
      setNotes(n);
      await load();
      onChanged();
    } catch (e) {
      setNotes([e instanceof Error ? e.message : String(e)]);
    }
    setClosingScene(false);
  }

  /** Opens the rollback panel, loading the chapter list it needs on demand rather than on every book load. */
  async function openRollback() {
    if (rollbackOpen) return setRollbackOpen(false);
    try {
      setChapters((await api.chapters()).chapters);
    } catch {
      // A rollback by scene number still works with an empty chapter list.
    }
    setRollbackOpen(true);
  }

  /**
   * Rolls the book back to a scene or chapter boundary (GAPS.md 3.6). `mode`
   * defaults server-side to `'fork'` — the safe option, which branches at
   * the target into a new sibling book and switches to it, leaving this one
   * exactly as it was. `'destructive'` truncates in place with no way back,
   * so it gets its own confirmation dialog on top of the panel already
   * having to be opened deliberately.
   */
  async function doRollback(target: { scene?: number; chapter?: number }, mode: 'fork' | 'destructive') {
    if (rollbackBusy) return;
    if (mode === 'destructive') {
      const label = target.scene !== undefined ? `scene ${target.scene}` : `chapter ${target.chapter}`;
      if (!window.confirm(`Permanently discard everything from ${label} onward? This cannot be undone.`)) return;
    }
    setRollbackBusy(true);
    try {
      const result = await api.rollback({ ...target, mode });
      if (result.mode === 'fork' && result.forkedStory) {
        setNotes([`rolled back to scene ${result.toScene} — switched to a new book "${result.forkedStory.title || 'untitled'}"; this one is untouched`]);
      } else {
        setNotes([`rolled back to scene ${result.toScene}, discarding what followed`]);
      }
      setRollbackOpen(false);
      await load();
      onChanged();
    } catch (e) {
      setNotes([e instanceof Error ? e.message : String(e)]);
    }
    setRollbackBusy(false);
  }

  /**
   * Re-renders one turn's prose in place. Different sentences, same events —
   * the delta already committed never moves, only `bookProse` does (DESIGN
   * §7.2). `note` is an optional steering hint for the common case of "reroll,
   * but fix this one thing" rather than a blind retry.
   */
  async function regenerate(id: string, note: string) {
    if (regeneratingId) return;
    setRegeneratingId(id);
    try {
      await api.regenerate(id, note.trim() || undefined);
      setRerollOpenId(null);
      setRerollNote('');
      await load();
    } catch (e) {
      setNotes([e instanceof Error ? e.message : String(e)]);
    }
    setRegeneratingId(null);
  }

  return (
    <div className="main">
      <div className="pane" style={{ display: 'flex', flexDirection: 'column', padding: 0 }}>
        <div className="pane" style={{ flex: 1 }}>
          <div className="book">
            {hasPlayer === false ? (
              <div className="notice" role="status">
                <b>This book has no protagonist yet.</b>{' '}
                {state?.counts.entities
                  ? 'The world has canon, but nobody to play as — which is what a story created outside the setup wizard looks like.'
                  : 'There is no canon here yet either.'}{' '}
                Open <b>Library → start a new book</b> to run the wizard, or call <code>start_story</code> over MCP after
                picking someone with <code>list_characters</code>.
              </div>
            ) : null}
            {turns.length === 0 && hasPlayer !== false ? (
              <p className="empty">Nothing written yet. Describe what you do below.</p>
            ) : null}
            {turns.map((t, i) => {
              // A scene opening earns the rubricated initial and, unless it is the
              // very first, a break above it.
              const opensScene = i === 0 || turns[i - 1]!.scene !== t.scene;
              return (
              <Fragment key={t.id}>
                {opensScene && i > 0 ? (
                  <div className="scene-break" role="separator" aria-label={`scene ${t.scene}`}>
                    <Mark size={14} />
                    <span>scene {roman(t.scene)}</span>
                  </div>
                ) : null}
              <div
                className={`turn${t.pinned ? ' pinned' : ''}${t.id === arrivingId ? ' arriving' : ''}${opensScene ? ' opens-scene' : ''}`}
              >
                <span className="folio">{t.scene}·{t.turn}</span>
                <div className="raw">{t.rawInput}</div>
                <p className="prose">{t.bookProse}</p>
                <SceneIllustration turnId={t.id} defaultStyle={state?.session.style.visualStyle ?? 'drawing'} />
                {rerollOpenId === t.id ? (
                  <div className="row" style={{ margin: '4px 0 6px', gap: 'var(--s2)' }}>
                    <input
                      autoFocus
                      value={rerollNote}
                      placeholder="steer it, or leave blank for a plain reroll"
                      onChange={(e) => setRerollNote(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') void regenerate(t.id, rerollNote);
                        if (e.key === 'Escape') { setRerollOpenId(null); setRerollNote(''); }
                      }}
                    />
                    <button
                      className="primary"
                      disabled={regeneratingId === t.id}
                      onClick={() => regenerate(t.id, rerollNote)}
                    >
                      {regeneratingId === t.id ? 'rerolling…' : 'reroll'}
                    </button>
                    <button onClick={() => { setRerollOpenId(null); setRerollNote(''); }}>cancel</button>
                  </div>
                ) : null}
                <div className="turn-tools">
                  {t.move ? <span className="move" title="gm move">{t.move}</span> : null}
                  {t.integrity && t.integrity !== 'in-character' ? <span className="status ripening">{t.integrity}</span> : null}
                  {t.lintScore != null && t.lintScore > 0 ? <span className="mono">lint {t.lintScore}</span> : null}
                  <span className="grow" />
                  <button
                    title={t.pinned ? 'pinned passages are never rewritten' : 'different sentences, same events — what happened does not change'}
                    disabled={t.pinned || regeneratingId === t.id}
                    onClick={() => {
                      if (rerollOpenId === t.id) { setRerollOpenId(null); setRerollNote(''); }
                      else { setRerollOpenId(t.id); setRerollNote(''); }
                    }}
                  >
                    reroll
                  </button>
                  <button
                    onClick={async () => {
                      await api.pin(t.id, !t.pinned);
                      if (!t.pinned) await api.addAnchor(t.bookProse.slice(0, 300), 'pinned by the author');
                      await load();
                    }}
                  >
                    {t.pinned ? 'unpin' : 'pin'}
                  </button>
                </div>
              </div>
              </Fragment>
              );
            })}
            {/*
              One provisional turn, two phases. Before the first token there is
              nothing honest to render as prose, so it is the ruling of a page
              waiting for ink, labelled with the gate actually running. The moment
              tokens arrive the ruling gives way to them. Either way the folio and
              the author's own words are already real and already in place.

              The gate name lives here rather than in the composer hint, because
              it describes this prose and belongs beside it.
            */}
            {awaiting || streaming ? (
              <div className={`turn awaiting${streaming ? ' streaming' : ''}`} aria-live="polite">
                <span className="folio">
                  {state ? `${state.session.scene}·${state.session.turn + 1}` : '·'}
                </span>
                <div className="raw">{awaiting ?? input}</div>
                {streaming ? (
                  <p className="prose">
                    {streaming}
                    <span className="caret" />
                  </p>
                ) : (
                  <div className="ruled" aria-hidden="true"><i /><i /><i /></div>
                )}
                <div className="turn-tools">
                  <span className="stage">{stage || 'writing'}</span>
                </div>
              </div>
            ) : null}
            <div ref={bottom} />
          </div>
        </div>

        <div className="composer">
          <div className="measure">
            {interrupt ? (
              <div className="interrupt">
                <p>{interrupt.interrupt.message}</p>
                <div className="opts">
                  {interrupt.interrupt.options.map((o) => (
                    <button
                      key={o.key}
                      onClick={() => {
                        if (o.effect === 'revise' || o.effect === 'switch-character') {
                          setInterrupt(null);
                          setNotes(['nothing written — revise and try again']);
                          return;
                        }
                        void play(interrupt.input, true);
                      }}
                    >
                      <b>{o.key}</b> {o.label}
                    </button>
                  ))}
                </div>
              </div>
            ) : null}

            {notes.length ? (
              <div className="notes">
                <b>what followed</b>
                {notes.map((n, i) => (
                  <div key={i}>{n}</div>
                ))}
              </div>
            ) : null}

            {rollbackOpen ? <RollbackPanel state={state} chapters={chapters} busy={rollbackBusy} onRollback={doRollback} onCancel={() => setRollbackOpen(false)} /> : null}

            <textarea
              value={input}
              placeholder="Write roughly. The book gets the worked version."
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) void play(input);
              }}
            />
            <div className="row" style={{ marginTop: 'var(--s2)' }}>
              <span className="hint grow" style={{ marginTop: 0 }}>
                ⌘↵ to play · shorthand is fine · leading “ooc” for a directive
              </span>
              <a
                className="button-like"
                title="download the book as markdown"
                href={turns.length ? api.exportUrl('markdown') : undefined}
                aria-disabled={!turns.length}
                onClick={(e) => { if (!turns.length) e.preventDefault(); }}
              >
                export .md
              </a>
              <a
                className="button-like"
                title="download the book as plain text"
                href={turns.length ? api.exportUrl('text') : undefined}
                aria-disabled={!turns.length}
                onClick={(e) => { if (!turns.length) e.preventDefault(); }}
              >
                export .txt
              </a>
              <button
                className={rollbackOpen ? 'primary' : ''}
                title="undo the last chapter or scene"
                disabled={busy || !turns.length}
                onClick={() => void openRollback()}
              >
                roll back…
              </button>
              <button
                title="close the current scene and summarise it"
                disabled={busy || closingScene || !turns.length}
                onClick={() => void closeScene()}
              >
                {closingScene ? 'closing…' : 'close scene'}
              </button>
              <button className="primary" disabled={busy || !input.trim()} onClick={() => void play(input)}>
                {busy ? 'writing…' : 'play'}
              </button>
            </div>
          </div>
        </div>
      </div>

      <aside className="side">
        {/*
          A plain controlled toggle, not `<details>`: `<details>` hides its
          body via the browser's own closed/open rendering, which fires
          regardless of any `display` override on the host element — so a
          `display: contents` escape hatch for desktop still left the panel
          closed-and-invisible there too, the exact bug this was meant to
          fix, just moved. `sideOpen` starts `false` and only matters below
          960px; above it `.side-toggle-summary` is hidden by CSS and
          `.side-toggle-body` is always rendered, so desktop sees exactly
          what it always did.
        */}
        <div className="side-toggle">
          <button
            type="button"
            className="side-toggle-summary"
            aria-expanded={sideOpen}
            onClick={() => setSideOpen((v) => !v)}
          >
            why · threads · divergence
          </button>
          <div className="side-toggle-body" hidden={!sideOpen}>
            <WhyPanel meta={lastMeta} />
            {state ? (
              <div className="card">
                <h3>open threads</h3>
                <div className="stack">
                  {state.threads.slice(0, 6).map((t) => (
                    <div key={t.id}>
                      <div className="row baseline" style={{ marginBottom: 5 }}>
                        <span className="small grow">{t.title}</span>
                        <span className="mono dimmer">{t.tension.toFixed(2)}</span>
                      </div>
                      <div className={`meter ${t.tension >= 0.75 ? 'high' : t.tension >= 0.45 ? 'mid' : ''}`}>
                        <i style={{ width: `${t.tension * 100}%` }} />
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            ) : null}
            {state?.divergences.length ? (
              <div className="card">
                <h3>divergence ledger</h3>
                <div className="stack">
                  {state.divergences.map((d) => (
                    <div key={d.id} className="small">
                      <span className="tag chronicle">{d.kind}</span>{' '}
                      <span className="dim">{d.detail}</span>{' '}
                      <span className="mono dimmer">s{d.scene}</span>
                    </div>
                  ))}
                </div>
              </div>
            ) : null}
          </div>
        </div>
      </aside>
    </div>
  );
}

/**
 * The backward move (GAPS.md 3.6): "undo the last chapter" or "back to a
 * specific scene". Chapter is the default granularity since that is the
 * user-facing unit; scene is available for finer control. Always shows both
 * outcomes side by side — fork (the safe default) and destructive (behind
 * its own confirm) — rather than a single button whose behaviour depends on
 * a mode nobody remembers they set.
 */
function RollbackPanel({
  state, chapters, busy, onRollback, onCancel,
}: {
  state: State | null;
  chapters: Array<{ chapter: number; title: string; summary: string }>;
  busy: boolean;
  onRollback: (target: { scene?: number; chapter?: number }, mode: 'fork' | 'destructive') => void;
  onCancel: () => void;
}) {
  const [unit, setUnit] = useState<'chapter' | 'scene'>(chapters.length ? 'chapter' : 'scene');
  const [chapter, setChapter] = useState(chapters.length ? String(chapters[chapters.length - 1]!.chapter) : '');
  const currentScene = state?.session.scene ?? 1;
  const [scene, setScene] = useState(String(Math.max(1, currentScene - 1)));

  const target = unit === 'chapter'
    ? (chapter.trim() ? { chapter: Number(chapter) } : null)
    : (scene.trim() ? { scene: Number(scene) } : null);
  const valid = target !== null && Number.isFinite(unit === 'chapter' ? target.chapter : target.scene);

  return (
    <div className="notice" role="region" aria-label="roll back">
      <b>Roll back</b>
      <p className="small dim" style={{ margin: '4px 0 var(--s3)' }}>
        Currently at scene {currentScene}. The default (fork) leaves this book untouched and switches you
        to a shorter sibling; destructive discards the tail here, with no way back.
      </p>
      <div className="row" style={{ marginBottom: 'var(--s2)' }}>
        <select value={unit} onChange={(e) => setUnit(e.target.value as 'chapter' | 'scene')}>
          <option value="chapter" disabled={!chapters.length}>chapter{chapters.length ? '' : ' (none recorded yet)'}</option>
          <option value="scene">scene</option>
        </select>
        {unit === 'chapter' ? (
          <select value={chapter} onChange={(e) => setChapter(e.target.value)}>
            {chapters.map((c) => (
              <option key={c.chapter} value={c.chapter}>
                chapter {c.chapter}{c.title ? ` — ${c.title}` : ''}
              </option>
            ))}
          </select>
        ) : (
          <input
            type="number" min={1} max={Math.max(1, currentScene - 1)}
            value={scene} onChange={(e) => setScene(e.target.value)}
            aria-label="scene to roll back to"
            style={{ width: '5rem' }}
          />
        )}
      </div>
      <div className="row wrap">
        <button
          className="primary"
          disabled={busy || !valid}
          onClick={() => target && onRollback(target, 'fork')}
        >
          {busy ? 'rolling back…' : 'roll back (fork — safe)'}
        </button>
        <button
          className="warn"
          disabled={busy || !valid}
          onClick={() => target && onRollback(target, 'destructive')}
        >
          discard permanently
        </button>
        <button onClick={onCancel} disabled={busy}>cancel</button>
      </div>
    </div>
  );
}

/** Shows the machinery behind the last turn: the reason to trust it. */
function WhyPanel({ meta }: { meta: TurnMeta | null }) {
  if (!meta) return <div className="card"><h3>why</h3><p className="empty">Play a turn.</p></div>;
  return (
    <div className="card">
      <h3>why</h3>
      <dl className="kv">
        <dt>move</dt>
        <dd>{meta.move ?? '—'}</dd>
        <dt>integrity</dt>
        <dd>
          {meta.integrity?.distance ?? 'skipped'}
          {meta.integrity?.reasoning ? <div className="dimmer small">{meta.integrity.reasoning}</div> : null}
        </dd>
        <dt>referee</dt>
        <dd>
          {meta.referee?.ruling ?? '—'}
          {meta.referee?.cost ? <div className="dimmer small">cost: {meta.referee.cost}</div> : null}
        </dd>
        {meta.lint ? (
          <>
            <dt>prose lint</dt>
            <dd>
              {meta.lint.score} {meta.lint.tripped ? <span className="warn">tripped</span> : <span className="ok">clean</span>}
              {meta.lint.findings.slice(0, 5).map((f, i) => (
                <div key={i} className="dimmer small lint-finding">
                  <span className="grow">{f.rule}</span>
                  {f.excerpt ? (
                    <button
                      title={`never write "${f.excerpt}" again`}
                      onClick={() => void api.config.block(f.excerpt).catch(() => {})}
                    >
                      block
                    </button>
                  ) : null}
                </div>
              ))}
            </dd>
          </>
        ) : null}
      </dl>

      {meta.frameLog ? (
        <>
          <h3 style={{ marginTop: 13 }}>frame budget</h3>
          <div className="small dim" style={{ marginBottom: 5 }}>
            {meta.frameLog.used} / {meta.frameLog.budget} tokens
          </div>
          <div className="bar" style={{ marginBottom: 8 }}>
            <i style={{ width: `${Math.min(100, (meta.frameLog.used / meta.frameLog.budget) * 100)}%` }} />
          </div>
          {meta.frameLog.slots.map((s) => (
            <div key={s.name} className="row small">
              <span className="grow dim">{s.name}</span>
              <span className="mono">{s.tokens}</span>
            </div>
          ))}
          {meta.frameLog.evicted.length ? (
            <div className="small warn" style={{ marginTop: 6 }}>evicted: {meta.frameLog.evicted.join(', ')}</div>
          ) : null}
          {meta.frameLog.compressed.length ? (
            <div className="small dimmer">compressed: {meta.frameLog.compressed.join(', ')}</div>
          ) : null}
        </>
      ) : null}

      {meta.providerCalls.length ? (
        <>
          <h3 style={{ marginTop: 13 }}>calls</h3>
          {meta.providerCalls.map((c, i) => (
            <div key={i} className="row small">
              <span className="grow dim">{c.role}</span>
              <span className="mono dimmer">{c.tokensIn}→{c.tokensOut}</span>
            </div>
          ))}
        </>
      ) : null}
    </div>
  );
}

// --------------------------------------------------------------------- graph

function GraphTab() {
  const [data, setData] = useState<{ entities: Entity[]; edges: Edge[]; hiddenEdges: number } | null>(null);
  const [layer, setLayer] = useState('');
  const [type, setType] = useState('');
  /**
   * Off by default: mentions are ~79% of the edges in a wiki ingest and
   * drowned the typed relationships completely, which made a dense graph look
   * empty of structure. See `GET /api/graph`'s own note on the weight floor.
   */
  const [showMentions, setShowMentions] = useState(false);
  const [selected, setSelected] = useState<string | null>(null);
  const [detail, setDetail] = useState<EntityDetail | null>(null);
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<Entity[]>([]);
  const [searching, setSearching] = useState(false);

  useEffect(() => {
    void api
      .graph({ layer: layer || undefined, type: type || undefined, ...(showMentions ? { minWeight: 0 } : {}) })
      .then(setData);
  }, [layer, type, showMentions]);

  useEffect(() => {
    if (!selected) return void setDetail(null);
    void api.entity(selected).then(setDetail);
  }, [selected]);

  // A 3,000-page ingest is not something type/layer filters alone can find
  // anything in — /api/search already existed, just unused by this view.
  useEffect(() => {
    const q = query.trim();
    if (!q) {
      setResults([]);
      return;
    }
    setSearching(true);
    const h = window.setTimeout(() => {
      void api.search(q).then(setResults).finally(() => setSearching(false));
    }, 200);
    return () => window.clearTimeout(h);
  }, [query]);

  return (
    <div className="main">
      <div className="pane">
        <div className="row" style={{ marginBottom: 11 }}>
          <div className="search-box">
            <input
              value={query}
              placeholder="search entities…"
              style={{ width: 200 }}
              onChange={(e) => setQuery(e.target.value)}
            />
            {query.trim() ? (
              <div className="search-results">
                {searching ? <div className="dimmer small" style={{ padding: 'var(--s2)' }}>searching…</div> : null}
                {!searching && results.length === 0 ? (
                  <div className="dimmer small" style={{ padding: 'var(--s2)' }}>nothing found</div>
                ) : null}
                {results.map((e) => (
                  <button
                    key={e.id}
                    className="search-result"
                    onClick={() => {
                      setSelected(e.id);
                      setQuery('');
                      setResults([]);
                    }}
                  >
                    <b>{e.name}</b>
                    <span className="dimmer small">{e.type} · {e.layer}</span>
                  </button>
                ))}
              </div>
            ) : null}
          </div>
          <select value={layer} onChange={(e) => setLayer(e.target.value)} style={{ width: 170 }}>
            <option value="">both layers</option>
            <option value="canon">canon only</option>
            <option value="chronicle">chronicle only</option>
          </select>
          <select value={type} onChange={(e) => setType(e.target.value)} style={{ width: 170 }}>
            <option value="">all types</option>
            {['Character', 'Location', 'Faction', 'Item', 'Concept', 'Event'].map((t) => (
              <option key={t} value={t}>{t}</option>
            ))}
          </select>
          <label className="row small dimmer" style={{ alignItems: 'center', gap: 6, whiteSpace: 'nowrap' }}>
            <input type="checkbox" checked={showMentions} onChange={(e) => setShowMentions(e.target.checked)} />
            wikilink mentions
          </label>
          <span className="dimmer small grow">
            {data
              ? `${data.entities.length} entities, ${data.edges.length} live edges` +
                (data.hiddenEdges ? ` (${data.hiddenEdges.toLocaleString()} mentions hidden)` : '')
              : 'loading'}
          </span>
        </div>
        {data ? (
          <GraphView entities={data.entities} edges={data.edges} onSelect={setSelected} selectedId={selected} />
        ) : null}
      </div>
      <aside className="side">
        <EntityPanel detail={detail} onSelect={setSelected} entities={data?.entities} />
      </aside>
    </div>
  );
}

/**
 * The graph's whole purpose is reading relationships, so nothing here shows a raw
 * id. Names come from the loaded graph; anything missing falls back to a
 * humanised slug rather than exposing the key.
 */
function entityNamer(entities: Entity[] | undefined) {
  const byId = new Map((entities ?? []).map((e) => [e.id, e.name]));
  return (id: string) =>
    byId.get(id) ?? (id.split(':').pop() ?? id).replace(/-/g, ' ');
}

/** `keeps_secret_from` is a database predicate, not something a reader should see. */
const readPredicate = (p: string) => p.toLowerCase().replace(/_/g, ' ');

/** A real minus (U+2212), not a hyphen. Relationship values are often negative. */
const signed = (n: number, places = 1) => n.toFixed(places).replace('-', '\u2212');

function EntityPanel({
  detail,
  onSelect,
  entities,
}: {
  detail: EntityDetail | null;
  onSelect: (id: string) => void;
  entities?: Entity[];
}) {
  const nameOf = entityNamer(entities);
  if (!detail) return <div className="card"><h3>entity</h3><p className="empty">Select a node.</p></div>;
  const { entity, canon, sheet } = detail;
  return (
    <>
      <div className="card">
        <div className="row baseline">
          <h2 className="name grow">{entity.name}</h2>
          <span className={`tag ${entity.layer}`}>{entity.layer}</span>
        </div>
        <p className="small dim" style={{ margin: 'var(--s2) 0 var(--s3)' }}>
          {entity.summary || <i className="dimmer">no summary</i>}
        </p>
        <dl className="kv small">
          <dt>type</dt><dd>{entity.type}</dd>
          <dt>salience</dt><dd>{entity.salience.toFixed(2)}</dd>
          <dt>depth</dt><dd>{['none', 'skim', 'mid', 'deep'][entity.depthLevel] ?? entity.depthLevel}</dd>
          <dt>provenance</dt><dd>{entity.provenance}</dd>
          {/* The key is developer information, so it goes last and stays quiet. */}
          <dt>id</dt><dd className="mono dimmer">{entity.id}</dd>
        </dl>
        {/* Canon divergence is the point of the two-layer model, so show it. */}
        {canon && canon.summary !== entity.summary ? (
          <div className="small" style={{ marginTop: 'var(--s3)', borderTop: '1px solid var(--rule)', paddingTop: 'var(--s3)' }}>
            <span className="tag canon">canon said</span>
            <div className="dim" style={{ marginTop: 5 }}>{canon.summary}</div>
          </div>
        ) : null}
      </div>

      {sheet?.contract.vows.length ? (
        <div className="card">
          <h3>vows</h3>
          <div className="stack">
            {[...sheet.contract.vows].sort((a, b) => a.rank - b.rank).map((v) => (
              <div key={v.id} className="row baseline small">
                <span className={`status ${v.broken ? 'ripening' : 'fired'}`} style={{ minWidth: '3.4rem' }}>
                  {v.broken ? 'broken' : 'held'}
                </span>
                <span className="mono dimmer">r{v.rank}</span>
                <span className="grow">{v.text}</span>
              </div>
            ))}
          </div>
        </div>
      ) : null}

      <div className="card">
        <h3>connections out</h3>
        {detail.edgesOut.length === 0 ? <p className="empty" style={{ padding: 0 }}>none</p> : null}
        <div className="rels">
          {detail.edgesOut.map((e) => (
            <button key={e.id} className="rel" onClick={() => onSelect(e.object)}>
              <span className="rel-pred">{readPredicate(e.predicate)}</span>
              <span className="rel-name">{nameOf(e.object)}</span>
            </button>
          ))}
        </div>
        <h3 style={{ marginTop: 'var(--s4)' }}>connections in</h3>
        {detail.edgesIn.length === 0 ? <p className="empty" style={{ padding: 0 }}>none</p> : null}
        <div className="rels">
          {detail.edgesIn.map((e) => (
            <button key={e.id} className="rel" onClick={() => onSelect(e.subject)}>
              <span className="rel-pred">{readPredicate(e.predicate)}</span>
              <span className="rel-name">{nameOf(e.subject)}</span>
            </button>
          ))}
        </div>
      </div>

      {/* Asymmetry is the normal case, so both directions are shown. */}
      {detail.relationships.length || detail.relationshipsToward.length ? (
        <div className="card">
          <h3>how they regard each other</h3>
          <div className="stack">
            {[
              ...detail.relationships.map((r) => ({ ...r, id: r.toId, outward: true })),
              ...detail.relationshipsToward.map((r) => ({ ...r, id: r.fromId, outward: false })),
            ].map((r) => (
              <div key={`${r.outward ? 'o' : 'i'}${r.id}`} className="regard">
                <div className="row baseline">
                  <span className="regard-dir" title={r.outward ? 'toward them' : 'toward this character'}>
                    {r.outward ? '→' : '←'}
                  </span>
                  <button className="rel-name grow" onClick={() => onSelect(r.id)}>{nameOf(r.id)}</button>
                </div>
                <div className="regard-metrics">
                  <span><i>trust</i>{signed(r.trust)}</span>
                  <span><i>affection</i>{signed(r.affection)}</span>
                  <span><i>respect</i>{signed(r.respect)}</span>
                </div>
                {r.note ? <div className="small dimmer">{r.note}</div> : null}
              </div>
            ))}
          </div>
        </div>
      ) : null}

      {detail.knowledge.length ? (
        <div className="card">
          <h3>what they hold</h3>
          <div className="stack">
            {detail.knowledge.map((k) => (
              <div key={k.factId} className="row baseline small">
                <span
                  className={`status ${k.level === 'knows' ? 'fired' : k.level === 'wrong' ? 'ripening' : 'pending'}`}
                  style={{ minWidth: '4.2rem' }}
                >
                  {k.level}
                </span>
                <span className="grow">{k.text}</span>
              </div>
            ))}
          </div>
        </div>
      ) : null}
    </>
  );
}

// ---------------------------------------------------------------------- cast

function CastTab({ state }: { state: State | null }) {
  const [cast, setCast] = useState<Array<{ sheet: Sheet; entity: Entity | null }>>([]);
  const [openId, setOpenId] = useState<string | null>(null);
  // Same canon/chronicle distinction the graph tab filters on: canon is the
  // ingested source material, chronicle is what this playthrough has changed
  // or invented. Without it, ingest noise (a mistyped index page, a stray
  // navigation entity) sits in the same list as the cast actually being
  // played, with nothing to separate them.
  const [layer, setLayer] = useState('');

  const load = useCallback(async () => setCast(await api.cast()), []);
  useEffect(() => {
    void load();
  }, [load]);

  const visible = layer ? cast.filter(({ entity }) => entity?.layer === layer) : cast;

  // Location ids are slugs in the model; the reader wants the name.
  const placeName = (id: string | null | undefined) =>
    id ? (id.split(':').pop() ?? id).replace(/-/g, ' ') : 'nowhere stated';

  return (
    <div className="main">
      <div className="pane">
        <div className="row" style={{ marginBottom: 11 }}>
          <select value={layer} onChange={(e) => setLayer(e.target.value)} style={{ width: 170 }}>
            <option value="">both layers</option>
            <option value="canon">canon only</option>
            <option value="chronicle">chronicle only</option>
          </select>
          <span className="dimmer small grow">{visible.length} of {cast.length} shown</span>
        </div>
        <div className="cast-grid">
          {visible.map(({ sheet, entity }) => {
            const open = openId === sheet.entityId;
            return (
            <div key={sheet.entityId} className={`card${open ? ' span' : ''}`}>
              <div className="row baseline">
                <h2 className="name grow">
                  {entity?.name ?? sheet.entityId}{' '}
                  {sheet.isPlayer ? <span className="tag locked">player</span> : null}
                  {entity ? <span className={`tag ${entity.layer}`}>{entity.layer}</span> : null}
                </h2>
                <button onClick={() => setOpenId(open ? null : sheet.entityId)}>
                  {open ? 'less' : 'more'}
                </button>
              </div>
              <p className="small dim" style={{ margin: '6px 0 8px', maxWidth: '46rem' }}>
                {entity?.summary}
              </p>
              <div className="small dimmer cast-cond">
                {placeName(sheet.condition.locationId)} · {sheet.condition.mood || 'unreadable'}
                {sheet.condition.intent ? ` · ${sheet.condition.intent}` : ''}
              </div>

              {openId === sheet.entityId ? (
                <div className="sheet-detail">
                  <h3 className="eyebrow rule" style={{ marginTop: 0 }}>appearance</h3>
                  <PortraitPanel sheet={sheet} onChanged={load} />
                  <AppearanceEditor sheet={sheet} onSaved={load} />

                  <SheetEditor sheet={sheet} currentScene={state?.session.scene ?? 0} onSaved={load} />

                  {/* Locks are how nudging parameters actually works. */}
                  <h3 className="eyebrow rule" style={{ marginTop: 'var(--s4)' }}>locks</h3>
                  <div className="row wrap">
                    {['condition.mood', 'condition.intent', 'condition.locationId', 'condition.inventory'].map((path) => {
                      const on = sheet.locks.includes(path);
                      return (
                        <button
                          key={path}
                          className={on ? 'primary' : ''}
                          aria-pressed={on}
                          onClick={async () => {
                            await api.lock(sheet.entityId, path, !on);
                            await load();
                          }}
                        >
                          {on ? '◆' : '◇'} {path.replace('condition.', '').replace('locationId', 'location')}
                        </button>
                      );
                    })}
                  </div>
                  <div className="small dimmer" style={{ marginTop: 'var(--s2)' }}>
                    A locked field is ground truth; the AI may not overwrite it.
                  </div>
                </div>
              ) : null}
            </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}

// ------------------------------------------------------------------- threads

/**
 * One thread: tension is a live drag as before, title is click-to-edit
 * (retitle inline rather than a separate edit mode, matching how vows/sheet
 * fields save on blur elsewhere), and status offers "resolve" / "abandon" /
 * reopen — the "close a thread by hand" half of §11's gap. `PUT
 * /api/thread/:id` already accepted `title`/`status`; only this control was
 * missing.
 */
function ThreadCard({ thread: t, onChanged }: { thread: Thread; onChanged: () => void }) {
  const [editing, setEditing] = useState(false);
  const [title, setTitle] = useState(t.title);
  // Local echo while dragging, same reason `AppearanceEditor` echoes locally:
  // the parent list is sorted by tension, so reloading it on every drag tick
  // would resort the card out from under the pointer mid-drag.
  const [tension, setTension] = useState(t.tension);

  async function setStatus(status: string) {
    await api.updateThread(t.id, { status });
    onChanged();
  }

  return (
    <div className="card">
      <div className="row baseline">
        {editing ? (
          <input
            className="name sm grow"
            value={title}
            autoFocus
            onChange={(e) => setTitle(e.target.value)}
            onBlur={async () => {
              setEditing(false);
              if (title.trim() && title.trim() !== t.title) await api.updateThread(t.id, { title: title.trim() });
              onChanged();
            }}
            onKeyDown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); }}
          />
        ) : (
          <button
            className="name sm grow as-h2"
            title="click to retitle"
            onClick={() => setEditing(true)}
            style={{ cursor: 'text', textAlign: 'left' }}
          >
            {t.title}
          </button>
        )}
        <span className="tag">{t.status}</span>
        {t.status === 'open' ? (
          <>
            <button title="mark resolved" onClick={() => setStatus('resolved')}>resolve</button>
            <button title="mark abandoned" onClick={() => setStatus('abandoned')}>abandon</button>
          </>
        ) : (
          <button title="reopen this thread" onClick={() => setStatus('open')}>reopen</button>
        )}
      </div>
      <div className="small dim" style={{ margin: '5px 0 var(--s4)', maxWidth: '44rem' }}>
        {t.stakes}
      </div>
      <div className="row" style={{ maxWidth: '30rem' }}>
        <span className="eyebrow" style={{ margin: 0, minWidth: '4.5rem' }}>tension</span>
        <div className="scale">
          <input
            type="range" min="0" max="1" step="0.05" value={tension}
            aria-label={`tension for ${t.title}`}
            onChange={async (e) => {
              const next = Number(e.target.value);
              setTension(next);
              await api.updateThread(t.id, { tension: next });
              onChanged();
            }}
          />
        </div>
        <span className="mono" style={{ width: 34, textAlign: 'right' }}>{tension.toFixed(2)}</span>
      </div>
      {t.resolutions.length ? (
        <div className="small dimmer" style={{ marginTop: 'var(--s3)' }}>
          <span className="status" style={{ marginRight: 'var(--s2)' }}>ways out</span>
          {t.resolutions.join(' · ')}
        </div>
      ) : null}
    </div>
  );
}

function ThreadsTab({ state, onChanged }: { state: State | null; onChanged: () => void }) {
  const [threads, setThreads] = useState<Thread[]>([]);
  const [text, setText] = useState('');
  const [strength, setStrength] = useState('push');
  const [diff, setDiff] = useState<Array<[string, string]> | null>(null);
  const [newTitle, setNewTitle] = useState('');
  const [newStakes, setNewStakes] = useState('');

  const load = useCallback(async () => setThreads(await api.threads()), []);
  useEffect(() => {
    void load();
  }, [load]);

  return (
    <div className="main">
      <div className="pane">
        <div className="measure-tool">
          <p className="lede">
            Tension is the dial the director reads before it chooses what happens next. Raise one
            and the story leans on it.
          </p>
          {threads.map((t) => (
            <ThreadCard key={t.id} thread={t} onChanged={async () => { await load(); onChanged(); }} />
          ))}
          {threads.length === 0 ? <p className="empty">No threads yet — start one on the right.</p> : null}
        </div>
      </div>

      <aside className="side">
        <div className="card">
          <h3>start a thread</h3>
          <p className="small dim" style={{ margin: '0 0 var(--s3)' }}>
            The natural authoring move when the story needs tension the extractor never wrote —
            a rivalry, a debt, a countdown.
          </p>
          <input
            value={newTitle} placeholder="title — e.g. 'who told the garrison'"
            onChange={(e) => setNewTitle(e.target.value)}
          />
          <textarea
            rows={2} style={{ marginTop: 'var(--s2)' }}
            value={newStakes} placeholder="what's at stake if it resolves badly"
            onChange={(e) => setNewStakes(e.target.value)}
          />
          <button
            className="primary" style={{ marginTop: 'var(--s2)' }}
            disabled={!newTitle.trim()}
            onClick={async () => {
              await api.createThread(newTitle.trim(), newStakes.trim());
              setNewTitle('');
              setNewStakes('');
              await load();
              onChanged();
            }}
          >
            open thread
          </button>
        </div>

        <div className="card">
          <h3>direct the story</h3>
          <textarea
            rows={3} value={text}
            placeholder="turn this toward the captain searching the cells"
            onChange={(e) => setText(e.target.value)}
          />
          <div className="row" style={{ marginTop: 7 }}>
            <select value={strength} onChange={(e) => setStrength(e.target.value)}>
              <option value="hint">hint</option>
              <option value="push">push</option>
              <option value="mandate">mandate</option>
            </select>
            <button
              className="primary"
              disabled={!text.trim()}
              onClick={async () => {
                const res = await api.addDirective(text, strength);
                // Recalculation is reported, never silent: that is what keeps it
                // trustworthy in a system with offscreen machinery. Zeros are not
                // news, so only the effects that actually happened are listed.
                const d = res.diff;
                const entries: Array<[string, string]> = [];
                if (d.raisedThreadTitles.length) entries.push(['raised', d.raisedThreadTitles.join('; ')]);
                if (d.loweredThreads.length) entries.push(['lowered', `${d.loweredThreads.length} thread(s)`]);
                if (d.supersededConsequences.length) {
                  entries.push(['superseded', `${d.supersededConsequences.length} pending consequence(s)`]);
                }
                if (d.retimedConsequences.length) {
                  entries.push(['retimed', `${d.retimedConsequences.length} consequence(s)`]);
                }
                setDiff(entries.length ? entries : [['no change', 'nothing needed moving']]);
                setText('');
                await load();
                onChanged();
              }}
            >
              apply
            </button>
          </div>
          {diff ? (
            <div style={{ marginTop: 'var(--s4)' }}>
              <h3 className="eyebrow rule">recalculated</h3>
              <dl className="kv small">
                {diff.map(([k, v]) => (
                  <Fragment key={k}>
                    <dt>{k}</dt>
                    <dd>{v}</dd>
                  </Fragment>
                ))}
              </dl>
            </div>
          ) : null}
        </div>

        {state?.directives.length ? (
          <div className="card">
            <h3>active directives</h3>
            {state.directives.map((d) => (
              <div key={d.id} className="row small" style={{ marginBottom: 5 }}>
                <span className="grow">
                  <span className="tag">{d.strength}</span> {d.text}
                </span>
                <button
                  aria-label={`retire directive: ${d.text}`}
                  title="retire this directive"
                  onClick={async () => { await api.retireDirective(d.id); onChanged(); }}
                >
                  ×
                </button>
              </div>
            ))}
          </div>
        ) : null}
      </aside>
    </div>
  );
}

// ------------------------------------------------------------------ timeline

/**
 * §11's "Timeline — chronicle with the divergence points marked" (GAPS.md
 * 3.1, absorbing 3.5). Scenes, chapters and the divergence ledger already
 * existed with nothing rendering them as one connected spine — the book
 * view is a flat turn list, and the divergence ledger only ever appeared
 * in its sidebar when non-empty. This is that spine: one chapter heading
 * per chapter, one row per scene beneath it (turn count, summary when one
 * exists), and every divergence recorded at that scene inline, always
 * visible rather than hidden behind non-emptiness.
 */
function TimelineTab() {
  const [timeline, setTimeline] = useState<Timeline | null>(null);
  const [reveal, setReveal] = useState<Set<number>>(new Set());

  useEffect(() => {
    void api.timeline().then(setTimeline);
  }, []);

  if (!timeline) return <div className="main"><div className="pane"><p className="empty">Loading.</p></div></div>;

  const chapterMeta = new Map(timeline.chapters.map((c) => [c.chapter, c]));
  const byChapter = new Map<number, Timeline['scenes']>();
  for (const s of timeline.scenes) {
    const list = byChapter.get(s.chapter) ?? [];
    list.push(s);
    byChapter.set(s.chapter, list);
  }
  const chapterNumbers = [...byChapter.keys()].sort((a, b) => a - b);

  return (
    <div className="main">
      <div className="pane">
        <div className="measure-tool">
          <p className="lede">
            The record of how this playthrough actually went — where it diverged from canon, and by how
            much, scene by scene.
          </p>
          {timeline.scenes.length === 0 ? <p className="empty">Nothing played yet.</p> : null}
          <div className="timeline">
            {chapterNumbers.map((chapter) => {
              const cMeta = chapterMeta.get(chapter);
              return (
                <Fragment key={chapter}>
                  <div className="timeline-chapter-head">
                    <span>Chapter {chapter}{cMeta?.title ? `: ${cMeta.title}` : ''}</span>
                  </div>
                  {cMeta?.summary ? <p className="small dim" style={{ margin: '0 0 var(--s3)' }}>{cMeta.summary}</p> : null}
                  {byChapter.get(chapter)!.map((s) => (
                    <div key={s.scene} className={`timeline-scene${s.scene === timeline.currentScene ? ' current' : ''}`}>
                      <div className="row baseline">
                        <span className="mono" style={{ minWidth: '3.5rem' }}>s{s.scene}</span>
                        <span className="grow small">{s.title || (s.turnCount ? '' : 'not yet played')}</span>
                        <span className="dimmer small">{s.turnCount} turn{s.turnCount === 1 ? '' : 's'}</span>
                        {s.scene === timeline.currentScene ? <span className="tag locked">current</span> : null}
                      </div>
                      {s.summary ? <p className="small dim" style={{ margin: '4px 0 0' }}>{s.summary}</p> : null}
                      {s.divergences.length ? (
                        <div className="stack" style={{ marginTop: 'var(--s2)' }}>
                          {s.divergences.map((d) => {
                            const open = reveal.has(d.id);
                            return (
                              <div key={d.id} className="timeline-divergence">
                                <div className="row baseline">
                                  <span className="tag chronicle">{d.kind}</span>
                                  <span className="small grow">{d.detail}</span>
                                  {d.canon ? (
                                    <button
                                      className="link"
                                      onClick={() => setReveal((prev) => {
                                        const next = new Set(prev);
                                        if (next.has(d.id)) next.delete(d.id); else next.add(d.id);
                                        return next;
                                      })}
                                    >
                                      {open ? 'hide canon' : 'vs. canon'}
                                    </button>
                                  ) : null}
                                </div>
                                {open && d.canon ? <p className="small dimmer" style={{ margin: '2px 0 0' }}>{d.canon}</p> : null}
                              </div>
                            );
                          })}
                        </div>
                      ) : null}
                    </div>
                  ))}
                </Fragment>
              );
            })}
          </div>
        </div>
      </div>
      <aside className="side">
        <div className="card">
          <h3>reading this</h3>
          <p className="small dim">
            Every divergence here is a real branch point — the story went one way, the source material
            (or the setup) said another. That gap is what makes this a playthrough of the world rather
            than a transcript of it.
          </p>
          <div className="small dimmer" style={{ marginTop: 'var(--s3)' }}>
            {timeline.divergenceCount} divergence{timeline.divergenceCount === 1 ? '' : 's'} total
          </div>
        </div>
      </aside>
    </div>
  );
}

// ----------------------------------------------------------------- causality

function CausalityTab() {
  const [cons, setCons] = useState<Consequence[]>([]);
  const [reveal, setReveal] = useState(false);

  useEffect(() => {
    void api.consequences().then(setCons);
  }, []);

  const byDepth = [...cons].sort((a, b) => a.depth - b.depth || a.createdScene - b.createdScene);

  /**
   * Identical consequences seeded in the same scene are collapsed to one row with
   * a count. The key covers every dimension the row displays, so nothing is hidden
   * by the collapse — only the repetition goes.
   */
  const collapsed: Array<Consequence & { count: number }> = [];
  const seen = new Map<string, Consequence & { count: number }>();
  for (const c of byDepth) {
    const key = [
      c.createdScene, c.depth, c.actorName, c.action, c.maturity, c.visibility,
      c.significance.toFixed(2), c.firedScene ?? '', JSON.stringify(c.trigger),
    ].join('|');
    const hit = seen.get(key);
    if (hit) {
      hit.count += 1;
    } else {
      const row = { ...c, count: 1 };
      seen.set(key, row);
      collapsed.push(row);
    }
  }

  // Grouped by the scene that seeded them: a flat list of near-identical rows is
  // unreadable, and the scene is the thing the reader is actually tracking.
  const scenes = [...new Set(collapsed.map((c) => c.createdScene))].sort((a, b) => a - b);

  return (
    <div className="main">
      <div className="pane">
        <div className="measure-tool">
          <div className="row" style={{ marginBottom: 'var(--s4)' }}>
            <p className="lede grow" style={{ margin: 0 }}>
              What your acts set in motion. Indentation is depth from the original act.
            </p>
            <button className={reveal ? 'primary' : ''} onClick={() => setReveal(!reveal)}>
              {reveal ? 'hide spoilers' : 'reveal hidden'}
            </button>
            <button onClick={async () => { await api.tick(); setCons(await api.consequences()); }}>tick world</button>
          </div>

          <div className="chain">
            {byDepth.length === 0 ? <p className="empty">Nothing in motion yet.</p> : null}
            {scenes.map((scene) => {
              const rows = collapsed.filter((c) => c.createdScene === scene);
              const total = rows.reduce((n, r) => n + r.count, 0);
              return (
                <Fragment key={scene}>
                  <div className="scene-head">
                    <span>scene {scene}</span>
                    <span className="dimmer" style={{ letterSpacing: 0 }}>
                      {total} seeded
                    </span>
                  </div>
                  {rows.map((c) => {
                    const hidden = c.visibility === 'offscreen-hidden' && !reveal;
                    return (
                      <div key={c.id} className={`node ${c.maturity} depth-${Math.min(4, c.depth)}`}>
                        <span className={`status ${c.maturity}`}>{c.maturity}</span>
                        <span className="act">
                          <span className={hidden ? 'spoiler hidden' : 'spoiler'}>
                            <span>{c.actorName} {c.action}</span>
                          </span>
                          {c.count > 1 ? <span className="mult">×{c.count}</span> : null}
                        </span>
                        <span className="node-meta">
                          depth {c.depth} · {c.visibility.replace('-', ' ')} · significance{' '}
                          {c.significance.toFixed(2)}
                          {c.firedScene != null ? ` · fired in s${c.firedScene}` : ''}
                          {c.trigger.kind === 'after-scenes' ? ` · after ${c.trigger.scenes} scene(s)` : ''}
                        </span>
                      </div>
                    );
                  })}
                </Fragment>
              );
            })}
          </div>
        </div>
      </div>
      <aside className="side">
        <div className="card">
          <h3>reading this</h3>
          <p className="small dim">
            Most consequences should be discoverable rather than hidden. A world of pure hidden
            machinery is indistinguishable from no machinery at all, so the engine steers traces
            toward you once too much has matured unseen.
          </p>
          <div className="legend-list" style={{ marginTop: 'var(--s4)' }}>
            <div><span className="status fired">fired</span> <span className="dim">it happened</span></div>
            <div><span className="status ripening">ripening</span> <span className="dim">arriving soon</span></div>
            <div><span className="status pending">pending</span> <span className="dim">waiting on a trigger</span></div>
            <div><span className="status superseded">superseded</span> <span className="dim">a directive moved past it</span></div>
          </div>
        </div>
      </aside>
    </div>
  );
}

// --------------------------------------------------------------------- facts

/**
 * Grant/revoke controls — the authoring half of §11's "epistemics are
 * read-only" gap. The facts view could already show who knows what; there
 * was no way to fix it when the extractor gets it wrong, which is exactly
 * what produces an NPC reacting to something they should not know (or,
 * just as often, failing to react to something they plainly should).
 */
function FactsTab() {
  const [facts, setFacts] = useState<Fact[]>([]);
  const [cast, setCast] = useState<Array<{ sheet: Sheet; entity: Entity | null }>>([]);
  const [grantTarget, setGrantTarget] = useState<Record<string, string>>({});
  const [grantLevel, setGrantLevel] = useState<Record<string, string>>({});

  const load = useCallback(async () => setFacts(await api.facts()), []);
  useEffect(() => {
    void load();
    void api.cast().then(setCast);
  }, [load]);

  return (
    <div className="main">
      <div className="pane">
        <div className="measure-tool">
          <p className="lede">
            Facts are true in the world; knowledge of them is per-character. The gap between the two
            is what produces dramatic irony instead of NPCs reacting to what they cannot know.
          </p>
          {facts.map((f) => {
            const target = grantTarget[f.id] ?? '';
            const level = grantLevel[f.id] ?? 'knows';
            const knownIds = new Set(f.knowers.map((k) => k.entityId));
            const candidates = cast.filter(({ sheet }) => !knownIds.has(sheet.entityId));
            return (
              <div key={f.id} className="card">
                <div className="row baseline">
                  <p className="name sm" style={{ maxWidth: '38rem' }}>{f.text}</p>
                  <span className="grow" />
                  <span className="mono dimmer">s{f.scene}</span>
                </div>
                <h3 className="eyebrow rule" style={{ margin: 'var(--s4) 0 var(--s2)' }}>
                  who holds a version of it
                </h3>
                {f.knowers.length === 0 ? (
                  <p className="empty" style={{ padding: 0 }}>Nobody. This is still only true.</p>
                ) : (
                  <div className="knowers">
                    {f.knowers.map((k) => (
                      <div key={k.entityId} className="knower">
                        <span className="knower-name">{k.name}</span>
                        <span className={`status ${k.level === 'knows' ? 'fired' : k.level === 'wrong' ? 'ripening' : 'pending'}`}>
                          {k.level}
                        </span>
                        <span className="mono dimmer">
                          {k.distortion > 0 ? k.distortion.toFixed(1) : ''}
                        </span>
                        <button
                          aria-label={`revoke ${f.text} from ${k.name}`}
                          title="revoke — back to never told"
                          onClick={async () => { await api.revokeKnowledge(f.id, k.entityId); await load(); }}
                        >
                          ×
                        </button>
                      </div>
                    ))}
                  </div>
                )}
                {candidates.length ? (
                  <div className="row" style={{ marginTop: 'var(--s3)' }}>
                    <select
                      value={target}
                      style={{ width: 200 }}
                      onChange={(e) => setGrantTarget((prev) => ({ ...prev, [f.id]: e.target.value }))}
                    >
                      <option value="">grant to…</option>
                      {candidates.map(({ sheet, entity }) => (
                        <option key={sheet.entityId} value={sheet.entityId}>{entity?.name ?? sheet.entityId}</option>
                      ))}
                    </select>
                    <select value={level} onChange={(e) => setGrantLevel((prev) => ({ ...prev, [f.id]: e.target.value }))}>
                      <option value="knows">knows</option>
                      <option value="suspects">suspects</option>
                      <option value="wrong">wrong</option>
                    </select>
                    <button
                      disabled={!target}
                      onClick={async () => {
                        await api.grantKnowledge(f.id, target, level);
                        setGrantTarget((prev) => ({ ...prev, [f.id]: '' }));
                        await load();
                      }}
                    >
                      grant
                    </button>
                  </div>
                ) : null}
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}

/**
 * Each swatch carries its own `data-palette`, so it renders in the preset it
 * offers rather than in the active one. No colour is duplicated in JS.
 */
function PalettePicker() {
  const [current, setCurrent] = useState(resolvePalette);
  return (
    <div className="card">
      <h3>appearance</h3>
      <p className="lede" style={{ margin: '0 0 var(--s3)' }}>
        One preset per genre, each derived from a specific source rather than picked from a
        wheel. All nine are contrast-verified; the light ones follow your system by default.
      </p>
      <div className="palettes">
        {PRESETS.map((p) => (
          <button
            key={p.key}
            className={`palette-choice${current === p.key ? ' selected' : ''}`}
            aria-pressed={current === p.key}
            title={p.source}
            onClick={() => {
              savePalette(p.key);
              setCurrent(p.key);
            }}
          >
            <span className="swatch" data-palette={p.key} aria-hidden="true" />
            <span className="palette-text">
              <b>
                {p.label}
                {p.mode === 'light' ? <span className="tag">light</span> : null}
              </b>
              <span className="palette-genre">{p.genre}</span>
              <span>{p.source}</span>
            </span>
          </button>
        ))}
      </div>
    </div>
  );
}

// ------------------------------------------------------------------ settings

function SettingsTab({ state, onChanged, currentUser }: { state: State | null; onChanged: () => void; currentUser: CurrentUser | null }) {
  const [style, setStyle] = useState<State['session']['style'] | null>(null);
  const [knobs, setKnobs] = useState<State['session']['knobs'] | null>(null);
  const [anchors, setAnchors] = useState<Array<{ id: number; text: string; note: string }>>([]);
  // No `currentUser` at all (login off) means there is no admin concept in
  // play here — the same "off means unrestricted, not restricted" shape
  // `requireAdmin` uses server-side. Once login is on, only an explicit
  // `isAdmin` shows the system-wide panels below; a signed-in non-admin
  // simply never sees the controls whose routes would 403 them anyway.
  const showSystemSettings = !currentUser || currentUser.isAdmin;

  useEffect(() => {
    void api.style().then(setStyle);
    void api.knobs().then(setKnobs);
    void api.anchors().then(setAnchors);
  }, []);

  const saveStyle = async (patch: Partial<NonNullable<typeof style>>) => {
    setStyle(await api.setStyle(patch));
    onChanged();
  };
  const saveKnobs = async (patch: Partial<NonNullable<typeof knobs>>) => {
    setKnobs(await api.setKnobs(patch));
    onChanged();
  };

  return (
    <div className="main">
      <div className="pane">
        <div className="measure-tool">
        <PalettePicker />
        {style ? (
          <div className="card">
            <h3>style contract</h3>
            {([
              ['pov', ['first', 'third-limited', 'third-omniscient', 'second']],
              ['tense', ['past', 'present']],
              ['register', ['plain', 'clipped', 'lyrical', 'ornate', 'archaic']],
              ['density', ['sparse', 'balanced', 'rich']],
              ['humor', ['none', 'dry', 'absurd']],
              ['pacing', ['languid', 'steady', 'breakneck']],
            ] as const).map(([key, opts]) => (
              <label className="field-row" key={key}>
                <span>{key}</span>
                <select value={style[key] as string} onChange={(e) => void saveStyle({ [key]: e.target.value })}>
                  {opts.map((o) => <option key={o} value={o}>{o}</option>)}
                </select>
              </label>
            ))}
            <label className="field-row">
              <span>genre</span>
              <input
                defaultValue={style.genreLens}
                onBlur={(e) => void saveStyle({ genreLens: e.target.value })}
              />
            </label>
            <label className="field-row">
              <span>comparables</span>
              <input
                defaultValue={style.comparables.join(', ')}
                placeholder="naming a work beats any stack of adjectives"
                onBlur={(e) => void saveStyle({ comparables: e.target.value.split(',').map((s) => s.trim()).filter(Boolean) })}
              />
            </label>
            <label className="field-row">
              <span>scene target</span>
              <input
                type="number" defaultValue={style.sceneTarget}
                onBlur={(e) => void saveStyle({ sceneTarget: Number(e.target.value) })}
              />
            </label>
            <label className="field-row">
              <span>illustration style</span>
              <StylePicker value={style.visualStyle} onChange={(v) => void saveStyle({ visualStyle: v })} />
            </label>
            <label className="field-row block">
              <span>visual anchor</span>
              <textarea
                rows={2}
                defaultValue={style.visualAnchor}
                placeholder="what stays true in every image of this world — architecture, dress, light, palette"
                onBlur={(e) => void saveStyle({ visualAnchor: e.target.value })}
              />
            </label>
          </div>
        ) : null}

        {showSystemSettings ? <IngestHealthPanel worldTitle={state?.worldTitle} onChanged={onChanged} /> : null}
        {showSystemSettings ? <ImageProvidersPanel /> : null}
        {showSystemSettings ? <ProvidersPanel /> : null}
        <UsagePanel usage={state?.usage ?? null} />
        {showSystemSettings ? <ConfigPanels /> : null}

        {anchors.length ? (
          <div className="card">
            <h3>style anchors</h3>
            <p className="small dimmer" style={{ marginTop: 0 }}>
              Re-injected periodically. These do more to prevent drift than the lint pass does.
            </p>
            {anchors.map((a) => (
              <p
                key={a.id}
                style={{
                  font: 'italic 15px/1.55 var(--serif)',
                  color: 'var(--ink-2)',
                  borderLeft: '1px solid var(--rule-strong)',
                  padding: '2px 0 2px var(--s3)',
                  margin: 'var(--s2) 0 0',
                  maxWidth: '40rem',
                }}
              >
                “{a.text}”
              </p>
            ))}
          </div>
        ) : null}
        </div>
      </div>

      <aside className="side">
        {knobs ? (
          <div className="card">
            <h3>knobs</h3>
            <div className="knob">
              <label>character strictness</label>
              <select
                value={knobs.characterStrictness}
                onChange={(e) => void saveKnobs({ characterStrictness: e.target.value })}
              >
                <option value="permissive">permissive — narrate anything</option>
                <option value="coaching">coaching — in-fiction nudges only</option>
                <option value="strict">strict — interrupt on breach</option>
                <option value="iron">iron — interrupt on off-key too</option>
              </select>
            </div>
            <div className="knob">
              <label>canon fidelity</label>
              <select value={knobs.canonFidelity} onChange={(e) => void saveKnobs({ canonFidelity: e.target.value })}>
                <option value="strict">strict</option>
                <option value="flexible">flexible</option>
                <option value="au">alternate universe</option>
              </select>
            </div>
            {([
              ['danger', 0, 1, 0.05],
              ['pacing', 0, 1, 0.05],
              ['npcAgency', 0, 1, 0.05],
              ['propagationDepth', 1, 5, 1],
              ['ignoranceBudget', 0, 20, 1],
            ] as const).map(([key, min, max, step]) => (
              <div className="knob" key={key}>
                <label>
                  {/* camelCase is the field name, not a label */}
                  <span>{key.replace(/([a-z])([A-Z])/g, '$1 $2').toLowerCase()}</span>
                  <span className="mono">{knobs[key]}</span>
                </label>
                <div className="scale">
                  <input
                    type="range" min={min} max={max} step={step} value={knobs[key] as number}
                    onChange={(e) => void saveKnobs({ [key]: Number(e.target.value) })}
                  />
                </div>
              </div>
            ))}
            <p className="small dimmer">
              Ignorance budget caps how much may mature unseen before the engine starts steering
              traces toward you.
            </p>
          </div>
        ) : null}
      </aside>
    </div>
  );
}

/**
 * The library: both axes of "which fiction am I in".
 *
 * Two panels because there are genuinely two levels, and collapsing them is
 * what made switching look impossible. A **world** is a file — its own canon,
 * cast and images, nothing shared. A **book** is a playthrough inside one
 * world, sharing that world's canon. Worlds come first because it is the
 * coarser move, and because a player looking for "my other world" was
 * previously staring at a list of books with no indication another world could
 * exist at all.
 *
 * Every row states whether it is the open one. That was the actual bug behind
 * "I don't see a way to switch": the switching worked, but nothing marked the
 * current row, so every entry looked like an identical inert label.
 */
function StoriesTab({ currentSceneTurn, onSwitched, onResetToWizard, currentUser }: {
  currentSceneTurn: string;
  onSwitched: () => void;
  onResetToWizard: () => void;
  /** `null` when login is off (no admin concept at all — see `SettingsTab`'s identical `showSystemSettings` reasoning) or when the request has not resolved yet; the upload control below is shown either when there is no login at all or when this user is specifically an admin. */
  currentUser: CurrentUser | null;
}) {
  const [stories, setStories] = useState<Story[] | null>(null);
  const [worlds, setWorlds] = useState<WorldSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [renaming, setRenaming] = useState<{ id: string; title: string } | null>(null);
  const [worldRenaming, setWorldRenaming] = useState<{ slug: string; title: string } | null>(null);
  const [newWorldTitle, setNewWorldTitle] = useState('');
  const [forkFrom, setForkFrom] = useState<{ id: string; title: string } | null>(null);
  const [forkScene, setForkScene] = useState('');
  const [forkTitle, setForkTitle] = useState('');
  // Same "no login means no admin concept, otherwise gate on isAdmin" rule
  // SettingsTab already applies to the system-wide panels — this control
  // replaces a file every story in a world shares, the same class of
  // system-wide action, so it is gated identically rather than inventing a
  // second rule.
  const showWorldUpload = !currentUser || currentUser.isAdmin;
  // One hidden <input type="file"> per world row, keyed by slug, so each
  // row's "replace file…" button can trigger its own picker via a plain DOM
  // ref rather than lifting one shared input's target world into state.
  const uploadInputs = useRef<Record<string, HTMLInputElement | null>>({});

  const load = useCallback(async () => {
    try {
      // Both lists in parallel: they are independent reads, and a world switch
      // invalidates both, so they are always refetched together anyway.
      const [storyList, worldList] = await Promise.all([api.stories.list(), api.worlds.list()]);
      setStories(storyList);
      setWorlds(worldList.worlds);
      setError(null);
    } catch (e) {
      // A server without story/world management enabled (currentStory or
      // currentWorld not configured) 503s every route here — worth saying
      // plainly rather than showing an empty, confusing list.
      setError(e instanceof Error ? e.message : String(e));
    }
  }, []);

  useEffect(() => void load(), [load]);

  const run = async (id: string, label: string, fn: () => Promise<void>) => {
    setBusy(id + label);
    try {
      await fn();
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="main">
      <div className="pane">
        <div className="measure-tool">
          {error ? <div className="card warn">{error}</div> : null}

          <div className="card">
            <h3>worlds</h3>
            <p className="hint">
              A world is its own file: its own canon, cast and illustrations. Nothing is shared between two
              worlds. Switching closes one and opens the other — no restart, but it does replace everything on
              screen.
            </p>
            {!worlds ? (
              <p className="empty">loading…</p>
            ) : (
              worlds.map((w) => (
                <div key={w.slug} className="field-row" style={{ alignItems: 'flex-start' }}>
                  <span style={{ flex: 1 }}>
                    {worldRenaming?.slug === w.slug ? (
                      <input
                        autoFocus
                        value={worldRenaming.title}
                        onChange={(e) => setWorldRenaming({ slug: w.slug, title: e.target.value })}
                        onKeyDown={(e) => {
                          if (e.key === 'Escape') setWorldRenaming(null);
                          if (e.key === 'Enter') {
                            void run(w.slug, 'wrename', async () => {
                              await api.worlds.rename(w.slug, worldRenaming.title);
                              setWorldRenaming(null);
                              await load();
                              onSwitched();
                            });
                          }
                        }}
                      />
                    ) : (
                      <>
                        <b>{w.title || 'untitled world'}</b>
                        {w.current ? <span className="tag locked" style={{ marginLeft: 6 }}>open</span> : null}
                        <br />
                        <span className="small dimmer">
                          <span className="mono">{w.slug}</span> · {w.entityCount} entities ·{' '}
                          {w.storyCount} book{w.storyCount === 1 ? '' : 's'}
                        </span>
                      </>
                    )}
                  </span>
                  <span style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                    <button
                      className={w.current ? '' : 'primary'}
                      disabled={w.current || busy === `${w.slug}wswitch`}
                      title={w.current ? 'already open' : 'close the current world and open this one'}
                      onClick={() => void run(w.slug, 'wswitch', async () => {
                        await api.worlds.switchTo(w.slug);
                        await load();
                        onSwitched();
                      })}
                    >
                      {w.current ? 'open' : 'switch'}
                    </button>
                    <button
                      disabled={worldRenaming?.slug === w.slug}
                      onClick={() => setWorldRenaming({ slug: w.slug, title: w.title })}
                    >
                      rename
                    </button>
                    <button
                      className="warn"
                      disabled={w.current || worlds.length <= 1 || busy === `${w.slug}wdelete`}
                      title={
                        w.current
                          ? 'switch to another world before deleting this one'
                          : worlds.length <= 1
                            ? 'the only world cannot be deleted; use "discard this world" below to empty it'
                            : 'delete this world, its canon, every book in it, and its images'
                      }
                      onClick={() => {
                        if (!window.confirm(`Delete the world "${w.title || w.slug}"? This removes its canon, all ${w.storyCount} book(s) and its images. This cannot be undone.`)) return;
                        void run(w.slug, 'wdelete', async () => {
                          await api.worlds.remove(w.slug);
                          await load();
                        });
                      }}
                    >
                      delete
                    </button>
                    {showWorldUpload ? (
                      <>
                        <input
                          type="file"
                          accept=".db"
                          ref={(el) => { uploadInputs.current[w.slug] = el; }}
                          style={{ display: 'none' }}
                          onChange={(e) => {
                            const file = e.target.files?.[0];
                            e.target.value = '';
                            if (!file) return;
                            void run(w.slug, 'wupload', async () => {
                              await api.worlds.upload(w.slug, file);
                              await load();
                            });
                          }}
                        />
                        <button
                          disabled={w.current || busy === `${w.slug}wupload`}
                          title={
                            w.current
                              ? 'switch to another world before replacing its file'
                              : 'replace this world\u2019s database file with an uploaded .db \u2014 e.g. a save repaired elsewhere with sqlite3 .recover. The existing file is kept as a dated backup, not deleted.'
                          }
                          onClick={() => uploadInputs.current[w.slug]?.click()}
                        >
                          {busy === `${w.slug}wupload` ? 'uploading…' : 'replace file…'}
                        </button>
                      </>
                    ) : null}
                  </span>
                </div>
              ))
            )}
            <div className="field-row" style={{ marginTop: 'var(--s3)' }}>
              <input
                value={newWorldTitle}
                onChange={(e) => setNewWorldTitle(e.target.value)}
                placeholder="new world title — e.g. Mass Effect"
              />
              <button
                disabled={busy === 'newworld create'}
                title="creates an empty world; switch to it and the setup wizard will offer to ingest a wiki"
                onClick={() => void run('newworld', 'create', async () => {
                  await api.worlds.create(newWorldTitle.trim() || undefined);
                  setNewWorldTitle('');
                  await load();
                })}
              >
                add world
              </button>
            </div>
            <p className="hint small">
              A new world starts empty. Switch to it and the setup wizard opens, so you can ingest a wiki or
              author one by hand — the world you are in now is left untouched.
            </p>
          </div>

          <div className="card">
            <h3>books in this world</h3>
            <p className="hint">
              Every book here shares the same canon — the wiki (or authored world) underneath — but plays out
              independently: what one book's characters do, say, or learn never touches another's.
            </p>
            {!stories ? (
              <p className="empty">loading…</p>
            ) : stories.length === 0 ? (
              <p className="empty">no stories yet</p>
            ) : (
              stories.map((s) => (
                <div key={s.id} className="field-row" style={{ alignItems: 'flex-start' }}>
                  <span style={{ flex: 1 }}>
                    {renaming?.id === s.id ? (
                      <input
                        autoFocus
                        value={renaming.title}
                        onChange={(e) => setRenaming({ id: s.id, title: e.target.value })}
                        onKeyDown={async (e) => {
                          if (e.key !== 'Enter') return;
                          await run(s.id, 'rename', async () => {
                            await api.stories.rename(s.id, renaming.title);
                            setRenaming(null);
                            await load();
                          });
                        }}
                      />
                    ) : (
                      <>
                        <b>{s.title || 'untitled book'}</b>
                        {s.current ? <span className="tag locked" style={{ marginLeft: 6 }}>reading</span> : null}
                        {' — '}
                        scene {s.scene}·{s.turn}
                        {s.forkedFrom ? (
                          <span className="dimmer"> · forked at scene {s.forkedAtScene}</span>
                        ) : null}
                      </>
                    )}
                  </span>
                  <span style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                    <button
                      className={s.current ? '' : 'primary'}
                      disabled={s.current || busy === `${s.id}switch`}
                      title={s.current ? 'already reading this book' : 'open this book'}
                      onClick={() => void run(s.id, 'switch', async () => {
                        await api.stories.switchTo(s.id);
                        // Client-side selection, not just the server-side
                        // call above: once login is on, `world.storyId`
                        // resolution happens per-request from *this user's*
                        // own stories (`worldFor`, `src/store/index.ts`),
                        // not from the legacy shared pointer `switchTo`
                        // still updates for login-off compatibility. Without
                        // this, every request after a successful switch
                        // would keep resolving back to "my most recently
                        // played" rather than the one just picked.
                        setSelectedStoryId(s.id);
                        await load();
                        onSwitched();
                      })}
                    >
                      {s.current ? 'reading' : 'open'}
                    </button>
                    <button
                      disabled={renaming?.id === s.id}
                      onClick={() => setRenaming({ id: s.id, title: s.title })}
                    >
                      rename
                    </button>
                    <button
                      onClick={() => {
                        setForkFrom({ id: s.id, title: s.title });
                        setForkScene('');
                        setForkTitle('');
                      }}
                    >
                      branch…
                    </button>
                    <button
                      className="warn"
                      disabled={stories.length <= 1 || busy === `${s.id}delete`}
                      title={stories.length <= 1 ? 'the last story in a world cannot be deleted this way' : 'delete this story only — canon and every other story are unaffected'}
                      onClick={async () => {
                        if (!window.confirm(`Delete "${s.title || 'untitled story'}"? This only removes this one story — canon and other stories are unaffected.`)) return;
                        await run(s.id, 'delete', async () => {
                          await api.stories.remove(s.id);
                          await load();
                        });
                      }}
                    >
                      delete
                    </button>
                  </span>
                </div>
              ))
            )}
          </div>

          <div className="card">
            <h3>start a new book</h3>
            <p className="hint">
              A fresh playthrough of <em>this</em> world — same canon, no history. To start a different world
              instead, add one above. Currently at scene/turn {currentSceneTurn}.
            </p>
            <button
              className="primary"
              disabled={busy === 'new'}
              onClick={() => void run('new', 'create', async () => {
                await api.stories.create();
                await load();
              })}
            >
              new book
            </button>
          </div>

          {forkFrom ? (
            <div className="card">
              <h3>branch "{forkFrom.title || 'untitled story'}"</h3>
              <p className="hint">
                Leave the scene blank for a fresh story sharing only canon. Give a scene number to copy that
                story's chronicle up to (not including) that scene — a continuation from an earlier point, with
                the original left exactly as it was.
              </p>
              <label className="field-row">
                <span>title</span>
                <input value={forkTitle} onChange={(e) => setForkTitle(e.target.value)} placeholder={`${forkFrom.title || 'untitled story'} (fork)`} />
              </label>
              <label className="field-row">
                <span>continue from scene</span>
                <input value={forkScene} onChange={(e) => setForkScene(e.target.value)} placeholder="leave blank for a fresh story" inputMode="numeric" />
              </label>
              <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
                <button
                  className="primary"
                  disabled={busy === `${forkFrom.id}fork`}
                  onClick={() => void run(forkFrom.id, 'fork', async () => {
                    const scene = forkScene.trim() ? Number(forkScene.trim()) : undefined;
                    if (scene !== undefined && (!Number.isFinite(scene) || scene < 1)) throw new Error('scene must be a number of 1 or greater');
                    await api.stories.fork(forkFrom.id, forkTitle.trim() || undefined, scene);
                    setForkFrom(null);
                    await load();
                  })}
                >
                  create branch
                </button>
                <button onClick={() => setForkFrom(null)}>cancel</button>
              </div>
            </div>
          ) : null}

          <div className="card">
            <h3>empty this world</h3>
            <p className="hint warn">
              Wipes every book in <em>this</em> world, and its canon with them, so the setup wizard can run
              again from scratch. The world file stays (under the same name); it is its contents that go. To
              remove a world outright, use its delete button above.
            </p>
            <button
              className="warn"
              onClick={async () => {
                if (!window.confirm('Empty this world — every book in it, and its canon? The world itself stays, but nothing in it will.')) return;
                await api.setup.reset();
                onResetToWizard();
              }}
            >
              empty world &amp; start over
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

/**
 * The running total for the session: per-turn calls are logged and shown, but
 * nothing accumulated them, and on a paid provider that is the number you
 * actually want.
 */
function UsagePanel({ usage }: { usage: State['usage'] | null }) {
  if (!usage || usage.calls === 0) {
    return (
      <div className="card">
        <h3>session usage</h3>
        <p className="empty">Nothing spent yet.</p>
      </div>
    );
  }
  const roles = Object.entries(usage.byRole).sort((a, b) => (b[1].tokensIn + b[1].tokensOut) - (a[1].tokensIn + a[1].tokensOut));
  return (
    <div className="card">
      <h3>session usage</h3>
      <dl className="kv small">
        <dt>calls</dt><dd>{usage.calls}</dd>
        <dt>tokens in</dt><dd>{usage.tokensIn.toLocaleString()}</dd>
        <dt>tokens out</dt><dd>{usage.tokensOut.toLocaleString()}</dd>
      </dl>
      {roles.length ? (
        <>
          <h3 className="eyebrow rule" style={{ marginTop: 'var(--s4)' }}>by role</h3>
          {roles.map(([role, r]) => (
            <div key={role} className="row small">
              <span className="grow dim">{role}</span>
              <span className="mono dimmer">{r.calls}× {r.tokensIn.toLocaleString()}→{r.tokensOut.toLocaleString()}</span>
            </div>
          ))}
        </>
      ) : null}
    </div>
  );
}

/**
 * "Finish reading this wiki" for a world an ingest left partway through — a
 * token expiring 600 pages into a 3,000-page `deep` crawl used to have no
 * recovery but re-running the whole ingest from the wizard and paying for
 * every page a second time. `SetupService.ingestHealth`/`continueIngest` make
 * that a genuine resume: pages Pass B already finished are never re-sent to
 * the model, only what is still pending or came back `failed`.
 *
 * Absent entirely for a world with no wiki behind it (`hasContext: false` —
 * the sample, or a custom-described world): there is nothing to continue, and
 * saying so would just be noise on every settings screen that will never use
 * this panel.
 */
function IngestHealthPanel({ worldTitle, onChanged }: { worldTitle: string | undefined; onChanged: () => void }) {
  const [health, setHealth] = useState<IngestHealth | null>(null);
  const [job, setJob] = useState<Job | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [moreSeeds, setMoreSeeds] = useState('');
  const [deeper, setDeeper] = useState(false);
  // Blank leaves this world's stored budget alone; a number re-crawls wider.
  const [morePages, setMorePages] = useState('');

  const refresh = useCallback(async () => {
    try {
      setHealth(await api.setup.ingestHealth());
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh, worldTitle]);

  // Poll while a continue job is running, same shape as the wizard's own job
  // polling — stages and counts, never a fake percentage.
  const pollRef = useRef<number | null>(null);
  useEffect(() => {
    if (job?.status !== 'running') return;
    const tick = async () => {
      try {
        const next = await api.setup.job(job.id);
        setJob(next);
        if (next.status !== 'running') {
          await refresh();
          onChanged();
        }
      } catch {
        // A dropped poll is not fatal; the next tick retries.
      }
    };
    pollRef.current = window.setInterval(tick, 700);
    return () => {
      if (pollRef.current) window.clearInterval(pollRef.current);
    };
  }, [job, refresh, onChanged]);

  // The escalation ladder stops at deep: "all" is a whole-wiki budget and is
  // only servable from an offline dump ingest, so it is never something this
  // one-click widen can put a world into.
  const nextMode = (current: DepthMode): DepthMode =>
    current === 'skim' ? 'mid' : current === 'mid' ? 'deep' : 'deep';

  const start = (widen: boolean) =>
    void (async () => {
      setBusy(true);
      setError(null);
      try {
        const overrides: { seeds?: string[]; mode?: string; maxPages?: number } = {};
        if (widen) {
          const added = moreSeeds.split(',').map((s) => s.trim()).filter(Boolean);
          if (added.length && health?.context) overrides.seeds = [...health.context.seeds, ...added];
          if (deeper && health?.context) overrides.mode = nextMode(health.context.mode);
          // Re-crawls at the wider budget; every page Pass B already finished
          // is skipped, so widening only pays for what is new.
          if (morePages) overrides.maxPages = Number(morePages);
        }
        setJob(await api.setup.continue(overrides));
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      }
      setBusy(false);
    })();

  if (!health?.hasContext) return null; // nothing to continue: not a wiki ingest

  const { context, pagesDone, pagesFailed, pagesPending } = health;
  const total = pagesDone + pagesFailed + pagesPending;
  const complete = total > 0 && pagesFailed === 0 && pagesPending === 0;

  return (
    <div className="card">
      <div className="row">
        <h3 className="grow" style={{ margin: 0 }}>reading {context?.wikiName}</h3>
        <button disabled={busy} onClick={() => void refresh()}>refresh</button>
      </div>

      {error ? <p className="small warn">{error}</p> : null}

      <p className="small dim" style={{ marginTop: 8 }}>
        {context?.mode} mode · {context?.seeds.join(', ')}
      </p>

      {total > 0 ? (
        <>
          <div className="bar" style={{ margin: 'var(--s2) 0' }}>
            <i style={{ width: `${Math.round((pagesDone / total) * 100)}%` }} />
          </div>
          <p className="small dimmer">
            {pagesDone} of {total} pages read
            {pagesFailed ? `, ${pagesFailed} failed (a dead token or rate limit, most likely)` : ''}
            {pagesPending ? `, ${pagesPending} not yet reached` : ''}
          </p>
        </>
      ) : (
        <p className="small dimmer">Pass A ran; the LLM pass has not started or this mode skips it.</p>
      )}

      {job ? (
        <div className="progress" style={{ padding: 'var(--s2) 0' }}>
          <div className="progress-stage">
            {job.progress.stage}
            {jobPercent(job) === null ? null : (
              <span className="dimmer mono" style={{ marginLeft: 8 }}>{jobPercent(job)}%</span>
            )}
          </div>
          {job.progress.detail ? <div className="dim small">{job.progress.detail}</div> : null}
          {job.status === 'running' ? (
            jobPercent(job) !== null ? (
              <div className="bar">
                <i style={{ width: `${jobPercent(job)}%` }} />
              </div>
            ) : (
              <div className="spinner" />
            )
          ) : (
            <p className="small dim">{job.status === 'failed' ? job.error : 'done.'}</p>
          )}
        </div>
      ) : null}

      {!complete || pagesFailed ? (
        <div className="row" style={{ marginTop: 'var(--s3)' }}>
          <button className="primary" disabled={busy || job?.status === 'running'} onClick={() => start(false)}>
            {pagesFailed || pagesPending ? 'continue reading' : 'start pass B'}
          </button>
        </div>
      ) : (
        <p className="small dim" style={{ marginTop: 'var(--s2)' }}>Fully read at {context?.mode} mode.</p>
      )}

      <details style={{ marginTop: 'var(--s3)' }}>
        <summary className="small dim" style={{ cursor: 'pointer' }}>read more</summary>
        <div style={{ marginTop: 'var(--s2)' }}>
          <label className="field-row">
            <span>more seeds</span>
            <input
              value={moreSeeds}
              placeholder="another page or category, comma-separated"
              onChange={(e) => setMoreSeeds(e.target.value)}
            />
          </label>
          <label className="field-row">
            <span>page budget</span>
            <input
              inputMode="numeric"
              value={morePages}
              placeholder={
                context?.budgets?.maxPages === 'all'
                  ? 'all'
                  : context?.budgets?.maxPages
                    ? String(context.budgets.maxPages)
                    : 'the mode default'
              }
              onChange={(e) => setMorePages(e.target.value.replace(/[^0-9]/g, ''))}
            />
          </label>
          {context && context.mode !== 'deep' && context.mode !== 'all' ? (
            <label className="field-row">
              <span>go deeper</span>
              <span className="row" style={{ alignItems: 'center', gap: 'var(--s2)' }}>
                <input type="checkbox" checked={deeper} onChange={(e) => setDeeper(e.target.checked)} />
                <span className="small dimmer">{context.mode} → {nextMode(context.mode)}</span>
              </span>
            </label>
          ) : null}
          <div className="row" style={{ marginTop: 'var(--s2)' }}>
            <button disabled={busy || job?.status === 'running' || (!moreSeeds.trim() && !deeper && !morePages)} onClick={() => start(true)}>
              read more
            </button>
          </div>
        </div>
      </details>
    </div>
  );
}

/**
 * Which image providers are usable here, and which one is in use.
 *
 * "Off" is always offered and is the honest default: unlike text narration,
 * which always needs *some* provider, illustration is optional and a fresh
 * install should not silently start writing image files nobody asked for.
 *
 * Probes on mount rather than on a button, unlike `ProvidersPanel`. It used to
 * be probe-on-demand and that was a discoverability bug, not a saving: the
 * provider list *and* the switcher both live behind the probe, so before the
 * click this panel was a single dim sentence and there was no visible way to
 * choose an image provider at all. The probe is local (a port check and a
 * credential lookup, no third-party calls), so paying for it on mount is
 * cheaper than a user concluding the feature does not exist.
 */
function ImageProvidersPanel() {
  const [report, setReport] = useState<ImageProvidersReport | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const probe = async () => {
    setBusy(true);
    setError(null);
    try {
      setReport(await api.images.providers());
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
    setBusy(false);
  };

  // Probe once on mount; the button re-runs it on demand. `probe` is
  // deliberately not a dependency — it is redefined every render, so depending
  // on it would re-probe on every keystroke elsewhere in the panel.
  useEffect(() => {
    void probe();
  }, []);

  const badge = (status: string) =>
    status === 'ready' ? (
      <span className="status fired">ready</span>
    ) : status === 'unknown' ? (
      <span className="status pending">unknown</span>
    ) : (
      <span className="status pending">not set</span>
    );

  const setProfile = (name: string | null) =>
    void (async () => {
      setBusy(true);
      setError(null);
      try {
        await api.images.setProfile(name);
        setReport(await api.images.providers());
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      }
      setBusy(false);
    })();

  return (
    <div className="card">
      <div className="row">
        <h3 className="grow" style={{ margin: 0 }}>illustration</h3>
        <button disabled={busy} onClick={() => void probe()}>
          {busy ? 'checking…' : 'recheck'}
        </button>
      </div>

      {error ? <p className="small warn">{error}</p> : null}

      {!report ? (
        <p className="small dimmer" style={{ marginTop: 8 }}>
          {busy ? 'checking a local ComfyUI server and the bedrock image models…' : 'no answer yet — press recheck.'}
        </p>
      ) : null}

      {report ? (
        <>
          <p className="small dim" style={{ marginTop: 8 }}>
            current: <b>{report.profile}</b>
            {report.profile === 'none' ? ' — nothing generates until you pick one below' : null}
          </p>
          {report.results.map((r) => (
            <div key={r.key} className="provider">
              <span className="provider-status">{badge(r.status)}</span>
              <span className="mono">{r.key}</span>
              <span className="provider-auth">{r.kind}</span>
              {r.detail ? <span className="provider-detail">{r.detail}</span> : null}
              {r.fix ? <span className="provider-fix">→ {r.fix}</span> : null}
            </div>
          ))}
          <h3 className="eyebrow rule" style={{ marginTop: 'var(--s4)' }}>switch provider</h3>
          <div className="row wrap">
            <button
              className={report.profile === 'none' ? 'primary' : ''}
              aria-pressed={report.profile === 'none'}
              disabled={busy || report.profile === 'none'}
              onClick={() => setProfile(null)}
            >
              off
            </button>
            {report.results.map((r) => (
              <button
                key={r.key}
                className={r.key === report.profile ? 'primary' : ''}
                aria-pressed={r.key === report.profile}
                disabled={busy || r.key === report.profile}
                onClick={() => setProfile(r.key)}
              >
                {r.key}
              </button>
            ))}
          </div>
          <p className="small dimmer" style={{ marginTop: 'var(--s2)' }}>
            Takes effect on the next generation. No restart.
          </p>
        </>
      ) : null}
    </div>
  );
}

/**
 * Which models are usable here, and the one-line fix for the ones that are not.
 * Probing touches local ports and credential helpers, so it is on demand.
 */
function ProvidersPanel() {
  const [report, setReport] = useState<ProvidersReport | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const probe = async () => {
    setBusy(true);
    setError(null);
    try {
      setReport(await api.providers());
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
    setBusy(false);
  };

  // The state is information; the fix is the action. Only the action takes colour.
  const badge = (status: string) =>
    status === 'ready' ? (
      <span className="status fired">ready</span>
    ) : status === 'unknown' ? (
      <span className="status pending">unknown</span>
    ) : (
      <span className="status pending">not set</span>
    );

  return (
    <div className="card">
      <div className="row">
        <h3 className="grow" style={{ margin: 0 }}>models available here</h3>
        <button disabled={busy} onClick={() => void probe()}>
          {busy ? 'checking…' : report ? 'recheck' : 'check'}
        </button>
      </div>

      {error ? <p className="small warn">{error}</p> : null}

      {!report && !busy ? (
        <p className="small dimmer" style={{ marginTop: 8 }}>
          Checks local servers, AWS profiles, gcloud logins and API keys. Nothing is sent anywhere.
        </p>
      ) : null}

      {report ? (
        <>
          <p className="small dim" style={{ marginTop: 8 }}>
            profile <b>{report.profile}</b>
            {report.usableProfiles.length ? ` · usable now: ${report.usableProfiles.join(', ')}` : ' · nothing but the mock is usable'}
          </p>
          {report.results.map((r) => (
            <div key={r.key} className="provider">
              <span className="provider-status">{badge(r.status)}</span>
              <span className="mono">{r.key}</span>
              <span className="provider-auth">{r.auth}</span>
              {r.detail ? <span className="provider-detail">{r.detail}</span> : null}
              {r.fix ? <span className="provider-fix">→ {r.fix}</span> : null}
            </div>
          ))}
          {report.usableProfiles.length ? (
            <>
              <h3 className="eyebrow rule" style={{ marginTop: 'var(--s4)' }}>switch profile</h3>
              <div className="row wrap">
                {(report.usableProfiles.includes('mock') ? report.usableProfiles : [...report.usableProfiles, 'mock']).map((name) => (
                  <button
                    key={name}
                    className={name === report.profile ? 'primary' : ''}
                    aria-pressed={name === report.profile}
                    disabled={busy || name === report.profile}
                    onClick={() =>
                      void (async () => {
                        setBusy(true);
                        setError(null);
                        try {
                          await api.setProfile(name);
                          setReport(await api.providers());
                        } catch (e) {
                          setError(e instanceof Error ? e.message : String(e));
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
                Takes effect on the next turn. No restart.
              </p>
            </>
          ) : null}
        </>
      ) : null}
    </div>
  );
}
