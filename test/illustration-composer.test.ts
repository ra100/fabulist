/**
 * Prompt composer tests. Pure functions, no DB, no provider — same discipline
 * the composer itself follows (see `composer.ts`'s file comment).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  composePortraitPrompt,
  composeScenePrompt,
  locationAnchor,
  STYLE_FRAGMENTS,
} from '../src/illustration/composer.ts';
import { defaultStyleContract, type CharacterSheet, type Entity } from '../src/domain/types.ts';
import { emptyAppearance, emptyCondition, emptyContract, emptyIdentity, emptyVoice } from '../src/store/cast.ts';

function entity(over: Partial<Entity> = {}): Entity {
  return {
    id: 'char:test', type: 'Character', layer: 'canon', name: 'Test',
    summary: '', provenance: 'authored', confidence: 1, salience: 0.5,
    depthLevel: 0, props: {}, createdScene: 0, ...over,
  };
}

function sheet(over: Partial<CharacterSheet> = {}): CharacterSheet {
  return {
    entityId: 'char:test', identity: emptyIdentity(), contract: emptyContract(),
    voice: emptyVoice(), condition: emptyCondition(), appearance: emptyAppearance(),
    locks: [], isPlayer: false, ...over,
  };
}

// -------------------------------------------------------------- style anchor

test('every visual style has a distinct positive and negative fragment', () => {
  const keys = Object.keys(STYLE_FRAGMENTS);
  assert.deepEqual(keys.sort(), ['animation', 'draft', 'drawing', 'realistic', 'sketch'].sort());
  const positives = new Set(Object.values(STYLE_FRAGMENTS).map((f) => f.positive));
  assert.equal(positives.size, keys.length, 'no two styles share a positive fragment');
});

// ----------------------------------------------------------------- portrait

test('a portrait prompt restates the durable appearance, not just the summary', () => {
  const e = entity({ name: 'Brother Anselm', summary: 'A monk.' });
  const s = sheet({
    appearance: { ...emptyAppearance(), description: 'Lean, grey-haired, ink-stained hands.', attire: 'undyed wool habit', markers: ['a burn scar on the forearm'] },
  });
  const style = defaultStyleContract();
  const { prompt, negativePrompt } = composePortraitPrompt(e, s, style);

  assert.match(prompt, /Brother Anselm/);
  assert.match(prompt, /Lean, grey-haired, ink-stained hands/, 'durable description appears');
  assert.match(prompt, /undyed wool habit/, 'attire appears');
  assert.match(prompt, /burn scar/, 'markers appear');
  assert.ok(negativePrompt.length > 0);
});

test('a portrait with no authored appearance still produces a usable prompt from the summary', () => {
  const e = entity({ name: 'Nobody Yet', summary: 'A stranger at the gate.' });
  const s = sheet();
  const { prompt } = composePortraitPrompt(e, s, defaultStyleContract());
  assert.match(prompt, /Nobody Yet/);
  assert.match(prompt, /stranger at the gate/);
});

test('two different visual styles produce two different prompts for the same character', () => {
  const e = entity({ name: 'X' });
  const s = sheet({ appearance: { ...emptyAppearance(), description: 'tall, dark-haired' } });
  const a = composePortraitPrompt(e, s, { ...defaultStyleContract(), visualStyle: 'realistic' });
  const b = composePortraitPrompt(e, s, { ...defaultStyleContract(), visualStyle: 'sketch' });
  assert.notEqual(a.prompt, b.prompt);
  assert.notEqual(a.negativePrompt, b.negativePrompt);
  // But the character description itself must survive the style change
  // unchanged — the whole point of separating style from identity.
  assert.match(a.prompt, /tall, dark-haired/);
  assert.match(b.prompt, /tall, dark-haired/);
});

test('the world visual anchor is present in every portrait prompt', () => {
  const style = { ...defaultStyleContract(), visualAnchor: 'a monastery under a secular garrison, iron-gall ink and stone' };
  const { prompt } = composePortraitPrompt(entity(), sheet(), style);
  assert.match(prompt, /monastery under a secular garrison/);
});

test('a portrait prompt never invents identity the sheet does not have', () => {
  const e = entity({ name: 'Blank', summary: '' });
  const { prompt } = composePortraitPrompt(e, sheet(), defaultStyleContract());
  assert.match(prompt, /no visual description recorded yet/, 'honest placeholder, not a fabricated one');
});

// --------------------------------------------------------------------- scene

test('a scene prompt restates the location and every present character', () => {
  const loc = entity({ id: 'loc:scriptorium', type: 'Location', name: 'The Scriptorium', summary: 'Long room, north light.' });
  const anselm = entity({ id: 'char:anselm', name: 'Brother Anselm' });
  const anselmSheet = sheet({ appearance: { ...emptyAppearance(), description: 'Lean, grey-haired.' } });

  const { prompt } = composeScenePrompt(loc, [{ entity: anselm, sheet: anselmSheet }], defaultStyleContract(), 'He looks up from the desk.');

  assert.match(prompt, /The Scriptorium/);
  assert.match(prompt, /north light/);
  assert.match(prompt, /Brother Anselm/);
  assert.match(prompt, /Lean, grey-haired/);
  assert.match(prompt, /looks up from the desk/);
});

test('the same location produces the same anchor text across two calls, for place consistency', () => {
  const loc = entity({ id: 'loc:x', name: 'The Drowned Mill', summary: 'Abandoned when the river moved.' });
  assert.equal(locationAnchor(loc), locationAnchor(loc));
  assert.match(locationAnchor(loc), /The Drowned Mill/);
  assert.match(locationAnchor(loc), /river moved/);
});

test('a location prefers its own visualDescription prop over the summary when both exist', () => {
  const loc = entity({ name: 'X', summary: 'summary text', props: { visualDescription: 'a specific visual description' } });
  const anchor = locationAnchor(loc);
  assert.match(anchor, /specific visual description/);
});

test('a scene with no location still produces a usable prompt', () => {
  const { prompt } = composeScenePrompt(undefined, [], defaultStyleContract());
  assert.match(prompt, /Scene\./);
});

test('an empty cast produces a scene prompt with no dangling "Present:" fragment', () => {
  const { prompt } = composeScenePrompt(entity(), [], defaultStyleContract());
  assert.doesNotMatch(prompt, /Present:/);
});
