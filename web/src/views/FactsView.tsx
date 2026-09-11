import { useCallback, useEffect, useState } from 'react';
import { api, type Entity, type Fact, type Sheet } from '../api.ts';

export function FactsView() {
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
            Facts are true in the world; knowledge of them is per-character. The gap between the two is what produces
            dramatic irony instead of NPCs reacting to what they cannot know.
          </p>
          {facts.map((fact) => {
            const target = grantTarget[fact.id] ?? '';
            const level = grantLevel[fact.id] ?? 'knows';
            const knownIds = new Set(fact.knowers.map((knower) => knower.entityId));
            const candidates = cast.filter(({ sheet }) => !knownIds.has(sheet.entityId));
            return (
              <div key={fact.id} className="card">
                <div className="row baseline">
                  <p className="name sm" style={{ maxWidth: '38rem' }}>
                    {fact.text}
                  </p>
                  <span className="grow" />
                  <span className="mono dimmer">s{fact.scene}</span>
                </div>
                <h3 className="eyebrow rule" style={{ margin: 'var(--s4) 0 var(--s2)' }}>
                  who holds a version of it
                </h3>
                {fact.knowers.length === 0 ? (
                  <p className="empty" style={{ padding: 0 }}>
                    Nobody. This is still only true.
                  </p>
                ) : (
                  <div className="knowers">
                    {fact.knowers.map((knower) => (
                      <div key={knower.entityId} className="knower">
                        <span className="knower-name">{knower.name}</span>
                        <span
                          className={`status ${
                            knower.level === 'knows' ? 'fired' : knower.level === 'wrong' ? 'ripening' : 'pending'
                          }`}
                        >
                          {knower.level}
                        </span>
                        <span className="mono dimmer">{knower.distortion > 0 ? knower.distortion.toFixed(1) : ''}</span>
                        <button
                          aria-label={`revoke ${fact.text} from ${knower.name}`}
                          title="revoke — back to never told"
                          onClick={async () => {
                            await api.revokeKnowledge(fact.id, knower.entityId);
                            await load();
                          }}
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
                      onChange={(event) =>
                        setGrantTarget((previous) => ({ ...previous, [fact.id]: event.target.value }))
                      }
                    >
                      <option value="">grant to…</option>
                      {candidates.map(({ sheet, entity }) => (
                        <option key={sheet.entityId} value={sheet.entityId}>
                          {entity?.name ?? sheet.entityId}
                        </option>
                      ))}
                    </select>
                    <select
                      value={level}
                      onChange={(event) =>
                        setGrantLevel((previous) => ({ ...previous, [fact.id]: event.target.value }))
                      }
                    >
                      <option value="knows">knows</option>
                      <option value="suspects">suspects</option>
                      <option value="wrong">wrong</option>
                    </select>
                    <button
                      disabled={!target}
                      onClick={async () => {
                        await api.grantKnowledge(fact.id, target, level);
                        setGrantTarget((previous) => ({ ...previous, [fact.id]: '' }));
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
