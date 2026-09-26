import { useEffect, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { providerSecretSchema } from '../../../src/server/contracts.ts';
import { api, type CurrentUser } from '../api.ts';
import { eraseUnlockedStoryKeys, unlockWithPassphrase, wrapProviderKey } from '../crypto/keys.ts';
import {
  effectiveTrust,
  keyHintFor,
  providerStatusLine,
  savedKeyInfo,
  TRUST_COPY,
  unlockHandoffNote,
} from '../my-provider.ts';
import {
  encryptionKeys,
  useDeleteProviderKeyMutation,
  useEncryptionKeysQuery,
  useMyUsageQuery,
  useProviderKeyQuery,
  useProviderModelsMutation,
  useProviderModelsSavedQuery,
  useSaveProviderKeyMutation,
  useTestProviderKeyMutation,
  useTestProviderKeySavedMutation,
  useUnlockMutation,
  useUsageByUserQuery,
} from '../queries.ts';

export function MyProviderPanel({ user }: { user: CurrentUser }) {
  const queryClient = useQueryClient();
  const { data: state, error: loadError } = useProviderKeyQuery(true);
  const { data: keyBundle } = useEncryptionKeysQuery(true);
  const save = useSaveProviderKeyMutation();
  const remove = useDeleteProviderKeyMutation();
  const probe = useTestProviderKeyMutation();
  const listModels = useProviderModelsMutation();
  const listModelsSaved = useProviderModelsSavedQuery(state?.key !== null);
  const probeSaved = useTestProviderKeySavedMutation();
  const unlock = useUnlockMutation();
  const [endpointId, setEndpointId] = useState('');
  const [apiKey, setApiKey] = useState('');
  const [narrate, setNarrate] = useState('');
  const [mechanics, setMechanics] = useState('');
  const [extract, setExtract] = useState('');
  const [trust, setTrust] = useState<'unlock' | 'sealed'>('unlock');
  const [passphrase, setPassphrase] = useState('');
  const [models, setModels] = useState<string[]>([]);
  const [note, setNote] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // Authoritative: the saved key's narrate/mechanics/extract settings are what
  // is actually used for your key. Seed the form from them on mount/refresh so
  // the settings show what's in use instead of an empty form.
  useEffect(() => {
    const m = state?.key?.models;
    if (!m) return;
    setNarrate((prev) => (prev.trim() ? prev : m.narrate));
    setMechanics((prev) => (prev.trim() ? prev : m.mechanics ?? ''));
    setExtract((prev) => (prev.trim() ? prev : m.extract ?? ''));
  }, [state?.key?.id]);

  if (!state) {
    return (
      <div className="card">
        <h3>my provider</h3>
        <p className="empty">{loadError ? loadError.message : 'loading…'}</p>
      </div>
    );
  }

  const endpoint = endpointId || state.key?.endpointId || state.endpoints[0]?.id || '';
  const enrolled = keyBundle?.enrolled === true;
  const mode = keyBundle ? effectiveTrust(trust, enrolled, state.sealedAvailable) : trust;
  const modelSet = () => ({
    narrate: narrate.trim(),
    ...(mechanics.trim() ? { mechanics: mechanics.trim() } : {}),
    ...(extract.trim() ? { extract: extract.trim() } : {}),
  });
  // An unlock wrap is opaque to the server, so a malformed key must be caught before it is wrapped.
  const checkedKey = () => {
    const key = apiKey.trim();
    if (!providerSecretSchema.safeParse(key).success) throw new Error('API key must be 8-512 printable characters with no spaces');
    return key;
  };
  const run = async (fn: () => Promise<void>) => {
    setBusy(true);
    setNote(null);
    try {
      await fn();
    } catch (e) {
      setNote(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const onLoadModels = () =>
    run(async () => {
      // Use the saved key when there is one — no need to re-type it. Otherwise
      // fall back to a key typed into this form.
      const found = state.key
        ? await listModelsSaved.refetch().then((r) => r.data?.models ?? [])
        : (await listModels.mutateAsync({ endpointId: endpoint, key: checkedKey() })).models;
      setModels(found);
      setNote(found.length ? `${found.length} models found` : 'this provider did not list models; type a model id');
    });

  const onTest = () =>
    run(async () => {
      const model = narrate.trim();
      if (!model) throw new Error('enter a narrate model id first');
      const result = state.key
        ? await probeSaved.mutateAsync(model)
        : await probe.mutateAsync({ endpointId: endpoint, model, key: checkedKey() });
      setNote(result.ok ? `works — ${result.model} answered` : `failed — ${result.error}`);
    });

  const onSave = () =>
    run(async () => {
      const key = checkedKey();
      const id = crypto.randomUUID();
      const base = { id, label: '', endpointId: endpoint, models: modelSet() };
      let saved = 'saved';
      if (mode === 'sealed') {
        await save.mutateAsync({ ...base, trust: 'sealed', key });
      } else {
        const bundle = await queryClient.fetchQuery({ queryKey: encryptionKeys.keys, queryFn: api.encryption.keys });
        if (!bundle.userKey) throw new Error('set up private storage first, or choose the server-sealed mode');
        const unlocked = await unlockWithPassphrase(user.id, bundle.userKey, [], passphrase);
        try {
          const wrap = await wrapProviderKey(user.id, unlocked.masterKey, id, key);
          await save.mutateAsync({ ...base, trust: 'unlock', wrap, keyHint: keyHintFor(key) });
          saved = await unlockHandoffNote(() => unlock.mutateAsync({ storyKeys: [], providerKeys: [{ keyId: id, key }] }));
        } finally {
          eraseUnlockedStoryKeys(unlocked);
        }
      }
      setApiKey('');
      setPassphrase('');
      setNote(saved);
    });

  const onDelete = () =>
    run(async () => {
      await remove.mutateAsync();
      setNote('deleted');
    });

  const canSave =
    !busy && !!apiKey && !!narrate.trim() && (mode === 'sealed' ? state.sealedAvailable : enrolled && passphrase.length >= 12);

  if (mode === null) {
    return (
      <div className="card">
        <h3>my provider</h3>
        <p className="small">{providerStatusLine(state.status)}</p>
        <p className="empty">Set up private storage to save a key.</p>
        {state.key ? (
          <button type="button" disabled={busy} onClick={() => void onDelete()}>
            delete saved key
          </button>
        ) : null}
        {note ? <p className="small dim" role="status">{note}</p> : null}
      </div>
    );
  }

  return (
    <div className="card">
      <h3>my provider</h3>
      <p className="small">{providerStatusLine(state.status)}</p>
      {state.key ? (
        <p className="small dim">
          saved: <span className="mono">{state.key.endpointId} ••••{state.key.keyHint}</span> ({state.key.trust})
        </p>
      ) : null}
      {state.key ? <p className="small dim">{savedKeyInfo(state.key)}</p> : null}
      <label className="field-row">
        <span>provider</span>
        <select value={endpoint} disabled={busy} onChange={(e) => setEndpointId(e.target.value)}>
          {state.endpoints.map((e) => (
            <option key={e.id} value={e.id}>
              {e.label}
            </option>
          ))}
        </select>
      </label>
      <label className="field-row">
        <span>API key</span>
        <input type="password" autoComplete="off" value={apiKey} disabled={busy} onChange={(e) => setApiKey(e.target.value)} />
      </label>
      <button type="button" disabled={busy || (!apiKey && !state.key)} onClick={() => void onLoadModels()}>
        load models
      </button>
      <datalist id="my-provider-models">
        {models.map((m) => (
          <option key={m} value={m} />
        ))}
      </datalist>
      {([
        ['narrate', narrate, setNarrate],
        ['mechanics (optional)', mechanics, setMechanics],
        ['extract (optional)', extract, setExtract],
      ] as const).map(([label, value, set]) => (
        <label className="field-row" key={label}>
          <span>{label}</span>
          <input list="my-provider-models" value={value} disabled={busy} onChange={(e) => set(e.target.value)} />
        </label>
      ))}
      <fieldset className="field-row block">
        <legend>how your key is protected</legend>
        <label className="private-recovery-check">
          <input type="radio" name="trust" checked={mode === 'unlock'} disabled={busy || !enrolled} onChange={() => setTrust('unlock')} />
          <span>with my passphrase — {TRUST_COPY.unlock}</span>
        </label>
        <label className="private-recovery-check">
          <input type="radio" name="trust" checked={mode === 'sealed'} disabled={busy || !state.sealedAvailable} onChange={() => setTrust('sealed')} />
          <span>by the server — {state.sealedAvailable ? TRUST_COPY.sealed : 'Not available on this server.'}</span>
        </label>
      </fieldset>
      {mode === 'unlock' ? (
        <label className="field-row">
          <span>passphrase</span>
          <input type="password" autoComplete="current-password" value={passphrase} disabled={busy} onChange={(e) => setPassphrase(e.target.value)} />
        </label>
      ) : null}
      <div className="row">
        <button type="button" disabled={busy || !apiKey || !narrate.trim()} onClick={() => void onTest()}>
          test
        </button>
        <button type="button" disabled={!canSave} onClick={() => void onSave()}>
          save
        </button>
        <button type="button" disabled={busy || !state.key} onClick={() => void onDelete()}>
          delete
        </button>
      </div>
      {note ? <p className="small dim" role="status">{note}</p> : null}
    </div>
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
  return (
    <div className="card">
      <h3>your usage · last {data.days} days</h3>
      {data.rows.map((r) => (
        <div key={`${r.day}|${r.model}|${r.keySource}`} className="row small">
          <span className="grow dim">
            {r.day} · {r.model}
          </span>
          <span className="tag">{r.keySource === 'own' ? 'your key' : 'server'}</span>
          <span className="mono dimmer">
            {r.calls}× {r.tokensIn.toLocaleString()}→{r.tokensOut.toLocaleString()}
          </span>
        </div>
      ))}
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
