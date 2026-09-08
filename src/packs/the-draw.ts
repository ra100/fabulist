/**
 * The Draw — original science fiction, written for this engine.
 *
 * The premise is a constraint, not a technology. Ships cross between stars by
 * falling along standing currents; the currents run one way, open only at fixed
 * mouths, and reverse on a schedule of years. Nothing living stays conscious
 * inside one, so a crew goes under and a single Warden holds the ship awake and
 * pays for it in replaced tissue. And no word outruns a ship, which is the
 * load-bearing rule: every consequence in this world travels at hull speed,
 * arrives late, and arrives about something already finished.
 *
 * Authoring notes that follow the engine rather than the fiction:
 *
 *  - **The ship is the persistent place.** `presentIds` matches
 *    `condition.locationId` by exact equality and does not walk `PART_OF`, so
 *    the whole crew sits at `loc:the-deferred-grace` and the interior gets only
 *    three rooms — the three places a closed door is the drama.
 *  - **The crew is a Faction.** `MEMBER_OF` is matched by exact string in
 *    `consequence/propagate.ts` and drives the factional cascade. Without it,
 *    breaking the engineer's hand reaches only whoever was wired to her by hand.
 *  - **The aliens are epistemics.** A Semne promise is carried in a living
 *    figure whose meaning *is* its metabolic state. Nothing that crosses a draw
 *    comes out in the state it entered. So no Semne promise survives transit,
 *    which is a fact the Quorum has always known and human charter law has never
 *    once written down.
 */
import type { WorldPack } from './types.ts';
import { packEdges } from './types.ts';

export const theDrawPack: WorldPack = {
  id: 'the-draw',
  title: 'The Draw',
  genre: 'science-fiction',
  blurb:
    'A hull in debt, a Warden the draw has been quietly replacing, and eleven sleepers who are not on the manifest.',
  premise: `Stars are joined by draws: standing one-way currents that open at fixed mouths, run eleven weeks
or forty, and turn over on a schedule measured in years. When a draw reverses, everything behind it is
simply behind it, and stays there until it turns again. Nothing living remains conscious inside a draw.
A crew goes under in sealed tiers and one person stays awake to hold the ship — the Warden — and comes
out with some measurable share of their body replaced by something the draw put back. That share is
called drift, it is stamped on a card, and at forty hundredths the Warden Roll strikes you off and no
port will agree that you are anybody.

The other rule is the one nobody bothers to state. No word outruns a ship. There is no signal faster
than a hull, so every order, every debt notice, every death in the family arrives weeks or years after
the thing it describes, carried in a sack by whoever happened to be going that way. Ships leave letters
on dead hulls moored at the mouths and hope. Half the law enforced at a toll station is law that was
repealed before the inspector shipped out.

The *Deferred Grace* is a mid-tonnage hull carrying eleven thousand of debt against nine thousand of
hull, a Warden whose card understates him by seven hundredths, a Semne figure-keeper whose every
promise the Quorum has voided, and eleven sealed tiers in the cold hold that appear on no manifest. She
is nine days from a bond payment on the wrong side of a draw that reverses in five weeks. Nothing here
is settled by weapons. It is settled by what people are prepared to write down.`,
  license: 'Original work, written for this engine. No third-party setting or characters.',
  entities: [
    // --- the ship, and the only three rooms worth a door
    //
    // Presence is exact-match on locationId. The crew lives at this id; galley,
    // bridge and corridor are prose, because an entity for them would only serve
    // to move people off-stage.
    {
      id: 'loc:the-deferred-grace',
      type: 'Location',
      name: 'The Deferred Grace',
      summary: 'Mid-tonnage hull, nineteen years old, named for the bond extension that paid for her.',
      tier: 'principal',
      props: { tonnage: 4100, crossings: 31, bondholder: 'the Ferrick Trust' },
    },
    {
      id: 'loc:the-warden-station',
      type: 'Location',
      name: 'The Warden Station',
      summary: 'One seat, one door, sealed from inside. Where a Warden spends eleven weeks being the only one awake.',
      tier: 'principal',
    },
    {
      id: 'loc:the-cold-hold',
      type: 'Location',
      name: 'The Cold Hold',
      summary: 'Freight tiers racked four deep. Cold enough that nobody lingers, which is most of why it is used.',
      tier: 'principal',
    },
    {
      id: 'loc:the-captains-cabin',
      type: 'Location',
      name: "The Captain's Cabin",
      summary: 'Two metres by three, and the only lock aboard the crew respects on principle rather than habit.',
      tier: 'principal',
    },

    // --- port cluster: Winnow, the human toll station at the Marrow mouth
    {
      id: 'loc:winnow-station',
      type: 'Location',
      name: 'Winnow Station',
      summary: 'The toll station at the Marrow mouth. Sells entry slots, weighs manifests, and never hurries.',
      tier: 'principal',
    },
    {
      id: 'loc:the-toll-shed',
      type: 'Location',
      name: 'The Toll Shed',
      summary: 'Where a hull is opened and read. Two tables, a floor drain, and a clerk who has all day.',
      tier: 'principal',
    },
    {
      id: 'loc:the-marrow-mouth',
      type: 'Location',
      name: 'The Marrow Mouth',
      summary: 'The one place the Marrow can be entered. Four hundred kilometres wide and not moveable by anyone.',
      tier: 'principal',
    },
    {
      id: 'loc:the-marrow-draw',
      type: 'Location',
      name: 'The Marrow',
      summary:
        'Eleven weeks of falling toward Semne space. Reverses in five weeks and then not again for eleven years.',
      tier: 'principal',
    },
    {
      id: 'loc:the-lamp',
      type: 'Location',
      name: 'The Lamp',
      summary: 'A dead hull moored at the mouth where crews leave letters for whoever is going the other way.',
      tier: 'principal',
    },

    // --- port cluster: the Slack, salvage and no law worth the name
    {
      id: 'loc:the-slack',
      type: 'Location',
      name: 'The Slack',
      summary: 'A salvage port in the dead water between two mouths. No authority, no toll, and no papers required.',
      tier: 'principal',
    },
    {
      id: 'loc:the-breaker-fields',
      type: 'Location',
      name: 'The Breaker Fields',
      summary: 'Where hulls are cut up for the tiers. A ship with a lien on it is worth more here in pieces.',
      tier: 'supporting',
    },

    // --- port cluster: the Sill, the Semne-held mouth
    {
      id: 'loc:the-sill',
      type: 'Location',
      name: 'The Sill',
      summary: 'The Semne station at the far end of the Marrow. Hulls are admitted or refused; nothing is negotiated.',
      tier: 'principal',
    },
    {
      id: 'loc:the-figure-garden',
      type: 'Location',
      name: 'The Figure Garden',
      summary: 'Warm, wet, and full of racks where the Semne grow the living glyphs they speak and promise with.',
      tier: 'principal',
    },

    // --- port cluster: Lowmarch, where the debt lives
    {
      id: 'loc:lowmarch',
      type: 'Location',
      name: 'Lowmarch',
      summary: 'A company world that manufactures nothing and administers every hull bond written in this arm.',
      tier: 'principal',
    },
    {
      id: 'loc:the-assize-floor',
      type: 'Location',
      name: 'The Assize Floor',
      summary: 'Where hulls are condemned and identities verified. Both are done by the same three clerks.',
      tier: 'supporting',
    },
    {
      id: 'loc:the-measuring-room',
      type: 'Location',
      name: 'The Measuring Room',
      summary: "The Roll's office at Lowmarch. A Warden goes in whole and comes out a number written on a card.",
      tier: 'supporting',
    },

    // --- referenced, not reachable
    {
      id: 'loc:the-ossick-draw',
      type: 'Location',
      name: 'The Ossick',
      summary: 'Turned nine years ago and runs outbound only. Two more years before anything can come back down it.',
      tier: 'supporting',
    },
    {
      id: 'loc:candlewell',
      type: 'Location',
      name: 'Candlewell',
      summary: 'Eleven thousand people behind a reversed draw. Nobody has had word out of it in nine years.',
      tier: 'supporting',
    },
    {
      id: 'loc:the-shear',
      type: 'Location',
      name: 'The Shear',
      summary: 'A mouth that stopped holding. Six hulls entered in one season and none of them arrived anywhere.',
      tier: 'background',
    },
    {
      id: 'loc:ellim',
      type: 'Location',
      name: 'Ellim',
      summary: 'The Semne interior. No human has been admitted past the Sill and none has been told why.',
      tier: 'background',
    },

    // --- cluster A: the crew of the Deferred Grace. Eight people at one
    // locationId, which is the only reason an ensemble happens at all.
    {
      id: 'char:yevet-drun',
      type: 'Character',
      name: 'Captain Yevet Drun',
      summary: 'Holds the hull bond in her own name, which means the hull is hers and so is the shortfall.',
      tier: 'principal',
      props: { status: 'alive', age: 47, crossings: 22 },
    },
    {
      id: 'char:corin-sorge',
      type: 'Character',
      name: 'Corin Sorge',
      summary: "The Grace's Warden. Card says thirty-one hundredths of him is what the draw put back. It is wrong.",
      tier: 'principal',
      props: { status: 'alive', age: 41, crossings: 19, driftOnCard: 0.31, driftMeasured: 0.38 },
    },
    {
      id: 'char:teodor-halb',
      type: 'Character',
      name: 'Teodor Halb',
      summary: 'Second Warden, two crossings held, and quietly certain he could hold a third if anyone would let him.',
      tier: 'principal',
      props: { status: 'alive', age: 24, crossings: 2, driftOnCard: 0.04 },
    },
    {
      id: 'char:anaya-rask',
      type: 'Character',
      name: 'Anaya Rask',
      summary: 'Engineer. Keeps twenty-three sleep tiers running on parts bought from people who cut up hulls.',
      tier: 'principal',
      props: { status: 'alive', age: 52 },
    },
    {
      id: 'char:marit-odiah',
      type: 'Character',
      name: 'Marit Odiah',
      summary: 'Interpreter. Reads Semne figures by heat and taste, and cannot grow a single one of her own.',
      tier: 'principal',
      props: { status: 'alive', age: 36 },
    },
    {
      id: 'char:salt-nine',
      type: 'Character',
      name: 'Salt Nine',
      summary:
        'Semne figure-keeper. Regrew her own name after an injury, so the Quorum holds every promise she ever made void.',
      tier: 'principal',
      props: { status: 'alive', species: 'Semne', standing: 'voided' },
    },
    {
      id: 'char:dov-cheveny',
      type: 'Character',
      name: 'Dov Cheveny',
      summary: 'Purser. Writes the manifest, and writes a second letter about the manifest to a man on Lowmarch.',
      tier: 'principal',
      props: { status: 'alive', age: 33 },
    },
    {
      id: 'char:hanne-wole',
      type: 'Character',
      name: 'Dr Hanne Wole',
      summary: "Ship's physician. Measures the Warden's drift and has entered a smaller number three times running.",
      tier: 'principal',
      props: { status: 'alive', age: 58 },
    },

    // --- cluster B: Winnow, the Mouth Authority, and the people who live off it
    {
      id: 'char:ottilie-brask',
      type: 'Character',
      name: 'Inspector Ottilie Brask',
      summary:
        'Reads hulls at Winnow. Thorough, unbribable, and enforcing orders that may have been repealed months ago.',
      tier: 'principal',
      props: { status: 'alive', age: 45 },
    },
    {
      id: 'char:anders-pell',
      type: 'Character',
      name: 'Reeve Anders Pell',
      summary: 'Sells the entry slots. There are nine before the reversal and eleven captains who need one.',
      tier: 'principal',
      props: { status: 'alive', age: 61 },
    },
    {
      id: 'char:yseult-marek',
      type: 'Character',
      name: 'Yseult Marek',
      summary: 'Roll officer at the mouth. Measures a Warden before entry and has never once been talked down.',
      tier: 'principal',
      props: { status: 'alive', age: 39 },
    },
    {
      id: 'char:ilya-naut',
      type: 'Character',
      name: 'Ilya Naut',
      summary: 'Sells places in the mouth queue that are not his to sell, and delivers about two thirds of them.',
      tier: 'supporting',
      props: { status: 'alive', age: 29 },
    },
    {
      id: 'char:hollis-fen',
      type: 'Character',
      name: 'Hollis Fen',
      summary: 'Keeps the Lamp. Has read every letter left there for nineteen years and delivered nearly all of them.',
      tier: 'supporting',
      props: { status: 'alive', age: 70 },
    },

    // --- cluster C: the Slack
    {
      id: 'char:hessa-vantch',
      type: 'Character',
      name: 'Hessa Vantch',
      summary: 'Runs the Breaker Fields. Buys hulls with liens on them and pays in cash that has no history.',
      tier: 'principal',
      props: { status: 'alive', age: 55 },
    },
    {
      id: 'char:kalo-isang',
      type: 'Character',
      name: 'Kalo Isang',
      summary: 'Struck from the Roll at sixty-one hundredths and crossing anyway. Legally not a person in any port.',
      tier: 'principal',
      props: { status: 'alive', crossings: 44, driftMeasured: 0.61 },
    },
    {
      id: 'char:nim-baptiste',
      type: 'Character',
      name: 'Nim Baptiste',
      summary: 'Sells blank Roll cards. Explains, unprompted, that the stamp is genuine and only the number is a lie.',
      tier: 'supporting',
      props: { status: 'alive', age: 31 },
    },
    {
      id: 'char:orla-vend',
      type: 'Character',
      name: 'Orla Vend',
      summary: 'Twenty-two, Candlewell-born, riding the ninth freight tier. The ninth tier is the one that failed.',
      tier: 'principal',
      props: { status: 'alive', age: 22 },
    },

    // --- cluster D: the Semne Quorum
    {
      id: 'char:warmth-two',
      type: 'Character',
      name: 'Warmth Two',
      summary:
        'Sill-keeper. Admits or refuses hulls, and holds that a promise carried through a draw is not the promise.',
      tier: 'principal',
      props: { status: 'alive', species: 'Semne' },
    },
    {
      id: 'char:ash-eleven',
      type: 'Character',
      name: 'Ash Eleven',
      summary: 'Quorum advocate. Argues the validity of promises, and has never lost one he agreed to argue.',
      tier: 'principal',
      props: { status: 'alive', species: 'Semne' },
    },
    {
      id: 'char:ash-three',
      type: 'Character',
      name: 'Ash Three',
      summary:
        "Witness. The Grace's original charter is not written anywhere; it is a state she is holding in her body.",
      tier: 'principal',
      props: { status: 'alive', species: 'Semne' },
    },
    {
      id: 'char:warmth-seven',
      type: 'Character',
      name: 'Warmth Seven',
      summary: 'Learning human speech, badly, and voiding a promise a week by saying things bodies cannot keep.',
      tier: 'supporting',
      props: { status: 'alive', species: 'Semne' },
    },

    // --- cluster E: the Ferrick Trust, and the paper
    {
      id: 'char:bastian-ferrick',
      type: 'Character',
      name: 'Factor Bastian Ferrick',
      summary: "Holds the Grace's bond and would rather have the hull than the money, which he has not said aloud.",
      tier: 'principal',
      props: { status: 'alive', age: 50 },
    },
    {
      id: 'char:ilva-ovist',
      type: 'Character',
      name: 'Assessor Ilva Ovist',
      summary:
        'Condemns hulls and verifies persons. Has refused to certify four Wardens this year on the same grounds.',
      tier: 'principal',
      props: { status: 'alive', age: 43 },
    },
    {
      id: 'char:sennet-halb',
      type: 'Character',
      name: 'Sennet Halb',
      summary: 'Measurer for the Roll at Lowmarch. Put her nephew on the register and has regretted it since.',
      tier: 'principal',
      props: { status: 'alive', age: 64 },
    },

    // --- bridges
    {
      id: 'char:wren-sorge',
      type: 'Character',
      name: 'Wren Sorge',
      summary: "Corin's daughter, fourteen, on Candlewell. Behind the Ossick for two more years, and possibly alive.",
      tier: 'supporting',
      props: { status: 'unknown', age: 14 },
    },
    {
      id: 'char:ysolde-tarr',
      type: 'Character',
      name: 'Captain Ysolde Tarr',
      summary:
        'Master of the Second Instalment. Needs one of the nine remaining slots and is being very pleasant about it.',
      tier: 'principal',
      props: { status: 'alive', age: 44 },
    },

    // --- factions. The crew is one of these on purpose: MEMBER_OF is matched by
    // exact string and drives the factional cascade, so this is what makes the
    // whole ensemble turn when one of them is hurt.
    {
      id: 'fac:the-grace',
      type: 'Faction',
      name: "The Grace's Crew",
      summary: 'Eight people, one hull, and a bond none of them signed but all of them are riding.',
      tier: 'principal',
    },
    {
      id: 'fac:the-mouth-authority',
      type: 'Faction',
      name: 'The Mouth Authority',
      summary: 'Meters entry at every human-held mouth. Slow, literal, and the last word on who crosses.',
      tier: 'principal',
    },
    {
      id: 'fac:the-warden-roll',
      type: 'Faction',
      name: 'The Warden Roll',
      summary:
        'Registers Wardens, measures drift, and strikes them off at forty hundredths whatever they can still do.',
      tier: 'principal',
    },
    {
      id: 'fac:the-ferrick-trust',
      type: 'Faction',
      name: 'The Ferrick Trust',
      summary: 'Writes hull bonds against a captain personally. Owns eleven hulls it never paid to build.',
      tier: 'principal',
    },
    {
      id: 'fac:the-breakers',
      type: 'Faction',
      name: 'The Breakers',
      summary: 'Salvage crews at the Slack. Will cut up anything, ask nothing, and remember everything for later.',
      tier: 'principal',
    },
    {
      id: 'fac:the-semne-quorum',
      type: 'Faction',
      name: 'The Semne Quorum',
      summary:
        'Holds the far end of the Marrow and every mouth beyond it. Does not sign, and does not consider that a gap.',
      tier: 'principal',
    },

    // --- items
    {
      id: 'item:the-graces-bond',
      type: 'Item',
      name: "The Grace's Bond",
      summary: 'Eleven thousand against a hull worth nine, payable at Lowmarch, endorsed by Yevet Drun personally.',
      tier: 'principal',
    },
    {
      id: 'item:corins-card',
      type: 'Item',
      name: "Corin's Card",
      summary:
        'Nineteen crossings, thirty-one hundredths of drift, stamped by the Roll. Two of the three figures are true.',
      tier: 'principal',
    },
    {
      id: 'item:the-charter-figure',
      type: 'Item',
      name: 'The Charter Figure',
      summary:
        "The Grace's right of entry at the Sill, grown and alive. Its meaning is its state, and its state has changed.",
      tier: 'principal',
    },
    {
      id: 'item:the-cold-freight',
      type: 'Item',
      name: 'The Cold Freight',
      summary: 'Eleven sealed tiers in the hold with people in them, on no manifest, paid for in cash at the Slack.',
      tier: 'principal',
    },
    {
      id: 'item:the-manifest',
      type: 'Item',
      name: 'The Manifest',
      summary: "Cheveny's fair copy. Accurate on every line except the four hundred tonnes it does not mention.",
      tier: 'principal',
    },
    {
      id: 'item:the-ninth-tier',
      type: 'Item',
      name: 'The Ninth Tier',
      summary: 'A sleep tier that seals and does not hold. Whoever is in it is awake for the whole crossing.',
      tier: 'principal',
    },
    {
      id: 'item:the-drift-ledger',
      type: 'Item',
      name: 'The Drift Ledger',
      summary: "The Roll's running record of every registered Warden. Nobody has ever been argued out of a line in it.",
      tier: 'principal',
    },
    {
      id: 'item:a-blank-roll-card',
      type: 'Item',
      name: 'A Blank Roll Card',
      summary: 'Genuine stock, genuine stamp, no numbers yet. Baptiste has fourteen and prices them by the hundredth.',
      tier: 'supporting',
    },
    {
      id: 'item:the-lamp-sack',
      type: 'Item',
      name: 'The Lamp Sack',
      summary: "Two hundred letters for Candlewell, going nowhere for two more years, and eleven of them are Corin's.",
      tier: 'supporting',
    },
    {
      id: 'item:the-grown-name',
      type: 'Item',
      name: 'The Grown Name',
      summary: "Salt Nine's regrown name-figure. Under Semne law it is both her identity and the evidence against it.",
      tier: 'principal',
    },

    // --- concepts. These are the written cannots. The Referee needs a stated
    // prohibition to push against; a world where everything is permitted
    // generates no friction at all.
    {
      id: 'concept:the-draw',
      type: 'Concept',
      name: 'The Draw',
      summary:
        'A standing current between two stars: enterable only at a fixed mouth, one direction only, and it reverses on a schedule of years.',
      tier: 'principal',
    },
    {
      id: 'concept:the-sleep',
      type: 'Concept',
      name: 'The Sleep',
      summary:
        'Nothing living stays conscious inside a draw. A crew goes under in tiers or it does not arrive as itself.',
      tier: 'principal',
    },
    {
      id: 'concept:the-warden',
      type: 'Concept',
      name: 'The Warden',
      summary: 'The one who stays awake to hold the ship. Exactly one, for the whole crossing, sealed alone.',
      tier: 'principal',
    },
    {
      id: 'concept:drift',
      type: 'Concept',
      name: 'Drift',
      summary:
        'The share of a Warden the draw has replaced. It accumulates, it is measured in hundredths, and at forty the Roll strikes you off.',
      tier: 'principal',
    },
    {
      id: 'concept:no-word-outruns-a-ship',
      type: 'Concept',
      name: 'No Word Outruns a Ship',
      summary:
        'There is no signal faster than a hull, so every order, debt and death arrives late and about something already over.',
      tier: 'principal',
    },
    {
      id: 'concept:figures',
      type: 'Concept',
      name: 'Figures',
      summary:
        'Semne speech: small grown organisms whose meaning is their exact metabolic state, so no figure can be copied without becoming a different statement.',
      tier: 'principal',
    },
    {
      id: 'concept:the-unchanged-body',
      type: 'Concept',
      name: 'The Unchanged Body',
      summary: 'Semne law: a promise is void if the body that made it is materially not the body that carries it now.',
      tier: 'principal',
    },
    {
      id: 'concept:the-hull-bond',
      type: 'Concept',
      name: 'The Hull Bond',
      summary:
        'Debt written against a captain personally, not the hull. Default and the ship is condemned and the master is nobody.',
      tier: 'principal',
    },

    // --- events
    {
      id: 'event:the-ossick-reversal',
      type: 'Event',
      name: 'The Ossick Reversal',
      summary:
        'Nine years ago the Ossick turned nine months early and put eleven thousand people on the far side of it.',
      tier: 'principal',
    },
    {
      id: 'event:the-nineteenth-crossing',
      type: 'Event',
      name: 'The Nineteenth Crossing',
      summary:
        "Corin's last transit. He came out with a different set of fingerprints and Wole wrote down the old number.",
      tier: 'principal',
    },
    {
      id: 'event:the-voiding-of-salt-nine',
      type: 'Event',
      name: 'The Voiding of Salt Nine',
      summary:
        'The Quorum ruled her regrown name a different body, and every promise she had ever made fell over at once.',
      tier: 'principal',
    },
    {
      id: 'event:the-shear-losses',
      type: 'Event',
      name: 'The Shear Losses',
      summary:
        'Six hulls entered a mouth that had held for sixty years. Word of the first loss arrived after the sixth.',
      tier: 'supporting',
    },
  ],
  edges: packEdges([
    // --- the crew as a faction. Without these, breaking Rask's hand reaches
    // Rask and whoever was individually wired to her, and the ensemble does not
    // turn.
    ['char:yevet-drun', 'LEADS', 'fac:the-grace', 0.95],
    ['char:corin-sorge', 'MEMBER_OF', 'fac:the-grace', 0.9],
    ['char:teodor-halb', 'MEMBER_OF', 'fac:the-grace', 0.75],
    ['char:anaya-rask', 'MEMBER_OF', 'fac:the-grace', 0.9],
    ['char:marit-odiah', 'MEMBER_OF', 'fac:the-grace', 0.85],
    ['char:salt-nine', 'MEMBER_OF', 'fac:the-grace', 0.8],
    ['char:dov-cheveny', 'MEMBER_OF', 'fac:the-grace', 0.55],
    ['char:hanne-wole', 'MEMBER_OF', 'fac:the-grace', 0.85],
    ['char:yevet-drun', 'COMMANDS', 'char:corin-sorge', 0.7],
    ['char:yevet-drun', 'COMMANDS', 'char:teodor-halb', 0.8],

    // other factions
    ['char:anders-pell', 'LEADS', 'fac:the-mouth-authority', 0.8],
    ['char:ottilie-brask', 'MEMBER_OF', 'fac:the-mouth-authority', 0.9],
    ['char:corin-sorge', 'MEMBER_OF', 'fac:the-warden-roll', 0.8],
    ['char:teodor-halb', 'MEMBER_OF', 'fac:the-warden-roll', 0.6],
    ['char:yseult-marek', 'MEMBER_OF', 'fac:the-warden-roll', 0.85],
    ['char:sennet-halb', 'MEMBER_OF', 'fac:the-warden-roll', 0.9],
    ['char:kalo-isang', 'HOSTILE_TO', 'fac:the-warden-roll', 0.8],
    ['char:hessa-vantch', 'LEADS', 'fac:the-breakers', 0.9],
    ['char:nim-baptiste', 'MEMBER_OF', 'fac:the-breakers', 0.55],
    ['char:kalo-isang', 'MEMBER_OF', 'fac:the-breakers', 0.7],
    ['char:warmth-two', 'LEADS', 'fac:the-semne-quorum', 0.7],
    ['char:ash-eleven', 'MEMBER_OF', 'fac:the-semne-quorum', 0.9],
    ['char:ash-three', 'MEMBER_OF', 'fac:the-semne-quorum', 0.7],
    ['char:warmth-seven', 'MEMBER_OF', 'fac:the-semne-quorum', 0.6],
    ['char:bastian-ferrick', 'LEADS', 'fac:the-ferrick-trust', 0.9],
    ['char:ilva-ovist', 'MEMBER_OF', 'fac:the-ferrick-trust', 0.8],

    // --- inside the crew. Dense, because this is the cluster every scenario
    // shares and the one the player will be standing in.
    ['char:yevet-drun', 'RELIES_ON', 'char:corin-sorge', 0.85],
    ['char:corin-sorge', 'LOYAL_TO', 'char:yevet-drun', 0.7],
    ['char:corin-sorge', 'KEEPS_SECRET_FROM', 'char:yevet-drun', 0.75],
    ['char:yevet-drun', 'PROTECTS', 'char:teodor-halb', 0.5],
    ['char:teodor-halb', 'LOYAL_TO', 'char:yevet-drun', 0.75],
    ['char:corin-sorge', 'MENTORS', 'char:teodor-halb', 0.55],
    ['char:teodor-halb', 'APPRENTICE_OF', 'char:corin-sorge', 0.8],
    // Asymmetric on purpose: Teo is competing and Corin has not noticed.
    ['char:teodor-halb', 'RIVAL_OF', 'char:corin-sorge', 0.45],
    ['char:hanne-wole', 'PROTECTS', 'char:corin-sorge', 0.7],
    ['char:corin-sorge', 'TRUSTS', 'char:hanne-wole', 0.8],
    ['char:hanne-wole', 'KEEPS_SECRET_FROM', 'char:yseult-marek', 0.7],
    ['char:hanne-wole', 'SUSPECTS', 'char:dov-cheveny', 0.5],
    ['char:yevet-drun', 'TRUSTS', 'char:anaya-rask', 0.8],
    ['char:anaya-rask', 'RELIES_ON', 'char:yevet-drun', 0.6],
    ['char:anaya-rask', 'FRIENDLY_WITH', 'char:corin-sorge', 0.7],
    ['char:corin-sorge', 'FRIENDLY_WITH', 'char:anaya-rask', 0.45],
    ['char:anaya-rask', 'FRIENDLY_WITH', 'char:hanne-wole', 0.6],
    ['char:hanne-wole', 'FRIENDLY_WITH', 'char:anaya-rask', 0.65],
    ['char:marit-odiah', 'RELIES_ON', 'char:salt-nine', 0.85],
    ['char:salt-nine', 'TRUSTS', 'char:marit-odiah', 0.6],
    ['char:marit-odiah', 'PROTECTS', 'char:salt-nine', 0.6],
    ['char:salt-nine', 'OWES', 'char:marit-odiah', 0.7],
    // Salt Nine can read his drift off him metabolically. Nobody else aboard can.
    ['char:salt-nine', 'WATCHES', 'char:corin-sorge', 0.6],
    ['char:dov-cheveny', 'SUSPECTS', 'char:yevet-drun', 0.6],
    ['char:yevet-drun', 'SUSPECTS', 'char:dov-cheveny', 0.5],
    ['char:dov-cheveny', 'RIVAL_OF', 'char:marit-odiah', 0.35],
    ['char:teodor-halb', 'FRIENDLY_WITH', 'char:anaya-rask', 0.5],
    ['char:yevet-drun', 'RELIES_ON', 'char:marit-odiah', 0.6],

    // --- the bridge that makes the crew leak: Cheveny reports to Lowmarch.
    ['char:dov-cheveny', 'INFORMS', 'char:bastian-ferrick', 0.8],
    ['char:bastian-ferrick', 'PAYS', 'char:dov-cheveny', 0.6],

    // --- cluster B: Winnow
    ['char:ottilie-brask', 'SERVES', 'char:anders-pell', 0.7],
    ['char:anders-pell', 'RELIES_ON', 'char:ilya-naut', 0.45],
    ['char:ilya-naut', 'PAYS', 'char:anders-pell', 0.6],
    ['char:ottilie-brask', 'HOSTILE_TO', 'char:ilya-naut', 0.6],
    ['char:hollis-fen', 'FRIENDLY_WITH', 'char:ilya-naut', 0.5],
    ['char:hollis-fen', 'INFORMS', 'char:ottilie-brask', 0.4],
    ['char:ottilie-brask', 'SUSPECTS', 'char:yevet-drun', 0.7],
    ['char:yseult-marek', 'WATCHES', 'char:corin-sorge', 0.7],
    ['char:yseult-marek', 'INFORMS', 'char:sennet-halb', 0.6],
    ['char:yseult-marek', 'RIVAL_OF', 'char:sennet-halb', 0.5],
    ['char:anders-pell', 'DEALS_WITH', 'char:ysolde-tarr', 0.6],
    ['char:hollis-fen', 'CORRESPONDS_WITH', 'char:corin-sorge', 0.5],

    // --- cluster C: the Slack
    ['char:hessa-vantch', 'EMPLOYS', 'char:kalo-isang', 0.8],
    ['char:kalo-isang', 'OWES', 'char:hessa-vantch', 0.7],
    ['char:hessa-vantch', 'RELIES_ON', 'char:nim-baptiste', 0.55],
    ['char:nim-baptiste', 'TRUSTS', 'char:hessa-vantch', 0.4],
    ['char:nim-baptiste', 'DEALS_WITH', 'char:hanne-wole', 0.5],
    ['char:hessa-vantch', 'RIVAL_OF', 'char:bastian-ferrick', 0.6],
    ['char:hessa-vantch', 'DEALS_WITH', 'char:yevet-drun', 0.55],
    // Corin sees his own arithmetic in Kalo and crosses the room to avoid it.
    ['char:kalo-isang', 'FRIENDLY_WITH', 'char:corin-sorge', 0.7],
    ['char:corin-sorge', 'SUSPECTS', 'char:kalo-isang', 0.35],
    ['char:orla-vend', 'PAYS', 'char:hessa-vantch', 0.6],
    ['char:orla-vend', 'FRIENDLY_WITH', 'char:wren-sorge', 0.4],

    // --- cluster D: the Quorum
    ['char:ash-eleven', 'MENTORS', 'char:warmth-seven', 0.6],
    ['char:warmth-seven', 'APPRENTICE_OF', 'char:ash-eleven', 0.7],
    ['char:ash-eleven', 'RELIES_ON', 'char:ash-three', 0.8],
    ['char:ash-three', 'KIN_OF', 'char:ash-eleven', 0.6],
    ['char:ash-eleven', 'KIN_OF', 'char:ash-three', 0.5],
    ['char:warmth-two', 'SUSPECTS', 'char:salt-nine', 0.7],
    ['char:salt-nine', 'KEEPS_SECRET_FROM', 'char:warmth-two', 0.8],
    ['char:ash-eleven', 'HOSTILE_TO', 'char:salt-nine', 0.5],
    ['char:ash-eleven', 'WATCHES', 'char:marit-odiah', 0.6],
    ['char:marit-odiah', 'RELIES_ON', 'char:ash-three', 0.5],
    ['char:warmth-seven', 'FRIENDLY_WITH', 'char:marit-odiah', 0.6],
    ['char:marit-odiah', 'PROTECTS', 'char:warmth-seven', 0.4],
    ['char:salt-nine', 'KIN_OF', 'char:ash-three', 0.4],
    ['char:warmth-two', 'HOSTILE_TO', 'char:yevet-drun', 0.4],

    // --- cluster E: the Trust
    ['char:bastian-ferrick', 'EMPLOYS', 'char:ilva-ovist', 0.8],
    ['char:ilva-ovist', 'SERVES', 'char:bastian-ferrick', 0.7],
    ['char:yevet-drun', 'OWES_MONEY_TO', 'char:bastian-ferrick', 0.9],
    ['char:yevet-drun', 'OWES_MONEY_TO', 'fac:the-ferrick-trust', 0.95],
    ['char:bastian-ferrick', 'RIVAL_OF', 'char:yevet-drun', 0.6],
    ['char:ilva-ovist', 'WATCHES', 'char:yevet-drun', 0.6],
    ['char:bastian-ferrick', 'DEALS_WITH', 'char:anders-pell', 0.5],
    ['char:sennet-halb', 'KIN_OF', 'char:teodor-halb', 0.8],
    ['char:teodor-halb', 'KIN_OF', 'char:sennet-halb', 0.7],
    ['char:sennet-halb', 'PATRON_OF', 'char:teodor-halb', 0.7],
    ['char:teodor-halb', 'OWES', 'char:sennet-halb', 0.6],
    ['char:sennet-halb', 'SUSPECTS', 'char:hanne-wole', 0.5],
    ['char:ilva-ovist', 'SUSPECTS', 'char:corin-sorge', 0.55],

    // --- bridges and kin
    ['char:corin-sorge', 'PARENT_OF', 'char:wren-sorge', 0.95],
    ['char:wren-sorge', 'CHILD_OF', 'char:corin-sorge', 0.9],
    ['char:corin-sorge', 'PROTECTS', 'char:wren-sorge', 0.9],
    // Letters that will take two years to move and eleven weeks to be read.
    ['char:corin-sorge', 'CORRESPONDS_WITH', 'char:wren-sorge', 0.6],
    ['char:marit-odiah', 'CORRESPONDS_WITH', 'char:ash-three', 0.4],
    ['char:ysolde-tarr', 'COURTS', 'char:yevet-drun', 0.5],
    ['char:yevet-drun', 'RIVAL_OF', 'char:ysolde-tarr', 0.6],
    ['char:ysolde-tarr', 'OWES_MONEY_TO', 'char:bastian-ferrick', 0.7],
    ['char:ysolde-tarr', 'DEALS_WITH', 'char:ilya-naut', 0.5],
    ['char:kalo-isang', 'SUPPLIES', 'char:hessa-vantch', 0.5],

    // --- structural: containment. Only three rooms hang off the ship, and each
    // one exists because a shut door is the whole point of it.
    ['loc:the-warden-station', 'PART_OF', 'loc:the-deferred-grace', 0.9],
    ['loc:the-cold-hold', 'PART_OF', 'loc:the-deferred-grace', 0.9],
    ['loc:the-captains-cabin', 'PART_OF', 'loc:the-deferred-grace', 0.9],
    ['loc:the-toll-shed', 'PART_OF', 'loc:winnow-station', 0.9],
    ['loc:the-breaker-fields', 'PART_OF', 'loc:the-slack', 0.9],
    ['loc:the-figure-garden', 'PART_OF', 'loc:the-sill', 0.9],
    ['loc:the-assize-floor', 'PART_OF', 'loc:lowmarch', 0.9],
    ['loc:the-measuring-room', 'PART_OF', 'loc:lowmarch', 0.85],
    ['loc:the-lamp', 'PART_OF', 'loc:the-marrow-mouth', 0.7],

    // --- structural: routes. One direction each, which is the point.
    ['loc:winnow-station', 'CONNECTS_TO', 'loc:the-marrow-mouth', 0.9],
    ['loc:the-marrow-mouth', 'CONNECTS_TO', 'loc:the-marrow-draw', 0.95],
    ['loc:the-marrow-draw', 'CONNECTS_TO', 'loc:the-sill', 0.85],
    ['loc:the-sill', 'CONNECTS_TO', 'loc:ellim', 0.4],
    ['loc:lowmarch', 'CONNECTS_TO', 'loc:winnow-station', 0.7],
    ['loc:the-slack', 'CONNECTS_TO', 'loc:winnow-station', 0.6],
    ['loc:the-slack', 'CONNECTS_TO', 'loc:the-shear', 0.45],
    ['loc:the-ossick-draw', 'CONNECTS_TO', 'loc:candlewell', 0.6],
    ['loc:lowmarch', 'CONNECTS_TO', 'loc:the-ossick-draw', 0.5],

    // --- structural: who holds what
    ['fac:the-mouth-authority', 'HOLDS', 'loc:winnow-station', 0.9],
    ['fac:the-mouth-authority', 'HOLDS', 'loc:the-marrow-mouth', 0.8],
    ['loc:winnow-station', 'GOVERNED_BY', 'fac:the-mouth-authority', 0.9],
    ['fac:the-semne-quorum', 'HOLDS', 'loc:the-sill', 0.95],
    ['fac:the-semne-quorum', 'HOLDS', 'loc:ellim', 0.9],
    ['fac:the-semne-quorum', 'HOLDS', 'loc:the-figure-garden', 0.85],
    ['fac:the-breakers', 'OCCUPIES', 'loc:the-slack', 0.85],
    ['fac:the-breakers', 'HOLDS', 'loc:the-breaker-fields', 0.8],
    ['fac:the-ferrick-trust', 'HOLDS', 'loc:lowmarch', 0.8],
    ['fac:the-ferrick-trust', 'HOLDS', 'loc:the-assize-floor', 0.85],
    ['fac:the-warden-roll', 'HOLDS', 'loc:the-measuring-room', 0.85],
    ['fac:the-grace', 'OCCUPIES', 'loc:the-deferred-grace', 0.9],
    // The bank owns the house you sleep in.
    ['fac:the-ferrick-trust', 'HOLDS', 'loc:the-deferred-grace', 0.6],

    // --- structural: sworn to a rule rather than a person
    ['char:corin-sorge', 'SWORN_TO', 'concept:the-warden', 0.95],
    ['char:teodor-halb', 'SWORN_TO', 'concept:the-warden', 0.6],
    ['char:kalo-isang', 'SWORN_TO', 'concept:the-warden', 0.4],
    ['fac:the-warden-roll', 'SWORN_TO', 'concept:drift', 0.9],
    ['fac:the-semne-quorum', 'SWORN_TO', 'concept:the-unchanged-body', 1.0],
    ['char:yevet-drun', 'SWORN_TO', 'concept:the-hull-bond', 0.85],
    ['fac:the-ferrick-trust', 'SWORN_TO', 'concept:the-hull-bond', 0.9],
    ['fac:the-mouth-authority', 'SWORN_TO', 'concept:the-draw', 0.7],
    ['char:warmth-two', 'WORSHIPS', 'concept:the-unchanged-body', 0.8],

    // --- structural: how the ideas nest
    ['concept:the-sleep', 'PART_OF', 'concept:the-draw', 0.85],
    ['concept:the-warden', 'PART_OF', 'concept:the-sleep', 0.8],
    ['concept:drift', 'PART_OF', 'concept:the-warden', 0.85],
    ['concept:no-word-outruns-a-ship', 'PART_OF', 'concept:the-draw', 0.75],
    ['concept:figures', 'MENTIONS', 'concept:the-unchanged-body', 0.6],
    ['concept:the-unchanged-body', 'MENTIONS', 'concept:drift', 0.7],

    // --- structural: custody
    ['char:corin-sorge', 'CARRIES', 'item:corins-card', 0.9],
    ['char:hanne-wole', 'KEEPS', 'item:the-ninth-tier', 0.3],
    ['char:anaya-rask', 'KEEPS', 'item:the-ninth-tier', 0.8],
    ['item:the-ninth-tier', 'KEPT_IN', 'loc:the-cold-hold', 0.9],
    ['char:salt-nine', 'KEEPS', 'item:the-charter-figure', 0.9],
    ['item:the-charter-figure', 'KEPT_IN', 'loc:the-cold-hold', 0.75],
    ['char:salt-nine', 'CARRIES', 'item:the-grown-name', 0.9],
    ['char:dov-cheveny', 'KEEPS', 'item:the-manifest', 0.85],
    ['item:the-cold-freight', 'KEPT_IN', 'loc:the-cold-hold', 0.95],
    ['char:bastian-ferrick', 'KEEPS', 'item:the-graces-bond', 0.9],
    ['item:the-graces-bond', 'KEPT_IN', 'loc:the-assize-floor', 0.8],
    ['char:yseult-marek', 'KEEPS', 'item:the-drift-ledger', 0.8],
    ['char:nim-baptiste', 'KEEPS', 'item:a-blank-roll-card', 0.7],
    ['char:hollis-fen', 'KEEPS', 'item:the-lamp-sack', 0.7],
    ['item:the-lamp-sack', 'KEPT_IN', 'loc:the-lamp', 0.95],

    // --- structural: origin and habit
    ['char:salt-nine', 'FROM_WORLD', 'loc:ellim', 0.8],
    ['char:warmth-two', 'FROM_WORLD', 'loc:ellim', 0.8],
    ['char:ash-eleven', 'FROM_WORLD', 'loc:ellim', 0.8],
    ['char:ash-three', 'FROM_WORLD', 'loc:ellim', 0.8],
    ['char:warmth-seven', 'FROM_WORLD', 'loc:ellim', 0.8],
    ['char:corin-sorge', 'FROM_WORLD', 'loc:candlewell', 0.75],
    ['char:orla-vend', 'FROM_WORLD', 'loc:candlewell', 0.8],
    ['char:corin-sorge', 'WORKS_AT', 'loc:the-warden-station', 0.95],
    ['char:yevet-drun', 'LIVES_AT', 'loc:the-captains-cabin', 0.9],
    ['char:anaya-rask', 'WORKS_AT', 'loc:the-cold-hold', 0.6],
    ['char:ottilie-brask', 'WORKS_AT', 'loc:the-toll-shed', 0.9],
    ['char:anders-pell', 'WORKS_AT', 'loc:winnow-station', 0.9],
    ['char:yseult-marek', 'WORKS_AT', 'loc:winnow-station', 0.7],
    ['char:ilya-naut', 'MEETS_AT', 'loc:winnow-station', 0.6],
    ['char:hollis-fen', 'LIVES_AT', 'loc:the-lamp', 0.95],
    ['char:hessa-vantch', 'WORKS_AT', 'loc:the-breaker-fields', 0.9],
    ['char:kalo-isang', 'FOUND_AT', 'loc:the-slack', 0.7],
    ['char:nim-baptiste', 'MEETS_AT', 'loc:the-slack', 0.7],
    ['char:warmth-two', 'WORKS_AT', 'loc:the-sill', 0.9],
    ['char:ash-eleven', 'WORKS_AT', 'loc:the-sill', 0.7],
    ['char:warmth-seven', 'WORKS_AT', 'loc:the-figure-garden', 0.7],
    ['char:ash-three', 'LIVES_AT', 'loc:the-figure-garden', 0.6],
    ['char:bastian-ferrick', 'WORKS_AT', 'loc:the-assize-floor', 0.8],
    ['char:ilva-ovist', 'WORKS_AT', 'loc:the-assize-floor', 0.85],
    ['char:sennet-halb', 'WORKS_AT', 'loc:the-measuring-room', 0.9],
    ['char:wren-sorge', 'LIVES_AT', 'loc:candlewell', 0.9],
    ['char:ysolde-tarr', 'FOUND_AT', 'loc:winnow-station', 0.5],
    ['char:marit-odiah', 'MEETS_AT', 'loc:the-figure-garden', 0.6],

    // --- structural: what the events are about
    ['event:the-ossick-reversal', 'MENTIONS', 'loc:the-ossick-draw', 0.9],
    ['event:the-ossick-reversal', 'MENTIONS', 'loc:candlewell', 0.85],
    ['event:the-ossick-reversal', 'MENTIONS', 'char:wren-sorge', 0.6],
    ['event:the-nineteenth-crossing', 'MENTIONS', 'char:corin-sorge', 0.9],
    ['event:the-nineteenth-crossing', 'MENTIONS', 'concept:drift', 0.8],
    ['event:the-nineteenth-crossing', 'MENTIONS', 'char:hanne-wole', 0.7],
    ['event:the-voiding-of-salt-nine', 'MENTIONS', 'char:salt-nine', 0.9],
    ['event:the-voiding-of-salt-nine', 'MENTIONS', 'concept:the-unchanged-body', 0.85],
    ['event:the-voiding-of-salt-nine', 'MENTIONS', 'item:the-grown-name', 0.8],
    ['event:the-shear-losses', 'MENTIONS', 'loc:the-shear', 0.9],
    ['event:the-shear-losses', 'MENTIONS', 'concept:no-word-outruns-a-ship', 0.75],
  ]),
  sheets: [
    {
      entityId: 'char:yevet-drun',
      identity: {
        goals: ['make the Lowmarch payment', 'get the eleven off the ship alive', "keep her master's ticket"],
        wounds: ['signed the bond personally at thirty-one because nobody else would underwrite her'],
        fears: ['being condemned and certified as nobody in the same room on the same afternoon'],
        allegiances: ["the Grace's crew", 'the eleven in the hold, who paid her'],
        competencies: ['reading a contract for what it does not say', 'holding a hull together on credit'],
        secrets: ['the eleven tiers are people and she wrote them down as agricultural plant'],
        arc: 'A master who has kept the ship by never once being the one who has to say no out loud.',
      },
      contract: {
        vows: [
          {
            id: 'the-hull',
            text: 'the Grace does not go to the breakers while I hold her',
            rank: 1,
            broken: false,
            brokenScene: null,
          },
          {
            id: 'the-freight',
            text: 'anyone I take money from, I put down alive',
            rank: 2,
            broken: false,
            brokenScene: null,
          },
          {
            id: 'the-warden',
            text: 'no Warden of mine crosses past what the Roll allows',
            rank: 3,
            broken: false,
            brokenScene: null,
          },
        ],
        drives: ['keep the hull', 'be owed nothing she cannot name'],
        breakingPoint: 'A slot she can take only by putting Teodor in the station instead of Corin.',
        costOfBreak: 'Corin would let her. That is what would be unbearable about it.',
      },
      voice: {
        diction: 'Flat, commercial, specific about figures. Answers the question that was asked and no more.',
        tics: ['gives a number instead of a reason', 'says "as it stands" before conceding anything'],
        samples: [
          'As it stands we are nine days short and five weeks from the reversal. Pick which one to be sorry about.',
          'I did not ask what it costs. I asked what it costs me.',
          'Write it down. If it is not worth writing down it is not worth arguing about.',
        ],
        never: ['pleads', 'raises her voice below decks', 'mentions the eleven by number where Cheveny can hear'],
      },
      appearance: {
        description:
          'Forty-seven, short, heavy through the shoulders from twenty years of low-gravity work. Cropped grey hair, a face that gives away nothing at a table.',
        attire: "A master's coat with the Ferrick endorsement stitched inside the cuff where it cannot be seen.",
        markers: ['two joints missing from the left little finger', 'reading lenses on a cord she never takes off'],
      },
    },
    {
      entityId: 'char:corin-sorge',
      identity: {
        goals: ['hold one more crossing', 'reach the Ossick before it turns back', 'find out whether Wren is alive'],
        wounds: ['nineteen crossings', 'left Candlewell four months before the draw reversed and took the work'],
        fears: ['being struck off in a room at Lowmarch and never being allowed to cross toward her again'],
        allegiances: ['the Grace', 'Wren'],
        competencies: ['holding a hull awake for eleven weeks', 'lying calmly to a measurer'],
        secrets: ['he lost the last three hours of the nineteenth crossing and does not know what he did in them'],
        arc: 'A man spending himself in instalments toward a place that will not open for two more years.',
      },
      contract: {
        vows: [
          {
            id: 'the-station',
            text: 'the ship comes out, whatever comes out with it',
            rank: 1,
            broken: false,
            brokenScene: null,
          },
          {
            id: 'the-sleepers',
            text: 'nobody wakes inside a draw on my watch',
            rank: 2,
            broken: false,
            brokenScene: null,
          },
          {
            id: 'the-card',
            text: 'I will not cross on a number I know to be false',
            rank: 4,
            broken: false,
            brokenScene: null,
          },
        ],
        drives: ['get to Candlewell', 'not become Kalo Isang'],
        breakingPoint: 'A voice on the hold circuit, eight weeks from anywhere, asking him to open the door.',
        costOfBreak:
          'Two conscious minds in one draw. Nobody who has tried it has come back able to say what happened.',
      },
      voice: {
        diction: 'Quiet, concrete, slightly behind the conversation. Talks about equipment when asked about himself.',
        tics: ['states the elapsed time unprompted', 'corrects a small factual detail instead of answering'],
        samples: [
          'Twenty-two days. I keep the count out loud because the count is the part that goes first.',
          'It is not that I forget. It is that I come back and something has been done and it was me who did it.',
          'You should not be awake. Say your name again for me.',
        ],
        never: ['says he is frightened', 'mentions Wren to anyone aboard except Wole', 'refuses a crossing'],
      },
      appearance: {
        description:
          "Forty-one and unmarked — no scars, no calluses, teeth like a boy's, skin that takes no ink. Nineteen crossings of replacement have left him newer than he should be, and it reads wrong at close range.",
        attire: "A Warden's quilted station coat, worn indoors out of habit, cuffs frayed where the seat straps cross.",
        markers: [
          'fingerprints that no longer match his card',
          'a wedding band he cannot get off a hand that keeps changing size',
        ],
      },
    },
    {
      entityId: 'char:marit-odiah',
      identity: {
        goals: [
          'keep the charter standing',
          'be allowed to speak in her own right at the Sill',
          'protect Salt Nine from her own people',
        ],
        wounds: ['eleven years learning a language she can read and will never be able to speak'],
        fears: ['that everything she has ever translated was a different promise by the time she said it in human'],
        allegiances: ['the Grace', 'Salt Nine', "her own reading, over the Quorum's"],
        competencies: [
          'reading a figure by heat, smell and four trained tastes',
          'Quorum procedure',
          'knowing when a Semne has said nothing',
        ],
        secrets: ['she has been reading the charter figure privately for a month and it has been dying for three'],
        arc: 'An interpreter discovering the medium she serves cannot carry what she has been paid to carry.',
      },
      contract: {
        vows: [
          {
            id: 'accuracy',
            text: 'I render what the figure is, not what the room wants it to be',
            rank: 1,
            broken: false,
            brokenScene: null,
          },
          {
            id: 'attribution',
            text: 'I never speak a promise as mine that is not mine',
            rank: 2,
            broken: false,
            brokenScene: null,
          },
          {
            id: 'the-voided',
            text: 'a voided speaker is still a speaker, and I will say so in the hearing',
            rank: 3,
            broken: false,
            brokenScene: null,
          },
        ],
        drives: ['be believed', 'get the reading right even when the reading is fatal'],
        breakingPoint:
          'Being told that the honest reading condemns the hull and the crew, and being handed a dishonest one that does not.',
        costOfBreak: 'Salt Nine would smell it on her before she finished the sentence.',
      },
      voice: {
        diction: 'Careful, technical, hedges with the precision of someone who has been burned by a loose word.',
        tics: ['distinguishes "says" from "carries"', "gives the figure's temperature before its meaning"],
        samples: [
          'It carries consent. I am not prepared to tell you it says yes.',
          'Nine degrees down from what it was at the mouth. In their law that is not a change of mood, it is a change of speaker.',
          'You are asking me to quote something that cannot be quoted. That is not modesty, Captain, it is the physics.',
        ],
        never: ['guesses out loud', 'speaks for Salt Nine without saying she is doing it'],
      },
      appearance: {
        description:
          'Thirty-six, thin, hands and forearms permanently pink from garden humidity. Eyes kept half shut in warm rooms out of long habit.',
        attire: 'Garden coveralls under a human coat she takes off the moment she is inside the Sill.',
        markers: [
          'no sense of smell left for anything human',
          "a reader's scald across the palate that makes her eat everything cold",
        ],
      },
    },

    // --- the three who push back hardest, in detail
    {
      entityId: 'char:salt-nine',
      identity: {
        goals: ['keep the charter figure alive to the Sill', 'be re-witnessed by anybody at all'],
        wounds: ['a hull fire took two thirds of her and she chose to regrow rather than die of it'],
        fears: ['dying voided, which in her law means never having existed as a promiser'],
        allegiances: ['the Grace', 'Marit Odiah'],
        competencies: ['growing and tending figures', 'reading a metabolic state at two metres', 'Quorum precedent'],
        secrets: ["she can read Corin's real drift off the air in a corridor and has told nobody"],
        arc: 'A person her own law says is a stranger wearing her promises.',
      },
      contract: {
        vows: [
          {
            id: 'the-charter',
            text: 'the figure in my keeping arrives alive',
            rank: 1,
            broken: false,
            brokenScene: null,
          },
          {
            id: 'no-forgery',
            text: 'I will not grow a figure to say what was not said',
            rank: 2,
            broken: false,
            brokenScene: null,
          },
        ],
        drives: ['be a valid speaker again', 'owe Marit less than she does'],
        breakingPoint: 'Being asked to grow a replacement charter and swear it is the same promise.',
        costOfBreak: 'It would be true forgery, and she would have proved the Quorum right about her.',
      },
      voice: {
        diction:
          'Short human sentences assembled from a smaller vocabulary than she has. Precise about states, blunt about people.',
        tics: ['gives temperatures instead of feelings', 'says "I am not able to promise that" as a complete answer'],
        samples: [
          'It is four degrees down. It will not reach the Sill as itself.',
          'I am not able to promise that. I am able to intend it. Write the intention.',
          'Your Warden runs warm on the left side. He has not for eleven days. Ask him.',
        ],
        never: ['claims to promise', 'discusses the fire', 'speaks to Warmth Two directly'],
      },
      appearance: {
        description:
          'Waist-high and broad, matte grey-green, mantled in fine cilia that run visibly warm or cold as she speaks. No face — a reading-cleft low on the front, and four short limbs that fold under her at rest.',
        attire: 'A humidity wrap of ship canvas, patched, and a harness of grown pockets for figures in transit.',
        markers: [
          'the regrowth seam across her whole upper mantle, a paler grey',
          'carries her own name-figure at the throat where a Semne is required to',
        ],
      },
    },
    {
      entityId: 'char:warmth-two',
      identity: {
        goals: ['admit no promise that cannot be verified in the body that carries it'],
        fears: ['a precedent that lets changed bodies bind the Quorum'],
        allegiances: ['the Semne Quorum', 'the Unchanged Body'],
        competencies: ['refusal', "reading a figure's transit history off its state"],
        secrets: ['the Quorum has known for two centuries that no promise survives a draw and has never told a human'],
        arc: 'A keeper who is entirely correct and has never once considered what being correct costs the other side.',
      },
      contract: {
        vows: [
          { id: 'the-sill', text: 'nothing changed passes as unchanged', rank: 1, broken: false, brokenScene: null },
        ],
        drives: ['hold the rule exactly'],
        breakingPoint: 'A case where holding the rule kills eleven people at his own threshold.',
        costOfBreak: 'The rule would be a preference, and the Quorum has nothing else.',
      },
      voice: {
        diction:
          'Formal, complete, and entirely without give. Uses the passive for anything a human would call a decision.',
        tics: ['restates the rule before applying it', 'refers to people as "the carrier" and "the promiser"'],
        samples: [
          'The promiser is not present. A body of thirty-eight hundredths difference is not the body that swore.',
          'It is not refused. It was never valid. There is nothing here to refuse.',
        ],
        never: ['negotiates', 'expresses regret', 'acknowledges Salt Nine as a speaker'],
      },
      appearance: {
        description:
          'Larger than most, pale ash-grey, cilia clipped short in the Sill fashion so that his state is legible at distance to anyone entitled to read it.',
        attire:
          "The Sill-keeper's cold collar, which holds him a fixed two degrees below ambient so his speech cannot be misread as feeling.",
        markers: ['a witness-brand of grown tissue on the left flank, renewed every year'],
      },
    },
    {
      entityId: 'char:bastian-ferrick',
      identity: {
        goals: ['take the Grace at condemnation value', 'never be the one who says so'],
        fears: ['a captain who reads the bond properly and pays on the last day'],
        allegiances: ['the Ferrick Trust'],
        competencies: ['bond drafting', 'patience', "buying purser's letters"],
        secrets: ['he has a buyer for the hull already and the price is nearly double the debt'],
        arc: 'A man who has never seized anything, only allowed things to fall due.',
      },
      contract: {
        vows: [
          {
            id: 'the-instrument',
            text: 'the instrument is enforced as written, always',
            rank: 2,
            broken: false,
            brokenScene: null,
          },
        ],
        drives: ['acquire without appearing to want'],
        breakingPoint: 'Having to say out loud, in front of Ovist, that he wants the hull.',
        costOfBreak: 'Nine other captains would read their own bonds that evening.',
      },
      voice: {
        diction: 'Courteous, unhurried, sympathetic in the abstract. Never uses the word "seize".',
        tics: ['calls the debt "the position"', 'offers water before bad news'],
        samples: [
          'The position matures on the ninth. I am not able to alter that; nobody is.',
          'I would very much rather you paid, Captain. I have said so in writing.',
        ],
        never: ['threatens', 'discusses the buyer', 'writes down what he wants'],
      },
      appearance: {
        description:
          'Fifty, soft, immaculate; the pallor of a man who has never crossed a draw and does not intend to.',
        attire: "Registry black with the Trust's pin, and gloves indoors.",
        markers: ['a habit of aligning papers square before speaking'],
      },
    },

    // --- everyone else: goals, a diction, a body. Enough to be played, not
    // enough to spend frame budget on.
    {
      entityId: 'char:teodor-halb',
      identity: {
        goals: ['be given a full crossing', "get out from under his aunt's recommendation"],
        fears: ['being twenty-four forever and a second hand forever'],
        secrets: ["he has read Corin's ledger line and knows the numbers do not reconcile"],
      },
      contract: {
        vows: [
          { id: 'the-roll', text: 'I hold what the Roll says I may hold', rank: 3, broken: false, brokenScene: null },
        ],
        drives: ['be the one they need'],
        breakingPoint: 'Being told the seat is his because Corin cannot.',
        costOfBreak: 'He would take it, and know exactly what it cost, and take it anyway.',
      },
      voice: { diction: 'Eager, over-precise, quotes regulation numbers he has memorised out of anxiety.' },
      appearance: {
        description:
          'Twenty-four, tall, unfinished-looking; two crossings have taken nothing off him yet and it shows next to Corin.',
        attire: "A second hand's station coat, new, still stiff at the collar.",
      },
    },
    {
      entityId: 'char:anaya-rask',
      identity: {
        goals: ['keep twenty-three tiers sealing', 'not be the reason somebody wakes up in transit'],
        wounds: ['fitted the ninth tier herself out of Slack parts, eight months ago'],
        competencies: ['sleep tiers', 'sourcing parts with no history'],
      },
      voice: {
        diction: 'Terse, mechanical, gives tolerances rather than opinions. Swears at equipment, never at people.',
      },
      appearance: {
        description: 'Fifty-two, wiry, hands ruined by coolant. Grey plait pinned flat for hatchways.',
        attire: "Engineer's wrap, pockets sewn on wherever she needed one.",
        markers: ['cold burns up both forearms in overlapping crescents'],
      },
    },
    {
      entityId: 'char:hanne-wole',
      identity: {
        goals: ['keep Corin off the Assize Floor', 'stop having to choose which number to write'],
        fears: ['being struck herself, which would end four careers at once'],
        secrets: ["she has understated the Warden's drift by seven hundredths across three crossings"],
      },
      voice: { diction: 'Dry, clinical, understates everything including catastrophe. Never softens a number twice.' },
      appearance: {
        description: 'Fifty-eight, spare, very still hands. Reads faces the way she reads charts, in order.',
        attire: "Ship's medical coat, sleeves permanently rolled, drift calipers on a belt clip.",
      },
    },
    {
      entityId: 'char:dov-cheveny',
      identity: {
        goals: ['be indispensable to somebody solvent', 'get off the Grace before the ninth'],
        fears: ['crossing again on a hull he has stopped believing in'],
        secrets: [
          'his letter to Ferrick describing the cold hold is already at the Lamp, waiting for anything outbound',
        ],
      },
      voice: { diction: 'Pleasant, helpful, slightly too interested. Volunteers information nobody asked for.' },
      appearance: {
        description: 'Thirty-three, neat, soft-handed; the only person aboard whose collar is always clean.',
        attire: "Purser's jacket kept brushed, and a document case he does not put down.",
      },
    },
    {
      entityId: 'char:ottilie-brask',
      identity: {
        goals: ['open the cold hold', 'be right on the record'],
        fears: ['having enforced something already repealed, again'],
        competencies: ['reading a hull against its own manifest', 'not being hurried'],
      },
      voice: { diction: 'Level, procedural, courteous in a way that offers nothing. Reads clauses aloud verbatim.' },
      appearance: {
        description: 'Forty-five, upright, unhurried. The face of someone who has all day and knows you do not.',
        attire: 'Authority grey with the mouth badge, boots for standing in cold holds.',
        markers: ['a tally clicker worn on the thumb'],
      },
    },
    {
      entityId: 'char:anders-pell',
      identity: { goals: ['sell nine slots for the price of eleven', 'retire before the reversal'] },
      voice: { diction: 'Genial, evasive, changes the subject to the weather at the mouth.' },
      appearance: { description: 'Sixty-one, comfortable, a reeve who has never been to the far end of anything.' },
    },
    {
      entityId: 'char:yseult-marek',
      identity: {
        goals: ['measure every Warden entering the Marrow before the reversal'],
        secrets: ["she has flagged the Grace's ledger line for review at Lowmarch and not told the ship"],
      },
      voice: {
        diction: 'Clipped, exact, repeats a number back before writing it. Immune to charm and slightly proud of it.',
      },
      appearance: {
        description:
          'Thirty-nine, narrow, gloved. Carries the ledger against her chest like something that might be taken.',
      },
    },
    {
      entityId: 'char:ilya-naut',
      identity: { goals: ['sell a slot he does not have', 'stay ahead of Brask'] },
      voice: { diction: 'Fast, friendly, promises in the present tense to avoid promising in the future.' },
      appearance: { description: 'Twenty-nine, restless, dressed one grade better than he can afford.' },
    },
    {
      entityId: 'char:hollis-fen',
      identity: {
        goals: ['see the Candlewell sack delivered before he dies'],
        secrets: ["he has read all two hundred Candlewell letters and can recite Corin's"],
      },
      voice: { diction: "Slow, digressive, quotes other people's letters as if they were common knowledge." },
      appearance: {
        description: "Seventy, bent, living in a dead hull he has fitted out with other people's furniture.",
      },
    },
    {
      entityId: 'char:hessa-vantch',
      identity: {
        goals: ['buy the Grace at breaker price', 'keep the freight trade quiet'],
        secrets: ['she sold Drun the eleven passages and kept no record of it at all'],
      },
      voice: { diction: 'Warm, generous, absolutely transactional. Talks about tonnage while discussing people.' },
      appearance: { description: 'Fifty-five, broad, cheerful; cut-scarred forearms she does not cover.' },
    },
    {
      entityId: 'char:kalo-isang',
      identity: {
        goals: ['keep crossing until it stops', 'tell one registered Warden the truth before he goes'],
        wounds: ['forty-four crossings; struck off at sixty-one hundredths; no port will certify him as anyone'],
      },
      voice: { diction: 'Amiable, wandering, loses the thread mid-sentence and picks up a different one.' },
      appearance: {
        description:
          'Age unguessable. Skin like something new, eyes that do not match each other, a body assembled from forty-four separate returns.',
        markers: ['no fingerprints at all', 'a struck card he still carries'],
      },
    },
    {
      entityId: 'char:nim-baptiste',
      identity: { goals: ['sell fourteen cards before the reversal'] },
      voice: { diction: 'Chatty, technical about forgery, oddly ethical about the stamp.' },
      appearance: { description: 'Thirty-one, tidy, ink on the fingertips of one hand only.' },
    },
    {
      entityId: 'char:orla-vend',
      identity: {
        goals: ['reach the Sill alive', 'get word to Candlewell that she got out'],
        fears: ['being told to go back under and knowing the tier will not take'],
        secrets: ['she knew the ninth tier was bad at the mouth and got in anyway'],
      },
      contract: {
        vows: [
          {
            id: 'the-passage',
            text: 'I do not cost anyone else the crossing',
            rank: 2,
            broken: false,
            brokenScene: null,
          },
        ],
        drives: ['live long enough to be somewhere'],
        breakingPoint: 'Week eight, when the hold circuit is the only voice left.',
        costOfBreak: 'She asks him to open the door.',
      },
      voice: { diction: 'Young, plain, factual about her own condition in a way that is hard to sit with.' },
      appearance: {
        description:
          'Twenty-two, small, Candlewell-thin. By week three the draw has begun taking her the way it takes Wardens, without the seat to hold her.',
        markers: ['a hand that has stopped matching the other one'],
      },
    },
    {
      entityId: 'char:ash-eleven',
      identity: {
        goals: ['establish that transit voids carriage, once, on the record'],
        secrets: ['he believes the rule is indefensible and intends to win with it anyway'],
      },
      voice: {
        diction: 'Elegant, procedural, sets traps two questions ahead. Enjoys precision the way others enjoy weather.',
      },
      appearance: {
        description: "Slight for a Semne, dark grey, cilia grown long and stained with advocate's pigment.",
      },
    },
    {
      entityId: 'char:ash-three',
      identity: {
        goals: ['carry the charter state unchanged for as long as her body allows'],
        wounds: ['nine years holding one promise has cost her the ability to hold any other'],
      },
      voice: {
        diction:
          'Sparse. Speaks rarely, because speaking alters her, and everything she is for depends on not altering.',
      },
      appearance: {
        description: 'Held at fixed temperature in the garden, wrapped, attended. A body being used as a document.',
      },
    },
    {
      entityId: 'char:warmth-seven',
      identity: {
        goals: ['learn to speak human without voiding herself weekly'],
        fears: ['being ruled a habitual false promiser, which is permanent'],
      },
      voice: { diction: 'Enthusiastic, wrong, over-promises constantly because human tenses invite it.' },
      appearance: {
        description: 'Young, small, cilia still pale; runs hot when embarrassed, which is often and legible.',
      },
    },
    {
      entityId: 'char:ilva-ovist',
      identity: {
        goals: ['certify only bodies she can verify', 'condemn the Grace on schedule'],
        secrets: ['she has refused four Wardens this year and has begun to suspect the rule is the problem'],
      },
      voice: { diction: 'Precise, impersonal, quotes the certification standard as though it were weather.' },
      appearance: { description: 'Forty-three, severe, gloved; a measuring rig on the desk she uses on everyone.' },
    },
    {
      entityId: 'char:sennet-halb',
      identity: {
        goals: ['keep the Roll honest', 'get her nephew off the register before he is spent'],
        wounds: ['put Teodor on the Roll herself, at his asking, four years ago'],
      },
      voice: { diction: 'Weary, formal, delivers unbearable numbers in the same tone as the date.' },
      appearance: { description: "Sixty-four, upright, a measurer's stained cuffs she has stopped trying to clean." },
    },
    {
      entityId: 'char:ysolde-tarr',
      identity: {
        goals: ['take one of the nine slots', 'be owed a favour by Yevet Drun'],
      },
      voice: { diction: 'Charming, teasing, generous with everything except the slot.' },
      appearance: {
        description: 'Forty-four, handsome, immaculate; a master who has never missed a payment and mentions it.',
      },
    },
    {
      entityId: 'char:wren-sorge',
      identity: {
        goals: ['get a letter out of Candlewell'],
        fears: ['that her father stopped writing nine years ago'],
      },
      voice: { diction: 'Fourteen, careful, writes better than she talks because writing is all there is.' },
      appearance: {
        description:
          'Fourteen, and unphotographed for nine years. Nobody aboard the Grace knows what she looks like now.',
      },
    },
  ],
  scenarios: [
    // ------------------------------------------------------------------ one
    // The captain. Debt, an inspection, and a crossing that should not happen.
    // Everyone aboard sits at the ship's own id, so the whole crew is on stage
    // and the factional cascade has somewhere to land.
    {
      id: 'the-ninth-day',
      title: 'Nine Days, Five Weeks',
      premise: `The bond falls due at Lowmarch on the ninth. The only route that gets you there and back is the
Marrow, which reverses in five weeks and then not for eleven years. Reeve Pell has nine entry slots and
eleven captains. Inspector Brask wants the cold hold opened, and there are eleven people in it who are
written down as agricultural plant. Your Warden's card says nineteen crossings and thirty-one hundredths;
your physician wrote that number and does not believe it. You are Yevet Drun, the bond has your name on
it, and every way out of this costs somebody something you will have to watch.`,
      playerCharacterId: 'char:yevet-drun',
      openingLocationId: 'loc:the-deferred-grace',
      openingScene: 'The inspection is at the second bell',
      focus: {
        'char:yevet-drun': 'focal',
        'char:corin-sorge': 'focal',
        'char:ottilie-brask': 'focal',
        'char:dov-cheveny': 'focal',
        'char:teodor-halb': 'focal',
        'item:the-cold-freight': 'focal',
        'item:the-manifest': 'focal',
        'loc:the-cold-hold': 'focal',
        'loc:the-deferred-grace': 'focal',
        'char:hanne-wole': 'principal',
        'char:anaya-rask': 'principal',
        'char:anders-pell': 'principal',
        'char:yseult-marek': 'principal',
        'char:bastian-ferrick': 'principal',
        'char:ysolde-tarr': 'principal',
        'concept:drift': 'principal',
        'concept:the-hull-bond': 'principal',
        'item:corins-card': 'principal',
        'char:marit-odiah': 'supporting',
        'char:salt-nine': 'supporting',
        'char:hessa-vantch': 'supporting',
        'char:kalo-isang': 'supporting',
        'char:ilya-naut': 'supporting',
        'char:orla-vend': 'supporting',
        'char:wren-sorge': 'background',
        'char:warmth-two': 'background',
        'loc:the-shear': 'background',
      },
      conditions: [
        {
          entityId: 'char:yevet-drun',
          locationId: 'loc:the-deferred-grace',
          mood: 'contained',
          inventory: ['the endorsed counterpart of the bond', "Pell's slot schedule"],
          intent: 'get a slot and get through the inspection without the hold being opened',
        },
        {
          entityId: 'char:corin-sorge',
          locationId: 'loc:the-deferred-grace',
          mood: 'careful',
          intent: 'be measured before anyone thinks to measure him twice',
        },
        {
          entityId: 'char:teodor-halb',
          locationId: 'loc:the-deferred-grace',
          mood: 'keyed up',
          intent: 'be offered the crossing',
        },
        {
          entityId: 'char:hanne-wole',
          locationId: 'loc:the-deferred-grace',
          mood: 'grim',
          intent: 'refuse to write the number a fourth time',
        },
        {
          entityId: 'char:anaya-rask',
          locationId: 'loc:the-deferred-grace',
          mood: 'preoccupied',
          intent: 'get the ninth tier sealing or condemn it out loud',
        },
        {
          entityId: 'char:dov-cheveny',
          locationId: 'loc:the-deferred-grace',
          mood: 'helpful',
          intent: 'be somewhere else when the hold is opened',
        },
        { entityId: 'char:marit-odiah', locationId: 'loc:the-deferred-grace', mood: 'distracted' },
        {
          entityId: 'char:salt-nine',
          locationId: 'loc:the-cold-hold',
          mood: 'cold',
          intent: 'keep the charter figure at temperature',
        },
        { entityId: 'char:orla-vend', locationId: 'loc:the-cold-hold', mood: 'frightened and quiet' },
        {
          entityId: 'char:ottilie-brask',
          locationId: 'loc:the-toll-shed',
          mood: 'unhurried',
          intent: 'open the cold hold at the second bell',
        },
        {
          entityId: 'char:anders-pell',
          locationId: 'loc:winnow-station',
          mood: 'affable',
          intent: 'sell the last three slots high',
        },
        {
          entityId: 'char:yseult-marek',
          locationId: 'loc:winnow-station',
          mood: 'exact',
          intent: "measure the Grace's Warden before entry",
        },
        {
          entityId: 'char:ysolde-tarr',
          locationId: 'loc:winnow-station',
          mood: 'charming',
          intent: 'get Drun to trade her slot away',
        },
        { entityId: 'char:ilya-naut', locationId: 'loc:winnow-station', mood: 'busy' },
        { entityId: 'char:hollis-fen', locationId: 'loc:the-lamp', mood: 'talkative' },
        { entityId: 'char:hessa-vantch', locationId: 'loc:the-breaker-fields', mood: 'patient' },
        { entityId: 'char:kalo-isang', locationId: 'loc:the-slack', mood: 'vague' },
        { entityId: 'char:nim-baptiste', locationId: 'loc:the-slack', mood: 'open for business' },
        {
          entityId: 'char:bastian-ferrick',
          locationId: 'loc:the-assize-floor',
          mood: 'courteous',
          intent: 'let the ninth arrive',
        },
        { entityId: 'char:ilva-ovist', locationId: 'loc:the-assize-floor', mood: 'impersonal' },
        { entityId: 'char:sennet-halb', locationId: 'loc:the-measuring-room', mood: 'tired' },
        { entityId: 'char:wren-sorge', locationId: 'loc:candlewell', mood: 'unknown' },
      ],
      relationships: [
        {
          from: 'char:yevet-drun',
          to: 'char:corin-sorge',
          trust: 0.8,
          affection: 0.5,
          respect: 0.9,
          note: 'the reason the hull still earns, and she has stopped looking at him closely',
        },
        {
          from: 'char:corin-sorge',
          to: 'char:yevet-drun',
          trust: 0.6,
          affection: 0.4,
          respect: 0.7,
          note: 'would cross for her past the point where it is a choice',
        },
        {
          from: 'char:yevet-drun',
          to: 'char:teodor-halb',
          trust: 0.4,
          affection: 0.5,
          respect: 0.2,
          note: 'the answer she does not want to have available',
        },
        {
          from: 'char:teodor-halb',
          to: 'char:yevet-drun',
          trust: 0.8,
          affection: 0.4,
          respect: 0.9,
          note: 'waiting to be asked, and rehearsing the yes',
        },
        {
          from: 'char:teodor-halb',
          to: 'char:corin-sorge',
          trust: 0.5,
          affection: 0.3,
          respect: 0.9,
          note: 'admires him and is counting his crossings',
        },
        {
          from: 'char:corin-sorge',
          to: 'char:teodor-halb',
          trust: 0.6,
          affection: 0.5,
          respect: 0.3,
          note: 'a boy he is teaching to replace him, which he has not said',
        },
        {
          from: 'char:hanne-wole',
          to: 'char:corin-sorge',
          trust: 0.7,
          affection: 0.8,
          respect: 0.6,
          note: 'has lied on paper three times to keep him aboard',
        },
        {
          from: 'char:corin-sorge',
          to: 'char:hanne-wole',
          trust: 0.9,
          affection: 0.6,
          respect: 0.7,
          note: 'the only person he has told about the missing hours',
        },
        {
          from: 'char:hanne-wole',
          to: 'char:yevet-drun',
          trust: 0.3,
          affection: 0.2,
          respect: 0.5,
          note: 'suspects the captain prefers not to be told',
        },
        {
          from: 'char:yevet-drun',
          to: 'char:hanne-wole',
          trust: 0.6,
          affection: 0.3,
          respect: 0.7,
          note: 'relies on her and has never asked how the numbers hold',
        },
        {
          from: 'char:dov-cheveny',
          to: 'char:yevet-drun',
          trust: -0.3,
          affection: -0.1,
          respect: 0.4,
          note: 'competent, doomed, and worth reporting on',
        },
        {
          from: 'char:yevet-drun',
          to: 'char:dov-cheveny',
          trust: -0.2,
          affection: -0.3,
          respect: 0.3,
          note: 'writes a clean manifest and something else besides',
        },
        {
          from: 'char:ottilie-brask',
          to: 'char:yevet-drun',
          trust: -0.4,
          affection: 0.1,
          respect: 0.5,
          note: 'four hundred tonnes she cannot account for, and no wish to be lied to',
        },
        {
          from: 'char:yevet-drun',
          to: 'char:ottilie-brask',
          trust: 0.1,
          affection: -0.2,
          respect: 0.7,
          note: 'cannot be bought, which at least simplifies it',
        },
        {
          from: 'char:bastian-ferrick',
          to: 'char:yevet-drun',
          trust: 0.2,
          affection: 0.1,
          respect: 0.6,
          note: 'hopes she fails and will be gracious about it',
        },
        {
          from: 'char:yevet-drun',
          to: 'char:bastian-ferrick',
          trust: -0.6,
          affection: -0.5,
          respect: 0.4,
          note: 'has read the instrument properly and knows what he is waiting for',
        },
        {
          from: 'char:ysolde-tarr',
          to: 'char:yevet-drun',
          trust: 0.4,
          affection: 0.6,
          respect: 0.6,
          note: 'genuinely fond, and will still take the slot',
        },
        {
          from: 'char:yevet-drun',
          to: 'char:ysolde-tarr',
          trust: -0.1,
          affection: 0.3,
          respect: 0.5,
          note: 'the pleasantness is the negotiation',
        },
        {
          from: 'char:anaya-rask',
          to: 'char:yevet-drun',
          trust: 0.7,
          affection: 0.4,
          respect: 0.6,
          note: 'will tell her about the ninth tier once and then let it be her problem',
        },
        {
          from: 'char:yseult-marek',
          to: 'char:corin-sorge',
          trust: -0.2,
          affection: 0.0,
          respect: 0.4,
          note: 'the numbers on his card do not sit right and she has flagged it',
        },
        {
          from: 'char:salt-nine',
          to: 'char:corin-sorge',
          trust: 0.3,
          affection: 0.4,
          respect: 0.5,
          note: 'can smell what his card denies and has said nothing',
        },
        {
          from: 'char:orla-vend',
          to: 'char:yevet-drun',
          trust: 0.5,
          affection: 0.1,
          respect: 0.2,
          note: 'paid her everything and has no other option left',
        },
      ],
      facts: [
        {
          text: 'the eleven sealed tiers in the cold hold contain living people and are entered on the manifest as agricultural plant',
          knows: [
            'char:yevet-drun',
            'char:dov-cheveny',
            'char:anaya-rask',
            'char:hessa-vantch',
            'char:orla-vend',
            'char:salt-nine',
          ],
          suspects: ['char:ottilie-brask', 'char:hanne-wole'],
        },
        {
          text: "Corin Sorge's true drift is thirty-eight hundredths and Wole has entered thirty-one for three crossings running",
          knows: ['char:hanne-wole', 'char:salt-nine'],
          suspects: ['char:yseult-marek', 'char:teodor-halb', 'char:sennet-halb'],
          wrong: ['char:yevet-drun'],
        },
        {
          text: 'Cheveny has left a letter at the Lamp describing the cold hold, addressed to Bastian Ferrick',
          knows: ['char:dov-cheveny', 'char:hollis-fen'],
          suspects: ['char:hanne-wole'],
        },
        {
          text: 'Ferrick has a buyer for the Grace at nearly twice the debt and intends to let the ninth pass',
          knows: ['char:bastian-ferrick'],
          suspects: ['char:hessa-vantch', 'char:ilva-ovist'],
          wrong: ['char:yevet-drun'],
        },
        {
          text: 'the ninth freight tier seals but does not hold, so whoever rides it stays conscious for the whole crossing',
          knows: ['char:anaya-rask', 'char:orla-vend'],
          suspects: ['char:corin-sorge'],
        },
      ],
      threads: [
        {
          title: 'The inspection of the cold hold',
          stakes: "eleven people, the master's ticket, and whether the Grace crosses at all",
          tension: 0.85,
          parties: ['char:ottilie-brask', 'char:yevet-drun', 'char:dov-cheveny', 'char:anaya-rask'],
          resolutions: [
            'the hold is opened and the eleven are found',
            'the manifest is amended before the second bell and the duty paid',
            'Brask is given a procedural reason to defer past the reversal',
            'the eleven are moved to the Slack and the passage money returned',
            'Cheveny produces the discrepancy himself and is believed',
          ],
        },
        {
          title: 'Whose card goes on the crossing',
          stakes: 'a Warden at thirty-eight hundredths, or a boy at four',
          tension: 0.8,
          parties: ['char:yevet-drun', 'char:corin-sorge', 'char:teodor-halb', 'char:hanne-wole', 'char:yseult-marek'],
          resolutions: [
            'Corin crosses on the understated card',
            'Teodor is given the station and holds it',
            'Wole writes the true number and Marek strikes Corin at the mouth',
            'a blank card is bought at the Slack and stamped',
            'nobody crosses and the reversal closes the route',
          ],
        },
        {
          title: 'Nine slots, eleven captains',
          stakes: 'the last passage before the Marrow turns for eleven years',
          tension: 0.6,
          parties: ['char:anders-pell', 'char:yevet-drun', 'char:ysolde-tarr', 'char:ilya-naut'],
          resolutions: [
            'Drun pays Pell above the schedule',
            'Tarr is given the slot and owes Drun the favour',
            'Naut sells a slot that turns out not to exist',
            'the Grace goes without a slot and answers for it at the Sill',
          ],
        },
        {
          title: 'What Ferrick is waiting for',
          stakes: 'a hull worth nine, a debt of eleven, and a buyer at seventeen',
          tension: 0.55,
          parties: ['char:bastian-ferrick', 'char:yevet-drun', 'char:hessa-vantch', 'char:ilva-ovist'],
          resolutions: [
            'the payment lands on the ninth and the position closes',
            'the Grace is condemned on the Assize Floor',
            "Vantch outbids the Trust's buyer and takes the paper instead of the hull",
            'Ovist refuses to certify the condemnation and the matter goes to review',
          ],
        },
      ],
      style: { register: 'clipped', pacing: 'steady', density: 'balanced', dialogueRatio: 0.45 },
      anchor: {
        text: 'She read the clause twice. It did not say seize, and it did not have to; it only had to say the ninth.',
        note: 'commercial, dry, a woman reading a document that is going to win',
      },
    },

    // ------------------------------------------------------------------ two
    // The Warden, three weeks into eleven. Every other person aboard is placed
    // at the ship's id and unconscious, so `presentIds` returns exactly one
    // character at the station: him. The crew are one door away and off-stage,
    // which is precisely the thing the presence model does well and precisely
    // what this scenario is about. The only other voice is on a circuit.
    {
      id: 'the-holding',
      title: 'The Holding',
      premise: `Twenty-two days into an eleven-week fall. The crew are under in their tiers, one door away and
as far off as anyone has ever been. You are Corin Sorge, you are sealed in the station because that is
what a Warden is for, and you have already lost three hours you cannot account for. The ninth freight
tier did not hold. There is a woman awake in the cold hold, she is Candlewell-born and knew your
daughter, and the draw is taking her the way it takes Wardens with no seat to hold her. No word leaves
this hull for eight more weeks. Whatever you decide, you decide it alone and nobody finds out until it
is finished.`,
      playerCharacterId: 'char:corin-sorge',
      openingLocationId: 'loc:the-warden-station',
      openingScene: 'Day twenty-two, and something in the hold is talking',
      focus: {
        'char:corin-sorge': 'focal',
        'char:orla-vend': 'focal',
        'loc:the-warden-station': 'focal',
        'loc:the-cold-hold': 'focal',
        'loc:the-marrow-draw': 'focal',
        'item:the-ninth-tier': 'focal',
        'concept:the-sleep': 'focal',
        'concept:drift': 'focal',
        'concept:no-word-outruns-a-ship': 'focal',
        'char:wren-sorge': 'principal',
        'char:hanne-wole': 'principal',
        'char:yevet-drun': 'principal',
        'char:salt-nine': 'principal',
        'item:corins-card': 'principal',
        'item:the-charter-figure': 'principal',
        'concept:the-warden': 'principal',
        'loc:the-deferred-grace': 'principal',
        'char:teodor-halb': 'supporting',
        'char:anaya-rask': 'supporting',
        'char:kalo-isang': 'supporting',
        'loc:candlewell': 'supporting',
        'loc:the-shear': 'supporting',
        'char:marit-odiah': 'background',
        'char:dov-cheveny': 'background',
        'char:warmth-two': 'background',
      },
      conditions: [
        {
          entityId: 'char:corin-sorge',
          locationId: 'loc:the-warden-station',
          mood: 'holding',
          injuries: ['thirty-eight hundredths replaced', 'three hours of the last crossing missing'],
          inventory: ['his card', 'a day-count scratched into the seat frame', 'eleven letters for Candlewell'],
          intent: 'bring the ship out at eleven weeks with everyone aboard still themselves',
        },
        // The one other conscious person aboard, and behind a door. She reaches
        // him on the hold circuit, which is the only reason this is a scene at all.
        {
          entityId: 'char:orla-vend',
          locationId: 'loc:the-cold-hold',
          mood: 'lucid and getting worse',
          injuries: ['awake inside a draw for twenty-two days', 'a right hand that has stopped matching the left'],
          intent: 'stay talking, because the talking is the part that is still her',
        },
        // Everyone else: at the ship's own id, under. Off-stage by exact match,
        // reduced to thumbnails, and unreachable without waking them.
        { entityId: 'char:yevet-drun', locationId: 'loc:the-deferred-grace', mood: 'under' },
        { entityId: 'char:teodor-halb', locationId: 'loc:the-deferred-grace', mood: 'under' },
        { entityId: 'char:anaya-rask', locationId: 'loc:the-deferred-grace', mood: 'under' },
        { entityId: 'char:hanne-wole', locationId: 'loc:the-deferred-grace', mood: 'under' },
        { entityId: 'char:marit-odiah', locationId: 'loc:the-deferred-grace', mood: 'under' },
        { entityId: 'char:dov-cheveny', locationId: 'loc:the-deferred-grace', mood: 'under' },
        {
          entityId: 'char:salt-nine',
          locationId: 'loc:the-deferred-grace',
          mood: 'under',
          intent: 'nothing; she cannot tend the figure from inside a tier',
        },
        { entityId: 'char:wren-sorge', locationId: 'loc:candlewell', mood: 'unknown' },
        { entityId: 'char:kalo-isang', locationId: 'loc:the-slack', mood: 'vague' },
        { entityId: 'char:yseult-marek', locationId: 'loc:winnow-station', mood: 'waiting on a ledger review' },
        { entityId: 'char:warmth-two', locationId: 'loc:the-sill', mood: 'unaware of any of it' },
      ],
      relationships: [
        {
          from: 'char:corin-sorge',
          to: 'char:orla-vend',
          trust: 0.4,
          affection: 0.6,
          respect: 0.5,
          note: 'the only news of his daughter in nine years, dying in his hold',
        },
        {
          from: 'char:orla-vend',
          to: 'char:corin-sorge',
          trust: 0.8,
          affection: 0.5,
          respect: 0.4,
          note: 'the only voice, and the only door',
        },
        {
          from: 'char:corin-sorge',
          to: 'char:wren-sorge',
          trust: 0.9,
          affection: 1.0,
          respect: 0.6,
          note: 'fourteen, two years behind a draw, and the reason for every crossing',
        },
        {
          from: 'char:orla-vend',
          to: 'char:wren-sorge',
          trust: 0.4,
          affection: 0.5,
          respect: 0.3,
          note: 'they were children together for a year before the reversal',
        },
        {
          from: 'char:corin-sorge',
          to: 'char:hanne-wole',
          trust: 0.9,
          affection: 0.6,
          respect: 0.7,
          note: 'asleep, and the only person who would know what to do',
        },
        {
          from: 'char:hanne-wole',
          to: 'char:corin-sorge',
          trust: 0.7,
          affection: 0.8,
          respect: 0.6,
          note: 'left him a sealed note in the station and has not said what is in it',
        },
        {
          from: 'char:corin-sorge',
          to: 'char:yevet-drun',
          trust: 0.6,
          affection: 0.4,
          respect: 0.7,
          note: 'she gave the order and is not available to amend it',
        },
        {
          from: 'char:yevet-drun',
          to: 'char:corin-sorge',
          trust: 0.8,
          affection: 0.5,
          respect: 0.9,
          note: 'will find out in eight weeks what her Warden decided',
        },
        {
          from: 'char:corin-sorge',
          to: 'char:salt-nine',
          trust: 0.5,
          affection: 0.3,
          respect: 0.6,
          note: 'the charter is failing in the hold and she is in a tier',
        },
        {
          from: 'char:salt-nine',
          to: 'char:corin-sorge',
          trust: 0.3,
          affection: 0.4,
          respect: 0.5,
          note: 'knows his real number and went under without saying it',
        },
        {
          from: 'char:corin-sorge',
          to: 'char:teodor-halb',
          trust: 0.6,
          affection: 0.5,
          respect: 0.3,
          note: 'could be woken and could hold the seat, at the cost of starting his own count',
        },
        {
          from: 'char:teodor-halb',
          to: 'char:corin-sorge',
          trust: 0.5,
          affection: 0.3,
          respect: 0.9,
          note: 'would say yes before the tier was fully open',
        },
        {
          from: 'char:kalo-isang',
          to: 'char:corin-sorge',
          trust: 0.6,
          affection: 0.5,
          respect: 0.4,
          note: 'told him at the Slack exactly how this part goes',
        },
        {
          from: 'char:corin-sorge',
          to: 'char:kalo-isang',
          trust: 0.3,
          affection: -0.2,
          respect: 0.2,
          note: 'a demonstration he did not want and now cannot stop consulting',
        },
      ],
      facts: [
        {
          text: 'Orla Vend is awake in the cold hold and the draw has been taking her for twenty-two days',
          knows: ['char:corin-sorge', 'char:orla-vend'],
          suspects: ['char:anaya-rask'],
        },
        {
          text: 'no word leaves the Grace for eight more weeks, so nobody outside the hull can learn any of this in time to change it',
          knows: ['char:corin-sorge', 'char:orla-vend', 'char:yevet-drun', 'char:hanne-wole', 'char:kalo-isang'],
        },
        {
          text: 'Corin lost three hours of the nineteenth crossing and does not know what he did in them',
          knows: ['char:corin-sorge', 'char:hanne-wole'],
          suspects: ['char:salt-nine', 'char:kalo-isang'],
        },
        {
          text: 'waking a sleeper inside a draw makes a second conscious mind in the current, and nobody who has done it has come back able to describe it',
          knows: ['char:corin-sorge', 'char:kalo-isang'],
          suspects: ['char:hanne-wole', 'char:orla-vend'],
        },
        {
          text: 'Wren Sorge was alive on Candlewell nine years ago and Orla Vend is the last person aboard who saw her',
          knows: ['char:orla-vend'],
          suspects: ['char:corin-sorge'],
        },
        {
          text: 'the charter figure is failing in the hold and only Salt Nine can hold it at temperature',
          knows: ['char:salt-nine'],
          suspects: ['char:corin-sorge', 'char:marit-odiah'],
        },
      ],
      threads: [
        {
          title: 'The woman in the ninth tier',
          stakes: 'her mind, and whether he opens a door he has sworn not to open',
          tension: 0.9,
          parties: ['char:corin-sorge', 'char:orla-vend'],
          resolutions: [
            'he keeps her talking for eight more weeks and she arrives as something',
            'he seals the hold circuit and lets it be quiet',
            'he brings her into the station and shares the seat',
            'he wakes Wole to take her out of it medically',
            'she stops answering and he does not know when it happened',
          ],
        },
        {
          title: 'Whether anyone else is woken',
          stakes: 'a second conscious mind in the current, and the vow he has kept nineteen times',
          tension: 0.8,
          parties: ['char:corin-sorge', 'char:teodor-halb', 'char:hanne-wole', 'char:salt-nine'],
          resolutions: [
            'nobody is woken and he holds the whole eleven weeks alone',
            'Teodor is woken and takes the seat, starting his own count',
            'Wole is woken for the hold and goes back under',
            'Salt Nine is woken to save the charter and loses her own standing by crossing awake',
            'he wakes someone and cannot afterwards say why',
          ],
        },
        {
          title: 'The count, kept out loud',
          stakes: 'the three hours he already lost, and whether he notices the next ones',
          tension: 0.7,
          parties: ['char:corin-sorge', 'char:orla-vend', 'char:kalo-isang'],
          resolutions: [
            'he arrives with the count intact and the log matching it',
            'the log and the count disagree and he trusts the log',
            'he finds work done in the station he has no memory of doing',
            'he stops keeping the count because keeping it has become the frightening part',
          ],
        },
        {
          title: 'Eleven letters for Candlewell',
          stakes: 'nine years of not knowing, and a mouth that opens in two',
          tension: 0.45,
          parties: ['char:corin-sorge', 'char:wren-sorge', 'char:orla-vend'],
          resolutions: [
            'he writes the twelfth letter and leaves the sack for the Ossick',
            'Orla tells him something that makes the letters unsendable',
            'he burns them and keeps crossing anyway',
            'he gives them to Orla to carry, on the assumption she outlasts him',
          ],
        },
      ],
      style: {
        pov: 'third-limited',
        register: 'plain',
        density: 'sparse',
        pacing: 'languid',
        dialogueRatio: 0.2,
        sceneTarget: 320,
      },
      anchor: {
        text: 'Day twenty-two. He said it aloud, because the saying was the count and the count was the part that went first.',
        note: 'sparse, present-tense attention, one man and a number',
      },
    },

    // ---------------------------------------------------------------- three
    // The interpreter, at the far end. The Semne rule and the human rule are
    // both internally consistent and cannot both be applied, which is the whole
    // scenario: nobody here is lying and nothing can be agreed.
    {
      id: 'the-unchanged-body',
      title: 'The Unchanged Body',
      premise: `The Grace made the Sill. The charter figure made it too, alive, and four degrees down from what it
was at the mouth — and to the Quorum a promise is carried in a body, so a figure that changed in transit
is not the promise that was made. Warmth Two is not refusing the charter; he is explaining that there has
never been one. Ash Eleven intends to establish that on the record, for every human hull, permanently. The
only person who could grow a replacement is Salt Nine, whose promises the Quorum voided years ago, and the
only person who can read the original is a witness whose body has been holding it for nine years and is
beginning to fail. You are Marit Odiah. You are the ship's mouth, and everything you say at this hearing is
said by somebody the room does not consider a speaker.`,
      playerCharacterId: 'char:marit-odiah',
      openingLocationId: 'loc:the-figure-garden',
      openingScene: 'Four degrees down',
      focus: {
        'char:marit-odiah': 'focal',
        'char:salt-nine': 'focal',
        'char:warmth-two': 'focal',
        'char:ash-eleven': 'focal',
        'char:ash-three': 'focal',
        'item:the-charter-figure': 'focal',
        'concept:the-unchanged-body': 'focal',
        'concept:figures': 'focal',
        'loc:the-figure-garden': 'focal',
        'loc:the-sill': 'focal',
        'char:yevet-drun': 'principal',
        'char:corin-sorge': 'principal',
        'char:warmth-seven': 'principal',
        'item:the-grown-name': 'principal',
        'concept:drift': 'principal',
        'concept:no-word-outruns-a-ship': 'principal',
        'loc:the-deferred-grace': 'principal',
        'char:orla-vend': 'supporting',
        'char:hanne-wole': 'supporting',
        'char:dov-cheveny': 'supporting',
        'char:bastian-ferrick': 'supporting',
        'char:ottilie-brask': 'background',
        'char:wren-sorge': 'background',
        'loc:ellim': 'background',
        'loc:lowmarch': 'background',
      },
      conditions: [
        {
          entityId: 'char:marit-odiah',
          locationId: 'loc:the-figure-garden',
          mood: 'clear-eyed and out of options',
          inventory: ['her reading kit', 'the mouth-side temperature record of the charter figure'],
          intent: 'get the charter admitted, or get the Grace admitted without one',
        },
        {
          entityId: 'char:salt-nine',
          locationId: 'loc:the-figure-garden',
          mood: 'cold and very careful',
          intent: 'keep the figure alive without being asked to swear for it',
        },
        {
          entityId: 'char:ash-three',
          locationId: 'loc:the-figure-garden',
          mood: 'failing',
          intent: 'hold the charter state long enough to be read once more',
        },
        {
          entityId: 'char:warmth-seven',
          locationId: 'loc:the-figure-garden',
          mood: 'running hot',
          intent: 'help, and void something else in the attempt',
        },
        {
          entityId: 'char:warmth-two',
          locationId: 'loc:the-sill',
          mood: 'settled',
          intent: 'record that the charter was never valid',
        },
        {
          entityId: 'char:ash-eleven',
          locationId: 'loc:the-sill',
          mood: 'pleased with the case',
          intent: 'establish the transit rule as general precedent',
        },
        {
          entityId: 'char:yevet-drun',
          locationId: 'loc:the-deferred-grace',
          mood: 'holding her temper',
          intent: 'be admitted, unload, and be back through before the reversal',
        },
        {
          entityId: 'char:corin-sorge',
          locationId: 'loc:the-deferred-grace',
          mood: 'thin',
          injuries: ['eleven weeks held', 'forty-one hundredths and no longer deniable'],
          intent: 'not be measured at the Sill',
        },
        { entityId: 'char:orla-vend', locationId: 'loc:the-deferred-grace', mood: 'arrived, and not entirely' },
        { entityId: 'char:hanne-wole', locationId: 'loc:the-deferred-grace', mood: 'out of lies' },
        { entityId: 'char:dov-cheveny', locationId: 'loc:the-deferred-grace', mood: 'packing' },
        {
          entityId: 'char:anaya-rask',
          locationId: 'loc:the-deferred-grace',
          mood: 'stripping the ninth tier for evidence',
        },
        { entityId: 'char:teodor-halb', locationId: 'loc:the-deferred-grace', mood: 'shaken' },
        {
          entityId: 'char:bastian-ferrick',
          locationId: 'loc:the-assize-floor',
          mood: 'unaware, for another nine weeks',
        },
        { entityId: 'char:ottilie-brask', locationId: 'loc:the-toll-shed', mood: 'still writing up the inspection' },
      ],
      relationships: [
        {
          from: 'char:marit-odiah',
          to: 'char:salt-nine',
          trust: 0.9,
          affection: 0.8,
          respect: 0.9,
          note: 'her voice, and the person the room will not hear',
        },
        {
          from: 'char:salt-nine',
          to: 'char:marit-odiah',
          trust: 0.7,
          affection: 0.6,
          respect: 0.8,
          note: 'the only human who has never asked her to promise anything',
        },
        {
          from: 'char:marit-odiah',
          to: 'char:warmth-two',
          trust: 0.2,
          affection: -0.3,
          respect: 0.8,
          note: 'entirely honest, entirely immovable, and correct',
        },
        {
          from: 'char:warmth-two',
          to: 'char:marit-odiah',
          trust: 0.5,
          affection: 0.0,
          respect: 0.4,
          note: 'a competent reader speaking for an invalid promiser',
        },
        {
          from: 'char:marit-odiah',
          to: 'char:ash-eleven',
          trust: -0.3,
          affection: -0.2,
          respect: 0.9,
          note: 'he is two questions ahead and she can feel it',
        },
        {
          from: 'char:ash-eleven',
          to: 'char:marit-odiah',
          trust: 0.3,
          affection: 0.3,
          respect: 0.7,
          note: 'the best human reader he has met, which is why he wants her on the record',
        },
        {
          from: 'char:marit-odiah',
          to: 'char:ash-three',
          trust: 0.8,
          affection: 0.7,
          respect: 0.9,
          note: 'nine years of one promise, and it is killing her',
        },
        {
          from: 'char:ash-three',
          to: 'char:marit-odiah',
          trust: 0.6,
          affection: 0.4,
          respect: 0.5,
          note: 'writes to her because writing costs less than speaking',
        },
        {
          from: 'char:ash-eleven',
          to: 'char:ash-three',
          trust: 0.7,
          affection: 0.4,
          respect: 0.6,
          note: 'his best evidence, and he will spend her to get the ruling',
        },
        {
          from: 'char:warmth-two',
          to: 'char:salt-nine',
          trust: -0.7,
          affection: -0.4,
          respect: 0.1,
          note: "a body wearing another body's obligations",
        },
        {
          from: 'char:salt-nine',
          to: 'char:warmth-two',
          trust: -0.5,
          affection: -0.6,
          respect: 0.5,
          note: 'applies the rule she would have applied, before the fire',
        },
        {
          from: 'char:warmth-seven',
          to: 'char:marit-odiah',
          trust: 0.8,
          affection: 0.7,
          respect: 0.5,
          note: 'wants to be useful and is dangerous to be near in a hearing',
        },
        {
          from: 'char:marit-odiah',
          to: 'char:warmth-seven',
          trust: 0.3,
          affection: 0.5,
          respect: 0.2,
          note: 'a liability she is fond of',
        },
        {
          from: 'char:yevet-drun',
          to: 'char:marit-odiah',
          trust: 0.7,
          affection: 0.4,
          respect: 0.8,
          note: 'will back her reading right up to the point it condemns the hull',
        },
        {
          from: 'char:marit-odiah',
          to: 'char:yevet-drun',
          trust: 0.5,
          affection: 0.3,
          respect: 0.6,
          note: 'knows exactly where that point is',
        },
        {
          from: 'char:corin-sorge',
          to: 'char:marit-odiah',
          trust: 0.6,
          affection: 0.3,
          respect: 0.6,
          note: 'she is the one arguing that a changed body still counts',
        },
        {
          from: 'char:marit-odiah',
          to: 'char:corin-sorge',
          trust: 0.6,
          affection: 0.5,
          respect: 0.7,
          note: 'the human case for her own argument, standing there at forty-one hundredths',
        },
      ],
      facts: [
        {
          text: 'the charter figure arrived four degrees down from its state at the mouth, so under the Unchanged Body it is not the promise that was made',
          knows: ['char:marit-odiah', 'char:salt-nine', 'char:warmth-two', 'char:ash-eleven', 'char:ash-three'],
          suspects: ['char:yevet-drun'],
        },
        {
          text: 'no Semne promise has ever survived a draw, and the Quorum has known this for two centuries without telling a human',
          knows: ['char:warmth-two', 'char:ash-eleven', 'char:ash-three', 'char:salt-nine'],
          suspects: ['char:marit-odiah'],
          wrong: ['char:yevet-drun', 'char:bastian-ferrick', 'char:ottilie-brask'],
        },
        {
          text: 'Ash Eleven privately believes the transit rule is indefensible and intends to win the hearing with it regardless',
          knows: ['char:ash-eleven'],
          suspects: ['char:marit-odiah', 'char:salt-nine'],
        },
        {
          text: "Corin Sorge is at forty-one hundredths, past the Roll's limit, and signed the Grace's entry declaration at the mouth eleven weeks ago",
          knows: ['char:corin-sorge', 'char:hanne-wole', 'char:salt-nine', 'char:marit-odiah'],
          suspects: ['char:warmth-two', 'char:yevet-drun'],
        },
        {
          text: 'Ash Three cannot hold the charter state for more than a few more days without losing it entirely',
          knows: ['char:ash-three', 'char:ash-eleven'],
          suspects: ['char:marit-odiah', 'char:salt-nine'],
          wrong: ['char:warmth-two'],
        },
        {
          text: 'Salt Nine could grow a replacement charter figure that would read as valid, and it would be a forgery under both bodies of law',
          knows: ['char:salt-nine', 'char:marit-odiah'],
          suspects: ['char:ash-eleven'],
        },
      ],
      threads: [
        {
          title: 'Whether the charter was ever valid',
          stakes: 'entry at the Sill for the Grace, and precedent for every human hull after her',
          tension: 0.85,
          parties: ['char:marit-odiah', 'char:warmth-two', 'char:ash-eleven', 'char:ash-three', 'char:yevet-drun'],
          resolutions: [
            'Ash Three is read once more and the original state is entered as witnessed',
            'the charter is ruled void and the rule becomes general precedent',
            'a new charter is negotiated at the Sill from nothing, on Semne terms',
            'Salt Nine grows a replacement and it is accepted',
            'Salt Nine grows a replacement and Warmth Two reads the forgery',
            'the Grace is refused and turns for the Marrow before it reverses',
          ],
        },
        {
          title: 'Who is allowed to be a speaker',
          stakes: "Salt Nine's standing, and whether a voided promiser can be heard at all",
          tension: 0.8,
          parties: ['char:salt-nine', 'char:warmth-two', 'char:ash-eleven', 'char:marit-odiah'],
          resolutions: [
            'Salt Nine is re-witnessed and her standing restored in part',
            'she is detained at the Sill as a false promiser',
            'Marit speaks in her own right and the Quorum accepts a human as promiser',
            'she leaves the figure and the hearing and goes back aboard voided',
            'the Quorum rules her a new person with no obligations, which is worse',
          ],
        },
        {
          title: 'The Warden who signed at the mouth',
          stakes: "Corin's card, the entry declaration, and a rule that says he is not the man who signed it",
          tension: 0.7,
          parties: ['char:corin-sorge', 'char:warmth-two', 'char:marit-odiah', 'char:hanne-wole'],
          resolutions: [
            'the declaration is re-sworn by someone who has not crossed awake',
            'Warmth Two measures Corin and voids the entry as well as the charter',
            'the true drift figure is entered honestly and the Roll deals with it later',
            'Corin is kept off the Sill entirely and never measured',
          ],
        },
        {
          title: 'What Warmth Seven has already promised',
          stakes: 'a young Semne one bad tense away from being a habitual false promiser',
          tension: 0.5,
          parties: ['char:warmth-seven', 'char:marit-odiah', 'char:ash-eleven', 'char:warmth-two'],
          resolutions: [
            'Marit unpicks the promise before it is entered',
            'Warmth Seven testifies and voids herself doing it',
            'Ash Eleven trades her standing for the ruling he wants',
            'she is put back in the garden and told not to speak human again',
          ],
        },
      ],
      style: { register: 'plain', density: 'balanced', pacing: 'steady', dialogueRatio: 0.55, humor: 'dry' },
      anchor: {
        text: 'She put the back of her hand against the case and read it the way she had been taught: heat first, then salt, then the meaning, which was that nothing had been agreed.',
        note: 'technical, restrained, a specialist being precise about a catastrophe',
      },
    },
  ],
};
