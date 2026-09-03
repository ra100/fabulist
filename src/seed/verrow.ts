/**
 * Hand-authored canon for Slice 0. See DESIGN.md §13.
 *
 * Twenty-odd entities, no ingest. If the loop is not consistent and enjoyable
 * against this, no amount of wiki data will save it.
 *
 * The setting is deliberately small and pressure-shaped: a monastery under a
 * secular garrison, which gives the integrity gate a real vow to defend and the
 * consequence engine dense social edges to travel along.
 */
import type { EntityType } from '../domain/types.ts';
import type { World } from '../store/index.ts';
import { emptyCondition, emptyContract, emptyIdentity, emptyVoice } from '../store/cast.ts';

interface SeedEntity {
  id: string;
  type: EntityType;
  name: string;
  summary: string;
  props?: Record<string, unknown>;
}

const ENTITIES: SeedEntity[] = [
  // Locations
  { id: 'loc:saint-verrow', type: 'Location', name: 'Saint Verrow', summary: 'A hill town grown around the monastery, half its houses leaning on the old wall.' },
  { id: 'loc:the-scriptorium', type: 'Location', name: 'The Scriptorium', summary: 'Long room, north light, twelve desks. The only warm room in winter.' },
  { id: 'loc:the-lower-cells', type: 'Location', name: 'The Lower Cells', summary: 'Cut into rock below the chapel. Cold, dry, and useful for storing things nobody should find.' },
  { id: 'loc:the-garrison-yard', type: 'Location', name: 'The Garrison Yard', summary: 'Requisitioned from the monastery six years ago. Still has the herb beds under the gravel.' },
  { id: 'loc:the-north-gate', type: 'Location', name: 'The North Gate', summary: 'Where the road to the mountain passes leaves. Watched, lately.' },
  { id: 'loc:the-drowned-mill', type: 'Location', name: 'The Drowned Mill', summary: 'Abandoned when the river moved. People meet there when they do not want to be seen meeting.' },

  // Factions
  { id: 'fac:the-order-of-verrow', type: 'Faction', name: 'The Order of Verrow', summary: 'Copyists and herbalists. Sworn to nonviolence for four hundred years, and increasingly inconvenient to the garrison.' },
  { id: 'fac:the-garrison', type: 'Faction', name: 'The Garrison', summary: 'Forty soldiers under Captain Sered, nominally protecting the pass, actually watching the Order.' },
  { id: 'fac:the-pass-carriers', type: 'Faction', name: 'The Pass Carriers', summary: 'Smugglers who move people over the mountains. Paid in silver or silence.' },

  // Characters
  { id: 'char:brother-anselm', type: 'Character', name: 'Brother Anselm', summary: 'Thirty years in the Order. Runs the scriptorium and pretends not to run anything else.', props: { status: 'alive', age: 54 } },
  { id: 'char:captain-sered', type: 'Character', name: 'Captain Sered', summary: 'Commands the garrison. Reasonable, tired, and entirely capable of hanging someone reasonably.', props: { status: 'alive' } },
  { id: 'char:sister-oria', type: 'Character', name: 'Sister Oria', summary: 'Herbalist. Keeps the Order alive through winters and asks fewer questions than she answers.', props: { status: 'alive' } },
  { id: 'char:novice-tem', type: 'Character', name: 'Novice Tem', summary: 'Seventeen, quick with a pen, slower with discretion. Anselm is teaching him both.', props: { status: 'alive' } },
  { id: 'char:hela-vask', type: 'Character', name: 'Hela Vask', summary: 'Pass carrier. Charges double for clergy and says it is a fair rate for the risk.', props: { status: 'alive' } },
  { id: 'char:sergeant-doff', type: 'Character', name: 'Sergeant Doff', summary: 'Sered\'s sergeant. Enjoys the work more than his captain does.', props: { status: 'alive' } },
  { id: 'char:prior-galt', type: 'Character', name: 'Prior Galt', summary: 'Head of the Order. Believes accommodation has kept them alive and cannot see what it has cost.', props: { status: 'alive' } },
  { id: 'char:the-widow-marn', type: 'Character', name: 'The Widow Marn', summary: 'Keeps the inn by the north gate. Hears everything, sells about a third of it.', props: { status: 'alive' } },
  { id: 'char:dural-vask', type: 'Character', name: 'Dural Vask', summary: "Hela's younger brother. Walks the high route in weather nobody else will.", props: { status: 'alive' } },

  // Items and concepts
  { id: 'item:the-verrow-psalter', type: 'Item', name: 'The Verrow Psalter', summary: 'The Order\'s oldest book. Also, in the back pages, a list of everyone they have moved over the pass.' },
  { id: 'item:anselms-knife', type: 'Item', name: "Anselm's Knife", summary: 'A parchment knife, thin and very sharp. Sharpened daily for forty years for entirely innocent reasons.' },
  { id: 'concept:the-accommodation', type: 'Concept', name: 'The Accommodation', summary: 'The unwritten agreement: the garrison does not search the monastery, and the Order does not ask what happened to the last prior.' },
  { id: 'concept:the-vow-of-verrow', type: 'Concept', name: 'The Vow of Verrow', summary: 'Harm no living thing. Not a preference. The Order was founded on the refusal.' },
];

const EDGES: Array<[string, string, string, number]> = [
  ['char:brother-anselm', 'MEMBER_OF', 'fac:the-order-of-verrow', 0.9],
  ['char:sister-oria', 'MEMBER_OF', 'fac:the-order-of-verrow', 0.9],
  ['char:novice-tem', 'MEMBER_OF', 'fac:the-order-of-verrow', 0.7],
  ['char:prior-galt', 'LEADS', 'fac:the-order-of-verrow', 0.95],
  ['char:captain-sered', 'LEADS', 'fac:the-garrison', 0.95],
  ['char:sergeant-doff', 'MEMBER_OF', 'fac:the-garrison', 0.8],
  ['char:hela-vask', 'MEMBER_OF', 'fac:the-pass-carriers', 0.8],
  ['char:dural-vask', 'MEMBER_OF', 'fac:the-pass-carriers', 0.7],
  ['char:dural-vask', 'KIN_OF', 'char:hela-vask', 0.9],
  ['char:hela-vask', 'KIN_OF', 'char:dural-vask', 0.9],
  ['char:brother-anselm', 'MENTORS', 'char:novice-tem', 0.8],
  ['char:brother-anselm', 'TRUSTS', 'char:sister-oria', 0.85],
  ['char:brother-anselm', 'KEEPS_SECRET_FROM', 'char:prior-galt', 0.7],
  ['char:brother-anselm', 'DEALS_WITH', 'char:hela-vask', 0.6],
  ['char:captain-sered', 'SUSPECTS', 'fac:the-order-of-verrow', 0.6],
  ['char:sergeant-doff', 'HOSTILE_TO', 'fac:the-order-of-verrow', 0.7],
  ['char:the-widow-marn', 'INFORMS', 'char:captain-sered', 0.5],
  ['char:the-widow-marn', 'FRIENDLY_WITH', 'char:sister-oria', 0.6],
  ['fac:the-garrison', 'OCCUPIES', 'loc:the-garrison-yard', 0.9],
  ['fac:the-order-of-verrow', 'HOLDS', 'loc:the-scriptorium', 0.9],
  ['fac:the-order-of-verrow', 'HOLDS', 'loc:the-lower-cells', 0.8],
  ['fac:the-order-of-verrow', 'SWORN_TO', 'concept:the-vow-of-verrow', 1.0],
  ['char:brother-anselm', 'KEEPS', 'item:the-verrow-psalter', 0.8],
  ['char:brother-anselm', 'CARRIES', 'item:anselms-knife', 0.7],
  ['item:the-verrow-psalter', 'KEPT_IN', 'loc:the-lower-cells', 0.7],
  ['loc:the-scriptorium', 'PART_OF', 'loc:saint-verrow', 0.9],
  ['loc:the-lower-cells', 'PART_OF', 'loc:saint-verrow', 0.9],
  ['loc:the-garrison-yard', 'PART_OF', 'loc:saint-verrow', 0.9],
  ['loc:the-north-gate', 'PART_OF', 'loc:saint-verrow', 0.8],
  ['char:hela-vask', 'MEETS_AT', 'loc:the-drowned-mill', 0.6],
  ['char:the-widow-marn', 'KEEPS_INN_AT', 'loc:the-north-gate', 0.8],
  ['fac:the-garrison', 'WATCHES', 'loc:the-north-gate', 0.7],
];

export interface SeedOptions {
  /** Which character the player runs. Defaults to Anselm, whose vow makes the gate real. */
  playerCharacterId?: string;
}

export function seedWorld(world: World, opts: SeedOptions = {}): void {
  for (const e of ENTITIES) {
    world.graph.upsert(
      {
        id: e.id,
        type: e.type,
        name: e.name,
        summary: e.summary,
        provenance: 'authored',
        confidence: 1,
        salience: 0.4,
        depthLevel: 3,
        props: e.props ?? {},
        createdScene: 0,
      },
      'canon',
    );
  }

  for (const [subject, predicate, object, weight] of EDGES) {
    world.graph.assertEdge({ subject, predicate, object, weight }, 0, 'canon', 'authored');
  }

  // --- Sheets. Contracts are the part the integrity gate actually reads.

  world.cast.put({
    entityId: 'char:brother-anselm',
    identity: {
      ...emptyIdentity(),
      goals: ['keep the pass route open', 'keep Tem out of it', 'finish the psalter copy'],
      wounds: ['the last prior died and he chose not to ask how'],
      fears: ['that the Order survives by becoming worth nothing'],
      allegiances: ['The Order of Verrow', 'the people he has moved over the pass'],
      competencies: ['copying and forgery', 'reading a room', 'thirty years of being underestimated'],
      secrets: ['the psalter back pages list everyone he has smuggled'],
      arc: 'A man who has kept a vow for thirty years by never being in a position where it cost him anything.',
    },
    contract: {
      vows: [
        { id: 'nonviolence', text: 'harm no living thing', rank: 1, broken: false, brokenScene: null },
        { id: 'poverty', text: 'own nothing beyond the habit and the tools of the work', rank: 3, broken: false, brokenScene: null },
        { id: 'obedience', text: 'obey the Prior in all things concerning the Order', rank: 4, broken: false, brokenScene: null },
      ],
      drives: ['protect those who cannot protect themselves', 'keep the work going'],
      breakingPoint: 'Someone he is responsible for, about to die in front of him, with no other hand available.',
      costOfBreak: 'He would not be able to go back to the desk. The Order would know within a day.',
    },
    voice: {
      diction: 'Measured, dry, understated. Prefers the specific noun. Deflects with practicalities.',
      tics: ['answers a question with a question about the work', 'says "as it happens" before bad news'],
      samples: [
        'As it happens, the ink is the least of our problems.',
        'I have not lied to you. I have simply not finished telling you things.',
        'Put it down, Tem. You do not know what it is yet.',
      ],
      never: ['raises his voice', 'threatens anyone', 'speaks of the last prior'],
    },
    condition: { ...emptyCondition(), locationId: 'loc:the-scriptorium', mood: 'guarded', inventory: ["Anselm's knife", 'a half-copied quire'], intent: 'get through the inspection without the cells being opened' },
    locks: [],
    isPlayer: true,
  });

  world.cast.put({
    entityId: 'char:captain-sered',
    identity: {
      ...emptyIdentity(),
      goals: ['find the route without having to hang a monk', 'be posted somewhere else'],
      fears: ['that his sergeant is right about the Order'],
      allegiances: ['The Garrison', 'his own sense of proportion'],
      competencies: ['patience', 'reading paperwork', 'command'],
      secrets: ['he has known about the route for a year and has not reported it'],
      arc: 'A reasonable man discovering that reasonableness is a way of postponing a decision.',
    },
    contract: {
      vows: [{ id: 'duty', text: 'the pass stays closed to those the crown names', rank: 2, broken: false, brokenScene: null }],
      drives: ['keep order without atrocity'],
      breakingPoint: 'Being made to look complicit in front of his own men.',
      costOfBreak: 'He becomes Doff.',
    },
    voice: {
      diction: 'Clipped, courteous, official register even in private. Uses names deliberately.',
      tics: ['calls people by rank or title', 'apologises immediately before doing something unpleasant'],
      samples: ['I am sorry, Brother. Open the cells.', 'You will find I am the best offer you get today.'],
      never: ['shouts', 'enjoys it'],
    },
    condition: { ...emptyCondition(), locationId: 'loc:the-garrison-yard', mood: 'tired', intent: 'inspect the lower cells today' },
    locks: [],
    isPlayer: false,
  });

  const supporting: Array<[string, string, string[], string, string]> = [
    ['char:sister-oria', 'Practical, warm, unsentimental about death.', ['keep everyone through the winter'], 'loc:the-scriptorium', 'busy'],
    ['char:novice-tem', 'Eager, too fast, quotes things he half understands.', ['be trusted with something real'], 'loc:the-scriptorium', 'restless'],
    ['char:hela-vask', 'Blunt, transactional, funny when it costs her nothing.', ['get paid', 'not get caught'], 'loc:the-drowned-mill', 'wary'],
    ['char:sergeant-doff', 'Flat, cheerful, faintly hungry.', ['catch the Order at it'], 'loc:the-garrison-yard', 'keen'],
    ['char:prior-galt', 'Formal, tired, speaks in the passive voice about anything difficult.', ['keep the Accommodation'], 'loc:saint-verrow', 'anxious'],
    ['char:the-widow-marn', 'Chatty, shrewd, never quite lies.', ['stay on everyone\'s good side'], 'loc:the-north-gate', 'watchful'],
    ['char:dural-vask', 'Few words, all of them concrete. Talks about weather and footing.', ['keep his sister out of the cells'], 'loc:the-north-gate', 'uneasy'],
  ];

  for (const [id, diction, goals, locationId, mood] of supporting) {
    world.cast.put({
      entityId: id,
      identity: { ...emptyIdentity(), goals },
      contract: emptyContract(),
      voice: { ...emptyVoice(), diction },
      condition: { ...emptyCondition(), locationId, mood },
      locks: [],
      isPlayer: false,
    });
  }

  // --- Relationships. Asymmetry is the point: Sered respects Anselm and is
  // still going to search his cells.

  const rels: Array<[string, string, number, number, number, string]> = [
    ['char:brother-anselm', 'char:novice-tem', 0.7, 0.8, 0.3, 'his responsibility, and his blind spot'],
    ['char:novice-tem', 'char:brother-anselm', 0.9, 0.9, 0.9, 'would follow him anywhere, which is the problem'],
    ['char:brother-anselm', 'char:captain-sered', 0.2, -0.1, 0.6, 'the least bad soldier available'],
    ['char:captain-sered', 'char:brother-anselm', 0.1, 0.3, 0.8, 'respects him, expects to have to ruin him'],
    ['char:sergeant-doff', 'char:brother-anselm', -0.6, -0.7, 0.2, 'wants him to be guilty'],
    ['char:brother-anselm', 'char:sister-oria', 0.9, 0.6, 0.8, 'the only one who knows all of it'],
    ['char:sister-oria', 'char:brother-anselm', 0.8, 0.5, 0.7, 'thinks he will get himself killed being subtle'],
    ['char:hela-vask', 'char:brother-anselm', 0.4, 0.2, 0.5, 'reliable payer, terrible liar'],
    ['char:prior-galt', 'char:brother-anselm', 0.3, 0.4, 0.5, 'suspects him of something and does not want to know'],
    ['char:the-widow-marn', 'char:captain-sered', 0.3, 0.1, 0.3, 'sells him the third of it that is safe'],
    ['char:dural-vask', 'char:hela-vask', 0.8, 0.9, 0.6, 'would burn the pass down for her'],
    ['char:hela-vask', 'char:dural-vask', 0.7, 0.8, 0.4, 'thinks he takes stupid risks, which he does'],
  ];
  for (const [from, to, trust, affection, respect, note] of rels) {
    world.cast.adjustRelationship(from, to, { trust, affection, respect, note });
  }

  // --- Facts. Note the asymmetry: the player knows things Sered does not, and
  // Sered knows one thing the player does not. That gap is the story engine.

  const routeFact = world.chronicle.addFact('the Order moves people over the pass and records them in the psalter', 0);
  world.chronicle.setKnowledge(routeFact.id, 'char:brother-anselm', 'knows', 0);
  world.chronicle.setKnowledge(routeFact.id, 'char:sister-oria', 'knows', 0);
  world.chronicle.setKnowledge(routeFact.id, 'char:hela-vask', 'knows', 0);
  world.chronicle.setKnowledge(routeFact.id, 'char:captain-sered', 'suspects', 0);
  world.chronicle.setKnowledge(routeFact.id, 'char:sergeant-doff', 'suspects', 0);

  const seredFact = world.chronicle.addFact('Sered has known about the route for a year and has not reported it', 0);
  world.chronicle.setKnowledge(seredFact.id, 'char:captain-sered', 'knows', 0);

  const priorFact = world.chronicle.addFact('the last prior was killed by the garrison, not by fever', 0);
  world.chronicle.setKnowledge(priorFact.id, 'char:prior-galt', 'knows', 0);
  world.chronicle.setKnowledge(priorFact.id, 'char:captain-sered', 'knows', 0);
  world.chronicle.setKnowledge(priorFact.id, 'char:brother-anselm', 'suspects', 0);

  // --- Threads. Each has several possible resolutions, never one.

  world.threads.create({
    title: 'The inspection of the lower cells',
    stakes: 'the psalter, and everyone named in it',
    tension: 0.8,
    parties: ['char:captain-sered', 'char:brother-anselm', 'char:sergeant-doff'],
    resolutions: ['the cells are opened', 'the psalter is moved first', 'Sered is given a reason to delay', 'Doff finds it without orders'],
    status: 'open',
    createdScene: 1,
  });
  world.threads.create({
    title: 'Tem wants to be trusted',
    stakes: 'whether Anselm makes him complicit or useless',
    tension: 0.5,
    parties: ['char:novice-tem', 'char:brother-anselm'],
    resolutions: ['he is told everything', 'he finds out badly', 'he is sent away', 'he tells someone'],
    status: 'open',
    createdScene: 1,
  });
  world.threads.create({
    title: 'What Sered is not reporting',
    stakes: 'his own neck, and the Accommodation',
    tension: 0.4,
    parties: ['char:captain-sered', 'char:sergeant-doff'],
    resolutions: ['Doff reports over his head', 'Sered acts first', 'it stays buried', 'Anselm learns of it and uses it'],
    status: 'open',
    createdScene: 1,
  });

  world.chronicle.upsertScene(1, {
    title: 'The morning of the inspection',
    summary: '',
    locationId: 'loc:the-scriptorium',
    chapter: 1,
  });

  world.session.set({
    scene: 1,
    turn: 0,
    playerCharacterId: opts.playerCharacterId ?? 'char:brother-anselm',
    currentLocationId: 'loc:the-scriptorium',
  });

  // A style anchor from the outset, so the narrator has a texture to match
  // before the player has liked anything.
  world.chronicle.addAnchor(
    'The ink had frozen in the well overnight. He warmed it against his palm and did not think about the cells.',
    'seed anchor: plain, concrete, withheld',
    0,
  );
}
