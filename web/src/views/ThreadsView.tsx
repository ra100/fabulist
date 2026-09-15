import { Fragment, useCallback, useEffect, useRef, useState } from 'react';
import { api, type State, type Thread } from '../api.ts';

function ThreadCard({ thread, onChanged }: { thread: Thread; onChanged: () => void }) {
  const [editing, setEditing] = useState(false);
  const [title, setTitle] = useState(thread.title);
  const [tension, setTension] = useState(thread.tension);
  // Drag ticks that land while a save is in flight; only the latest is kept.
  const pendingTension = useRef<number | null>(null);

  function flushPending() {
    const next = pendingTension.current;
    if (next === null) return;
    pendingTension.current = null;
    void run(save({ tension: next }));
  }

  const { busy, error, run, inFlight } = useAction(flushPending);

  function save(patch: Partial<Thread>) {
    return async () => {
      await api.updateThread(thread.id, patch);
      onChanged();
    };
  }

  function changeTension(value: number) {
    setTension(value);
    if (inFlight.current) {
      pendingTension.current = value;
      return;
    }
    void run(save({ tension: value }));
  }

  return (
    <div className="card">
      <div className="row baseline">
        {editing ? (
          <input
            className="name sm grow"
            value={title}
            autoFocus
            onChange={(event) => setTitle(event.target.value)}
            onBlur={() => {
              setEditing(false);
              const next = title.trim();
              if (next && next !== thread.title) {
                void run(save({ title: next }));
              }
            }}
            onKeyDown={(event) => {
              if (event.key === 'Enter') (event.target as HTMLInputElement).blur();
            }}
          />
        ) : (
          <button
            className="name sm grow as-h2"
            title="click to retitle"
            disabled={busy}
            onClick={() => setEditing(true)}
            style={{ cursor: 'text', textAlign: 'left' }}
          >
            {thread.title}
          </button>
        )}
        <span className="tag">{thread.status}</span>
        {thread.status === 'open' ? (
          <>
            <button title="mark resolved" disabled={busy} onClick={() => void run(save({ status: 'resolved' }))}>
              resolve
            </button>
            <button title="mark abandoned" disabled={busy} onClick={() => void run(save({ status: 'abandoned' }))}>
              abandon
            </button>
          </>
        ) : (
          <button title="reopen this thread" disabled={busy} onClick={() => void run(save({ status: 'open' }))}>
            reopen
          </button>
        )}
      </div>
      {error ? (
        <div className="small warn" style={{ margin: '0 0 var(--s3)' }}>
          {error}
        </div>
      ) : null}
      <div className="small dim" style={{ margin: '5px 0 var(--s4)', maxWidth: '44rem' }}>
        {thread.stakes}
      </div>
      <div className="row" style={{ maxWidth: '30rem' }}>
        <span className="eyebrow" style={{ margin: 0, minWidth: '4.5rem' }}>
          tension
        </span>
        <div className="scale">
          <input
            type="range"
            min="0"
            max="1"
            step="0.05"
            value={tension}
            aria-label={`tension for ${thread.title}`}
            onChange={(event) => changeTension(Number(event.target.value))}
          />
        </div>
        <span className="mono" style={{ width: 34, textAlign: 'right' }}>
          {tension.toFixed(2)}
        </span>
      </div>
      {thread.resolutions.length ? (
        <div className="small dimmer" style={{ marginTop: 'var(--s3)' }}>
          <span className="status" style={{ marginRight: 'var(--s2)' }}>
            ways out
          </span>
          {thread.resolutions.join(' · ')}
        </div>
      ) : null}
    </div>
  );
}

// Shared shape for mutations: a single-flight guard (ref, since state reads
// inside async continuations would be stale), a busy flag to disable the
// control while in flight, an error line for surfaced failures, and an
// optional settled hook that runs once the guard is released.
function useAction(onSettled?: () => void) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inFlight = useRef(false);

  async function run(action: () => Promise<void>) {
    if (inFlight.current) return;
    inFlight.current = true;
    setBusy(true);
    setError(null);
    try {
      await action();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
    inFlight.current = false;
    setBusy(false);
    onSettled?.();
  }

  return { busy, error, run, inFlight };
}

export function ThreadsView({ state, onChanged }: { state: State | null; onChanged: () => void }) {
  const [threads, setThreads] = useState<Thread[]>([]);
  const [text, setText] = useState('');
  const [strength, setStrength] = useState('push');
  const [diff, setDiff] = useState<Array<[string, string]> | null>(null);
  const [newTitle, setNewTitle] = useState('');
  const [newStakes, setNewStakes] = useState('');
  const create = useAction();
  const direct = useAction();
  const retire = useAction();

  const load = useCallback(async () => setThreads(await api.threads()), []);
  useEffect(() => {
    void load();
  }, [load]);

  function openThread() {
    return create.run(async () => {
      await api.createThread(newTitle.trim(), newStakes.trim());
      setNewTitle('');
      setNewStakes('');
      await load();
      onChanged();
    });
  }

  function applyDirective() {
    return direct.run(async () => {
      const response = await api.addDirective(text, strength);
      const entries: Array<[string, string]> = [];
      if (response.diff.raisedThreadTitles.length) {
        entries.push(['raised', response.diff.raisedThreadTitles.join('; ')]);
      }
      if (response.diff.loweredThreads.length) {
        entries.push(['lowered', `${response.diff.loweredThreads.length} thread(s)`]);
      }
      if (response.diff.supersededConsequences.length) {
        entries.push(['superseded', `${response.diff.supersededConsequences.length} pending consequence(s)`]);
      }
      if (response.diff.retimedConsequences.length) {
        entries.push(['retimed', `${response.diff.retimedConsequences.length} consequence(s)`]);
      }
      setDiff(entries.length ? entries : [['no change', 'nothing needed moving']]);
      setText('');
      await load();
      onChanged();
    });
  }

  function retireDirective(directiveId: string) {
    return retire.run(async () => {
      await api.retireDirective(directiveId);
      onChanged();
    });
  }

  return (
    <div className="main">
      <div className="pane">
        <div className="measure-tool">
          <p className="lede">
            Tension is the dial the director reads before it chooses what happens next. Raise one and the story leans on
            it.
          </p>
          {threads.map((thread) => (
            <ThreadCard
              key={thread.id}
              thread={thread}
              onChanged={async () => {
                await load();
                onChanged();
              }}
            />
          ))}
          {threads.length === 0 ? <p className="empty">No threads yet — start one on the right.</p> : null}
        </div>
      </div>

      <aside className="side">
        <div className="card">
          <h3>start a thread</h3>
          <p className="small dim" style={{ margin: '0 0 var(--s3)' }}>
            The natural authoring move when the story needs tension the extractor never wrote — a rivalry, a debt, a
            countdown.
          </p>
          <input
            value={newTitle}
            placeholder="title — e.g. 'who told the garrison'"
            onChange={(event) => setNewTitle(event.target.value)}
          />
          <textarea
            rows={2}
            style={{ marginTop: 'var(--s2)' }}
            value={newStakes}
            placeholder="what's at stake if it resolves badly"
            onChange={(event) => setNewStakes(event.target.value)}
          />
          <button
            className="primary"
            style={{ marginTop: 'var(--s2)' }}
            disabled={create.busy || !newTitle.trim()}
            onClick={() => void openThread()}
          >
            {create.busy ? 'opening…' : 'open thread'}
          </button>
          {create.error ? (
            <div className="small warn" style={{ marginTop: 'var(--s2)' }}>
              {create.error}
            </div>
          ) : null}
        </div>

        <div className="card">
          <h3>direct the story</h3>
          <textarea
            rows={3}
            value={text}
            placeholder="turn this toward the captain searching the cells"
            onChange={(event) => setText(event.target.value)}
          />
          <div className="row" style={{ marginTop: 7 }}>
            <select value={strength} onChange={(event) => setStrength(event.target.value)}>
              <option value="hint">hint</option>
              <option value="push">push</option>
              <option value="mandate">mandate</option>
            </select>
            <button className="primary" disabled={direct.busy || !text.trim()} onClick={() => void applyDirective()}>
              {direct.busy ? 'applying…' : 'apply'}
            </button>
          </div>
          {direct.error ? (
            <div className="small warn" style={{ marginTop: 'var(--s2)' }}>
              {direct.error}
            </div>
          ) : null}
          {diff ? (
            <div style={{ marginTop: 'var(--s4)' }}>
              <h3 className="eyebrow rule">recalculated</h3>
              <dl className="kv small">
                {diff.map(([key, value]) => (
                  <Fragment key={key}>
                    <dt>{key}</dt>
                    <dd>{value}</dd>
                  </Fragment>
                ))}
              </dl>
            </div>
          ) : null}
        </div>

        {state?.directives.length ? (
          <div className="card">
            <h3>active directives</h3>
            {state.directives.map((directive) => (
              <div key={directive.id} className="row small" style={{ marginBottom: 5 }}>
                <span className="grow">
                  <span className="tag">{directive.strength}</span> {directive.text}
                </span>
                <button
                  aria-label={`retire directive: ${directive.text}`}
                  title="retire this directive"
                  disabled={retire.busy}
                  onClick={() => void retireDirective(directive.id)}
                >
                  ×
                </button>
              </div>
            ))}
            {retire.error ? (
              <div className="small warn" style={{ marginTop: 'var(--s2)' }}>
                {retire.error}
              </div>
            ) : null}
          </div>
        ) : null}
      </aside>
    </div>
  );
}
