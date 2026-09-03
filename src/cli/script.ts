#!/usr/bin/env node
/**
 * Scripted session runner. See DESIGN.md §13.
 *
 * Replays a fixed list of turns without a TTY. Two uses: a non-interactive
 * smoke test, and the provider conformance suite — the same script run against
 * each configured provider should end with the same graph state. Prose will
 * differ between providers; the state must not.
 */
import { readFileSync } from 'node:fs';
import { World } from '../store/index.ts';
import { seedWorld } from '../seed/verrow.ts';
import { Engine } from '../loop/engine.ts';
import { buildRegistry, loadConfig } from '../config/config.ts';
import { makeProseGate } from '../lint/gate.ts';
import { seedConsequences, tickConsequences, worldTick } from '../consequence/propagate.ts';

export interface ScriptResult {
  turns: number;
  narrated: number;
  interrupted: number;
  blocked: number;
  answered: number;
  /** Fingerprint of final world state, for cross-provider comparison. */
  fingerprint: {
    entities: number;
    edges: number;
    events: number;
    facts: number;
    threads: number;
    brokenVows: string[];
    scene: number;
  };
  transcript: Array<{ input: string; kind: string; prose?: string; note?: string }>;
}

export async function runScript(
  lines: string[],
  opts: { world?: World; overrideOnInterrupt?: boolean; quiet?: boolean } = {},
): Promise<ScriptResult> {
  const cfg = loadConfig();
  const world = opts.world ?? World.open(':memory:');
  if (world.graph.counts().entities === 0) seedWorld(world);

  const { registry } = buildRegistry(cfg);
  const engine = new Engine({
    world,
    providers: registry,
    proseGate: makeProseGate({ threshold: cfg.proseLintThreshold, blocklist: cfg.blocklist }),
  });

  const result: ScriptResult = {
    turns: 0, narrated: 0, interrupted: 0, blocked: 0, answered: 0,
    fingerprint: { entities: 0, edges: 0, events: 0, facts: 0, threads: 0, brokenVows: [], scene: 1 },
    transcript: [],
  };

  for (const raw of lines) {
    const input = raw.trim();
    if (!input || input.startsWith('#')) continue;
    result.turns++;

    // A leading `!` means: play it even if the integrity gate objects. That is
    // how a script expresses a deliberate vow break.
    const override = input.startsWith('!');
    const text = override ? input.slice(1).trim() : input;

    const outcome = await engine.takeTurn(text, { overrideIntegrity: override || opts.overrideOnInterrupt });

    switch (outcome.kind) {
      case 'narrated': {
        result.narrated++;
        seedConsequences(world, outcome.delta, outcome.commit.events);
        tickConsequences(world);
        worldTick(world);
        result.transcript.push({ input: text, kind: 'narrated', prose: outcome.prose });
        if (!opts.quiet) console.log(`\n> ${text}\n${outcome.prose}`);
        break;
      }
      case 'interrupted':
        result.interrupted++;
        result.transcript.push({ input: text, kind: 'interrupted', note: outcome.interrupt.message });
        if (!opts.quiet) console.log(`\n> ${text}\n[gate: ${outcome.distance}] ${outcome.interrupt.message}`);
        break;
      case 'blocked':
        result.blocked++;
        result.transcript.push({ input: text, kind: 'blocked', note: outcome.reason });
        if (!opts.quiet) console.log(`\n> ${text}\n[blocked] ${outcome.reason}`);
        break;
      case 'answered':
        result.answered++;
        result.transcript.push({ input: text, kind: 'answered', note: outcome.text });
        if (!opts.quiet) console.log(`\n> ${text}\n${outcome.text}`);
        break;
    }
  }

  const counts = world.graph.counts();
  result.fingerprint = {
    entities: counts.entities,
    edges: counts.edges,
    events: world.chronicle.events({ limit: 5000 }).length,
    facts: world.chronicle.facts(5000).length,
    threads: world.threads.all().length,
    brokenVows: world.cast
      .list()
      .flatMap((s) => s.contract.vows.filter((v) => v.broken).map((v) => `${s.entityId}:${v.id}`))
      .sort(),
    scene: world.session.get().scene,
  };

  if (!opts.world) world.close();
  return result;
}

if (process.argv[1]?.endsWith('script.ts')) {
  const file = process.argv.slice(2).find((a) => !a.startsWith('--'));
  const text = file ? readFileSync(file, 'utf8') : readFileSync(0, 'utf8');
  const res = await runScript(text.split('\n'));
  console.log(`\n--- ${res.narrated}/${res.turns} narrated, ${res.interrupted} interrupted, ${res.blocked} blocked`);
  console.log(`--- fingerprint ${JSON.stringify(res.fingerprint)}`);
}
