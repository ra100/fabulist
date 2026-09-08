/**
 * The Quarantine Year — original historical fiction. An invented town under
 * plague orders, sealed, with authority improvising. Every person in it fictional.
 *
 * Thornhythe is not a real place and nobody in it ever lived. The period is: the
 * plague year in England, autumn 1665 into the winter, in a small chartered
 * harbour town on the Essex marsh coast. The furniture is documented and generic
 * — printed plague orders, sworn searchers of the dead with their red wands,
 * houses shut up for a term of days with a watchman at the door, weekly bills of
 * mortality, certificates of health, a pest-house on the saltings, a county
 * allowance of corn to a sealed town, justices of the peace who signed the order
 * and will not come near it. No named historical person appears, offstage or on.
 *
 * The pack exists to stress the knowledge system. In 1665 information walked:
 * it came by letter, by carrier, by whoever was at the toll cottage when the
 * cart went through. So the documents here are entities — the bill, the parish
 * register, the pit-book, the corn tally, the pass book, the blank certificates —
 * because a fact in this world lives in a specific object that can be forged,
 * delayed, intercepted, or dropped in a fire. Several people are authored
 * confidently *wrong* rather than merely ignorant, which is the more useful
 * state: a man who does not know pauses, and a man who is sure acts.
 */
import type { WorldPack } from './types.ts';
import { packEdges } from './types.ts';

export const theQuarantineYearPack: WorldPack = {
  id: 'the-quarantine-year',
  title: 'The Quarantine Year',
  genre: 'historical',
  blurb: 'A sealed harbour town in the plague year of 1665, and an acting mayor with no bench left to assent.',
  premise: `Thornhythe is a chartered harbour town of some nine hundred souls on the Essex marsh coast, England,
in the autumn of 1665. A London coaster came up the creek at the end of August. By the second week of
September the Mayor was in the ground, four aldermen with him, and the justices of the county had set a
watch on the causeway — the only road in — with orders that nobody pass without a certificate of health.
The neighbouring market towns will not honour Thornhythe certificates. So the town is sealed at both
ends: it cannot let its people out, and nobody outside will take them.

Corn comes by the county allowance, weekly, over the causeway, and it has been arriving short. The
printed orders say that a house with the sickness in it is shut up entire, well and sick together, with a
red cross on the door and a watchman before it, for the full term of days. The town's own surgeon
believes this is killing people who would otherwise live and signs the returns anyway, because his fee
and his pass depend on it. The corn factor who holds the granary key has a daughter behind one of those
sealed doors. The serjeant who drives the nails swore in front of the whole market that his own house
would be sealed first, and his daughter has a girl hidden in the town's sail loft who was landed off the
London hoy at night and is on no list anywhere.

Nothing here is settled by force; there is nobody left with enough authority to use any. It is settled by
paper — what is written in which book, who carried it, who read it on the way, and what a man is prepared
to put the town's seal to when there is no longer a bench to assent.`,
  license: 'Original work, written for this engine. No third-party setting or characters.',
  entities: [
    // ------------------------------------------------------------- the town
    {
      id: 'loc:thornhythe',
      type: 'Location',
      name: 'Thornhythe',
      summary: 'A chartered harbour town of nine hundred, sealed since the fourteenth of September and counting.',
      tier: 'principal',
    },
    {
      id: 'loc:the-guildhall',
      type: 'Location',
      name: 'The Guildhall',
      summary: 'One long chamber over the market cross. Twelve chairs at the bench, four of them empty and unfilled.',
      tier: 'principal',
    },
    {
      id: 'loc:the-clerks-room',
      type: 'Location',
      name: "The Clerk's Room",
      summary: 'A closet off the Guildhall holding every book the town has, in a dead man\u2019s hand.',
      tier: 'principal',
    },
    {
      id: 'loc:holy-cross-church',
      type: 'Location',
      name: 'Holy Cross Church',
      summary: 'The parish church. Locked against gatherings, and used anyway, at the west door, one at a time.',
      tier: 'supporting',
    },
    {
      id: 'loc:the-rectory',
      type: 'Location',
      name: 'The Rectory',
      summary:
        'The rector went to his wife\u2019s people in August. The curate uses the kitchen and touches nothing else.',
      tier: 'background',
    },
    {
      id: 'loc:the-quay',
      type: 'Location',
      name: 'The Quay',
      summary: 'Stone wharf, four hoys idle at it, and nothing coming up the creek that anyone will unload.',
      tier: 'principal',
    },
    {
      id: 'loc:the-custom-house',
      type: 'Location',
      name: 'The Custom House',
      summary: 'Two rooms and a strongbox of entered lading notes. The officer died; the notes are still filed.',
      tier: 'supporting',
    },
    {
      id: 'loc:the-town-granary',
      type: 'Location',
      name: 'The Town Granary',
      summary: 'Weatherboard loft above the wharf where the county allowance is stored. One key, and Havers has it.',
      tier: 'principal',
    },
    {
      id: 'loc:the-sail-loft',
      type: 'Location',
      name: 'The Sail Loft',
      summary:
        'The town\u2019s tackle, canvas and ladders, above the quay. The serjeant keeps the only key on his belt.',
      tier: 'supporting',
    },
    {
      id: 'loc:the-three-cups',
      type: 'Location',
      name: 'The Three Cups',
      summary: 'The alehouse at the quay head. Shut by the orders, open at the back, and the fastest post in the town.',
      tier: 'principal',
    },
    {
      id: 'loc:the-fish-shambles',
      type: 'Location',
      name: 'The Fish Shambles',
      summary: 'Open stalls where the market is now allowed, standing apart, coins dropped into a bowl of vinegar.',
      tier: 'supporting',
    },
    {
      id: 'loc:sluice-lane',
      type: 'Location',
      name: 'Sluice Lane',
      summary: 'Eleven houses under the wall. Nine have the cross on the door and a watchman\u2019s stool outside.',
      tier: 'principal',
    },
    {
      id: 'loc:the-corder-house',
      type: 'Location',
      name: 'The Corder House',
      summary: 'Shut up entire on the twenty-second, seven souls counted in. Something still moves behind the shutter.',
      tier: 'principal',
    },
    {
      id: 'loc:the-surgeons-house',
      type: 'Location',
      name: "The Surgeon's House",
      summary: 'Quy\u2019s door, with his fee-board still nailed up beside it and his pass framed behind the glass.',
      tier: 'supporting',
    },
    {
      id: 'loc:the-causeway',
      type: 'Location',
      name: 'The Causeway',
      summary: 'A mile of raised road across the marsh. The only way in, barred at the far end since September.',
      tier: 'principal',
    },
    {
      id: 'loc:the-toll-cottage',
      type: 'Location',
      name: 'The Toll Cottage',
      summary: 'Halfway along the causeway. The one table in the parish where both sides are permitted to stand.',
      tier: 'principal',
    },
    {
      id: 'loc:the-far-watch',
      type: 'Location',
      name: 'The Far Watch',
      summary: 'A turf hut and a chain at the landward end, kept by men the county pays and the town cannot reach.',
      tier: 'supporting',
    },
    {
      id: 'loc:the-saltings',
      type: 'Location',
      name: 'The Saltings',
      summary:
        'Tidal marsh either side of the town, crossed by footpaths only the wildfowlers can hold in their heads.',
      tier: 'supporting',
    },
    {
      id: 'loc:hollow-creek',
      type: 'Location',
      name: 'Hollow Creek',
      summary: 'A blind channel in the saltings where a boat can be laid alongside and nobody on the quay would know.',
      tier: 'supporting',
    },
    {
      id: 'loc:the-pest-house',
      type: 'Location',
      name: 'The Pest House',
      summary:
        'A brick shed and a paling fence on the marsh, paid for by the vestry, kept by Stannard, entered by few.',
      tier: 'principal',
    },
    {
      id: 'loc:the-new-ground',
      type: 'Location',
      name: 'The New Ground',
      summary: 'A quarter-acre beyond the churchyard, opened in September because the churchyard was full by then.',
      tier: 'supporting',
    },
    {
      id: 'loc:the-hoy-constant-hope',
      type: 'Location',
      name: 'The Constant Hope',
      summary: 'A London coaster riding quarantine at the creek mouth, her master aboard and refusing to be moved.',
      tier: 'supporting',
    },

    // ------------------------------------ cluster A: the Guildhall, improvising
    {
      id: 'char:ambrose-kell',
      type: 'Character',
      name: 'Ambrose Kell',
      summary:
        'Senior alderman, acting as mayor since the Mayor was buried. Signs everything, is entitled to none of it.',
      tier: 'principal',
      props: { status: 'alive', age: 57, trade: 'tallow chandler' },
    },
    {
      id: 'char:hester-dowsett',
      type: 'Character',
      name: 'Hester Dowsett',
      summary:
        'The late Town Clerk\u2019s widow. The only person living who can read his hand, and she is careful about it.',
      tier: 'principal',
      props: { status: 'alive', age: 44 },
    },
    {
      id: 'char:simeon-roode',
      type: 'Character',
      name: 'Simeon Roode',
      summary: 'Corporation serjeant. Nails the crosses up himself and keeps a private tally of who died behind them.',
      tier: 'principal',
      props: { status: 'alive', age: 46 },
    },
    {
      id: 'char:gideon-havers',
      type: 'Character',
      name: 'Gideon Havers',
      summary:
        'Alderman and corn factor. Holds the granary key, weighs the allowance alone, and calls the difference wastage.',
      tier: 'principal',
      props: { status: 'alive', age: 52 },
    },
    {
      id: 'char:bartholomew-quy',
      type: 'Character',
      name: 'Bartholomew Quy',
      summary:
        'The town\u2019s salaried surgeon. Believes the shutting up kills the well with the sick, and signs the returns.',
      tier: 'principal',
      props: { status: 'alive', age: 39 },
    },
    {
      id: 'char:elias-nunn',
      type: 'Character',
      name: 'Elias Nunn',
      summary:
        'Curate, the rector having gone. Buries them all and keeps two counts of them, which is his whole crime.',
      tier: 'principal',
      props: { status: 'alive', age: 31 },
    },

    // -------------------------------------- cluster B: the quay and the water
    {
      id: 'char:joan-larke',
      type: 'Character',
      name: 'Joan Larke',
      summary:
        'Keeps the Three Cups. Knows within a half-day who is sick, who is short, and who was down at the creek.',
      tier: 'principal',
      props: { status: 'alive', age: 48 },
    },
    {
      id: 'char:kit-swayne',
      type: 'Character',
      name: 'Kit Swayne',
      summary:
        'Master of the Constant Hope, riding quarantine. Landed three passengers at night and entered none of them.',
      tier: 'principal',
      props: { status: 'alive', age: 34 },
    },
    {
      id: 'char:ruth-swayne',
      type: 'Character',
      name: 'Ruth Swayne',
      summary:
        'Kit\u2019s sister, and Havers\u2019 clerk at the granary. Copies the tally in a fair hand and knows what it is.',
      tier: 'supporting',
      props: { status: 'alive', age: 27 },
    },
    {
      id: 'char:obadiah-pyke',
      type: 'Character',
      name: 'Obadiah Pyke',
      summary: 'Waterman. Carries letters over the creek for a penny and reads the ones that are not folded well.',
      tier: 'supporting',
      props: { status: 'alive', age: 41 },
    },
    {
      id: 'char:tobias-grimble',
      type: 'Character',
      name: 'Tobias Grimble',
      summary: 'Wildfowler. Brings flour over the saltings at low water and has never once been stopped on the path.',
      tier: 'supporting',
      props: { status: 'alive', age: 36 },
    },
    {
      id: 'char:mercy-grimble',
      type: 'Character',
      name: 'Mercy Grimble',
      summary:
        'Sells her husband\u2019s flour in the shambles at four times its price and will argue the fairness of it.',
      tier: 'supporting',
      props: { status: 'alive', age: 33 },
    },

    // ------------------------------- cluster C: the barrier, the marsh, the dead
    {
      id: 'char:isaac-trussel',
      type: 'Character',
      name: 'Isaac Trussel',
      summary: 'Captain of the county watch, hired out of the Dutch war and not from here. Holds the town in, exactly.',
      tier: 'principal',
      props: { status: 'alive', age: 43 },
    },
    {
      id: 'char:prudence-gedge',
      type: 'Character',
      name: 'Prudence Gedge',
      summary: 'Keeps the toll cottage and the pass book. The only soul both sides are content to be in a room with.',
      tier: 'principal',
      props: { status: 'alive', age: 38 },
    },
    {
      id: 'char:phineas-gedge',
      type: 'Character',
      name: 'Phineas Gedge',
      summary:
        'Prudence\u2019s boy, eleven. Runs letters along the sea wall for a farthing and has never lost one yet.',
      tier: 'background',
      props: { status: 'alive', age: 11 },
    },
    {
      id: 'char:jerome-wace',
      type: 'Character',
      name: 'Jerome Wace',
      summary:
        'A Thornhythe man taking the county\u2019s pay to keep Thornhythe shut. His mother is on the wrong side of it.',
      tier: 'supporting',
      props: { status: 'alive', age: 24 },
    },
    {
      id: 'char:dorcas-sallow',
      type: 'Character',
      name: 'Dorcas Sallow',
      summary: 'Sworn searcher of the dead. Says what killed a body, and so says whether a house is nailed shut.',
      tier: 'principal',
      props: { status: 'alive', age: 61 },
    },
    {
      id: 'char:silence-bulmer',
      type: 'Character',
      name: 'Silence Bulmer',
      summary: 'The second searcher, twenty-two and unlettered. Sworn to report truly and paid twopence a corpse.',
      tier: 'supporting',
      props: { status: 'alive', age: 22 },
    },
    {
      id: 'char:ezra-stannard',
      type: 'Character',
      name: 'Ezra Stannard',
      summary: 'Keeps the pest house and digs the new ground. Writes the pit-book, and has written into it for money.',
      tier: 'principal',
      props: { status: 'alive', age: 50 },
    },

    // ------------------------------ cluster D: Sluice Lane and what is hidden
    {
      id: 'char:alice-roode',
      type: 'Character',
      name: 'Alice Roode',
      summary:
        'The serjeant\u2019s daughter. Feeds a girl in the sail loft twice a day with her father\u2019s own key.',
      tier: 'principal',
      props: { status: 'alive', age: 20 },
    },
    {
      id: 'char:thankful-aveling',
      type: 'Character',
      name: 'Thankful Aveling',
      summary:
        'Nineteen, landed off the London hoy at night, entered in no book. If the town finds her it will hang her.',
      tier: 'principal',
      props: { status: 'alive', age: 19 },
    },
    {
      id: 'char:grace-havers',
      type: 'Character',
      name: 'Grace Havers',
      summary:
        'Havers\u2019 daughter, married into the Corder house and sealed inside it. Well on the ninth day, and counting.',
      tier: 'principal',
      props: { status: 'alive', age: 23 },
    },
    {
      id: 'char:nathaniel-corder',
      type: 'Character',
      name: 'Nathaniel Corder',
      summary:
        'Grace\u2019s husband, a ropemaker in debt to her father. Sick behind the shutter, and not yet dead of it.',
      tier: 'supporting',
      props: { status: 'alive', age: 29 },
    },
    {
      id: 'char:tabitha-nokes',
      type: 'Character',
      name: 'Tabitha Nokes',
      summary: 'Servant in the Corder house. Calls the count through the shutter each morning and is not believed.',
      tier: 'supporting',
      props: { status: 'alive', age: 35 },
    },
    {
      id: 'char:marget-skeat',
      type: 'Character',
      name: 'Marget Skeat',
      summary:
        'Sells plague water at the shambles. Knows more of the town\u2019s sick than the surgeon and charges less.',
      tier: 'principal',
      props: { status: 'alive', age: 58 },
    },

    // -------------------------------------------- the two who cross the lines
    {
      id: 'char:oliver-kell',
      type: 'Character',
      name: 'Oliver Kell',
      summary:
        'Kell\u2019s son, come home from London three days too late. Living rough on the marsh outside his own town.',
      tier: 'supporting',
      props: { status: 'alive', age: 25 },
    },
    {
      id: 'char:reuben-fowle',
      type: 'Character',
      name: 'Reuben Fowle',
      summary:
        'The county\u2019s carrier, who brought the allowance and counted the sacks. Found on the saltings, unmarked.',
      tier: 'supporting',
      props: { status: 'dead', age: 45 },
    },

    // ---------------------------------------------------------------- bodies
    {
      id: 'fac:the-corporation',
      type: 'Faction',
      name: 'The Corporation of Thornhythe',
      summary: 'Mayor, twelve aldermen and a seal. Four of the twelve are dead, two are shut up, and one is Havers.',
      tier: 'principal',
    },
    {
      id: 'fac:the-vestry',
      type: 'Faction',
      name: 'The Vestry of Holy Cross',
      summary: 'Pays for the poor, the pest house and the burying. Has spent next year\u2019s rate and it is October.',
      tier: 'supporting',
    },
    {
      id: 'fac:the-quay-partners',
      type: 'Faction',
      name: 'The Quay Partners',
      summary: 'Six men who between them own the wharf, three hoys and most of the corn that comes over it.',
      tier: 'supporting',
    },
    {
      id: 'fac:the-searchers',
      type: 'Faction',
      name: 'The Sworn Searchers',
      summary: 'Two women and a gravedigger, sworn to view every corpse and report truly what it died of.',
      tier: 'principal',
    },
    {
      id: 'fac:the-county-watch',
      type: 'Faction',
      name: 'The County Watch',
      summary: 'Fourteen men on the landward side of the chain, paid by the hundred, forbidden to speak across it.',
      tier: 'principal',
    },
    {
      id: 'fac:the-marsh-men',
      type: 'Faction',
      name: 'The Marsh Men',
      summary: 'Wildfowlers of the saltings. The only route in and out that no order has ever managed to close.',
      tier: 'supporting',
    },
    {
      id: 'fac:the-county-bench',
      type: 'Faction',
      name: 'The County Bench',
      summary:
        'The justices who signed the order that sealed the town. None of them has come within a mile of it since.',
      tier: 'supporting',
    },

    // -------------------------- documents, being how a fact moves in this world
    {
      id: 'item:the-weekly-bill',
      type: 'Item',
      name: 'The Weekly Bill of Mortality',
      summary:
        'Sent to the bench each Thursday. Last week it said thirty-four of the visitation. It was not thirty-four.',
      tier: 'principal',
    },
    {
      id: 'item:the-parish-register',
      type: 'Item',
      name: 'The Parish Register',
      summary:
        'Every burial in the curate\u2019s own hand, entered the same day, and sixty-one where the bill says thirty-four.',
      tier: 'principal',
    },
    {
      id: 'item:the-pit-book',
      type: 'Item',
      name: 'The Pit Book',
      summary:
        'Stannard\u2019s tally of who went into the new ground. Contains at least one burial that never happened.',
      tier: 'principal',
    },
    {
      id: 'item:the-corn-tally',
      type: 'Item',
      name: 'The Corn Tally',
      summary:
        'Havers\u2019 book of the allowance received. Nine quarters lighter than the carrier\u2019s notes for the same weeks.',
      tier: 'principal',
    },
    {
      id: 'item:the-searchers-return',
      type: 'Item',
      name: "The Searchers' Return",
      summary: 'The weekly sheet of causes of death, sworn by the searchers and countersigned by the surgeon.',
      tier: 'principal',
    },
    {
      id: 'item:the-blank-certificates',
      type: 'Item',
      name: 'The Blank Certificates',
      summary: 'Three certificates of health, signed and sealed by the Mayor before he died and never filled in.',
      tier: 'principal',
    },
    {
      id: 'item:the-town-seal',
      type: 'Item',
      name: 'The Town Seal',
      summary:
        'Silver, the size of a crown piece. By the oath it is used only by assent of the bench, and there is no bench.',
      tier: 'principal',
    },
    {
      id: 'item:the-pass-book',
      type: 'Item',
      name: 'The Pass Book',
      summary: 'Every soul that crosses the toll table, the hour, and which way. Prudence writes it in ink, always.',
      tier: 'principal',
    },
    {
      id: 'item:roodes-tally',
      type: 'Item',
      name: "Roode's Tally",
      summary:
        'A folded sheet in the serjeant\u2019s coat: nineteen doors, the souls counted in, and how many came out.',
      tier: 'principal',
    },
    {
      id: 'item:the-quy-letters',
      type: 'Item',
      name: "Quy's Letters",
      summary:
        'The surgeon\u2019s correspondence to a physician in the city, praising the town\u2019s remarkably low mortality.',
      tier: 'principal',
    },
    {
      id: 'item:the-lading-note',
      type: 'Item',
      name: 'The Lading Note',
      summary:
        'The Constant Hope\u2019s entered cargo, in the custom house strongbox. It lists no passengers whatever.',
      tier: 'supporting',
    },
    {
      id: 'item:the-red-wand',
      type: 'Item',
      name: 'The Red Wand',
      summary:
        'The four-foot rod a sworn searcher must carry in the street, so the well may see her coming and stand off.',
      tier: 'supporting',
    },

    // --------------------------------------------------------------- the words
    {
      id: 'concept:the-plague-orders',
      type: 'Concept',
      name: 'The Plague Orders',
      summary:
        'The printed sheet nailed to the market cross. Searchers, watchmen, shutting up, the term of days, the bill.',
      tier: 'principal',
    },
    {
      id: 'concept:the-shutting-up',
      type: 'Concept',
      name: 'The Shutting Up',
      summary:
        'Well and sick sealed in together for the full term. Every officer in the town has a private opinion of it.',
      tier: 'principal',
    },
    {
      id: 'concept:certificates-of-health',
      type: 'Concept',
      name: 'Certificates of Health',
      summary: 'A sealed paper saying you may be a person somewhere else. Worthless unless the next town honours it.',
      tier: 'principal',
    },
    {
      id: 'concept:the-county-allowance',
      type: 'Concept',
      name: 'The County Allowance',
      summary:
        'Corn and coin owed weekly to a sealed town, in exchange for staying sealed. Owed is not the same as had.',
      tier: 'principal',
    },
    {
      id: 'concept:the-visitation',
      type: 'Concept',
      name: 'The Visitation',
      summary: 'The word the town uses so as not to use the other one. It appears in every return and every bill.',
      tier: 'supporting',
    },
    {
      id: 'concept:the-term-of-days',
      type: 'Concept',
      name: 'The Term of Days',
      summary: 'How long a shut house stays shut, and from which death you count. Nobody agrees, and Roode decides.',
      tier: 'principal',
    },
    {
      id: 'concept:the-searchers-oath',
      type: 'Concept',
      name: "The Searchers' Oath",
      summary: 'Sworn on the book: to view every corpse, take no fee to change a report, and speak the cause truly.',
      tier: 'principal',
    },

    // ------------------------------------------------------- what has happened
    {
      id: 'event:the-hoy-came-up-the-creek',
      type: 'Event',
      name: 'The Hoy Came Up The Creek',
      summary: 'The twenty-sixth of August. The Constant Hope out of London, entered clean, and unloaded twice.',
      tier: 'principal',
    },
    {
      id: 'event:the-mayors-burial',
      type: 'Event',
      name: "The Mayor's Burial",
      summary:
        'The eleventh of September, at night, six men. No successor was chosen and no writ has come to choose one.',
      tier: 'principal',
    },
    {
      id: 'event:the-setting-of-the-watch',
      type: 'Event',
      name: 'The Setting of the Watch',
      summary:
        'The fourteenth. A chain across the causeway by noon, and the market towns refusing Thornhythe paper by dusk.',
      tier: 'principal',
    },
    {
      id: 'event:the-sealing-of-sluice-lane',
      type: 'Event',
      name: 'The Sealing of Sluice Lane',
      summary: 'The twenty-second. Nine doors in one morning, the Corder house among them, seven souls counted in.',
      tier: 'principal',
    },
  ],
  edges: packEdges([
    // ------------------------------------------------------------- geography
    ['loc:the-guildhall', 'PART_OF', 'loc:thornhythe', 0.9],
    ['loc:the-clerks-room', 'PART_OF', 'loc:the-guildhall', 0.9],
    ['loc:holy-cross-church', 'PART_OF', 'loc:thornhythe', 0.9],
    ['loc:the-rectory', 'PART_OF', 'loc:thornhythe', 0.7],
    ['loc:the-quay', 'PART_OF', 'loc:thornhythe', 0.9],
    ['loc:the-custom-house', 'PART_OF', 'loc:the-quay', 0.8],
    ['loc:the-town-granary', 'PART_OF', 'loc:the-quay', 0.85],
    ['loc:the-sail-loft', 'PART_OF', 'loc:the-quay', 0.8],
    ['loc:the-three-cups', 'PART_OF', 'loc:the-quay', 0.8],
    ['loc:the-fish-shambles', 'PART_OF', 'loc:thornhythe', 0.8],
    ['loc:sluice-lane', 'PART_OF', 'loc:thornhythe', 0.9],
    ['loc:the-corder-house', 'PART_OF', 'loc:sluice-lane', 0.9],
    ['loc:the-surgeons-house', 'PART_OF', 'loc:thornhythe', 0.8],
    ['loc:the-toll-cottage', 'PART_OF', 'loc:the-causeway', 0.9],
    ['loc:the-far-watch', 'PART_OF', 'loc:the-causeway', 0.85],
    ['loc:the-pest-house', 'PART_OF', 'loc:the-saltings', 0.85],
    ['loc:the-new-ground', 'PART_OF', 'loc:the-saltings', 0.7],
    ['loc:hollow-creek', 'PART_OF', 'loc:the-saltings', 0.8],
    ['loc:thornhythe', 'CONNECTS_TO', 'loc:the-causeway', 0.9],
    ['loc:the-causeway', 'CONNECTS_TO', 'loc:the-saltings', 0.6],
    ['loc:the-saltings', 'CONNECTS_TO', 'loc:thornhythe', 0.7],
    ['loc:the-quay', 'CONNECTS_TO', 'loc:hollow-creek', 0.6],
    ['loc:the-hoy-constant-hope', 'CONNECTS_TO', 'loc:hollow-creek', 0.7],
    ['loc:the-new-ground', 'CONNECTS_TO', 'loc:holy-cross-church', 0.6],

    // --------------------------------------------- who answers to what body
    ['loc:thornhythe', 'GOVERNED_BY', 'fac:the-corporation', 0.9],
    ['loc:the-causeway', 'GOVERNED_BY', 'fac:the-county-bench', 0.85],
    ['loc:holy-cross-church', 'GOVERNED_BY', 'fac:the-vestry', 0.8],
    ['loc:the-pest-house', 'GOVERNED_BY', 'fac:the-vestry', 0.7],
    ['fac:the-corporation', 'HOLDS', 'loc:the-guildhall', 0.9],
    ['fac:the-corporation', 'HOLDS', 'loc:the-sail-loft', 0.7],
    ['fac:the-quay-partners', 'HOLDS', 'loc:the-town-granary', 0.8],
    ['fac:the-quay-partners', 'HOLDS', 'loc:the-quay', 0.7],
    ['fac:the-county-watch', 'OCCUPIES', 'loc:the-far-watch', 0.9],
    ['fac:the-county-watch', 'OCCUPIES', 'loc:the-causeway', 0.8],
    ['fac:the-marsh-men', 'HOLDS', 'loc:the-saltings', 0.7],
    ['fac:the-vestry', 'HOLDS', 'loc:the-new-ground', 0.7],

    // ------------------------------------------ where the documents actually are
    ['item:the-town-seal', 'KEPT_IN', 'loc:the-clerks-room', 0.8],
    ['item:the-blank-certificates', 'KEPT_IN', 'loc:the-clerks-room', 0.8],
    ['item:the-weekly-bill', 'KEPT_IN', 'loc:the-clerks-room', 0.7],
    ['item:the-parish-register', 'KEPT_IN', 'loc:holy-cross-church', 0.85],
    ['item:the-corn-tally', 'KEPT_IN', 'loc:the-town-granary', 0.8],
    ['item:the-pit-book', 'KEPT_IN', 'loc:the-pest-house', 0.8],
    ['item:the-pass-book', 'KEPT_IN', 'loc:the-toll-cottage', 0.85],
    ['item:the-lading-note', 'KEPT_IN', 'loc:the-custom-house', 0.8],
    ['item:the-searchers-return', 'KEPT_IN', 'loc:the-surgeons-house', 0.7],
    ['char:ambrose-kell', 'KEEPS', 'item:the-town-seal', 0.8],
    ['char:hester-dowsett', 'KEEPS', 'item:the-blank-certificates', 0.9],
    ['char:hester-dowsett', 'KEEPS', 'item:the-weekly-bill', 0.8],
    ['char:elias-nunn', 'KEEPS', 'item:the-parish-register', 0.9],
    ['char:gideon-havers', 'KEEPS', 'item:the-corn-tally', 0.9],
    ['char:ezra-stannard', 'KEEPS', 'item:the-pit-book', 0.9],
    ['char:prudence-gedge', 'KEEPS', 'item:the-pass-book', 0.9],
    ['char:bartholomew-quy', 'KEEPS', 'item:the-searchers-return', 0.8],
    ['char:bartholomew-quy', 'KEEPS', 'item:the-quy-letters', 0.8],
    ['char:simeon-roode', 'CARRIES', 'item:roodes-tally', 0.9],
    ['char:dorcas-sallow', 'CARRIES', 'item:the-red-wand', 0.9],

    // ------------------------------------------------- oaths and their objects
    ['concept:the-shutting-up', 'PART_OF', 'concept:the-plague-orders', 0.9],
    ['concept:certificates-of-health', 'PART_OF', 'concept:the-plague-orders', 0.85],
    ['concept:the-term-of-days', 'PART_OF', 'concept:the-plague-orders', 0.85],
    ['concept:the-searchers-oath', 'PART_OF', 'concept:the-plague-orders', 0.8],
    ['concept:the-visitation', 'MENTIONS', 'loc:thornhythe', 0.5],
    ['concept:the-county-allowance', 'MENTIONS', 'fac:the-county-bench', 0.6],
    ['fac:the-corporation', 'SWORN_TO', 'concept:the-plague-orders', 0.9],
    ['fac:the-searchers', 'SWORN_TO', 'concept:the-searchers-oath', 0.95],
    ['char:ambrose-kell', 'SWORN_TO', 'concept:the-plague-orders', 0.85],
    ['char:simeon-roode', 'SWORN_TO', 'concept:the-plague-orders', 0.9],
    ['char:dorcas-sallow', 'SWORN_TO', 'concept:the-searchers-oath', 0.95],
    ['char:silence-bulmer', 'SWORN_TO', 'concept:the-searchers-oath', 0.6],
    ['char:isaac-trussel', 'SWORN_TO', 'concept:the-term-of-days', 0.8],
    ['char:prudence-gedge', 'SWORN_TO', 'concept:certificates-of-health', 0.85],
    ['char:bartholomew-quy', 'SWORN_TO', 'concept:the-visitation', 0.5],

    // ------------------------------------------------------- habitual places
    ['char:ambrose-kell', 'WORKS_AT', 'loc:the-guildhall', 0.9],
    ['char:hester-dowsett', 'WORKS_AT', 'loc:the-clerks-room', 0.9],
    ['char:elias-nunn', 'WORKS_AT', 'loc:holy-cross-church', 0.9],
    ['char:elias-nunn', 'LIVES_AT', 'loc:the-rectory', 0.7],
    ['char:gideon-havers', 'WORKS_AT', 'loc:the-town-granary', 0.9],
    ['char:ruth-swayne', 'WORKS_AT', 'loc:the-town-granary', 0.8],
    ['char:joan-larke', 'WORKS_AT', 'loc:the-three-cups', 0.9],
    ['char:bartholomew-quy', 'LIVES_AT', 'loc:the-surgeons-house', 0.9],
    ['char:ezra-stannard', 'WORKS_AT', 'loc:the-pest-house', 0.9],
    ['char:prudence-gedge', 'LIVES_AT', 'loc:the-toll-cottage', 0.9],
    ['char:phineas-gedge', 'LIVES_AT', 'loc:the-toll-cottage', 0.8],
    ['char:isaac-trussel', 'FOUND_AT', 'loc:the-far-watch', 0.85],
    ['char:jerome-wace', 'WORKS_AT', 'loc:the-causeway', 0.8],
    ['char:simeon-roode', 'LIVES_AT', 'loc:sluice-lane', 0.85],
    ['char:alice-roode', 'LIVES_AT', 'loc:sluice-lane', 0.85],
    ['char:grace-havers', 'LIVES_AT', 'loc:the-corder-house', 0.9],
    ['char:nathaniel-corder', 'LIVES_AT', 'loc:the-corder-house', 0.9],
    ['char:tabitha-nokes', 'LIVES_AT', 'loc:the-corder-house', 0.85],
    ['char:thankful-aveling', 'FOUND_AT', 'loc:the-sail-loft', 0.9],
    ['char:marget-skeat', 'MEETS_AT', 'loc:the-fish-shambles', 0.8],
    ['char:mercy-grimble', 'WORKS_AT', 'loc:the-fish-shambles', 0.8],
    ['char:tobias-grimble', 'MEETS_AT', 'loc:hollow-creek', 0.8],
    ['char:obadiah-pyke', 'WORKS_AT', 'loc:the-quay', 0.8],
    ['char:kit-swayne', 'FOUND_AT', 'loc:the-hoy-constant-hope', 0.9],
    ['char:oliver-kell', 'FOUND_AT', 'loc:the-saltings', 0.8],
    ['char:dorcas-sallow', 'MEETS_AT', 'loc:the-new-ground', 0.7],
    ['char:silence-bulmer', 'MEETS_AT', 'loc:the-new-ground', 0.6],

    // ----------------------------------------------------- what has happened
    ['event:the-hoy-came-up-the-creek', 'MENTIONS', 'loc:hollow-creek', 0.7],
    ['event:the-hoy-came-up-the-creek', 'MENTIONS', 'char:kit-swayne', 0.8],
    ['event:the-hoy-came-up-the-creek', 'MENTIONS', 'char:thankful-aveling', 0.8],
    ['event:the-hoy-came-up-the-creek', 'MENTIONS', 'item:the-lading-note', 0.7],
    ['event:the-mayors-burial', 'MENTIONS', 'char:ambrose-kell', 0.8],
    ['event:the-mayors-burial', 'MENTIONS', 'item:the-blank-certificates', 0.7],
    ['event:the-mayors-burial', 'MENTIONS', 'item:the-town-seal', 0.7],
    ['event:the-setting-of-the-watch', 'MENTIONS', 'fac:the-county-watch', 0.8],
    ['event:the-setting-of-the-watch', 'MENTIONS', 'loc:the-causeway', 0.8],
    ['event:the-setting-of-the-watch', 'MENTIONS', 'concept:certificates-of-health', 0.7],
    ['event:the-sealing-of-sluice-lane', 'MENTIONS', 'char:simeon-roode', 0.8],
    ['event:the-sealing-of-sluice-lane', 'MENTIONS', 'loc:the-corder-house', 0.8],
    ['event:the-sealing-of-sluice-lane', 'MENTIONS', 'char:grace-havers', 0.7],

    // ------------------------------------------------------------ membership
    ['char:ambrose-kell', 'LEADS', 'fac:the-corporation', 0.7],
    ['char:gideon-havers', 'MEMBER_OF', 'fac:the-corporation', 0.85],
    ['char:bartholomew-quy', 'MEMBER_OF', 'fac:the-corporation', 0.5],
    ['char:simeon-roode', 'SERVES', 'fac:the-corporation', 0.9],
    ['char:hester-dowsett', 'SERVES', 'fac:the-corporation', 0.6],
    ['char:elias-nunn', 'LEADS', 'fac:the-vestry', 0.7],
    ['char:ezra-stannard', 'MEMBER_OF', 'fac:the-vestry', 0.4],
    ['char:gideon-havers', 'LEADS', 'fac:the-quay-partners', 0.8],
    ['char:kit-swayne', 'MEMBER_OF', 'fac:the-quay-partners', 0.5],
    ['char:ruth-swayne', 'MEMBER_OF', 'fac:the-quay-partners', 0.4],
    ['char:dorcas-sallow', 'LEADS', 'fac:the-searchers', 0.75],
    ['char:silence-bulmer', 'MEMBER_OF', 'fac:the-searchers', 0.7],
    ['char:ezra-stannard', 'MEMBER_OF', 'fac:the-searchers', 0.6],
    ['char:isaac-trussel', 'LEADS', 'fac:the-county-watch', 0.9],
    ['char:jerome-wace', 'MEMBER_OF', 'fac:the-county-watch', 0.7],
    ['char:tobias-grimble', 'LEADS', 'fac:the-marsh-men', 0.7],
    ['char:mercy-grimble', 'MEMBER_OF', 'fac:the-marsh-men', 0.7],
    ['char:obadiah-pyke', 'MEMBER_OF', 'fac:the-marsh-men', 0.5],
    ['char:isaac-trussel', 'SERVES', 'fac:the-county-bench', 0.8],
    ['char:reuben-fowle', 'SERVES', 'fac:the-county-bench', 0.7],
    ['char:ambrose-kell', 'SERVES', 'fac:the-county-bench', 0.4],
    ['fac:the-corporation', 'TENANT_OF', 'fac:the-quay-partners', 0.6],
    ['fac:the-county-watch', 'HOSTILE_TO', 'fac:the-corporation', 0.5],
    ['fac:the-corporation', 'HOSTILE_TO', 'fac:the-county-watch', 0.4],
    ['fac:the-marsh-men', 'HOSTILE_TO', 'fac:the-county-watch', 0.6],
    ['fac:the-county-watch', 'WATCHES', 'loc:the-causeway', 0.85],
    ['fac:the-county-watch', 'WATCHES', 'loc:the-hoy-constant-hope', 0.6],
    ['fac:the-corporation', 'WATCHES', 'loc:sluice-lane', 0.7],

    // ------------------------------------------ cluster A: the Guildhall, inside
    ['char:ambrose-kell', 'RELIES_ON', 'char:hester-dowsett', 0.85],
    ['char:hester-dowsett', 'SERVES', 'char:ambrose-kell', 0.6],
    ['char:hester-dowsett', 'KEEPS_SECRET_FROM', 'char:ambrose-kell', 0.75],
    ['char:ambrose-kell', 'PROTECTS', 'char:hester-dowsett', 0.45],
    ['char:ambrose-kell', 'TRUSTS', 'char:simeon-roode', 0.75],
    ['char:simeon-roode', 'LOYAL_TO', 'char:ambrose-kell', 0.7],
    ['char:ambrose-kell', 'RELIES_ON', 'char:bartholomew-quy', 0.7],
    ['char:bartholomew-quy', 'KEEPS_SECRET_FROM', 'char:ambrose-kell', 0.7],
    ['char:bartholomew-quy', 'SERVES', 'char:ambrose-kell', 0.5],
    ['char:gideon-havers', 'RIVAL_OF', 'char:ambrose-kell', 0.8],
    ['char:ambrose-kell', 'SUSPECTS', 'char:gideon-havers', 0.35],
    ['char:simeon-roode', 'SUSPECTS', 'char:gideon-havers', 0.6],
    ['char:simeon-roode', 'HOSTILE_TO', 'char:gideon-havers', 0.5],
    ['char:gideon-havers', 'RELIES_ON', 'char:simeon-roode', 0.6],
    ['char:gideon-havers', 'BLACKMAILS', 'char:elias-nunn', 0.6],
    ['char:elias-nunn', 'INFORMS', 'char:ambrose-kell', 0.6],
    ['char:elias-nunn', 'WATCHES', 'char:gideon-havers', 0.4],
    ['char:elias-nunn', 'SUSPECTS', 'char:ezra-stannard', 0.6],
    ['char:hester-dowsett', 'HATES', 'char:gideon-havers', 0.6],
    ['char:gideon-havers', 'SUSPECTS', 'char:hester-dowsett', 0.5],
    ['char:elias-nunn', 'FRIENDLY_WITH', 'char:hester-dowsett', 0.5],
    ['char:hester-dowsett', 'FRIENDLY_WITH', 'char:elias-nunn', 0.65],
    ['char:bartholomew-quy', 'RIVAL_OF', 'char:marget-skeat', 0.7],
    ['char:bartholomew-quy', 'SUSPECTS', 'char:marget-skeat', 0.5],
    ['char:marget-skeat', 'RIVAL_OF', 'char:bartholomew-quy', 0.45],
    ['char:ambrose-kell', 'CORRESPONDS_WITH', 'fac:the-county-bench', 0.85],
    ['char:hester-dowsett', 'CORRESPONDS_WITH', 'fac:the-county-bench', 0.7],
    ['char:ambrose-kell', 'CORRESPONDS_WITH', 'char:isaac-trussel', 0.65],
    ['char:isaac-trussel', 'CORRESPONDS_WITH', 'char:ambrose-kell', 0.6],
    ['char:gideon-havers', 'EMPLOYS', 'char:ruth-swayne', 0.7],
    ['char:gideon-havers', 'PAYS', 'char:ezra-stannard', 0.6],
    ['char:gideon-havers', 'PAYS', 'char:silence-bulmer', 0.5],
    ['char:gideon-havers', 'DEALS_WITH', 'char:tobias-grimble', 0.6],
    ['char:gideon-havers', 'DEALS_WITH', 'char:reuben-fowle', 0.6],

    // ---------------------------------------------- cluster B: the water side
    ['char:kit-swayne', 'SIBLING_OF', 'char:ruth-swayne', 0.85],
    ['char:ruth-swayne', 'SIBLING_OF', 'char:kit-swayne', 0.85],
    ['char:kit-swayne', 'RELIES_ON', 'char:obadiah-pyke', 0.7],
    ['char:obadiah-pyke', 'KEEPS_SECRET_FROM', 'char:kit-swayne', 0.5],
    ['char:obadiah-pyke', 'INFORMS', 'char:joan-larke', 0.7],
    ['char:joan-larke', 'FRIENDLY_WITH', 'char:obadiah-pyke', 0.6],
    ['char:joan-larke', 'INFORMS', 'char:simeon-roode', 0.5],
    ['char:joan-larke', 'DEALS_WITH', 'char:mercy-grimble', 0.7],
    ['char:mercy-grimble', 'TRADES', 'char:joan-larke', 0.6],
    ['char:tobias-grimble', 'MARRIED_TO', 'char:mercy-grimble', 0.8],
    ['char:mercy-grimble', 'MARRIED_TO', 'char:tobias-grimble', 0.8],
    ['char:tobias-grimble', 'SUPPLIES', 'char:mercy-grimble', 0.75],
    ['char:tobias-grimble', 'SMUGGLES', 'char:gideon-havers', 0.6],
    ['char:obadiah-pyke', 'SMUGGLES', 'char:tobias-grimble', 0.5],
    ['char:ruth-swayne', 'KEEPS_SECRET_FROM', 'char:kit-swayne', 0.6],
    ['char:ruth-swayne', 'RELIES_ON', 'char:gideon-havers', 0.6],
    ['char:kit-swayne', 'OWES_MONEY_TO', 'char:gideon-havers', 0.7],
    ['char:nathaniel-corder', 'OWES_MONEY_TO', 'char:gideon-havers', 0.7],
    ['char:kit-swayne', 'HOSTILE_TO', 'char:isaac-trussel', 0.6],
    ['char:kit-swayne', 'KEEPS_SECRET_FROM', 'char:isaac-trussel', 0.75],
    ['char:joan-larke', 'SUSPECTS', 'char:kit-swayne', 0.55],
    ['char:joan-larke', 'CORRESPONDS_WITH', 'char:prudence-gedge', 0.6],
    ['char:prudence-gedge', 'CORRESPONDS_WITH', 'char:joan-larke', 0.65],
    ['char:bartholomew-quy', 'RELIES_ON', 'char:obadiah-pyke', 0.5],
    ['char:marget-skeat', 'SUPPLIES', 'char:joan-larke', 0.5],
    ['char:joan-larke', 'TRUSTS', 'char:marget-skeat', 0.6],
    ['char:marget-skeat', 'INFORMS', 'char:joan-larke', 0.5],

    // ------------------------------- cluster C: the barrier, the marsh, the dead
    ['char:prudence-gedge', 'PARENT_OF', 'char:phineas-gedge', 0.9],
    ['char:phineas-gedge', 'CHILD_OF', 'char:prudence-gedge', 0.9],
    ['char:phineas-gedge', 'INFORMS', 'char:prudence-gedge', 0.7],
    ['char:isaac-trussel', 'COMMANDS', 'char:jerome-wace', 0.8],
    ['char:jerome-wace', 'SERVES', 'char:isaac-trussel', 0.55],
    ['char:isaac-trussel', 'WATCHES', 'char:prudence-gedge', 0.65],
    ['char:prudence-gedge', 'KEEPS_SECRET_FROM', 'char:isaac-trussel', 0.75],
    ['char:prudence-gedge', 'INFORMS', 'char:isaac-trussel', 0.5],
    ['char:isaac-trussel', 'SUSPECTS', 'char:ambrose-kell', 0.7],
    ['char:isaac-trussel', 'CORRESPONDS_WITH', 'fac:the-county-bench', 0.8],
    ['char:isaac-trussel', 'HUNTS', 'char:oliver-kell', 0.4],
    ['char:isaac-trussel', 'RELIES_ON', 'char:reuben-fowle', 0.5],
    ['char:reuben-fowle', 'CORRESPONDS_WITH', 'fac:the-county-bench', 0.5],
    ['char:dorcas-sallow', 'MENTORS', 'char:silence-bulmer', 0.6],
    ['char:silence-bulmer', 'RELIES_ON', 'char:dorcas-sallow', 0.55],
    ['char:dorcas-sallow', 'INFORMS', 'char:bartholomew-quy', 0.7],
    ['char:bartholomew-quy', 'RELIES_ON', 'char:dorcas-sallow', 0.6],
    ['char:dorcas-sallow', 'SUSPECTS', 'char:ezra-stannard', 0.6],
    ['char:dorcas-sallow', 'SUSPECTS', 'char:tobias-grimble', 0.5],
    ['char:ezra-stannard', 'DEALS_WITH', 'char:dorcas-sallow', 0.5],
    ['char:ezra-stannard', 'KEEPS_SECRET_FROM', 'char:dorcas-sallow', 0.7],
    ['char:ezra-stannard', 'HOSTILE_TO', 'char:elias-nunn', 0.4],
    ['char:silence-bulmer', 'INFORMS', 'char:gideon-havers', 0.6],
    ['char:silence-bulmer', 'OWES_MONEY_TO', 'char:joan-larke', 0.4],
    ['char:dorcas-sallow', 'FRIENDLY_WITH', 'char:marget-skeat', 0.5],
    ['char:marget-skeat', 'TRUSTS', 'char:dorcas-sallow', 0.45],
    ['char:tobias-grimble', 'KEEPS_SECRET_FROM', 'char:dorcas-sallow', 0.7],
    ['char:prudence-gedge', 'PROTECTS', 'char:oliver-kell', 0.6],
    ['char:oliver-kell', 'RELIES_ON', 'char:prudence-gedge', 0.8],
    ['char:oliver-kell', 'CHILD_OF', 'char:ambrose-kell', 0.9],
    ['char:ambrose-kell', 'PARENT_OF', 'char:oliver-kell', 0.95],
    ['char:ambrose-kell', 'CORRESPONDS_WITH', 'char:oliver-kell', 0.85],
    ['char:oliver-kell', 'CORRESPONDS_WITH', 'char:ambrose-kell', 0.85],
    ['char:oliver-kell', 'PAYS', 'char:phineas-gedge', 0.4],
    ['char:jerome-wace', 'FRIENDLY_WITH', 'char:oliver-kell', 0.5],
    ['char:oliver-kell', 'FRIENDLY_WITH', 'char:jerome-wace', 0.4],
    ['char:hester-dowsett', 'CORRESPONDS_WITH', 'char:prudence-gedge', 0.45],

    // ------------------------- cluster D: Sluice Lane, and the girl in the loft
    ['char:simeon-roode', 'PARENT_OF', 'char:alice-roode', 0.9],
    ['char:alice-roode', 'CHILD_OF', 'char:simeon-roode', 0.9],
    ['char:simeon-roode', 'PROTECTS', 'char:alice-roode', 0.9],
    ['char:alice-roode', 'KEEPS_SECRET_FROM', 'char:simeon-roode', 0.9],
    ['char:alice-roode', 'PROTECTS', 'char:thankful-aveling', 0.85],
    ['char:thankful-aveling', 'RELIES_ON', 'char:alice-roode', 0.9],
    ['char:marget-skeat', 'PROTECTS', 'char:thankful-aveling', 0.6],
    ['char:thankful-aveling', 'TRUSTS', 'char:marget-skeat', 0.5],
    ['char:marget-skeat', 'FRIENDLY_WITH', 'char:alice-roode', 0.6],
    ['char:alice-roode', 'TRUSTS', 'char:marget-skeat', 0.7],
    ['char:jerome-wace', 'COURTS', 'char:alice-roode', 0.6],
    ['char:alice-roode', 'KEEPS_SECRET_FROM', 'char:jerome-wace', 0.7],
    ['char:jerome-wace', 'CORRESPONDS_WITH', 'char:alice-roode', 0.7],
    ['char:alice-roode', 'CORRESPONDS_WITH', 'char:jerome-wace', 0.55],
    ['char:obadiah-pyke', 'PROTECTS', 'char:thankful-aveling', 0.4],
    ['char:thankful-aveling', 'SUSPECTS', 'char:kit-swayne', 0.6],
    ['char:gideon-havers', 'PARENT_OF', 'char:grace-havers', 0.9],
    ['char:grace-havers', 'CHILD_OF', 'char:gideon-havers', 0.7],
    ['char:grace-havers', 'HATES', 'char:gideon-havers', 0.45],
    ['char:grace-havers', 'MARRIED_TO', 'char:nathaniel-corder', 0.8],
    ['char:nathaniel-corder', 'MARRIED_TO', 'char:grace-havers', 0.8],
    ['char:tabitha-nokes', 'SERVES', 'char:grace-havers', 0.7],
    ['char:grace-havers', 'RELIES_ON', 'char:tabitha-nokes', 0.8],
    ['char:tabitha-nokes', 'HATES', 'char:simeon-roode', 0.65],
    ['char:grace-havers', 'CORRESPONDS_WITH', 'char:gideon-havers', 0.6],
    ['char:gideon-havers', 'CORRESPONDS_WITH', 'char:grace-havers', 0.75],
    ['char:gideon-havers', 'PROTECTS', 'char:grace-havers', 0.5],
    ['char:simeon-roode', 'GUARDS', 'char:grace-havers', 0.5],
    ['char:marget-skeat', 'RELIES_ON', 'char:elias-nunn', 0.5],
    ['char:elias-nunn', 'FRIENDLY_WITH', 'char:marget-skeat', 0.45],
    ['char:elias-nunn', 'PROTECTS', 'char:tabitha-nokes', 0.4],
  ]),
  sheets: [
    // ------------------------------------------------- the three protagonists
    {
      entityId: 'char:ambrose-kell',
      identity: {
        goals: [
          'produce an account of Reuben Fowle that the bench will accept',
          'get the allowance restored to full weight',
          'get his son inside the barrier alive',
        ],
        wounds: [
          'he proposed the shutting up at the bench on the nineteenth, and nine doors were nailed on the twenty-second',
          'he buried the Mayor at night with six men and no bell',
        ],
        fears: [
          'that he has been acting as mayor without ever having been one',
          'that Oliver is already sick out there on the marsh',
        ],
        allegiances: ['the Corporation of Thornhythe', 'the town charter, as he understands it'],
        competencies: [
          'thirty years of aldermanic procedure',
          'weighing and pricing anything',
          'writing a letter that concedes nothing',
        ],
        secrets: [
          'he ordered the weekly bill kept low, and told Nunn it was to keep the county from despairing of them',
          'he has written to the bench accusing the county of sending the allowance short',
        ],
        arc: 'A procedural man discovering that procedure was the whole of his authority, and that it has gone.',
      },
      contract: {
        vows: [
          {
            id: 'the-seal',
            text: "set the town's seal to nothing the bench has not assented to",
            rank: 1,
            broken: false,
            brokenScene: null,
          },
          {
            id: 'the-open-weighing',
            text: "the town's corn is weighed in the open, before witnesses, every sack",
            rank: 2,
            broken: false,
            brokenScene: null,
          },
          {
            id: 'no-false-return',
            text: 'put nothing in a return to the bench that I know to be false',
            rank: 3,
            broken: false,
            brokenScene: null,
          },
        ],
        drives: ['hold the charter together until somebody with a writ arrives', 'be able to account for every death'],
        breakingPoint:
          'His son at the chain with the watch counting down, and a blank certificate and the seal both in the room.',
        costOfBreak:
          'Every paper he has sealed since the eleventh becomes forgery, and the four aldermen who died trusting him become his fault.',
      },
      voice: {
        diction:
          'Formal, careful, committee English. Numbers the parts of his reasoning aloud. Retreats into the wording of orders when pressed.',
        tics: [
          'says "as the orders have it" before doing something he doubts',
          'counts on his fingers when he is frightened',
          'calls people by their office, not their name',
        ],
        samples: [
          'The bench will require an account. I am the bench. You see my difficulty.',
          'As the orders have it, the house stays shut. I did not write the orders. I did read them aloud.',
          'Serjeant. How many were counted into that house, and how many are left in it?',
        ],
        never: ['raises his voice', 'says the word plague', 'admits he is not the Mayor'],
      },
      appearance: {
        description:
          'Fifty-seven, heavy-shouldered, a chandler\u2019s forearms gone slack. Grey stubble he has stopped shaving daily. Blinks slowly, as if translating.',
        attire:
          'A good black coat kept for the bench, the cuffs shiny; the aldermanic gown over it in the Guildhall, tallow-spotted at the hem.',
        markers: ['a burn-glaze across the back of the right hand from forty years of hot tallow'],
      },
    },
    {
      entityId: 'char:simeon-roode',
      identity: {
        goals: [
          'keep the tally true to the last name',
          'get Sluice Lane through the term of days without opening a door',
          'find out what his daughter is carrying up to the sail loft',
        ],
        wounds: [
          'he counted seven into the Corder house and has heard two voices at that shutter every morning since',
          'he nailed the door of the woman who taught him his letters',
        ],
        fears: ['that the tally is a confession', 'that Alice will be in the street when they cross his own door'],
        allegiances: ['the Corporation', 'the oath he took aloud in the market'],
        competencies: [
          'nailing and unnailing a door quietly',
          'counting a household by its noise',
          'twenty years of being the man nobody is glad to see',
        ],
        secrets: [
          'he has left the last house on the lane uncrossed for four days because he cannot make the term of days come out',
          'he opened the Corder shutter one inch on the ninth night and looked in',
        ],
        arc: 'A man who has made an exact record of nineteen deaths in order to avoid deciding whether he caused them.',
      },
      contract: {
        vows: [
          {
            id: 'my-house-first',
            text: 'the orders fall on my own house before any other in this town',
            rank: 1,
            broken: false,
            brokenScene: null,
          },
          {
            id: 'no-fee-for-a-door',
            text: 'take no money, no drink and no favour to nail a door or to open one',
            rank: 2,
            broken: false,
            brokenScene: null,
          },
          {
            id: 'count-aloud',
            text: 'count the living behind every door aloud, so the street hears the number',
            rank: 3,
            broken: false,
            brokenScene: null,
          },
        ],
        drives: [
          'be exact, because exactness is the only innocence available',
          'do it himself so nobody worse does it',
        ],
        breakingPoint:
          'His own daughter on the wrong side of a count, and the whole lane watching to see whether he says the number.',
        costOfBreak:
          'Nineteen doors stop being duty and become nineteen killings, and he is the only man who could testify to it.',
      },
      voice: {
        diction:
          'Flat, short, factual. Gives numbers before names. Says the unpleasant thing first so it is over with.',
        tics: [
          'states the count before he states anything else',
          'says "that is the orders" as a full sentence',
          'touches the tally in his coat when he is lying',
        ],
        samples: [
          'Seven in. Seven stays in. That is the orders.',
          'I do not decide the term. I count the days from the last death and the last death was Tuesday.',
          'You can stand at the window and talk to her. You cannot stand at the door.',
        ],
        never: ['apologises for the orders', 'takes money', 'uses a word longer than he needs'],
      },
      appearance: {
        description:
          'Forty-six, wiry, permanently stooped from carrying a ladder. Deep lines, close-cut grey hair, hands blackened with nail iron and vinegar.',
        attire:
          'The serjeant\u2019s leather coat with the town badge at the shoulder; a hammer, a purse of nails and a folded sheet in the inside pocket.',
        markers: [
          'two fingers of the left hand crushed flat years ago',
          'a vinegar-soaked cloth knotted at his throat',
        ],
      },
    },
    {
      entityId: 'char:prudence-gedge',
      identity: {
        goals: [
          'keep the book true so that the book is worth something later',
          'keep Phineas off the town side of the chain',
          'be the one person in this business nobody can accuse',
        ],
        wounds: [
          'she wrote a woman and three children out on the sixteenth and the far watch turned them back and they slept in the ditch',
          'her husband is in the new ground and she is not permitted to visit it',
        ],
        fears: ['that the book will be taken and read by men who were not here', 'that Phineas will start reading it'],
        allegiances: ['the pass book', 'both sides equally, which neither side believes'],
        competencies: [
          'a clear hand and an exact clock',
          'saying no in a way that cannot be argued with',
          'knowing which of two liars is lying about the smaller thing',
        ],
        secrets: [
          'Oliver Kell has been sleeping in her turf store since the nineteenth and is in the book as nothing at all',
          'Reuben Fowle crossed out at first light on the twenty-eighth and she wrote it, and the far watch has no such entry',
        ],
        arc: 'A clerk of a table who has understood that her book is the only true history of this year, and is about to be asked to spoil it.',
      },
      contract: {
        vows: [
          {
            id: 'every-soul-written',
            text: 'every soul that crosses this table is written in the book, the hour and the way, in ink',
            rank: 1,
            broken: false,
            brokenScene: null,
          },
          {
            id: 'read-no-letter',
            text: 'carry what is given me and read none of it',
            rank: 2,
            broken: false,
            brokenScene: null,
          },
          {
            id: 'no-side',
            text: 'take no fee from either side of the chain',
            rank: 3,
            broken: false,
            brokenScene: null,
          },
        ],
        drives: ['be believed later', 'keep the one honest surface in the parish honest'],
        breakingPoint: 'A child at the table at midnight whose crossing, written down, will hang somebody she owes.',
        costOfBreak:
          'One unwritten name and the book is a book of opinions; and it is the only evidence that Fowle ever left the town alive.',
      },
      voice: {
        diction:
          'Level, sparing, the phrasing of a woman used to being overheard by two enemies at once. Repeats the question back before answering.',
        tics: [
          'says the hour aloud as she writes it',
          'answers with what the book says rather than what she thinks',
          'wipes the table before anybody sets anything on it',
        ],
        samples: [
          'Half past six, going out. That is what I have. That is what I will say.',
          'You may put it on the table. I will not put my hand on it and I will not look at the fold.',
          'The captain asks me that every day. I tell him what I told you, and I tell you what I told him.',
        ],
        never: ['takes a side out loud', 'writes in pencil', 'lets anyone stand behind her chair'],
      },
      appearance: {
        description:
          'Thirty-eight, spare, upright from years of standing at a table. Chapped hands, ink on the second finger, eyes that go to the hour-glass first.',
        attire:
          'A grey stuff gown and a clean apron changed twice a day, and a widow\u2019s cap she has not taken off since August.',
        markers: ['a vinegar bowl and an hour-glass she carries between them like tools of office'],
      },
    },

    // ------------------------------------------------ the ones who push back
    {
      entityId: 'char:gideon-havers',
      identity: {
        goals: [
          'have the Corder house opened without any man being able to say he asked for it',
          'keep the tally out of the clerk\u2019s room until the sealing is over',
          'come out of the visitation owning the wharf outright',
        ],
        wounds: ['he signed his daughter into that marriage for a debt and she knows the figure'],
        fears: [
          'Grace dying behind a door he could have opened',
          'anyone laying the carrier\u2019s notes beside his tally',
        ],
        allegiances: ['the Quay Partners', 'his own house, in the long run'],
        competencies: ['weights and measures', 'lending at exactly the wrong moment', 'lawful-looking arithmetic'],
        secrets: [
          'nine quarters of the allowance in four weeks went over the saltings and was sold in the shambles',
          'he paid Stannard to write a name into the pit book that is not under the ground',
        ],
        arc: 'A man who began by shaving the wastage and has arrived somewhere he will not name even to himself.',
      },
      contract: {
        vows: [
          {
            id: 'the-house-of-havers',
            text: 'no child of mine goes into the ground before me',
            rank: 1,
            broken: false,
            brokenScene: null,
          },
          {
            id: 'lawful',
            text: 'nothing I do shall be provably unlawful',
            rank: 2,
            broken: false,
            brokenScene: null,
          },
        ],
        drives: ['be the man still standing when the writ arrives', 'get Grace out and be seen not to have tried'],
        breakingPoint: 'Being asked, in the open, at the bench, to produce the tally.',
        costOfBreak: 'He would rather be a murderer than a bankrupt, and he has begun to know that about himself.',
      },
      voice: {
        diction:
          'Warm, reasonable, mercantile. Puts everything as an offer. Uses the first person plural for anything unpopular.',
        tics: [
          'says "let us be practical" before a threat',
          'quotes a price for things that have no price',
          'agrees fully with whatever was just said and then reverses it',
        ],
        samples: [
          'Let us be practical. The town has bread for nine days. I have the key and you have the seal.',
          'Wastage, alderman. Rats and weather. You have kept a granary; you know what it comes to.',
          'She is my daughter. I am not permitted to want her out. Read the orders to me again.',
        ],
        never: ['raises his voice', 'signs anything first', 'says the word profit'],
      },
      appearance: {
        description:
          'Fifty-two, broad and well-fed in a town that is not, high colour, very clean hands. Smiles with the lower half of his face.',
        attire: 'Good brown broadcloth, a silver-topped stick, and the granary key on a cord inside his shirt.',
        markers: ['the key cord has worn a permanent red line across the back of his neck'],
      },
    },
    {
      entityId: 'char:isaac-trussel',
      identity: {
        goals: [
          'keep the chain shut for the full term with nobody killed at it',
          'account to the bench for a carrier who went in and did not come out',
          'be paid off and gone before the frosts',
        ],
        wounds: ['he held a line at a Dutch harbour and knows exactly what a mob at a barrier looks like'],
        fears: ['that his own men will start selling passage', 'having to fire on farmers'],
        allegiances: ['the County Bench', 'the fourteen men he brought with him'],
        competencies: ['holding a position with too few men', 'written orders', 'reading a crowd at fifty yards'],
        secrets: [
          'his standing order permits him to let a man out with a certificate, and he has not told the town that',
          'two of his fourteen have already been paid to look away and he does not know which',
        ],
        arc: 'A soldier discovering that a siege where nobody shoots is still a siege, and he is the besieger.',
      },
      contract: {
        vows: [
          {
            id: 'the-chain',
            text: 'the chain does not open before the term of days is out',
            rank: 1,
            broken: false,
            brokenScene: null,
          },
          {
            id: 'no-shot',
            text: 'no man of mine fires on an unarmed subject of the King',
            rank: 2,
            broken: false,
            brokenScene: null,
          },
        ],
        drives: ['discharge the commission exactly as written', 'get out with his name intact'],
        breakingPoint: 'A hundred people on the causeway at once and fourteen men, and the bench three days away.',
        costOfBreak:
          'He becomes the officer who let the sickness out, which is the only crime this county will remember.',
      },
      voice: {
        diction: 'Clipped, military, courteous to strangers and short with his own. Quotes his commission by clause.',
        tics: [
          'gives the date of the order he is obeying',
          'says "I am not empowered" instead of no',
          'addresses townspeople collectively, never individually',
        ],
        samples: [
          'I am not empowered to discuss the term. I am empowered to keep this road.',
          'Your carrier went in on the twenty-seventh. My book has him in. It does not have him out. Explain that to me.',
          'Stand off the chain. I will say it once more and then I will have said it twice.',
        ],
        never: ['crosses onto the town side', 'takes food from the town', 'uses a man\u2019s Christian name'],
      },
      appearance: {
        description:
          'Forty-three, upright, weather-cracked, a soldier\u2019s economy of movement. Keeps four paces between himself and everybody.',
        attire: 'A buff coat gone grey, a sash of no regiment, and his commission in an oilskin inside the breast.',
        markers: ['a musket-ball scar under the right jaw that pulls his mouth when he speaks'],
      },
    },
    {
      entityId: 'char:bartholomew-quy',
      identity: {
        goals: [
          'keep his salary and his pass',
          'be known in the city as the surgeon who kept a town at thirty-four dead',
          'never be asked in writing whether the shutting up works',
        ],
        wounds: ['he has attended forty-one deaths and touched perhaps six of them'],
        fears: ['the searchers being questioned separately from him', 'Marget Skeat being right'],
        allegiances: ['the Corporation, which pays him', 'his own reputation, which pays him better'],
        competencies: ['anatomy', 'a beautiful hand', 'saying two things in one sentence'],
        secrets: [
          'he wrote in a private letter that shutting the well in with the sick is the surest way to kill them, and countersigns the returns regardless',
          'he has never once entered the pest house',
        ],
        arc: 'A clever man who has kept his conscience in a drawer with his correspondence and is about to have the drawer opened.',
      },
      contract: {
        vows: [
          {
            id: 'do-no-harm',
            text: 'give no counsel I believe will kill the patient',
            rank: 1,
            broken: false,
            brokenScene: null,
          },
          {
            id: 'sign-truly',
            text: 'countersign no return I have not myself viewed',
            rank: 2,
            broken: false,
            brokenScene: null,
          },
        ],
        drives: ['be thought well of at a distance', 'not be in the room when it is decided'],
        breakingPoint:
          'Being asked to state, at the bench, in front of the searchers, whether the shutting up saves lives.',
        costOfBreak: 'The letters exist in another man\u2019s hands, and they are dated.',
      },
      voice: {
        diction:
          'Educated, fluent, faintly performing. Latin tags when nervous. Explains at length in order not to answer.',
        tics: [
          'begins with "the authorities are divided"',
          'describes symptoms rather than people',
          'defers to the orders and then to the bench and then to God',
        ],
        samples: [
          'The authorities are divided, alderman, and I am a surgeon and not a divine.',
          'I viewed the return. I did not view the body. Those are different acts and the sheet asks only for one.',
          'She sells fennel water and coloured spirit. I do not say it does nothing. I say it does not do that.',
        ],
        never: ['enters a shut house', 'writes an opinion he would sign at the bench', 'contradicts Kell in company'],
      },
      appearance: {
        description:
          'Thirty-nine, pale, well-kept, soft-handed for the trade. Stands with his weight on the back foot. Beautifully shaved every day of the visitation.',
        attire:
          'A dark coat and a linen mask soaked in rose vinegar that he holds rather than wears, and gloves he does not remove indoors.',
        markers: ['a silver pomander on a chain, always in the right hand'],
      },
    },

    // ------------------------------------------- the ones who hold a document
    {
      entityId: 'char:hester-dowsett',
      identity: {
        goals: ['be indispensable until the writ comes', 'keep the three blanks', 'be paid her husband\u2019s arrears'],
        wounds: ['she wrote the entry for her own husband in the fair copy because nobody else could'],
        fears: ['a new clerk arriving who can read the shorthand'],
        competencies: [
          'her husband\u2019s shorthand',
          'a fair copy in an hour',
          'knowing which book contradicts which',
        ],
        secrets: [
          'three certificates of health, signed and sealed by the dead Mayor, are sewn into the lining of her workbag',
          'the corn entries in the old books do not reconcile and she has known it for two weeks',
        ],
        arc: 'A widow who has discovered that being the only reader of a language is a kind of office.',
      },
      contract: {
        vows: [
          {
            id: 'fair-copy',
            text: 'copy what is given me exactly, and mark in the margin what I was told to leave out',
            rank: 2,
            broken: false,
            brokenScene: null,
          },
        ],
        drives: ['survive the year with something to sell', 'be owed a favour by whoever comes out on top'],
        breakingPoint: 'Being told to burn a book.',
        costOfBreak: 'She would have nothing left to be necessary for.',
      },
      voice: {
        diction: 'Precise, quiet, faintly amused. Corrects dates. Answers questions about books, never about people.',
        tics: ['gives the folio number', 'says "in whose hand?" before anything else'],
        samples: [
          'In whose hand? Because there are two counts, and only one of them is his.',
          'I can copy that fair by three. I cannot make it agree with the granary book, and it does not.',
        ],
        never: ['volunteers what she has not been asked', 'shows anyone the workbag'],
      },
      appearance: {
        description:
          'Forty-four, small, very still, ink to the knuckles. Reading eyes that have been ruined in candlelight.',
        attire: 'Widow\u2019s black, unrelieved, and a canvas workbag she does not put down.',
        markers: ['spectacles on a cord; a permanent groove on the second finger from the pen'],
      },
    },
    {
      entityId: 'char:elias-nunn',
      identity: {
        goals: [
          'bury every one of them by name',
          'get the register out of the town whole if the town does not survive',
          'stop being the man who copies out a false bill',
        ],
        wounds: ['he has buried sixty-one people in six weeks and read the office over perhaps twenty of them'],
        fears: ['the register being taken', 'Havers saying out loud what he has already said quietly'],
        competencies: ['the office for the dead from memory', 'a clear hand', 'sitting with the dying'],
        secrets: [
          'the bill he sends the bench is short by twenty-seven and he wrote both numbers himself',
          'he has entered four burials in the register that Stannard cannot account for in the pit book',
        ],
        arc: 'A young clergyman finding out that the sin available to him is clerical, and that he has already committed it.',
      },
      contract: {
        vows: [
          {
            id: 'named',
            text: 'no soul of this parish goes into the ground unnamed and unentered',
            rank: 1,
            broken: false,
            brokenScene: null,
          },
          {
            id: 'obedience-to-the-bench',
            text: 'render to the Corporation the accounts it requires of me',
            rank: 4,
            broken: false,
            brokenScene: null,
          },
        ],
        drives: ['stay when he could have gone', 'keep one true record of this'],
        breakingPoint: 'A cart of unentered dead at the new ground at first light and Stannard already digging.',
        costOfBreak: 'The register becomes as worthless as the bill, and it is all he has done here.',
      },
      voice: {
        diction: 'Young, tired, plain. Reaches for scripture and stops himself. Apologises for the length of things.',
        tics: ['says "forgive me" as punctuation', 'gives the date of a burial rather than the name of the dead'],
        samples: [
          'Forgive me. The bill says thirty-four. The register says sixty-one. Both are in my hand.',
          'I will not read the office over a number. Tell me who she was and I will do it at the west door.',
        ],
        never: ['refuses to attend a death', 'defends the bill'],
      },
      appearance: {
        description:
          'Thirty-one, gaunt, hollowed out, hair coming loose. Hands scrubbed raw. Has slept in the church porch since September.',
        attire: 'A rusty black cassock with the hem cut short for the marsh, and pattens for the new ground.',
        markers: ['a bandage on the left palm from the spade'],
      },
    },
    {
      entityId: 'char:dorcas-sallow',
      identity: {
        goals: ['view every body herself', 'be paid the twopence', 'have someone believe her about the carrier'],
        fears: ['being blamed for the returns when the bench finally comes'],
        competencies: [
          'thirty years of laying out the dead',
          'knowing the tokens from the other marks',
          'telling a drowning from a strangling',
        ],
        secrets: [
          'she returned Reuben Fowle as visitation and there was not a token on him anywhere',
          'she has never once been asked to explain a return, and Quy signs them in the doorway',
        ],
        arc: 'A pauper with the power to condemn a household, and no power whatever to be listened to.',
      },
      contract: {
        vows: [
          {
            id: 'view-every-body',
            text: 'view every corpse myself, with my own hands, before I say what it died of',
            rank: 1,
            broken: false,
            brokenScene: null,
          },
          {
            id: 'no-fee-to-change',
            text: 'take no fee to alter a report',
            rank: 2,
            broken: false,
            brokenScene: null,
          },
        ],
        drives: ['be exact because nobody expects her to be', 'eat this week'],
        breakingPoint: 'Being told by the surgeon, in front of Silence, that she saw what she did not see.',
        costOfBreak: 'Every return she has sworn for thirty years goes with it, and she has nothing else.',
      },
      voice: {
        diction: 'Blunt, physical, unembarrassed. Describes bodies the way a carpenter describes wood.',
        tics: ['begins with what she touched', 'calls the surgeon "the gentleman"'],
        samples: [
          'No tokens. Not in the groin, not under the arm, not behind the ear. I looked in all three.',
          'The gentleman signed it at the door without coming in. You may ask him what he saw. I will tell you what I felt.',
        ],
        never: ['goes into the street without the wand', 'says a house is clean when it is not'],
      },
      appearance: {
        description:
          'Sixty-one, bent, strong in the forearms, a face weathered past reading. Smells of vinegar and rosemary at all times.',
        attire:
          'A patched russet gown, a white band on the sleeve marking her office, and the red wand always in hand.',
        markers: ['the sleeve band and the four-foot red rod, visible at a hundred yards'],
      },
    },
    {
      entityId: 'char:ezra-stannard',
      identity: {
        goals: ['be paid for every hole', 'keep the pit book the only record that matters', 'not be searched'],
        fears: ['the curate laying the register beside the pit book'],
        competencies: ['digging in marsh ground', 'keeping people out of the pest house', 'a plausible entry'],
        secrets: [
          'he was paid to enter a girl off the London hoy as buried on the second of September, and she is alive in the town',
          'four in his pit book are not in the register and two in the register are not under the ground',
        ],
        arc: 'A man who has learned that the only thing anybody checks is the book, and has stopped checking the ground.',
      },
      contract: {
        vows: [
          {
            id: 'the-book-is-the-book',
            text: 'whatever is written in the pit book stands, and I will swear to it',
            rank: 2,
            broken: false,
            brokenScene: null,
          },
        ],
        drives: ['be indispensable and unexamined', 'be paid in coin, before'],
        breakingPoint: 'A grave being opened in front of witnesses.',
        costOfBreak: 'He would hang, and he has done the arithmetic on that already.',
      },
      voice: {
        diction:
          'Slow, agreeable, evasive. Answers with the weather and the ground. Repeats your question back wrongly.',
        tics: ['talks about the water table', 'says "it is all wrote down" as an answer to anything'],
        samples: [
          'It is all wrote down, curate. Second of September. You are welcome to look at the page.',
          'Ground\u2019s wet out there. You would not want it opened. Nobody would.',
        ],
        never: ['lets anyone into the pest house alone', 'says a number he has not written first'],
      },
      appearance: {
        description:
          'Fifty, thick through the shoulders, marsh mud to the thigh permanently. Missing most of his teeth on the left.',
        attire: 'Tarred canvas, a leather apron, boots to the knee, and the pit book in an oilskin under the apron.',
        markers: ['a broken nose set crooked; hands stained the colour of the marsh'],
      },
    },
    {
      entityId: 'char:marget-skeat',
      identity: {
        goals: [
          'keep her house off the shutting-up list',
          'get the girl in the loft to the marsh road before she is found',
          'be paid in bread, not coin',
        ],
        fears: ['being taken for a witch, which has happened to her before in another parish'],
        competencies: [
          'who in this town is sick and hiding it',
          'fennel water, plague water, and telling one fever from another',
          'going anywhere unnoticed',
        ],
        secrets: [
          'she has been dressing Thankful Aveling\u2019s hand in the sail loft since the fourth of September',
          'she knows the Corder house has two living in it and has told nobody who would act on it',
        ],
        arc: 'The town\u2019s real physician, who cannot say so and would be hanged for the saying.',
      },
      contract: {
        vows: [
          {
            id: 'never-refuse',
            text: 'refuse nobody who comes to my door, and name no one who came',
            rank: 1,
            broken: false,
            brokenScene: null,
          },
        ],
        drives: ['keep her people alive', 'stay beneath the notice of every office in this town'],
        breakingPoint: 'Being offered her own safety in exchange for a name.',
        costOfBreak: 'Nobody would come to her door again, and they would still hang her.',
      },
      voice: {
        diction: 'Warm, quick, deflecting. Talks in remedies. Never says a name if a description will do.',
        tics: ['offers something to drink before answering', 'calls everybody "my duck"'],
        samples: [
          'A young person. That is all I will say to you, and I have said too much of it.',
          'The gentleman charges four shillings to stand in the doorway. I charge a loaf to come in.',
        ],
        never: ['gives a name', 'claims to cure the visitation'],
      },
      appearance: {
        description:
          'Fifty-eight, small and brisk, a face made almost entirely of lines. Moves fast and low along walls.',
        attire:
          'Layers of much-mended wool, a basket of bottles and dried stalks, a shawl over the head in all weather.',
        markers: ['a badly healed burn up the inside of the left arm'],
      },
    },

    // ------------------------------ Sluice Lane, and the girl who is not on a list
    {
      entityId: 'char:alice-roode',
      identity: {
        goals: ['keep Thankful fed and unfound', 'get her onto the marsh road before her father counts the loft'],
        fears: ['her father asking her directly, because she cannot lie to him twice'],
        competencies: ['her father\u2019s habits to the quarter-hour', 'a plain hand and a plausible errand'],
        secrets: ['she took the sail-loft key off his belt while he slept and had it copied at the smith\u2019s'],
        arc: 'A dutiful girl who has found the one thing she will be disobedient about.',
      },
      contract: {
        vows: [
          {
            id: 'i-will-not-give-her-up',
            text: 'I will not give her up, to my father or to anyone',
            rank: 1,
            broken: false,
            brokenScene: null,
          },
        ],
        drives: ['be worth something to somebody', 'not become her father'],
        breakingPoint: 'Her father standing at the bottom of the loft ladder with the tally out.',
        costOfBreak: 'The girl would be hanged for bringing it in, and Alice would have said the word that did it.',
      },
      voice: {
        diction: 'Careful, level, too quick to explain. Uses errands as sentences.',
        tics: ['names an errand before she is asked', 'says "only" a great deal'],
        samples: [
          'Only the canvas, Father. Only to see the canvas is dry.',
          'You count houses. You have never once counted this one.',
        ],
        never: ['says the girl\u2019s name aloud outdoors'],
      },
      appearance: {
        description: 'Twenty, thin, dark-haired, hands red from carrying hot things. Walks fast with her head down.',
        attire: 'A brown workaday gown, a shawl, and a covered basket at all hours of the day.',
        markers: ['a copied iron key on a bootlace under her bodice'],
      },
    },
    {
      entityId: 'char:thankful-aveling',
      identity: {
        goals: ['get out of the loft', 'reach an aunt at Wivenford', 'not be the reason nine doors were nailed'],
        wounds: ['she watched her father die in the hold three days out of London and Swayne put him over the side'],
        fears: ['being named as the one who brought it', 'Alice being taken with her'],
        competencies: ['reading and a good hand', 'six weeks of absolute silence'],
        secrets: ['she is entered in the pit book as buried on the second of September and she has seen the page'],
        arc: 'A girl who has been officially dead for six weeks and is beginning to see the use of it.',
      },
      contract: {
        vows: [
          {
            id: 'not-alice',
            text: 'whatever comes of me, Alice Roode is not in it',
            rank: 1,
            broken: false,
            brokenScene: null,
          },
        ],
        drives: ['live', 'be somebody\u2019s again'],
        breakingPoint: 'Being offered a certificate for the price of Alice\u2019s name.',
        costOfBreak: 'She would go out through the chain alone and know exactly what she paid.',
      },
      voice: {
        diction: 'London, quick, quieter than she wants to be. Whispers even when it is safe.',
        tics: ['asks what day it is', 'starts sentences over'],
        samples: [
          'What day. Just tell me the day and I will stop asking.',
          'I am in their book as buried. I have read my own entry. It is a very neat hand.',
        ],
        never: ['goes near the loft window in daylight'],
      },
      appearance: {
        description:
          'Nineteen, city-pale gone paler, cropped hair growing back unevenly after a fever. Very thin at the wrists.',
        attire: 'A borrowed marsh-country gown too big for her, and no shoes, because shoes are heard on boards.',
        markers: ['a healing cut across the left palm from the hoy\u2019s rigging'],
      },
    },
    {
      entityId: 'char:grace-havers',
      identity: {
        goals: ['get Tabitha out even if she does not get out herself', 'make her father say it in writing'],
        wounds: ['four of the seven died in the front room in eight days and she washed all four'],
        fears: ['Nathaniel dying and the term of days beginning again from him'],
        competencies: ['nursing', 'a clear voice through a shutter', 'her father\u2019s exact weaknesses'],
        secrets: ['she has been writing the true count of the house on paper and pushing it under the door'],
        arc: 'A woman inside a sealed house who has worked out that the only weapon left to her is an accurate number.',
      },
      contract: {
        vows: [
          {
            id: 'the-true-count',
            text: 'I will call the true count of this house every morning, however long it takes',
            rank: 1,
            broken: false,
            brokenScene: null,
          },
        ],
        drives: ['be counted', 'outlive the term'],
        breakingPoint: 'Being offered the door open on condition she says the count was seven.',
        costOfBreak: 'Nobody would ever again believe a voice from behind a shutter in this town.',
      },
      voice: {
        diction: 'Clear, carrying, deliberately unhysterical. Says numbers first because numbers are believed.',
        tics: ['opens with the count and the day', 'uses her father\u2019s trade language at him'],
        samples: [
          'Ninth day. Two living. Two, serjeant, not seven. Write it as two.',
          'You weigh sacks for a living, Father. Weigh this one.',
        ],
        never: ['begs', 'says she is well when she is not'],
      },
      appearance: {
        description: 'Twenty-three, hollow-eyed at the shutter, hair tied back hard. Voice steadier than her hands.',
        attire: 'A dark gown worn nine days without changing, sleeves pinned back for nursing.',
        markers: ['seen only as a face and two hands in a shutter gap four inches wide'],
      },
    },
    {
      entityId: 'char:tabitha-nokes',
      identity: {
        goals: ['get out', 'have somebody write her name down as living'],
        fears: ['being put in the pest house instead of let out'],
        competencies: ['a voice that carries the length of Sluice Lane'],
      },
      contract: {
        vows: [
          {
            id: 'stay-with-her',
            text: 'I do not leave her in this house alone',
            rank: 2,
            broken: false,
            brokenScene: null,
          },
        ],
        drives: ['be believed'],
        breakingPoint: 'A gap in the boards wide enough to get through by herself.',
        costOfBreak: 'She has already thought about it once, and hates that she did.',
      },
      voice: { diction: 'Loud, aggrieved, unstoppable once started. Names the watchmen individually.' },
      appearance: { description: 'Thirty-five, broad, red-faced from shouting through a shutter for nine days.' },
    },
    {
      entityId: 'char:nathaniel-corder',
      identity: {
        goals: ['not die in front of his wife'],
        fears: ['that the term of days will restart from him'],
        secrets: ['he has been telling Grace he is mending and he is not'],
      },
      contract: {
        vows: [
          {
            id: 'the-debt',
            text: 'I pay Havers every farthing before I die',
            rank: 3,
            broken: false,
            brokenScene: null,
          },
        ],
        drives: ['last past the term'],
        breakingPoint: 'The eleventh day.',
        costOfBreak: 'The count starts again and Grace stays in.',
      },
      voice: { diction: 'Wrecked, brief, apologetic. Two or three words at a time, then nothing.' },
      appearance: {
        description: 'Twenty-nine, ropemaker\u2019s hands, grey as tallow, propped against the front-room wall.',
      },
    },

    // ----------------------------------------------- the water side and the marsh
    {
      entityId: 'char:joan-larke',
      identity: {
        goals: ['keep the back room open', 'know first', 'be owed by both sides'],
        competencies: ['hearing things', 'valuing information to the penny', 'never quite lying'],
        secrets: ['she has known since September that three came ashore at Hollow Creek and only two were buried'],
      },
      contract: {
        vows: [
          {
            id: 'no-name-for-money',
            text: 'I sell what I heard, never who said it',
            rank: 2,
            broken: false,
            brokenScene: null,
          },
        ],
        drives: ['be useful to whoever wins'],
        breakingPoint: 'The serjeant standing in her back room with the tally out and her licence in his other hand.',
        costOfBreak: 'The back room empties and she is an alehouse keeper in a town with no drinkers.',
      },
      voice: { diction: 'Chatty, shrewd, cheerfully mercenary. Prices things mid-sentence.' },
      appearance: {
        description: 'Forty-eight, sharp-eyed, a publican\u2019s stoutness, rings she has not sold yet.',
        attire: 'Good wool under a stained apron, and a bunch of keys at the waist.',
      },
    },
    {
      entityId: 'char:kit-swayne',
      identity: {
        goals: ['get the Constant Hope released', 'have the lading note stand as entered'],
        fears: ['the girl being found alive in the town'],
        competencies: ['the creek at any state of tide', 'a clean set of papers'],
        secrets: ['he landed three at Hollow Creek at night on the twenty-sixth, and one of them was already sick'],
      },
      contract: {
        vows: [{ id: 'the-ship', text: 'the ship comes first, always', rank: 1, broken: false, brokenScene: null }],
        drives: ['sail before the frosts', 'not hang for two shillings a head'],
        breakingPoint: 'The customs strongbox being opened in front of Trussel.',
        costOfBreak: 'He would lose the hoy, which is the only thing he owns and the only thing he is.',
      },
      voice: { diction: 'Coastal, flat, contemptuous of landsmen. Talks in tides and drafts.' },
      appearance: {
        description: 'Thirty-four, sun-cured, a seaman\u2019s stance on a still deck. Shouts across water from habit.',
        attire: 'Tarred slops, a knitted cap, a knife on a lanyard.',
      },
    },
    {
      entityId: 'char:ruth-swayne',
      identity: {
        goals: ['keep her place at the granary', 'get her brother off the water before he is caught'],
        secrets: ['she copies the tally fair and has kept the foul draft with the true figures in it'],
      },
      contract: {
        vows: [
          {
            id: 'fair-copy-truly',
            text: 'I copy what is set before me and I keep the draft',
            rank: 2,
            broken: false,
            brokenScene: null,
          },
        ],
        drives: ['be paid, and be safe'],
        breakingPoint: 'Havers asking for the drafts back.',
        costOfBreak: 'She is the only witness to the arithmetic and she would have burned herself.',
      },
      voice: { diction: 'Neat, guarded, answers exactly the question asked and no more.' },
      appearance: { description: 'Twenty-seven, plain-dressed, flour in the seams, ink on the right cuff.' },
    },
    {
      entityId: 'char:obadiah-pyke',
      identity: {
        goals: ['a penny a crossing', 'know what is in the letters'],
        competencies: ['the creek in fog', 'unfolding and refolding a letter'],
      },
      voice: { diction: 'Sly, cheerful, talks about the weather to change the subject.' },
      appearance: { description: 'Forty-one, bandy, permanently wet to the knee, one eye clouded.' },
    },
    {
      entityId: 'char:tobias-grimble',
      identity: {
        goals: ['get the flour in and the money out', 'never be seen on the sea wall'],
        secrets: [
          'he found Reuben Fowle face down on his own path and moved him half a mile before the searchers came',
        ],
      },
      voice: { diction: 'Few words, all of them about ground, tide and light.' },
      appearance: { description: 'Thirty-six, lean, marsh-coloured clothes, a long fowling piece he never puts down.' },
    },
    {
      entityId: 'char:mercy-grimble',
      identity: { goals: ['four times the price and no argument'], competencies: ['a stall, a scale and a hard face'] },
      voice: { diction: 'Loud, unashamed, argues the fairness of her prices unprompted.' },
      appearance: { description: 'Thirty-three, broad, flour to the elbow, a vinegar bowl for the coins.' },
    },

    // --------------------------------------------------- the barrier, and outside
    {
      entityId: 'char:jerome-wace',
      identity: {
        goals: ['his eight pence a day', 'Alice Roode', 'his mother out of Sluice Lane'],
        fears: ['being ordered to stop his own mother at the chain'],
        secrets: ['he never entered Reuben Fowle in the far watch book, because he was asleep, and has let it stand'],
      },
      contract: {
        vows: [
          {
            id: 'the-post',
            text: 'I keep the post I am set, whoever comes down the road',
            rank: 2,
            broken: false,
            brokenScene: null,
          },
        ],
        drives: ['be a man with wages', 'not be despised on both sides of the chain'],
        breakingPoint: 'Alice at the chain at night.',
        costOfBreak:
          'He is a Thornhythe man who took the county\u2019s coin; there is no version of him that is forgiven.',
      },
      voice: { diction: 'Young, defensive, over-explains his orders. Slips into local speech when rattled.' },
      appearance: { description: 'Twenty-four, raw-boned, a borrowed buff coat too big at the shoulders.' },
    },
    {
      entityId: 'char:silence-bulmer',
      identity: {
        goals: ['twopence a corpse', 'not be sworn at by the surgeon again'],
        secrets: ['Havers has paid her twice to say a thing she did not see'],
      },
      voice: { diction: 'Mumbled, agrees with whoever spoke last, repeats the phrase she was given.' },
      appearance: { description: 'Twenty-two, undersized, the searcher\u2019s white sleeve band worn like a bandage.' },
    },
    {
      entityId: 'char:phineas-gedge',
      identity: { goals: ['a farthing a letter', 'be trusted with a real one'] },
      voice: { diction: 'Eleven, fast, repeats messages word-perfect and understands about half.' },
      appearance: { description: 'Eleven, small for it, barefoot on the sea wall in all weather.' },
    },
    {
      entityId: 'char:oliver-kell',
      identity: {
        goals: ['get inside the barrier to his father', 'not be taken for a Londoner and driven off'],
        wounds: ['he was turned back at the chain by a man he went to school with'],
        fears: ['his father dying while he is a half mile off across the marsh'],
        secrets: ['he came out of London the week the bills went over three thousand, and has told nobody that'],
      },
      contract: {
        vows: [
          {
            id: 'get-in',
            text: 'I do not leave this marsh while my father is in that town',
            rank: 2,
            broken: false,
            brokenScene: null,
          },
        ],
        drives: ['be let in', 'be of some use from outside'],
        breakingPoint: 'A blank certificate offered to him with his own name to write in.',
        costOfBreak: 'His father sealed it, and everything his father has held together goes with it.',
      },
      voice: { diction: 'London polish over Essex vowels, tired, arguing his case before anyone objects.' },
      appearance: { description: 'Twenty-five, unshaven, a good coat ruined by three weeks of marsh, boots split.' },
    },
  ],
  scenarios: [
    // The mystery. Not a detective — an officer served with a precept he cannot
    // answer, in a town where no coroner may enter and no jury may assemble.
    {
      id: 'a-true-account-of-the-dead',
      title: 'A True Account of the Dead',
      premise: `The county's carrier went in over the causeway on the twenty-seventh of September with the
week's allowance and did not come out. He was found on the saltings four days later with no mark of the
sickness on him, and the searchers returned him as visitation, and the surgeon signed it at the door.
Now a precept has come down the causeway: render a true account of Reuben Fowle, or the allowance stops
and the watch stays until spring.

You are Ambrose Kell, senior alderman, acting as mayor because nobody else is left to. You may not hold
an inquest, because gatherings are forbidden by the orders you yourself read aloud. You may not send for
a coroner, because no coroner will come inside the chain. You have a seal you swore never to use without
the assent of a bench that no longer exists, a corn tally you have never seen, and a son sleeping in a
turf store a mile out on the marsh.`,
      playerCharacterId: 'char:ambrose-kell',
      openingLocationId: 'loc:the-guildhall',
      openingScene: 'The precept, read twice',
      focus: {
        'char:ambrose-kell': 'focal',
        'char:gideon-havers': 'focal',
        'char:isaac-trussel': 'focal',
        'char:hester-dowsett': 'focal',
        'char:dorcas-sallow': 'focal',
        'char:reuben-fowle': 'focal',
        'item:the-corn-tally': 'focal',
        'item:the-town-seal': 'focal',
        'loc:the-guildhall': 'focal',
        'char:simeon-roode': 'principal',
        'char:bartholomew-quy': 'principal',
        'char:elias-nunn': 'principal',
        'char:prudence-gedge': 'principal',
        'char:oliver-kell': 'principal',
        'char:ezra-stannard': 'principal',
        'char:tobias-grimble': 'principal',
        'item:the-pass-book': 'principal',
        'item:the-weekly-bill': 'principal',
        'concept:the-county-allowance': 'principal',
        'loc:the-clerks-room': 'principal',
        'loc:the-toll-cottage': 'principal',
        'char:ruth-swayne': 'supporting',
        'char:jerome-wace': 'supporting',
        'char:silence-bulmer': 'supporting',
        'char:joan-larke': 'supporting',
        'char:mercy-grimble': 'background',
        'char:thankful-aveling': 'background',
        'char:phineas-gedge': 'background',
      },
      conditions: [
        {
          entityId: 'char:ambrose-kell',
          locationId: 'loc:the-guildhall',
          mood: 'outwardly procedural, privately frantic',
          inventory: ['the precept from the bench', 'the town seal in a wash-leather bag', "his son's last letter"],
          intent: 'produce an account of Reuben Fowle before Thursday without opening the corn question',
        },
        {
          entityId: 'char:hester-dowsett',
          locationId: 'loc:the-clerks-room',
          mood: 'watchful',
          intent: 'be asked for the books rather than volunteer them',
        },
        {
          entityId: 'char:gideon-havers',
          locationId: 'loc:the-guildhall',
          mood: 'helpful',
          intent: 'have the Corder house opened as a mercy, and the tally left where it is',
        },
        {
          entityId: 'char:dorcas-sallow',
          locationId: 'loc:the-new-ground',
          mood: 'aggrieved',
          intent: 'tell somebody with authority that there were no tokens on the carrier',
        },
        { entityId: 'char:bartholomew-quy', locationId: 'loc:the-surgeons-house', mood: 'unavailable' },
        { entityId: 'char:simeon-roode', locationId: 'loc:sluice-lane', mood: 'exhausted' },
        { entityId: 'char:elias-nunn', locationId: 'loc:holy-cross-church', mood: 'sleepless' },
        {
          entityId: 'char:isaac-trussel',
          locationId: 'loc:the-far-watch',
          mood: 'formal',
          intent: 'have the carrier accounted for in writing, or keep the chain shut',
        },
        { entityId: 'char:prudence-gedge', locationId: 'loc:the-toll-cottage', mood: 'careful' },
        { entityId: 'char:oliver-kell', locationId: 'loc:the-saltings', mood: 'wet and stubborn' },
        { entityId: 'char:ezra-stannard', locationId: 'loc:the-pest-house', mood: 'agreeable' },
        { entityId: 'char:tobias-grimble', locationId: 'loc:hollow-creek', mood: 'absent by preference' },
        { entityId: 'char:ruth-swayne', locationId: 'loc:the-town-granary', mood: 'quiet' },
        { entityId: 'char:joan-larke', locationId: 'loc:the-three-cups', mood: 'busy' },
        { entityId: 'char:jerome-wace', locationId: 'loc:the-causeway', mood: 'uneasy' },
      ],
      relationships: [
        {
          from: 'char:ambrose-kell',
          to: 'char:gideon-havers',
          trust: -0.2,
          affection: -0.3,
          respect: 0.4,
          note: 'the last alderman standing beside him, which is why he has not looked at the tally',
        },
        {
          from: 'char:gideon-havers',
          to: 'char:ambrose-kell',
          trust: 0.1,
          affection: -0.1,
          respect: -0.4,
          note: 'a chandler holding a seal he is afraid of; useful exactly that long',
        },
        {
          from: 'char:ambrose-kell',
          to: 'char:hester-dowsett',
          trust: 0.6,
          affection: 0.3,
          respect: 0.8,
          note: 'cannot read his own town without her and resents needing to say so',
        },
        {
          from: 'char:hester-dowsett',
          to: 'char:ambrose-kell',
          trust: 0.3,
          affection: 0.2,
          respect: 0.4,
          note: 'a decent man doing something indecent slowly; she is waiting to see how slowly',
        },
        {
          from: 'char:ambrose-kell',
          to: 'char:isaac-trussel',
          trust: -0.3,
          affection: -0.4,
          respect: 0.6,
          note: 'the only man in the business with unambiguous authority, and it is not over this town',
        },
        {
          from: 'char:isaac-trussel',
          to: 'char:ambrose-kell',
          trust: -0.5,
          affection: 0.1,
          respect: 0.2,
          note: 'believes him either a fool or the man who buried the carrier; has not settled which',
        },
        {
          from: 'char:ambrose-kell',
          to: 'char:oliver-kell',
          trust: 0.8,
          affection: 0.95,
          respect: 0.3,
          note: 'the whole reason the seal is dangerous to him',
        },
        {
          from: 'char:oliver-kell',
          to: 'char:ambrose-kell',
          trust: 0.5,
          affection: 0.7,
          respect: 0.6,
          note: 'cannot understand why a man with a seal will not simply write his son a pass',
        },
        {
          from: 'char:dorcas-sallow',
          to: 'char:bartholomew-quy',
          trust: -0.5,
          affection: -0.6,
          respect: -0.2,
          note: 'signs at the door and has never once looked at what she brought him',
        },
        {
          from: 'char:bartholomew-quy',
          to: 'char:dorcas-sallow',
          trust: 0.4,
          affection: -0.2,
          respect: -0.5,
          note: 'a useful pair of hands he would not put in a letter',
        },
        {
          from: 'char:dorcas-sallow',
          to: 'char:ambrose-kell',
          trust: 0.3,
          affection: 0.1,
          respect: 0.5,
          note: 'has been trying to be admitted to him for four days',
        },
        {
          from: 'char:hester-dowsett',
          to: 'char:gideon-havers',
          trust: -0.7,
          affection: -0.8,
          respect: 0.3,
          note: 'had her husband\u2019s papers turned over the week he died, and remembers who came',
        },
        {
          from: 'char:prudence-gedge',
          to: 'char:ambrose-kell',
          trust: 0.2,
          affection: 0.3,
          respect: 0.4,
          note: 'has his son in her turf store and has not decided whether that is a favour or a hold',
        },
        {
          from: 'char:isaac-trussel',
          to: 'char:prudence-gedge',
          trust: 0.3,
          affection: 0.1,
          respect: 0.7,
          note: 'the only book in the parish he half believes, which is why he watches her',
        },
        {
          from: 'char:ruth-swayne',
          to: 'char:gideon-havers',
          trust: -0.3,
          affection: -0.4,
          respect: 0.2,
          note: 'writes his arithmetic out fair twice a week and has kept every draft',
        },
        {
          from: 'char:ezra-stannard',
          to: 'char:gideon-havers',
          trust: 0.4,
          affection: 0.1,
          respect: 0.3,
          note: 'pays in coin, before, which is the whole of the relationship',
        },
      ],
      facts: [
        {
          text: 'Reuben Fowle had no plague tokens on him and was returned as visitation regardless',
          knows: ['char:dorcas-sallow', 'char:ezra-stannard'],
          suspects: ['char:elias-nunn', 'char:isaac-trussel'],
          wrong: ['char:bartholomew-quy', 'char:ambrose-kell'],
        },
        {
          text: 'the carrier\u2019s notes show forty quarters delivered over four weeks and the corn tally shows thirty-one received',
          knows: ['char:gideon-havers', 'char:ruth-swayne'],
          suspects: ['char:hester-dowsett', 'char:simeon-roode'],
          wrong: ['char:ambrose-kell', 'char:isaac-trussel'],
        },
        {
          text: 'Prudence Gedge wrote Reuben Fowle crossing out at half past six and the far watch book has no such entry',
          knows: ['char:prudence-gedge', 'char:jerome-wace'],
          suspects: ['char:joan-larke'],
          wrong: ['char:isaac-trussel'],
        },
        {
          text: 'Tobias Grimble found the carrier on his own path across the saltings and moved the body half a mile',
          knows: ['char:tobias-grimble', 'char:mercy-grimble', 'char:ezra-stannard'],
          suspects: ['char:dorcas-sallow'],
          wrong: ['char:simeon-roode', 'char:ambrose-kell'],
        },
        {
          text: 'the weekly bill sent to the bench says thirty-four dead and the parish register says sixty-one',
          knows: ['char:elias-nunn', 'char:ambrose-kell', 'char:hester-dowsett'],
          suspects: ['char:isaac-trussel', 'char:prudence-gedge'],
          wrong: ['char:bartholomew-quy'],
        },
        {
          text: 'Oliver Kell is sleeping in the toll cottage turf store and is entered in no book at all',
          knows: ['char:oliver-kell', 'char:prudence-gedge', 'char:phineas-gedge', 'char:ambrose-kell'],
          suspects: ['char:isaac-trussel', 'char:jerome-wace'],
          wrong: ['char:gideon-havers'],
        },
        {
          text: 'three certificates of health signed and sealed by the dead Mayor are sewn into Hester Dowsett\u2019s workbag',
          knows: ['char:hester-dowsett'],
          suspects: ['char:gideon-havers'],
          wrong: ['char:prudence-gedge', 'char:ambrose-kell'],
        },
      ],
      threads: [
        {
          title: 'An account of Reuben Fowle',
          stakes: 'the allowance, the term of the watch, and whether Kell is acting mayor of anything',
          tension: 0.8,
          parties: ['char:ambrose-kell', 'char:isaac-trussel', 'char:dorcas-sallow', 'char:gideon-havers'],
          resolutions: [
            'the return stands as visitation and the bench accepts it',
            'Kell seals a finding himself and it holds until somebody asks who assented',
            'the grave is opened and the searcher is proved right in front of witnesses',
            'Grimble is produced and the path is accounted for, and Havers is not named',
            'Trussel keeps the chain shut and the town runs out of corn first',
          ],
        },
        {
          title: 'Nine quarters of the allowance',
          stakes: 'nine days\u2019 bread for nine hundred people, and an alderman\u2019s neck',
          tension: 0.7,
          parties: ['char:gideon-havers', 'char:ambrose-kell', 'char:hester-dowsett', 'char:ruth-swayne'],
          resolutions: [
            'the tally is laid beside the carrier\u2019s notes at the bench',
            'the drafts are burned and the arithmetic becomes unprovable',
            'Havers makes restitution quietly in exchange for the Corder house',
            'Kell\u2019s letter accusing the county arrives and he is humiliated in open sessions',
          ],
        },
        {
          title: 'A pass for Oliver Kell',
          stakes: 'the seal, the oath under it, and one young man on a marsh in October',
          tension: 0.65,
          parties: ['char:ambrose-kell', 'char:oliver-kell', 'char:prudence-gedge', 'char:isaac-trussel'],
          resolutions: [
            'a blank certificate is filled in and sealed, and the oath is gone',
            'Oliver comes in over the saltings with the marsh men and is in no book',
            'Trussel admits his standing order and lets him through lawfully',
            'Oliver is turned back for good and walks to another county',
            'Prudence writes him in the book and takes the consequence',
          ],
        },
        {
          title: 'The bill and the register',
          stakes: 'twenty-seven dead the county has never been told about',
          tension: 0.55,
          parties: ['char:elias-nunn', 'char:ambrose-kell', 'char:bartholomew-quy', 'char:isaac-trussel'],
          resolutions: [
            'the true number goes out on Thursday and the town is written off',
            'Nunn sends the register out over the marsh and keeps sending the bill',
            'Quy\u2019s letters reach the city and the discrepancy is discovered from outside',
            'the bill is corrected quietly across four weeks and nobody names it',
          ],
        },
      ],
      style: { register: 'plain', pacing: 'steady', density: 'balanced' },
      anchor: {
        text: 'The precept had been read to him twice, once by Hester and once by himself, and it said the same thing both times.',
        note: 'dry, procedural, a man taking refuge in the wording',
      },
      opening:
        'The precept lay on the bench table under a stone, because the window would not shut and the wind came off the marsh all morning.',
    },

    // Same canon, a different cluster and a much smaller room. The player is the
    // man who executes the orders, and the two things he most wants to do — open
    // a door and not search his own loft — break the same vow from either side.
    {
      id: 'nineteen-doors',
      title: 'Nineteen Doors',
      premise: `You are Simeon Roode, serjeant of the Corporation, and you have nailed nineteen doors shut
in Thornhythe since the twenty-second of September. You swore in front of the whole market that the
orders would fall on your own house first, and you have kept an exact tally so that nobody, least of all
you, can pretend the count was different.

This morning the Corder house calls two living through the shutter and your tally says seven were
counted in. If the count is two then five have been dead in there for days and the term should have run
from the last of them, and you have kept a house sealed past its term. If the count is seven then two
women in that front room can be left where they are. Gideon Havers, whose daughter is one of the voices,
has stood at your shoulder twice this week without once asking you to open it. And your daughter Alice
has been going up to the town's sail loft twice a day with a covered basket, using a key that is supposed
to be the only one, and you have not yet made yourself climb the ladder.`,
      playerCharacterId: 'char:simeon-roode',
      openingLocationId: 'loc:sluice-lane',
      openingScene: 'The ninth day at the Corder shutter',
      focus: {
        'char:simeon-roode': 'focal',
        'char:alice-roode': 'focal',
        'char:grace-havers': 'focal',
        'char:gideon-havers': 'focal',
        'char:thankful-aveling': 'focal',
        'char:tabitha-nokes': 'focal',
        'item:roodes-tally': 'focal',
        'loc:sluice-lane': 'focal',
        'loc:the-corder-house': 'focal',
        'char:marget-skeat': 'principal',
        'char:bartholomew-quy': 'principal',
        'char:dorcas-sallow': 'principal',
        'char:ambrose-kell': 'principal',
        'char:nathaniel-corder': 'principal',
        'char:jerome-wace': 'principal',
        'char:ezra-stannard': 'principal',
        'concept:the-term-of-days': 'principal',
        'concept:the-shutting-up': 'principal',
        'item:the-pit-book': 'principal',
        'loc:the-sail-loft': 'principal',
        'char:elias-nunn': 'supporting',
        'char:joan-larke': 'supporting',
        'char:silence-bulmer': 'supporting',
        'char:kit-swayne': 'supporting',
        'char:hester-dowsett': 'background',
        'char:isaac-trussel': 'background',
        'char:oliver-kell': 'background',
      },
      conditions: [
        {
          entityId: 'char:simeon-roode',
          locationId: 'loc:sluice-lane',
          mood: 'flat and very tired',
          inventory: ['a hammer', 'a purse of nails', 'the tally, folded', 'the sail-loft key on his belt'],
          intent: 'settle the count at the Corder house without opening it',
        },
        {
          entityId: 'char:tabitha-nokes',
          locationId: 'loc:the-corder-house',
          mood: 'hoarse',
          intent: 'be counted as living by somebody who writes things down',
        },
        {
          entityId: 'char:grace-havers',
          locationId: 'loc:the-corder-house',
          mood: 'steady, deliberately',
          intent: 'have the true count of the house written as two',
        },
        { entityId: 'char:nathaniel-corder', locationId: 'loc:the-corder-house', mood: 'failing' },
        {
          entityId: 'char:gideon-havers',
          locationId: 'loc:sluice-lane',
          mood: 'sympathetic',
          intent: 'have the serjeant open the door on his own authority and for his own reasons',
        },
        {
          entityId: 'char:alice-roode',
          locationId: 'loc:the-sail-loft',
          mood: 'braced',
          inventory: ['a covered basket', 'a copied key'],
          intent: 'feed the girl and get out before her father comes down the quay',
        },
        {
          entityId: 'char:thankful-aveling',
          locationId: 'loc:the-sail-loft',
          mood: 'silent by discipline',
          intent: 'get onto the marsh road tonight',
        },
        { entityId: 'char:marget-skeat', locationId: 'loc:the-fish-shambles', mood: 'watchful' },
        { entityId: 'char:dorcas-sallow', locationId: 'loc:sluice-lane', mood: 'waiting to be asked' },
        { entityId: 'char:bartholomew-quy', locationId: 'loc:the-surgeons-house', mood: 'writing letters' },
        { entityId: 'char:ambrose-kell', locationId: 'loc:the-guildhall', mood: 'preoccupied' },
        { entityId: 'char:jerome-wace', locationId: 'loc:the-causeway', mood: 'looking towards the town' },
        { entityId: 'char:ezra-stannard', locationId: 'loc:the-new-ground', mood: 'digging' },
        { entityId: 'char:elias-nunn', locationId: 'loc:the-new-ground', mood: 'grey' },
        { entityId: 'char:joan-larke', locationId: 'loc:the-three-cups', mood: 'listening' },
      ],
      relationships: [
        {
          from: 'char:simeon-roode',
          to: 'char:alice-roode',
          trust: 0.5,
          affection: 0.95,
          respect: 0.4,
          note: 'the one person he has never counted, and he has begun to notice that',
        },
        {
          from: 'char:alice-roode',
          to: 'char:simeon-roode',
          trust: 0.2,
          affection: 0.7,
          respect: 0.6,
          note: 'loves him and has watched him nail nineteen doors; both of those are true at once',
        },
        {
          from: 'char:simeon-roode',
          to: 'char:grace-havers',
          trust: 0.1,
          affection: -0.1,
          respect: 0.7,
          note: 'she calls the count every morning in a voice he cannot get out of his head',
        },
        {
          from: 'char:grace-havers',
          to: 'char:simeon-roode',
          trust: -0.2,
          affection: -0.5,
          respect: 0.5,
          note: 'the only officer in this town who has ever answered her, which she despises him slightly less for',
        },
        {
          from: 'char:tabitha-nokes',
          to: 'char:simeon-roode',
          trust: -0.6,
          affection: -0.8,
          respect: -0.2,
          note: 'nailed the board across her window with her looking through it',
        },
        {
          from: 'char:gideon-havers',
          to: 'char:simeon-roode',
          trust: -0.1,
          affection: 0.2,
          respect: 0.3,
          note: 'an honest man is the cheapest instrument available if you can find his one soft place',
        },
        {
          from: 'char:simeon-roode',
          to: 'char:gideon-havers',
          trust: -0.6,
          affection: -0.7,
          respect: 0.1,
          note: 'has not once asked for the door to be opened, and that is what is wrong with him',
        },
        {
          from: 'char:alice-roode',
          to: 'char:thankful-aveling',
          trust: 0.8,
          affection: 0.8,
          respect: 0.5,
          note: 'the first thing she has ever done that was entirely her own',
        },
        {
          from: 'char:thankful-aveling',
          to: 'char:alice-roode',
          trust: 0.9,
          affection: 0.7,
          respect: 0.6,
          note: 'has nothing to give her back and knows exactly what she is costing her',
        },
        {
          from: 'char:marget-skeat',
          to: 'char:simeon-roode',
          trust: -0.3,
          affection: 0.1,
          respect: 0.6,
          note: 'a straight man in a crooked office; she has treated three houses he sealed',
        },
        {
          from: 'char:simeon-roode',
          to: 'char:marget-skeat',
          trust: 0.2,
          affection: 0.3,
          respect: 0.5,
          note: 'goes where the surgeon will not, which he has stopped pretending not to notice',
        },
        {
          from: 'char:dorcas-sallow',
          to: 'char:simeon-roode',
          trust: 0.6,
          affection: 0.3,
          respect: 0.7,
          note: 'the only officer who takes her return as written',
        },
        {
          from: 'char:jerome-wace',
          to: 'char:alice-roode',
          trust: 0.6,
          affection: 0.8,
          respect: 0.4,
          note: 'writes to her twice a week from the wrong side of the chain',
        },
        {
          from: 'char:alice-roode',
          to: 'char:jerome-wace',
          trust: 0.3,
          affection: 0.5,
          respect: 0.2,
          note: 'a way out of the town that she has not decided whether to use',
        },
        {
          from: 'char:grace-havers',
          to: 'char:gideon-havers',
          trust: -0.6,
          affection: -0.4,
          respect: -0.5,
          note: 'he could have had this door open in a morning and has spent nine days being seen not to try',
        },
        {
          from: 'char:gideon-havers',
          to: 'char:grace-havers',
          trust: 0.3,
          affection: 0.8,
          respect: 0.2,
          note: 'wants her out more than he wants anything, and cannot be the man who asked',
        },
      ],
      facts: [
        {
          text: 'the Corder house has two living in it and Roode\u2019s tally says seven were counted in',
          knows: ['char:grace-havers', 'char:tabitha-nokes', 'char:simeon-roode', 'char:gideon-havers'],
          suspects: ['char:marget-skeat', 'char:dorcas-sallow'],
          wrong: ['char:ambrose-kell', 'char:bartholomew-quy'],
        },
        {
          text: 'a girl off the London hoy is alive in the town sail loft, fed twice a day by the serjeant\u2019s daughter',
          knows: ['char:alice-roode', 'char:thankful-aveling', 'char:marget-skeat', 'char:obadiah-pyke'],
          suspects: ['char:joan-larke'],
          wrong: ['char:simeon-roode', 'char:bartholomew-quy'],
        },
        {
          text: 'Thankful Aveling is entered in the pit book as buried on the second of September',
          knows: ['char:ezra-stannard', 'char:thankful-aveling', 'char:gideon-havers'],
          suspects: ['char:elias-nunn'],
          wrong: ['char:simeon-roode', 'char:dorcas-sallow'],
        },
        {
          text: 'the surgeon has never entered a shut house and signs the searchers\u2019 returns in the doorway',
          knows: ['char:bartholomew-quy', 'char:dorcas-sallow', 'char:silence-bulmer'],
          suspects: ['char:simeon-roode', 'char:marget-skeat'],
          wrong: ['char:ambrose-kell'],
        },
        {
          text: 'Quy has written privately that shutting the well in with the sick is the surest way to kill them',
          knows: ['char:bartholomew-quy', 'char:marget-skeat'],
          suspects: ['char:elias-nunn'],
          wrong: ['char:simeon-roode', 'char:ambrose-kell'],
        },
        {
          text: 'the last house on Sluice Lane has been left uncrossed for four days because the term of days will not come out',
          knows: ['char:simeon-roode'],
          suspects: ['char:joan-larke', 'char:gideon-havers'],
        },
        {
          text: 'Nathaniel Corder is still alive behind the shutter, so the term of days has not yet begun to run',
          knows: ['char:grace-havers', 'char:tabitha-nokes', 'char:nathaniel-corder'],
          suspects: ['char:simeon-roode'],
          wrong: ['char:gideon-havers', 'char:ambrose-kell'],
        },
      ],
      threads: [
        {
          title: 'The count at the Corder house',
          stakes: 'two women behind a nailed door, and nineteen doors\u2019 worth of a man\u2019s only defence',
          tension: 0.85,
          parties: ['char:simeon-roode', 'char:grace-havers', 'char:gideon-havers', 'char:tabitha-nokes'],
          resolutions: [
            'the tally is amended to two and the term is run from the last death',
            'the door is opened and Roode has taken a favour whether he was paid or not',
            'the count stands at seven and the house stays shut to the end',
            'Havers has it opened through the bench and Roode is never asked',
            'Nathaniel dies, the term restarts, and the arithmetic becomes unanswerable',
          ],
        },
        {
          title: 'What Alice carries up the sail-loft ladder',
          stakes: 'a girl who does not exist, and the one vow Roode said out loud in public',
          tension: 0.8,
          parties: ['char:simeon-roode', 'char:alice-roode', 'char:thankful-aveling', 'char:marget-skeat'],
          resolutions: [
            'Roode climbs the ladder and counts his own house first, as he swore',
            'the girl is over the saltings before he goes up, and he never has to know',
            'Alice tells him herself and makes him choose in daylight',
            'Joan Larke sells it and the choice is taken away from all three of them',
            'the pit-book entry is produced and the girl is officially dead enough to walk out',
          ],
        },
        {
          title: 'The surgeon in the doorway',
          stakes: 'whether any return sworn in this town for six weeks is worth the paper',
          tension: 0.6,
          parties: ['char:bartholomew-quy', 'char:dorcas-sallow', 'char:simeon-roode', 'char:marget-skeat'],
          resolutions: [
            'Quy is made to enter a shut house in front of witnesses',
            'Dorcas swears her returns separately and the two accounts diverge on paper',
            'the letters are found and read by the wrong person',
            'Quy resigns his salary, keeps his pass, and leaves over the marsh',
          ],
        },
      ],
      style: { register: 'clipped', pacing: 'steady', density: 'sparse' },
      anchor: {
        text: 'Seven in, said the tally, in his own hand, and the voice at the shutter said two, and had said two for nine mornings.',
        note: 'flat, numerical, a man using arithmetic as a place to stand',
      },
      opening:
        'The stool outside the Corder door had been sat on so long the marsh damp had gone through the seat, and the watchman had gone home to be sick, and nobody had replaced him.',
    },

    // The information scenario. Every letter, pass, rumour and lie in this world
    // crosses one table, and the woman who keeps it has sworn to write down
    // everything that crosses. Tonight three separate people need a crossing that
    // is not written.
    {
      id: 'the-pass-book',
      title: 'The Pass Book',
      premise: `You are Prudence Gedge, and you keep the toll cottage halfway along the causeway: the one
table in this parish where a Thornhythe man and a county man are both permitted to stand. Everything that
moves between the sealed town and the world outside crosses your table — the allowance, the bill of
mortality, the letters, the people turned back — and you write every soul of it in the book, the hour and
the way, in ink, because you swore to.

The book is now the only honest account of this year, and three people want a hole in it. Captain Trussel
wants to know why his far watch has no entry for a carrier your book says went out at half past six.
Ambrose Kell's son has been sleeping in your turf store for three weeks and is in the book as nothing at
all. And tonight there is a girl coming over the saltings from the town who is entered in the pest-house
book as buried five weeks ago, with a dead woman's name and no paper, asking to be let through.`,
      playerCharacterId: 'char:prudence-gedge',
      openingLocationId: 'loc:the-toll-cottage',
      openingScene: 'Half past six, going out',
      focus: {
        'char:prudence-gedge': 'focal',
        'char:isaac-trussel': 'focal',
        'char:oliver-kell': 'focal',
        'char:jerome-wace': 'focal',
        'char:thankful-aveling': 'focal',
        'item:the-pass-book': 'focal',
        'item:the-blank-certificates': 'focal',
        'loc:the-toll-cottage': 'focal',
        'loc:the-causeway': 'focal',
        'char:phineas-gedge': 'principal',
        'char:ambrose-kell': 'principal',
        'char:hester-dowsett': 'principal',
        'char:reuben-fowle': 'principal',
        'char:alice-roode': 'principal',
        'char:joan-larke': 'principal',
        'char:tobias-grimble': 'principal',
        'concept:certificates-of-health': 'principal',
        'concept:the-term-of-days': 'principal',
        'loc:the-far-watch': 'principal',
        'loc:the-saltings': 'principal',
        'char:gideon-havers': 'supporting',
        'char:simeon-roode': 'supporting',
        'char:marget-skeat': 'supporting',
        'char:elias-nunn': 'supporting',
        'char:ezra-stannard': 'supporting',
        'char:obadiah-pyke': 'background',
        'char:mercy-grimble': 'background',
      },
      conditions: [
        {
          entityId: 'char:prudence-gedge',
          locationId: 'loc:the-toll-cottage',
          mood: 'level, and running out of level',
          inventory: ['the pass book', 'an hour-glass', 'a bowl of vinegar', 'a stone bottle of ink'],
          intent: 'get through tonight without an unwritten crossing',
        },
        { entityId: 'char:phineas-gedge', locationId: 'loc:the-toll-cottage', mood: 'excited and useless' },
        {
          entityId: 'char:isaac-trussel',
          locationId: 'loc:the-toll-cottage',
          mood: 'patient in the way that is worse',
          intent: 'have the book read to him aloud from the twenty-sixth onward',
        },
        {
          entityId: 'char:oliver-kell',
          locationId: 'loc:the-toll-cottage',
          mood: 'past pride',
          intent: 'be written in going in, by any hand, on any paper',
        },
        {
          entityId: 'char:jerome-wace',
          locationId: 'loc:the-causeway',
          mood: 'frightened and pretending otherwise',
          intent: 'keep it from coming out that the far watch book was never written that morning',
        },
        {
          entityId: 'char:thankful-aveling',
          locationId: 'loc:the-saltings',
          mood: 'exhausted',
          intent: 'get past the chain under any name at all',
        },
        { entityId: 'char:tobias-grimble', locationId: 'loc:the-saltings', mood: 'businesslike' },
        { entityId: 'char:alice-roode', locationId: 'loc:the-saltings', mood: 'terrified and steady' },
        { entityId: 'char:ambrose-kell', locationId: 'loc:the-guildhall', mood: 'awake at the window' },
        { entityId: 'char:hester-dowsett', locationId: 'loc:the-clerks-room', mood: 'deciding something' },
        { entityId: 'char:joan-larke', locationId: 'loc:the-three-cups', mood: 'trading' },
        { entityId: 'char:simeon-roode', locationId: 'loc:sluice-lane', mood: 'looking for his daughter' },
        { entityId: 'char:marget-skeat', locationId: 'loc:the-fish-shambles', mood: 'having done what she could' },
        { entityId: 'char:ezra-stannard', locationId: 'loc:the-pest-house', mood: 'uneasy' },
      ],
      relationships: [
        {
          from: 'char:prudence-gedge',
          to: 'char:isaac-trussel',
          trust: 0.1,
          affection: -0.2,
          respect: 0.7,
          note: 'keeps his word exactly, which makes him the most dangerous man on the road',
        },
        {
          from: 'char:isaac-trussel',
          to: 'char:prudence-gedge',
          trust: 0.4,
          affection: 0.2,
          respect: 0.8,
          note: 'the only record he half believes, and she is hiding something in it',
        },
        {
          from: 'char:prudence-gedge',
          to: 'char:oliver-kell',
          trust: 0.3,
          affection: 0.5,
          respect: 0.1,
          note: 'three weeks in her turf store and not one line of him in the book',
        },
        {
          from: 'char:oliver-kell',
          to: 'char:prudence-gedge',
          trust: 0.7,
          affection: 0.6,
          respect: 0.5,
          note: 'has understood she is the only lawful way in, and has begun asking for the other kind',
        },
        {
          from: 'char:prudence-gedge',
          to: 'char:jerome-wace',
          trust: -0.2,
          affection: 0.2,
          respect: -0.3,
          note: 'a Thornhythe boy who slept through the one morning that mattered',
        },
        {
          from: 'char:jerome-wace',
          to: 'char:prudence-gedge',
          trust: -0.4,
          affection: -0.1,
          respect: 0.6,
          note: 'her book is the thing that will hang him, and she has been kind to him about it',
        },
        {
          from: 'char:prudence-gedge',
          to: 'char:phineas-gedge',
          trust: 0.4,
          affection: 0.95,
          respect: 0.2,
          note: 'carries letters she has not read, and she intends to keep it that way',
        },
        {
          from: 'char:phineas-gedge',
          to: 'char:prudence-gedge',
          trust: 0.9,
          affection: 0.9,
          respect: 0.8,
          note: 'thinks the book is the most important object in England, which is nearly right',
        },
        {
          from: 'char:prudence-gedge',
          to: 'char:ambrose-kell',
          trust: 0.2,
          affection: 0.3,
          respect: 0.4,
          note: 'she has his son and he has never once asked her for a favour; she respects and resents it',
        },
        {
          from: 'char:ambrose-kell',
          to: 'char:prudence-gedge',
          trust: 0.5,
          affection: 0.4,
          respect: 0.6,
          note: 'the only person outside the chain who has done him a kindness with no price on it',
        },
        {
          from: 'char:thankful-aveling',
          to: 'char:prudence-gedge',
          trust: 0.2,
          affection: 0,
          respect: 0.3,
          note: 'a table with a book on it, and no reason on earth to be merciful',
        },
        {
          from: 'char:alice-roode',
          to: 'char:prudence-gedge',
          trust: 0.4,
          affection: 0.1,
          respect: 0.5,
          note: 'has heard all her life that the toll-cottage woman writes everything down',
        },
        {
          from: 'char:isaac-trussel',
          to: 'char:jerome-wace',
          trust: -0.2,
          affection: -0.1,
          respect: -0.4,
          note: 'one of the fourteen, and one of the two he suspects of having been bought',
        },
        {
          from: 'char:joan-larke',
          to: 'char:prudence-gedge',
          trust: 0.5,
          affection: 0.5,
          respect: 0.6,
          note: 'the other half of the only working post in the hundred',
        },
        {
          from: 'char:tobias-grimble',
          to: 'char:prudence-gedge',
          trust: 0.1,
          affection: 0,
          respect: 0.4,
          note: 'she has never asked him a question about the saltings and he is grateful for it',
        },
      ],
      facts: [
        {
          text: 'the pass book has Reuben Fowle crossing out at half past six and the far watch book has nothing',
          knows: ['char:prudence-gedge', 'char:jerome-wace'],
          suspects: ['char:joan-larke', 'char:ambrose-kell'],
          wrong: ['char:isaac-trussel', 'char:simeon-roode'],
        },
        {
          text: 'Jerome Wace was asleep at the far watch that morning and has let the missing entry stand',
          knows: ['char:jerome-wace'],
          suspects: ['char:prudence-gedge'],
          wrong: ['char:isaac-trussel', 'char:oliver-kell'],
        },
        {
          text: 'Trussel\u2019s standing order lets him pass a man out on a certificate of health, and he has never said so in the town',
          knows: ['char:isaac-trussel'],
          suspects: ['char:prudence-gedge'],
          wrong: ['char:ambrose-kell', 'char:oliver-kell', 'char:joan-larke'],
        },
        {
          text: 'Oliver Kell has slept in the toll cottage turf store since the nineteenth and appears in no book',
          knows: ['char:oliver-kell', 'char:prudence-gedge', 'char:phineas-gedge', 'char:ambrose-kell'],
          suspects: ['char:isaac-trussel', 'char:jerome-wace'],
          wrong: ['char:gideon-havers'],
        },
        {
          text: 'the girl coming over the saltings tonight is entered in the pit book as buried on the second of September',
          knows: ['char:thankful-aveling', 'char:ezra-stannard', 'char:alice-roode', 'char:marget-skeat'],
          suspects: ['char:joan-larke'],
          wrong: ['char:prudence-gedge', 'char:isaac-trussel'],
        },
        {
          text: 'three certificates of health signed and sealed by the dead Mayor were never burned',
          knows: ['char:hester-dowsett'],
          suspects: ['char:gideon-havers', 'char:ambrose-kell'],
          wrong: ['char:prudence-gedge', 'char:isaac-trussel'],
        },
        {
          text: 'the weekly bill the town sends out is short of the parish register by twenty-seven dead',
          knows: ['char:elias-nunn', 'char:ambrose-kell', 'char:hester-dowsett'],
          suspects: ['char:prudence-gedge', 'char:isaac-trussel'],
        },
      ],
      threads: [
        {
          title: 'The entry that is not in the far watch book',
          stakes: 'whether the town or the county killed the carrier, decided entirely on paper',
          tension: 0.8,
          parties: ['char:prudence-gedge', 'char:isaac-trussel', 'char:jerome-wace', 'char:reuben-fowle'],
          resolutions: [
            'the book is read aloud from the twenty-sixth and Wace is finished',
            'Prudence lets Trussel believe the town kept the carrier, and the town pays for it',
            'Wace confesses to sleeping and the county\u2019s own record is discredited',
            'both books go to the bench, and the bench believes the neater one',
            'the page is altered, and Prudence has broken the only vow she has',
          ],
        },
        {
          title: 'A girl who is already buried',
          stakes: 'one life, against the only unspoiled record of this year',
          tension: 0.85,
          parties: ['char:thankful-aveling', 'char:prudence-gedge', 'char:alice-roode', 'char:isaac-trussel'],
          resolutions: [
            'she is written in truly, under her own name, and taken at the chain',
            'she crosses unwritten, and the book stops being a book',
            'she is written in under the dead woman\u2019s name from the pit book, which is true on paper',
            'Grimble takes her round the far watch over the saltings and no table is troubled',
            'she is turned back to the town and Alice Roode is taken with her',
          ],
        },
        {
          title: 'Kell\u2019s son at the table',
          stakes: 'an acting mayor\u2019s oath, and three weeks of a woman\u2019s silence',
          tension: 0.6,
          parties: ['char:oliver-kell', 'char:prudence-gedge', 'char:ambrose-kell', 'char:isaac-trussel'],
          resolutions: [
            'Trussel admits the standing order and Oliver goes in lawfully, written',
            'a blank certificate comes out of the clerk\u2019s room and Kell has sealed it himself',
            'Oliver goes in over the saltings and is entered nowhere at all',
            'Prudence writes him in retrospectively and takes the charge of it',
            'he is moved on to another county and the letters stop',
          ],
        },
        {
          title: 'What the town is not sending out',
          stakes: 'twenty-seven dead, and the term the watch will be kept for',
          tension: 0.5,
          parties: ['char:prudence-gedge', 'char:isaac-trussel', 'char:hester-dowsett', 'char:elias-nunn'],
          resolutions: [
            'the register goes out over the marsh and the true figure reaches the bench',
            'Prudence reads a letter she swore not to read and learns it that way',
            'the bill stays short and the watch is lifted on a false count',
            'Trussel works it out from the burials he can count from the sea wall',
          ],
        },
      ],
      style: { register: 'plain', pacing: 'steady', dialogueRatio: 0.55 },
      anchor: {
        text: 'She wrote the hour before she wrote the name, always, so that the hour could not be argued with afterwards.',
        note: 'exact, procedural, a woman building evidence out of routine',
      },
      opening:
        'The ink had thickened in the cold and she thinned it with a drop from the vinegar bowl, which was not correct, and made the entries for the twenty-eighth greyer than the rest of the page.',
    },
  ],
};
