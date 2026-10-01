import { useEffect, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { providerSecretSchema } from '../../../src/server/contracts.ts';
import { api, type CurrentUser, type ProviderModelRole } from '../api.ts';
import { providerKeyHandoff, wrapProviderKey } from '../crypto/keys.ts';
import { useUnlockedMasterKey } from '../crypto/session.ts';
import { effectiveTrust, keyHintFor, providerStatusLine, TRUST_COPY, unlockHandoffNote } from '../my-provider.ts';
import {
  encryptionKeys,
  useDeleteProviderKeyMutation,
  useEncryptionKeysQuery,
  useMyUsageQuery,
  useProviderKeyQuery,
  useProviderModelAssignmentsQuery,
  useProviderModelsMutation,
  useProviderModelsSavedMutation,
  useSaveProviderKeyMutation,
  useSaveProviderModelAssignmentsMutation,
  useTestProviderKeyMutation,
  useUnlockMutation,
  useUsageByUserQuery,
} from '../queries.ts';

const UNLOCK_FIRST = 'Unlock private storage with your passcode to save or unlock passcode-protected keys.';

const ROLE_OPTIONS: Array<{ role: ProviderModelRole; label: string }> = [
  { role: 'narrate', label: 'Narration' },
  { role: 'classify', label: 'Classify' },
  { role: 'integrity', label: 'Integrity' },
  { role: 'referee', label: 'Referee' },
  { role: 'jev-fastpath', label: 'Jev fast check' },
  { role: 'director', label: 'Director' },
  { role: 'humanize', label: 'Humanize' },
  { role: 'summarize', label: 'Summarize' },
  { role: 'setup', label: 'Setup' },
  { role: 'extract', label: 'Extract' },
  { role: 'passb', label: 'Pass B' },
  { role: 'image', label: 'Images' },
];

/** Saved credentials that can make images; mirrors `IMAGE_CAPABLE_ENDPOINTS` on the server. */
const IMAGE_ENDPOINTS = new Set(['openai']);
const isImageModel = (model: string) => /image|dall-e/i.test(model);

interface ModelDraft {
  providerKeyId: string;
  model: string;
}
type ModelDrafts = Record<ProviderModelRole, ModelDraft>;

function emptyModelDrafts(): ModelDrafts {
  return Object.fromEntries(ROLE_OPTIONS.map(({ role }) => [role, { providerKeyId: '', model: '' }])) as ModelDrafts;
}

export function MyProviderPanel({ user }: { user: CurrentUser }) {
  const queryClient = useQueryClient();
  const { data: state, error: loadError } = useProviderKeyQuery(true);
  const { data: keyBundle } = useEncryptionKeysQuery(true);
  const { data: savedAssignments } = useProviderModelAssignmentsQuery(true);
  const save = useSaveProviderKeyMutation();
  const remove = useDeleteProviderKeyMutation();
  const probe = useTestProviderKeyMutation();
  const listTypedModels = useProviderModelsMutation();
  const listSavedModels = useProviderModelsSavedMutation();
  const saveAssignments = useSaveProviderModelAssignmentsMutation();
  const unlock = useUnlockMutation();
  const masterKey = useUnlockedMasterKey(user.id);

  const [endpointId, setEndpointId] = useState('');
  const [label, setLabel] = useState('');
  const [apiKey, setApiKey] = useState('');
  const [trust, setTrust] = useState<'unlock' | 'sealed'>('unlock');
  const [providerNote, setProviderNote] = useState<string | null>(null);
  const [providerBusy, setProviderBusy] = useState(false);
  const [typedModels, setTypedModels] = useState<string[]>([]);
  const [modelDrafts, setModelDrafts] = useState<ModelDrafts>(emptyModelDrafts);
  const [catalogs, setCatalogs] = useState<Record<string, string[]>>({});
  const [modelNote, setModelNote] = useState<string | null>(null);
  const [modelBusy, setModelBusy] = useState(false);

  useEffect(() => {
    if (!savedAssignments) return;
    const next = emptyModelDrafts();
    for (const assignment of savedAssignments.assignments) {
      next[assignment.role] = { providerKeyId: assignment.providerKeyId, model: assignment.model };
    }
    setModelDrafts(next);
  }, [savedAssignments]);

  const endpoint = endpointId || state?.endpoints[0]?.id || '';
  const enrolled = keyBundle?.enrolled === true;
  const mode = state && keyBundle ? effectiveTrust(trust, enrolled, state.sealedAvailable) : trust;
  const typedKeyValid = providerSecretSchema.safeParse(apiKey.trim()).success;

  const checkedKey = () => {
    const key = apiKey.trim();
    if (!providerSecretSchema.safeParse(key).success) {
      throw new Error('API key must be 8-512 printable characters with no spaces');
    }
    return key;
  };

  const runProvider = async (fn: () => Promise<void>) => {
    setProviderBusy(true);
    setProviderNote(null);
    try {
      await fn();
    } catch (error) {
      setProviderNote(error instanceof Error ? error.message : String(error));
    } finally {
      setProviderBusy(false);
    }
  };

  const loadTypedModels = () =>
    runProvider(async () => {
      const models = (await listTypedModels.mutateAsync({ endpointId: endpoint, key: checkedKey() })).models;
      setTypedModels(models);
      setProviderNote(
        models.length
          ? models.length + ' models found for this provider key'
          : 'No model catalog is available; you can enter model IDs after saving this provider.',
      );
    });

  const testTypedKey = () =>
    runProvider(async () => {
      const result = await probe.mutateAsync({ endpointId: endpoint, key: checkedKey() });
      setProviderNote(result.message);
    });

  const saveProvider = () =>
    runProvider(async () => {
      const key = checkedKey();
      const id = crypto.randomUUID();
      const providerLabel = label.trim();
      let note = 'Provider saved.';
      if (mode === 'sealed') {
        await save.mutateAsync({ id, label: providerLabel, endpointId: endpoint, trust: 'sealed', key });
      } else {
        if (!masterKey) throw new Error(UNLOCK_FIRST);
        const wrap = await wrapProviderKey(user.id, masterKey, id, key);
        await save.mutateAsync({
          id,
          label: providerLabel,
          endpointId: endpoint,
          trust: 'unlock',
          wrap,
          keyHint: keyHintFor(key),
        });
        note = await unlockHandoffNote(() =>
          unlock.mutateAsync({ storyKeys: [], providerKeys: [{ keyId: id, key }] }),
        );
      }
      setApiKey('');
      setLabel('');
      setTypedModels([]);
      setProviderNote(note);
    });

  const deleteProvider = (id: string) =>
    runProvider(async () => {
      await remove.mutateAsync(id);
      setProviderNote('Provider removed. Any model assignments that used it were cleared.');
    });

  const unlockProvider = (id: string) =>
    runProvider(async () => {
      if (!masterKey) throw new Error(UNLOCK_FIRST);
      const bundle = await queryClient.fetchQuery({ queryKey: encryptionKeys.keys, queryFn: api.encryption.keys });
      const record = bundle.providerKeys?.find((item) => item.keyId === id);
      if (!record) throw new Error('The saved encrypted credential is no longer available.');
      const providerKeys = await providerKeyHandoff(user.id, masterKey, [record]);
      if (!providerKeys.length) throw new Error('Could not unlock this provider credential.');
      await unlockHandoffNote(() => unlock.mutateAsync({ storyKeys: [], providerKeys }));
      setProviderNote('Provider credential unlocked.');
    });

  const canSave =
    !providerBusy &&
    typedKeyValid &&
    (mode === 'sealed' ? !!state?.sealedAvailable : enrolled && masterKey !== null);

  if (!state) {
    return (
      <div className="card">
        <h3>configure providers</h3>
        <p className="empty">{loadError ? loadError.message : 'loading…'}</p>
      </div>
    );
  }

  const providerName = (key: (typeof state.keys)[number]['key']) => {
    const provider = state.endpoints.find((item) => item.id === key.endpointId)?.label ?? key.endpointId;
    return (key.label ? key.label + ' · ' : '') + provider + ' ••••' + key.keyHint;
  };
  const assignmentCanSave = !modelBusy && state.keys.length > 0;

  const saveModelAssignments = () =>
    (async () => {
      setModelBusy(true);
      setModelNote(null);
      try {
        const incomplete = ROLE_OPTIONS.filter(({ role }) => {
          const draft = modelDrafts[role];
          return draft.providerKeyId && !draft.model.trim();
        });
        if (incomplete.length)
          throw new Error('Enter a model ID for: ' + incomplete.map(({ label }) => label).join(', '));
        const assignments = ROLE_OPTIONS.flatMap(({ role }) => {
          const draft = modelDrafts[role];
          return draft.providerKeyId && draft.model.trim()
            ? [{ role, providerKeyId: draft.providerKeyId, model: draft.model.trim() }]
            : [];
        });
        await saveAssignments.mutateAsync(assignments);
        setModelNote('Model assignments saved.');
      } catch (error) {
        setModelNote(error instanceof Error ? error.message : String(error));
      } finally {
        setModelBusy(false);
      }
    })();

  const loadSavedModels = async (role: ProviderModelRole) => {
    const keyId = modelDrafts[role].providerKeyId;
    if (!keyId) {
      setModelNote('Choose a saved provider for this role first.');
      return;
    }
    setModelBusy(true);
    setModelNote(null);
    try {
      const result = await listSavedModels.mutateAsync(keyId);
      setCatalogs((previous) => ({ ...previous, [keyId]: result.models }));
      setModelNote(
        result.models.length
          ? result.models.length +
              ' models loaded for ' +
              (state.keys.find((item) => item.key.id === keyId)?.key.label || 'this provider') +
              '.'
          : 'This provider did not return a model catalog. Enter a model ID manually.',
      );
    } catch (error) {
      setModelNote(error instanceof Error ? error.message : String(error));
    } finally {
      setModelBusy(false);
    }
  };

  return (
    <>
      <section className="card">
        <h3>configure providers</h3>
        <p className="small">Add and test credentials here. Saving is separate from testing and model selection.</p>
        <p className="small">{providerStatusLine(state.status)}</p>

        {state.keys.length ? (
          <div className="stack">
            {state.keys.map(({ key, status }) => (
              <div className="card subtle" key={key.id}>
                <div className="row">
                  <span className="grow">
                    <strong>{providerName(key)}</strong>
                  </span>
                  <span className="tag">{status === 'ready' ? 'available' : status}</span>
                  <span className="tag">{key.trust}</span>
                </div>
                <p className="small dim">
                  Added {new Date(key.createdAt).toLocaleDateString()}
                  {key.lastUsedAt ? ' · last used ' + new Date(key.lastUsedAt).toLocaleDateString() : ''}
                </p>
                <div className="row">
                  {key.trust === 'unlock' && status === 'locked' ? (
                    <button
                      type="button"
                      disabled={providerBusy || !masterKey}
                      onClick={() => void unlockProvider(key.id)}
                    >
                      unlock
                    </button>
                  ) : null}
                  <button type="button" disabled={providerBusy} onClick={() => void deleteProvider(key.id)}>
                    remove
                  </button>
                </div>
              </div>
            ))}
          </div>
        ) : (
          <p className="empty">No saved provider credentials yet.</p>
        )}

        <h4>add provider</h4>
        <label className="field-row">
          <span>provider</span>
          <select
            value={endpoint}
            disabled={providerBusy}
            onChange={(event) => {
              setEndpointId(event.target.value);
              setTypedModels([]);
              setProviderNote(null);
            }}
          >
            {state.endpoints.map((item) => (
              <option key={item.id} value={item.id}>
                {item.label}
              </option>
            ))}
          </select>
        </label>
        <label className="field-row">
          <span>label (optional)</span>
          <input value={label} disabled={providerBusy} onChange={(event) => setLabel(event.target.value)} />
        </label>
        <label className="field-row">
          <span>API key</span>
          <input
            type="password"
            autoComplete="off"
            value={apiKey}
            disabled={providerBusy}
            onChange={(event) => {
              setApiKey(event.target.value);
              setTypedModels([]);
              setProviderNote(null);
            }}
          />
        </label>
        <div className="row">
          <button type="button" disabled={providerBusy || !typedKeyValid} onClick={() => void loadTypedModels()}>
            load models
          </button>
          <button type="button" disabled={providerBusy || !typedKeyValid} onClick={() => void testTypedKey()}>
            test key
          </button>
        </div>
        {typedModels.length ? (
          <p className="small dim">{typedModels.length} model IDs are available after this credential is saved.</p>
        ) : null}

        <fieldset className="field-row block">
          <legend>how this key is protected</legend>
          <label className="private-recovery-check">
            <input
              type="radio"
              name="provider-trust"
              checked={mode === 'unlock'}
              disabled={providerBusy || !enrolled}
              onChange={() => setTrust('unlock')}
            />
            <span>with my passcode — {TRUST_COPY.unlock}</span>
          </label>
          <label className="private-recovery-check">
            <input
              type="radio"
              name="provider-trust"
              checked={mode === 'sealed'}
              disabled={providerBusy || !state.sealedAvailable}
              onChange={() => setTrust('sealed')}
            />
            <span>by the server — {state.sealedAvailable ? TRUST_COPY.sealed : 'Not available on this server.'}</span>
          </label>
        </fieldset>
        {mode === null ? (
          <p className="small dim">Set up private storage or enable server-sealed keys before saving a credential.</p>
        ) : null}
        {mode === 'unlock' && !masterKey ? (
          <p className="small dim">{UNLOCK_FIRST}</p>
        ) : null}
        <button type="button" disabled={!canSave} onClick={() => void saveProvider()}>
          save provider
        </button>
        {providerNote ? (
          <p className="small dim" role="status">
            {providerNote}
          </p>
        ) : null}
      </section>

      <section className="card">
        <h3>configure models</h3>
        <p className="small">
          Choose a saved provider and model for each role. Load a catalog or type a model ID. Roles without an
          assignment use Narration when configured; otherwise they keep the server's existing fallback.
        </p>
        {!state.keys.length ? <p className="empty">Save a provider credential before assigning models.</p> : null}
        {ROLE_OPTIONS.map(({ role, label: roleLabel }) => {
          const draft = modelDrafts[role];
          const listId = `${role === 'image' ? 'provider-image-models-' : 'provider-models-'}${draft.providerKeyId}`;
          const choices =
            role === 'image' ? state.keys.filter(({ key }) => IMAGE_ENDPOINTS.has(key.endpointId)) : state.keys;
          return (
            <div className="provider-model-role" key={role}>
              <h4>{roleLabel}</h4>
              {role === 'jev-fastpath' ? (
                <p className="small dim">
                  Optional OpenRouter check. Use <span className="mono">typesafe/jev-1.13</span>; unclear or unsafe results use your full Integrity and Referee routes.
                </p>
              ) : null}
              {role === 'image' ? (
                <p className="small dim">
                  Portraits and scene illustrations. Uses an OpenAI credential and does not fall back to Narration;
                  without an assignment, images keep the server's image setting.
                </p>
              ) : null}
              <label className="field-row">
                <span>provider</span>
                <select
                  value={draft.providerKeyId}
                  disabled={!state.keys.length || modelBusy}
                  onChange={(event) =>
                    setModelDrafts((previous) => ({
                      ...previous,
                      [role]: {
                        providerKeyId: event.target.value,
                        model: event.target.value === draft.providerKeyId ? draft.model : '',
                      },
                    }))
                  }
                >
                  <option value="">{role === 'image' ? 'use server image setting' : 'use fallback'}</option>
                  {choices.map(({ key }) => (
                    <option key={key.id} value={key.id}>
                      {providerName(key)}
                    </option>
                  ))}
                </select>
              </label>
              <label className="field-row">
                <span>model ID</span>
                <input
                  list={draft.providerKeyId ? listId : undefined}
                  value={draft.model}
                  placeholder={
                    role === 'jev-fastpath' ? 'typesafe/jev-1.13' : role === 'image' ? 'gpt-image-1' : undefined
                  }
                  disabled={!draft.providerKeyId || modelBusy}
                  onChange={(event) =>
                    setModelDrafts((previous) => ({ ...previous, [role]: { ...draft, model: event.target.value } }))
                  }
                />
              </label>
              <button
                type="button"
                disabled={!draft.providerKeyId || modelBusy}
                onClick={() => void loadSavedModels(role)}
              >
                load models
              </button>
            </div>
          );
        })}
        {state.keys.map(({ key }) => (
          <datalist id={'provider-models-' + key.id} key={key.id}>
            {(catalogs[key.id] ?? []).map((model) => (
              <option key={model} value={model} />
            ))}
          </datalist>
        ))}
        {state.keys
          .filter(({ key }) => IMAGE_ENDPOINTS.has(key.endpointId))
          .map(({ key }) => (
            <datalist id={`provider-image-models-${key.id}`} key={`image-${key.id}`}>
              {(catalogs[key.id] ?? []).filter(isImageModel).map((model) => (
                <option key={model} value={model} />
              ))}
            </datalist>
          ))}
        <button type="button" disabled={!assignmentCanSave} onClick={() => void saveModelAssignments()}>
          save model assignments
        </button>
        {modelNote ? (
          <p className="small dim" role="status">
            {modelNote}
          </p>
        ) : null}
      </section>
    </>
  );
}

export function MyUsagePanel() {
  const { data } = useMyUsageQuery(30, true);
  if (!data?.rows.length) {
    return (
      <div className="card">
        <h3>your usage</h3>
        <p className="empty">No provider calls in the last 30 days.</p>
      </div>
    );
  }
  const daily = Array.from(
    data.rows.reduce((days, row) => {
      const day = days.get(row.day) ?? { day: row.day, calls: 0, tokensIn: 0, tokensOut: 0 };
      day.calls += row.calls;
      day.tokensIn += row.tokensIn;
      day.tokensOut += row.tokensOut;
      days.set(row.day, day);
      return days;
    }, new Map<string, { day: string; calls: number; tokensIn: number; tokensOut: number }>()),
    ([, value]) => value,
  ).sort((a, b) => a.day.localeCompare(b.day));
  const maxTokens = Math.max(...daily.map((day) => day.tokensIn + day.tokensOut), 1);
  const chart = { width: 760, height: 220, left: 52, right: 12, top: 14, bottom: 48 };
  const plotWidth = chart.width - chart.left - chart.right;
  const plotHeight = chart.height - chart.top - chart.bottom;
  const slotWidth = plotWidth / daily.length;
  const barWidth = Math.min(22, slotWidth * 0.62);
  const compact = (value: number) =>
    new Intl.NumberFormat(undefined, { notation: 'compact', maximumFractionDigits: 1 }).format(value);

  return (
    <div className="card">
      <h3>your usage · last {data.days} days</h3>
      <div className="small dim">Daily tokens · {daily.reduce((sum, day) => sum + day.calls, 0).toLocaleString()} calls</div>
      <div style={{ overflowX: 'auto', marginTop: 'var(--s3)' }}>
        <svg
          viewBox={`0 0 ${chart.width} ${chart.height}`}
          role="img"
          aria-label={`Daily token usage over ${daily.length} active days. Input and output tokens are shown separately.`}
          style={{ display: 'block', width: '100%', minWidth: 420, height: 'auto' }}
        >
          {[0, 0.5, 1].map((fraction) => {
            const y = chart.top + plotHeight * (1 - fraction);
            return (
              <g key={fraction}>
                <line x1={chart.left} x2={chart.width - chart.right} y1={y} y2={y} stroke="var(--rule)" />
                <text x={chart.left - 8} y={y + 4} textAnchor="end" fill="var(--ink-3)" fontSize="11">
                  {compact(maxTokens * fraction)}
                </text>
              </g>
            );
          })}
          {daily.map((day, index) => {
            const x = chart.left + slotWidth * index + (slotWidth - barWidth) / 2;
            const inputHeight = (day.tokensIn / maxTokens) * plotHeight;
            const outputHeight = (day.tokensOut / maxTokens) * plotHeight;
            const baseY = chart.top + plotHeight;
            const label = new Date(`${day.day}T00:00:00Z`).toLocaleDateString(undefined, {
              month: 'short',
              day: 'numeric',
              timeZone: 'UTC',
            });
            return (
              <g key={day.day}>
                <title>{`${day.day}: ${day.tokensIn.toLocaleString()} input tokens, ${day.tokensOut.toLocaleString()} output tokens, ${day.calls} calls`}</title>
                <rect x={x} y={baseY - inputHeight} width={barWidth} height={inputHeight} fill="var(--accent)" rx="2" />
                <rect x={x} y={baseY - inputHeight - outputHeight} width={barWidth} height={outputHeight} fill="var(--ink-3)" rx="2" />
                {(daily.length <= 10 || index % Math.ceil(daily.length / 6) === 0 || index === daily.length - 1) && (
                  <text x={x + barWidth / 2} y={baseY + 20} textAnchor="middle" fill="var(--ink-3)" fontSize="11">
                    {label}
                  </text>
                )}
              </g>
            );
          })}
        </svg>
      </div>
      <div className="row small" aria-hidden="true">
        <span className="dim"><span style={{ color: 'var(--accent)' }}>■</span> input</span>
        <span className="dim"><span style={{ color: 'var(--ink-3)' }}>■</span> output</span>
      </div>
      <details>
        <summary className="small">usage by model</summary>
        {data.rows.map((r) => (
          <div key={`${r.day}|${r.model}|${r.keySource}`} className="row small">
            <span className="grow dim">{r.day} · {r.model}</span>
            <span className="tag">{r.keySource === 'own' ? 'your key' : 'server'}</span>
            <span className="mono dimmer">
              {r.calls}× {r.tokensIn.toLocaleString()}→{r.tokensOut.toLocaleString()}
            </span>
          </div>
        ))}
      </details>
    </div>
  );
}

export function AdminUsagePanel() {
  const { data } = useUsageByUserQuery(30, true);
  return (
    <div className="card">
      <h3>usage by user · last 30 days</h3>
      {data?.rows.length ? (
        data.rows.map((r) => (
          <div key={`${r.userId}|${r.keySource}`} className="row small">
            <span className="grow mono dim">{r.userId}</span>
            <span className="tag">{r.keySource === 'own' ? 'own key' : 'server'}</span>
            <span className="mono dimmer">
              {r.calls}× {r.tokensIn.toLocaleString()}→{r.tokensOut.toLocaleString()}
            </span>
          </div>
        ))
      ) : (
        <p className="empty">No metered calls yet.</p>
      )}
    </div>
  );
}
