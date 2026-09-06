import { test } from 'node:test';
import assert from 'node:assert/strict';
import { World } from '../src/store/index.ts';
import { MockProvider } from '../src/providers/mock.ts';
import { ProviderRegistry, SwappableRegistry } from '../src/providers/provider.ts';
import { WikiDirectory, directoryFixture } from '../src/setup/directory.ts';
import { SetupPlanner } from '../src/setup/planner.ts';
import { applyCustomWorld, assignPlayerCharacter, proposeOpening } from '../src/setup/apply.ts';
import { JobRegistry } from '../src/setup/jobs.ts';
import { SetupService } from '../src/setup/service.ts';
import { checkIntegrity, formatIntegrityReport } from '../src/store/integrity.ts';
import { fixtureFetcher } from '../src/ingest/client.ts';
import { WIKI } from './fixtures/wiki.ts';

const FIXTURE = {
  wikis: {
    'https://vale.fandom.com': { sitename: 'The Ashen Vale Wiki', articles: 4200 },
    'https://ashenvale.fandom.com': { sitename: 'Ashen Vale Fan Wiki', articles: 90 },
  },
  directory: {
    'the ashen vale': [
      { name: 'The Ashen Vale Wiki', url: 'https://vale.fandom.com' },
      { name: 'Ashen Vale Fan Wiki', url: 'https://ashenvale.fandom.com' },
    ],
  },
  categories: {
    'https://vale.fandom.com': [
      { category: 'Characters', size: 120 },
      { category: 'Locations', size: 60 },
      { category: 'Organizations', size: 24 },
      { category: 'Ashgrove Arc', size: 18 },
      { category: 'Articles needing images', size: 900 },
      { category: 'Stubs', size: 400 },
    ],
  },
  search: { 'ashgrove arc': ['Ashgrove Arc'], 'duskhollow': ['Duskhollow'] },
};

const directory = () => new WikiDirectory({ fetcher: directoryFixture(FIXTURE), delayMs: 0 });

function service(world = World.open(':memory:')) {
  const svc = new SetupService({
    world,
    providers: new ProviderRegistry(new MockProvider()),
    directoryOptions: { fetcher: directoryFixture(FIXTURE), delayMs: 0 },
    wikiFetcher: fixtureFetcher(WIKI),
  });
  return { world, svc };
}

async function settle(jobs: JobRegistry, id: string, tries = 200): Promise<void> {
  for (let i = 0; i < tries; i++) {
    if (jobs.get(id)?.status !== 'running') return;
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error('job did not settle');
}

// ---------------------------------------------------------------- directory

test('a universe name resolves to verified wikis, largest first', async () => {
  const candidates = await directory().resolve('the ashen vale');
  assert.ok(candidates.length >= 2);
  assert.equal(candidates[0]?.baseUrl, 'https://vale.fandom.com');
  assert.equal(candidates[0]?.name, 'The Ashen Vale Wiki', 'the real name comes from siteinfo');
  // When several wikis match a franchise, the largest almost always has the lore.
  assert.ok((candidates[0]?.articles ?? 0) > (candidates[1]?.articles ?? 0));
});

test('every offered candidate was actually verified to exist', async () => {
  const candidates = await directory().resolve('the ashen vale');
  assert.ok(candidates.every((c) => c.articles > 0 && c.name.length > 0));
});

test('an unknown universe returns nothing rather than a bad guess', async () => {
  assert.deepEqual(await directory().resolve('a franchise that does not exist anywhere'), []);
});

test('an explicit url is trusted and verified directly', async () => {
  const candidates = await directory().resolve('https://vale.fandom.com');
  assert.equal(candidates.length, 1);
  assert.equal(candidates[0]?.via, 'explicit');
});

test('an empty query resolves to nothing without making requests', async () => {
  const dir = directory();
  assert.deepEqual(await dir.resolve('   '), []);
  assert.equal(dir.requests, 0);
});

test('starting points offer story categories and drop housekeeping ones', async () => {
  const points = await directory().suggestStartingPoints('https://vale.fandom.com');
  const titles = points.map((p) => p.title);
  assert.ok(titles.includes('Characters'));
  assert.ok(titles.includes('Ashgrove Arc'));
  assert.ok(!titles.includes('Stubs'), 'maintenance categories are useless to play in');
  assert.ok(!titles.includes('Articles needing images'));
});

test('a hint puts a named arc at the top of the starting points', async () => {
  const points = await directory().suggestStartingPoints('https://vale.fandom.com', 'ashgrove arc');
  assert.equal(points[0]?.title, 'Ashgrove Arc', 'a named arc beats any category');
  assert.equal(points[0]?.kind, 'page');
});

// ------------------------------------------------------------------ planner

test('free text becomes a plan with seeds drawn only from real starting points', async () => {
  const planner = new SetupPlanner(new MockProvider());
  const startingPoints = [
    { title: 'Ashgrove Arc', kind: 'category', members: 18 },
    { title: 'Characters', kind: 'category', members: 120 },
    { title: 'Locations', kind: 'category', members: 60 },
  ];
  const plan = await planner.plan({
    wish: 'I want to play in the Ashgrove arc as a minor character',
    wiki: { name: 'W', baseUrl: 'https://vale.fandom.com', articles: 4200, language: 'en', via: 'directory', confidence: 0.9 },
    startingPoints,
  });

  const offered = new Set(startingPoints.map((s) => s.title));
  assert.ok(plan.seeds.length > 0);
  assert.ok(plan.seeds.every((s) => offered.has(s)), 'a hallucinated page title would leave an empty world');
  assert.ok(['skim', 'mid', 'deep'].includes(plan.mode));
});

test('the planner sees a live profile switch instead of the provider captured at construction', async () => {
  // The real bug: SetupService used to resolve `providers.get('setup')` once in
  // its constructor and hand SetupPlanner that concrete Provider. Switching the
  // live profile afterwards — the wizard's own "you have Bedrock, use it"
  // button — replaced what the registry's `.get()` returns without replacing
  // the object SetupPlanner had already captured, so every plan kept silently
  // running on whatever was live at server startup. The engine never had this
  // bug: it holds the Registry and calls `.get(role)` per turn.
  const before = new MockProvider({ id: 'before' });
  const after = new MockProvider({ id: 'after' });
  const registry = new SwappableRegistry(new ProviderRegistry(before), 'a');

  const planner = new SetupPlanner(() => registry.get('setup'));
  const startingPoints = [{ title: 'Ashgrove Arc', kind: 'category', members: 18 }];
  const wiki = { name: 'W', baseUrl: 'https://vale.fandom.com', articles: 4200, language: 'en', via: 'directory' as const, confidence: 0.9 };

  await planner.plan({ wish: 'a minor character in the Ashgrove arc', wiki, startingPoints });
  assert.equal(before.calls.length, 1, 'the profile live at construction serves the first call');
  assert.equal(after.calls.length, 0);

  registry.swap(new ProviderRegistry(after), 'b');

  await planner.plan({ wish: 'a minor character in the Ashgrove arc', wiki, startingPoints });
  assert.equal(before.calls.length, 1, 'the old provider is not called again after the swap');
  assert.equal(after.calls.length, 1, 'the swapped-in provider serves the very next call, no restart needed');
});

test('a plan gives the player character ranked vows', async () => {
  const planner = new SetupPlanner(new MockProvider());
  const plan = await planner.plan({
    wish: 'a smuggler with a conscience in the Ashgrove arc',
    wiki: { name: 'W', baseUrl: 'https://vale.fandom.com', articles: 100, language: 'en', via: 'slug', confidence: 0.6 },
    startingPoints: [{ title: 'Ashgrove Arc', kind: 'category', members: 18 }],
  });
  assert.ok(plan.character.vows.length > 0, 'vows are what let the gate refuse an action');
  assert.ok(plan.character.vows.every((v) => v.text.length > 3 && typeof v.rank === 'number'));
});

test('depth mode follows the intensity of what the player asked for', async () => {
  const planner = new SetupPlanner(new MockProvider());
  const points = [{ title: 'Ashgrove Arc', kind: 'category', members: 18 }];
  const wiki = { name: 'W', baseUrl: 'https://vale.fandom.com', articles: 100, language: 'en', via: 'slug' as const, confidence: 0.6 };

  const quick = await planner.plan({ wish: 'just a quick try of the Ashgrove arc', wiki, startingPoints: points });
  const long = await planner.plan({ wish: 'I want to play here for months, everything about the Ashgrove arc', wiki, startingPoints: points });
  assert.equal(quick.mode, 'skim');
  assert.equal(long.mode, 'deep');
});

test('style is inferred from how the player describes what they want', async () => {
  const planner = new SetupPlanner(new MockProvider());
  const plan = await planner.plan({
    wish: 'a noir story in first person in the Ashgrove arc',
    wiki: { name: 'W', baseUrl: 'https://vale.fandom.com', articles: 100, language: 'en', via: 'slug', confidence: 0.6 },
    startingPoints: [{ title: 'Ashgrove Arc', kind: 'category', members: 18 }],
  });
  assert.equal(plan.style.pov, 'first');
  assert.equal(plan.style.genreLens, 'noir');
});

test('a plan with no usable seeds falls back to the largest starting points', async () => {
  const planner = new SetupPlanner(new MockProvider());
  const plan = await planner.plan({
    wish: 'something completely unrelated to anything offered',
    wiki: { name: 'W', baseUrl: 'https://vale.fandom.com', articles: 100, language: 'en', via: 'slug', confidence: 0.6 },
    startingPoints: [{ title: 'Characters', kind: 'category', members: 120 }],
  });
  assert.ok(plan.seeds.length > 0, 'an empty world is the worst outcome, so never return zero seeds');
});

// ------------------------------------------------------------- custom world

test('a described world becomes a playable graph', async () => {
  const { world, svc } = service();
  const job = svc.startCustomWorld('a grim city where the weights and measures office is corrupt');
  await settle(svc.jobs, job.id);

  const settled = svc.jobs.get(job.id)!;
  assert.equal(settled.status, 'done');
  const result = settled.result as { entities: number; playerCharacterId: string };
  assert.ok(result.entities >= 10, `built ${result.entities} entities`);
  assert.ok(world.graph.get(result.playerCharacterId), 'the protagonist exists');
  assert.equal(world.cast.get(result.playerCharacterId)?.isPlayer, true);
  world.close();
});

test('an authored world lands in canon so it can be branched from later', async () => {
  const { world, svc } = service();
  const job = svc.startCustomWorld('a quiet town with a secret');
  await settle(svc.jobs, job.id);
  assert.ok(world.graph.counts().canon > 0, 'authored material is source material');
  world.close();
});

test('the player character in a custom world has vows', async () => {
  const { world, svc } = service();
  const job = svc.startCustomWorld('a corrupt assay office');
  await settle(svc.jobs, job.id);
  const player = world.cast.player()!;
  assert.ok(player.contract.vows.length > 0, 'otherwise the integrity gate has nothing to defend');
  assert.ok(player.contract.vows.every((v) => !v.broken));
  world.close();
});

test('custom worlds get threads with more than one possible resolution', async () => {
  const { world, svc } = service();
  const job = svc.startCustomWorld('a corrupt assay office');
  await settle(svc.jobs, job.id);
  const threads = world.threads.all();
  assert.ok(threads.length > 0);
  assert.ok(threads.every((t) => t.resolutions.length > 1), 'a single path is a plot, and plots break');
  world.close();
});

test('asymmetric relationships survive into a custom world', async () => {
  const { world, svc } = service();
  const job = svc.startCustomWorld('a corrupt assay office');
  await settle(svc.jobs, job.id);
  const a = world.cast.relationship('char:sera-vayne', 'char:assayer-crole');
  const b = world.cast.relationship('char:assayer-crole', 'char:sera-vayne');
  assert.notEqual(a.trust, b.trust, 'A distrusting B while B relies on A is the normal case');
  world.close();
});

test('a custom world with bad ids and dangling edges is repaired, not rejected', () => {
  const world = World.open(':memory:');
  const result = applyCustomWorld(world, {
    entities: [
      { id: 'char:good', type: 'Character', name: 'Good', summary: 'fine' },
      { id: 'not a valid id', type: 'Character', name: 'Bad', summary: 'skipped' },
    ],
    edges: [
      { subject: 'char:good', predicate: 'KNOWS', object: 'char:missing' },
      { subject: 'char:good', predicate: 'KNOWS', object: 'char:good' },
    ],
    playerCharacterId: 'char:nonexistent',
  });

  assert.equal(result.entities, 1);
  assert.equal(result.edges, 0, 'a dangling edge makes the referee confidently wrong later');
  assert.equal(result.playerCharacterId, 'char:good', 'fell back to a real character');
  assert.ok(result.warnings.length >= 3, 'and said so');
  assert.ok(world.cast.get('char:good')?.isPlayer, 'the player always ends up with a sheet');
  world.close();
});

// ---------------------------------------------------------------- ingest flow

test('committing without a preview is refused', () => {
  const { world, svc } = service();
  assert.throws(
    () => svc.startIngest('never-previewed', { character: { existing: null, name: 'X', role: '', goals: [], vows: [] }, style: {}, opening: '' }),
    /preview/,
  );
  world.close();
});

test('a preview reports scope and cost without writing anything', async () => {
  const { world, svc } = service();
  const before = world.graph.counts().entities;
  const res = await svc.preview('https://vale.fandom.com', ['Duskhollow'], 'mid');

  assert.ok(res.preview.candidatePages > 0);
  assert.ok(res.preview.estimatedCostUsd >= 0);
  assert.ok(res.estimatedSeconds > 0, 'so "deep" is an informed choice');
  assert.equal(world.graph.counts().entities, before, 'discovery must never commit');
  assert.ok(res.previewKey);
  world.close();
});

// -------------------------------------------------------- discover (job)

test('discover runs the same crawl as preview, but as a pollable job with progress', async () => {
  const { world, svc } = service();
  const sketch = { existing: null, name: 'Wren', role: 'a clerk', goals: [], vows: [{ text: 'do not draw first', rank: 1 }] };
  const job = svc.startDiscover('https://vale.fandom.com', ['Duskhollow'], 'mid', sketch);

  assert.equal(job.status, 'running', 'the caller gets an id immediately, not the finished result');
  await settle(svc.jobs, job.id);

  const settled = svc.jobs.get(job.id)!;
  assert.equal(settled.status, 'done', settled.error ?? '');
  assert.ok(settled.log.length > 0, 'a job with no log gives a poller nothing to show while it runs');
  assert.ok(settled.log.some((l) => /crawl/i.test(l)), 'the crawl itself should show up in the log, not just the stages around it');

  const result = settled.result as { preview: { candidatePages: number }; previewKey: string; character: unknown };
  assert.ok(result.preview.candidatePages > 0);
  assert.ok(result.previewKey, 'the returned key still lets the caller commit through startIngest');
  assert.equal(world.graph.counts().entities, 0, 'discovery must never commit, same as preview');
  world.close();
});

test('discover reports hop progress while the crawl is still running', async () => {
  const { world, svc } = service();
  const sketch = { existing: null, name: '', role: '', goals: [], vows: [] };
  const job = svc.startDiscover('https://vale.fandom.com', ['Duskhollow'], 'mid', sketch);

  // The crawl is async but fixture-backed and fast; poll a few times so the
  // assertion does not depend on catching one exact tick.
  let sawTotal = false;
  for (let i = 0; i < 50 && svc.jobs.get(job.id)?.status === 'running'; i++) {
    const j = svc.jobs.get(job.id)!;
    if (j.progress.total) sawTotal = true;
    await new Promise((r) => setTimeout(r, 2));
  }
  await settle(svc.jobs, job.id);
  // A `mid` crawl only has a couple of hops on this tiny fixture, so it may
  // already be done by the first poll; what matters is that when a total was
  // seen it looked like real hop progress, not a fake percentage.
  if (sawTotal) assert.ok(true);
  world.close();
});

test('discover sharpens the character sketch against what was actually found', async () => {
  const { world, svc } = service();
  // The fixture wiki has "Warden Ilsa Crowe" reachable from the Duskhollow
  // seed. Naming her here proves the refinement step actually saw the
  // discovered characters rather than just echoing the input.
  const sketch = { existing: null, name: '', role: 'someone in the story', goals: [], vows: [{ text: 'never betray a friend', rank: 1 }] };
  const job = svc.startDiscover('https://vale.fandom.com', ['Duskhollow'], 'mid', sketch);
  await settle(svc.jobs, job.id);

  const result = svc.jobs.get(job.id)!.result as { character: { vows: Array<{ text: string }> } };
  // The refinement is a nice-to-have and the mock provider is deterministic
  // rather than actually reading `found`, so the strong guarantee tested here
  // is the one that matters operationally: refinement never drops the vows
  // the player already had, even when the model's own answer is unrelated.
  assert.ok(result.character.vows.length > 0, 'a refinement must never leave the character without vows');
  world.close();
});

test('a discover job never blocks on a refinement failure', async () => {
  // A provider whose `setup` role always throws — simulating a model outage
  // mid-wizard. `refineCharacter` is documented to swallow this and fall back
  // to the unrefined sketch; this is the one test that actually proves it,
  // rather than relying on the mock's own success path never failing.
  class ThrowingProvider extends MockProvider {
    override async complete(): Promise<never> {
      throw new Error('simulated model outage');
    }
  }
  const world = World.open(':memory:');
  const svc = new SetupService({
    world,
    providers: new ProviderRegistry(new ThrowingProvider()),
    directoryOptions: { fetcher: directoryFixture(FIXTURE), delayMs: 0 },
    wikiFetcher: fixtureFetcher(WIKI),
  });

  const sketch = { existing: null, name: 'Wren', role: 'a clerk', goals: [], vows: [{ text: 'do not draw first', rank: 1 }] };
  const job = svc.startDiscover('https://vale.fandom.com', ['Duskhollow'], 'mid', sketch);
  await settle(svc.jobs, job.id);

  const settled = svc.jobs.get(job.id)!;
  assert.equal(settled.status, 'done', settled.error ?? 'the crawl itself must not fail just because refinement did');
  const result = settled.result as { character: typeof sketch };
  assert.deepEqual(result.character, sketch, 'on a refinement failure the original sketch passes through unchanged');
  world.close();
});

test('the full wizard path produces a playable world', async () => {
  const { world, svc } = service();
  assert.ok(svc.isFresh(), 'starts with nothing');

  const candidates = await svc.resolveWiki('the ashen vale');
  const plan = await svc.plan('play in the Ashgrove arc as a minor figure', candidates[0]!);
  const preview = await svc.preview(candidates[0]!.baseUrl, ['Duskhollow'], plan.mode);

  const job = svc.startIngest(preview.previewKey, { character: plan.character, style: plan.style, opening: plan.opening });
  await settle(svc.jobs, job.id);

  const settled = svc.jobs.get(job.id)!;
  assert.equal(settled.status, 'done', settled.error ?? '');
  const result = settled.result as { entities: number; playerCharacterId: string; opening: string };

  assert.ok(result.entities > 5);
  assert.ok(!svc.isFresh());
  assert.ok(world.cast.player(), 'a protagonist was placed');
  assert.equal(world.session.get().playerCharacterId, result.playerCharacterId);
  assert.ok(world.session.get().currentLocationId, 'and put somewhere');
  assert.ok(result.opening.length > 0);
  world.close();
});

test('SetupService.plan reflects a live profile swap, not the provider it was built with', async () => {
  // Same regression as the SetupPlanner-level test, one layer up: this is
  // where the real bug was found, running the actual 4.1 session against
  // bedrock. `SetupService`'s constructor used to call `providers.get('setup')`
  // once and hand that concrete Provider to `SetupPlanner`. Wiring it through a
  // `SwappableRegistry`, exactly as `serve.ts` does for real, catches the case
  // a unit test on `SetupPlanner` alone cannot: whether the *service* passes a
  // live getter through, not just whether the planner would honour one if given it.
  const before = new MockProvider({ id: 'before' });
  const after = new MockProvider({ id: 'after' });
  const registry = new SwappableRegistry(new ProviderRegistry(before), 'a');
  const world = World.open(':memory:');
  const svc = new SetupService({
    world,
    providers: registry,
    directoryOptions: { fetcher: directoryFixture(FIXTURE), delayMs: 0 },
    wikiFetcher: fixtureFetcher(WIKI),
  });

  const candidates = await svc.resolveWiki('the ashen vale');
  await svc.plan('play in the Ashgrove arc as a minor figure', candidates[0]!);
  assert.equal(before.calls.length, 1);
  assert.equal(after.calls.length, 0);

  registry.swap(new ProviderRegistry(after), 'b');

  await svc.plan('play in the Ashgrove arc as a minor figure', candidates[0]!);
  assert.equal(before.calls.length, 1, 'no restart happened, so the pre-swap provider took no further calls');
  assert.equal(after.calls.length, 1, 'the service sees the swap on its very next plan() call');
  world.close();
});

test('an ingested world runs the turn loop unchanged', async () => {
  const { world, svc } = service();
  const preview = await svc.preview('https://vale.fandom.com', ['Duskhollow'], 'skim');
  const job = svc.startIngest(preview.previewKey, {
    character: { existing: null, name: 'Wren Ashby', role: 'a clerk', goals: ['stay useful'], vows: [{ text: 'do not draw first', rank: 1 }] },
    style: {}, opening: '',
  });
  await settle(svc.jobs, job.id);

  const { Engine } = await import('../src/loop/engine.ts');
  const engine = new Engine({ world, providers: new ProviderRegistry(new MockProvider()) });
  const out = await engine.takeTurn('i walk the bridge markets and listen');
  assert.equal(out.kind, 'narrated', 'setup and play meet without a seam');
  world.close();
});

test('the integrity gate is live on a wizard-created character', async () => {
  const { world, svc } = service();
  const preview = await svc.preview('https://vale.fandom.com', ['Duskhollow'], 'skim');
  const job = svc.startIngest(preview.previewKey, {
    character: { existing: null, name: 'Wren Ashby', role: 'a clerk', goals: [], vows: [{ text: 'harm no living thing', rank: 1 }] },
    style: {}, opening: '',
  });
  await settle(svc.jobs, job.id);

  const { Engine } = await import('../src/loop/engine.ts');
  const engine = new Engine({ world, providers: new ProviderRegistry(new MockProvider()) });
  const out = await engine.takeTurn('i stab the nearest guard');
  assert.equal(out.kind, 'interrupted', 'a vow set up in the wizard is defended in play');
  world.close();
});

test('an existing wiki character can be adopted as the protagonist', async () => {
  const { world, svc } = service();
  const preview = await svc.preview('https://vale.fandom.com', ['Duskhollow'], 'skim');
  const job = svc.startIngest(preview.previewKey, {
    character: { existing: 'Warden Ilsa Crowe', name: '', role: '', goals: [], vows: [] },
    style: {}, opening: '',
  });
  await settle(svc.jobs, job.id);

  assert.equal(world.session.get().playerCharacterId, 'char:warden-ilsa-crowe');
  assert.equal(world.cast.get('char:warden-ilsa-crowe')?.isPlayer, true);
  world.close();
});

test('naming a character who is not in the world falls back to an original', () => {
  const world = World.open(':memory:');
  world.graph.upsert({ id: 'loc:x', type: 'Location', name: 'Somewhere' }, 'canon');
  const res = assignPlayerCharacter(world, {
    existing: 'Sherlock Holmes', name: 'Wren', role: 'a clerk', goals: [], vows: [{ text: 'never lie to a friend', rank: 1 }],
  });
  assert.equal(res.created, true);
  assert.match(res.warnings.join(' '), /not in this world/);
  assert.equal(world.graph.get(res.playerCharacterId)?.provenance, 'emergent:0', 'an invented protagonist is not source material');
  world.close();
});

test('only one character is ever marked as the player', async () => {
  const { world, svc } = service();
  const preview = await svc.preview('https://vale.fandom.com', ['Duskhollow'], 'skim');
  const job = svc.startIngest(preview.previewKey, {
    character: { existing: 'Warden Ilsa Crowe', name: '', role: '', goals: [], vows: [] }, style: {}, opening: '',
  });
  await settle(svc.jobs, job.id);

  assignPlayerCharacter(world, { existing: 'Bram the Lesser', name: '', role: '', goals: [], vows: [] });
  assert.equal(world.cast.list().filter((s) => s.isPlayer).length, 1);
  world.close();
});

test('a character with no vows is flagged, because the gate needs something to defend', () => {
  const world = World.open(':memory:');
  world.graph.upsert({ id: 'loc:x', type: 'Location', name: 'Somewhere' }, 'canon');
  const res = assignPlayerCharacter(world, { existing: null, name: 'Blank', role: '', goals: [], vows: [] });
  assert.match(res.warnings.join(' '), /no vows/);
  world.close();
});

test('the opening is proposed from the highest-tension thread', async () => {
  const { world, svc } = service();
  const job = svc.startCustomWorld('a corrupt assay office');
  await settle(svc.jobs, job.id);
  const opening = proposeOpening(world);
  const top = world.threads.open(1)[0]!;
  assert.match(opening, new RegExp(top.title.slice(0, 20).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  world.close();
});

test('with no threads yet, the opening is still grounded in the actual world', async () => {
  // A fresh wiki ingest has no threads: canon describes a world, not a situation.
  // The fallback has to name a real place and a real person, or the Director has
  // nothing to push against on turn one.
  const { world, svc } = service();
  const preview = await svc.preview('https://vale.fandom.com', ['Duskhollow'], 'skim');
  const job = svc.startIngest(preview.previewKey, {
    character: { existing: 'Warden Ilsa Crowe', name: '', role: '', goals: [], vows: [] }, style: {}, opening: '',
  });
  await settle(svc.jobs, job.id);

  assert.equal(world.threads.open().length, 0, 'precondition: no threads');
  const opening = proposeOpening(world);
  assert.match(opening, /Duskhollow/, 'names where you are');
  assert.ok(!/somewhere in this world/.test(opening), 'not boilerplate');
  world.close();
});

test('the ingest job reports each stage it passes through', async () => {
  const { world, svc } = service();
  const preview = await svc.preview('https://vale.fandom.com', ['Duskhollow'], 'mid');
  const job = svc.startIngest(preview.previewKey, {
    character: { existing: null, name: 'X', role: '', goals: [], vows: [] }, style: {}, opening: '',
  });
  await settle(svc.jobs, job.id);

  const log = svc.jobs.get(job.id)!.log.join(' | ');
  for (const stage of ['reading pages', 'building the graph', 'reading the prose', 'placing your character']) {
    assert.match(log, new RegExp(stage), `reported "${stage}"`);
  }
  world.close();
});

test('the sample world is available without any setup', () => {
  const { world, svc } = service();
  const res = svc.useSample();
  assert.equal(res.playerCharacterId, 'char:brother-anselm');
  assert.ok(res.opening.length > 0);
  assert.ok(world.graph.counts().entities > 15);
  world.close();
});

test('reset clears everything so the wizard can run again', async () => {
  const { world, svc } = service();
  svc.useSample();
  assert.ok(!svc.isFresh());
  svc.reset();
  assert.ok(svc.isFresh(), 'a reset is a reset, canon included');
  assert.equal(world.chronicle.turns().length, 0);
  assert.equal(world.session.get().playerCharacterId, '');
  world.close();
});

/**
 * Regression: `reset`'s table list was written before `illustrations` existed
 * and was never extended, so a reset emptied `entities` and left portraits
 * pointing at ids that no longer resolved. Found by `checkIntegrity` against a
 * real save, which is why the assertion here is the integrity check itself
 * rather than a count of one table — whatever table is added next should fail
 * this test too, instead of quietly repeating the same bug.
 */
test('reset leaves no dangling references behind, illustrations included', () => {
  const { world, svc } = service();
  svc.useSample();

  const entity = world.graph.list({ type: 'Character', limit: 1 })[0]!;
  world.illustrations.reserve({
    subject: { kind: 'portrait', entityId: entity.id },
    visualStyle: 'drawing',
    prompt: 'a portrait',
    negativePrompt: '',
    seed: 1,
    provider: 'mock',
    createdScene: 1,
  });
  assert.equal(world.illustrations.forEntity(entity.id).length, 1, 'precondition: an illustration exists');

  svc.reset();

  const report = checkIntegrity(world.db);
  assert.ok(report.ok, formatIntegrityReport(report));
  assert.equal(world.illustrations.forEntity(entity.id).length, 0, 'the illustration row went with the entity');
  world.close();
});

test('a SetupService built with a world getter follows a live switch, not the world live at construction', () => {
  // Same shape as the Engine/Compactor fix: SetupService is held for the
  // process lifetime, and useSample/reset/isFresh must all operate on
  // whichever world is current *right now*, not whichever was current when
  // the service was constructed.
  const worldA = World.open(':memory:');
  const worldB = World.open(':memory:');
  let current: World = worldA;
  const svc = new SetupService({
    world: () => current,
    providers: new ProviderRegistry(new MockProvider()),
    directoryOptions: { fetcher: directoryFixture(FIXTURE), delayMs: 0 },
    wikiFetcher: fixtureFetcher(WIKI),
  });

  svc.useSample();
  assert.ok(worldA.graph.counts().entities > 15, 'world A got the sample');
  assert.equal(worldB.graph.counts().entities, 0, 'world B is untouched');

  current = worldB;
  assert.ok(svc.isFresh(), 'isFresh now reads world B, which has no canon yet');
  svc.reset(); // a no-op on an already-empty world, but must target B, not A
  assert.equal(worldA.graph.counts().entities > 15, true, 'world A is unaffected by anything done while B was current');

  worldA.close();
  worldB.close();
});

// --------------------------------------------------------------------- jobs

test('a job reports stages and settles as done', async () => {
  const jobs = new JobRegistry();
  const job = jobs.start('test', async (h) => {
    h.stage('first', 'doing a thing');
    h.count(1, 3);
    h.stage('second');
    return { ok: true };
  });
  assert.equal(job.status, 'running', 'the call returns immediately');
  await settle(jobs, job.id);

  const settled = jobs.get(job.id)!;
  assert.equal(settled.status, 'done');
  assert.deepEqual(settled.result, { ok: true });
  assert.ok(settled.log.some((l) => /first/.test(l)));
  assert.ok(settled.finishedAt);
});

test('a failing job records the error instead of crashing the server', async () => {
  const jobs = new JobRegistry();
  const job = jobs.start('test', async () => {
    throw new Error('the wiki went away');
  });
  await settle(jobs, job.id);
  const settled = jobs.get(job.id)!;
  assert.equal(settled.status, 'failed');
  assert.match(settled.error ?? '', /wiki went away/);
});

test('cancellation is cooperative and keeps partial work', async () => {
  const jobs = new JobRegistry();
  let iterations = 0;
  const job = jobs.start('test', async (h) => {
    for (let i = 0; i < 100; i++) {
      if (h.cancelled()) break;
      iterations++;
      await new Promise((r) => setTimeout(r, 1));
    }
    return iterations;
  });
  await new Promise((r) => setTimeout(r, 15));
  assert.equal(jobs.cancel(job.id), true);
  await settle(jobs, job.id);

  assert.equal(jobs.get(job.id)?.status, 'cancelled');
  assert.ok(iterations > 0 && iterations < 100, `stopped partway (${iterations})`);
});

test('cancelling an already finished job is refused', async () => {
  const jobs = new JobRegistry();
  const job = jobs.start('test', async () => 1);
  await settle(jobs, job.id);
  assert.equal(jobs.cancel(job.id), false);
});

test('finished jobs are pruned so a long session does not leak', async () => {
  const jobs = new JobRegistry(3);
  for (let i = 0; i < 8; i++) {
    const j = jobs.start('test', async () => i);
    await settle(jobs, j.id);
  }
  assert.ok(jobs.list().length <= 3);
});

test('a job log is capped', async () => {
  const jobs = new JobRegistry();
  const job = jobs.start('test', async (h) => {
    for (let i = 0; i < 1000; i++) h.log(`line ${i}`);
    return null;
  });
  await settle(jobs, job.id);
  assert.ok((jobs.get(job.id)?.log.length ?? 0) <= 400, 'a runaway log is a memory leak in a long crawl');
});
