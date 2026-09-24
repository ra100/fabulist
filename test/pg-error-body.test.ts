/**
 * What an unexpected server error tells the caller.
 *
 * A 4xx message is the caller's to read. A 5xx one is whatever an internal layer
 * threw — SQL, file paths, a provider's response — so a signed-in server logs it
 * under a reference and sends only that. A login-off server is one person's own
 * laptop, and keeps surfacing the message, because a silent 500 there is worse.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { withPg } from './pg-harness.ts';
import { fakeAuth, listenSignedIn } from './signed-in.ts';
import { PrivateStoryLockedError } from '../src/store/private-story-access.ts';
import { worldFor } from '../src/store/index-pg.ts';
import { createApiServer } from '../src/server/api-pg.ts';
import { Engine } from '../src/loop/engine-pg.ts';
import { MockProvider } from '../src/providers/mock.ts';
import { ProviderRegistry } from '../src/providers/provider.ts';
import type { SetupService } from '../src/setup/service-pg.ts';
import type { AuthConfig } from '../src/auth/config.ts';
import type { Db } from '../src/db/pg.ts';

const INTERNAL = 'relation "stories" violates constraint at /srv/fabulist/src/store/world-pg.ts:704';

/** A setup service whose reset throws `error`: by default the kind only the server should see. */
const brokenSetup = (error: Error) =>
  ({
    resetMyStory: async () => {
      throw error;
    },
  }) as unknown as SetupService;

async function resetReply(db: Db, authConfig: AuthConfig | undefined, error: Error = new Error(INTERNAL)) {
  const boot = () => worldFor(db, null);
  const server = createApiServer({
    world: boot,
    db,
    engine: new Engine({ world: boot, db, providers: new ProviderRegistry(new MockProvider()) }),
    setup: brokenSetup(error),
    ...(authConfig ? { authConfig } : {}),
  });
  const { as, close } = await listenSignedIn(server);
  const errors: unknown[][] = [];
  const original = console.error;
  console.error = (...args: unknown[]) => void errors.push(args);
  try {
    return { reply: await as('alice', 'POST', '/api/setup/reset', {}), errors };
  } finally {
    console.error = original;
    await close();
  }
}

test('a signed-in 500 hides the internal message behind a logged reference', async (t) => {
  const ran = await withPg(async (db) => {
    const { reply, errors } = await resetReply(db, fakeAuth());
    assert.equal(reply.status, 500);
    const message = reply.body.error ?? '';
    assert.doesNotMatch(message, /violates|\/srv\//, 'no internal detail reaches the caller');
    const ref = /ref ([0-9a-f]{8})/.exec(message)?.[1];
    assert.ok(ref, `the reply carries a reference: ${message}`);
    const logged = errors.find((args) => String(args[0]).includes(ref));
    assert.ok(logged, 'the reference is logged');
    assert.ok(logged.some((a) => a instanceof Error && a.message === INTERNAL), 'next to the real error');
  });
  if (!ran) t.skip('no Postgres configured');
});

test('a locked private story is a 423 with its message, not a hidden 500', async (t) => {
  const ran = await withPg(async (db) => {
    // The UI recognises the lock by this exact message and offers to unlock, so
    // it must reach a signed-in caller intact.
    const locked = new PrivateStoryLockedError('story:locked-one');
    const { reply } = await resetReply(db, fakeAuth(), locked);
    assert.equal(reply.status, 423);
    assert.equal(reply.body.error, 'private story story:locked-one is locked');
  });
  if (!ran) t.skip('no Postgres configured');
});

test('a login-off 500 still surfaces the message to the one local user', async (t) => {
  const ran = await withPg(async (db) => {
    const { reply } = await resetReply(db, undefined);
    assert.equal(reply.status, 500);
    assert.equal(reply.body.error, INTERNAL);
  });
  if (!ran) t.skip('no Postgres configured');
});
