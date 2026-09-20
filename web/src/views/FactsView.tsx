import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, getSelectedStoryId } from '../api.ts';
import { queryKeys } from '../query-keys.ts';

export function FactsView() {
  const [grantTarget, setGrantTarget] = useState<Record<string, string>>({});
  const [grantLevel, setGrantLevel] = useState<Record<string, string>>({});
  const storyId = getSelectedStoryId();
  const queryClient = useQueryClient();

  const factsQuery = useQuery({
    queryKey: queryKeys.facts(storyId),
    queryFn: () => api.facts(),
  });
  const castQuery = useQuery({
    queryKey: queryKeys.cast(storyId),
    queryFn: () => api.cast(),
  });
  const facts = factsQuery.data ?? [];
  const cast = castQuery.data ?? [];

  const grant = useMutation({
    mutationFn: (args: { factId: string; target: string; level: string }) =>
      api.grantKnowledge(args.factId, args.target, args.level),
    onSuccess: async (_data, args) => {
      setGrantTarget((previous) => ({ ...previous, [args.factId]: '' }));
      await queryClient.invalidateQueries({ queryKey: queryKeys.facts(storyId) });
    },
  });

  const revoke = useMutation({
    mutationFn: (args: { factId: string; entityId: string }) => api.revokeKnowledge(args.factId, args.entityId),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: queryKeys.facts(storyId) });
    },
  });

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
                          onClick={() =>
                            void revoke.mutateAsync({ factId: fact.id, entityId: knower.entityId }).catch(() => {})
                          }
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
                      disabled={!target || grant.isPending}
                      onClick={() =>
                        void grant.mutateAsync({ factId: fact.id, target, level }).catch(() => {})
                      }
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
