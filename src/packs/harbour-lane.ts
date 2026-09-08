/**
 * Harbour Lane — Brackmouth, present day.
 *
 * A contemporary pack whose engine is the relationship triad rather than a
 * plot. Everywhere else `trust`/`affection`/`respect` are colour on top of a
 * situation; here they *are* the situation, because `consequence/propagate.ts`
 * will walk a relationship directly whenever the strongest of the three clears
 * 0.25 either way. So every significant pair is authored in both directions
 * with different numbers, and the negative range is used as much as the
 * positive one. Contempt and cooled affection are what make a small town
 * legible.
 *
 * Three things this pack is built to demonstrate:
 *
 *  - **One cast, three ways in.** All three scenarios draw on the same
 *    seventy-odd entities. Nessa Coyle is a bridge in the boatyard scenario and
 *    the protagonist of the next one; Grace Ollery is a name on a wage dispute
 *    in one and the thing Iris Kellow will not say out loud in another.
 *  - **Clusters, not a hairball.** Three tight knots — the Tarrant family and
 *    the yard, the Lane's traders, the school-and-surgery end of town — joined
 *    by a handful of deliberately thin bridges. The consequence engine caps at
 *    five reactors, so fifteen inbound edges on one person is waste; several
 *    dense knots means somebody plausible always reacts wherever the player is.
 *  - **Vows in a contemporary register.** Not oaths. A professional
 *    confidence, a rule about a child, a promise to an old man who cannot hold
 *    anyone to it. The integrity gate reads `breakingPoint` and `costOfBreak`,
 *    and in each scenario the obvious, tempting course breaks a rank-1 vow.
 *
 * Nothing here is a crime. The pressure is a business failing slowly, a tide
 * that will not wait, and four people who would rather lose the thing than say
 * the sentence.
 */
import type { WorldPack } from './types.ts';
import { packEdges } from './types.ts';

export const harbourLanePack: WorldPack = {
  id: 'harbour-lane',
  title: 'Harbour Lane',
  genre: 'contemporary',
  blurb: 'An estuary town, a boatyard three months from closing, and a spring tide on Friday that nobody can move.',
  premise: `Brackmouth is a town of about three thousand at the top of a tidal estuary, and its harbour
silted up long before anyone currently living decided to stay. Harbour Lane runs two hundred metres
from the slipway to Marsh End church: a pub, a chandlery that also sells kettles, a fish bar, a
bookkeeper in one room over the chandlery, a surgery in what used to be a bank, and an ex-post-office
that is now a holiday lettings agency with photographs of the estuary at high water in the window. At
low water the estuary is mud and a channel you could step over.

What is under strain is ordinary. Tarrant & Sons has repaired boats on the same foreshore lease for
sixty-one years and has not paid its last remaining shipwright since March. The lease comes up for
renewal this month with a change-of-use clause in it. Douglas Tarrant, who used to be the yard, is in
a care home on the Bilton road with a stroke and about forty words. His three children have not once
used the word inheritance in the same room. Kit Tarrant is back for the first time in fourteen years
and has not said why. Over the road, the pub floods every tide above 5.4 metres and its licensees are
the only two people in Brackmouth who have not worked out that their marriage is over.

None of it needs anybody's malice. It would all go wrong on its own if nobody intervened — which is
what makes it worth intervening in. Everything in Brackmouth is decided by who is willing to say a
thing out loud, in front of whom, and how much later they can be made to regret it.`,
  license: 'Original work, written for this engine. No third-party setting or characters.',

  entities: [
    // ------------------------------------------------------------------ places
    //
    // Contemporary settings live or die on venues where people cannot avoid
    // each other. Every location below is either somewhere private enough to
    // say the thing, or somewhere public enough that saying it is a decision.
    {
      id: 'loc:brackmouth',
      type: 'Location',
      name: 'Brackmouth',
      summary: 'Three thousand people at the top of a tidal estuary, arranged around a harbour that silted up in 1958.',
      tier: 'principal',
    },
    {
      id: 'loc:harbour-lane',
      type: 'Location',
      name: 'Harbour Lane',
      summary: 'Two hundred metres of shopfront from the slipway to the church. Six businesses, four of them solvent.',
      tier: 'principal',
    },
    {
      id: 'loc:tarrant-boatyard',
      type: 'Location',
      name: 'Tarrant & Sons Boatyard',
      summary: 'Sixty-one years on the same foreshore lease. Two sheds, a slip, a crane with a current certificate.',
      tier: 'principal',
    },
    {
      id: 'loc:the-big-shed',
      type: 'Location',
      name: 'The Big Shed',
      summary: 'Corrugated, eighty feet, a roof a surveyor has put in writing. Smells of epoxy and cold water.',
      tier: 'principal',
    },
    {
      id: 'loc:the-yard-office',
      type: 'Location',
      name: 'The Yard Office',
      summary: 'A partitioned corner with a two-bar heater, a landline, and every number Rhona has not told anyone.',
      tier: 'principal',
    },
    {
      id: 'loc:the-slipway',
      type: 'Location',
      name: 'The Slipway',
      summary: 'Concrete into mud. Usable two hours either side of high water, and the whole town walks past it.',
      tier: 'principal',
    },
    {
      id: 'loc:the-mud-berth',
      type: 'Location',
      name: 'The Mud Berth',
      summary: 'Where the Aveline sits between tides, propped, tarpaulined, visible from the pub car park.',
      tier: 'principal',
    },
    {
      id: 'loc:the-ferryman',
      type: 'Location',
      name: 'The Ferryman',
      summary: 'The pub, named for a crossing that stopped running in 1994. Forty covers on a good Friday.',
      tier: 'principal',
    },
    {
      id: 'loc:the-back-room',
      type: 'Location',
      name: 'The Ferryman Back Room',
      summary: 'Hired out for hearings, wakes and birthdays. One door, thin wall, and everything said in it gets out.',
      tier: 'principal',
    },
    {
      id: 'loc:the-pub-kitchen',
      type: 'Location',
      name: 'The Ferryman Kitchen',
      summary:
        "Tom's eleven square metres. The only room in the building where nobody can hear you over the extractor.",
      tier: 'principal',
    },
    {
      id: 'loc:coyle-bookkeeping',
      type: 'Location',
      name: 'Coyle Bookkeeping',
      summary: "One room over the chandlery, six clients' files in a locked cabinet, and a kettle on the windowsill.",
      tier: 'principal',
    },
    {
      id: 'loc:nandras',
      type: 'Location',
      name: "Nandra's",
      summary: 'Chandlery, hardware, and the only place in town that sells both stainless bolts and birthday candles.',
      tier: 'principal',
    },
    {
      id: 'loc:molloys',
      type: 'Location',
      name: "Molloy's",
      summary: 'The fish bar. Open six to nine, and functionally the town noticeboard for anything not yet confirmed.',
      tier: 'principal',
    },
    {
      id: 'loc:the-old-post-office',
      type: 'Location',
      name: 'The Old Post Office',
      summary: 'Voss Coastal Lettings, in the building that used to take parcels. Estuary photographs at high water.',
      tier: 'principal',
    },
    {
      id: 'loc:the-surgery',
      type: 'Location',
      name: 'The Surgery Waiting Room',
      summary: 'Nine chairs in what was the bank. Nobody in Brackmouth can wait here without being seen waiting.',
      tier: 'principal',
    },
    {
      id: 'loc:marsh-end-primary',
      type: 'Location',
      name: 'Marsh End Primary',
      summary: 'Ninety-one children, four classes, and a hall that doubles as the town meeting room in winter.',
      tier: 'principal',
    },
    {
      id: 'loc:the-school-gate',
      type: 'Location',
      name: 'The School Gate',
      summary: 'Eight twenty and three fifteen, unavoidably. Where the town negotiates in ten-minute instalments.',
      tier: 'principal',
    },
    {
      id: 'loc:marsh-end-churchyard',
      type: 'Location',
      name: 'Marsh End Churchyard',
      summary: 'Four generations of Tarrants against the north wall, and a bench where people go to not be spoken to.',
      tier: 'principal',
    },
    {
      id: 'loc:the-quay-car-park',
      type: 'Location',
      name: 'The Quay Car Park',
      summary: 'Free after six. Where arguments go when they are too big for a house and too small for a solicitor.',
      tier: 'principal',
    },
    {
      id: 'loc:douglas-room',
      type: 'Location',
      name: 'Room 12, Brindle House',
      summary: 'A high bed, a window on the car park, and forty years of yard photographs taped to the wardrobe door.',
      tier: 'principal',
    },
    {
      id: 'loc:the-glebe',
      type: 'Location',
      name: 'The Glebe',
      summary:
        "Marie and Ivo's house on the hill, with the view the brochures use and a kitchen island nobody eats at.",
      tier: 'background',
    },
    {
      id: 'loc:tarrant-house',
      type: 'Location',
      name: 'The Tarrant House',
      summary: 'Behind the yard, damp on the seaward gable. Rhona has slept in her childhood bedroom for eleven years.',
      tier: 'principal',
    },
    {
      id: 'loc:the-sea-wall-path',
      type: 'Location',
      name: 'The Sea Wall Path',
      summary:
        'A mile of raised bank out to the marsh. The only place in Brackmouth you can be certain of not meeting anyone.',
      tier: 'supporting',
    },
    {
      id: 'loc:the-harbour-office',
      type: 'Location',
      name: 'The Harbour Office',
      summary: 'A portacabin with a tide gauge, a kettle, and sixty-one years of the yard’s lease in a filing drawer.',
      tier: 'supporting',
    },

    // ------------------------------------------- cluster one: the yard, the family
    //
    // Eight people tied by blood, wages and a boat. Dense enough that anything
    // done to one of them pulls four others in without a bridge being crossed.
    {
      id: 'char:rhona-tarrant',
      type: 'Character',
      name: 'Rhona Tarrant',
      summary:
        'Runs the yard since her father’s stroke and has kept it going mainly by not telling anyone how bad it is.',
      tier: 'principal',
      props: { age: 52, role: 'yard manager' },
    },
    {
      id: 'char:kit-tarrant',
      type: 'Character',
      name: 'Kit Tarrant',
      summary: 'Back in Brackmouth after fourteen years, charming about everything except why he came.',
      tier: 'principal',
      props: { age: 38, role: 'returned brother' },
    },
    {
      id: 'char:marie-voss',
      type: 'Character',
      name: 'Marie Voss',
      summary: 'The sister who married up the hill. Visited every Sunday for two years and intends to be paid for it.',
      tier: 'principal',
      props: { age: 46, role: 'sister', maiden: 'Tarrant' },
    },
    {
      id: 'char:ivo-voss',
      type: 'Character',
      name: 'Ivo Voss',
      summary: 'Lettings agent. Has had the yard site valued as fourteen apartments and has never said so in a room.',
      tier: 'principal',
      props: { age: 49, role: 'lettings agent' },
    },
    {
      id: 'char:douglas-tarrant',
      type: 'Character',
      name: 'Douglas Tarrant',
      summary: 'Was the yard for forty years. Since the stroke he has about forty words and uses them very precisely.',
      tier: 'principal',
      props: { age: 79, role: 'father', condition: 'stroke, expressive aphasia' },
    },
    {
      id: 'char:sam-tarrant',
      type: 'Character',
      name: 'Sam Tarrant',
      summary:
        'Nineteen, second-year apprentice, and has an offer letter from a college in Bilton he has shown to one person.',
      tier: 'principal',
      props: { age: 19, role: 'apprentice' },
    },
    {
      id: 'char:tansy-voss',
      type: 'Character',
      name: 'Tansy Voss',
      summary:
        'Sixteen, Marie’s daughter, at the yard every Saturday because it is the one place her parents will not follow her.',
      tier: 'supporting',
      props: { age: 16 },
    },
    {
      id: 'char:bryn-ollery',
      type: 'Character',
      name: 'Bryn Ollery',
      summary: 'Forty-one years a shipwright at Tarrant’s. Not paid since March, and has made a point of not asking.',
      tier: 'principal',
      props: { age: 61, role: 'shipwright' },
    },
    {
      id: 'char:eddie-quill',
      type: 'Character',
      name: 'Eddie Quill',
      summary: 'Retired from the yard in 2009 and has turned up most weeks since. Knows where the deeds are kept.',
      tier: 'supporting',
      props: { age: 67 },
    },

    // ------------------------------- cluster two: the Lane, the pub, the traders
    //
    // The commercial knot. Money, licences and rent, which in a town this size
    // are the same conversation as who is speaking to whom.
    {
      id: 'char:nessa-coyle',
      type: 'Character',
      name: 'Nessa Coyle',
      summary: 'Keeps the books for six businesses on the Lane, including two that are about to be on opposite sides.',
      tier: 'principal',
      props: { age: 37, role: 'bookkeeper' },
    },
    {
      id: 'char:hattie-coyle',
      type: 'Character',
      name: 'Hattie Coyle',
      summary:
        'Nessa’s mother, cleans at Brindle House, and repeats roughly half of what Douglas Tarrant manages to say.',
      tier: 'supporting',
      props: { age: 68 },
    },
    {
      id: 'char:iris-kellow',
      type: 'Character',
      name: 'Iris Kellow',
      summary: 'Licensee of the Ferryman. Warm to the room, monosyllabic the moment the last customer is out.',
      tier: 'principal',
      props: { age: 43, role: 'licensee' },
    },
    {
      id: 'char:tom-kellow',
      type: 'Character',
      name: 'Tom Kellow',
      summary: 'Cooks. Co-licensee. Believes he is the one holding it together and can produce the rota to prove it.',
      tier: 'principal',
      props: { age: 45, role: 'chef, co-licensee' },
    },
    {
      id: 'char:bee-kellow',
      type: 'Character',
      name: 'Bee Kellow',
      summary:
        'Eleven on Friday. Keeps the pub’s tide table by hand and has noticed considerably more than either parent thinks.',
      tier: 'principal',
      props: { age: 10 },
    },
    {
      id: 'char:dev-nandra',
      type: 'Character',
      name: 'Dev Nandra',
      summary:
        'Thirty-one years behind the chandlery counter. Chairs the traders and is quietly furious about the window displays.',
      tier: 'principal',
      props: { age: 63, role: 'chandler' },
    },
    {
      id: 'char:deb-molloy',
      type: 'Character',
      name: 'Deb Molloy',
      summary:
        'Runs the fish bar, extends credit to everyone, and will repeat what you tell her before the oil is cool.',
      tier: 'principal',
      props: { age: 58 },
    },
    {
      id: 'char:col-molloy',
      type: 'Character',
      name: 'Col Molloy',
      summary: 'Deb’s son. Fryer six nights, yard labourer when there is work, and never once talks about himself.',
      tier: 'supporting',
      props: { age: 26 },
    },
    {
      id: 'char:len-fewkes',
      type: 'Character',
      name: 'Len Fewkes',
      summary:
        'Clerk to the Harbour Trust. Reads out clause numbers and genuinely believes that is the same as being neutral.',
      tier: 'principal',
      props: { age: 55, role: 'trust clerk' },
    },

    // ---------------------- cluster three: the school, the surgery, the church
    //
    // The end of town that sees people when they are not performing. Weakly
    // bridged to the other two — through Grace, Cass and the gig crew — which is
    // what stops the whole cast collapsing into one undifferentiated hairball.
    {
      id: 'char:grace-ollery',
      type: 'Character',
      name: 'Grace Ollery',
      summary:
        'District nurse, Bryn’s daughter, captains the gig crew, and asks the question everyone else has decided to avoid.',
      tier: 'principal',
      props: { age: 34, role: 'district nurse' },
    },
    {
      id: 'char:winnie-ollery',
      type: 'Character',
      name: 'Winnie Ollery',
      summary:
        'Bryn’s wife, care assistant at Brindle House, and the only person in Brackmouth saying the wage thing out loud.',
      tier: 'principal',
      props: { age: 59 },
    },
    {
      id: 'char:aiden-frew',
      type: 'Character',
      name: 'Aiden Frew',
      summary: 'Head of Marsh End Primary. Cannot switch off the assembly voice, and has liked Iris Kellow since 1994.',
      tier: 'principal',
      props: { age: 48, role: 'headteacher' },
    },
    {
      id: 'char:cass-frew',
      type: 'Character',
      name: 'Cass Frew',
      summary:
        'Seventeen, Aiden’s daughter, works Molloy’s counter, and is the only person Sam Tarrant has told anything.',
      tier: 'supporting',
      props: { age: 17 },
    },
    {
      id: 'char:priya-nandra',
      type: 'Character',
      name: 'Priya Nandra',
      summary:
        'Teaches Year Five, including Bee. Careful, kind, and keeping a written note she has not yet had to use.',
      tier: 'principal',
      props: { age: 29, role: 'teacher' },
    },
    {
      id: 'char:mo-abiri',
      type: 'Character',
      name: 'Mo Abiri',
      summary: 'Runs the after-school club and therefore knows exactly which parents are late and how often.',
      tier: 'background',
      props: { age: 41 },
    },
    {
      id: 'char:fen-alder',
      type: 'Character',
      name: 'Fen Alder',
      summary: 'Locum GP, eight months into a three-month contract, still without the local shorthand and aware of it.',
      tier: 'principal',
      props: { age: 39, role: 'locum GP' },
    },
    {
      id: 'char:orla-dace',
      type: 'Character',
      name: 'Orla Dace',
      summary:
        'Vicar of Marsh End. Refuses metaphor, witnessed Douglas Tarrant refuse to sign something, and has said nothing.',
      tier: 'principal',
      props: { age: 57, role: 'vicar' },
    },
    {
      id: 'char:jerome-hyde',
      type: 'Character',
      name: 'Jerome Hyde',
      summary:
        'Chair of governors and Harbour Trust member. Says “as I understand it” about things he decided last month.',
      tier: 'supporting',
      props: { age: 52 },
    },
    {
      id: 'char:russ-pardoe',
      type: 'Character',
      name: 'Russ Pardoe',
      summary:
        'Marine surveyor from Bilton. Speaks in report prose, dates everything, and has already copied the Trust.',
      tier: 'supporting',
      props: { age: 44, role: 'surveyor' },
    },

    // ---------------------------------------------------------------- institutions
    //
    // Contemporary factions are not armies. They are things that can send you a
    // letter, and whose members are obliged to have an opinion when one arrives.
    {
      id: 'fac:tarrant-and-sons',
      type: 'Faction',
      name: 'Tarrant & Sons',
      summary:
        'A limited company with one shipwright, one apprentice, a crane, and a foreshore lease worth more than all of it.',
      tier: 'principal',
    },
    {
      id: 'fac:the-harbour-trust',
      type: 'Faction',
      name: 'The Brackmouth Harbour Trust',
      summary:
        'Seven trustees who own the foreshore, meet quarterly, and have discovered that their leases are worth money.',
      tier: 'principal',
    },
    {
      id: 'fac:voss-lettings',
      type: 'Faction',
      name: 'Voss Coastal Lettings',
      summary:
        'Fifty-one holiday properties and an ambition. The most profitable business on Harbour Lane by a factor of nine.',
      tier: 'principal',
    },
    {
      id: 'fac:the-lane-traders',
      type: 'Faction',
      name: 'The Harbour Lane Traders',
      summary:
        'Six businesses, a group chat, and an annual dispute about the Christmas lights that stands in for every other dispute.',
      tier: 'principal',
    },
    {
      id: 'fac:the-gig-crew',
      type: 'Faction',
      name: 'The Brackmouth Gig Crew',
      summary:
        'Six oars, one borrowed boat the yard maintains for nothing, and the only room in town where rank does not apply.',
      tier: 'principal',
    },
    {
      id: 'fac:brindle-house',
      type: 'Faction',
      name: 'Brindle House',
      summary:
        'Nineteen residents, eleven staff, a proprietor in another county, and a laundry rota that decides who hears what.',
      tier: 'supporting',
    },

    // ----------------------------------------------------------------- objects
    {
      id: 'item:the-yard-ledger',
      type: 'Item',
      name: 'The Yard Ledger',
      summary:
        'A hardback cash book Rhona keeps by hand because the accounting software would have to be shown to somebody.',
      tier: 'principal',
    },
    {
      id: 'item:the-freehold-deeds',
      type: 'Item',
      name: 'The Freehold Deeds',
      summary:
        'Deeds to the house and the two cottages, in a document box in the yard office that has not been opened since 2019.',
      tier: 'principal',
    },
    {
      id: 'item:the-second-will',
      type: 'Item',
      name: 'The Second Will',
      summary:
        'Drawn up in 2019, never signed, and the reason nobody in the family will finish a sentence about the yard.',
      tier: 'principal',
    },
    {
      id: 'item:the-aveline',
      type: 'Item',
      name: 'The Aveline',
      summary:
        'A 1936 pilot cutter, two-thirds restored, named for the Tarrants’ mother. The only asset with a market.',
      tier: 'principal',
    },
    {
      id: 'item:the-personal-guarantee',
      type: 'Item',
      name: 'The Personal Guarantee',
      summary:
        'Two pages and a signature line, holding a living person liable for the company’s overdraft. Kit’s name is typed on it.',
      tier: 'principal',
    },
    {
      id: 'item:the-surveyors-letter',
      type: 'Item',
      name: 'The Surveyor’s Letter',
      summary:
        'Dated three weeks ago, condemns the big shed roof, copied to the Harbour Trust, and still in its envelope.',
      tier: 'principal',
    },
    {
      id: 'item:bees-tide-table',
      type: 'Item',
      name: 'Bee’s Tide Table',
      summary:
        'Hand-ruled on card, Blu-tacked beside the optics, more accurate than the printed one and correspondingly loved.',
      tier: 'supporting',
    },
    {
      id: 'item:iris-wedding-ring',
      type: 'Item',
      name: 'Iris’s Wedding Ring',
      summary: 'Comes off for the kitchen and goes back on for the bar, which used to be about hygiene.',
      tier: 'supporting',
    },

    // ------------------------------------------------------------------- ideas
    {
      id: 'concept:the-tide',
      type: 'Concept',
      name: 'The Tide',
      summary:
        'Brackmouth’s actual clock. Two hours either side of high water or nothing moves, and nothing negotiates with it.',
      tier: 'principal',
    },
    {
      id: 'concept:the-haul-out',
      type: 'Concept',
      name: 'Friday’s Haul-Out',
      summary:
        'The last spring tide big enough to lift the Aveline off the mud for four weeks. Two-forty in the afternoon.',
      tier: 'principal',
    },
    {
      id: 'concept:the-lease-renewal',
      type: 'Concept',
      name: 'The Lease Renewal',
      summary:
        'Sixty-one years of foreshore, up this month, with a change-of-use clause the Trust’s clerk keeps calling standard.',
      tier: 'principal',
    },
    {
      id: 'concept:the-arrangement',
      type: 'Concept',
      name: 'The Arrangement',
      summary:
        'What the Tarrants call not discussing their father’s will: Marie visits, Rhona works, Kit is not mentioned.',
      tier: 'principal',
    },
    {
      id: 'concept:client-confidence',
      type: 'Concept',
      name: 'Client Confidence',
      summary: 'Nessa’s one professional line: what is in a client’s books stays in the books, including the hints.',
      tier: 'principal',
    },
    {
      id: 'concept:not-in-front-of-bee',
      type: 'Concept',
      name: 'Not In Front of Bee',
      summary:
        'The Kellows’ unwritten rule, kept immaculately for three years and now the only part of the marriage still working.',
      tier: 'principal',
    },
    {
      id: 'concept:the-lane',
      type: 'Concept',
      name: 'The Lane',
      summary:
        'What the traders mean by “the Lane” — a version of the street with a butcher in it. Nostalgia as a voting bloc.',
      tier: 'background',
    },

    // ------------------------------------------------------------------ events
    {
      id: 'event:the-ferry-stopping',
      type: 'Event',
      name: 'The Ferry Stopping',
      summary:
        '1994. The crossing closed, the Lane lost half its trade in a summer, and the town has dated things from it since.',
      tier: 'background',
    },
    {
      id: 'event:the-night-kit-left',
      type: 'Event',
      name: 'The Night Kit Left',
      summary:
        'Fourteen years ago, after a row in the big shed that four people remember and no two of them the same way.',
      tier: 'principal',
    },
    {
      id: 'event:the-stroke',
      type: 'Event',
      name: 'The Stroke',
      summary:
        'Douglas went down between the bandsaw and the door. Bryn found him and has not been right in that shed since.',
      tier: 'principal',
    },
    {
      id: 'event:the-january-tide',
      type: 'Event',
      name: 'The January Tide',
      summary:
        'A surge on a 5.9 metre spring put nine inches through the big shed and the pub cellar, and neither is insured for it.',
      tier: 'principal',
    },
  ],

  edges: packEdges([
    // ================================================================= kinship
    //
    // Blood, marriage and its remains. `EX_OF` and `CO_PARENT_WITH` both carry a
    // kin stance, which is exactly right: a former partner reacts like family
    // and generally faster.
    ['char:rhona-tarrant', 'SIBLING_OF', 'char:kit-tarrant', 0.9],
    ['char:kit-tarrant', 'SIBLING_OF', 'char:rhona-tarrant', 0.9],
    ['char:rhona-tarrant', 'SIBLING_OF', 'char:marie-voss', 0.85],
    ['char:marie-voss', 'SIBLING_OF', 'char:rhona-tarrant', 0.85],
    ['char:kit-tarrant', 'SIBLING_OF', 'char:marie-voss', 0.7],
    ['char:marie-voss', 'SIBLING_OF', 'char:kit-tarrant', 0.7],
    ['char:rhona-tarrant', 'CHILD_OF', 'char:douglas-tarrant', 0.95],
    ['char:kit-tarrant', 'CHILD_OF', 'char:douglas-tarrant', 0.8],
    ['char:marie-voss', 'CHILD_OF', 'char:douglas-tarrant', 0.85],
    ['char:douglas-tarrant', 'PARENT_OF', 'char:rhona-tarrant', 0.9],
    ['char:douglas-tarrant', 'PARENT_OF', 'char:kit-tarrant', 0.85],
    ['char:douglas-tarrant', 'PARENT_OF', 'char:marie-voss', 0.6],
    ['char:rhona-tarrant', 'PARENT_OF', 'char:sam-tarrant', 0.95],
    ['char:sam-tarrant', 'CHILD_OF', 'char:rhona-tarrant', 0.9],
    ['char:douglas-tarrant', 'KIN_OF', 'char:sam-tarrant', 0.7],
    ['char:sam-tarrant', 'KIN_OF', 'char:tansy-voss', 0.5],
    ['char:tansy-voss', 'KIN_OF', 'char:sam-tarrant', 0.6],
    ['char:marie-voss', 'MARRIED_TO', 'char:ivo-voss', 0.8],
    ['char:ivo-voss', 'MARRIED_TO', 'char:marie-voss', 0.8],
    ['char:marie-voss', 'PARENT_OF', 'char:tansy-voss', 0.85],
    ['char:tansy-voss', 'CHILD_OF', 'char:marie-voss', 0.6],
    ['char:tansy-voss', 'CHILD_OF', 'char:ivo-voss', 0.5],
    ['char:bryn-ollery', 'MARRIED_TO', 'char:winnie-ollery', 0.85],
    ['char:winnie-ollery', 'MARRIED_TO', 'char:bryn-ollery', 0.9],
    ['char:bryn-ollery', 'PARENT_OF', 'char:grace-ollery', 0.85],
    ['char:grace-ollery', 'CHILD_OF', 'char:bryn-ollery', 0.9],
    ['char:winnie-ollery', 'PARENT_OF', 'char:grace-ollery', 0.8],
    ['char:nessa-coyle', 'CHILD_OF', 'char:hattie-coyle', 0.85],
    ['char:hattie-coyle', 'PARENT_OF', 'char:nessa-coyle', 0.9],
    ['char:iris-kellow', 'MARRIED_TO', 'char:tom-kellow', 0.6],
    ['char:tom-kellow', 'MARRIED_TO', 'char:iris-kellow', 0.75],
    ['char:iris-kellow', 'CO_PARENT_WITH', 'char:tom-kellow', 0.9],
    ['char:tom-kellow', 'CO_PARENT_WITH', 'char:iris-kellow', 0.9],
    ['char:iris-kellow', 'PARENT_OF', 'char:bee-kellow', 0.95],
    ['char:tom-kellow', 'PARENT_OF', 'char:bee-kellow', 0.9],
    ['char:bee-kellow', 'CHILD_OF', 'char:iris-kellow', 0.9],
    ['char:bee-kellow', 'CHILD_OF', 'char:tom-kellow', 0.85],
    ['char:deb-molloy', 'PARENT_OF', 'char:col-molloy', 0.85],
    ['char:col-molloy', 'CHILD_OF', 'char:deb-molloy', 0.7],
    ['char:dev-nandra', 'PARENT_OF', 'char:priya-nandra', 0.8],
    ['char:priya-nandra', 'CHILD_OF', 'char:dev-nandra', 0.85],
    ['char:aiden-frew', 'PARENT_OF', 'char:cass-frew', 0.85],
    ['char:cass-frew', 'CHILD_OF', 'char:aiden-frew', 0.6],
    // The ex who never quite finished. Authored both ways because it fires both
    // ways, and with different weight because she has carried more of it.
    ['char:nessa-coyle', 'EX_OF', 'char:kit-tarrant', 0.85],
    ['char:kit-tarrant', 'EX_OF', 'char:nessa-coyle', 0.6],

    // ============================================== loyalty, reliance, wanting
    ['char:bryn-ollery', 'LOYAL_TO', 'char:rhona-tarrant', 0.9],
    ['char:bryn-ollery', 'LOYAL_TO', 'char:douglas-tarrant', 0.95],
    ['char:rhona-tarrant', 'RELIES_ON', 'char:bryn-ollery', 0.95],
    ['char:rhona-tarrant', 'PROTECTS', 'char:douglas-tarrant', 0.85],
    ['char:rhona-tarrant', 'PROTECTS', 'char:sam-tarrant', 0.8],
    ['char:bryn-ollery', 'MENTORS', 'char:sam-tarrant', 0.85],
    ['char:sam-tarrant', 'RELIES_ON', 'char:bryn-ollery', 0.7],
    ['char:bryn-ollery', 'MENTORS', 'char:tansy-voss', 0.6],
    ['char:tansy-voss', 'APPRENTICE_OF', 'char:bryn-ollery', 0.65],
    ['char:eddie-quill', 'LOYAL_TO', 'char:douglas-tarrant', 0.8],
    ['char:eddie-quill', 'MENTORS', 'char:bryn-ollery', 0.5],
    ['char:rhona-tarrant', 'TRUSTS', 'char:nessa-coyle', 0.85],
    ['char:nessa-coyle', 'TRUSTS', 'char:rhona-tarrant', 0.5],
    ['char:kit-tarrant', 'TRUSTS', 'char:nessa-coyle', 0.8],
    ['char:nessa-coyle', 'TRUSTS', 'char:kit-tarrant', 0.35],
    ['char:nessa-coyle', 'LOVES', 'char:kit-tarrant', 0.7],
    ['char:kit-tarrant', 'DESIRES', 'char:nessa-coyle', 0.75],
    ['char:kit-tarrant', 'LOVES', 'char:douglas-tarrant', 0.6],
    ['char:sam-tarrant', 'TRUSTS', 'char:cass-frew', 0.9],
    ['char:sam-tarrant', 'DESIRES', 'char:cass-frew', 0.7],
    ['char:cass-frew', 'DESIRES', 'char:sam-tarrant', 0.45],
    ['char:cass-frew', 'PROTECTS', 'char:bee-kellow', 0.6],
    ['char:grace-ollery', 'PROTECTS', 'char:bryn-ollery', 0.8],
    ['char:grace-ollery', 'LOVES', 'char:iris-kellow', 0.6],
    ['char:iris-kellow', 'DESIRES', 'char:grace-ollery', 0.7],
    ['char:aiden-frew', 'DESIRES', 'char:iris-kellow', 0.5],
    ['char:iris-kellow', 'FRIENDLY_WITH', 'char:aiden-frew', 0.4],
    ['char:iris-kellow', 'PROTECTS', 'char:bee-kellow', 0.95],
    ['char:tom-kellow', 'PROTECTS', 'char:bee-kellow', 0.9],
    ['char:tom-kellow', 'RELIES_ON', 'char:iris-kellow', 0.8],
    ['char:iris-kellow', 'RELIES_ON', 'char:tom-kellow', 0.5],
    ['char:bee-kellow', 'TRUSTS', 'char:priya-nandra', 0.7],
    ['char:bee-kellow', 'TRUSTS', 'char:tom-kellow', 0.6],
    ['char:priya-nandra', 'PROTECTS', 'char:bee-kellow', 0.7],
    ['char:aiden-frew', 'RELIES_ON', 'char:priya-nandra', 0.75],
    ['char:priya-nandra', 'RELIES_ON', 'char:mo-abiri', 0.6],
    ['char:mo-abiri', 'FRIENDLY_WITH', 'char:priya-nandra', 0.65],
    ['char:mo-abiri', 'PROTECTS', 'char:bee-kellow', 0.5],
    ['char:aiden-frew', 'SERVES', 'char:jerome-hyde', 0.6],
    ['char:fen-alder', 'TRUSTS', 'char:grace-ollery', 0.8],
    ['char:grace-ollery', 'RELIES_ON', 'char:fen-alder', 0.55],
    ['char:fen-alder', 'PROTECTS', 'char:douglas-tarrant', 0.5],
    ['char:douglas-tarrant', 'TRUSTS', 'char:orla-dace', 0.8],
    ['char:orla-dace', 'FRIENDLY_WITH', 'char:douglas-tarrant', 0.6],
    ['char:orla-dace', 'FRIENDLY_WITH', 'char:bryn-ollery', 0.5],
    ['char:hattie-coyle', 'FRIENDLY_WITH', 'char:winnie-ollery', 0.7],
    ['char:winnie-ollery', 'FRIENDLY_WITH', 'char:hattie-coyle', 0.55],
    ['char:deb-molloy', 'FRIENDLY_WITH', 'char:rhona-tarrant', 0.6],
    ['char:dev-nandra', 'FRIENDLY_WITH', 'char:bryn-ollery', 0.5],
    ['char:col-molloy', 'LOYAL_TO', 'char:rhona-tarrant', 0.5],
    ['char:col-molloy', 'FRIENDLY_WITH', 'char:sam-tarrant', 0.7],
    ['char:iris-kellow', 'TRUSTS', 'char:nessa-coyle', 0.75],
    ['char:nessa-coyle', 'FRIENDLY_WITH', 'char:iris-kellow', 0.6],
    ['char:dev-nandra', 'TRUSTS', 'char:nessa-coyle', 0.8],
    ['char:nessa-coyle', 'PROTECTS', 'char:hattie-coyle', 0.85],
    ['char:tansy-voss', 'TRUSTS', 'char:rhona-tarrant', 0.6],
    ['char:marie-voss', 'RELIES_ON', 'char:ivo-voss', 0.65],
    ['char:ivo-voss', 'RELIES_ON', 'char:nessa-coyle', 0.7],
    ['char:ivo-voss', 'RELIES_ON', 'char:len-fewkes', 0.6],
    ['char:marie-voss', 'OWES', 'char:rhona-tarrant', 0.4],
    ['char:kit-tarrant', 'OWES', 'char:marie-voss', 0.55],
    ['char:rhona-tarrant', 'OWES_MONEY_TO', 'char:bryn-ollery', 0.9],
    ['char:rhona-tarrant', 'OWES_MONEY_TO', 'char:deb-molloy', 0.4],
    ['fac:tarrant-and-sons', 'OWES_MONEY_TO', 'char:dev-nandra', 0.6],
    ['fac:tarrant-and-sons', 'OWES_MONEY_TO', 'char:russ-pardoe', 0.35],
    ['char:iris-kellow', 'OWES_MONEY_TO', 'char:dev-nandra', 0.3],

    // ================================================ friction, and the honest
    // negatives. A small town is mostly legible through what has cooled.
    ['char:rhona-tarrant', 'RIVAL_OF', 'char:marie-voss', 0.8],
    ['char:marie-voss', 'RIVAL_OF', 'char:rhona-tarrant', 0.75],
    ['char:rhona-tarrant', 'HATES', 'char:ivo-voss', 0.7],
    ['char:ivo-voss', 'RIVAL_OF', 'char:rhona-tarrant', 0.45],
    ['char:marie-voss', 'SUSPECTS', 'char:kit-tarrant', 0.6],
    ['char:kit-tarrant', 'SUSPECTS', 'char:marie-voss', 0.65],
    ['char:winnie-ollery', 'HOSTILE_TO', 'char:rhona-tarrant', 0.7],
    ['char:grace-ollery', 'SUSPECTS', 'char:rhona-tarrant', 0.6],
    ['char:russ-pardoe', 'SUSPECTS', 'char:rhona-tarrant', 0.5],
    ['char:dev-nandra', 'HOSTILE_TO', 'char:ivo-voss', 0.65],
    ['char:dev-nandra', 'RIVAL_OF', 'fac:voss-lettings', 0.6],
    ['char:tom-kellow', 'SUSPECTS', 'char:grace-ollery', 0.55],
    ['char:tom-kellow', 'RIVAL_OF', 'char:aiden-frew', 0.4],
    ['char:cass-frew', 'HOSTILE_TO', 'char:aiden-frew', 0.35],
    ['char:tansy-voss', 'HOSTILE_TO', 'char:ivo-voss', 0.5],
    ['char:eddie-quill', 'SUSPECTS', 'char:marie-voss', 0.45],
    ['char:len-fewkes', 'SUSPECTS', 'fac:tarrant-and-sons', 0.5],
    ['char:jerome-hyde', 'RIVAL_OF', 'char:dev-nandra', 0.35],
    ['char:bee-kellow', 'HOSTILE_TO', 'char:marie-voss', 0.3],

    // ============================================================= observation
    //
    // Who is watching whom, and who is holding something back from whom. In a
    // town this size these are the same list twice.
    ['char:marie-voss', 'WATCHES', 'char:rhona-tarrant', 0.6],
    ['char:bee-kellow', 'WATCHES', 'char:iris-kellow', 0.75],
    ['char:priya-nandra', 'WATCHES', 'char:bee-kellow', 0.6],
    ['char:mo-abiri', 'WATCHES', 'char:tom-kellow', 0.4],
    ['char:hattie-coyle', 'INFORMS', 'char:deb-molloy', 0.7],
    ['char:deb-molloy', 'INFORMS', 'char:marie-voss', 0.45],
    ['char:len-fewkes', 'INFORMS', 'char:ivo-voss', 0.6],
    ['char:russ-pardoe', 'INFORMS', 'fac:the-harbour-trust', 0.65],
    ['char:col-molloy', 'INFORMS', 'char:deb-molloy', 0.5],
    ['char:rhona-tarrant', 'KEEPS_SECRET_FROM', 'char:bryn-ollery', 0.9],
    ['char:rhona-tarrant', 'KEEPS_SECRET_FROM', 'char:kit-tarrant', 0.7],
    ['char:sam-tarrant', 'KEEPS_SECRET_FROM', 'char:rhona-tarrant', 0.75],
    ['char:bryn-ollery', 'KEEPS_SECRET_FROM', 'char:winnie-ollery', 0.8],
    ['char:nessa-coyle', 'KEEPS_SECRET_FROM', 'char:kit-tarrant', 0.85],
    ['char:nessa-coyle', 'KEEPS_SECRET_FROM', 'char:ivo-voss', 0.6],
    ['char:douglas-tarrant', 'KEEPS_SECRET_FROM', 'char:rhona-tarrant', 0.7],
    ['char:orla-dace', 'KEEPS_SECRET_FROM', 'char:rhona-tarrant', 0.65],
    ['char:iris-kellow', 'KEEPS_SECRET_FROM', 'char:tom-kellow', 0.8],
    ['char:tom-kellow', 'KEEPS_SECRET_FROM', 'char:iris-kellow', 0.55],
    ['char:iris-kellow', 'KEEPS_SECRET_FROM', 'char:bee-kellow', 0.75],
    ['char:grace-ollery', 'KEEPS_SECRET_FROM', 'char:winnie-ollery', 0.5],
    ['char:cass-frew', 'KEEPS_SECRET_FROM', 'char:aiden-frew', 0.6],

    // ============================== the third knot, tied off internally
    //
    // The school-and-surgery end of town needs enough of its own social wiring
    // that something can happen there without borrowing a reactor from the
    // boatyard. Deliberately quieter ties than cluster one: professional regard,
    // shared rotas, and people who see each other four times a week by timetable.
    ['char:grace-ollery', 'FRIENDLY_WITH', 'char:priya-nandra', 0.65],
    ['char:priya-nandra', 'FRIENDLY_WITH', 'char:grace-ollery', 0.75],
    ['char:grace-ollery', 'TRUSTS', 'char:orla-dace', 0.6],
    ['char:orla-dace', 'FRIENDLY_WITH', 'char:grace-ollery', 0.5],
    ['char:fen-alder', 'FRIENDLY_WITH', 'char:orla-dace', 0.55],
    ['char:orla-dace', 'TRUSTS', 'char:fen-alder', 0.65],
    ['char:aiden-frew', 'FRIENDLY_WITH', 'char:fen-alder', 0.45],
    ['char:fen-alder', 'RELIES_ON', 'char:winnie-ollery', 0.5],
    ['char:winnie-ollery', 'TRUSTS', 'char:fen-alder', 0.4],
    ['char:winnie-ollery', 'TRUSTS', 'char:orla-dace', 0.55],
    ['char:aiden-frew', 'RELIES_ON', 'char:mo-abiri', 0.6],
    ['char:mo-abiri', 'INFORMS', 'char:aiden-frew', 0.55],
    ['char:mo-abiri', 'INFORMS', 'char:priya-nandra', 0.5],
    ['char:cass-frew', 'TRUSTS', 'char:priya-nandra', 0.5],
    ['char:priya-nandra', 'FRIENDLY_WITH', 'char:cass-frew', 0.4],
    ['char:jerome-hyde', 'WATCHES', 'char:aiden-frew', 0.5],
    ['char:aiden-frew', 'SUSPECTS', 'char:jerome-hyde', 0.4],
    ['char:russ-pardoe', 'FRIENDLY_WITH', 'char:jerome-hyde', 0.4],
    ['char:jerome-hyde', 'RELIES_ON', 'char:russ-pardoe', 0.45],
    ['char:priya-nandra', 'KEEPS_SECRET_FROM', 'char:aiden-frew', 0.5],

    // ==================================== membership, trade, and money moving
    //
    // `MEMBER_OF` and `LEADS` are matched by exact string in `propagate.ts` and
    // drive the expensive walk where everyone else in the institution also
    // reacts. That is the whole point of a town: you cannot annoy one trader.
    ['char:rhona-tarrant', 'LEADS', 'fac:tarrant-and-sons', 0.95],
    ['char:bryn-ollery', 'MEMBER_OF', 'fac:tarrant-and-sons', 0.9],
    ['char:sam-tarrant', 'MEMBER_OF', 'fac:tarrant-and-sons', 0.75],
    ['char:douglas-tarrant', 'MEMBER_OF', 'fac:tarrant-and-sons', 0.6],
    ['char:eddie-quill', 'MEMBER_OF', 'fac:tarrant-and-sons', 0.4],
    ['char:col-molloy', 'MEMBER_OF', 'fac:tarrant-and-sons', 0.45],
    ['char:len-fewkes', 'LEADS', 'fac:the-harbour-trust', 0.8],
    ['char:jerome-hyde', 'MEMBER_OF', 'fac:the-harbour-trust', 0.7],
    ['char:orla-dace', 'MEMBER_OF', 'fac:the-harbour-trust', 0.5],
    ['char:ivo-voss', 'LEADS', 'fac:voss-lettings', 0.95],
    ['char:marie-voss', 'MEMBER_OF', 'fac:voss-lettings', 0.6],
    ['char:dev-nandra', 'LEADS', 'fac:the-lane-traders', 0.8],
    ['char:iris-kellow', 'MEMBER_OF', 'fac:the-lane-traders', 0.7],
    ['char:deb-molloy', 'MEMBER_OF', 'fac:the-lane-traders', 0.7],
    ['char:nessa-coyle', 'MEMBER_OF', 'fac:the-lane-traders', 0.6],
    ['char:ivo-voss', 'MEMBER_OF', 'fac:the-lane-traders', 0.5],
    ['char:grace-ollery', 'LEADS', 'fac:the-gig-crew', 0.85],
    ['char:col-molloy', 'CREW_OF', 'fac:the-gig-crew', 0.7],
    ['char:sam-tarrant', 'CREW_OF', 'fac:the-gig-crew', 0.7],
    ['char:priya-nandra', 'MEMBER_OF', 'fac:the-gig-crew', 0.6],
    ['char:tom-kellow', 'MEMBER_OF', 'fac:the-gig-crew', 0.6],
    ['char:kit-tarrant', 'MEMBER_OF', 'fac:the-gig-crew', 0.3],
    ['char:winnie-ollery', 'MEMBER_OF', 'fac:brindle-house', 0.7],
    ['char:hattie-coyle', 'MEMBER_OF', 'fac:brindle-house', 0.6],
    ['char:douglas-tarrant', 'TENANT_OF', 'fac:brindle-house', 0.8],
    ['fac:tarrant-and-sons', 'TENANT_OF', 'fac:the-harbour-trust', 0.95],
    ['fac:voss-lettings', 'DEALS_WITH', 'fac:the-harbour-trust', 0.6],
    ['fac:voss-lettings', 'RIVAL_OF', 'fac:the-lane-traders', 0.65],
    ['fac:the-harbour-trust', 'DEALS_WITH', 'fac:tarrant-and-sons', 0.7],
    ['fac:brindle-house', 'EMPLOYS', 'char:winnie-ollery', 0.7],
    ['fac:brindle-house', 'EMPLOYS', 'char:hattie-coyle', 0.6],
    ['char:deb-molloy', 'EMPLOYS', 'char:cass-frew', 0.6],
    ['char:deb-molloy', 'EMPLOYS', 'char:col-molloy', 0.5],
    ['char:iris-kellow', 'EMPLOYS', 'char:col-molloy', 0.45],
    ['char:iris-kellow', 'EMPLOYS', 'char:tom-kellow', 0.5],
    ['fac:tarrant-and-sons', 'EMPLOYS', 'char:bryn-ollery', 0.9],
    ['fac:tarrant-and-sons', 'EMPLOYS', 'char:sam-tarrant', 0.7],
    ['char:russ-pardoe', 'DEALS_WITH', 'char:rhona-tarrant', 0.5],
    // Six sets of books, two of which are about to be on opposite sides of the
    // same table. This is the whole of the second scenario in five edges.
    ['char:nessa-coyle', 'DEALS_WITH', 'fac:tarrant-and-sons', 0.85],
    ['char:nessa-coyle', 'DEALS_WITH', 'fac:voss-lettings', 0.8],
    ['char:nessa-coyle', 'DEALS_WITH', 'char:iris-kellow', 0.7],
    ['char:nessa-coyle', 'DEALS_WITH', 'char:dev-nandra', 0.65],
    ['char:nessa-coyle', 'DEALS_WITH', 'char:deb-molloy', 0.55],
    ['char:dev-nandra', 'SUPPLIES', 'fac:tarrant-and-sons', 0.7],
    ['char:dev-nandra', 'SUPPLIES', 'char:iris-kellow', 0.4],
    ['char:ivo-voss', 'PAYS', 'char:len-fewkes', 0.3],
    ['char:marie-voss', 'PAYS', 'fac:brindle-house', 0.6],
    ['char:jerome-hyde', 'PATRON_OF', 'fac:the-gig-crew', 0.4],
    ['char:aiden-frew', 'MENTORS', 'char:priya-nandra', 0.55],

    // ============================================== structure, place, custody
    //
    // Deliberately inert: no stance, no reactors, no consequence travels these.
    // They exist so the Referee can answer "where is that" and "who has it".
    ['loc:harbour-lane', 'PART_OF', 'loc:brackmouth', 0.9],
    ['loc:tarrant-boatyard', 'PART_OF', 'loc:brackmouth', 0.9],
    ['loc:the-big-shed', 'PART_OF', 'loc:tarrant-boatyard', 0.95],
    ['loc:the-yard-office', 'PART_OF', 'loc:tarrant-boatyard', 0.95],
    ['loc:the-slipway', 'PART_OF', 'loc:tarrant-boatyard', 0.8],
    ['loc:the-mud-berth', 'PART_OF', 'loc:brackmouth', 0.6],
    ['loc:the-ferryman', 'PART_OF', 'loc:harbour-lane', 0.9],
    ['loc:the-back-room', 'PART_OF', 'loc:the-ferryman', 0.95],
    ['loc:the-pub-kitchen', 'PART_OF', 'loc:the-ferryman', 0.95],
    ['loc:coyle-bookkeeping', 'PART_OF', 'loc:nandras', 0.8],
    ['loc:nandras', 'PART_OF', 'loc:harbour-lane', 0.9],
    ['loc:molloys', 'PART_OF', 'loc:harbour-lane', 0.9],
    ['loc:the-old-post-office', 'PART_OF', 'loc:harbour-lane', 0.9],
    ['loc:the-surgery', 'PART_OF', 'loc:harbour-lane', 0.85],
    ['loc:the-school-gate', 'PART_OF', 'loc:marsh-end-primary', 0.9],
    ['loc:marsh-end-primary', 'PART_OF', 'loc:brackmouth', 0.8],
    ['loc:marsh-end-churchyard', 'PART_OF', 'loc:brackmouth', 0.8],
    ['loc:the-quay-car-park', 'PART_OF', 'loc:brackmouth', 0.8],
    ['loc:douglas-room', 'PART_OF', 'loc:brackmouth', 0.5],
    ['loc:the-glebe', 'PART_OF', 'loc:brackmouth', 0.6],
    ['loc:tarrant-house', 'PART_OF', 'loc:brackmouth', 0.7],
    ['loc:the-sea-wall-path', 'PART_OF', 'loc:brackmouth', 0.6],
    ['loc:the-harbour-office', 'PART_OF', 'loc:brackmouth', 0.7],
    ['loc:the-slipway', 'CONNECTS_TO', 'loc:harbour-lane', 0.8],
    ['loc:the-slipway', 'CONNECTS_TO', 'loc:the-mud-berth', 0.8],
    ['loc:the-quay-car-park', 'CONNECTS_TO', 'loc:the-ferryman', 0.85],
    ['loc:the-quay-car-park', 'CONNECTS_TO', 'loc:tarrant-boatyard', 0.7],
    ['loc:the-sea-wall-path', 'CONNECTS_TO', 'loc:marsh-end-churchyard', 0.7],
    ['loc:harbour-lane', 'CONNECTS_TO', 'loc:marsh-end-churchyard', 0.7],
    ['fac:the-harbour-trust', 'HOLDS', 'loc:the-slipway', 0.9],
    ['fac:the-harbour-trust', 'HOLDS', 'loc:the-mud-berth', 0.8],
    ['fac:the-harbour-trust', 'HOLDS', 'loc:the-harbour-office', 0.9],
    ['fac:tarrant-and-sons', 'OCCUPIES', 'loc:tarrant-boatyard', 0.95],
    ['fac:voss-lettings', 'OCCUPIES', 'loc:the-old-post-office', 0.9],
    ['fac:brindle-house', 'HOLDS', 'loc:douglas-room', 0.8],
    ['loc:tarrant-boatyard', 'GOVERNED_BY', 'fac:the-harbour-trust', 0.85],
    ['loc:marsh-end-primary', 'GOVERNED_BY', 'char:jerome-hyde', 0.5],
    ['char:rhona-tarrant', 'LIVES_AT', 'loc:tarrant-house', 0.9],
    ['char:sam-tarrant', 'LIVES_AT', 'loc:tarrant-house', 0.8],
    ['char:kit-tarrant', 'LIVES_AT', 'loc:tarrant-house', 0.4],
    ['char:douglas-tarrant', 'LIVES_AT', 'loc:douglas-room', 0.9],
    ['char:marie-voss', 'LIVES_AT', 'loc:the-glebe', 0.85],
    ['char:ivo-voss', 'LIVES_AT', 'loc:the-glebe', 0.85],
    ['char:tansy-voss', 'LIVES_AT', 'loc:the-glebe', 0.7],
    ['char:iris-kellow', 'LIVES_AT', 'loc:the-ferryman', 0.9],
    ['char:tom-kellow', 'LIVES_AT', 'loc:the-ferryman', 0.85],
    ['char:bee-kellow', 'LIVES_AT', 'loc:the-ferryman', 0.9],
    ['char:rhona-tarrant', 'WORKS_AT', 'loc:the-yard-office', 0.95],
    ['char:bryn-ollery', 'WORKS_AT', 'loc:the-big-shed', 0.95],
    ['char:sam-tarrant', 'WORKS_AT', 'loc:the-big-shed', 0.8],
    ['char:nessa-coyle', 'WORKS_AT', 'loc:coyle-bookkeeping', 0.95],
    ['char:dev-nandra', 'WORKS_AT', 'loc:nandras', 0.9],
    ['char:deb-molloy', 'WORKS_AT', 'loc:molloys', 0.9],
    ['char:col-molloy', 'WORKS_AT', 'loc:molloys', 0.7],
    ['char:cass-frew', 'WORKS_AT', 'loc:molloys', 0.6],
    ['char:ivo-voss', 'WORKS_AT', 'loc:the-old-post-office', 0.9],
    ['char:tom-kellow', 'WORKS_AT', 'loc:the-pub-kitchen', 0.95],
    ['char:fen-alder', 'WORKS_AT', 'loc:the-surgery', 0.9],
    ['char:grace-ollery', 'WORKS_AT', 'loc:the-surgery', 0.6],
    ['char:aiden-frew', 'WORKS_AT', 'loc:marsh-end-primary', 0.9],
    ['char:priya-nandra', 'WORKS_AT', 'loc:marsh-end-primary', 0.85],
    ['char:mo-abiri', 'WORKS_AT', 'loc:marsh-end-primary', 0.7],
    ['char:orla-dace', 'WORKS_AT', 'loc:marsh-end-churchyard', 0.8],
    ['char:len-fewkes', 'WORKS_AT', 'loc:the-harbour-office', 0.9],
    ['char:winnie-ollery', 'WORKS_AT', 'loc:douglas-room', 0.6],
    ['char:hattie-coyle', 'WORKS_AT', 'loc:douglas-room', 0.55],
    ['char:bee-kellow', 'FOUND_AT', 'loc:the-school-gate', 0.7],
    ['char:eddie-quill', 'FOUND_AT', 'loc:the-big-shed', 0.6],
    ['char:tansy-voss', 'FOUND_AT', 'loc:the-big-shed', 0.6],
    ['char:iris-kellow', 'MEETS_AT', 'loc:the-quay-car-park', 0.5],
    ['char:grace-ollery', 'MEETS_AT', 'loc:the-mud-berth', 0.5],
    ['char:kit-tarrant', 'MEETS_AT', 'loc:the-sea-wall-path', 0.5],
    ['char:marie-voss', 'MEETS_AT', 'loc:the-back-room', 0.5],
    ['char:jerome-hyde', 'MEETS_AT', 'loc:the-back-room', 0.6],
    ['char:russ-pardoe', 'MEETS_AT', 'loc:the-harbour-office', 0.5],
    ['char:rhona-tarrant', 'KEEPS', 'item:the-yard-ledger', 0.9],
    ['char:rhona-tarrant', 'KEEPS', 'item:the-surveyors-letter', 0.7],
    ['char:eddie-quill', 'KEEPS', 'item:the-freehold-deeds', 0.4],
    ['char:orla-dace', 'KEEPS', 'item:the-second-will', 0.6],
    ['char:marie-voss', 'CARRIES', 'item:the-personal-guarantee', 0.7],
    ['char:iris-kellow', 'CARRIES', 'item:iris-wedding-ring', 0.6],
    ['char:bee-kellow', 'KEEPS', 'item:bees-tide-table', 0.8],
    ['item:the-yard-ledger', 'KEPT_IN', 'loc:the-yard-office', 0.9],
    ['item:the-freehold-deeds', 'KEPT_IN', 'loc:the-yard-office', 0.8],
    ['item:the-surveyors-letter', 'KEPT_IN', 'loc:the-yard-office', 0.7],
    ['item:the-aveline', 'KEPT_IN', 'loc:the-mud-berth', 0.9],
    ['item:bees-tide-table', 'KEPT_IN', 'loc:the-ferryman', 0.8],
    ['fac:tarrant-and-sons', 'KEEPS', 'item:the-aveline', 0.85],
    ['char:nessa-coyle', 'SWORN_TO', 'concept:client-confidence', 0.95],
    ['char:iris-kellow', 'SWORN_TO', 'concept:not-in-front-of-bee', 0.95],
    ['char:tom-kellow', 'SWORN_TO', 'concept:not-in-front-of-bee', 0.85],
    ['char:rhona-tarrant', 'SWORN_TO', 'concept:the-arrangement', 0.6],
    ['char:marie-voss', 'SWORN_TO', 'concept:the-arrangement', 0.7],
    ['fac:tarrant-and-sons', 'MENTIONS', 'concept:the-lease-renewal', 0.8],
    ['concept:the-haul-out', 'PART_OF', 'concept:the-tide', 0.8],
    ['loc:brackmouth', 'MENTIONS', 'concept:the-tide', 0.7],
    ['loc:harbour-lane', 'MENTIONS', 'concept:the-lane', 0.7],
    ['event:the-ferry-stopping', 'MENTIONS', 'loc:harbour-lane', 0.6],
    ['event:the-night-kit-left', 'MENTIONS', 'loc:the-big-shed', 0.7],
    ['event:the-stroke', 'MENTIONS', 'loc:the-big-shed', 0.7],
    ['event:the-january-tide', 'MENTIONS', 'loc:the-ferryman', 0.6],
    ['event:the-january-tide', 'MENTIONS', 'loc:the-big-shed', 0.6],
  ]),

  sheets: [
    // ---------------------------------------------------------- player one: Rhona
    //
    // Her rank-1 vow is the one Friday breaks. There is exactly one way to get
    // the Aveline off the mud on that tide, and it runs through Bryn's hands on
    // the crane, and the only thing that keeps them there is a sentence she
    // knows to be untrue.
    {
      entityId: 'char:rhona-tarrant',
      identity: {
        goals: [
          'get the Aveline out on Friday’s tide',
          'get the lease renewed without the change-of-use clause',
          'pay Bryn before he asks',
        ],
        wounds: [
          'she was in the office doing VAT when her father went down forty feet away',
          'she gave up a job in Bilton in 2014 and has never once mentioned it',
        ],
        fears: ['that Bryn already knows and is being kind about it', 'ending up the Tarrant who lost the yard'],
        allegiances: ['Tarrant & Sons', 'Bryn Ollery', 'her father, as he was'],
        competencies: [
          'reading a hull and a bank statement with the same eye',
          'the tide tables from memory',
          'twenty years of making a shortfall last another month',
        ],
        secrets: [
          'the yard cannot trade past January',
          'she has had Ivo’s valuation letter since August and has not opened it in front of anyone',
        ],
        arc: 'A woman who has held something together for eleven years by never letting anybody see the whole of it, discovering that this was the same as being alone.',
      },
      contract: {
        vows: [
          {
            id: 'no-lies-to-bryn',
            text: 'I do not lie to Bryn Ollery. Not about the money, not about the yard, not by leaving it out.',
            rank: 1,
            broken: false,
            brokenScene: null,
          },
          {
            id: 'the-aveline-stays',
            text: 'Dad’s boat does not leave this yard while he is alive.',
            rank: 2,
            broken: false,
            brokenScene: null,
          },
          {
            id: 'sam-finishes',
            text: 'Sam finishes his time before I ask him for anything.',
            rank: 3,
            broken: false,
            brokenScene: null,
          },
          {
            id: 'nothing-at-the-glebe',
            text: 'Nothing about Dad gets decided in Marie’s kitchen.',
            rank: 5,
            broken: false,
            brokenScene: null,
          },
        ],
        drives: ['keep the yard working', 'be the one who carries it'],
        breakingPoint:
          'Bryn’s hands on the crane controls at two-forty on Friday, and the only way to keep them there being a sentence she knows is untrue.',
        costOfBreak:
          'Forty-one years would end in the quay car park. Winnie would have it round the Lane by Saturday, Grace would never speak to her again, and the unbearable part is that Bryn would still turn up on Monday.',
      },
      voice: {
        diction:
          'Short. Trade nouns. Converts every feeling into a logistics problem and then solves the logistics problem. Says “we” about the yard and “I” about the debt.',
        tics: [
          'answers a question about money with a fact about the tide',
          'uses surnames when she is angry, including her family’s',
          'says “that’s not a decision, it’s a” and then a number',
        ],
        samples: [
          'That’s not a decision, Kit, it’s a tide table. Two-forty Friday, then nothing until the eleventh.',
          'I’ve not asked you to do anything I wouldn’t do. I’m aware that isn’t the same as fair.',
          'Don’t tell me what Dad would have wanted. I’m the one who wipes his chin.',
        ],
        never: ['says the word insolvent', 'cries anywhere she can be seen', 'asks Marie for anything at all'],
      },
      appearance: {
        description:
          'Fifty-two, wiry, cropped grey-brown hair she cuts herself. Weather-reddened across the nose and cheekbones. Stands with her weight back like someone expecting the ground to move.',
        attire: 'Yard fleece over a work shirt, cargo trousers, steel toecaps. A good coat that never leaves the hook.',
        markers: [
          'a thumbnail that has grown back wrong since 2016',
          'reading glasses pushed up into her hair and forgotten there',
        ],
      },
    },

    // ---------------------------------------------------------- player two: Nessa
    //
    // The vow is a professional ethic, which in a contemporary register is
    // exactly what a vow is. The gate will fire the moment the player has her
    // hint at page four.
    {
      entityId: 'char:nessa-coyle',
      identity: {
        goals: [
          'keep six clients on one street who are about to be on two sides',
          'get her mother assessed without her mother finding out she asked',
          'not be the one who says it first',
        ],
        wounds: [
          'she wrote Kit a letter the week after he left and never sent it, and still has it',
          'she came back from college for one term in 2011 and never got round to leaving again',
        ],
        fears: ['being the professional in the room while somebody she loves signs the wrong page'],
        allegiances: ['her clients, plurally and awkwardly', 'Hattie', 'Harbour Lane as an actual place'],
        competencies: [
          'management accounts in an afternoon',
          'saying no in a tone nobody can take offence at',
          'knowing which of two sets of figures is the honest one',
        ],
        secrets: [
          'she keeps the books for both Tarrant & Sons and Voss Coastal Lettings',
          'she has read the guarantee and knows whose name is typed on it',
        ],
        arc: 'A woman whose one rule has kept her useful, solvent and slightly outside her own life, being asked whether it is a principle or a place to hide.',
      },
      contract: {
        vows: [
          {
            id: 'client-confidence',
            text: 'What is in a client’s books stays in the books. Not the numbers, not the shape of them, not a look across a table.',
            rank: 1,
            broken: false,
            brokenScene: null,
          },
          {
            id: 'no-going-back',
            text: 'I do not go back to anything I already ended.',
            rank: 2,
            broken: false,
            brokenScene: null,
          },
          {
            id: 'tuesdays-are-mums',
            text: 'Tuesdays are Mum’s. Nothing gets booked over them.',
            rank: 4,
            broken: false,
            brokenScene: null,
          },
        ],
        drives: ['be the one person on this street who cannot be leaned on', 'get it right rather than get it settled'],
        breakingPoint:
          'Kit at her desk with a pen already in his hand, page four face down, asking her plainly whether he should sign it.',
        costOfBreak:
          'Six clients on two hundred metres of street. She would have to tell Dev Nandra why he needed a new bookkeeper, and she does not lie to Dev, so she would have to say it out loud in the chandlery.',
      },
      voice: {
        diction:
          'Precise, unhurried, professional register worn as armour. Uses numbers as a way of not saying things. Restates a question before she answers a different one.',
        tics: [
          'says “I’m not able to tell you that” in the same tone as good morning',
          'quotes a page number instead of a fact',
          'goes quiet for one full beat before anything true',
        ],
        samples: [
          'I’m not able to tell you that.',
          'You’re asking me what I’d do. I’d read page four. Slowly.',
          'I have done your mother’s VAT since I was twenty-three. That is not the same as knowing you, Kit.',
        ],
        never: ['gossips', 'guesses out loud', 'says trust me', 'talks about one client in front of another'],
      },
      appearance: {
        description:
          'Thirty-seven, dark hair up with a pencil through it about half the time, the settled stillness of someone who works sitting down and rows twice a week anyway.',
        attire: 'Good jumper, decent boots, a coat with a laptop bag permanently over the same shoulder.',
        markers: ['a biro line on the inside of her right wrist most days', 'her grandmother’s watch, wound by hand'],
      },
    },

    // --------------------------------------------------------- player three: Iris
    //
    // Three of her four vows are in each other's way, which is the design: the
    // rank-1 rule about Bee is the only part of the marriage still functioning,
    // and Friday puts it in the same room as the sentence she has to say.
    {
      entityId: 'char:iris-kellow',
      identity: {
        goals: [
          'get Bee’s birthday through Friday intact',
          'find out what the cellar needs before the Trust’s hearing does',
          'say the word to Tom without an audience',
        ],
        wounds: [
          'the January water took the cellar stock and something else she has not named',
          'she was going to leave in 2019 and Bee got croup',
        ],
        fears: [
          'that Bee has already worked it out and is being kind',
          'becoming her mother, who ran the same bar and never left it',
        ],
        allegiances: [
          'Bee, first and by a distance',
          'the Ferryman as a going concern',
          'the Lane traders, tactically',
        ],
        competencies: [
          'a full bar and three conversations at once',
          'reading a room before she is in it',
          'cellar work nobody has ever thanked her for',
        ],
        secrets: [
          'she has been going down to the gig shed on Thursday evenings',
          'she has already had Marie’s figure and has not told Tom it arrived',
        ],
        arc: 'A woman who is superb in public and mute in private, discovering that the rule protecting her daughter is also the rule keeping her married.',
      },
      contract: {
        vows: [
          {
            id: 'not-in-front-of-bee',
            text: 'Bee does not hear it. Not one word of it, not once, not through a wall.',
            rank: 1,
            broken: false,
            brokenScene: null,
          },
          {
            id: 'not-before-close',
            text: 'I do not drink in my own bar before close. Not since January.',
            rank: 2,
            broken: false,
            brokenScene: null,
          },
          {
            id: 'not-while-wearing-it',
            text: 'I do not put a hand on anybody else while I am still wearing the ring.',
            rank: 3,
            broken: false,
            brokenScene: null,
          },
          {
            id: 'nobody-barred-for-me',
            text: 'Nobody gets asked to leave this pub for something they said about me.',
            rank: 5,
            broken: false,
            brokenScene: null,
          },
        ],
        drives: ['hold the room', 'get her daughter to twelve without a scene in it'],
        breakingPoint:
          'Friday at seven, the back room double-booked, and Tom saying the entirely true thing in a normal voice with the serving hatch open.',
        costOfBreak:
          'Bee stops keeping the tide table. She goes to Tom’s sister in Bilton and is scrupulously fair about the arrangements, and Iris does not think she could stand being treated fairly by her own child.',
      },
      voice: {
        diction:
          'Bar-fluent: fast, warm, pitched at the room rather than the person. Switches to flat monosyllables the second a door shuts. Public voice and private voice are two different instruments.',
        tics: [
          'answers the person by talking to the room',
          'wipes something down while delivering the bad half',
          'says “right” at the end of a sentence to close it',
        ],
        samples: [
          'Not in here. Take it out to the car park like a grown man, right.',
          'I’ve got forty covers and a birthday. Whatever this is, it’s Saturday’s problem.',
          'You’re allowed to want things, Grace. I’m the one who isn’t.',
        ],
        never: [
          'says the word divorce',
          'argues where a customer can hear',
          'admits to being tired',
          'lets Bee see her crying',
        ],
      },
      appearance: {
        description:
          'Forty-three, dark red hair pinned up for service, strong forearms from twenty years of cellar work, and a public smile she can hold for six hours.',
        attire:
          'Black shirt with the sleeves turned back, apron off the moment she leaves the bar, good earrings always.',
        markers: [
          'a burn scar the width of a pencil on the inside of the left wrist, from the glasswasher',
          'a wedding ring that moves between hand and apron pocket depending which room she is in',
        ],
      },
    },

    // ------------------------------------------------ the ones with their own vows
    //
    // The people who can be played against. Each has a contract, because the
    // integrity gate is not only the player's: a Narrator that knows what Bryn
    // will not do writes a better Bryn.
    {
      entityId: 'char:kit-tarrant',
      identity: {
        goals: [
          'find out what he is being asked to sign before he signs it',
          'see his father alone',
          'not be the one who leaves again',
        ],
        wounds: [
          'the row in the shed, of which he remembers a sentence nobody else remembers saying',
          'fourteen years of a phone he could have used at any point',
        ],
        fears: [
          'that he is exactly what Marie says he is',
          'the Aveline going to someone who will keep her on a mooring',
        ],
        allegiances: ['nobody yet, which is the problem'],
        competencies: ['making a room comfortable inside ninety seconds', 'joinery, badly out of practice', 'leaving'],
        secrets: ['Marie’s solicitor wrote to him in July; the boat had nothing to do with it'],
        arc: 'A man who has been forgiven in advance by everyone except himself, finding out that the family has been running perfectly well on his absence.',
      },
      contract: {
        vows: [
          {
            id: 'no-more-vanishing',
            text: 'I don’t do that again. Whatever this turns into, I don’t just go.',
            rank: 1,
            broken: false,
            brokenScene: null,
          },
          {
            id: 'not-nessas-problem',
            text: 'I don’t make Nessa Coyle carry anything of mine. Not again.',
            rank: 2,
            broken: false,
            brokenScene: null,
          },
        ],
        drives: ['be useful for once, visibly', 'be liked in the room he is in'],
        breakingPoint: 'Being told, accurately and in front of Bryn, exactly what his leaving cost.',
        costOfBreak:
          'The second time is not a departure, it is a verdict, and Sam is old enough now to read it as one.',
      },
      voice: {
        diction:
          'Fluent, funny, apologises pre-emptively. Talks about the present in the past tense. Fills every silence and knows he does it.',
        tics: [
          'says “right” as a complete sentence while thinking',
          'makes the joke one beat before it would be needed',
          'starts a sentence, hears it, and starts a different one',
        ],
        samples: [
          'Right. So. Nobody’s going to tell me. That’s the plan, is it.',
          'I didn’t come back for the boat.',
          'You look — you look the same, which is an appalling thing to say to a person, I’m aware of that.',
        ],
        never: ['raises his voice', 'says he was homesick', 'asks about the will in a straight line'],
      },
      appearance: {
        description:
          'Thirty-eight, the Tarrant jaw and none of the Tarrant stillness. Softer through the shoulders than a yard would make a man. Moves like a visitor.',
        attire:
          'Town coat that is wrong for the slipway, good boots ruined within a day, no hat in weather that needs one.',
        markers: ['a scar across the left eyebrow from a shed door in 2004'],
      },
    },
    {
      entityId: 'char:marie-voss',
      identity: {
        goals: [
          'a decision, in writing, with three signatures on it',
          'the Glebe’s mortgage off Ivo’s books',
          'to be thanked once, out loud',
        ],
        wounds: [
          'two years of Sunday visits nobody has ever mentioned to her',
          'being the middle one, and the one who married',
        ],
        fears: ['that Rhona is right about her', 'the yard going under and taking Ivo’s business with it'],
        allegiances: ['her household', 'Tansy', 'the version of events in which she behaved well'],
        competencies: ['chairing a room without appearing to', 'paperwork', 'patience of a very specific kind'],
        secrets: ['the buyer she has brought is Ivo, through a company name'],
        arc: 'A woman who is not wrong about a single fact and is going to lose anyway on the strength of her tone.',
      },
      contract: {
        vows: [
          {
            id: 'nothing-behind-rhonas-back',
            text: 'I don’t do anything to that yard I wouldn’t say to Rhona’s face.',
            rank: 2,
            broken: false,
            brokenScene: null,
          },
          {
            id: 'dad-not-in-the-room',
            text: 'Dad doesn’t get used. Not by her and not by me.',
            rank: 1,
            broken: false,
            brokenScene: null,
          },
        ],
        drives: ['be recognised as the reasonable one', 'settle it before the winter does'],
        breakingPoint:
          'Rhona saying, in front of Kit, that Marie never did anything for the old man that wasn’t bankable.',
        costOfBreak: 'She becomes what Rhona has been calling her since 2019, and Tansy is in the house to watch it.',
      },
      voice: {
        diction:
          'Reasonable, agenda-shaped, uses first names the way a chair of a meeting does. Concedes the small thing to take the large one.',
        tics: [
          'prefaces disagreement with “I hear you”',
          'says “realistically”',
          'restates your point better than you did, then dismantles it',
        ],
        samples: [
          'I hear you. Realistically, though.',
          'Nobody is taking anything from anybody. There is a price and there is a market.',
          'I visited every Sunday for two years while you were being magnificent about it.',
        ],
        never: ['shouts', 'admits Ivo is the buyer', 'sets foot in the big shed'],
      },
      appearance: {
        description:
          'Forty-six, groomed in a way the Lane notices, the same jaw as her brother and considerably better posture.',
        attire: 'Coat that has never been rained on hard, boots for a car, one good ring.',
        markers: ['reading glasses she puts on to end a conversation'],
      },
    },
    {
      entityId: 'char:ivo-voss',
      identity: {
        goals: [
          'the yard site, at the price he has already modelled',
          'the change-of-use clause left exactly as drafted',
        ],
        fears: ['being seen to be the buyer before contracts', 'Dev Nandra at a public meeting'],
        allegiances: ['Voss Coastal Lettings', 'Marie, sincerely, and second'],
        competencies: [
          'planning process',
          'being liked by people who are not paying attention',
          'never saying the number first',
        ],
        secrets: ['fourteen apartments and a marina office; the drawings are eight months old'],
        arc: 'A man who genuinely believes he is saving the street and will be astonished to be hated for it.',
      },
      contract: {
        vows: [
          {
            id: 'never-first-number',
            text: 'I never say the number first.',
            rank: 3,
            broken: false,
            brokenScene: null,
          },
        ],
        drives: ['win the site', 'be thought of as local'],
        breakingPoint: 'Marie finding out how long the drawings have existed.',
        costOfBreak: 'He would have to be the villain in his own kitchen, which he has never once been.',
      },
      voice: {
        diction:
          'Salesman’s warmth with planning-application vocabulary underneath. Compliments the building before mentioning the offer.',
        tics: [
          'says “no pressure at all” under pressure',
          'calls things “the site”',
          'laughs at the end of his own sentences',
        ],
        samples: [
          'It’s a beautiful shed. Genuinely. No pressure at all — I just think somebody should say what it’s worth.',
          'Change of use is standard. It’s in every lease on this foreshore.',
        ],
        never: ['names his own figure first', 'goes into the pub', 'says the word flats'],
      },
      appearance: {
        description:
          'Forty-nine, well-kept, the tan of somebody who shows people around properties. Handshake arrives early.',
        attire: 'Quarter-zip, chinos, boat shoes in October.',
        markers: ['sunglasses on the head indoors'],
      },
    },
    {
      entityId: 'char:bryn-ollery',
      identity: {
        goals: ['get the Aveline out on Friday', 'see Sam through his time', 'not have to ask'],
        wounds: ['he found Douglas on the shed floor and has not worked past four o’clock alone since'],
        fears: ['being the last one, and being told so kindly'],
        allegiances: ['Douglas Tarrant', 'the yard, which is not the same as the company'],
        competencies: ['forty-one years of oak, larch and iron sickness', 'a crane on a falling tide', 'silence'],
        secrets: ['he has known since June and has told nobody, including Winnie'],
        arc: 'A man whose loyalty is indistinguishable from his pride, being made to choose which of the two he actually has.',
      },
      contract: {
        vows: [
          {
            id: 'never-above-her-head',
            text: 'I don’t go over Rhona’s head. Not to Marie, not to the Trust, not to my own wife.',
            rank: 1,
            broken: false,
            brokenScene: null,
          },
          {
            id: 'boy-goes-home-whole',
            text: 'The boy goes home in one piece every night. That’s the job before the job.',
            rank: 2,
            broken: false,
            brokenScene: null,
          },
        ],
        drives: ['finish what is on the bench', 'be worth keeping'],
        breakingPoint: 'Being lied to about the money by Rhona, directly, with the lift already in the air.',
        costOfBreak:
          'He would say one sentence to Winnie and then the whole Lane would own it, and he would never get it back.',
      },
      voice: {
        diction:
          'Slow, exact, forty-one years of not needing many words. Talks about the boat when he means the people.',
        tics: [
          'names timber by species',
          'says “she’ll do” as the highest praise available',
          'answers after a count of three',
        ],
        samples: [
          'She’ll do.',
          'I’ve not asked. You’ll have noticed I’ve not asked.',
          'Your father would have had that roof off in a fortnight and then we’d all have got wet.',
        ],
        never: ['complains about money', 'says he is owed anything', 'raises it in front of Sam'],
      },
      appearance: {
        description:
          'Sixty-one, thick through the chest, hands you would recognise from across a car park. Deaf in the left ear from the planer and pretending otherwise.',
        attire: 'Boiler suit over two jumpers from September to May, a woollen hat that predates his daughter.',
        markers: [
          'left index finger short at the top joint',
          'a permanent horizontal crease across the forehead from a hat brim',
        ],
      },
    },
    {
      entityId: 'char:tom-kellow',
      identity: {
        goals: [
          'the Friday service out clean',
          'to be told he is not imagining it',
          'Bee’s birthday to be exactly as booked',
        ],
        wounds: ['nine inches of January water and a kitchen he rebuilt himself over five weeks'],
        fears: ['that she has already gone and is finishing the notice period'],
        allegiances: ['Bee', 'the kitchen', 'the rota'],
        competencies: [
          'forty covers alone',
          'costing a menu to the penny',
          'holding a grievance at a low simmer for years',
        ],
        secrets: ['he has known about Thursdays since the second week and has said nothing'],
        arc: 'A man who has confused doing everything with being indispensable, and is about to find out which one Iris needed.',
      },
      contract: {
        vows: [
          {
            id: 'bee-hears-nothing',
            text: 'Whatever happens, Bee hears none of it from me.',
            rank: 1,
            broken: false,
            brokenScene: null,
          },
          {
            id: 'service-comes-out',
            text: 'The service goes out. I have never once sent a bad plate and I am not starting over this.',
            rank: 2,
            broken: false,
            brokenScene: null,
          },
        ],
        drives: ['be the one who stayed', 'have it acknowledged'],
        breakingPoint: 'Grace Ollery standing in his kitchen doorway on a Friday with the hatch open.',
        costOfBreak:
          'He becomes the man who said it in front of the room, and in Brackmouth that is the only fact about him that survives.',
      },
      voice: {
        diction: 'Kitchen shorthand: imperatives, timings, nothing wasted. Sincere only when facing the other way.',
        tics: [
          'gives the answer as a time',
          'says “yeah, no” when he means no',
          'names the day something was arranged',
        ],
        samples: [
          'Yeah, no. Six minutes, and then we’ll do it properly.',
          'I booked it in January. I told you in January, Iris.',
          'I’m not the one who stopped.',
        ],
        never: ['leaves the kitchen mid-service', 'says the word divorce', 'criticises her in front of Col'],
      },
      appearance: {
        description:
          'Forty-five, heavy-set, forearms scarred the way every chef’s are, a tea towel over the shoulder as permanent uniform.',
        attire: 'Whites gone grey at the cuff, apron doubled over at the waist, clogs.',
        markers: ['a burn on the right forearm in the shape of an oven shelf'],
      },
    },
    {
      entityId: 'char:grace-ollery',
      identity: {
        goals: [
          'get her father his wages without him finding out she asked',
          'keep the crew rowing through winter',
          'not be somebody’s secret',
        ],
        wounds: ['a marriage in Bilton that ended quietly and which the Lane still asks about'],
        fears: ['being the reason a child’s home comes apart'],
        allegiances: ['Bryn', 'the gig crew', 'her caseload, which includes half the cast'],
        competencies: ['clinical calm', 'asking the direct question and then waiting', 'a full ten-mile row'],
        secrets: ['she has told nobody about Thursdays and intends to keep it that way'],
        arc: 'A woman who is honest with everyone about everything except the one thing, discovering that this is not the same as being honest.',
      },
      contract: {
        vows: [
          {
            id: 'nothing-that-costs-a-child',
            text: 'I don’t take anything that costs a child its house.',
            rank: 1,
            broken: false,
            brokenScene: null,
          },
          {
            id: 'never-a-patients-business',
            text: 'What I learn on a visit is not mine to use. Ever, and not even for Dad.',
            rank: 2,
            broken: false,
            brokenScene: null,
          },
        ],
        drives: ['say the true thing first', 'be able to look at her own week'],
        breakingPoint:
          'Iris on the sea wall path saying she has decided, and Bee still being ten for another two days.',
        costOfBreak:
          'She would be the woman who broke up the Ferryman, in a town where that sentence outlives everybody in it.',
      },
      voice: {
        diction:
          'Clinical calm as a personality. Asks the question the room is avoiding, then leaves the silence open exactly two beats too long.',
        tics: ['counts things out loud', 'uses full names when it is serious', 'says “when” rather than “if”'],
        samples: [
          'When did he last get paid, Rhona.',
          'I’m not asking as his daughter. Well. I am. But I’d ask anyway.',
          'You can say it out here. There’s nobody on this bank for a mile.',
        ],
        never: ['discusses a patient', 'lies to her father', 'goes into the pub on a Thursday'],
      },
      appearance: {
        description:
          'Thirty-four, rower’s shoulders, her father’s hands at two-thirds scale, hair cut short for practicality and kept that way out of preference.',
        attire:
          'Navy uniform tunic on a working day, a fleece with the crew’s initials on it every other hour of her life.',
        markers: ['oar callus across both palms', 'a fine scar under the chin from a childhood fall on the slipway'],
      },
    },
    {
      entityId: 'char:douglas-tarrant',
      identity: {
        goals: ['the boat finished', 'to be understood the first time'],
        wounds: ['forty words, and the certainty that he had more of them this morning'],
        fears: ['being decided about in a room he is not in'],
        allegiances: ['Bryn Ollery', 'the Aveline'],
        competencies: ['sixty years of knowing which way a hull wants to go', 'refusal'],
        secrets: ['he would not sign the second will, and Orla Dace was there when he would not'],
        arc: 'A man who built everything anyone is arguing about and can no longer put a sentence into the argument.',
      },
      contract: {
        vows: [
          {
            id: 'not-sold-under-me',
            text: 'Not while I’m in it. Not the yard.',
            rank: 1,
            broken: false,
            brokenScene: null,
          },
        ],
        drives: ['be asked, not told'],
        breakingPoint: 'Being shown a paper by Marie with a pen already uncapped.',
        costOfBreak: 'He would sign it, and then he would know he had, for however long he had left to know things.',
      },
      voice: {
        diction:
          'Nouns arrive late or not at all. Gets there by a different road: names a tool when he means a person, a boat when he means a year.',
        tics: [
          'taps the bed rail twice for no',
          'says “the — the —” and then a boat’s name',
          'closes his eyes to end a conversation',
        ],
        samples: ['Aveline.', 'Not the — not the girl. The other one.', 'Bryn.', 'No. No. Chisel.'],
        never: ['long sentences', 'explains himself twice', 'lets Marie hold his hand'],
      },
      appearance: {
        description:
          'Seventy-nine, big-framed and gone light inside it, the left side of his face slower than the right. Yard hands, unmistakably, on a hospital blanket.',
        attire: 'Cardigan over pyjamas until eleven, then a shirt Winnie buttons for him and a good jumper.',
        markers: ['left hand curled in on itself', 'a tattoo on the forearm gone blue-green and unreadable'],
      },
    },

    // ------------------------------------------------------------ the rest of it
    //
    // Lighter sheets: a goal, a voice and a body. In a contemporary setting the
    // voice card is doing nearly all of the differentiating work, so nobody gets
    // a placeholder diction line even at this depth.
    {
      entityId: 'char:sam-tarrant',
      identity: {
        goals: ['the Bilton course, without it being a betrayal'],
        fears: ['his mother finding the letter before he says it'],
        secrets: ['he has an offer of a place starting in January and has shown it to Cass Frew only'],
      },
      voice: {
        diction:
          'Mumbled and deflective about everything except engines and rowing, on which he is suddenly fluent and slightly boring.',
        tics: ['says “it’s fine” as a complete refusal', 'looks at his phone when the subject is his own future'],
        samples: ['It’s fine.', 'Bryn says the transom’s going to need doing anyway, so.'],
        never: ['says he wants to leave', 'contradicts Bryn in the shed'],
      },
      appearance: {
        description:
          'Nineteen, tall and not finished, his grandfather’s hands arriving early on somebody still working out how to stand.',
        attire: 'Yard overalls with the sleeves cut off over a hoodie, regardless of temperature.',
        markers: ['epoxy in the hair, permanently'],
      },
    },
    {
      entityId: 'char:bee-kellow',
      identity: {
        goals: ['the back room on Friday, as promised, for the whole evening'],
        fears: ['the answer to the question she has not asked'],
        secrets: ['she has written Friday’s tide heights on the back of the specials board'],
      },
      voice: {
        diction: 'Exact, literal, obsessed with numbers and with things being unfair in a way she can demonstrate.',
        tics: ['corrects adults on figures', 'asks what a word means and never asks twice'],
        samples: ['High water’s two-forty, not three.', 'You said Friday was mine.', 'Is it because of the cellar?'],
        never: ['cries in the bar', 'asks either parent about the other'],
      },
      appearance: {
        description:
          'Ten, small for it, hair in a plait she does herself badly, a biro behind the ear in imitation of somebody.',
        attire: 'School jumper until nine at night, wellingtons at every opportunity.',
        markers: ['a plaster on one knee more or less permanently'],
      },
    },
    {
      entityId: 'char:winnie-ollery',
      identity: { goals: ['Bryn’s wages, and an apology, in that order'], fears: ['that he will let them keep him'] },
      voice: {
        diction:
          'Short, hot and audible. Says the accurate thing at the wrong volume, in the wrong room, to the wrong person, and is generally right.',
        tics: ['starts sentences with “no, because—”', 'names the amount'],
        samples: ['No, because it’s five months, Rhona. Not two. Five.', 'He won’t say it so I will.'],
        never: ['lets it go', 'says it to Bryn’s face'],
      },
      appearance: { description: 'Fifty-nine, brisk, carehome tabard and outdoor shoes, reading glasses on a cord.' },
    },
    {
      entityId: 'char:hattie-coyle',
      identity: {
        goals: ['her Tuesdays, and to be useful in them'],
        secrets: ['she has missed three shifts and logged them anyway'],
      },
      voice: {
        diction:
          'Cheerful and entirely indiscreet. Calls everybody love. Repeats what Douglas manages to say, with confident interpretation added.',
        tics: ['says “well”, then everything', 'reports speech she has improved'],
        samples: ['He said Aveline, love. Twice. Well — you know what he means.'],
        never: ['admits she has forgotten something', 'keeps anything to herself for more than a day'],
      },
      appearance: { description: 'Sixty-eight, small and quick, tabard over a cardigan, hair set once a fortnight.' },
    },
    {
      entityId: 'char:dev-nandra',
      identity: {
        goals: ['the Lane with six trading businesses on it in five years'],
        fears: ['being the last shop with a light on'],
      },
      voice: {
        diction:
          'Counter-side courtesy, exact prices from memory, and a quiet, extremely patient political position about the window displays.',
        tics: ['gives the price and then the trade price', 'says “for you” before a discount he gives everyone'],
        samples: [
          'Four twenty. Three sixty for you. It’s the same bolt, Rhona.',
          'Fifty-one houses with nobody in them in February. You tell me what that is.',
        ],
        never: ['refuses credit to somebody local', 'sets foot in the Old Post Office'],
      },
      appearance: { description: 'Sixty-three, upright, shop coat over a shirt and tie he has worn daily since 1994.' },
    },
    {
      entityId: 'char:priya-nandra',
      identity: {
        goals: ['Bee through the term without a referral'],
        secrets: ['there is a dated note in her file about a child asleep at eleven in the morning'],
      },
      voice: {
        diction:
          'Teacher-clear and warm, professionally careful about what she has noticed. Says less than she knows and knows she is doing it.',
        tics: ['repeats a child’s own words back to them', 'says “I’m going to be honest with you” and then is'],
        samples: ['She’s fine. She’s tired. I’m telling you because you’d want to know, not because it’s a thing yet.'],
        never: ['gossips at the gate', 'discusses one parent with another'],
      },
      appearance: { description: 'Twenty-nine, lanyard, sensible shoes, rower’s hands that surprise people.' },
    },
    {
      entityId: 'char:aiden-frew',
      identity: {
        goals: ['the school’s numbers up, the governors quiet'],
        wounds: ['1994, and a fortnight he still counts from'],
      },
      voice: {
        diction:
          'Assembly voice he cannot switch off. Uses “we” when he means “you”, and “shall we” when he means now.',
        tics: ['says “right then”', 'asks a question he has already answered'],
        samples: [
          'Right then. Shall we not do this at the gate.',
          'We’re going to have a think about that, aren’t we.',
        ],
        never: ['swears', 'says what he means to Iris'],
      },
      appearance: { description: 'Forty-eight, tall, jacket-and-no-tie, a lanyard worn like a badge of office.' },
    },
    {
      entityId: 'char:cass-frew',
      identity: {
        goals: ['out of Brackmouth with Sam or without him'],
        secrets: ['she has seen Sam’s offer letter and has not told her father'],
      },
      voice: {
        diction:
          'Deadpan, fast, funnier than her father and aware of the advantage. Bored voice for adults, real voice for two people.',
        tics: ['answers with a flat statement of the obvious', 'says “yeah” in three different lengths'],
        samples: ['Chips or a conversation. Not both.', 'He’s going. You all know he’s going.'],
        never: ['tells her father anything first'],
      },
      appearance: {
        description: 'Seventeen, fryer-shiny fringe pinned back, apron over a school shirt, eyeliner regardless.',
      },
    },
    {
      entityId: 'char:deb-molloy',
      identity: { goals: ['everybody fed and the whole story'], competencies: ['credit, extended and remembered'] },
      voice: {
        diction:
          'Fryer-side commentary, generous with food and money, and absolutely will repeat it before the oil is cool.',
        tics: ['asks the follow-up question while wrapping', 'says “I’ll not say who”'],
        samples: ['Salt? — I’ll not say who, but there’s a surveyor been in twice.', 'Put it on the book, love.'],
        never: ['takes money off Bryn Ollery', 'says the thing to somebody’s face'],
      },
      appearance: {
        description: 'Fifty-eight, comfortable, sleeves up, half-glasses on a chain, permanently slightly damp.',
      },
    },
    {
      entityId: 'char:col-molloy',
      identity: { goals: ['enough hours between two jobs'], fears: ['being asked what he actually wants'] },
      voice: {
        diction:
          'Talks constantly while working and never once about himself. Redirects every personal question into a practical one.',
        tics: ['says “aye, well” as a full paragraph', 'offers to do the thing instead of discussing it'],
        samples: ['Aye, well. I’ll get the props out, shall I.'],
        never: ['gives an opinion about the Tarrants'],
      },
      appearance: { description: 'Twenty-six, wiry, fryer-burn on both forearms, beanie in all weathers.' },
    },
    {
      entityId: 'char:eddie-quill',
      identity: {
        goals: ['to be needed in the shed on Friday'],
        secrets: ['he knows the document box is behind the paint shelf'],
      },
      voice: {
        diction:
          'Anecdote as argument. Every story is about a boat, takes four minutes, and ends in a warning nobody asked for.',
        tics: ['starts with a year', 'ends with “and they never did it again”'],
        samples: ['Seventy-nine. We lifted a forty-footer on a falling tide and they never did it again.'],
        never: ['stays away for more than a week'],
      },
      appearance: { description: 'Sixty-seven, small, flat cap, a boiler suit he has no working reason to own.' },
    },
    {
      entityId: 'char:tansy-voss',
      identity: {
        goals: ['a season on the Aveline before she is sold'],
        fears: ['being made to choose a side by either parent'],
      },
      voice: {
        diction: 'Technical, blunt, sixteen, and entirely uninterested in the family politics she is standing inside.',
        tics: ['corrects terminology', 'says “can I just—” and then does'],
        samples: ['It’s not a rope, it’s a warp. Can I just do the props?'],
        never: ['repeats anything said in the shed at home'],
      },
      appearance: { description: 'Sixteen, in her mother’s good coat over yard clothes, hair shoved through a cap.' },
    },
    {
      entityId: 'char:len-fewkes',
      identity: { goals: ['a renewal that survives an audit'], fears: ['a trustee saying something minuted'] },
      voice: {
        diction:
          'Committee English. Reads out clause numbers and believes reading them out is the same as being neutral.',
        tics: ['says “as per”', 'quotes the sub-clause letter'],
        samples: ['Clause eleven, sub-paragraph (c). It’s standard. It’s in every lease on this foreshore.'],
        never: ['gives an opinion on the record'],
      },
      appearance: {
        description: 'Fifty-five, fleece with the Trust’s crest, clipboard, a lanyard nobody has ever checked.',
      },
    },
    {
      entityId: 'char:jerome-hyde',
      identity: { goals: ['both his committees agreeing with him separately'] },
      voice: {
        diction:
          'Governor-speak. Says “as I understand it” about decisions he took last month, and “we’d all agree” before something nobody agrees with.',
        tics: ['says “as I understand it”', 'attributes his own view to consensus'],
        samples: ['As I understand it, the Trust’s hands are somewhat tied.'],
        never: ['puts anything in writing'],
      },
      appearance: { description: 'Fifty-two, gilet, good car keys on the table, a handshake with a squeeze in it.' },
    },
    {
      entityId: 'char:russ-pardoe',
      identity: { goals: ['his report acted on, and his invoice paid'] },
      voice: {
        diction:
          'Report prose out loud. Dates everything, qualifies everything, and is impossible to be angry at accurately.',
        tics: ['gives the date of his own letter', 'says “in my opinion, and it is only an opinion”'],
        samples: ['My letter of the eleventh. In my opinion, and it is only an opinion, that roof has one winter.'],
        never: ['softens a finding'],
      },
      appearance: {
        description: 'Forty-four, high-vis over a fleece, hard hat under the arm, tablet in a rubber case.',
      },
    },
    {
      entityId: 'char:fen-alder',
      identity: {
        goals: ['the permanent post, or a decision not to want it'],
        fears: ['still being the locum in three years'],
      },
      voice: {
        diction:
          'Careful and slightly formal, an imported vocabulary in a town with its own. Has not earned the shorthand and refuses to fake it.',
        tics: [
          'asks permission before saying the difficult thing',
          'uses the full clinical word and then the plain one',
        ],
        samples: [
          'May I say something you won’t like? — Aphasia. He can’t find the word. It isn’t that he doesn’t know it.',
        ],
        never: ['pretends to be local', 'discusses a patient in the waiting room'],
      },
      appearance: {
        description: 'Thirty-nine, neat, a cycling jacket over surgery clothes, glasses pushed up constantly.',
      },
    },
    {
      entityId: 'char:orla-dace',
      identity: {
        goals: ['Douglas Tarrant’s wishes honoured without her having to breach a confidence to do it'],
        secrets: ['she watched him refuse to sign and was asked to say nothing'],
      },
      voice: {
        diction:
          'Plain, unshockable, refuses metaphor entirely. Will say the blunt sentence and then wait it out without softening it.',
        tics: ['answers the question actually asked', 'says “I can’t tell you that, and you know why”'],
        samples: ['He said no. That’s all I’m able to tell you, Rhona, and you know why.'],
        never: ['uses a comforting phrase she does not mean', 'takes a side in the back room'],
      },
      appearance: {
        description: 'Fifty-seven, collar under a waterproof, muddy boots, a churchyard rake habitually in hand.',
      },
    },
    {
      entityId: 'char:mo-abiri',
      identity: {
        goals: ['the club’s funding renewed'],
        competencies: ['knowing exactly which parents are late, and how often'],
      },
      voice: {
        diction: 'Warm, practical, keeps a mental register of every pickup time and mentions it only when it matters.',
        tics: ['says “no bother at all” while noting it', 'names the time'],
        samples: ['Twenty past six. No bother at all.'],
        never: ['makes a parent feel it in front of the child'],
      },
      appearance: { description: 'Forty-one, club polo shirt, keys and a laminated register on a neck cord.' },
    },
  ],

  scenarios: [
    // ========================================================== scenario one
    //
    // The family firm. Anchored on the yard cluster, and built so the rank-1
    // vow and the only viable plan point in opposite directions: the Aveline
    // does not come off the mud without Bryn, and Bryn does not stay on the
    // crane if Rhona tells him the truth this morning.
    {
      id: 'the-haul-out',
      title: 'The Haul-Out',
      premise: `Friday's two-forty is the last tide big enough to lift the Aveline off the mud for four weeks,
and in four weeks the Harbour Trust will have renewed the lease with a change-of-use clause in it. You are
Rhona Tarrant. Bryn Ollery has not been paid since March and has made a point of not asking. Your brother
Kit is standing in your office for the first time in fourteen years, and your sister is parking outside with
a buyer she will not name.`,
      playerCharacterId: 'char:rhona-tarrant',
      openingLocationId: 'loc:the-yard-office',
      openingScene: 'Nine o’clock, and three people in an office built for one',
      focus: {
        'char:rhona-tarrant': 'focal',
        'char:bryn-ollery': 'focal',
        'char:kit-tarrant': 'focal',
        'char:marie-voss': 'focal',
        'char:sam-tarrant': 'focal',
        'item:the-aveline': 'focal',
        'item:the-surveyors-letter': 'focal',
        'concept:the-haul-out': 'focal',
        'loc:the-yard-office': 'focal',
        'loc:the-big-shed': 'focal',
        'char:ivo-voss': 'principal',
        'char:douglas-tarrant': 'principal',
        'char:nessa-coyle': 'principal',
        'char:grace-ollery': 'principal',
        'char:winnie-ollery': 'principal',
        'char:len-fewkes': 'principal',
        'char:tansy-voss': 'principal',
        'char:eddie-quill': 'principal',
        'concept:the-lease-renewal': 'principal',
        'concept:the-arrangement': 'principal',
        'item:the-yard-ledger': 'principal',
        'item:the-second-will': 'principal',
        'loc:the-slipway': 'principal',
        'loc:the-mud-berth': 'principal',
        'loc:douglas-room': 'principal',
        'event:the-night-kit-left': 'principal',
        'char:deb-molloy': 'supporting',
        'char:col-molloy': 'supporting',
        'char:dev-nandra': 'supporting',
        'char:russ-pardoe': 'supporting',
        'char:orla-dace': 'supporting',
        'char:jerome-hyde': 'supporting',
        'char:hattie-coyle': 'supporting',
        'loc:tarrant-house': 'supporting',
        'loc:the-quay-car-park': 'supporting',
        'char:iris-kellow': 'background',
        'char:tom-kellow': 'background',
        'char:bee-kellow': 'background',
        'char:priya-nandra': 'background',
        'char:aiden-frew': 'background',
        'char:cass-frew': 'background',
        'char:fen-alder': 'background',
        'char:mo-abiri': 'background',
      },
      conditions: [
        {
          entityId: 'char:rhona-tarrant',
          locationId: 'loc:the-yard-office',
          mood: 'braced',
          inventory: ['the yard ledger', 'a crane certificate due for renewal', 'the surveyor’s letter, still sealed'],
          intent: 'get to Friday with the crane, the shipwright and the lease all still hers',
        },
        {
          entityId: 'char:kit-tarrant',
          locationId: 'loc:the-yard-office',
          mood: 'over-friendly',
          intent: 'find out what Marie has actually brought him back for',
        },
        {
          entityId: 'char:bryn-ollery',
          locationId: 'loc:the-yard-office',
          mood: 'patient',
          intent: 'get the crane certificate signed off before Friday and say nothing about the money',
        },
        {
          entityId: 'char:sam-tarrant',
          locationId: 'loc:the-big-shed',
          mood: 'evasive',
          intent: 'not be asked about January',
        },
        {
          entityId: 'char:tansy-voss',
          locationId: 'loc:the-big-shed',
          mood: 'cheerful',
          intent: 'be allowed on the props team',
        },
        { entityId: 'char:eddie-quill', locationId: 'loc:the-big-shed', mood: 'reminiscing' },
        {
          entityId: 'char:marie-voss',
          locationId: 'loc:the-quay-car-park',
          mood: 'composed',
          inventory: ['a document wallet', 'the personal guarantee'],
          intent: 'get three signatures on one piece of paper before the weekend',
        },
        {
          entityId: 'char:ivo-voss',
          locationId: 'loc:the-old-post-office',
          mood: 'unhurried',
          intent: 'stay out of the room until it is agreed',
        },
        {
          entityId: 'char:nessa-coyle',
          locationId: 'loc:coyle-bookkeeping',
          mood: 'uneasy',
          intent: 'get the management accounts finished before anybody asks her a direct question',
        },
        {
          entityId: 'char:douglas-tarrant',
          locationId: 'loc:douglas-room',
          mood: 'agitated',
          intent: 'be told what is happening to the boat',
        },
        { entityId: 'char:winnie-ollery', locationId: 'loc:douglas-room', mood: 'simmering' },
        { entityId: 'char:hattie-coyle', locationId: 'loc:douglas-room', mood: 'chatty' },
        {
          entityId: 'char:grace-ollery',
          locationId: 'loc:the-surgery',
          mood: 'decided',
          intent: 'ask Rhona the wages question today, out loud',
        },
        { entityId: 'char:len-fewkes', locationId: 'loc:the-harbour-office', mood: 'procedural' },
        {
          entityId: 'char:russ-pardoe',
          locationId: 'loc:the-harbour-office',
          mood: 'brisk',
          intent: 'get an answer to his letter of the eleventh',
        },
        { entityId: 'char:deb-molloy', locationId: 'loc:molloys', mood: 'interested' },
        { entityId: 'char:col-molloy', locationId: 'loc:molloys', mood: 'available' },
      ],
      relationships: [
        {
          from: 'char:rhona-tarrant',
          to: 'char:bryn-ollery',
          trust: 0.95,
          affection: 0.7,
          respect: 0.9,
          note: 'the only person she has never had to explain herself to, and the one she is currently lying to',
        },
        {
          from: 'char:bryn-ollery',
          to: 'char:rhona-tarrant',
          trust: 0.6,
          affection: 0.55,
          respect: 0.85,
          note: 'knows about the money, has decided that asking would cost her more than it would get him',
        },
        {
          from: 'char:rhona-tarrant',
          to: 'char:kit-tarrant',
          trust: -0.4,
          affection: 0.5,
          respect: -0.3,
          note: 'loves him without liking him, which she could not say and would not deny',
        },
        {
          from: 'char:kit-tarrant',
          to: 'char:rhona-tarrant',
          trust: 0.6,
          affection: 0.4,
          respect: 0.9,
          note: 'assumes she will forgive him because she always has; has not looked at what it cost',
        },
        {
          from: 'char:rhona-tarrant',
          to: 'char:marie-voss',
          trust: -0.7,
          affection: -0.2,
          respect: 0.4,
          note: 'accurate about the yard, wrong about everything that matters, and impossible to argue with',
        },
        {
          from: 'char:marie-voss',
          to: 'char:rhona-tarrant',
          trust: -0.3,
          affection: 0.25,
          respect: 0.7,
          note: 'admires her and intends to be the one who stops her',
        },
        {
          from: 'char:rhona-tarrant',
          to: 'char:sam-tarrant',
          trust: 0.5,
          affection: 0.95,
          respect: 0.4,
          note: 'her reason for all of it, and the one she has never once asked what he wants',
        },
        {
          from: 'char:sam-tarrant',
          to: 'char:rhona-tarrant',
          trust: 0.3,
          affection: 0.7,
          respect: 0.6,
          note: 'has an offer letter in his coat and would rather leave than say so',
        },
        {
          from: 'char:rhona-tarrant',
          to: 'char:douglas-tarrant',
          trust: 0.4,
          affection: 0.6,
          respect: 0.9,
          note: 'wipes his chin twice a week and cannot forgive him for the will',
        },
        {
          from: 'char:douglas-tarrant',
          to: 'char:rhona-tarrant',
          trust: 0.7,
          affection: 0.5,
          respect: 0.8,
          note: 'trusts her with the yard and not with the boat, and cannot get the sentence out',
        },
        {
          from: 'char:rhona-tarrant',
          to: 'char:nessa-coyle',
          trust: 0.85,
          affection: 0.4,
          respect: 0.8,
          note: 'the only outsider who has seen the real figures, which is a kind of intimacy neither would name',
        },
        {
          from: 'char:nessa-coyle',
          to: 'char:rhona-tarrant',
          trust: 0.5,
          affection: 0.35,
          respect: 0.75,
          note: 'client first, friend second, and lately having to remember which',
        },
        {
          from: 'char:rhona-tarrant',
          to: 'char:ivo-voss',
          trust: -0.9,
          affection: -0.8,
          respect: -0.4,
          note: 'the only person in Brackmouth she would not let use the yard toilet',
        },
        {
          from: 'char:ivo-voss',
          to: 'char:rhona-tarrant',
          trust: -0.2,
          affection: 0.1,
          respect: 0.5,
          note: 'thinks she is the best argument against her own case and is happy to let her make it',
        },
        {
          from: 'char:rhona-tarrant',
          to: 'char:winnie-ollery',
          trust: -0.3,
          affection: -0.1,
          respect: 0.4,
          note: 'says the true thing at the wrong volume, and is owed the right to',
        },
        {
          from: 'char:winnie-ollery',
          to: 'char:rhona-tarrant',
          trust: -0.6,
          affection: -0.5,
          respect: 0.2,
          note: 'five months, not two, and she has counted them all',
        },
        {
          from: 'char:rhona-tarrant',
          to: 'char:grace-ollery',
          trust: 0.4,
          affection: 0.3,
          respect: 0.8,
          note: 'dreads her, because Grace asks and then waits',
        },
        {
          from: 'char:grace-ollery',
          to: 'char:rhona-tarrant',
          trust: -0.2,
          affection: 0.2,
          respect: 0.6,
          note: 'believes she is drowning honourably, which is still drowning her father',
        },
        {
          from: 'char:bryn-ollery',
          to: 'char:sam-tarrant',
          trust: 0.8,
          affection: 0.85,
          respect: 0.5,
          note: 'the apprentice he was going to leave the shed to, if there were a shed',
        },
        {
          from: 'char:sam-tarrant',
          to: 'char:bryn-ollery',
          trust: 0.9,
          affection: 0.8,
          respect: 0.95,
          note: 'the person he cannot tell about the college, for exactly the reason he should',
        },
        {
          from: 'char:bryn-ollery',
          to: 'char:winnie-ollery',
          trust: 0.5,
          affection: 0.8,
          respect: 0.6,
          note: 'loves her and has not told her about the wages, which is the largest lie of his life',
        },
        {
          from: 'char:winnie-ollery',
          to: 'char:bryn-ollery',
          trust: 0.9,
          affection: 0.9,
          respect: 0.3,
          note: 'adores him and thinks he lets himself be used, and is right',
        },
        {
          from: 'char:kit-tarrant',
          to: 'char:marie-voss',
          trust: -0.5,
          affection: -0.1,
          respect: 0.5,
          note: 'she wrote the letter that got him here and has not once mentioned writing it',
        },
        {
          from: 'char:marie-voss',
          to: 'char:kit-tarrant',
          trust: -0.4,
          affection: 0.3,
          respect: -0.5,
          note: 'needs his signature and expects to despise herself for how easily she gets it',
        },
        {
          from: 'char:kit-tarrant',
          to: 'char:nessa-coyle',
          trust: 0.8,
          affection: 0.7,
          respect: 0.85,
          note: 'the only person here he has not yet disappointed twice',
        },
        {
          from: 'char:nessa-coyle',
          to: 'char:kit-tarrant',
          trust: 0.3,
          affection: 0.75,
          respect: 0.2,
          note: 'never stopped, has never said so, and is professionally required not to',
        },
        {
          from: 'char:kit-tarrant',
          to: 'char:douglas-tarrant',
          trust: 0.2,
          affection: 0.8,
          respect: 0.6,
          note: 'has not been to Brindle House yet and is running out of morning to not go',
        },
        {
          from: 'char:douglas-tarrant',
          to: 'char:kit-tarrant',
          trust: 0.3,
          affection: 0.9,
          respect: 0.1,
          note: 'the one he asks for by name and the one he would not leave the yard to',
        },
        {
          from: 'char:kit-tarrant',
          to: 'char:bryn-ollery',
          trust: 0.7,
          affection: 0.6,
          respect: 0.9,
          note: 'the nearest thing to a witness he trusts; also the man who was there that night',
        },
        {
          from: 'char:bryn-ollery',
          to: 'char:kit-tarrant',
          trust: -0.5,
          affection: 0.3,
          respect: -0.4,
          note: 'liked the boy, has no time for the man, and would still put a coat round him',
        },
        {
          from: 'char:marie-voss',
          to: 'char:ivo-voss',
          trust: 0.5,
          affection: 0.6,
          respect: 0.4,
          note: 'her household, her mortgage, and the one thing she has not asked him a direct question about',
        },
        {
          from: 'char:ivo-voss',
          to: 'char:marie-voss',
          trust: 0.35,
          affection: 0.75,
          respect: 0.6,
          note: 'loves her and has kept eight months of drawings out of the kitchen',
        },
        {
          from: 'char:marie-voss',
          to: 'char:douglas-tarrant',
          trust: 0.2,
          affection: 0.55,
          respect: 0.5,
          note: 'two years of Sundays, and a receipt for them nobody has ever asked to see',
        },
        {
          from: 'char:douglas-tarrant',
          to: 'char:marie-voss',
          trust: -0.4,
          affection: 0.2,
          respect: 0.3,
          note: 'will not have her hold his hand and cannot explain that it is about the paper',
        },
        {
          from: 'char:sam-tarrant',
          to: 'char:cass-frew',
          trust: 0.9,
          affection: 0.85,
          respect: 0.7,
          note: 'the only person who has read the offer letter',
        },
        {
          from: 'char:cass-frew',
          to: 'char:sam-tarrant',
          trust: 0.7,
          affection: 0.5,
          respect: 0.3,
          note: 'will go with or without him and has told him so once, clearly',
        },
        {
          from: 'char:tansy-voss',
          to: 'char:bryn-ollery',
          trust: 0.85,
          affection: 0.6,
          respect: 0.95,
          note: 'the only adult in her life who explains things in the order they happen',
        },
        {
          from: 'char:bryn-ollery',
          to: 'char:tansy-voss',
          trust: 0.6,
          affection: 0.7,
          respect: 0.5,
          note: 'a Voss with a Tarrant’s hands, which he finds funny and does not say',
        },
        {
          from: 'char:tansy-voss',
          to: 'char:marie-voss',
          trust: 0.2,
          affection: 0.4,
          respect: -0.3,
          note: 'sixteen, and has worked out exactly who the buyer is',
        },
        {
          from: 'char:marie-voss',
          to: 'char:tansy-voss',
          trust: 0.4,
          affection: 0.9,
          respect: 0.5,
          note: 'doing all of it for her, and would be genuinely shocked to hear it doubted',
        },
        {
          from: 'char:grace-ollery',
          to: 'char:bryn-ollery',
          trust: 0.8,
          affection: 0.9,
          respect: 0.6,
          note: 'would go over his head for him and knows he would never forgive it',
        },
        {
          from: 'char:bryn-ollery',
          to: 'char:grace-ollery',
          trust: 0.7,
          affection: 0.95,
          respect: 0.8,
          note: 'proud of her past the point of being able to say it, and terrified she will interfere',
        },
        {
          from: 'char:len-fewkes',
          to: 'char:ivo-voss',
          trust: 0.4,
          affection: 0.2,
          respect: 0.35,
          note: 'the only person who reads the clauses he drafts, which he mistakes for respect',
        },
        {
          from: 'char:ivo-voss',
          to: 'char:len-fewkes',
          trust: 0.3,
          affection: -0.1,
          respect: -0.4,
          note: 'useful, cheap, and would deny knowing him at a hearing',
        },
        {
          from: 'char:eddie-quill',
          to: 'char:rhona-tarrant',
          trust: 0.6,
          affection: 0.5,
          respect: 0.3,
          note: 'thinks she is doing it wrong and turns up anyway, every week, unpaid',
        },
        {
          from: 'char:rhona-tarrant',
          to: 'char:eddie-quill',
          trust: 0.5,
          affection: 0.4,
          respect: 0.2,
          note: 'a nuisance she cannot afford to lose, since he knows where everything is',
        },
      ],
      facts: [
        {
          text: 'Tarrant & Sons has not paid Bryn Ollery since March.',
          knows: ['char:rhona-tarrant', 'char:nessa-coyle', 'char:bryn-ollery'],
          suspects: ['char:grace-ollery', 'char:winnie-ollery', 'char:deb-molloy'],
          wrong: ['char:sam-tarrant'],
        },
        {
          text: 'Russ Pardoe’s letter of the eleventh condemns the big shed roof and was copied to the Harbour Trust.',
          knows: ['char:russ-pardoe', 'char:rhona-tarrant', 'char:len-fewkes'],
          suspects: ['char:jerome-hyde'],
          wrong: ['char:bryn-ollery'],
        },
        {
          text: 'The lease renewal contains a change-of-use clause that would allow the yard site to become moorings and apartments.',
          knows: ['char:len-fewkes', 'char:ivo-voss', 'char:jerome-hyde'],
          suspects: ['char:rhona-tarrant', 'char:dev-nandra', 'char:marie-voss'],
        },
        {
          text: 'The buyer Marie has brought is Ivo, through a company name.',
          knows: ['char:ivo-voss', 'char:marie-voss'],
          suspects: ['char:tansy-voss', 'char:nessa-coyle'],
          wrong: ['char:rhona-tarrant'],
        },
        {
          text: 'Douglas refused to sign the 2019 will and Orla Dace was in the room when he refused.',
          knows: ['char:douglas-tarrant', 'char:orla-dace'],
          suspects: ['char:marie-voss'],
          wrong: ['char:rhona-tarrant', 'char:kit-tarrant'],
        },
        {
          text: 'Sam has an offer of a place on the marine engineering course at Bilton, starting in January.',
          knows: ['char:sam-tarrant', 'char:cass-frew'],
          suspects: ['char:bryn-ollery'],
          wrong: ['char:rhona-tarrant'],
        },
        {
          text: 'Marie’s solicitor wrote to Kit in July. The boat was never mentioned in the letter.',
          knows: ['char:kit-tarrant', 'char:marie-voss'],
          suspects: ['char:nessa-coyle'],
          wrong: ['char:rhona-tarrant', 'char:bryn-ollery'],
        },
      ],
      threads: [
        {
          title: 'Friday’s tide',
          stakes: 'the Aveline, the crane certificate, and whether there is anything left worth renewing a lease over',
          tension: 0.8,
          parties: [
            'char:rhona-tarrant',
            'char:bryn-ollery',
            'char:sam-tarrant',
            'char:col-molloy',
            'item:the-aveline',
          ],
          resolutions: [
            'she comes out on Friday and the shed roof holds',
            'the haul-out is abandoned and the Aveline sits on the mud until the eleventh',
            'Rhona sells her where she lies and pays the wages out of it',
            'the lift goes wrong in front of the Trust and settles the lease argument for everybody',
          ],
        },
        {
          title: 'What Marie has brought with her',
          stakes: 'the site, and three siblings who have never once used the word inheritance in the same room',
          tension: 0.85,
          parties: [
            'char:rhona-tarrant',
            'char:marie-voss',
            'char:kit-tarrant',
            'char:ivo-voss',
            'char:douglas-tarrant',
          ],
          resolutions: [
            'the buyer is named out loud and the offer dies of it',
            'Kit signs and the yard becomes his debt',
            'Rhona buys time by conceding the cottages',
            'the three of them agree something in a car park that no solicitor will recognise',
          ],
        },
        {
          title: 'Five months of Bryn’s wages',
          stakes: 'forty-one years, and whether Rhona says it before somebody else does',
          tension: 0.75,
          parties: ['char:rhona-tarrant', 'char:bryn-ollery', 'char:winnie-ollery', 'char:grace-ollery'],
          resolutions: [
            'she tells him this morning, before the crane',
            'Winnie says it in the fish bar first',
            'Grace goes over both their heads',
            'he works Friday for nothing and never mentions it again',
          ],
        },
        {
          title: 'The letter about the roof',
          stakes: 'the shed, the insurance, and the Trust’s excuse',
          tension: 0.5,
          parties: ['char:rhona-tarrant', 'char:russ-pardoe', 'char:len-fewkes', 'char:jerome-hyde'],
          resolutions: [
            'the letter is opened and answered before the hearing',
            'the Trust acts on its copy and nobody has to decide anything',
            'the roof is patched badly and passes',
            'Bryn finds out what the letter actually says',
          ],
        },
      ],
      style: {
        pov: 'third-limited',
        tense: 'past',
        register: 'clipped',
        density: 'balanced',
        dialogueRatio: 0.55,
        genreLens: 'domestic realism, trade-specific',
        humor: 'dry',
        pacing: 'steady',
        sceneTarget: 380,
        comparables: [
          'a family firm’s accounts read aloud as an accusation',
          'two people agreeing about a tide so they do not have to agree about anything else',
        ],
        forbidden: [
          'anybody delivering a speech',
          'the sea as a metaphor for anything',
          'a solicitor’s letter arriving at a dramatically convenient moment',
          'weather standing in for feeling',
        ],
        contentBounds: [
          'No violence. The worst thing anyone does here is say something true at the wrong moment, in front of the wrong person.',
          'Money, debt, illness and family rupture are all fully in scope and should be specific rather than gestured at.',
          'Douglas’s aphasia is played straight: never comic, never a metaphor, never miraculously cured for a scene.',
          'No crime plot. Nobody forges a signature, steals a document, or threatens anyone.',
          'Attraction and old history may be present; sex stays off-page in this scenario.',
          'No on-page death and no self-harm.',
        ],
      },
      anchor: {
        text: 'The certificate needed a signature and a hundred and forty pounds, and she had the pen.',
        note: 'concrete, monetised, withheld — the register the whole scenario should hold',
      },
      opening:
        'The two-bar heater had been on since seven and the office was still cold enough to see her breath over the ledger, which was how she knew it was properly October.',
    },

    // ========================================================== scenario two
    //
    // The same canon, one street over, and a protagonist who was a supporting
    // name in the first scenario. Nessa's rank-1 vow is a professional ethic,
    // which is what a contemporary vow looks like: the tempting course is a
    // single sentence about page four, and the gate will fire on it.
    {
      id: 'a-matter-of-confidence',
      title: 'A Matter of Confidence',
      premise: `You keep the books for six businesses on two hundred metres of street, and two of them are about to
be on opposite sides of the same table. You are Nessa Coyle. On Friday, Kit Tarrant — who left fourteen years
ago and whom you have never quite finished with — will be asked to put his name to a personal guarantee for a
company you know cannot trade past January. Telling him breaks the only professional rule you have. Not telling
him means sitting in the back room on Friday and watching.`,
      playerCharacterId: 'char:nessa-coyle',
      openingLocationId: 'loc:coyle-bookkeeping',
      openingScene: 'Somebody on the stairs at twenty past eight',
      focus: {
        'char:nessa-coyle': 'focal',
        'char:kit-tarrant': 'focal',
        'char:rhona-tarrant': 'focal',
        'char:ivo-voss': 'focal',
        'char:marie-voss': 'focal',
        'char:hattie-coyle': 'focal',
        'item:the-personal-guarantee': 'focal',
        'concept:client-confidence': 'focal',
        'loc:coyle-bookkeeping': 'focal',
        'loc:the-sea-wall-path': 'focal',
        'char:dev-nandra': 'principal',
        'char:iris-kellow': 'principal',
        'char:bryn-ollery': 'principal',
        'char:winnie-ollery': 'principal',
        'char:grace-ollery': 'principal',
        'char:deb-molloy': 'principal',
        'char:douglas-tarrant': 'principal',
        'char:len-fewkes': 'principal',
        'item:the-yard-ledger': 'principal',
        'item:the-aveline': 'principal',
        'concept:the-lease-renewal': 'principal',
        'event:the-night-kit-left': 'principal',
        'loc:nandras': 'principal',
        'loc:the-ferryman': 'principal',
        'loc:the-back-room': 'principal',
        'loc:the-mud-berth': 'principal',
        'loc:douglas-room': 'principal',
        'char:sam-tarrant': 'supporting',
        'char:tansy-voss': 'supporting',
        'char:col-molloy': 'supporting',
        'char:orla-dace': 'supporting',
        'char:tom-kellow': 'supporting',
        'loc:the-old-post-office': 'supporting',
        'loc:the-quay-car-park': 'supporting',
        'char:bee-kellow': 'background',
        'char:aiden-frew': 'background',
        'char:cass-frew': 'background',
        'char:priya-nandra': 'background',
        'char:mo-abiri': 'background',
        'char:jerome-hyde': 'background',
        'char:russ-pardoe': 'background',
        'char:fen-alder': 'background',
        'char:eddie-quill': 'background',
      },
      conditions: [
        {
          entityId: 'char:nessa-coyle',
          locationId: 'loc:coyle-bookkeeping',
          mood: 'composed and not calm',
          inventory: [
            'two client files that should not be on the same desk',
            'a letter written in 2011 and never posted',
          ],
          intent: 'finish the management accounts without answering a single direct question',
        },
        {
          entityId: 'char:kit-tarrant',
          locationId: 'loc:coyle-bookkeeping',
          mood: 'trying to be charming about it',
          intent: 'get somebody in this town to tell him plainly what he is signing',
        },
        {
          entityId: 'char:dev-nandra',
          locationId: 'loc:nandras',
          mood: 'watchful',
          intent: 'find out whether the Trust has already decided',
        },
        {
          entityId: 'char:hattie-coyle',
          locationId: 'loc:nandras',
          mood: 'bright',
          intent: 'be seen to be perfectly fine',
        },
        {
          entityId: 'char:rhona-tarrant',
          locationId: 'loc:the-yard-office',
          mood: 'shut',
          intent: 'keep Nessa on the yard’s side of the table',
        },
        { entityId: 'char:bryn-ollery', locationId: 'loc:the-big-shed', mood: 'working' },
        { entityId: 'char:sam-tarrant', locationId: 'loc:the-big-shed', mood: 'distracted' },
        {
          entityId: 'char:ivo-voss',
          locationId: 'loc:the-old-post-office',
          mood: 'friendly',
          intent: 'get his own accounts filed and Nessa kept close',
        },
        {
          entityId: 'char:marie-voss',
          locationId: 'loc:the-old-post-office',
          mood: 'businesslike',
          intent: 'have the guarantee ready for Friday',
        },
        {
          entityId: 'char:iris-kellow',
          locationId: 'loc:the-ferryman',
          mood: 'brittle',
          intent: 'get a straight answer about the cellar out of somebody',
        },
        { entityId: 'char:deb-molloy', locationId: 'loc:molloys', mood: 'collecting' },
        { entityId: 'char:grace-ollery', locationId: 'loc:the-mud-berth', mood: 'straightforward' },
        { entityId: 'char:winnie-ollery', locationId: 'loc:douglas-room', mood: 'blunt' },
        { entityId: 'char:douglas-tarrant', locationId: 'loc:douglas-room', mood: 'waiting' },
        { entityId: 'char:len-fewkes', locationId: 'loc:the-harbour-office', mood: 'neutral to a fault' },
      ],
      relationships: [
        {
          from: 'char:nessa-coyle',
          to: 'char:kit-tarrant',
          trust: 0.25,
          affection: 0.85,
          respect: 0.15,
          note: 'she never finished it and has organised fourteen years around not having to say so',
        },
        {
          from: 'char:kit-tarrant',
          to: 'char:nessa-coyle',
          trust: 0.85,
          affection: 0.7,
          respect: 0.9,
          note: 'the one person here he believes will tell him the truth, which is the cruellest thing he could think about her',
        },
        {
          from: 'char:nessa-coyle',
          to: 'char:hattie-coyle',
          trust: 0.4,
          affection: 0.9,
          respect: 0.5,
          note: 'has started checking the Tuesday rota against the log, and hates herself for it',
        },
        {
          from: 'char:hattie-coyle',
          to: 'char:nessa-coyle',
          trust: 0.9,
          affection: 0.85,
          respect: 0.7,
          note: 'proud of her, tells the whole Lane about her, and has not mentioned the missed shifts',
        },
        {
          from: 'char:nessa-coyle',
          to: 'char:rhona-tarrant',
          trust: 0.55,
          affection: 0.4,
          respect: 0.8,
          note: 'her best client and her worst conflict, in the same ring binder',
        },
        {
          from: 'char:rhona-tarrant',
          to: 'char:nessa-coyle',
          trust: 0.9,
          affection: 0.45,
          respect: 0.75,
          note: 'has shown her everything, on the assumption that showing somebody everything buys their silence',
        },
        {
          from: 'char:nessa-coyle',
          to: 'char:ivo-voss',
          trust: -0.5,
          affection: -0.6,
          respect: 0.45,
          note: 'immaculate paperwork, and he has never once asked her a question he did not know the answer to',
        },
        {
          from: 'char:ivo-voss',
          to: 'char:nessa-coyle',
          trust: 0.6,
          affection: 0.3,
          respect: 0.7,
          note: 'keeps her because she is the only person on the Lane both sides believe',
        },
        {
          from: 'char:nessa-coyle',
          to: 'char:dev-nandra',
          trust: 0.85,
          affection: 0.7,
          respect: 0.9,
          note: 'her landlord, her first client, and the one person she could not lie to and stay',
        },
        {
          from: 'char:dev-nandra',
          to: 'char:nessa-coyle',
          trust: 0.9,
          affection: 0.6,
          respect: 0.8,
          note: 'treats her as the Lane’s conscience and has no idea what that costs her',
        },
        {
          from: 'char:nessa-coyle',
          to: 'char:iris-kellow',
          trust: 0.6,
          affection: 0.65,
          respect: 0.5,
          note: 'the only client who has ever cried in the office, and has never referred to it since',
        },
        {
          from: 'char:iris-kellow',
          to: 'char:nessa-coyle',
          trust: 0.8,
          affection: 0.5,
          respect: 0.7,
          note: 'the one person who has seen the pub’s real numbers and not offered an opinion',
        },
        {
          from: 'char:nessa-coyle',
          to: 'char:deb-molloy',
          trust: -0.35,
          affection: 0.4,
          respect: 0.1,
          note: 'kind, generous, and a broadcast tower with a fryer',
        },
        {
          from: 'char:deb-molloy',
          to: 'char:nessa-coyle',
          trust: 0.5,
          affection: 0.6,
          respect: 0.55,
          note: 'keeps trying to get one sentence out of her and admires that she cannot',
        },
        {
          from: 'char:nessa-coyle',
          to: 'char:grace-ollery',
          trust: 0.7,
          affection: 0.5,
          respect: 0.8,
          note: 'the only other person in Brackmouth who holds things professionally, and they have never discussed it',
        },
        {
          from: 'char:grace-ollery',
          to: 'char:nessa-coyle',
          trust: 0.65,
          affection: 0.45,
          respect: 0.85,
          note: 'would tell her before anyone, and will not',
        },
        {
          from: 'char:kit-tarrant',
          to: 'char:rhona-tarrant',
          trust: 0.6,
          affection: 0.4,
          respect: 0.9,
          note: 'assumes she will forgive him because she always has; has not looked at what it cost',
        },
        {
          from: 'char:rhona-tarrant',
          to: 'char:kit-tarrant',
          trust: -0.4,
          affection: 0.5,
          respect: -0.3,
          note: 'loves him without liking him, which she could not say and would not deny',
        },
        {
          from: 'char:kit-tarrant',
          to: 'char:marie-voss',
          trust: -0.5,
          affection: -0.1,
          respect: 0.5,
          note: 'she wrote the letter that got him here and has not once mentioned writing it',
        },
        {
          from: 'char:marie-voss',
          to: 'char:kit-tarrant',
          trust: -0.4,
          affection: 0.3,
          respect: -0.5,
          note: 'needs his signature and expects to despise herself for how easily she gets it',
        },
        {
          from: 'char:kit-tarrant',
          to: 'char:bryn-ollery',
          trust: 0.7,
          affection: 0.6,
          respect: 0.9,
          note: 'the nearest thing to a witness he trusts; also the man who was there that night',
        },
        {
          from: 'char:bryn-ollery',
          to: 'char:kit-tarrant',
          trust: -0.5,
          affection: 0.3,
          respect: -0.4,
          note: 'liked the boy, has no time for the man, and would still put a coat round him',
        },
        {
          from: 'char:kit-tarrant',
          to: 'char:douglas-tarrant',
          trust: 0.2,
          affection: 0.8,
          respect: 0.6,
          note: 'has not been to Brindle House yet and is running out of week to not go',
        },
        {
          from: 'char:douglas-tarrant',
          to: 'char:kit-tarrant',
          trust: 0.3,
          affection: 0.9,
          respect: 0.1,
          note: 'the one he asks for by name and the one he would not leave the yard to',
        },
        {
          from: 'char:ivo-voss',
          to: 'char:marie-voss',
          trust: 0.35,
          affection: 0.75,
          respect: 0.6,
          note: 'loves her and has kept eight months of drawings out of the kitchen',
        },
        {
          from: 'char:marie-voss',
          to: 'char:ivo-voss',
          trust: 0.5,
          affection: 0.6,
          respect: 0.4,
          note: 'her household, her mortgage, and the one thing she has not asked him a direct question about',
        },
        {
          from: 'char:ivo-voss',
          to: 'char:dev-nandra',
          trust: -0.3,
          affection: -0.2,
          respect: 0.5,
          note: 'the only opposition on the Lane with a mailing list, which he respects and resents',
        },
        {
          from: 'char:dev-nandra',
          to: 'char:ivo-voss',
          trust: -0.8,
          affection: -0.75,
          respect: -0.2,
          note: 'fifty-one houses with nobody in them in February, and a man who calls it investment',
        },
        {
          from: 'char:hattie-coyle',
          to: 'char:winnie-ollery',
          trust: 0.7,
          affection: 0.75,
          respect: 0.4,
          note: 'thirty years of the same laundry rota and no secrets left between them',
        },
        {
          from: 'char:winnie-ollery',
          to: 'char:hattie-coyle',
          trust: 0.35,
          affection: 0.6,
          respect: 0.3,
          note: 'loves her and has begun covering for her, without ever using the word',
        },
        {
          from: 'char:hattie-coyle',
          to: 'char:deb-molloy',
          trust: 0.6,
          affection: 0.7,
          respect: 0.2,
          note: 'the person she tells things to, which is the same as telling the street',
        },
        {
          from: 'char:deb-molloy',
          to: 'char:hattie-coyle',
          trust: 0.4,
          affection: 0.65,
          respect: 0.15,
          note: 'a reliable source who has lately started getting the days wrong',
        },
        {
          from: 'char:iris-kellow',
          to: 'char:grace-ollery',
          trust: 0.6,
          affection: 0.7,
          respect: 0.75,
          note: 'Thursdays, and a rule she is still keeping to the letter and not the spirit',
        },
        {
          from: 'char:grace-ollery',
          to: 'char:iris-kellow',
          trust: 0.45,
          affection: 0.8,
          respect: 0.5,
          note: 'would wait a year; is not sure she should have to say that out loud',
        },
        {
          from: 'char:iris-kellow',
          to: 'char:tom-kellow',
          trust: 0.2,
          affection: -0.15,
          respect: 0.35,
          note: 'the best chef in the estuary and a man she cannot be in a kitchen with',
        },
        {
          from: 'char:tom-kellow',
          to: 'char:iris-kellow',
          trust: 0.45,
          affection: 0.55,
          respect: 0.2,
          note: 'still in it, and keeping a list',
        },
        {
          from: 'char:len-fewkes',
          to: 'char:ivo-voss',
          trust: 0.4,
          affection: 0.2,
          respect: 0.35,
          note: 'the only person who reads the clauses he drafts, which he mistakes for respect',
        },
        {
          from: 'char:ivo-voss',
          to: 'char:len-fewkes',
          trust: 0.3,
          affection: -0.1,
          respect: -0.4,
          note: 'useful, cheap, and would deny knowing him at a hearing',
        },
        {
          from: 'char:dev-nandra',
          to: 'char:iris-kellow',
          trust: 0.6,
          affection: 0.5,
          respect: 0.4,
          note: 'carries her account and would carry it another year rather than see the Lane lose a pub',
        },
        {
          from: 'char:iris-kellow',
          to: 'char:dev-nandra',
          trust: 0.7,
          affection: 0.55,
          respect: 0.65,
          note: 'owes him three hundred pounds and has stopped going in for small things',
        },
        {
          from: 'char:bryn-ollery',
          to: 'char:rhona-tarrant',
          trust: 0.6,
          affection: 0.55,
          respect: 0.85,
          note: 'knows about the money, has decided asking would cost her more than it would get him',
        },
        {
          from: 'char:rhona-tarrant',
          to: 'char:bryn-ollery',
          trust: 0.95,
          affection: 0.7,
          respect: 0.9,
          note: 'the only person she has never had to explain herself to, and the one she is currently lying to',
        },
        {
          from: 'char:marie-voss',
          to: 'char:rhona-tarrant',
          trust: -0.3,
          affection: 0.25,
          respect: 0.7,
          note: 'admires her and intends to be the one who stops her',
        },
        {
          from: 'char:rhona-tarrant',
          to: 'char:marie-voss',
          trust: -0.7,
          affection: -0.2,
          respect: 0.4,
          note: 'accurate about the yard, wrong about everything that matters, and impossible to argue with',
        },
      ],
      facts: [
        {
          text: 'Tarrant & Sons cannot trade past January without either the freehold or new money.',
          knows: ['char:nessa-coyle', 'char:rhona-tarrant'],
          suspects: ['char:bryn-ollery', 'char:dev-nandra', 'char:len-fewkes'],
          wrong: ['char:sam-tarrant'],
        },
        {
          text: 'On Friday Kit will be asked to sign a personal guarantee against the company’s overdraft.',
          knows: ['char:nessa-coyle', 'char:marie-voss', 'char:ivo-voss'],
          suspects: ['char:rhona-tarrant'],
          wrong: ['char:kit-tarrant'],
        },
        {
          text: 'Nessa keeps the books for Voss Coastal Lettings as well as for the boatyard.',
          knows: ['char:nessa-coyle', 'char:ivo-voss', 'char:hattie-coyle', 'char:dev-nandra'],
          wrong: ['char:kit-tarrant', 'char:bryn-ollery'],
        },
        {
          text: 'Ivo has had the yard site drawn up as fourteen apartments and a marina office. The drawings are eight months old.',
          knows: ['char:ivo-voss'],
          suspects: ['char:nessa-coyle', 'char:len-fewkes', 'char:dev-nandra'],
          wrong: ['char:marie-voss'],
        },
        {
          text: 'Hattie has missed three Tuesday shifts at Brindle House and logged them as worked.',
          knows: ['char:nessa-coyle', 'char:winnie-ollery'],
          suspects: ['char:grace-ollery'],
          wrong: ['char:hattie-coyle', 'char:deb-molloy'],
        },
        {
          text: 'Nessa wrote Kit a letter the week after he left and never posted it. It is in the desk drawer she keeps locked.',
          knows: ['char:nessa-coyle'],
          wrong: ['char:kit-tarrant'],
        },
      ],
      threads: [
        {
          title: 'The signature line',
          stakes: 'a man’s house against a company’s overdraft, and the one rule that makes Nessa employable',
          tension: 0.85,
          parties: ['char:nessa-coyle', 'char:kit-tarrant', 'char:rhona-tarrant', 'char:marie-voss', 'char:ivo-voss'],
          resolutions: [
            'she says nothing and he signs',
            'she tells him, and resigns the yard’s account the same afternoon',
            'she gets Rhona to tell him, which costs Rhona everything and Nessa nothing',
            'the guarantee is withdrawn because somebody else names the buyer first',
          ],
        },
        {
          title: 'Fourteen years, and neither of them going first',
          stakes: 'whether this is a second attempt or a long postponement with better weather',
          tension: 0.65,
          parties: ['char:nessa-coyle', 'char:kit-tarrant', 'char:hattie-coyle'],
          resolutions: [
            'she gives him the letter she wrote in 2011',
            'they get as far as the sea wall and no further',
            'he leaves again and this time she watches him do it',
            'they begin something on the wrong week and both know it is the wrong week',
          ],
        },
        {
          title: 'Whose books she is really keeping',
          stakes:
            'six clients on two hundred metres of street, and a conflict she has been managing by never being asked',
          tension: 0.7,
          parties: ['char:nessa-coyle', 'char:ivo-voss', 'char:rhona-tarrant', 'char:dev-nandra'],
          resolutions: [
            'she declares the conflict and hands one account back',
            'Ivo declares it for her, publicly and helpfully',
            'she keeps both and is found out at the hearing',
            'Dev Nandra asks her the question directly in the shop',
          ],
        },
        {
          title: 'Hattie’s Tuesdays',
          stakes: 'a woman’s job, her licence to be useful, and her daughter’s willingness to say it',
          tension: 0.45,
          parties: ['char:nessa-coyle', 'char:hattie-coyle', 'char:winnie-ollery', 'char:grace-ollery'],
          resolutions: [
            'Nessa says it to her mother’s face',
            'Winnie stops covering and Brindle House notices',
            'Grace arranges an assessment that looks like a coincidence',
            'it goes on until something is dropped',
          ],
        },
      ],
      style: {
        pov: 'first',
        tense: 'present',
        register: 'plain',
        density: 'rich',
        dialogueRatio: 0.62,
        genreLens: 'contemporary romance inside a professional-ethics problem',
        humor: 'dry',
        pacing: 'languid',
        sceneTarget: 420,
        comparables: [
          'two adults being extremely careful in a room with a kettle in it',
          'a love scene conducted entirely through the choice of which page to leave face up',
        ],
        forbidden: [
          'a misunderstanding that a single sentence would clear up',
          'anybody running through rain to a door',
          'the word soulmate, or any variant of it',
          'her profession described as boring by the narration',
        ],
        contentBounds: [
          'Romance is the spine of this scenario. Desire, jealousy, reopened history and physical awareness are all fully in scope.',
          'Physical intimacy: on-page to kissing and undressed proximity; anything beyond that closes the scene and resumes afterwards.',
          'Both parties are adults, both keep choosing it or not choosing it, and consent is legible in the writing rather than assumed.',
          'No infidelity played as inevitable, no coercion, and no jealousy expressed physically.',
          'No crime, no violence, no medical emergency used to force a decision.',
          'Hattie’s cognitive decline is handled plainly and never for pathos or comedy.',
        ],
      },
      anchor: {
        text: 'Two files on one desk, and I have been keeping them a hand’s width apart all morning like that is a professional standard.',
        note: 'first person, present, dry — the ethical problem stated as a physical arrangement of paper',
      },
      opening:
        'Somebody comes up the stairs at twenty past eight, and I know from the third tread who it is, because that is the sort of thing you keep whether you want it or not.',
    },

    // ======================================================== scenario three
    //
    // The third cluster, and the third register: second person, present, sparse.
    // Iris's four vows are actively in each other's way, which is the point —
    // the rank-1 rule about Bee is the last functioning part of the marriage,
    // and Friday puts it in the same eleven square metres as the sentence.
    {
      id: 'not-in-front-of-bee',
      title: 'Not In Front of Bee',
      premise: `The back room is booked twice on Friday. The Harbour Trust has the lease hearing at six and your
daughter has her eleventh birthday at seven, and Tom took both bookings in January and has mentioned neither.
You are Iris Kellow. The cellar has flooded on every tide over 5.4 metres since the new year, Marie Voss has put
a figure on half your licence, and you have been going down to the gig shed on Thursday evenings. Everyone in
Brackmouth has worked out that your marriage is over except your husband, and possibly you.`,
      playerCharacterId: 'char:iris-kellow',
      openingLocationId: 'loc:the-pub-kitchen',
      openingScene: 'Half past ten, and the bookings diary open on the prep bench',
      focus: {
        'char:iris-kellow': 'focal',
        'char:tom-kellow': 'focal',
        'char:bee-kellow': 'focal',
        'char:grace-ollery': 'focal',
        'char:marie-voss': 'focal',
        'concept:not-in-front-of-bee': 'focal',
        'loc:the-pub-kitchen': 'focal',
        'loc:the-back-room': 'focal',
        'item:bees-tide-table': 'focal',
        'item:iris-wedding-ring': 'focal',
        'char:len-fewkes': 'principal',
        'char:priya-nandra': 'principal',
        'char:aiden-frew': 'principal',
        'char:nessa-coyle': 'principal',
        'char:deb-molloy': 'principal',
        'char:col-molloy': 'principal',
        'char:dev-nandra': 'principal',
        'char:ivo-voss': 'principal',
        'char:cass-frew': 'principal',
        'char:mo-abiri': 'principal',
        'char:rhona-tarrant': 'principal',
        'concept:the-tide': 'principal',
        'concept:the-lease-renewal': 'principal',
        'event:the-january-tide': 'principal',
        'loc:the-ferryman': 'principal',
        'loc:the-quay-car-park': 'principal',
        'loc:the-school-gate': 'principal',
        'loc:the-sea-wall-path': 'principal',
        'char:bryn-ollery': 'supporting',
        'char:kit-tarrant': 'supporting',
        'char:jerome-hyde': 'supporting',
        'char:orla-dace': 'supporting',
        'char:winnie-ollery': 'supporting',
        'loc:molloys': 'supporting',
        'loc:marsh-end-primary': 'supporting',
        'loc:the-mud-berth': 'supporting',
        'char:douglas-tarrant': 'background',
        'char:sam-tarrant': 'background',
        'char:tansy-voss': 'background',
        'char:hattie-coyle': 'background',
        'char:eddie-quill': 'background',
        'char:russ-pardoe': 'background',
        'char:fen-alder': 'background',
      },
      conditions: [
        {
          entityId: 'char:iris-kellow',
          locationId: 'loc:the-pub-kitchen',
          mood: 'level, at cost',
          inventory: ['the bookings diary', 'her ring, in the apron pocket', 'Marie’s figure on a folded envelope'],
          intent: 'get Friday sorted, in writing, without any of it happening in front of Bee',
        },
        {
          entityId: 'char:tom-kellow',
          locationId: 'loc:the-pub-kitchen',
          mood: 'aggrieved and working',
          intent: 'be told that he was right about January',
        },
        {
          entityId: 'char:bee-kellow',
          locationId: 'loc:the-ferryman',
          mood: 'excited and watching',
          intent: 'confirm that the back room is hers from seven',
        },
        {
          entityId: 'char:col-molloy',
          locationId: 'loc:the-ferryman',
          mood: 'oblivious',
          intent: 'get the cellar pumped before the lunchtime trade',
        },
        {
          entityId: 'char:grace-ollery',
          locationId: 'loc:the-mud-berth',
          mood: 'careful',
          intent: 'not be the reason for anything',
        },
        {
          entityId: 'char:len-fewkes',
          locationId: 'loc:the-harbour-office',
          mood: 'administrative',
          intent: 'confirm the back room for six o’clock Friday',
        },
        {
          entityId: 'char:marie-voss',
          locationId: 'loc:the-glebe',
          mood: 'patient',
          intent: 'get an answer on the licence before the hearing',
        },
        { entityId: 'char:ivo-voss', locationId: 'loc:the-old-post-office', mood: 'pleasant' },
        {
          entityId: 'char:nessa-coyle',
          locationId: 'loc:coyle-bookkeeping',
          mood: 'unavailable',
          intent: 'avoid being asked what the pub is worth',
        },
        {
          entityId: 'char:priya-nandra',
          locationId: 'loc:the-school-gate',
          mood: 'kind and deliberate',
          intent: 'say one sentence to a parent at the gate',
        },
        { entityId: 'char:aiden-frew', locationId: 'loc:the-school-gate', mood: 'hopeful' },
        { entityId: 'char:mo-abiri', locationId: 'loc:marsh-end-primary', mood: 'noting the time' },
        { entityId: 'char:deb-molloy', locationId: 'loc:molloys', mood: 'collecting' },
        { entityId: 'char:cass-frew', locationId: 'loc:molloys', mood: 'deadpan' },
        { entityId: 'char:dev-nandra', locationId: 'loc:nandras', mood: 'solid' },
        { entityId: 'char:rhona-tarrant', locationId: 'loc:the-yard-office', mood: 'preoccupied' },
      ],
      relationships: [
        {
          from: 'char:iris-kellow',
          to: 'char:tom-kellow',
          trust: 0.2,
          affection: -0.15,
          respect: 0.35,
          note: 'the best chef in the estuary and a man she cannot be in a kitchen with',
        },
        {
          from: 'char:tom-kellow',
          to: 'char:iris-kellow',
          trust: 0.45,
          affection: 0.55,
          respect: 0.2,
          note: 'still in it, still keeping a list, and would produce the list if asked',
        },
        {
          from: 'char:iris-kellow',
          to: 'char:bee-kellow',
          trust: 0.7,
          affection: 0.98,
          respect: 0.6,
          note: 'the reason for the rule, and the person the rule is beginning to fail',
        },
        {
          from: 'char:bee-kellow',
          to: 'char:iris-kellow',
          trust: 0.5,
          affection: 0.9,
          respect: 0.7,
          note: 'watches her the way she watches the tide gauge, and has drawn her own conclusions',
        },
        {
          from: 'char:tom-kellow',
          to: 'char:bee-kellow',
          trust: 0.8,
          affection: 0.95,
          respect: 0.5,
          note: 'the only relationship in the building he has never once got wrong',
        },
        {
          from: 'char:bee-kellow',
          to: 'char:tom-kellow',
          trust: 0.75,
          affection: 0.8,
          respect: 0.4,
          note: 'easier than her mother and less use in an emergency',
        },
        {
          from: 'char:iris-kellow',
          to: 'char:grace-ollery',
          trust: 0.6,
          affection: 0.75,
          respect: 0.8,
          note: 'Thursdays, and a rule she is keeping to the letter and not the spirit',
        },
        {
          from: 'char:grace-ollery',
          to: 'char:iris-kellow',
          trust: 0.45,
          affection: 0.85,
          respect: 0.5,
          note: 'would wait a year, and is no longer sure she should have to say that out loud',
        },
        {
          from: 'char:tom-kellow',
          to: 'char:grace-ollery',
          trust: -0.5,
          affection: -0.35,
          respect: 0.4,
          note: 'has known since the second week and has said nothing, which he considers a kindness',
        },
        {
          from: 'char:grace-ollery',
          to: 'char:tom-kellow',
          trust: 0.2,
          affection: -0.1,
          respect: 0.55,
          note: 'thinks he is a decent man in an impossible position and will not use that against him',
        },
        {
          from: 'char:iris-kellow',
          to: 'char:marie-voss',
          trust: -0.55,
          affection: -0.4,
          respect: 0.5,
          note: 'has put a real number on the licence, which is more than the brewery ever did',
        },
        {
          from: 'char:marie-voss',
          to: 'char:iris-kellow',
          trust: 0.2,
          affection: 0.15,
          respect: 0.6,
          note: 'the best operator on the Lane, running the worst building on it',
        },
        {
          from: 'char:iris-kellow',
          to: 'char:ivo-voss',
          trust: -0.7,
          affection: -0.5,
          respect: 0.2,
          note: 'will not have him in the bar, and cannot say why in front of Bee',
        },
        {
          from: 'char:ivo-voss',
          to: 'char:iris-kellow',
          trust: 0.1,
          affection: 0.2,
          respect: 0.45,
          note: 'wants the frontage and would genuinely prefer to buy it from somebody happy',
        },
        {
          from: 'char:iris-kellow',
          to: 'char:aiden-frew',
          trust: 0.5,
          affection: 0.3,
          respect: 0.2,
          note: 'kind, present, and thirty years too available',
        },
        {
          from: 'char:aiden-frew',
          to: 'char:iris-kellow',
          trust: 0.6,
          affection: 0.7,
          respect: 0.55,
          note: '1994, and a fortnight he has never stopped counting from',
        },
        {
          from: 'char:iris-kellow',
          to: 'char:priya-nandra',
          trust: 0.55,
          affection: 0.4,
          respect: 0.75,
          note: 'the person who will tell her something about her own daughter that she should have known first',
        },
        {
          from: 'char:priya-nandra',
          to: 'char:iris-kellow',
          trust: 0.4,
          affection: 0.35,
          respect: 0.6,
          note: 'has a dated note in a file and would rather have a conversation than use it',
        },
        {
          from: 'char:priya-nandra',
          to: 'char:bee-kellow',
          trust: 0.6,
          affection: 0.7,
          respect: 0.5,
          note: 'a child asleep at eleven in the morning, twice in a fortnight',
        },
        {
          from: 'char:bee-kellow',
          to: 'char:priya-nandra',
          trust: 0.8,
          affection: 0.6,
          respect: 0.65,
          note: 'the only adult who answers a question with the actual answer',
        },
        {
          from: 'char:iris-kellow',
          to: 'char:col-molloy',
          trust: 0.65,
          affection: 0.4,
          respect: 0.3,
          note: 'pumps the cellar without being asked and has never once repeated anything',
        },
        {
          from: 'char:col-molloy',
          to: 'char:iris-kellow',
          trust: 0.6,
          affection: 0.5,
          respect: 0.7,
          note: 'the best employer he has had, and he has told his mother nothing',
        },
        {
          from: 'char:iris-kellow',
          to: 'char:deb-molloy',
          trust: -0.4,
          affection: 0.5,
          respect: 0.1,
          note: 'twenty years of friendship and a transmitter she cannot switch off',
        },
        {
          from: 'char:deb-molloy',
          to: 'char:iris-kellow',
          trust: 0.55,
          affection: 0.7,
          respect: 0.4,
          note: 'fond of her, and has already told two people about Thursdays',
        },
        {
          from: 'char:iris-kellow',
          to: 'char:nessa-coyle',
          trust: 0.8,
          affection: 0.5,
          respect: 0.7,
          note: 'the one person who has seen the pub’s real numbers and offered no opinion at all',
        },
        {
          from: 'char:nessa-coyle',
          to: 'char:iris-kellow',
          trust: 0.6,
          affection: 0.65,
          respect: 0.5,
          note: 'the only client who has ever cried in the office, and has never referred to it since',
        },
        {
          from: 'char:iris-kellow',
          to: 'char:dev-nandra',
          trust: 0.7,
          affection: 0.55,
          respect: 0.65,
          note: 'owes him three hundred pounds and has stopped going in for small things',
        },
        {
          from: 'char:dev-nandra',
          to: 'char:iris-kellow',
          trust: 0.6,
          affection: 0.5,
          respect: 0.4,
          note: 'would carry her account another year rather than watch the Lane lose a pub',
        },
        {
          from: 'char:iris-kellow',
          to: 'char:len-fewkes',
          trust: -0.2,
          affection: -0.3,
          respect: 0.15,
          note: 'a man who books a room for six and reads out a clause about noise',
        },
        {
          from: 'char:len-fewkes',
          to: 'char:iris-kellow',
          trust: 0.3,
          affection: 0.1,
          respect: 0.4,
          note: 'a reliable venue, and the only licensee who returns the forms on time',
        },
        {
          from: 'char:cass-frew',
          to: 'char:bee-kellow',
          trust: 0.6,
          affection: 0.7,
          respect: 0.3,
          note: 'babysits her for four pounds an hour and tells her the truth about adults',
        },
        {
          from: 'char:bee-kellow',
          to: 'char:cass-frew',
          trust: 0.85,
          affection: 0.8,
          respect: 0.6,
          note: 'the person she asked what a decree absolute was',
        },
        {
          from: 'char:aiden-frew',
          to: 'char:cass-frew',
          trust: 0.4,
          affection: 0.85,
          respect: 0.3,
          note: 'cannot get out of the headteacher register with his own daughter',
        },
        {
          from: 'char:cass-frew',
          to: 'char:aiden-frew',
          trust: -0.2,
          affection: 0.35,
          respect: -0.4,
          note: 'loves him and has not told him a single true thing since she was fourteen',
        },
        {
          from: 'char:mo-abiri',
          to: 'char:tom-kellow',
          trust: 0.3,
          affection: 0.2,
          respect: 0.35,
          note: 'six twenty, twice this week, and she has said no bother at all both times',
        },
        {
          from: 'char:tom-kellow',
          to: 'char:mo-abiri',
          trust: 0.5,
          affection: 0.4,
          respect: 0.5,
          note: 'the reason he still has a service on Wednesdays, and he has never said thank you properly',
        },
        {
          from: 'char:iris-kellow',
          to: 'char:rhona-tarrant',
          trust: 0.6,
          affection: 0.45,
          respect: 0.85,
          note: 'the only other woman on this estuary running something that is going under',
        },
        {
          from: 'char:rhona-tarrant',
          to: 'char:iris-kellow',
          trust: 0.5,
          affection: 0.4,
          respect: 0.7,
          note: 'would not take advice from her and would take a drink',
        },
        {
          from: 'char:iris-kellow',
          to: 'char:kit-tarrant',
          trust: -0.1,
          affection: 0.3,
          respect: -0.2,
          note: 'bought a round for the whole bar the night he got back, which told her everything',
        },
        {
          from: 'char:kit-tarrant',
          to: 'char:iris-kellow',
          trust: 0.4,
          affection: 0.35,
          respect: 0.5,
          note: 'the landlady who did not ask him where he had been, for which he is disproportionately grateful',
        },
        {
          from: 'char:marie-voss',
          to: 'char:ivo-voss',
          trust: 0.5,
          affection: 0.6,
          respect: 0.4,
          note: 'her household, her mortgage, and the one thing she has not asked him a direct question about',
        },
        {
          from: 'char:ivo-voss',
          to: 'char:marie-voss',
          trust: 0.35,
          affection: 0.75,
          respect: 0.6,
          note: 'loves her and has kept eight months of drawings out of the kitchen',
        },
        {
          from: 'char:winnie-ollery',
          to: 'char:grace-ollery',
          trust: 0.6,
          affection: 0.9,
          respect: 0.5,
          note: 'would want to be told, and has made that impossible',
        },
        {
          from: 'char:grace-ollery',
          to: 'char:winnie-ollery',
          trust: 0.3,
          affection: 0.7,
          respect: 0.4,
          note: 'tells her mother the second-best version of everything',
        },
      ],
      facts: [
        {
          text: 'The Ferryman back room is booked twice on Friday: the Harbour Trust lease hearing at six and Bee’s birthday at seven.',
          knows: ['char:tom-kellow', 'char:len-fewkes', 'char:iris-kellow'],
          suspects: ['char:col-molloy'],
          wrong: ['char:bee-kellow'],
        },
        {
          text: 'The pub cellar floods on any tide over 5.4 metres and has done since January. Friday’s is 5.7.',
          knows: ['char:iris-kellow', 'char:tom-kellow', 'char:col-molloy', 'char:bee-kellow'],
          suspects: ['char:nessa-coyle', 'char:dev-nandra'],
          wrong: ['char:marie-voss'],
        },
        {
          text: 'Marie and Ivo have offered to buy into the Ferryman’s licence.',
          knows: ['char:iris-kellow', 'char:marie-voss', 'char:ivo-voss', 'char:nessa-coyle'],
          suspects: ['char:deb-molloy'],
          wrong: ['char:tom-kellow'],
        },
        {
          text: 'Iris has been going down to the gig shed on Thursday evenings.',
          knows: ['char:iris-kellow', 'char:grace-ollery', 'char:col-molloy'],
          suspects: ['char:tom-kellow', 'char:deb-molloy', 'char:priya-nandra'],
          wrong: ['char:bee-kellow', 'char:aiden-frew'],
        },
        {
          text: 'Nothing has happened between Iris and Grace, and Grace has decided to say nothing to anyone about that either.',
          knows: ['char:iris-kellow', 'char:grace-ollery'],
          wrong: ['char:deb-molloy', 'char:tom-kellow'],
        },
        {
          text: 'Bee has been falling asleep in class and Priya Nandra has a dated note about it.',
          knows: ['char:priya-nandra', 'char:bee-kellow', 'char:mo-abiri'],
          suspects: ['char:aiden-frew'],
          wrong: ['char:iris-kellow', 'char:tom-kellow'],
        },
      ],
      threads: [
        {
          title: 'Friday, booked twice',
          stakes: 'a lease hearing, an eleventh birthday, and one room with a thin wall',
          tension: 0.75,
          parties: ['char:iris-kellow', 'char:tom-kellow', 'char:bee-kellow', 'char:len-fewkes'],
          resolutions: [
            'the Trust is moved to the school hall and nobody minds',
            'the birthday is moved and Bee is told why',
            'both happen, an hour apart, and the wall does what walls do',
            'Iris cancels the hearing and the Trust decides the lease without a public meeting',
          ],
        },
        {
          title: 'The word neither of them will say',
          stakes: 'three years of an unwritten rule, and whether it was ever protecting Bee or only them',
          tension: 0.85,
          parties: ['char:iris-kellow', 'char:tom-kellow', 'char:bee-kellow'],
          resolutions: [
            'they say it to each other in the car park and to Bee together on Saturday',
            'Tom says it first, in the kitchen, with the hatch open',
            'Bee says it first, at the table, having worked it out',
            'neither says it and the year turns again',
          ],
        },
        {
          title: 'Thursdays at the gig shed',
          stakes: 'whether a thing that has not happened yet gets to happen honestly',
          tension: 0.65,
          parties: ['char:iris-kellow', 'char:grace-ollery', 'char:tom-kellow', 'char:deb-molloy'],
          resolutions: [
            'Iris takes the ring off and says so to Tom before anything else',
            'Grace stops coming and gives no reason',
            'Deb Molloy tells it as a fact before it is one',
            'they carry on exactly as they are for another six months',
          ],
        },
        {
          title: 'The offer on the licence',
          stakes: 'half the Ferryman, and who Iris would rather owe',
          tension: 0.6,
          parties: ['char:iris-kellow', 'char:tom-kellow', 'char:marie-voss', 'char:ivo-voss', 'char:nessa-coyle'],
          resolutions: [
            'the offer is taken and Tom finds out it was never the brewery',
            'the offer is refused and the cellar decides it in January instead',
            'Dev Nandra and the traders find a worse but local answer',
            'Iris tells Marie what the cellar actually does, and the figure goes away',
          ],
        },
      ],
      style: {
        pov: 'second',
        tense: 'present',
        register: 'plain',
        density: 'sparse',
        dialogueRatio: 0.58,
        genreLens: 'domestic realism at close range',
        humor: 'none',
        pacing: 'steady',
        sceneTarget: 330,
        comparables: [
          'a marriage conducted entirely through a bookings diary',
          'the last twenty minutes before service, twice a day, for eleven years',
        ],
        forbidden: [
          'a slammed door',
          'either of them saying what they always do',
          'the child used as a device to end a scene',
          'the narration explaining the marriage to the reader',
        ],
        contentBounds: [
          'A marriage ending, at ordinary volume. Sustained low-grade unkindness, contempt and exhaustion are in scope; cruelty staged for effect is not.',
          'Bee is ten, eleven on Friday. She may overhear, misread, and be frightened. Nothing happens to her, and nothing sexual occurs in any scene she is in or adjacent to.',
          'Iris’s attraction to a woman is present and unremarkable to the narration. It is not the crisis and nobody treats it as a revelation.',
          'Physical intimacy: restraint, proximity and a hand not taken. Nothing explicit; the vow about the ring is the mechanism, not the prudery.',
          'No violence, and no affair uncovered by a device — only by people noticing each other in a small town.',
          'Alcohol is present throughout and Iris’s rule about it is load-bearing. No comic drunkenness, no relapse played as spectacle.',
        ],
      },
      anchor: {
        text: 'You write BEE — 7PM in the diary again, over the top of what is already there, in a different pen.',
        note: 'second person, present, sparse: an act of denial recorded as an administrative task',
      },
      opening:
        'The bookings diary is open on the prep bench where he left it, and Friday has two things on it in the same handwriting, which is yours.',
    },
  ],
};
