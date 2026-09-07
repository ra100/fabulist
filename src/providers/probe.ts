/**
 * Provider probe. Answers "what can I actually use on this machine, right now?"
 *
 * Worth its own module because the failure modes are all different and all
 * silent: a local server that isn't running, an SSO token that expired
 * yesterday, a Bedrock region where the model was never granted access, a
 * gcloud login without a project set. Each of those produces a different
 * mid-session error hours later, and each has a different one-line fix.
 */
import { AwsCredentialProvider } from './aws.ts';
import { GoogleAuth } from './google.ts';
import { findCopilotOAuthToken, defaultCopilotEnvironment } from './copilot.ts';
import { defaultAuth, PRESETS, type AuthMode, type ProviderSpec } from './http.ts';

export type ProbeStatus = 'ready' | 'unavailable' | 'unknown';

export interface ProbeResult {
  key: string;
  kind: string;
  model: string;
  auth: AuthMode;
  status: ProbeStatus;
  /** What is configured, when ready. */
  detail: string;
  /** The single most useful next step, when not. */
  fix: string;
  note?: string;
}

export interface ProbeOptions {
  env?: Record<string, string | undefined>;
  fetcher?: typeof fetch;
  /** Skip network reachability checks for local servers. */
  offline?: boolean;
  timeoutMs?: number;
  aws?: AwsCredentialProvider;
  google?: GoogleAuth;
}

async function reachable(url: string, fetcher: typeof fetch, timeoutMs: number): Promise<boolean> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetcher(url, { signal: controller.signal });
    // Any HTTP answer proves something is listening; 404 on /models still counts.
    return res.status > 0;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

export async function probeProvider(key: string, spec: ProviderSpec, opts: ProbeOptions = {}): Promise<ProbeResult> {
  const env = opts.env ?? process.env;
  const fetcher = opts.fetcher ?? fetch;
  const timeoutMs = opts.timeoutMs ?? 2500;
  const auth = spec.auth ?? defaultAuth(spec.kind);

  const base: ProbeResult = {
    key,
    kind: spec.kind,
    model: spec.model,
    auth,
    status: 'unknown',
    detail: '',
    fix: '',
    ...(spec.note ? { note: spec.note } : {}),
  };

  switch (auth) {
    case 'none': {
      const url = spec.kind === 'ollama' ? `${spec.baseUrl}/api/tags` : `${spec.baseUrl}/models`;
      if (opts.offline) return { ...base, status: 'unknown', detail: 'local server, not probed' };
      const up = await reachable(url, fetcher, timeoutMs);
      return up
        ? { ...base, status: 'ready', detail: `listening at ${spec.baseUrl}` }
        : {
            ...base,
            status: 'unavailable',
            detail: `nothing listening at ${spec.baseUrl}`,
            fix: startHint(spec),
          };
    }

    case 'api-key': {
      const present = !!(spec.apiKeyEnv && env[spec.apiKeyEnv]);
      if (present) return { ...base, status: 'ready', detail: `${spec.apiKeyEnv} is set` };
      // A target with a local credential fallback is not unavailable just
      // because no key is exported: Unsloth's desktop secret authenticates a
      // local install, so reporting "not set" here would send someone to create
      // a key they do not need. Probed for real rather than assumed present.
      if (spec.localAuth === 'unsloth-desktop') {
        const { UnslothAuth } = await import('./unslothAuth.ts');
        const root = (spec.baseUrl ?? '').replace(/\/v1\/?$/, '');
        const resolved = await new UnslothAuth({ baseUrl: root, fetcher, timeoutMs }).token().catch(() => null);
        if (resolved) {
          return { ...base, status: 'ready', detail: `no key needed: authenticated via this machine\u2019s ${resolved.source === 'desktop-secret' ? 'desktop login' : resolved.source}` };
        }
        return {
          ...base,
          status: 'unavailable',
          detail: `${spec.apiKeyEnv} is not set and no local desktop login was available`,
          fix: `start Unsloth Studio locally, or export ${spec.apiKeyEnv}=… for a remote instance`,
        };
      }
      return { ...base, status: 'unavailable', detail: `${spec.apiKeyEnv} is not set`, fix: `export ${spec.apiKeyEnv}=…` };
    }

    case 'aws-profile': {
      const aws = opts.aws ?? new AwsCredentialProvider();
      const profile = spec.profile ?? aws.profileName();
      try {
        const resolved = await aws.resolve(profile);
        const source = resolved.credentials.source;
        // Resolving proves the credentials were *found*, never that they still
        // work. Static keys in particular are read straight off disk: a stale
        // `aws_session_token` in `~/.aws/credentials` resolves perfectly and
        // then fails every call with a 403 that the runtime used to blame on
        // model access. That cost a real debugging detour, so the distinction
        // is surfaced here rather than left for the first failed turn.
        //
        // SSO differs in kind: `resolve` reads a cached token that carries an
        // expiry, so a lapsed one throws and lands in the catch below.
        const unverifiable = /credentials file|environment/i.test(source);
        return {
          ...base,
          status: 'ready',
          detail: `profile "${profile}" via ${source}, region ${spec.region ?? resolved.region}`,
          // Credentials resolving proves identity, not model entitlement, and
          // Bedrock access is granted per model per region.
          fix: unverifiable
            ? 'static keys, not a live session — if calls fail with 403 they are expired: refresh (aws sso login) rather than checking model access'
            : '',
        };
      } catch (err) {
        const profiles = aws.listProfiles();
        return {
          ...base,
          status: 'unavailable',
          detail: err instanceof Error ? err.message : String(err),
          fix: profiles.length
            ? `try AWS_PROFILE=<one of: ${profiles.slice(0, 6).join(', ')}> or: aws sso login --profile ${profile}`
            : 'configure a profile: aws configure sso',
        };
      }
    }

    case 'google-oauth': {
      const google = opts.google ?? new GoogleAuth();
      try {
        const token = await google.accessToken();
        const project = spec.project ?? google.project();
        if (!project) {
          return {
            ...base,
            status: 'unavailable',
            detail: `signed in via ${token.source}, but no project is set`,
            fix: 'export GOOGLE_CLOUD_PROJECT=<your project id>',
          };
        }
        return { ...base, status: 'ready', detail: `${token.source}, project ${project}` };
      } catch (err) {
        return {
          ...base,
          status: 'unavailable',
          detail: err instanceof Error ? err.message : String(err),
          fix: 'gcloud auth application-default login',
        };
      }
    }

    case 'copilot-oauth': {
      const found = findCopilotOAuthToken(defaultCopilotEnvironment());
      if (!found) {
        return { ...base, status: 'unavailable', detail: 'no local Copilot token', fix: 'sign in to Copilot in your editor' };
      }
      if (spec.allowUnofficial !== true) {
        return {
          ...base,
          status: 'unavailable',
          detail: `token found at ${found.source}, but the provider is disabled`,
          fix: 'set "allowUnofficial": true on the provider spec to acknowledge it is undocumented and may breach Copilot terms',
        };
      }
      return { ...base, status: 'ready', detail: `token from ${found.source}` };
    }

    default:
      return base;
  }
}

function startHint(spec: ProviderSpec): string {
  switch (spec.dialect) {
    case 'vllm':
      return `start it: vllm serve <model> --port ${port(spec.baseUrl)} --max-model-len 65536`;
    case 'llamacpp':
      return `start it: llama-server -m <model.gguf> --port ${port(spec.baseUrl)} --ctx-size 65536`;
    default:
      return spec.kind === 'ollama' ? 'start it: ollama serve' : `start a server at ${spec.baseUrl}`;
  }
}

function port(baseUrl = ''): string {
  try {
    return new URL(baseUrl).port || '8000';
  } catch {
    return '8000';
  }
}

/** Probes every preset plus any extra specs from config, concurrently. */
export async function probeAll(
  extra: Record<string, ProviderSpec> = {},
  opts: ProbeOptions = {},
): Promise<ProbeResult[]> {
  const specs = { ...PRESETS, ...extra };
  const results = await Promise.all(
    Object.entries(specs).map(([key, spec]) =>
      probeProvider(key, spec, opts).catch(
        (err: unknown): ProbeResult => ({
          key,
          kind: spec.kind,
          model: spec.model,
          auth: spec.auth ?? defaultAuth(spec.kind),
          status: 'unavailable',
          detail: err instanceof Error ? err.message : String(err),
          fix: '',
        }),
      ),
    ),
  );
  // Ready first, then by key, so the useful answer is at the top.
  const rank = (s: ProbeStatus) => (s === 'ready' ? 0 : s === 'unknown' ? 1 : 2);
  return results.sort((a, b) => rank(a.status) - rank(b.status) || a.key.localeCompare(b.key));
}

/** Which profiles are fully usable, so the UI can offer only real choices. */
export function usableProfiles(results: ProbeResult[], profiles: Record<string, { narrate: string; mechanics: string; extract: string }>): string[] {
  const ready = new Set(results.filter((r) => r.status === 'ready').map((r) => r.key));
  return Object.entries(profiles)
    .filter(([, roles]) => ready.has(roles.narrate) && ready.has(roles.mechanics) && ready.has(roles.extract))
    .map(([name]) => name);
}
