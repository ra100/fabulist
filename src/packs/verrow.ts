/**
 * Saint Verrow — the original hand-authored setting, as a pack.
 *
 * This is a migration, not a rewrite: the entities, edges, sheets, facts and
 * threads are the ones from `seed/verrow.ts`, which stays where it is so the
 * `pnpm seed` path and the tests built on it keep working unchanged.
 *
 * What the migration adds is what the seed could not express:
 *
 *  - **Authored salience.** The seed set a flat 0.4 on all twenty-odd entities
 *    and got away with it because twenty-odd entities fit inside the Narrator's
 *    twelve-entity window no matter how they sort. Nothing larger does.
 *  - **Live predicates.** `FRIENDLY_WITH`, `RELIES_ON` and `KEEPS_SECRET_FROM`
 *    matched none of the consequence engine's patterns, so three of the more
 *    interesting ties in the seed were invisible to propagation. They are in the
 *    vocabulary now (`packs/predicates.ts`) and they fire.
 *  - **A second scenario.** The seed had one situation. The same canon supports
 *    a second with a different protagonist, which is the cheapest possible
 *    demonstration that the canon/scenario split does what it claims.
 */
import type { WorldPack } from './types.ts';
import { packEdges } from './types.ts';

export const verrowPack: WorldPack = {
  id: 'saint-verrow',
  title: 'Saint Verrow',
  genre: 'historical',
  blurb: 'A monastery under a secular garrison, and a vow of nonviolence that is about to cost something.',
  premise: `A hill town grown around a four-hundred-year-old monastery, half its houses leaning on the old
wall. The Order of Verrow copies books and grows herbs and has sworn, since its founding, to harm no
living thing. Six years ago a crown garrison requisitioned the monastery's south yard to watch the
mountain passes. They have been watching the Order instead.

What holds the place together is the Accommodation: the garrison does not search the monastery, and
the Order does not ask what happened to the last prior. It is not a treaty. It is an agreement nobody
has written down and everybody is a little ashamed of, and it is coming apart because the Order has
been moving people over the passes and writing their names in the back of a psalter.

Nothing here is decided by force. Everything is decided by what people are willing to admit they
already know.`,
  license: 'Original work, written for this engine. No third-party setting or characters.',

  entities: [
    // --- places
    {
      id: 'loc:saint-verrow',
      type: 'Location',
      name: 'Saint Verrow',
      summary: 'A hill town grown around the monastery, half its houses leaning on the old wall.',
      tier: 'principal',
    },
    {
      id: 'loc:the-scriptorium',
      type: 'Location',
      name: 'The Scriptorium',
      summary: 'Long room, north light, twelve desks. The only warm room in winter.',
      tier: 'principal',
    },
    {
      id: 'loc:the-lower-cells',
      type: 'Location',
      name: 'The Lower Cells',
      summary: 'Cut into rock below the chapel. Cold, dry, and useful for storing things nobody should find.',
      tier: 'principal',
    },
    {
      id: 'loc:the-garrison-yard',
      type: 'Location',
      name: 'The Garrison Yard',
      summary: 'Requisitioned from the monastery six years ago. Still has the herb beds under the gravel.',
      tier: 'principal',
    },
    {
      id: 'loc:the-north-gate',
      type: 'Location',
      name: 'The North Gate',
      summary: 'Where the road to the mountain passes leaves. Watched, lately.',
      tier: 'principal',
    },
    {
      id: 'loc:the-drowned-mill',
      type: 'Location',
      name: 'The Drowned Mill',
      summary: 'Abandoned when the river moved. People meet there when they do not want to be seen meeting.',
      tier: 'supporting',
    },

    // --- factions
    {
      id: 'fac:the-order-of-verrow',
      type: 'Faction',
      name: 'The Order of Verrow',
      summary:
        'Copyists and herbalists. Sworn to nonviolence for four hundred years, and increasingly inconvenient to the garrison.',
      tier: 'principal',
    },
    {
      id: 'fac:the-garrison',
      type: 'Faction',
      name: 'The Garrison',
      summary: 'Forty soldiers under Captain Sered, nominally protecting the pass, actually watching the Order.',
      tier: 'principal',
    },
    {
      id: 'fac:the-pass-carriers',
      type: 'Faction',
      name: 'The Pass Carriers',
      summary: 'Smugglers who move people over the mountains. Paid in silver or silence.',
      tier: 'supporting',
    },

    // --- people
    {
      id: 'char:brother-anselm',
      type: 'Character',
      name: 'Brother Anselm',
      summary: 'Thirty years in the Order. Runs the scriptorium and pretends not to run anything else.',
      tier: 'principal',
      props: { status: 'alive', age: 54 },
    },
    {
      id: 'char:captain-sered',
      type: 'Character',
      name: 'Captain Sered',
      summary: 'Commands the garrison. Reasonable, tired, and entirely capable of hanging someone reasonably.',
      tier: 'principal',
      props: { status: 'alive' },
    },
    {
      id: 'char:sister-oria',
      type: 'Character',
      name: 'Sister Oria',
      summary: 'Herbalist. Keeps the Order alive through winters and asks fewer questions than she answers.',
      tier: 'principal',
      props: { status: 'alive' },
    },
    {
      id: 'char:novice-tem',
      type: 'Character',
      name: 'Novice Tem',
      summary: 'Seventeen, quick with a pen, slower with discretion. Anselm is teaching him both.',
      tier: 'principal',
      props: { status: 'alive' },
    },
    {
      id: 'char:hela-vask',
      type: 'Character',
      name: 'Hela Vask',
      summary: 'Pass carrier. Charges double for clergy and says it is a fair rate for the risk.',
      tier: 'principal',
      props: { status: 'alive' },
    },
    {
      id: 'char:sergeant-doff',
      type: 'Character',
      name: 'Sergeant Doff',
      summary: "Sered's sergeant. Enjoys the work more than his captain does.",
      tier: 'principal',
      props: { status: 'alive' },
    },
    {
      id: 'char:prior-galt',
      type: 'Character',
      name: 'Prior Galt',
      summary: 'Head of the Order. Believes accommodation has kept them alive and cannot see what it has cost.',
      tier: 'principal',
      props: { status: 'alive' },
    },
    {
      id: 'char:the-widow-marn',
      type: 'Character',
      name: 'The Widow Marn',
      summary: 'Keeps the inn by the north gate. Hears everything, sells about a third of it.',
      tier: 'supporting',
      props: { status: 'alive' },
    },
    {
      id: 'char:dural-vask',
      type: 'Character',
      name: 'Dural Vask',
      summary: "Hela's younger brother. Walks the high route in weather nobody else will.",
      tier: 'supporting',
      props: { status: 'alive' },
    },

    // --- things and ideas
    {
      id: 'item:the-verrow-psalter',
      type: 'Item',
      name: 'The Verrow Psalter',
      summary: "The Order's oldest book. Also, in the back pages, a list of everyone they have moved over the pass.",
      tier: 'principal',
    },
    {
      id: 'item:anselms-knife',
      type: 'Item',
      name: "Anselm's Knife",
      summary: 'A parchment knife, thin and very sharp. Sharpened daily for forty years for entirely innocent reasons.',
      tier: 'supporting',
    },
    {
      id: 'concept:the-accommodation',
      type: 'Concept',
      name: 'The Accommodation',
      summary:
        'The unwritten agreement: the garrison does not search the monastery, and the Order does not ask what happened to the last prior.',
      tier: 'principal',
    },
    {
      id: 'concept:the-vow-of-verrow',
      type: 'Concept',
      name: 'The Vow of Verrow',
      summary: 'Harm no living thing. Not a preference. The Order was founded on the refusal.',
      tier: 'principal',
    },
  ],

  edges: packEdges([
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
    ['char:novice-tem', 'LOYAL_TO', 'char:brother-anselm', 0.85],
    ['char:sister-oria', 'TRUSTS', 'char:brother-anselm', 0.8],
    ['char:sergeant-doff', 'SUSPECTS', 'char:brother-anselm', 0.65],
    // Previously inert. Galt leaning on Anselm is half the reason Anselm cannot
    // simply walk away from the Order's politics.
    ['char:prior-galt', 'RELIES_ON', 'char:brother-anselm', 0.5],
    ['char:captain-sered', 'WATCHES', 'char:brother-anselm', 0.6],
    ['char:brother-anselm', 'TRUSTS', 'char:sister-oria', 0.85],
    ['char:brother-anselm', 'KEEPS_SECRET_FROM', 'char:prior-galt', 0.7],
    ['char:brother-anselm', 'DEALS_WITH', 'char:hela-vask', 0.6],
    ['char:captain-sered', 'SUSPECTS', 'fac:the-order-of-verrow', 0.6],
    ['char:sergeant-doff', 'HOSTILE_TO', 'fac:the-order-of-verrow', 0.7],
    ['char:the-widow-marn', 'INFORMS', 'char:captain-sered', 0.5],
    ['char:the-widow-marn', 'FRIENDLY_WITH', 'char:sister-oria', 0.6],
    ['char:sister-oria', 'FRIENDLY_WITH', 'char:the-widow-marn', 0.5],
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
    ['char:the-widow-marn', 'WORKS_AT', 'loc:the-north-gate', 0.8],
    ['fac:the-garrison', 'WATCHES', 'loc:the-north-gate', 0.7],
  ]),

  sheets: [
    {
      entityId: 'char:brother-anselm',
      identity: {
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
          {
            id: 'poverty',
            text: 'own nothing beyond the habit and the tools of the work',
            rank: 3,
            broken: false,
            brokenScene: null,
          },
          {
            id: 'obedience',
            text: 'obey the Prior in all things concerning the Order',
            rank: 4,
            broken: false,
            brokenScene: null,
          },
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
      appearance: {
        description:
          'A lean man of fifty-four, close-cropped grey hair, ink permanently under the nails of his right hand. Stands very still when listening.',
        attire: 'The undyed wool habit of the Order of Verrow, rope-belted, sleeves pushed back for the desk.',
        markers: [
          'a burn scar across the left forearm, always kept covered',
          'reading spectacles worn low on the nose',
        ],
      },
    },
    {
      entityId: 'char:captain-sered',
      identity: {
        goals: ['find the route without having to hang a monk', 'be posted somewhere else'],
        fears: ['that his sergeant is right about the Order'],
        allegiances: ['The Garrison', 'his own sense of proportion'],
        competencies: ['patience', 'reading paperwork', 'command'],
        secrets: ['he has known about the route for a year and has not reported it'],
        arc: 'A reasonable man discovering that reasonableness is a way of postponing a decision.',
      },
      contract: {
        vows: [
          {
            id: 'duty',
            text: 'the pass stays closed to those the crown names',
            rank: 2,
            broken: false,
            brokenScene: null,
          },
        ],
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
      appearance: {
        description:
          'Mid-forties, weathered, the build of a soldier gone slightly soft behind a desk. Pale grey eyes, deliberate posture.',
        attire: "Garrison officer's coat, crown-blue over grey, always buttoned to the collar regardless of weather.",
        markers: ['a healed break in the nose, slightly off-centre'],
      },
    },
    {
      entityId: 'char:sister-oria',
      identity: {
        goals: ['keep everyone through the winter'],
        competencies: ['herbs and wounds', 'knowing what not to say'],
        secrets: ['she has known about the route as long as Anselm has'],
      },
      contract: {
        vows: [{ id: 'nonviolence', text: 'harm no living thing', rank: 1, broken: false, brokenScene: null }],
        drives: ['keep people alive, whatever they have done'],
        breakingPoint: 'Being asked to let someone die to protect the Order.',
        costOfBreak: 'She would never trust the Order again, and would stay anyway.',
      },
      voice: { diction: 'Practical, warm, unsentimental about death.' },
      appearance: {
        description: 'Stout, sixty, hands stained green-brown from the herb store. Moves fast for her age.',
      },
    },
    {
      entityId: 'char:novice-tem',
      identity: {
        goals: ['be trusted with something real'],
        fears: ['being sent away as useless'],
        arc: 'A boy who wants to be complicit because complicity looks like being taken seriously.',
      },
      contract: {
        vows: [
          {
            id: 'nonviolence',
            text: 'harm no living thing',
            rank: 2,
            broken: false,
            brokenScene: null,
          },
          { id: 'novice-obedience', text: 'obey those who teach you', rank: 3, broken: false, brokenScene: null },
        ],
        drives: ['be useful to Anselm'],
        breakingPoint: 'Watching Anselm be taken and having a stone in reach.',
        costOfBreak: 'He would have to be got out of Verrow the same night.',
      },
      voice: { diction: 'Eager, too fast, quotes things he half understands.' },
      appearance: {
        description: 'Seventeen, gangly, ink-spotted novice habit, hair that will not stay cut short.',
      },
    },
    {
      entityId: 'char:hela-vask',
      identity: { goals: ['get paid', 'not get caught'], competencies: ['the high route in bad weather'] },
      voice: { diction: 'Blunt, transactional, funny when it costs her nothing.' },
      appearance: {
        description:
          "Thirty, weathered from mountain weather, a mountaineer's coat over trail leathers, rope coiled at the hip.",
      },
    },
    {
      entityId: 'char:sergeant-doff',
      identity: { goals: ['catch the Order at it'], fears: ['being passed over again'] },
      voice: { diction: 'Flat, cheerful, faintly hungry.' },
      appearance: {
        description: "Thick-necked, garrison sergeant's coat, a grin that does not reach the eyes.",
      },
    },
    {
      entityId: 'char:prior-galt',
      identity: {
        goals: ['keep the Accommodation'],
        fears: ['that the Order ends on his watch'],
        secrets: ['he knows the garrison killed the last prior and has never said so'],
      },
      voice: { diction: 'Formal, tired, speaks in the passive voice about anything difficult.' },
      appearance: {
        description: "Elderly, stooped, the Order's good ceremonial habit worn slightly too large for him now.",
      },
    },
    {
      entityId: 'char:the-widow-marn',
      identity: { goals: ["stay on everyone's good side"], competencies: ['hearing things'] },
      voice: { diction: 'Chatty, shrewd, never quite lies.' },
      appearance: {
        description: "Fifties, sharp-eyed, an innkeeper's apron over good wool, rings on every finger.",
      },
    },
    {
      entityId: 'char:dural-vask',
      identity: { goals: ['keep his sister out of the cells'] },
      voice: { diction: 'Few words, all of them concrete. Talks about weather and footing.' },
      appearance: {
        description: "Twenties, rangy, sun-cracked skin, the same mountaineer's coat as his sister in a smaller size.",
      },
    },
  ],

  scenarios: [
    {
      id: 'the-inspection',
      title: 'The Morning of the Inspection',
      premise: `Captain Sered means to open the lower cells today. The psalter is down there, and in its back
pages the name of every person the Order has moved over the pass. You are Brother Anselm, you have kept
a vow of nonviolence for thirty years, and you have until midday to make a search unnecessary.`,
      playerCharacterId: 'char:brother-anselm',
      openingLocationId: 'loc:the-scriptorium',
      openingScene: 'The morning of the inspection',
      focus: {
        'char:brother-anselm': 'focal',
        'char:captain-sered': 'focal',
        'char:novice-tem': 'focal',
        'char:sergeant-doff': 'focal',
        'item:the-verrow-psalter': 'focal',
        'loc:the-lower-cells': 'focal',
        'loc:the-scriptorium': 'focal',
        'char:sister-oria': 'principal',
        'char:prior-galt': 'principal',
        'concept:the-vow-of-verrow': 'principal',
        'concept:the-accommodation': 'principal',
        'char:hela-vask': 'supporting',
        'char:the-widow-marn': 'background',
        'char:dural-vask': 'background',
      },
      conditions: [
        {
          entityId: 'char:brother-anselm',
          locationId: 'loc:the-scriptorium',
          mood: 'guarded',
          inventory: ["Anselm's knife", 'a half-copied quire'],
          intent: 'get through the inspection without the cells being opened',
        },
        { entityId: 'char:novice-tem', locationId: 'loc:the-scriptorium', mood: 'restless' },
        { entityId: 'char:sister-oria', locationId: 'loc:the-scriptorium', mood: 'busy' },
        {
          entityId: 'char:captain-sered',
          locationId: 'loc:the-garrison-yard',
          mood: 'tired',
          intent: 'inspect the lower cells today',
        },
        { entityId: 'char:sergeant-doff', locationId: 'loc:the-garrison-yard', mood: 'keen' },
        { entityId: 'char:prior-galt', locationId: 'loc:saint-verrow', mood: 'anxious' },
        { entityId: 'char:hela-vask', locationId: 'loc:the-drowned-mill', mood: 'wary' },
        { entityId: 'char:the-widow-marn', locationId: 'loc:the-north-gate', mood: 'watchful' },
        { entityId: 'char:dural-vask', locationId: 'loc:the-north-gate', mood: 'uneasy' },
      ],
      relationships: [
        {
          from: 'char:brother-anselm',
          to: 'char:novice-tem',
          trust: 0.7,
          affection: 0.8,
          respect: 0.3,
          note: 'his responsibility, and his blind spot',
        },
        {
          from: 'char:novice-tem',
          to: 'char:brother-anselm',
          trust: 0.9,
          affection: 0.9,
          respect: 0.9,
          note: 'would follow him anywhere, which is the problem',
        },
        {
          from: 'char:brother-anselm',
          to: 'char:captain-sered',
          trust: 0.2,
          affection: -0.1,
          respect: 0.6,
          note: 'the least bad soldier available',
        },
        {
          from: 'char:captain-sered',
          to: 'char:brother-anselm',
          trust: 0.1,
          affection: 0.3,
          respect: 0.8,
          note: 'respects him, expects to have to ruin him',
        },
        {
          from: 'char:sergeant-doff',
          to: 'char:brother-anselm',
          trust: -0.6,
          affection: -0.7,
          respect: 0.2,
          note: 'wants him to be guilty',
        },
        {
          from: 'char:brother-anselm',
          to: 'char:sister-oria',
          trust: 0.9,
          affection: 0.6,
          respect: 0.8,
          note: 'the only one who knows all of it',
        },
        {
          from: 'char:sister-oria',
          to: 'char:brother-anselm',
          trust: 0.8,
          affection: 0.5,
          respect: 0.7,
          note: 'thinks he will get himself killed being subtle',
        },
        {
          from: 'char:hela-vask',
          to: 'char:brother-anselm',
          trust: 0.4,
          affection: 0.2,
          respect: 0.5,
          note: 'reliable payer, terrible liar',
        },
        {
          from: 'char:prior-galt',
          to: 'char:brother-anselm',
          trust: 0.3,
          affection: 0.4,
          respect: 0.5,
          note: 'suspects him of something and does not want to know',
        },
        {
          from: 'char:the-widow-marn',
          to: 'char:captain-sered',
          trust: 0.3,
          affection: 0.1,
          respect: 0.3,
          note: 'sells him the third of it that is safe',
        },
        {
          from: 'char:dural-vask',
          to: 'char:hela-vask',
          trust: 0.8,
          affection: 0.9,
          respect: 0.6,
          note: 'would burn the pass down for her',
        },
        {
          from: 'char:hela-vask',
          to: 'char:dural-vask',
          trust: 0.7,
          affection: 0.8,
          respect: 0.4,
          note: 'thinks he takes stupid risks, which he does',
        },
      ],
      facts: [
        {
          text: 'the Order moves people over the pass and records them in the psalter',
          knows: ['char:brother-anselm', 'char:sister-oria', 'char:hela-vask'],
          suspects: ['char:captain-sered', 'char:sergeant-doff'],
        },
        {
          text: 'Sered has known about the route for a year and has not reported it',
          knows: ['char:captain-sered'],
        },
        {
          text: 'the last prior was killed by the garrison, not by fever',
          knows: ['char:prior-galt', 'char:captain-sered'],
          suspects: ['char:brother-anselm'],
        },
      ],
      threads: [
        {
          title: 'The inspection of the lower cells',
          stakes: 'the psalter, and everyone named in it',
          tension: 0.8,
          parties: ['char:captain-sered', 'char:brother-anselm', 'char:sergeant-doff'],
          resolutions: [
            'the cells are opened',
            'the psalter is moved first',
            'Sered is given a reason to delay',
            'Doff finds it without orders',
          ],
        },
        {
          title: 'Tem wants to be trusted',
          stakes: 'whether Anselm makes him complicit or useless',
          tension: 0.5,
          parties: ['char:novice-tem', 'char:brother-anselm'],
          resolutions: ['he is told everything', 'he finds out badly', 'he is sent away', 'he tells someone'],
        },
        {
          title: 'What Sered is not reporting',
          stakes: 'his own neck, and the Accommodation',
          tension: 0.4,
          parties: ['char:captain-sered', 'char:sergeant-doff'],
          resolutions: [
            'Doff reports over his head',
            'Sered acts first',
            'it stays buried',
            'Anselm learns of it and uses it',
          ],
        },
      ],
      anchor: {
        text: 'The ink had frozen in the well overnight. He warmed it against his palm and did not think about the cells.',
        note: 'plain, concrete, withheld',
      },
    },

    // The second scenario exists to prove the split: same canon, same twenty-two
    // entities, different protagonist, different pressure, different focus. Sered
    // has a vow too, and it points the other way.
    {
      id: 'the-reasonable-man',
      title: 'The Reasonable Man',
      premise: `You are Captain Sered. You have known about the Order's route over the pass for a year and
have not reported it, because reporting it means hangings and you have been telling yourself there is
time. This morning your sergeant went over your head. Whatever you do next, someone finds out what you
have been sitting on.`,
      playerCharacterId: 'char:captain-sered',
      openingLocationId: 'loc:the-garrison-yard',
      openingScene: 'The letter Doff has already sent',
      focus: {
        'char:captain-sered': 'focal',
        'char:sergeant-doff': 'focal',
        'char:brother-anselm': 'focal',
        'concept:the-accommodation': 'focal',
        'loc:the-garrison-yard': 'focal',
        'char:prior-galt': 'principal',
        'char:the-widow-marn': 'principal',
        'loc:the-lower-cells': 'principal',
        'item:the-verrow-psalter': 'principal',
        'char:sister-oria': 'supporting',
        'char:novice-tem': 'supporting',
        'char:hela-vask': 'supporting',
        'char:dural-vask': 'background',
      },
      conditions: [
        {
          entityId: 'char:captain-sered',
          locationId: 'loc:the-garrison-yard',
          mood: 'cornered',
          intent: 'find out what Doff wrote and to whom',
        },
        { entityId: 'char:sergeant-doff', locationId: 'loc:the-garrison-yard', mood: 'pleased with himself' },
        { entityId: 'char:brother-anselm', locationId: 'loc:the-scriptorium', mood: 'unaware' },
        { entityId: 'char:the-widow-marn', locationId: 'loc:the-north-gate', mood: 'already selling it' },
        { entityId: 'char:prior-galt', locationId: 'loc:saint-verrow', mood: 'anxious' },
      ],
      relationships: [
        {
          from: 'char:captain-sered',
          to: 'char:sergeant-doff',
          trust: -0.4,
          affection: -0.5,
          respect: 0.3,
          note: 'competent, and now dangerous',
        },
        {
          from: 'char:sergeant-doff',
          to: 'char:captain-sered',
          trust: 0.1,
          affection: -0.2,
          respect: -0.3,
          note: 'thinks him weak, and is not entirely wrong',
        },
        {
          from: 'char:captain-sered',
          to: 'char:brother-anselm',
          trust: 0.1,
          affection: 0.3,
          respect: 0.8,
          note: 'respects him, expects to have to ruin him',
        },
        {
          from: 'char:brother-anselm',
          to: 'char:captain-sered',
          trust: 0.2,
          affection: -0.1,
          respect: 0.6,
          note: 'the least bad soldier available',
        },
        {
          from: 'char:the-widow-marn',
          to: 'char:captain-sered',
          trust: 0.3,
          affection: 0.1,
          respect: 0.3,
          note: 'sells him the third of it that is safe',
        },
        {
          from: 'char:captain-sered',
          to: 'char:the-widow-marn',
          trust: -0.2,
          affection: 0.2,
          respect: 0.1,
          note: 'useful, and she knows it',
        },
      ],
      facts: [
        {
          text: 'Doff has written to the district command about the pass route',
          knows: ['char:sergeant-doff'],
          suspects: ['char:captain-sered', 'char:the-widow-marn'],
        },
        {
          text: 'Sered has known about the route for a year and has not reported it',
          knows: ['char:captain-sered'],
          suspects: ['char:sergeant-doff'],
        },
        {
          text: 'the last prior was killed by the garrison, not by fever',
          knows: ['char:captain-sered', 'char:prior-galt'],
          wrong: ['char:sergeant-doff'],
        },
      ],
      threads: [
        {
          title: 'What Doff sent, and to whom',
          stakes: "Sered's commission and his neck",
          tension: 0.75,
          parties: ['char:captain-sered', 'char:sergeant-doff'],
          resolutions: [
            'the letter is intercepted',
            'Sered reports first and frames it his way',
            'Doff is bought or promoted away',
            'district command arrives already informed',
          ],
        },
        {
          title: 'Whether the Order is warned',
          stakes: 'forty soldiers, and whoever is currently in the cells',
          tension: 0.6,
          parties: ['char:captain-sered', 'char:brother-anselm', 'char:prior-galt'],
          resolutions: [
            'Sered warns Anselm and becomes complicit in fact',
            'the Order is taken by surprise',
            'Galt is warned instead and does nothing',
            'the route is closed quietly before anyone arrives',
          ],
        },
        {
          title: 'The Accommodation, out loud',
          stakes: 'an agreement that only worked while nobody named it',
          tension: 0.5,
          parties: ['char:captain-sered', 'char:prior-galt', 'char:brother-anselm'],
          resolutions: [
            'it is written down and becomes a treaty',
            'it is denied by both sides',
            'it collapses into a search',
            'it is replaced by something worse and more honest',
          ],
        },
      ],
      style: { register: 'clipped', pacing: 'steady' },
      anchor: {
        text: 'The yard had been herb beds once. You could still see the lines under the gravel if you knew to look, and he did.',
        note: 'official register, dry, a man noticing what he has ruined',
      },
    },
  ],
};
