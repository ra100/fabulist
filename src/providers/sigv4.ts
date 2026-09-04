/**
 * AWS Signature Version 4, over node:crypto.
 *
 * Hand-rolled rather than pulled from the AWS SDK. The SDK is a large dependency
 * tree for one signed POST, and this file is the whole of what Bedrock needs.
 * Correctness is not a matter of opinion here, so it is checked against AWS's
 * own published test vector in the tests.
 */
import { createHash, createHmac } from 'node:crypto';

export interface AwsCredentials {
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken?: string;
  /** ISO timestamp; used to refresh before use rather than after a 403. */
  expiration?: string;
  /** Where these came from, for the provider doctor. */
  source: string;
}

export interface SignParams {
  method: string;
  url: string;
  region: string;
  service: string;
  body: string;
  headers?: Record<string, string>;
  credentials: AwsCredentials;
  /** Overridable so the signature is testable against a fixed vector. */
  now?: Date;
  /**
   * Adds `x-amz-content-sha256`. Required by S3, optional elsewhere, and it
   * changes the signed header set - so it is off by default to keep Bedrock
   * requests minimal and comparable to AWS's reference vectors.
   */
  includeContentSha256?: boolean;
}

const sha256 = (data: string | Buffer): string => createHash('sha256').update(data).digest('hex');
const hmac = (key: string | Buffer, data: string): Buffer => createHmac('sha256', key).update(data, 'utf8').digest();

/** `20150830T123600Z` and `20150830`. */
function stamps(now: Date): { amzDate: string; dateStamp: string } {
  const amzDate = `${now.toISOString().replace(/[:-]|\.\d{3}/g, '')}`;
  return { amzDate, dateStamp: amzDate.slice(0, 8) };
}

/**
 * Percent-encodes a path segment per SigV4 rules, which are not the same as
 * `encodeURIComponent`: the unreserved set differs and `~` must stay literal.
 * Bedrock model ids contain colons and dots, so this matters.
 */
function uriEncode(value: string, encodeSlash: boolean): string {
  let out = '';
  for (const ch of value) {
    if (/[A-Za-z0-9\-._~]/.test(ch)) {
      out += ch;
    } else if (ch === '/') {
      out += encodeSlash ? '%2F' : '/';
    } else {
      for (const byte of Buffer.from(ch, 'utf8')) {
        out += `%${byte.toString(16).toUpperCase().padStart(2, '0')}`;
      }
    }
  }
  return out;
}

function canonicalPath(pathname: string): string {
  if (!pathname || pathname === '/') return '/';
  return pathname
    .split('/')
    .map((segment) => uriEncode(segment, true))
    .join('/');
}

function canonicalQuery(search: URLSearchParams): string {
  const pairs: Array<[string, string]> = [];
  for (const [k, v] of search) pairs.push([uriEncode(k, true), uriEncode(v, true)]);
  // Sorted by encoded key, then encoded value.
  pairs.sort((a, b) => (a[0] === b[0] ? (a[1] < b[1] ? -1 : 1) : a[0] < b[0] ? -1 : 1));
  return pairs.map(([k, v]) => `${k}=${v}`).join('&');
}

export interface SignedRequest {
  url: string;
  headers: Record<string, string>;
  body: string;
}

export function signRequest(params: SignParams): SignedRequest {
  const { method, region, service, body, credentials } = params;
  const url = new URL(params.url);
  const { amzDate, dateStamp } = stamps(params.now ?? new Date());

  const headers: Record<string, string> = {
    host: url.host,
    'x-amz-date': amzDate,
    ...Object.fromEntries(Object.entries(params.headers ?? {}).map(([k, v]) => [k.toLowerCase(), v])),
  };
  if (credentials.sessionToken) headers['x-amz-security-token'] = credentials.sessionToken;

  const payloadHash = sha256(body);
  if (params.includeContentSha256) headers['x-amz-content-sha256'] = payloadHash;

  const sortedNames = Object.keys(headers).sort();
  // Header values are trimmed and internal whitespace collapsed before signing.
  const canonicalHeaders = sortedNames.map((n) => `${n}:${headers[n]!.trim().replace(/\s+/g, ' ')}\n`).join('');
  const signedHeaders = sortedNames.join(';');

  const canonicalRequest = [
    method.toUpperCase(),
    canonicalPath(url.pathname),
    canonicalQuery(url.searchParams),
    canonicalHeaders,
    signedHeaders,
    payloadHash,
  ].join('\n');

  const scope = `${dateStamp}/${region}/${service}/aws4_request`;
  const stringToSign = ['AWS4-HMAC-SHA256', amzDate, scope, sha256(canonicalRequest)].join('\n');

  const kDate = hmac(`AWS4${credentials.secretAccessKey}`, dateStamp);
  const kRegion = hmac(kDate, region);
  const kService = hmac(kRegion, service);
  const kSigning = hmac(kService, 'aws4_request');
  const signature = createHmac('sha256', kSigning).update(stringToSign, 'utf8').digest('hex');

  headers.authorization =
    `AWS4-HMAC-SHA256 Credential=${credentials.accessKeyId}/${scope}, ` +
    `SignedHeaders=${signedHeaders}, Signature=${signature}`;

  return { url: url.toString(), headers, body };
}

/** Exposed for the test vector, which asserts on the intermediate strings. */
export function canonicalRequestFor(params: SignParams): { canonicalRequest: string; stringToSign: string; signature: string } {
  const signed = signRequest(params);
  const auth = signed.headers.authorization ?? '';
  const signature = /Signature=([0-9a-f]+)/.exec(auth)?.[1] ?? '';

  const url = new URL(params.url);
  const { amzDate, dateStamp } = stamps(params.now ?? new Date());
  const headers: Record<string, string> = { ...signed.headers };
  delete headers.authorization;
  const sortedNames = Object.keys(headers).sort();
  const canonicalHeaders = sortedNames.map((n) => `${n}:${headers[n]!.trim().replace(/\s+/g, ' ')}\n`).join('');
  const canonicalRequest = [
    params.method.toUpperCase(),
    canonicalPath(url.pathname),
    canonicalQuery(url.searchParams),
    canonicalHeaders,
    sortedNames.join(';'),
    sha256(params.body),
  ].join('\n');
  const scope = `${dateStamp}/${params.region}/${params.service}/aws4_request`;
  const stringToSign = ['AWS4-HMAC-SHA256', amzDate, scope, sha256(canonicalRequest)].join('\n');

  return { canonicalRequest, stringToSign, signature };
}
