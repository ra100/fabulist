/**
 * Issue #27: the reference reverse-proxy config
 * (`deploy/nginx/fabulist.conf`) set no baseline security headers at all —
 * no CSP, no clickjacking protection, no MIME-sniffing guard. This is a
 * static-config regression test, the same pattern
 * `test/release-workflow.test.ts` already uses for the release workflow's
 * pinned SSH host key: it does not start nginx (this file is a reference
 * config the operator manages directly, per its own header comment — see
 * `deploy/nginx/fabulist.conf`'s first paragraph), it only proves the
 * committed text still contains what this issue required, so a future edit
 * cannot silently drop a header.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const conf = readFileSync(new URL('../deploy/nginx/fabulist.conf', import.meta.url), 'utf8');

/** Only the `server { listen 443 ... }` block should carry these — verifies placement, not just presence, since an `add_header` outside every `server{}` in an included fragment applies at the parent `http{}` level instead of scoping to this one virtual host. */
function serverBlock(text: string, marker: string): string {
  const blocks: string[] = [];
  const serverRe = /server\s*\{/g;
  let match: RegExpExecArray | null;
  while ((match = serverRe.exec(text))) {
    const openBrace = match.index + match[0].length - 1;
    let depth = 0;
    for (let i = openBrace; i < text.length; i++) {
      if (text[i] === '{') depth++;
      else if (text[i] === '}') {
        depth--;
        if (depth === 0) {
          blocks.push(text.slice(openBrace, i + 1));
          break;
        }
      }
    }
  }
  const found = blocks.find((b) => b.includes(marker));
  assert.ok(found, `expected a server{} block containing ${JSON.stringify(marker)}`);
  return found!;
}

test('the 443 server block sets a Content-Security-Policy scoped to the built frontend', () => {
  const https = serverBlock(conf, 'listen 443 ssl;');
  assert.match(https, /add_header Content-Security-Policy "[^"]*default-src 'self'[^"]*" always;/);
  assert.match(https, /script-src 'self'/);
  assert.match(https, /frame-ancestors 'none'/);
  assert.match(https, /object-src 'none'/);
  // Google Fonts is the one cross-origin dependency the landing page has —
  // style/font-src must allow exactly that, not a wildcard.
  assert.match(https, /style-src[^;]*fonts\.googleapis\.com/);
  assert.match(https, /font-src[^;]*fonts\.gstatic\.com/);
});

test('the 443 server block sets X-Frame-Options, X-Content-Type-Options, and Referrer-Policy', () => {
  const https = serverBlock(conf, 'listen 443 ssl;');
  assert.match(https, /add_header X-Frame-Options "DENY" always;/);
  assert.match(https, /add_header X-Content-Type-Options "nosniff" always;/);
  assert.match(https, /add_header Referrer-Policy "strict-origin-when-cross-origin" always;/);
});

test('HSTS is documented with an explicit rollout policy rather than shipped live by default', () => {
  // Commented out: HSTS is a one-way door per browser once a client caches
  // it, so this reference config must not turn it on unilaterally for
  // whoever adopts it — see the rollout steps immediately above it.
  assert.match(conf, /# add_header Strict-Transport-Security "max-age=\d+" always;/);
  assert.match(conf, /Documented rollout, in order:/);
  assert.match(conf, /HSTS is a one-way door per browser/);
});

test('the plain-http :80 block still only redirects — no security headers duplicated onto a response that never has a body', () => {
  const http = serverBlock(conf, 'listen 80;');
  assert.match(http, /return 301 https:\/\/\$host\$request_uri;/);
  assert.doesNotMatch(http, /add_header/);
});
