/**
 * The baseline security headers come from the app itself, not only from the
 * reverse proxy: a deployment whose proxy config drifts, or a server reached
 * directly, still refuses framing and MIME sniffing and keeps paths out of
 * cross-origin referrers.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import { withPg } from './pg-harness.ts';
import { worldFor } from '../src/store/index-pg.ts';
import { createApiServer } from '../src/server/api-pg.ts';
import { Engine } from '../src/loop/engine-pg.ts';
import { MockProvider } from '../src/providers/mock.ts';
import { ProviderRegistry } from '../src/providers/provider.ts';

test('every response carries nosniff, frame denial and a referrer policy', async (t) => {
  const ran = await withPg(async (db) => {
    const boot = () => worldFor(db, null);
    const server = createApiServer({
      world: boot,
      db,
      engine: new Engine({ world: boot, db, providers: new ProviderRegistry(new MockProvider()) }),
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    try {
      for (const path of ['/api/meta', '/api/no-such-route', '/', '/welcome']) {
        const res = await fetch(`${base}${path}`);
        await res.arrayBuffer();
        assert.equal(res.headers.get('x-content-type-options'), 'nosniff', path);
        assert.equal(res.headers.get('x-frame-options'), 'DENY', path);
        assert.equal(res.headers.get('referrer-policy'), 'strict-origin-when-cross-origin', path);
      }
    } finally {
      await new Promise<void>((r) => server.close(() => r()));
    }
  });
  if (!ran) t.skip('no Postgres configured');
});
