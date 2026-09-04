/**
 * AWS credential resolution without an API key. See README "Providers".
 *
 * The point of this file is that a work laptop almost never has static keys in
 * the environment. It has an `AWS_PROFILE` that resolves through SSO, or an
 * external helper like aws-vault or saml2aws, or a role assumed from another
 * profile. Supporting only env vars would mean supporting almost nobody.
 *
 * Resolution order per profile, first hit wins:
 *   1. environment variables
 *   2. static keys in ~/.aws/credentials
 *   3. credential_process (covers aws-vault, saml2aws, and most enterprise tooling)
 *   4. IAM Identity Center (SSO) via the cached access token
 *   5. role_arn + source_profile, assumed with sts:AssumeRole
 *
 * Everything is injected so the whole chain is testable without touching a real
 * ~/.aws or the network.
 */
import { execFile } from 'node:child_process';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { signRequest, type AwsCredentials } from './sigv4.ts';

export interface AwsEnvironment {
  env: Record<string, string | undefined>;
  readFile: (path: string) => string | null;
  listDir: (path: string) => string[];
  fetcher: typeof fetch;
  /** Runs `credential_process`. Returns stdout. */
  run: (command: string) => Promise<string>;
  now: () => Date;
}

export function defaultAwsEnvironment(): AwsEnvironment {
  return {
    env: process.env,
    readFile: (path) => {
      try {
        return existsSync(path) ? readFileSync(path, 'utf8') : null;
      } catch {
        return null;
      }
    },
    listDir: (path) => {
      try {
        return existsSync(path) ? readdirSync(path) : [];
      } catch {
        return [];
      }
    },
    fetcher: fetch,
    run: (command) =>
      new Promise((resolve, reject) => {
        // Shell-free: the AWS config format specifies a command plus arguments,
        // and running it through a shell would make a config file a code-execution
        // vector for anything that can write to it.
        const parts = tokenize(command);
        const [bin, ...args] = parts;
        if (!bin) return reject(new Error('empty credential_process'));
        execFile(bin, args, { timeout: 60_000, maxBuffer: 1024 * 1024 }, (err, stdout) => {
          if (err) reject(err);
          else resolve(stdout);
        });
      }),
    now: () => new Date(),
  };
}

/** Splits a command line on whitespace, honouring single and double quotes. */
export function tokenize(command: string): string[] {
  const out: string[] = [];
  let current = '';
  let quote: '"' | "'" | null = null;
  for (const ch of command.trim()) {
    if (quote) {
      if (ch === quote) quote = null;
      else current += ch;
    } else if (ch === '"' || ch === "'") {
      quote = ch;
    } else if (/\s/.test(ch)) {
      if (current) {
        out.push(current);
        current = '';
      }
    } else {
      current += ch;
    }
  }
  if (current) out.push(current);
  return out;
}

export type IniFile = Record<string, Record<string, string>>;

/** Minimal INI parser for the AWS config format. Nested sub-sections are flattened. */
export function parseIni(text: string): IniFile {
  const out: IniFile = {};
  let section = 'default';
  for (const rawLine of text.split('\n')) {
    const line = rawLine.replace(/[;#].*$/, '').trim();
    if (!line) continue;
    const header = /^\[(.+)\]$/.exec(line);
    if (header?.[1]) {
      section = header[1].trim();
      out[section] ??= {};
      continue;
    }
    const eq = line.indexOf('=');
    if (eq < 0) continue;
    const key = line.slice(0, eq).trim().toLowerCase();
    const value = line.slice(eq + 1).trim();
    out[section] ??= {};
    if (key) out[section]![key] = value;
  }
  return out;
}

export interface ResolvedAws {
  credentials: AwsCredentials;
  region: string;
}

export class AwsCredentialProvider {
  private envs: AwsEnvironment;
  private cache = new Map<string, AwsCredentials>();

  constructor(envs: AwsEnvironment = defaultAwsEnvironment()) {
    this.envs = envs;
  }

  private configDir(): string {
    return this.envs.env.AWS_CONFIG_DIR ?? join(this.envs.env.HOME ?? homedir(), '.aws');
  }

  private credentialsFile(): IniFile {
    const path = this.envs.env.AWS_SHARED_CREDENTIALS_FILE ?? join(this.configDir(), 'credentials');
    const text = this.envs.readFile(path);
    return text ? parseIni(text) : {};
  }

  private configFile(): IniFile {
    const path = this.envs.env.AWS_CONFIG_FILE ?? join(this.configDir(), 'config');
    const text = this.envs.readFile(path);
    if (!text) return {};
    // Config sections are `[profile name]`, except `[default]`. Normalise.
    const raw = parseIni(text);
    const out: IniFile = {};
    for (const [section, values] of Object.entries(raw)) {
      out[section.replace(/^profile\s+/, '')] = values;
    }
    return out;
  }

  profileName(): string {
    return this.envs.env.AWS_PROFILE ?? this.envs.env.AWS_DEFAULT_PROFILE ?? 'default';
  }

  region(profile = this.profileName()): string {
    return (
      this.envs.env.AWS_REGION ??
      this.envs.env.AWS_DEFAULT_REGION ??
      this.configFile()[profile]?.region ??
      'us-east-1'
    );
  }

  /** Profiles visible on this machine, for the provider doctor. */
  listProfiles(): string[] {
    return [...new Set([...Object.keys(this.credentialsFile()), ...Object.keys(this.configFile())])].sort();
  }

  private fresh(creds: AwsCredentials | undefined): AwsCredentials | null {
    if (!creds) return null;
    if (!creds.expiration) return creds;
    // Refresh five minutes early: expiring mid-session shows up as a confusing
    // 403 several turns later rather than as an auth problem.
    const expiresAt = new Date(creds.expiration).getTime();
    return expiresAt - this.envs.now().getTime() > 5 * 60_000 ? creds : null;
  }

  async resolve(profile = this.profileName(), seen = new Set<string>()): Promise<ResolvedAws> {
    const cached = this.fresh(this.cache.get(profile));
    if (cached) return { credentials: cached, region: this.region(profile) };

    if (seen.has(profile)) throw new Error(`circular source_profile chain at "${profile}"`);
    seen.add(profile);

    const credentials = await this.resolveChain(profile, seen);
    this.cache.set(profile, credentials);
    return { credentials, region: this.region(profile) };
  }

  private async resolveChain(profile: string, seen: Set<string>): Promise<AwsCredentials> {
    const env = this.envs.env;

    // 1. Environment. Only honoured for the default profile, or when the
    // environment explicitly names this profile - otherwise asking for profile
    // "prod" could silently hand back whatever keys happen to be exported.
    const envNamesThisProfile = (env.AWS_PROFILE ?? env.AWS_DEFAULT_PROFILE ?? 'default') === profile;
    if (envNamesThisProfile && env.AWS_ACCESS_KEY_ID && env.AWS_SECRET_ACCESS_KEY) {
      return {
        accessKeyId: env.AWS_ACCESS_KEY_ID,
        secretAccessKey: env.AWS_SECRET_ACCESS_KEY,
        ...(env.AWS_SESSION_TOKEN ? { sessionToken: env.AWS_SESSION_TOKEN } : {}),
        source: 'environment',
      };
    }

    const creds = this.credentialsFile()[profile] ?? {};
    const config = this.configFile()[profile] ?? {};
    const merged = { ...config, ...creds };

    // 2. Static keys.
    if (merged.aws_access_key_id && merged.aws_secret_access_key) {
      return {
        accessKeyId: merged.aws_access_key_id,
        secretAccessKey: merged.aws_secret_access_key,
        ...(merged.aws_session_token ? { sessionToken: merged.aws_session_token } : {}),
        source: `credentials file (${profile})`,
      };
    }

    // 3. credential_process.
    if (merged.credential_process) {
      return this.fromProcess(merged.credential_process, profile);
    }

    // 4. IAM Identity Center.
    if (merged.sso_start_url || merged.sso_session) {
      return this.fromSso(profile, merged);
    }

    // 5. Assume a role from another profile.
    if (merged.role_arn && merged.source_profile) {
      return this.fromAssumeRole(profile, merged, seen);
    }

    throw new Error(
      `no credentials for AWS profile "${profile}". Tried environment, credentials file, ` +
        `credential_process, SSO and assume-role.`,
    );
  }

  private async fromProcess(command: string, profile: string): Promise<AwsCredentials> {
    const stdout = await this.envs.run(command);
    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(stdout) as Record<string, unknown>;
    } catch {
      throw new Error(`credential_process for "${profile}" did not return JSON`);
    }
    const accessKeyId = String(parsed.AccessKeyId ?? '');
    const secretAccessKey = String(parsed.SecretAccessKey ?? '');
    if (!accessKeyId || !secretAccessKey) throw new Error(`credential_process for "${profile}" returned no keys`);
    return {
      accessKeyId,
      secretAccessKey,
      ...(parsed.SessionToken ? { sessionToken: String(parsed.SessionToken) } : {}),
      ...(parsed.Expiration ? { expiration: String(parsed.Expiration) } : {}),
      source: `credential_process (${profile})`,
    };
  }

  /**
   * Exchanges a cached SSO access token for role credentials.
   *
   * Deliberately does not attempt the browser login flow: if the token is missing
   * or stale the only useful answer is "run aws sso login", and saying so beats
   * opening a browser from a story engine.
   */
  private async fromSso(profile: string, merged: Record<string, string>): Promise<AwsCredentials> {
    const sessionName = merged.sso_session;
    const sessionConfig = sessionName ? (this.configFile()[`sso-session ${sessionName}`] ?? {}) : {};
    const startUrl = merged.sso_start_url ?? sessionConfig.sso_start_url;
    const ssoRegion = merged.sso_region ?? sessionConfig.sso_region ?? this.region(profile);
    const accountId = merged.sso_account_id;
    const roleName = merged.sso_role_name;

    if (!startUrl || !accountId || !roleName) {
      throw new Error(`profile "${profile}" has incomplete SSO configuration`);
    }

    const token = this.ssoAccessToken(startUrl, sessionName);
    if (!token) {
      throw new Error(`no valid SSO token for "${profile}". Run: aws sso login --profile ${profile}`);
    }

    const url = `https://portal.sso.${ssoRegion}.amazonaws.com/federation/credentials?account_id=${encodeURIComponent(accountId)}&role_name=${encodeURIComponent(roleName)}`;
    const res = await this.envs.fetcher(url, { headers: { 'x-amz-sso_bearer_token': token } });
    if (!res.ok) {
      throw new Error(`SSO credential fetch failed (${res.status}). Run: aws sso login --profile ${profile}`);
    }
    const body = (await res.json()) as { roleCredentials?: { accessKeyId?: string; secretAccessKey?: string; sessionToken?: string; expiration?: number } };
    const rc = body.roleCredentials;
    if (!rc?.accessKeyId || !rc.secretAccessKey) throw new Error('SSO returned no credentials');

    return {
      accessKeyId: rc.accessKeyId,
      secretAccessKey: rc.secretAccessKey,
      ...(rc.sessionToken ? { sessionToken: rc.sessionToken } : {}),
      ...(rc.expiration ? { expiration: new Date(rc.expiration).toISOString() } : {}),
      source: `sso (${profile})`,
    };
  }

  /** Finds the cached SSO token matching this start URL or session name. */
  private ssoAccessToken(startUrl: string, sessionName?: string): string | null {
    const dir = join(this.configDir(), 'sso', 'cache');
    for (const file of this.envs.listDir(dir)) {
      if (!file.endsWith('.json')) continue;
      const text = this.envs.readFile(join(dir, file));
      if (!text) continue;
      let parsed: { startUrl?: string; accessToken?: string; expiresAt?: string; sessionName?: string };
      try {
        parsed = JSON.parse(text);
      } catch {
        continue;
      }
      if (!parsed.accessToken) continue;
      const matches =
        parsed.startUrl === startUrl || (sessionName !== undefined && parsed.sessionName === sessionName);
      if (!matches) continue;
      if (parsed.expiresAt && new Date(parsed.expiresAt).getTime() <= this.envs.now().getTime()) continue;
      return parsed.accessToken;
    }
    return null;
  }

  private async fromAssumeRole(profile: string, merged: Record<string, string>, seen: Set<string>): Promise<AwsCredentials> {
    const source = await this.resolve(merged.source_profile!, seen);
    const region = this.region(profile);
    const sessionName = merged.role_session_name ?? 'story-engine';

    const query = new URLSearchParams({
      Version: '2011-06-15',
      Action: 'AssumeRole',
      RoleArn: merged.role_arn!,
      RoleSessionName: sessionName,
    });
    if (merged.external_id) query.set('ExternalId', merged.external_id);

    const signed = signRequest({
      method: 'POST',
      url: `https://sts.${region}.amazonaws.com/`,
      region,
      service: 'sts',
      body: query.toString(),
      headers: { 'content-type': 'application/x-www-form-urlencoded; charset=utf-8', accept: 'application/json' },
      credentials: source.credentials,
      now: this.envs.now(),
    });

    const res = await this.envs.fetcher(signed.url, { method: 'POST', headers: signed.headers, body: signed.body });
    if (!res.ok) throw new Error(`AssumeRole failed for "${profile}" (${res.status})`);
    const json = (await res.json()) as {
      AssumeRoleResponse?: { AssumeRoleResult?: { Credentials?: { AccessKeyId?: string; SecretAccessKey?: string; SessionToken?: string; Expiration?: string | number } } };
    };
    const c = json.AssumeRoleResponse?.AssumeRoleResult?.Credentials;
    if (!c?.AccessKeyId || !c.SecretAccessKey) throw new Error(`AssumeRole for "${profile}" returned no credentials`);

    return {
      accessKeyId: c.AccessKeyId,
      secretAccessKey: c.SecretAccessKey,
      ...(c.SessionToken ? { sessionToken: c.SessionToken } : {}),
      ...(c.Expiration
        ? { expiration: typeof c.Expiration === 'number' ? new Date(c.Expiration * 1000).toISOString() : c.Expiration }
        : {}),
      source: `assume-role ${merged.role_arn} via ${merged.source_profile}`,
    };
  }
}

export type { AwsCredentials };
