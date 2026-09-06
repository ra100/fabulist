#!/usr/bin/env node
/**
 * Interactive play loop. The fastest way to find out whether any of this is
 * actually enjoyable, which is the only test that matters for Slice 0.
 */
import { createInterface } from 'node:readline/promises';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { stdin, stdout } from 'node:process';
import { World } from '../store/index.ts';
import { seedWorld } from '../seed/verrow.ts';
import { Engine, type TurnOutcome } from '../loop/engine.ts';
import { loadConfig, buildRegistry } from '../config/config.ts';
import { seedConsequences, tickConsequences, worldTick } from '../consequence/propagate.ts';
import { makeProseGate } from '../lint/gate.ts';

const DIM = '\x1b[2m';
const BOLD = '\x1b[1m';
const YELLOW = '\x1b[33m';
const CYAN = '\x1b[36m';
const RESET = '\x1b[0m';

const HELP = `
${BOLD}commands${RESET}
  /help                 this list
  /look                 where you are and who is present
  /sheet [name]         a character sheet
  /threads              open threads by tension
  /facts                what is known, and by whom
  /queue                pending and fired consequences
  /why                  the frame, move, and verdicts behind the last turn
  /direct <text>        steer the story, with the recalculation shown
  /style <k>=<v>        change the style contract
  /knob <k>=<v>         change a knob
  /pin                  keep the last passage from being re-rendered
  /anchor <text>        add a style anchor
  /tick                 advance the offscreen world a step
  /scene                close the current scene and summarise it
  /compact              summarise any scene that closed unsummarised
  /branch <n> <file>    fork the save at scene n, leaving this one intact
  /save                 flush to disk
  /quit
Anything else is played as your character.
`;

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const fresh = args.includes('--fresh');
  const inMemory = args.includes('--memory');
  const cfg = loadConfig();
  const dbPath = inMemory ? ':memory:' : cfg.dbPath;

  if (!inMemory) mkdirSync(dirname(dbPath), { recursive: true });
  const world = World.open(dbPath);

  if (fresh || world.graph.counts().entities === 0) {
    seedWorld(world);
    console.log(`${DIM}seeded Saint Verrow${RESET}`);
  }

  const { registry, notes } = buildRegistry(cfg);
  for (const n of notes) console.log(`${DIM}${n}${RESET}`);

  const engine = new Engine({
    world,
    providers: registry,
    proseGate: makeProseGate({ threshold: cfg.proseLintThreshold, blocklist: cfg.blocklist }),
  });

  const rl = createInterface({ input: stdin, output: stdout });
  console.log(`\n${BOLD}Saint Verrow${RESET} ${DIM}/help for commands${RESET}`);
  look(world);

  for (;;) {
    const s = world.session.get();
    const line = (await rl.question(`\n${CYAN}[s${s.scene}t${s.turn}]${RESET} `)).trim();
    if (!line) continue;

    if (line.startsWith('/')) {
      const [cmd, ...rest] = line.slice(1).split(/\s+/);
      const arg = rest.join(' ');
      if (cmd === 'quit' || cmd === 'q') break;
      if (!(await command(cmd ?? '', arg, world, engine))) console.log(`${DIM}unknown command${RESET}`);
      continue;
    }

    await play(line, world, engine, rl);
  }

  rl.close();
  world.close();
  console.log(`${DIM}saved${RESET}`);
}

async function play(
  input: string,
  world: World,
  engine: Engine,
  rl: ReturnType<typeof createInterface>,
  overrideIntegrity = false,
): Promise<void> {
  let outcome: TurnOutcome;
  try {
    outcome = await engine.takeTurn(input, { overrideIntegrity });
  } catch (err) {
    console.log(`${YELLOW}the turn failed: ${err instanceof Error ? err.message : String(err)}${RESET}`);
    return;
  }

  if (outcome.kind === 'answered') {
    console.log(`\n${DIM}${outcome.text}${RESET}`);
    return;
  }

  if (outcome.kind === 'interrupted') {
    // The interrupt is a conversation, not a rejection.
    console.log(`\n${YELLOW}${outcome.interrupt.message}${RESET}\n`);
    for (const o of outcome.interrupt.options) console.log(`  ${BOLD}${o.key}${RESET}  ${o.label}`);
    const choice = (await rl.question('\nwhich? ')).trim().toLowerCase();
    const picked = outcome.interrupt.options.find((o) => o.key === choice);
    if (!picked || picked.effect === 'revise' || picked.effect === 'switch-character') {
      console.log(`${DIM}nothing written. try again.${RESET}`);
      return;
    }
    // Both 'override' and 'establish-break' proceed; the difference is that the
    // author has now chosen it deliberately, which is what makes it story.
    await play(input, world, engine, rl, true);
    return;
  }

  if (outcome.kind === 'blocked') {
    console.log(`${YELLOW}the world model refused that: ${outcome.reason}${RESET}`);
    for (const i of outcome.validation.issues.filter((x) => !x.repaired)) {
      console.log(`  ${DIM}${i.tier}: ${i.message}${RESET}`);
    }
    return;
  }

  console.log(`\n${outcome.prose}\n`);

  const seeded = seedConsequences(world, outcome.delta, outcome.commit.events);
  const tick = tickConsequences(world);
  worldTick(world);

  const notes: string[] = [];
  if (outcome.commit.brokenVows.length) {
    notes.push(`vow broken: ${outcome.commit.brokenVows.map((v) => v.text).join('; ')}`);
  }
  if (seeded.length) notes.push(`${seeded.length} consequence${seeded.length === 1 ? '' : 's'} set in motion`);
  const onscreen = tick.fired.filter((f) => f.consequence.visibility === 'onscreen');
  if (onscreen.length) notes.push(`arriving: ${onscreen.map((f) => f.event.text).join(' ')}`);
  if (tick.transmissions.length) notes.push(`${tick.transmissions.length} rumour(s) travelled`);
  if (outcome.turn.meta.lint?.tripped) notes.push(`prose lint: ${outcome.turn.meta.lint.findings.length} finding(s)`);
  if (notes.length) console.log(`${DIM}${notes.join(' | ')}${RESET}`);
}

async function command(cmd: string, arg: string, world: World, engine: Engine): Promise<boolean> {
  switch (cmd) {
    case 'help':
      console.log(HELP);
      return true;
    case 'look':
      look(world);
      return true;
    case 'sheet': {
      const s = world.session.get();
      const id = arg ? world.graph.resolveName(arg)?.id : s.playerCharacterId;
      if (!id) {
        console.log(`${DIM}no such character${RESET}`);
        return true;
      }
      const sheet = world.cast.get(id);
      const e = world.graph.get(id);
      if (!sheet || !e) {
        console.log(`${DIM}no sheet${RESET}`);
        return true;
      }
      console.log(`\n${BOLD}${e.name}${RESET} ${DIM}${e.id}${RESET}\n${e.summary}`);
      if (sheet.contract.vows.length) {
        console.log(`\n${BOLD}vows${RESET}`);
        for (const v of [...sheet.contract.vows].sort((a, b) => a.rank - b.rank)) {
          console.log(`  ${v.broken ? `${YELLOW}[broken]${RESET}` : '[held]  '} r${v.rank} ${v.text}`);
        }
      }
      if (sheet.identity.goals.length) console.log(`\ngoals: ${sheet.identity.goals.join('; ')}`);
      if (sheet.identity.secrets.length) console.log(`secrets: ${sheet.identity.secrets.join('; ')}`);
      const c = sheet.condition;
      console.log(`\nat ${world.graph.get(c.locationId ?? '')?.name ?? 'nowhere'}, ${c.mood || 'unreadable'}`);
      if (c.intent) console.log(`intent: ${c.intent}`);
      if (sheet.locks.length) console.log(`${DIM}locked: ${sheet.locks.join(', ')}${RESET}`);
      return true;
    }
    case 'threads': {
      console.log('');
      for (const t of world.threads.open(12)) {
        console.log(`  ${bar(t.tension)} ${t.title}`);
        console.log(`     ${DIM}${t.stakes} → ${t.resolutions.join(' / ')}${RESET}`);
      }
      return true;
    }
    case 'facts': {
      console.log('');
      for (const f of world.chronicle.facts(20)) {
        const knowers = world.chronicle.knowersOf(f.id);
        const names = knowers
          .map((k) => `${world.graph.get(k.entityId)?.name ?? k.entityId}${k.level === 'knows' ? '' : `(${k.level})`}`)
          .join(', ');
        console.log(`  ${f.text}\n     ${DIM}${names || 'nobody'}${RESET}`);
      }
      return true;
    }
    case 'queue': {
      const all = world.consequences.all(30);
      if (!all.length) console.log(`${DIM}nothing in motion${RESET}`);
      for (const c of all) {
        const who = world.graph.get(c.actorId)?.name ?? c.actorId;
        console.log(`  ${c.maturity.padEnd(10)} d${c.depth} ${DIM}${c.visibility}${RESET} ${who} ${c.action}`);
      }
      return true;
    }
    case 'why': {
      const last = world.chronicle.recentTurns(1)[0];
      if (!last) {
        console.log(`${DIM}nothing played yet${RESET}`);
        return true;
      }
      const m = last.meta;
      console.log(`\n${BOLD}why${RESET}`);
      console.log(`  move: ${m.move ?? 'none'}`);
      console.log(`  integrity: ${m.integrity?.distance ?? 'skipped'} ${DIM}${m.integrity?.reasoning ?? ''}${RESET}`);
      console.log(`  referee: ${m.referee?.ruling ?? 'none'} ${DIM}${m.referee?.reasoning ?? ''}${RESET}`);
      if (m.lint) console.log(`  lint: score ${m.lint.score.toFixed(1)} ${m.lint.findings.map((f) => f.rule).join(', ')}`);
      for (const [role, frame] of Object.entries(engine.lastFrames)) {
        const l = frame.log;
        console.log(`  frame:${role} ${l.used}/${l.budget} tokens${l.evicted.length ? ` evicted ${l.evicted.join(',')}` : ''}`);
      }
      console.log(`  calls: ${m.providerCalls.map((c) => `${c.role}=${c.tokensIn}in/${c.tokensOut}out`).join(' ')}`);
      return true;
    }
    case 'direct': {
      if (!arg) return true;
      const { applyDirectiveRecalc } = await import('../consequence/propagate.ts');
      const d = world.directives.create({
        text: arg,
        scope: 'chapter',
        strength: 'push',
        lifetimeScenes: 5,
        status: 'active',
        createdScene: world.session.get().scene,
      });
      const diff = applyDirectiveRecalc(world, d.id, d.text);
      console.log(`\n${DIM}recalculated:${RESET}`);
      console.log(`  raised: ${diff.raisedThreads.map((id) => world.threads.get(id)?.title ?? id).join('; ') || 'none'}`);
      console.log(`  lowered: ${diff.loweredThreads.length}`);
      console.log(`  superseded: ${diff.supersededConsequences.length}, retimed: ${diff.retimedConsequences.length}`);
      return true;
    }
    case 'style': {
      const [k, v] = arg.split('=').map((x) => x.trim());
      if (!k || v === undefined) {
        console.log(JSON.stringify(world.session.get().style, null, 2));
        return true;
      }
      const style = { ...world.session.get().style } as Record<string, unknown>;
      style[k] = /^[\d.]+$/.test(v) ? Number(v) : v.includes(',') ? v.split(',').map((x) => x.trim()) : v;
      world.session.set({ style: style as never });
      console.log(`${DIM}${k} = ${v}${RESET}`);
      return true;
    }
    case 'knob': {
      const [k, v] = arg.split('=').map((x) => x.trim());
      if (!k || v === undefined) {
        console.log(JSON.stringify(world.session.get().knobs, null, 2));
        return true;
      }
      const knobs = { ...world.session.get().knobs } as Record<string, unknown>;
      knobs[k] = /^[\d.]+$/.test(v) ? Number(v) : v;
      world.session.set({ knobs: knobs as never });
      console.log(`${DIM}${k} = ${v}${RESET}`);
      return true;
    }
    case 'pin': {
      const last = world.chronicle.recentTurns(1)[0];
      if (!last) return true;
      world.chronicle.setPinned(last.id, true);
      world.chronicle.addAnchor(last.bookProse.slice(0, 300), 'pinned by the author', world.session.get().scene);
      console.log(`${DIM}pinned, and kept as a style anchor${RESET}`);
      return true;
    }
    case 'anchor': {
      if (!arg) return true;
      world.chronicle.addAnchor(arg, 'manual', world.session.get().scene);
      console.log(`${DIM}anchor added${RESET}`);
      return true;
    }
    case 'scene': {
      const s = world.session.get();
      const res = await engine.compaction().onSceneClosed(s.scene);
      world.session.set({ scene: s.scene + 1, turn: 0 });
      world.chronicle.upsertScene(s.scene + 1, { chapter: engine.compaction().chapterOf(s.scene + 1) });
      console.log(`${DIM}scene ${s.scene} closed${res.scenesSummarised.length ? ' and summarised' : ''}${res.chaptersSummarised.length ? `, chapter ${res.chaptersSummarised[0]} rolled up` : ''}. now scene ${s.scene + 1}.${RESET}`);
      const summary = world.chronicle.scenes().find((x) => x.scene === s.scene)?.summary;
      if (summary) console.log(`  ${DIM}${summary}${RESET}`);
      return true;
    }
    case 'compact': {
      const res = await engine.compaction().backfill(world.session.get().scene);
      console.log(`${DIM}summarised ${res.scenesSummarised.length} scene(s), ${res.chaptersSummarised.length} chapter(s)${RESET}`);
      return true;
    }
    case 'branch': {
      const [sceneArg, ...rest] = arg.split(/\s+/);
      const atScene = Number(sceneArg);
      const toPath = rest.join(' ');
      if (!atScene || !toPath) {
        console.log(`${DIM}usage: /branch <scene> <file>${RESET}`);
        return true;
      }
      const { branchSave } = await import('../loop/branch.ts');
      const row = world.db.prepare(`PRAGMA database_list`).get() as { file?: string } | undefined;
      if (!row?.file) {
        console.log(`${YELLOW}cannot branch an in-memory session${RESET}`);
        return true;
      }
      try {
        const res = branchSave({ fromPath: row.file, toPath, atScene });
        console.log(`${DIM}branched at scene ${atScene} -> ${res.path}${RESET}`);
        console.log(`  ${DIM}discarded ${res.removed.turns} turn(s), ${res.removed.events} event(s), ${res.removed.consequences} consequence(s); restored ${res.removed.retiredEdgesRestored} relation(s)${RESET}`);
        console.log(`  ${DIM}this session is untouched${RESET}`);
      } catch (err) {
        console.log(`${YELLOW}${err instanceof Error ? err.message : String(err)}${RESET}`);
      }
      return true;
    }
    case 'tick': {
      const tick = tickConsequences(world);
      const notes = worldTick(world);
      console.log(`${DIM}fired ${tick.fired.length}, ripened ${tick.ripened.length}, rumours ${tick.transmissions.length}${RESET}`);
      for (const n of notes) console.log(`  ${DIM}${n}${RESET}`);
      return true;
    }
    case 'save':
      console.log(`${DIM}sqlite writes as it goes; nothing to flush${RESET}`);
      return true;
    default:
      return false;
  }
}

function look(world: World): void {
  const s = world.session.get();
  const loc = s.currentLocationId ? world.graph.get(s.currentLocationId) : undefined;
  console.log(`\n${BOLD}${loc?.name ?? 'nowhere'}${RESET} ${DIM}scene ${s.scene}${RESET}`);
  if (loc?.summary) console.log(loc.summary);
  const present = world.cast
    .list()
    .filter((sh) => sh.condition.locationId === s.currentLocationId && sh.entityId !== s.playerCharacterId);
  if (present.length) {
    console.log(
      `${DIM}present: ${present.map((p) => world.graph.get(p.entityId)?.name ?? p.entityId).join(', ')}${RESET}`,
    );
  }
}

function bar(v: number): string {
  const n = Math.round(v * 10);
  return `${'█'.repeat(n)}${'·'.repeat(10 - n)}`;
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
