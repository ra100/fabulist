import { Fragment, useCallback, useEffect, useRef, useState } from 'react';
import {
  api,
  type BookTurn,
  type Consequence,
  type Edge,
  type Entity,
  type EntityDetail,
  type Fact,
  type Interrupt,
  type Sheet,
  type PlayResponse,
  type ProvidersReport,
  type State,
  type Thread,
  type TurnMeta,
} from './api.ts';
import { GraphView } from './views/GraphView.tsx';
import { SetupWizard } from './views/SetupWizard.tsx';
import { ConfigPanels } from './views/ConfigPanels.tsx';
import { PRESETS, resolvePalette, savePalette } from './palette.ts';
import { Mark } from './Mark.tsx';

type Tab = 'book' | 'graph' | 'cast' | 'threads' | 'causality' | 'facts' | 'settings';

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

export function App() {
  const [tab, setTab] = useState<Tab>('book');
  const [state, setState] = useState<State | null>(null);
  const [error, setError] = useState<string | null>(null);
  // null while unknown, so the wizard does not flash before the check returns.
  const [fresh, setFresh] = useState<boolean | null>(null);

  const refresh = useCallback(async () => {
    try {
      setState(await api.state());
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
          <Mark size={14} />
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
          </div>
        ) : null}
        <nav className="tabs">
          {(['book', 'graph', 'cast', 'threads', 'causality', 'facts', 'settings'] as Tab[]).map((t) => (
            <button key={t} className={tab === t ? 'active' : ''} onClick={() => setTab(t)}>
              {t}
            </button>
          ))}
          <button
            title="discard this world and set up a new one"
            onClick={async () => {
              if (!window.confirm('Discard this world and everything that happened in it?')) return;
              await api.setup.reset();
              setFresh(true);
            }}
          >
            new
          </button>
        </nav>
      </header>

      {error ? <div className="card warn" style={{ margin: 12 }}>{error}</div> : null}

      {tab === 'book' ? <BookTab state={state} onChanged={refresh} /> : null}
      {tab === 'graph' ? <GraphTab /> : null}
      {tab === 'cast' ? <CastTab /> : null}
      {tab === 'threads' ? <ThreadsTab state={state} onChanged={refresh} /> : null}
      {tab === 'causality' ? <CausalityTab /> : null}
      {tab === 'facts' ? <FactsTab /> : null}
      {tab === 'settings' ? <SettingsTab onChanged={refresh} /> : null}
    </div>
  );
}

// ---------------------------------------------------------------------- book

function BookTab({ state, onChanged }: { state: State | null; onChanged: () => void }) {
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

  const load = useCallback(async () => {
    const book = await api.book();
    setTurns(book.turns);
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

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

  return (
    <div className="main">
      <div className="pane" style={{ display: 'flex', flexDirection: 'column', padding: 0 }}>
        <div className="pane" style={{ flex: 1 }}>
          <div className="book">
            {turns.length === 0 ? (
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
                <div className="turn-tools">
                  {t.move ? <span className="move" title="gm move">{t.move}</span> : null}
                  {t.integrity && t.integrity !== 'in-character' ? <span className="status ripening">{t.integrity}</span> : null}
                  {t.lintScore != null && t.lintScore > 0 ? <span className="mono">lint {t.lintScore}</span> : null}
                  <span className="grow" />
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
              <button className="primary" disabled={busy || !input.trim()} onClick={() => void play(input)}>
                {busy ? 'writing…' : 'play'}
              </button>
            </div>
          </div>
        </div>
      </div>

      <aside className="side">
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
      </aside>
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
  const [data, setData] = useState<{ entities: Entity[]; edges: Edge[] } | null>(null);
  const [layer, setLayer] = useState('');
  const [type, setType] = useState('');
  const [selected, setSelected] = useState<string | null>(null);
  const [detail, setDetail] = useState<EntityDetail | null>(null);

  useEffect(() => {
    void api.graph({ layer: layer || undefined, type: type || undefined }).then(setData);
  }, [layer, type]);

  useEffect(() => {
    if (!selected) return void setDetail(null);
    void api.entity(selected).then(setDetail);
  }, [selected]);

  return (
    <div className="main">
      <div className="pane">
        <div className="row" style={{ marginBottom: 11 }}>
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
          <span className="dimmer small grow">
            {data ? `${data.entities.length} entities, ${data.edges.length} live edges` : 'loading'}
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

function CastTab() {
  const [cast, setCast] = useState<Array<{ sheet: Sheet; entity: Entity | null }>>([]);
  const [openId, setOpenId] = useState<string | null>(null);

  const load = useCallback(async () => setCast(await api.cast()), []);
  useEffect(() => {
    void load();
  }, [load]);

  // Location ids are slugs in the model; the reader wants the name.
  const placeName = (id: string | null | undefined) =>
    id ? (id.split(':').pop() ?? id).replace(/-/g, ' ') : 'nowhere stated';

  return (
    <div className="main">
      <div className="pane">
        <div className="cast-grid">
          {cast.map(({ sheet, entity }) => {
            const open = openId === sheet.entityId;
            return (
            <div key={sheet.entityId} className={`card${open ? ' span' : ''}`}>
              <div className="row baseline">
                <h2 className="name grow">
                  {entity?.name ?? sheet.entityId}{' '}
                  {sheet.isPlayer ? <span className="tag locked">player</span> : null}
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
                  {sheet.contract.vows.length ? (
                    <>
                      <h3 className="eyebrow rule">contract</h3>
                      <div className="stack" style={{ marginBottom: 'var(--s3)' }}>
                        {[...sheet.contract.vows].sort((a, b) => a.rank - b.rank).map((v) => (
                          <div key={v.id} className="row baseline small">
                            <span className={`status ${v.broken ? 'ripening' : 'fired'}`} style={{ minWidth: '4rem' }}>
                              {v.broken ? 'broken' : 'held'}
                            </span>
                            <span className="mono dimmer">r{v.rank}</span>
                            <span className="grow">{v.text}</span>
                          </div>
                        ))}
                      </div>
                      {sheet.contract.breakingPoint ? (
                        <div className="small dim">breaking point — {sheet.contract.breakingPoint}</div>
                      ) : null}
                      {sheet.contract.costOfBreak ? (
                        <div className="small dim">cost of breaking — {sheet.contract.costOfBreak}</div>
                      ) : null}
                    </>
                  ) : null}

                  {sheet.voice.diction ? (
                    <>
                      <h3 className="eyebrow rule" style={{ marginTop: 'var(--s4)' }}>voice</h3>
                      <div className="small dim">{sheet.voice.diction}</div>
                      {sheet.voice.samples.map((s, i) => (
                        <p
                          key={i}
                          style={{
                            font: 'italic 15px/1.55 var(--serif)',
                            color: 'var(--ink)',
                            borderLeft: '1px solid var(--rule-strong)',
                            padding: '2px 0 2px var(--s3)',
                            margin: 'var(--s2) 0 0',
                            maxWidth: '38rem',
                          }}
                        >
                          “{s}”
                        </p>
                      ))}
                      {sheet.voice.never.length ? (
                        <div className="small dimmer" style={{ marginTop: 'var(--s2)' }}>
                          never — {sheet.voice.never.join('; ')}
                        </div>
                      ) : null}
                    </>
                  ) : null}

                  <h3 className="eyebrow rule" style={{ marginTop: 'var(--s4)' }}>identity</h3>
                  <dl className="kv">
                    {(['goals', 'wounds', 'fears', 'secrets'] as const).map((k) =>
                      sheet.identity[k].length ? (
                        <Fragment key={k}>
                          <dt>{k}</dt>
                          <dd>{sheet.identity[k].join('; ')}</dd>
                        </Fragment>
                      ) : null,
                    )}
                  </dl>

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

function ThreadsTab({ state, onChanged }: { state: State | null; onChanged: () => void }) {
  const [threads, setThreads] = useState<Thread[]>([]);
  const [text, setText] = useState('');
  const [strength, setStrength] = useState('push');
  const [diff, setDiff] = useState<Array<[string, string]> | null>(null);

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
            <div key={t.id} className="card">
              <div className="row baseline">
                <h2 className="name sm grow">{t.title}</h2>
                <span className="tag">{t.status}</span>
              </div>
              <div className="small dim" style={{ margin: '5px 0 var(--s4)', maxWidth: '44rem' }}>
                {t.stakes}
              </div>
              <div className="row" style={{ maxWidth: '30rem' }}>
                <span className="eyebrow" style={{ margin: 0, minWidth: '4.5rem' }}>tension</span>
                <div className="scale">
                  <input
                    type="range" min="0" max="1" step="0.05" value={t.tension}
                    aria-label={`tension for ${t.title}`}
                    onChange={async (e) => {
                      const tension = Number(e.target.value);
                      setThreads((prev) => prev.map((x) => (x.id === t.id ? { ...x, tension } : x)));
                      await api.updateThread(t.id, { tension });
                      onChanged();
                    }}
                  />
                </div>
                <span className="mono" style={{ width: 34, textAlign: 'right' }}>{t.tension.toFixed(2)}</span>
              </div>
              <div className="small dimmer" style={{ marginTop: 'var(--s3)' }}>
                <span className="status" style={{ marginRight: 'var(--s2)' }}>ways out</span>
                {t.resolutions.join(' · ')}
              </div>
            </div>
          ))}
        </div>
      </div>

      <aside className="side">
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

function FactsTab() {
  const [facts, setFacts] = useState<Fact[]>([]);
  useEffect(() => {
    void api.facts().then(setFacts);
  }, []);

  return (
    <div className="main">
      <div className="pane">
        <div className="measure-tool">
          <p className="lede">
            Facts are true in the world; knowledge of them is per-character. The gap between the two
            is what produces dramatic irony instead of NPCs reacting to what they cannot know.
          </p>
          {facts.map((f) => (
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
                    </div>
                  ))}
                </div>
              )}
            </div>
          ))}
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

function SettingsTab({ onChanged }: { onChanged: () => void }) {
  const [style, setStyle] = useState<State['session']['style'] | null>(null);
  const [knobs, setKnobs] = useState<State['session']['knobs'] | null>(null);
  const [anchors, setAnchors] = useState<Array<{ id: number; text: string; note: string }>>([]);

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
          </div>
        ) : null}

        <ProvidersPanel />
        <ConfigPanels />

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
