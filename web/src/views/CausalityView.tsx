import { Fragment, useEffect, useState } from 'react';
import { api, type Consequence } from '../api.ts';

export function CausalityView() {
  const [consequences, setConsequences] = useState<Consequence[]>([]);
  const [reveal, setReveal] = useState(false);

  useEffect(() => {
    void api.consequences().then(setConsequences);
  }, []);

  const byDepth = [...consequences].sort((a, b) => a.depth - b.depth || a.createdScene - b.createdScene);
  const collapsed: Array<Consequence & { count: number }> = [];
  const seen = new Map<string, Consequence & { count: number }>();
  for (const consequence of byDepth) {
    const key = [
      consequence.createdScene,
      consequence.depth,
      consequence.actorName,
      consequence.action,
      consequence.maturity,
      consequence.visibility,
      consequence.significance.toFixed(2),
      consequence.firedScene ?? '',
      JSON.stringify(consequence.trigger),
    ].join('|');
    const existing = seen.get(key);
    if (existing) {
      existing.count += 1;
    } else {
      const row = { ...consequence, count: 1 };
      seen.set(key, row);
      collapsed.push(row);
    }
  }

  const scenes = [...new Set(collapsed.map((consequence) => consequence.createdScene))].sort((a, b) => a - b);

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
            <button
              onClick={async () => {
                await api.tick();
                setConsequences(await api.consequences());
              }}
            >
              tick world
            </button>
          </div>

          <div className="chain">
            {byDepth.length === 0 ? <p className="empty">Nothing in motion yet.</p> : null}
            {scenes.map((scene) => {
              const rows = collapsed.filter((consequence) => consequence.createdScene === scene);
              const total = rows.reduce((count, row) => count + row.count, 0);
              return (
                <Fragment key={scene}>
                  <div className="scene-head">
                    <span>scene {scene}</span>
                    <span className="dimmer" style={{ letterSpacing: 0 }}>
                      {total} seeded
                    </span>
                  </div>
                  {rows.map((consequence) => {
                    const hidden = consequence.visibility === 'offscreen-hidden' && !reveal;
                    return (
                      <div
                        key={consequence.id}
                        className={`node ${consequence.maturity} depth-${Math.min(4, consequence.depth)}`}
                      >
                        <span className={`status ${consequence.maturity}`}>{consequence.maturity}</span>
                        <span className="act">
                          <span className={hidden ? 'spoiler hidden' : 'spoiler'}>
                            <span>
                              {consequence.actorName} {consequence.action}
                            </span>
                          </span>
                          {consequence.count > 1 ? <span className="mult">×{consequence.count}</span> : null}
                        </span>
                        <span className="node-meta">
                          depth {consequence.depth} · {consequence.visibility.replace('-', ' ')} · significance{' '}
                          {consequence.significance.toFixed(2)}
                          {consequence.firedScene != null ? ` · fired in s${consequence.firedScene}` : ''}
                          {consequence.trigger.kind === 'after-scenes'
                            ? ` · after ${consequence.trigger.scenes} scene(s)`
                            : ''}
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
            Most consequences should be discoverable rather than hidden. A world of pure hidden machinery is
            indistinguishable from no machinery at all, so the engine steers traces toward you once too much has matured
            unseen.
          </p>
          <div className="legend-list" style={{ marginTop: 'var(--s4)' }}>
            <div>
              <span className="status fired">fired</span> <span className="dim">it happened</span>
            </div>
            <div>
              <span className="status ripening">ripening</span> <span className="dim">arriving soon</span>
            </div>
            <div>
              <span className="status pending">pending</span> <span className="dim">waiting on a trigger</span>
            </div>
            <div>
              <span className="status superseded">superseded</span>{' '}
              <span className="dim">a directive moved past it</span>
            </div>
          </div>
        </div>
      </aside>
    </div>
  );
}
