/**
 * Configuration panels.
 *
 * Everything here was previously a hand-edited JSON file plus a restart. The one
 * that matters most is the blocklist: the design expects it to become the most
 * valuable file in the project, which only happens if adding to it costs a click
 * at the moment a phrase annoys you — so it is also addable straight from a lint
 * finding in the why panel.
 */
import { useCallback, useEffect, useState } from 'react';
import {
  api,
  type AppConfig,
  type ConfigBundle,
  type ProbeResult,
  type ProviderSpec,
  type ValidationIssue,
} from '../api.ts';

const KINDS = ['openai-compat', 'anthropic', 'ollama', 'bedrock', 'google', 'copilot'] as const;
const DIALECTS = ['openai', 'vllm', 'llamacpp'] as const;

/** Fields that only make sense for some kinds; showing all of them is noise. */
function relevantFields(kind: string): Array<'baseUrl' | 'dialect' | 'apiKeyEnv' | 'profile' | 'region' | 'project' | 'location' | 'allowUnofficial'> {
  switch (kind) {
    case 'openai-compat':
      return ['baseUrl', 'dialect', 'apiKeyEnv'];
    case 'anthropic':
      return ['baseUrl', 'apiKeyEnv'];
    case 'ollama':
      return ['baseUrl'];
    case 'bedrock':
      return ['profile', 'region'];
    case 'google':
      return ['project', 'location'];
    case 'copilot':
      return ['allowUnofficial'];
    default:
      return [];
  }
}

export function ConfigPanels({ onChanged }: { onChanged?: () => void }) {
  const [bundle, setBundle] = useState<ConfigBundle | null>(null);
  const [issues, setIssues] = useState<ValidationIssue[]>([]);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setBundle(await api.config.get());
    } catch (e) {
      setNote(e instanceof Error ? e.message : String(e));
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const apply = async (fn: () => Promise<{ config: AppConfig; issues: ValidationIssue[]; registryRebuilt: boolean }>) => {
    setBusy(true);
    setNote(null);
    try {
      const result = await fn();
      setIssues(result.issues);
      setBundle((prev) => (prev ? { ...prev, config: result.config } : prev));
      if (result.registryRebuilt) setNote('models reloaded — takes effect on the next turn');
      onChanged?.();
      // Provider keys may have changed, so refresh the surrounding lists.
      setBundle(await api.config.get());
    } catch (e) {
      setNote(e instanceof Error ? e.message : String(e));
    }
    setBusy(false);
  };

  if (!bundle) return <div className="card"><h3>configuration</h3><p className="empty">loading…</p></div>;
  const cfg = bundle.config;

  return (
    <>
      {note ? <div className="card small dim">{note}</div> : null}
      {issues.length ? (
        <div className="card">
          <h3>needs attention</h3>
          {issues.map((i) => (
            <div key={i.field} className="small warn">
              <span className="mono">{i.field}</span> — {i.message}
            </div>
          ))}
        </div>
      ) : null}

      <ProsePanel cfg={cfg} busy={busy} apply={apply} />
      <RoutingPanel bundle={bundle} busy={busy} apply={apply} />
      <ProvidersEditor bundle={bundle} busy={busy} apply={apply} reload={load} />
    </>
  );
}

// ------------------------------------------------------------------- prose

function ProsePanel({
  cfg,
  busy,
  apply,
}: {
  cfg: AppConfig;
  busy: boolean;
  apply: (fn: () => Promise<{ config: AppConfig; issues: ValidationIssue[]; registryRebuilt: boolean }>) => Promise<void>;
}) {
  const [phrase, setPhrase] = useState('');

  return (
    <div className="card">
      <h3>prose gate</h3>
      <div className="knob">
        <label>
          <span>lint threshold</span>
          <span className="mono">{cfg.proseLintThreshold}</span>
        </label>
        <input
          type="range" min="0" max="40" step="1" value={cfg.proseLintThreshold} disabled={busy}
          onChange={(e) => void apply(() => api.config.patch({ proseLintThreshold: Number(e.target.value) }))}
        />
        <p className="hint">
          Lower rewrites more often. Over-tuned it produces careful, characterless prose, so the style anchors above do
          more good than dragging this down.
        </p>
      </div>

      <h3 style={{ marginTop: 14 }}>your blocklist</h3>
      <p className="hint">
        Phrases you never want to read. Add one whenever something annoys you — this list is worth more than any general
        rule, because it is calibrated to your ear.
      </p>
      <div className="row" style={{ marginTop: 7 }}>
        <input
          value={phrase}
          placeholder="a phrase you are tired of"
          onChange={(e) => setPhrase(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && phrase.trim()) {
              void apply(() => api.config.block(phrase)).then(() => setPhrase(''));
            }
          }}
        />
        <button
          disabled={busy || phrase.trim().length < 2}
          onClick={() => void apply(() => api.config.block(phrase)).then(() => setPhrase(''))}
        >
          block
        </button>
      </div>
      {cfg.blocklist.length ? (
        <div className="chips" style={{ marginTop: 9 }}>
          {cfg.blocklist.map((p) => (
            <button key={p} className="chip on" disabled={busy} title="stop blocking this" onClick={() => void apply(() => api.config.unblock(p))}>
              {p} ×
            </button>
          ))}
        </div>
      ) : (
        <p className="small dimmer" style={{ marginTop: 7 }}>Nothing blocked yet.</p>
      )}
    </div>
  );
}

// ----------------------------------------------------------------- routing

function RoutingPanel({
  bundle,
  busy,
  apply,
}: {
  bundle: ConfigBundle;
  busy: boolean;
  apply: (fn: () => Promise<{ config: AppConfig; issues: ValidationIssue[]; registryRebuilt: boolean }>) => Promise<void>;
}) {
  const [open, setOpen] = useState(false);
  const cfg = bundle.config;

  return (
    <div className="card">
      <div className="row">
        <h3 className="grow" style={{ margin: 0 }}>which model does what</h3>
        <button onClick={() => setOpen(!open)}>{open ? 'less' : 'more'}</button>
      </div>
      <p className="hint">
        Empty means the profile decides. Worth pinning <span className="mono">extract</span> and{' '}
        <span className="mono">passb</span> deliberately: they write your world model, and changing them mid-campaign
        yields a subtly inconsistent world with no obvious cause.
      </p>

      {open ? (
        <div style={{ marginTop: 10 }}>
          {bundle.roles.map((role) => (
            <label className="field-row" key={role}>
              <span className="mono">{role}</span>
              <select
                value={cfg.routes[role] ?? ''}
                disabled={busy}
                onChange={(e) => void apply(() => api.config.patch({ routes: { ...cfg.routes, [role]: e.target.value } }))}
              >
                <option value="">(profile default)</option>
                {bundle.providerKeys.map((key) => (
                  <option key={key} value={key}>{key}</option>
                ))}
              </select>
            </label>
          ))}
        </div>
      ) : null}
    </div>
  );
}

// --------------------------------------------------------------- providers

const BLANK: ProviderSpec = { kind: 'openai-compat', model: '', baseUrl: 'http://127.0.0.1:8000/v1', auth: 'none', dialect: 'vllm' };

/**
 * Add, edit, test and keep a provider spec.
 *
 * Exported because the setup wizard shows the same editor before a world is
 * built. Duplicating the form there would mean two places to keep the
 * kind-to-fields mapping and the test-before-keep flow correct, and the wizard
 * is exactly where a wrong local base URL is least likely to be noticed.
 */
export function ProvidersEditor({
  bundle,
  busy,
  apply,
  reload,
}: {
  bundle: ConfigBundle;
  busy: boolean;
  apply: (fn: () => Promise<{ config: AppConfig; issues: ValidationIssue[]; registryRebuilt: boolean }>) => Promise<void>;
  reload: () => Promise<void>;
}) {
  const [editing, setEditing] = useState<string | null>(null);
  const [key, setKey] = useState('');
  const [spec, setSpec] = useState<ProviderSpec>(BLANK);
  const [tested, setTested] = useState<(ProbeResult & { issues: ValidationIssue[] }) | null>(null);
  const cfg = bundle.config;

  const startEdit = (name: string) => {
    const existing = bundle.presets[name] ?? BLANK;
    setEditing(name);
    setKey(name);
    setSpec({ ...existing });
    setTested(null);
  };

  const startNew = () => {
    setEditing('');
    setKey('');
    setSpec({ ...BLANK });
    setTested(null);
  };

  /**
   * Begins a new provider pre-filled from a preset, rather than listing the
   * preset as though it were already configured.
   *
   * The key is copied too, which matters more than convenience: `PROFILES`
   * references presets *by key* (`bedrock` needs `bedrock:sonnet` to exist), so
   * keeping the suggested name makes the profile work without the user having to
   * know that coupling.
   */
  const startFromPreset = (name: string) => {
    const preset = bundle.presets[name];
    if (!preset) return;
    setEditing('');
    setKey(name);
    setSpec({ ...preset });
    setTested(null);
  };

  const field = (name: keyof ProviderSpec, label: string, placeholder = '') => (
    <label className="field-row" key={name}>
      <span>{label}</span>
      <input
        value={String(spec[name] ?? '')}
        placeholder={placeholder}
        onChange={(e) => setSpec({ ...spec, [name]: e.target.value })}
      />
    </label>
  );

  // Only what the user actually configured. The presets are candidates, not
  // accounts: listing all sixteen made the screen read as "sixteen
  // half-configured providers you must now fix" when in fact none of them were
  // ever added. They are still reachable, as templates, from the add flow below.
  const mine = Object.keys(cfg.providers).sort();
  const templates = Object.keys(bundle.presets)
    .filter((name) => !(name in cfg.providers))
    .sort();

  return (
    <div className="card">
      <div className="row">
        <h3 className="grow" style={{ margin: 0 }}>models</h3>
        <button disabled={busy} onClick={startNew}>add</button>
      </div>
      <p className="hint">
        The models you have configured. Nothing here is contacted until a profile or a role points at it.
      </p>

      <div style={{ marginTop: 9 }}>
        {mine.length === 0 ? (
          <p className="small dimmer" style={{ margin: '4px 0' }}>
            None yet — the built-in profiles cover the common cases, so this stays empty until you need a specific
            server, model id or account. <b>add</b> starts a blank one; the templates below pre-fill a known service.
          </p>
        ) : (
          mine.map((name) => (
            <div className="row small" key={name} style={{ marginBottom: 4 }}>
              <span className="grow mono">{name}</span>
              <span className="tag locked">yours</span>
              <button style={{ padding: '2px 7px', fontSize: 11 }} onClick={() => startEdit(name)}>edit</button>
              <button
                style={{ padding: '2px 7px', fontSize: 11 }}
                disabled={busy}
                onClick={() => void apply(() => api.config.removeProvider(name))}
              >
                ×
              </button>
            </div>
          ))
        )}
      </div>

      {editing === null && templates.length ? (
        <details style={{ marginTop: 11 }}>
          <summary className="small dim" style={{ cursor: 'pointer' }}>
            start from a known service ({templates.length})
          </summary>
          <p className="hint" style={{ marginTop: 7 }}>
            These pre-fill the form; nothing is saved until you press <b>keep</b>. The built-in profiles already refer
            to these names, so keeping the suggested name is usually what you want.
          </p>
          <div className="row wrap" style={{ marginTop: 7, gap: 4 }}>
            {templates.map((name) => (
              <button
                key={name}
                className="mono"
                style={{ padding: '2px 7px', fontSize: 11 }}
                onClick={() => startFromPreset(name)}
              >
                {name}
              </button>
            ))}
          </div>
        </details>
      ) : null}

      {editing !== null ? (
        <div style={{ marginTop: 13, borderTop: '1px solid var(--rule)', paddingTop: 11 }}>
          <h3 className="eyebrow" style={{ marginTop: 0 }}>
            {editing === '' ? 'add a model' : `editing ${editing}`}
          </h3>
          <label className="field-row">
            <span>name</span>
            <input value={key} placeholder="vllm:my-model" onChange={(e) => setKey(e.target.value)} />
          </label>
          <label className="field-row">
            <span>kind</span>
            <select value={spec.kind} onChange={(e) => setSpec({ ...spec, kind: e.target.value })}>
              {KINDS.map((k) => <option key={k} value={k}>{k}</option>)}
            </select>
          </label>
          {field('model', 'model id', 'the id the server was launched with')}

          {relevantFields(spec.kind).map((name) => {
            if (name === 'allowUnofficial') {
              return (
                <label className="field-row" key={name}>
                  <span>unofficial</span>
                  <span className="small" style={{ display: 'flex', alignItems: 'center', gap: 7 }}>
                    <input
                      type="checkbox"
                      style={{ width: 'auto' }}
                      checked={spec.allowUnofficial === true}
                      onChange={(e) => setSpec({ ...spec, allowUnofficial: e.target.checked })}
                    />
                    I understand this uses an undocumented endpoint and may breach Copilot's terms
                  </span>
                </label>
              );
            }
            if (name === 'dialect') {
              return (
                <label className="field-row" key={name}>
                  <span>dialect</span>
                  <select value={spec.dialect ?? 'openai'} onChange={(e) => setSpec({ ...spec, dialect: e.target.value })}>
                    {DIALECTS.map((d) => <option key={d} value={d}>{d}</option>)}
                  </select>
                </label>
              );
            }
            const labels: Record<string, [string, string]> = {
              baseUrl: ['base url', 'http://127.0.0.1:8000/v1'],
              apiKeyEnv: ['key from env', 'OPENAI_API_KEY'],
              profile: ['aws profile', 'leave blank for AWS_PROFILE'],
              region: ['aws region', 'leave blank to use the profile'],
              project: ['gcp project', 'leave blank to discover'],
              location: ['gcp location', 'us-central1'],
            };
            const [label, placeholder] = labels[name] ?? [name, ''];
            return field(name, label, placeholder);
          })}

          {tested ? (
            <div className="small" style={{ marginTop: 8 }}>
              <span className={tested.status === 'ready' ? 'ok' : 'warn'}>{tested.status}</span>{' '}
              <span className="dim">{tested.detail}</span>
              {tested.fix ? <div className="warn">→ {tested.fix}</div> : null}
              {tested.issues.map((i) => (
                <div key={i.field} className="warn">
                  <span className="mono">{i.field}</span> — {i.message}
                </div>
              ))}
            </div>
          ) : null}

          <div className="row" style={{ marginTop: 10 }}>
            <button
              disabled={busy || !spec.model.trim()}
              onClick={() => void api.config.testProvider(key || 'candidate', spec).then(setTested)}
            >
              test it
            </button>
            <button
              className="primary"
              disabled={busy || !key.trim() || !spec.model.trim()}
              onClick={() =>
                void apply(() => api.config.putProvider(key, spec)).then(async () => {
                  setEditing(null);
                  await reload();
                })
              }
            >
              keep
            </button>
            <button onClick={() => setEditing(null)}>cancel</button>
          </div>
        </div>
      ) : null}
    </div>
  );
}
