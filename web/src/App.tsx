import { useCallback, useEffect, useRef, useState } from 'react';
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
  type ProvidersReport,
  type State,
  type Thread,
  type TurnMeta,
} from './api.ts';
import { GraphView } from './views/GraphView.tsx';
import { SetupWizard } from './views/SetupWizard.tsx';

type Tab = 'book' | 'graph' | 'cast' | 'threads' | 'causality' | 'facts' | 'settings';

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
        <h1>{state?.worldTitle ?? 'Fabulist'}</h1>
        {state ? (
          <div className="meta">
            <span>scene {state.session.scene}·{state.session.turn}</span>
            <span>{state.counts.entities}e / {state.counts.edges}v</span>
            <span title="pending consequences">{state.pendingConsequences} in motion</span>
            {state.hiddenFired > 0 ? (
              <span className="warn" title="fired offscreen and still unseen">
                {state.hiddenFired} unseen
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
  const bottom = useRef<HTMLDivElement>(null);

  const load = useCallback(async () => {
    const book = await api.book();
    setTurns(book.turns);
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    bottom.current?.scrollIntoView({ behavior: 'smooth' });
  }, [turns.length]);

  async function play(text: string, override = false) {
    if (!text.trim() || busy) return;
    setBusy(true);
    setNotes([]);
    try {
      const res = await api.play(text, override);
      const o = res.outcome;

      if (o.kind === 'interrupted') {
        setInterrupt({ interrupt: o.interrupt, input: text });
        setBusy(false);
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
    } catch (e) {
      setNotes([e instanceof Error ? e.message : String(e)]);
    }
    setBusy(false);
  }

  return (
    <div className="main">
      <div className="pane" style={{ display: 'flex', flexDirection: 'column', padding: 0 }}>
        <div className="pane" style={{ flex: 1 }}>
          <div className="book">
            {turns.length === 0 ? <p className="empty">Nothing written yet.</p> : null}
            {turns.map((t) => (
              <div key={t.id} className={`turn${t.pinned ? ' pinned' : ''}`}>
                <div className="raw">{t.rawInput}</div>
                <p className="prose">{t.bookProse}</p>
                <div className="turn-tools">
                  <span>s{t.scene}·{t.turn}</span>
                  {t.move ? <span title="gm move">{t.move}</span> : null}
                  {t.integrity && t.integrity !== 'in-character' ? <span className="warn">{t.integrity}</span> : null}
                  {t.lintScore != null && t.lintScore > 0 ? <span className="dimmer">lint {t.lintScore}</span> : null}
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
            ))}
            <div ref={bottom} />
          </div>
        </div>

        <div className="composer">
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
                    <b>{o.key}</b> — {o.label}
                  </button>
                ))}
              </div>
            </div>
          ) : null}

          {notes.length ? (
            <div className="small dim" style={{ marginBottom: 8 }}>
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
          <div className="row" style={{ marginTop: 8 }}>
            <span className="hint grow">⌘↵ to play · shorthand is fine · leading “ooc” for a directive</span>
            <button className="primary" disabled={busy || !input.trim()} onClick={() => void play(input)}>
              {busy ? 'writing…' : 'play'}
            </button>
          </div>
        </div>
      </div>

      <aside className="side">
        <WhyPanel meta={lastMeta} />
        {state ? (
          <div className="card">
            <h3>open threads</h3>
            {state.threads.slice(0, 6).map((t) => (
              <div key={t.id} style={{ marginBottom: 9 }}>
                <div className="small">{t.title}</div>
                <div className="bar">
                  <i style={{ width: `${t.tension * 100}%` }} />
                </div>
              </div>
            ))}
          </div>
        ) : null}
        {state?.divergences.length ? (
          <div className="card">
            <h3>divergence ledger</h3>
            {state.divergences.map((d) => (
              <div key={d.id} className="small dim">
                s{d.scene} {d.kind}: {d.detail}
              </div>
            ))}
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
              {meta.lint.findings.slice(0, 4).map((f, i) => (
                <div key={i} className="dimmer small">{f.rule}</div>
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
        <EntityPanel detail={detail} onSelect={setSelected} />
      </aside>
    </div>
  );
}

function EntityPanel({ detail, onSelect }: { detail: EntityDetail | null; onSelect: (id: string) => void }) {
  if (!detail) return <div className="card"><h3>entity</h3><p className="empty">Select a node.</p></div>;
  const { entity, canon, sheet } = detail;
  return (
    <>
      <div className="card">
        <div className="row">
          <h3 className="grow" style={{ margin: 0 }}>{entity.name}</h3>
          <span className={`tag ${entity.layer}`}>{entity.layer}</span>
        </div>
        <p className="small" style={{ marginTop: 8 }}>{entity.summary || <i className="dimmer">no summary</i>}</p>
        <dl className="kv small">
          <dt>id</dt><dd className="mono">{entity.id}</dd>
          <dt>type</dt><dd>{entity.type}</dd>
          <dt>salience</dt><dd>{entity.salience.toFixed(2)}</dd>
          <dt>depth</dt><dd>{['none', 'skim', 'mid', 'deep'][entity.depthLevel] ?? entity.depthLevel}</dd>
          <dt>provenance</dt><dd className="mono dimmer">{entity.provenance}</dd>
        </dl>
        {/* Canon divergence is the point of the two-layer model, so show it. */}
        {canon && canon.summary !== entity.summary ? (
          <div className="small" style={{ marginTop: 9, borderTop: '1px solid var(--line)', paddingTop: 8 }}>
            <span className="tag canon">canon said</span>
            <div className="dim" style={{ marginTop: 5 }}>{canon.summary}</div>
          </div>
        ) : null}
      </div>

      {sheet?.contract.vows.length ? (
        <div className="card">
          <h3>vows</h3>
          {[...sheet.contract.vows].sort((a, b) => a.rank - b.rank).map((v) => (
            <div key={v.id} className="small" style={{ marginBottom: 5 }}>
              <span className={v.broken ? 'warn' : 'ok'}>{v.broken ? 'broken' : 'held'}</span>{' '}
              <span className="dimmer mono">r{v.rank}</span> {v.text}
            </div>
          ))}
        </div>
      ) : null}

      <div className="card">
        <h3>edges out</h3>
        {detail.edgesOut.length === 0 ? <p className="empty">none</p> : null}
        {detail.edgesOut.map((e) => (
          <div key={e.id} className="small row">
            <span className="mono dimmer" style={{ width: 118 }}>{e.predicate.toLowerCase()}</span>
            <button className="grow" style={{ textAlign: 'left', background: 'none', border: 'none', padding: 0 }} onClick={() => onSelect(e.object)}>
              {e.object}
            </button>
          </div>
        ))}
        <h3 style={{ marginTop: 12 }}>edges in</h3>
        {detail.edgesIn.length === 0 ? <p className="empty">none</p> : null}
        {detail.edgesIn.map((e) => (
          <div key={e.id} className="small row">
            <span className="mono dimmer" style={{ width: 118 }}>{e.predicate.toLowerCase()}</span>
            <button className="grow" style={{ textAlign: 'left', background: 'none', border: 'none', padding: 0 }} onClick={() => onSelect(e.subject)}>
              {e.subject}
            </button>
          </div>
        ))}
      </div>

      {/* Asymmetry is the normal case, so both directions are shown side by side. */}
      {detail.relationships.length || detail.relationshipsToward.length ? (
        <div className="card">
          <h3>relationships</h3>
          {detail.relationships.map((r) => (
            <div key={`o${r.toId}`} className="small">
              → {r.toId} <span className="dimmer mono">t{r.trust.toFixed(1)} a{r.affection.toFixed(1)} r{r.respect.toFixed(1)}</span>
              {r.note ? <div className="dimmer">{r.note}</div> : null}
            </div>
          ))}
          {detail.relationshipsToward.map((r) => (
            <div key={`i${r.fromId}`} className="small" style={{ marginTop: 4 }}>
              ← {r.fromId} <span className="dimmer mono">t{r.trust.toFixed(1)} a{r.affection.toFixed(1)} r{r.respect.toFixed(1)}</span>
              {r.note ? <div className="dimmer">{r.note}</div> : null}
            </div>
          ))}
        </div>
      ) : null}

      {detail.knowledge.length ? (
        <div className="card">
          <h3>knows</h3>
          {detail.knowledge.map((k) => (
            <div key={k.factId} className="small">
              <span className={k.level === 'knows' ? 'ok' : k.level === 'wrong' ? 'warn' : 'dim'}>[{k.level}]</span> {k.text}
            </div>
          ))}
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

  return (
    <div className="main">
      <div className="pane">
        {cast.map(({ sheet, entity }) => (
          <div key={sheet.entityId} className="card">
            <div className="row">
              <h3 className="grow" style={{ margin: 0 }}>
                {entity?.name ?? sheet.entityId} {sheet.isPlayer ? <span className="tag locked">player</span> : null}
              </h3>
              <button onClick={() => setOpenId(openId === sheet.entityId ? null : sheet.entityId)}>
                {openId === sheet.entityId ? 'less' : 'more'}
              </button>
            </div>
            <p className="small dim">{entity?.summary}</p>
            <div className="small">
              at {sheet.condition.locationId ?? '—'} · {sheet.condition.mood || 'unreadable'}
              {sheet.condition.intent ? ` · ${sheet.condition.intent}` : ''}
            </div>

            {openId === sheet.entityId ? (
              <div style={{ marginTop: 11, borderTop: '1px solid var(--line)', paddingTop: 10 }}>
                {sheet.contract.vows.length ? (
                  <>
                    <h3>contract</h3>
                    {[...sheet.contract.vows].sort((a, b) => a.rank - b.rank).map((v) => (
                      <div key={v.id} className="small">
                        <span className={v.broken ? 'warn' : 'ok'}>{v.broken ? 'broken' : 'held'}</span> r{v.rank} {v.text}
                      </div>
                    ))}
                    {sheet.contract.breakingPoint ? (
                      <div className="small dim" style={{ marginTop: 5 }}>breaking point: {sheet.contract.breakingPoint}</div>
                    ) : null}
                    {sheet.contract.costOfBreak ? (
                      <div className="small dim">cost of breaking: {sheet.contract.costOfBreak}</div>
                    ) : null}
                  </>
                ) : null}

                {sheet.voice.diction ? (
                  <>
                    <h3 style={{ marginTop: 11 }}>voice</h3>
                    <div className="small">{sheet.voice.diction}</div>
                    {sheet.voice.samples.map((s, i) => (
                      <div key={i} className="small dim" style={{ fontStyle: 'italic' }}>“{s}”</div>
                    ))}
                    {sheet.voice.never.length ? (
                      <div className="small dimmer">never: {sheet.voice.never.join('; ')}</div>
                    ) : null}
                  </>
                ) : null}

                <h3 style={{ marginTop: 11 }}>identity</h3>
                {(['goals', 'wounds', 'fears', 'secrets'] as const).map((k) =>
                  sheet.identity[k].length ? (
                    <div key={k} className="small">
                      <span className="dim">{k}:</span> {sheet.identity[k].join('; ')}
                    </div>
                  ) : null,
                )}

                {/* Locks are how nudging parameters actually works. */}
                <h3 style={{ marginTop: 11 }}>locks</h3>
                <div className="row small" style={{ flexWrap: 'wrap', gap: 6 }}>
                  {['condition.mood', 'condition.intent', 'condition.locationId', 'condition.inventory'].map((path) => {
                    const on = sheet.locks.includes(path);
                    return (
                      <button
                        key={path}
                        className={on ? 'primary' : ''}
                        onClick={async () => {
                          await api.lock(sheet.entityId, path, !on);
                          await load();
                        }}
                      >
                        {on ? '🔒' : '🔓'} {path.replace('condition.', '')}
                      </button>
                    );
                  })}
                </div>
                <div className="small dimmer" style={{ marginTop: 5 }}>
                  A locked field is ground truth; the AI may not overwrite it.
                </div>
              </div>
            ) : null}
          </div>
        ))}
      </div>
    </div>
  );
}

// ------------------------------------------------------------------- threads

function ThreadsTab({ state, onChanged }: { state: State | null; onChanged: () => void }) {
  const [threads, setThreads] = useState<Thread[]>([]);
  const [text, setText] = useState('');
  const [strength, setStrength] = useState('push');
  const [diff, setDiff] = useState<string[] | null>(null);

  const load = useCallback(async () => setThreads(await api.threads()), []);
  useEffect(() => {
    void load();
  }, [load]);

  return (
    <div className="main">
      <div className="pane">
        {threads.map((t) => (
          <div key={t.id} className="card">
            <div className="row">
              <span className="grow">{t.title}</span>
              <span className="tag">{t.status}</span>
            </div>
            <div className="small dim" style={{ margin: '5px 0' }}>{t.stakes}</div>
            <div className="row">
              <input
                type="range" min="0" max="1" step="0.05" value={t.tension}
                onChange={async (e) => {
                  const tension = Number(e.target.value);
                  setThreads((prev) => prev.map((x) => (x.id === t.id ? { ...x, tension } : x)));
                  await api.updateThread(t.id, { tension });
                  onChanged();
                }}
              />
              <span className="mono dimmer" style={{ width: 40 }}>{t.tension.toFixed(2)}</span>
            </div>
            <div className="small dimmer" style={{ marginTop: 5 }}>
              possible: {t.resolutions.join(' / ')}
            </div>
          </div>
        ))}
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
                // trustworthy in a system with offscreen machinery.
                setDiff([
                  `raised: ${res.diff.raisedThreadTitles.join('; ') || 'none'}`,
                  `lowered: ${res.diff.loweredThreads.length}`,
                  `superseded: ${res.diff.supersededConsequences.length} pending consequence(s)`,
                  `retimed: ${res.diff.retimedConsequences.length}`,
                ]);
                setText('');
                await load();
                onChanged();
              }}
            >
              apply
            </button>
          </div>
          {diff ? (
            <div className="small dim" style={{ marginTop: 9 }}>
              <b>recalculated</b>
              {diff.map((d, i) => <div key={i}>{d}</div>)}
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
                <button onClick={async () => { await api.retireDirective(d.id); onChanged(); }}>×</button>
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

  return (
    <div className="main">
      <div className="pane">
        <div className="row" style={{ marginBottom: 12 }}>
          <span className="grow dim small">
            What your acts set in motion. Indentation is depth from the original act.
          </span>
          <button className={reveal ? 'primary' : ''} onClick={() => setReveal(!reveal)}>
            {reveal ? 'hide spoilers' : 'reveal hidden'}
          </button>
          <button onClick={async () => { await api.tick(); setCons(await api.consequences()); }}>tick world</button>
        </div>

        <div className="chain">
          {byDepth.length === 0 ? <p className="empty">Nothing in motion yet.</p> : null}
          {byDepth.map((c) => {
            const hidden = c.visibility === 'offscreen-hidden' && !reveal;
            return (
              <div key={c.id} className={`node ${c.maturity} depth-${Math.min(4, c.depth)}`}>
                <div className="row">
                  <span className="grow">
                    <span className={hidden ? 'spoiler hidden' : 'spoiler'}>
                      <span>{c.actorName} {c.action}</span>
                    </span>
                  </span>
                  <span className="dimmer">{c.maturity}</span>
                </div>
                <div className="dimmer" style={{ fontSize: 11 }}>
                  d{c.depth} · {c.visibility} · sig {c.significance.toFixed(2)} · seeded s{c.createdScene}
                  {c.firedScene != null ? ` · fired s${c.firedScene}` : ''}
                  {c.trigger.kind === 'after-scenes' ? ` · after ${c.trigger.scenes} scene(s)` : ''}
                </div>
              </div>
            );
          })}
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
          <div className="small" style={{ marginTop: 9 }}>
            <div><span className="ok">fired</span> — it happened</div>
            <div><span className="warn">ripening</span> — arriving soon</div>
            <div><span className="dim">pending</span> — waiting on a trigger</div>
            <div><span className="dimmer">superseded</span> — a directive moved past it</div>
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
        <p className="small dim">
          Facts are true in the world; knowledge of them is per-character. The gap between the two
          is what produces dramatic irony instead of NPCs reacting to what they cannot know.
        </p>
        <table>
          <thead>
            <tr><th>fact</th><th>scene</th><th>who holds a version of it</th></tr>
          </thead>
          <tbody>
            {facts.map((f) => (
              <tr key={f.id}>
                <td>{f.text}</td>
                <td className="mono dimmer">{f.scene}</td>
                <td className="small">
                  {f.knowers.length === 0 ? <i className="dimmer">nobody</i> : null}
                  {f.knowers.map((k) => (
                    <span key={k.entityId} style={{ marginRight: 9 }}>
                      <span className={k.level === 'knows' ? 'ok' : k.level === 'wrong' ? 'warn' : 'dim'}>
                        {k.name}
                      </span>
                      <span className="dimmer"> {k.level}{k.distortion > 0 ? ` ${k.distortion.toFixed(1)}` : ''}</span>
                    </span>
                  ))}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
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
              <div className="row" key={key} style={{ marginBottom: 7 }}>
                <span className="dim" style={{ width: 110 }}>{key}</span>
                <select value={style[key] as string} onChange={(e) => void saveStyle({ [key]: e.target.value })}>
                  {opts.map((o) => <option key={o} value={o}>{o}</option>)}
                </select>
              </div>
            ))}
            <div className="row" style={{ marginBottom: 7 }}>
              <span className="dim" style={{ width: 110 }}>genre</span>
              <input
                defaultValue={style.genreLens}
                onBlur={(e) => void saveStyle({ genreLens: e.target.value })}
              />
            </div>
            <div className="row" style={{ marginBottom: 7 }}>
              <span className="dim" style={{ width: 110 }}>comparables</span>
              <input
                defaultValue={style.comparables.join(', ')}
                placeholder="naming a work beats any stack of adjectives"
                onBlur={(e) => void saveStyle({ comparables: e.target.value.split(',').map((s) => s.trim()).filter(Boolean) })}
              />
            </div>
            <div className="row">
              <span className="dim" style={{ width: 110 }}>scene target</span>
              <input
                type="number" defaultValue={style.sceneTarget}
                onBlur={(e) => void saveStyle({ sceneTarget: Number(e.target.value) })}
              />
            </div>
          </div>
        ) : null}

        <ProvidersPanel />

        {anchors.length ? (
          <div className="card">
            <h3>style anchors</h3>
            <p className="small dimmer">
              Re-injected periodically. These do more to prevent drift than the lint pass does.
            </p>
            {anchors.map((a) => (
              <div key={a.id} className="small dim" style={{ fontStyle: 'italic', marginBottom: 6 }}>“{a.text}”</div>
            ))}
          </div>
        ) : null}
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
                  <span>{key}</span>
                  <span className="mono">{knobs[key]}</span>
                </label>
                <input
                  type="range" min={min} max={max} step={step} value={knobs[key] as number}
                  onChange={(e) => void saveKnobs({ [key]: Number(e.target.value) })}
                />
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

  const badge = (status: string) =>
    status === 'ready' ? <span className="ok">ready</span> : status === 'unknown' ? <span className="dimmer">?</span> : <span className="warn">--</span>;

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
            <div key={r.key} style={{ marginBottom: 7 }}>
              <div className="row small">
                <span style={{ width: 46 }}>{badge(r.status)}</span>
                <span className="grow mono">{r.key}</span>
                <span className="dimmer">{r.auth}</span>
              </div>
              {r.detail ? <div className="small dimmer" style={{ paddingLeft: 46 }}>{r.detail}</div> : null}
              {r.fix ? <div className="small warn" style={{ paddingLeft: 46 }}>→ {r.fix}</div> : null}
            </div>
          ))}
          <p className="small dimmer">
            Switching profile is a config change (fabulist.config.json), so the engine reloads it on restart.
          </p>
        </>
      ) : null}
    </div>
  );
}
