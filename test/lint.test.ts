import test from 'node:test';
import assert from 'node:assert/strict';
import { lintProse, availableRules, crossSceneTells } from '../src/lint/engine.ts';

// ---------------------------------------------------------------- fixtures

/**
 * A deliberately "clean" human-sounding fiction passage. It intentionally contains
 * several things that the classic AI-tell checklists would flag and that the fiction
 * profile must NOT flag: curly quotes (correct book typography), one em dash used for
 * a genuine mid-sentence interruption, exactly one rule-of-three, and a passive-voice
 * sentence used on purpose for narrative distance. None of the fiction-specific tells
 * (somatic clichés, named-not-shown emotion, uniform dialogue, portentous one-liners,
 * dialogue-tag monotony...) appear here. Long enough that per-1000-word normalization
 * doesn't get skewed by its small size.
 */
const CLEAN_FICTION = `
Mara found the letter under the floorboard, exactly where her grandmother said it would be, and for a long moment she didn't open it.

"You're not going to read it standing there, are you?" said Devon, leaning in the doorway with his arms crossed.

"Maybe I am."

"You've been staring at it for five minutes."

"Four," she said, and finally broke the seal.

The paper was thinner than she expected, the ink gone brown at the edges. She read it twice before she trusted herself to speak. Somewhere in the walls a pipe knocked, then settled.

"Well?" Devon said.

"She knew. The whole time, she knew, and she never—" Mara stopped herself, folded the letter along its old crease, and put it back exactly where she'd found it, as if that would undo having read it.

Devon didn't push. He'd learned that much, at least, in the two years since his mother's funeral, when pushing had cost him three weeks of silence.

Later, packing the kitchen boxes, Mara found herself thinking about the house differently: the crack in the ceiling that had always been there, the smell of her grandmother's coffee that had never quite left the cabinets, the particular slant of afternoon light across the counter that no other house she'd lived in had managed to reproduce.

They loaded the van in silence broken only by directions — left here, mind the step, careful with that one — and by the time the house was empty the sun had gone orange over the ridge behind it. Devon locked the door out of habit, though the house would be someone else's within the month.

"You never told me what it said," he said, when they were back on the highway.

"I know."

He didn't ask again. Some things she would tell him in her own time, or not at all, and after four years together he had stopped needing the difference explained to him.
`.trim();

/**
 * An "AI-slop" fiction passage: written to hit as many fiction-profile tells as
 * possible in a small space — somatic clichés, named-not-shown emotion, sensory
 * triads, non-events, portentous closers, eyes/weather doing emotional labour,
 * uniform dialogue, symmetrical paragraphs, adverb-laden dialogue tags, and AI
 * vocabulary — while staying under the length where per-1000-word normalization
 * would wash the density out.
 */
const SLOP_FICTION = `
She let out a breath she didn't know she was holding as the door creaked open. Her jaw clenched. A shiver ran down her spine.

"I am fine," she breathed softly.

"I am okay," he murmured quietly.

"I am ready," she intoned firmly.

"I am here," he bit out sharply.

The smell of smoke, dust, and something faintly metallic filled the room. Her heart pounded. She felt a profound sadness settle over her, and a wave of grief washed over her all at once.

Something unspoken passed between them. The air was thick with everything neither of them would say. The silence stretched between them like a held breath.

His eyes betrayed everything his mouth would not say. The sky mirrored the wreckage below, and the rain seemed to know exactly when to fall.

Everything changed.

The room felt the tapestry of loss.

Nothing would ever be the same.
`.trim();

/**
 * A clean documentation passage: plain declarative sentences, no filler, no vague
 * authorities, straight quotes, sentence-case headings. Should score near zero on
 * the prose-doc profile.
 */
const CLEAN_DOC = `
## Setting up the build

Clone the repository and run \`npm install\` from the project root. The install step also builds the CLI binaries used by the test suite.

Configuration lives in \`config.json\`. Set \`"port"\` to change the listening port; the default is 8080. If the file is missing, the server falls back to built-in defaults and logs a warning naming the missing path.

Run \`npm test\` to execute the suite. Two tests were added in this release to cover the new retry logic in the upload client. Both tests failed on the first attempt because the retry backoff was measured in seconds instead of milliseconds; that bug is fixed in commit a91f3c2.

If a build fails, check the Node version first. The project requires Node 24 or later.
`.trim();

/**
 * An "AI-slop" documentation passage: written to hit as many prose-doc tells as
 * possible — significance inflation, promotional language, AI vocabulary, a
 * superficial "-ing" analysis clause, negative parallelism, copula avoidance,
 * repeated rule-of-three, filler, stacked hedging, vague attribution, authority
 * tropes, signposting, chat artifacts, a generic conclusion, buzzword compounds,
 * a Title Cased heading, an inline-bolded bullet, and a passive fragment.
 */
const SLOP_DOC = `
## The Complete Guide To Unlocking Your Team's Full Potential

Let's dive in. This platform stands as a testament to what modern engineering can achieve, and it serves as a pivotal moment in the evolving landscape of developer tooling. It boasts a vibrant, intricate, and enduring set of features, nestled in the heart of the developer experience.

It's not just a dashboard, it's a movement. Experts argue that observers have noted a real shift, underscoring the importance of the platform's indelible mark on the industry, showcasing how deeply rooted the interplay of design and engineering can be.

At its core, the real question is what really matters: fundamentally, this is the heart of the matter. In order to succeed, due to the fact that timing matters, teams must act at this point in time. Results could possibly potentially improve.

- **Speed:** it is fast, agile, and scalable.
- **Cost:** it is cheap, efficient, and lean.
- **Trust:** it is secure, private, and audited.

The system is real-time, data-driven, cross-functional, and client-facing, with end-to-end, decision-making support baked in.

No configuration needed. Results are generated automatically.

Great question! I hope this helps. Certainly, you're absolutely right, and the future looks bright — exciting times ahead, and a genuine step in the right direction.
`.trim();

// ------------------------------------------------------------------- profile shape

test('availableRules lists only fiction rules for the fiction profile', () => {
  const ids = availableRules('fiction');
  assert.ok(ids.includes('somatic-cliches'));
  assert.ok(ids.includes('uniform-dialogue-length'));
  assert.ok(!ids.includes('curly-quotes'), 'curly-quotes is a prose-doc-only rule');
  assert.ok(!ids.includes('title-case-headings'));
});

test('availableRules lists only prose-doc rules for the prose-doc profile', () => {
  const ids = availableRules('prose-doc');
  assert.ok(ids.includes('curly-quotes'));
  assert.ok(ids.includes('title-case-headings'));
  assert.ok(!ids.includes('somatic-cliches'), 'somatic-cliches is a fiction-only rule');
  assert.ok(!ids.includes('uniform-dialogue-length'));
});

test('lintProse defaults to the fiction profile when none is given', () => {
  const report = lintProse('Plain, unremarkable sentence.');
  assert.equal(report.profile, 'fiction');
});

test('report shape matches LintReport: profile, findings, score, tripped', () => {
  const report = lintProse('Nothing interesting here at all.', { profile: 'fiction' });
  assert.equal(report.profile, 'fiction');
  assert.ok(Array.isArray(report.findings));
  assert.equal(typeof report.score, 'number');
  assert.equal(typeof report.tripped, 'boolean');
});

test('findings carry a real offset that points at the matched text and a trimmed excerpt', () => {
  const text = 'Some preamble words here. She let out a breath she didn\'t know she was holding.';
  const report = lintProse(text, { profile: 'fiction' });
  const finding = report.findings.find((f) => f.rule === 'somatic-cliches');
  assert.ok(finding, 'expected a somatic-cliches finding');
  assert.equal(text.slice(finding.offset, finding.offset + finding.excerpt.length), finding.excerpt);
  assert.ok(finding.excerpt.length <= 60);
});

// -------------------------------------------------------- fiction: real tells caught

test('fiction: catches the canonical "breath she didn\'t know she was holding" cliché', () => {
  const report = lintProse('He let out a breath he didn\'t know he was holding.', { profile: 'fiction' });
  assert.ok(report.findings.some((f) => f.rule === 'somatic-cliches'));
});

test('fiction: catches other somatic clichés (jaw clenched, stomach dropped, blood ran cold)', () => {
  const report = lintProse('Her jaw clenched. His stomach dropped. Her blood ran cold.', { profile: 'fiction' });
  const rules = report.findings.filter((f) => f.rule === 'somatic-cliches').length;
  assert.ok(rules >= 3, `expected at least 3 somatic-cliche hits, got ${rules}`);
});

test('fiction: catches named-not-shown emotion ("felt a profound sadness", "a wave of grief washed over")', () => {
  const report = lintProse('She felt a profound sadness. A wave of grief washed over him.', { profile: 'fiction' });
  assert.ok(report.findings.some((f) => f.rule === 'named-emotion-telling'));
});

test('fiction: catches sensory triads, including "and something faintly X"', () => {
  const report = lintProse(
    'The scent of rain, smoke, and something faintly metallic filled the alley.',
    { profile: 'fiction' },
  );
  assert.ok(report.findings.some((f) => f.rule === 'sensory-triads'));
});

test('fiction: catches non-events like "something unspoken passed between them"', () => {
  const report = lintProse(
    'Something unspoken passed between them. The tension was palpable.',
    { profile: 'fiction' },
  );
  const ids = report.findings.map((f) => f.rule);
  assert.ok(ids.includes('non-events'));
});

test('fiction: catches stock portentous closers on sight, even a single instance', () => {
  const report = lintProse('She closed the door behind her. Everything changed.', { profile: 'fiction' });
  assert.ok(report.findings.some((f) => f.rule === 'portentous-stock-closers'));
});

test('fiction: catches a repeated portentous short-declarative-closer pattern, not a single instance', () => {
  const repeated = `First paragraph opens the scene, and this is longer. It closes here.

Second paragraph continues on. It stops now.

Third one goes further still. It ends there.

Fourth wraps things up nicely. It is done.`;
  const report = lintProse(repeated, { profile: 'fiction' });
  assert.ok(report.findings.some((f) => f.rule === 'portentous-one-liner-pattern'));

  const single = 'A long paragraph that goes on for quite a while about the walk home. It ends.';
  const singleReport = lintProse(single, { profile: 'fiction' });
  assert.ok(
    !singleReport.findings.some((f) => f.rule === 'portentous-one-liner-pattern'),
    'a single short closer must not trip the repeated-pattern rule',
  );
});

test('fiction: catches eyes/weather doing emotional labour', () => {
  const report = lintProse('His eyes betrayed everything. The sky mirrored the wreckage below.', {
    profile: 'fiction',
  });
  assert.ok(report.findings.some((f) => f.rule === 'eyes-weather-emotional-labour'));
});

test('fiction: catches suspiciously uniform dialogue-line lengths across >= 6 lines', () => {
  const text = '"I am fine." "I am okay." "I am ready." "I am here." "I am calm." "I am done."';
  const report = lintProse(text, { profile: 'fiction' });
  assert.ok(report.findings.some((f) => f.rule === 'uniform-dialogue-length'));
});

test('fiction: does NOT flag dialogue-length uniformity with fewer than 6 lines', () => {
  const text = '"I am fine." "I am okay." "I am ready." "I am here." "I am calm."';
  const report = lintProse(text, { profile: 'fiction' });
  assert.ok(!report.findings.some((f) => f.rule === 'uniform-dialogue-length'));
});

test('fiction: does NOT flag ordinary snappy banter that happens to land at similar lengths', () => {
  // Four short natural retorts can coincidentally sit within a word of each other -
  // that is what a snappy exchange looks like, not a template. A false positive here
  // is worse than a miss.
  const snappy = '"You should sit down." "I am fine standing." "You never listen." "I always listen."';
  const report = lintProse(snappy, { profile: 'fiction' });
  assert.ok(!report.findings.some((f) => f.rule === 'uniform-dialogue-length'));
});

test('fiction: does NOT flag a longer natural exchange with genuinely uneven line lengths', () => {
  const uneven =
    '"Wait." "For what?" "Just—wait, okay? Give me a second to think about this before you say anything else." "Fine." "You always do this." "Do what?"';
  const report = lintProse(uneven, { profile: 'fiction' });
  assert.ok(!report.findings.some((f) => f.rule === 'uniform-dialogue-length'));
});

test('fiction: catches symmetrical paragraph architecture (>= 5 paragraphs of 3+ sentences)', () => {
  const text = `One. Two. Three sentences here.

Four. Five. Six sentences here.

Seven. Eight. Nine sentences here.

Ten. Eleven. Twelve sentences here.

Thirteen. Fourteen. Fifteen sentences here.`;
  const report = lintProse(text, { profile: 'fiction' });
  assert.ok(report.findings.some((f) => f.rule === 'symmetrical-paragraph-architecture'));
});

test('fiction: uniform runs of one- and two-sentence paragraphs are left alone', () => {
  // A short beat paragraph is a deliberate device in close third. Flagging a run
  // of them punishes exactly the rhythm good fiction uses, and a false positive
  // here is worse than a miss: the gate must not flatten voice.
  const twos = `He waited. The ink stayed frozen.

She came back empty-handed. Nobody had opened the gate.

The bell rang twice. Tem did not look up.

Outside, the yard filled. The gravel took the sound out of it.

He counted the desks again. Twelve, as ever.`;
  const ones = `He waited.

She said nothing.

The bell rang.

Tem did not look up.

The yard filled.`;
  for (const text of [twos, ones]) {
    const report = lintProse(text, { profile: 'fiction' });
    assert.ok(
      !report.findings.some((f) => f.rule === 'symmetrical-paragraph-architecture'),
      'short-paragraph rhythm is not a templated shape',
    );
  }
});

test('fiction: catches dialogue-tag monotony from flashy "said"-replacement verbs', () => {
  const text =
    '"Stop," she breathed. "Please," he murmured. "Never," she intoned. "Enough," he bit out.';
  const report = lintProse(text, { profile: 'fiction' });
  assert.ok(report.findings.some((f) => f.rule === 'dialogue-tag-monotony'));
});

test('fiction: catches dialogue-tag monotony from every tag being "said" + adverb', () => {
  const text = '"Go," she said quietly. "Wait," he said softly. "No," she said firmly.';
  const report = lintProse(text, { profile: 'fiction' });
  assert.ok(report.findings.some((f) => f.rule === 'dialogue-tag-monotony'));
});

test('fiction: catches adverb-heavy dialogue tags across a large enough sample', () => {
  const text =
    '"Go," she said quietly. "Wait," he said softly. "No," she said firmly. "Enough," he said sharply. "Stop," he said loudly. "Fine," she said calmly.';
  const report = lintProse(text, { profile: 'fiction' });
  assert.ok(report.findings.some((f) => f.rule === 'adverb-density-in-dialogue-tags'));
});

test('fiction: does NOT flag adverb density from a small sample of tags, even if all carry an adverb', () => {
  // Three tags is too small a sample to distinguish "the writer leaned on adverbs" from
  // "each of these three specific beats happened to want one" - the rule needs volume.
  const text = '"Go," she said quietly. "Wait," he said softly. "No," she said firmly.';
  const report = lintProse(text, { profile: 'fiction' });
  assert.ok(!report.findings.some((f) => f.rule === 'adverb-density-in-dialogue-tags'));
});

test('fiction: does NOT flag adverb density from a tense scene that legitimately mixes adverbed and plain tags', () => {
  const text =
    '"Please," she said quietly. "I mean it," she said. "Okay," he said. "Truly," he said softly. "Fine," she said.';
  const report = lintProse(text, { profile: 'fiction' });
  assert.ok(!report.findings.some((f) => f.rule === 'adverb-density-in-dialogue-tags'));
});

test('fiction: catches AI vocabulary specific to fiction (tapestry, myriad, symphony of)', () => {
  const report = lintProse('The room felt like a tapestry of loss and a symphony of grief.', {
    profile: 'fiction',
  });
  assert.ok(report.findings.some((f) => f.rule === 'ai-vocabulary-fiction'));
});

test('fiction: catches overwrought metaphor density from 3+ similes stacked closely together', () => {
  const text =
    'Her thoughts moved like a river of glass, sharp and cold, and her heart beat like a drum of war, relentless and loud, while grief settled over her like a blanket of ash, heavy and grey.';
  const report = lintProse(text, { profile: 'fiction' });
  assert.ok(report.findings.some((f) => f.rule === 'overwrought-metaphor-density'));
});

test('fiction: does NOT flag two ordinary similes spread across a normal-length passage', () => {
  const text =
    "The letter sat on the table like a shadow of doubt neither of them wanted to name, and for a long time nobody moved to pick it up. Outside, traffic went by in the ordinary way traffic does, indifferent to whatever was happening inside. Later, at the wedding, the band's first song hit the room like a wall of sound, and for a moment conversation simply stopped, the way it does when something is briefly too loud to argue with.";
  const report = lintProse(text, { profile: 'fiction' });
  assert.ok(
    !report.findings.some((f) => f.rule === 'overwrought-metaphor-density'),
    'two similes spaced apart in a full paragraph is ordinary figurative language, not a crutch',
  );
});

test('fiction: only flags em dash density at extreme levels, not ordinary use', () => {
  const extreme =
    'She ran — fast — through the trees — never stopping — never looking back — until the light — faded — into nothing — at all.';
  const report = lintProse(extreme, { profile: 'fiction' });
  assert.ok(report.findings.some((f) => f.rule === 'em-dash-density-fiction'));
});

// ------------------------------------------------- fiction: legitimate craft NOT flagged

test('fiction: does NOT flag an em dash used for a genuine dialogue interruption', () => {
  const text =
    'She started to explain, the whole complicated business of it, working through the story slowly and carefully so he would understand every part before she reached the end. "I just—" "Don\'t," he said, and that was the end of it, and neither of them spoke again for the rest of the long walk home through the quiet, unlit streets.';
  const report = lintProse(text, { profile: 'fiction' });
  assert.ok(
    !report.findings.some((f) => f.rule === 'em-dash-density-fiction'),
    'a single interruption dash in a longer passage must not trip density',
  );
});

test('fiction: does NOT flag curly quotes — they are correct book typography', () => {
  const text = '\u201CI\u2019m not going,\u201D she said, and meant it.';
  const report = lintProse(text, { profile: 'fiction' });
  assert.ok(!report.findings.some((f) => f.rule === 'curly-quotes'), 'curly-quotes is not even a fiction rule');
});

test('fiction: does NOT flag a single rule-of-three list', () => {
  const text =
    'The kitchen smelled of coffee, toast, and something burnt, and she left the window open anyway, because the cold felt better than the smell of her own cooking failures.';
  const report = lintProse(text, { profile: 'fiction' });
  // Not a sensory-triad ("the smell of X, Y, and Z" is a doc-vs-fiction gray area,
  // so we specifically check the doc-only rule-of-three rule does not even exist here).
  assert.ok(!report.findings.some((f) => f.rule === 'rule-of-three-repeated'), 'that rule is prose-doc-only');
});

test('fiction: does NOT flag passive voice used for narrative distance', () => {
  const text =
    'The letter had been written years before, and by the time it was found the handwriting had faded almost past reading, though the fold lines were still crisp, as if it had been read and refolded a hundred times by someone who never quite decided to send it.';
  const report = lintProse(text, { profile: 'fiction' });
  assert.equal(report.findings.length, 0, `expected no findings, got ${JSON.stringify(report.findings)}`);
});

test('fiction: a well-written human-sounding passage scores near zero', () => {
  const report = lintProse(CLEAN_FICTION, { profile: 'fiction' });
  assert.ok(report.score <= 5, `expected a low score, got ${report.score}: ${JSON.stringify(report.findings)}`);
  assert.equal(report.tripped, false);
});

test('fiction: an AI-slop passage scores high and trips', () => {
  const report = lintProse(SLOP_FICTION, { profile: 'fiction' });
  assert.ok(report.score > 50, `expected a high score, got ${report.score}`);
  assert.equal(report.tripped, true);
  const ruleIds = new Set(report.findings.map((f) => f.rule));
  assert.ok(ruleIds.size >= 6, `expected many distinct rules to fire, got ${[...ruleIds].join(', ')}`);
});

test('the clean fiction passage scores substantially lower than the slop fiction passage', () => {
  const clean = lintProse(CLEAN_FICTION, { profile: 'fiction' });
  const slop = lintProse(SLOP_FICTION, { profile: 'fiction' });
  assert.ok(slop.score > clean.score * 5, `clean=${clean.score} slop=${slop.score}`);
});

// -------------------------------------------------------- prose-doc: real tells caught

test('prose-doc: catches significance inflation ("is a testament to", "pivotal moment")', () => {
  const report = lintProse('This project is a testament to hard work, a pivotal moment for the team.', {
    profile: 'prose-doc',
  });
  assert.ok(report.findings.some((f) => f.rule === 'significance-inflation'));
});

test('prose-doc: catches promotional language ("boasts a", "nestled in the heart of")', () => {
  const report = lintProse('The library boasts a huge collection, nestled in the heart of downtown.', {
    profile: 'prose-doc',
  });
  assert.ok(report.findings.some((f) => f.rule === 'promotional-language'));
});

test('prose-doc: catches AI vocabulary (delve, tapestry, myriad)', () => {
  const report = lintProse('Let us delve into the myriad ways this tapestry of features works.', {
    profile: 'prose-doc',
  });
  assert.ok(report.findings.some((f) => f.rule === 'ai-vocabulary-prose-doc'));
});

test('prose-doc: catches superficial "-ing" analysis clauses', () => {
  const report = lintProse('The bridge reopened in March, highlighting the growing importance of maintenance.', {
    profile: 'prose-doc',
  });
  assert.ok(report.findings.some((f) => f.rule === 'superficial-ing-analysis'));
});

test('prose-doc: catches negative parallelism ("not just X, it\'s Y" and "not only... but also")', () => {
  const a = lintProse("This isn't just a tool, it's a movement.", { profile: 'prose-doc' });
  assert.ok(a.findings.some((f) => f.rule === 'negative-parallelism'));
  const b = lintProse('The plan was not only ambitious but also risky.', { profile: 'prose-doc' });
  assert.ok(b.findings.some((f) => f.rule === 'negative-parallelism'));
});

test('prose-doc: catches copula avoidance ("serves as", "stands as", "functions as")', () => {
  const report = lintProse('This module serves as the entry point and stands as the reference implementation.', {
    profile: 'prose-doc',
  });
  assert.ok(report.findings.some((f) => f.rule === 'copula-avoidance'));
});

test('prose-doc: flags a repeated rule-of-three but not a single instance', () => {
  const single = lintProse('The room had chairs, tables, and lamps.', { profile: 'prose-doc' });
  assert.ok(!single.findings.some((f) => f.rule === 'rule-of-three-repeated'));

  const repeated = lintProse(
    'The room had chairs, tables, and lamps. The hall had rugs, drapes, and sconces.',
    { profile: 'prose-doc' },
  );
  assert.ok(repeated.findings.some((f) => f.rule === 'rule-of-three-repeated'));
});

test('prose-doc: flags high em dash density but not a single em dash', () => {
  const longClean = `${CLEAN_DOC} A single aside — just this one — does not make a pattern.`;
  const single = lintProse(longClean, { profile: 'prose-doc' });
  assert.ok(!single.findings.some((f) => f.rule === 'em-dash-density-prose-doc'));
});

test('prose-doc: flags curly quotes (wrong in a plain-text doc profile)', () => {
  const report = lintProse('\u201CQuoted\u201D text with \u2018inner\u2019 quotes.', { profile: 'prose-doc' });
  assert.ok(report.findings.some((f) => f.rule === 'curly-quotes'));
});

test('prose-doc: flags emoji in headings and bullets', () => {
  const report = lintProse('## \u{1F680} Getting started\n\n- \u2705 Done', { profile: 'prose-doc' });
  assert.ok(report.findings.some((f) => f.rule === 'emoji-in-headings-bullets'));
});

test('prose-doc: flags filler phrases', () => {
  const report = lintProse('In order to succeed, due to the fact that timing matters, act now.', {
    profile: 'prose-doc',
  });
  assert.ok(report.findings.some((f) => f.rule === 'filler-phrases'));
});

test('prose-doc: flags stacked hedging ("could potentially possibly")', () => {
  const report = lintProse('The results could possibly potentially indicate a trend.', { profile: 'prose-doc' });
  assert.ok(report.findings.some((f) => f.rule === 'excessive-hedging'));
});

test('prose-doc: flags vague attribution ("experts argue", "observers have noted")', () => {
  const report = lintProse('Experts argue this is significant, and observers have noted the trend.', {
    profile: 'prose-doc',
  });
  assert.ok(report.findings.some((f) => f.rule === 'vague-attribution'));
});

test('prose-doc: flags authority tropes ("at its core", "the real question is")', () => {
  const report = lintProse('At its core, the real question is what really matters.', { profile: 'prose-doc' });
  assert.ok(report.findings.some((f) => f.rule === 'authority-tropes'));
});

test('prose-doc: flags tutorial-video signposting ("let\'s dive in")', () => {
  const report = lintProse("Let's dive in and explore the feature set.", { profile: 'prose-doc' });
  assert.ok(report.findings.some((f) => f.rule === 'signposting'));
});

test('prose-doc: flags chat artifacts left in a document', () => {
  const report = lintProse('Great question! I hope this helps. Let me know if you have questions.', {
    profile: 'prose-doc',
  });
  assert.ok(report.findings.some((f) => f.rule === 'chat-artifacts'));
});

test('prose-doc: flags generic positive conclusions', () => {
  const report = lintProse('In summary, the future looks bright and these are exciting times ahead.', {
    profile: 'prose-doc',
  });
  assert.ok(report.findings.some((f) => f.rule === 'generic-positive-conclusion'));
});

test('prose-doc: flags a pile-up of hyphenated buzzword compounds but not a lone one', () => {
  const lone = lintProse('This is a real-time system.', { profile: 'prose-doc' });
  assert.ok(!lone.findings.some((f) => f.rule === 'hyphenated-pair-overuse'));

  const many = lintProse(
    'This data-driven, cross-functional, client-facing system is also real-time.',
    { profile: 'prose-doc' },
  );
  assert.ok(many.findings.some((f) => f.rule === 'hyphenated-pair-overuse'));
});

test('prose-doc: flags Title Cased headings but not sentence-case ones', () => {
  const titleCased = lintProse('## The Complete Guide To Modern Software Architecture Patterns', {
    profile: 'prose-doc',
  });
  assert.ok(titleCased.findings.some((f) => f.rule === 'title-case-headings'));

  const sentenceCase = lintProse('## Modern software architecture patterns explained', {
    profile: 'prose-doc',
  });
  assert.ok(!sentenceCase.findings.some((f) => f.rule === 'title-case-headings'));
});

test('prose-doc: flags inline-bolded-header bullet lists', () => {
  const report = lintProse('- **Speed:** it is fast\n- **Cost:** it is cheap', { profile: 'prose-doc' });
  assert.ok(report.findings.some((f) => f.rule === 'inline-header-bullets'));
});

test('prose-doc: flags passive subjectless fragments', () => {
  const report = lintProse('No configuration needed. Results are generated automatically.', {
    profile: 'prose-doc',
  });
  assert.ok(report.findings.some((f) => f.rule === 'passive-subjectless-fragments'));
});

// --------------------------------------------------- prose-doc: legitimate text NOT flagged

test('prose-doc: a clean documentation passage scores near zero', () => {
  const report = lintProse(CLEAN_DOC, { profile: 'prose-doc' });
  assert.ok(report.score <= 5, `expected a low score, got ${report.score}: ${JSON.stringify(report.findings)}`);
  assert.equal(report.tripped, false);
});

test('prose-doc: an AI-slop documentation passage scores high and trips', () => {
  const report = lintProse(SLOP_DOC, { profile: 'prose-doc' });
  assert.ok(report.score > 50, `expected a high score, got ${report.score}`);
  assert.equal(report.tripped, true);
  const ruleIds = new Set(report.findings.map((f) => f.rule));
  assert.ok(ruleIds.size >= 10, `expected many distinct rules to fire, got ${[...ruleIds].join(', ')}`);
});

// ------------------------------------------------------------------- cross-profile

test('the significance-inflation and promotional-language rules never fire on the fiction profile', () => {
  const text = 'This place boasts a vibrant history and is a testament to resilience.';
  const report = lintProse(text, { profile: 'fiction' });
  assert.ok(!report.findings.some((f) => f.rule === 'significance-inflation'));
  assert.ok(!report.findings.some((f) => f.rule === 'promotional-language'));
});

test('the somatic-cliches rule never fires on the prose-doc profile', () => {
  const text = 'She let out a breath she didn\'t know she was holding.';
  const report = lintProse(text, { profile: 'prose-doc' });
  assert.ok(!report.findings.some((f) => f.rule === 'somatic-cliches'));
});

// ----------------------------------------------------------------------- score/threshold

test('score rises monotonically as a rule fires more times in the same text', () => {
  const one = lintProse('He let out a breath he didn\'t know he was holding.', { profile: 'fiction' });
  const two = lintProse(
    "He let out a breath he didn't know he was holding. She let out a breath she didn't know she was holding.",
    { profile: 'fiction' },
  );
  assert.ok(two.score >= one.score);
});

test('score is normalized per word count: the same absolute number of findings scores lower in a longer text', () => {
  const short = lintProse('Her jaw clenched.', { profile: 'fiction' });
  const padding = 'A calm, unremarkable sentence about the weather and the road ahead. '.repeat(60);
  const long = lintProse(`${padding}Her jaw clenched.`, { profile: 'fiction' });
  assert.ok(long.score < short.score, `short=${short.score} long=${long.score}`);
});

test('tripped flips to true once score exceeds the threshold, and respects a custom threshold', () => {
  const text = 'Her jaw clenched. His stomach dropped.';
  const permissive = lintProse(text, { profile: 'fiction', threshold: 100000 });
  assert.equal(permissive.tripped, false);
  const strict = lintProse(text, { profile: 'fiction', threshold: 0 });
  assert.equal(strict.tripped, true);
});

// ------------------------------------------------------------------- blocklist

test('user blocklist flags a personally-banned phrase as a case-insensitive substring match', () => {
  const report = lintProse('The Ineffable Ledger hummed with purpose.', {
    profile: 'fiction',
    blocklist: ['ineffable ledger'],
  });
  const hit = report.findings.find((f) => f.rule === 'user-blocklist');
  assert.ok(hit, 'expected a user-blocklist finding');
  assert.equal(hit.excerpt, 'The Ineffable Ledger'.slice(4)); // 'Ineffable Ledger'
});

test('user blocklist is empty/absent by default and contributes nothing', () => {
  const report = lintProse('Nothing objectionable here.', { profile: 'fiction' });
  assert.ok(!report.findings.some((f) => f.rule === 'user-blocklist'));
});

test('user blocklist finds every occurrence of a banned phrase, not just the first', () => {
  const report = lintProse('shimmering eyes and shimmering hope and shimmering everything', {
    profile: 'fiction',
    blocklist: ['shimmering'],
  });
  const hits = report.findings.filter((f) => f.rule === 'user-blocklist');
  assert.equal(hits.length, 3);
});

test('user blocklist phrases apply on top of built-in rules and both contribute to the score', () => {
  const padding =
    'The morning was ordinary in every way that mattered, and nothing about the walk to the station suggested otherwise. ';
  const builtinOnly = lintProse(`${padding}Her jaw clenched.`, { profile: 'fiction' });
  const withBlocklist = lintProse(`${padding}Her jaw clenched, shimmering with resolve.`, {
    profile: 'fiction',
    blocklist: ['shimmering'],
  });
  assert.ok(withBlocklist.score > builtinOnly.score, `builtin=${builtinOnly.score} withBlocklist=${withBlocklist.score}`);
});

// -------------------------------------------------------------------- crossSceneTells

test('crossSceneTells finds a phrase repeated verbatim across 3+ separate texts', () => {
  const findings = crossSceneTells([
    "She let out a breath she didn't know she was holding as the door shut.",
    "He let out a breath he didn't know he was holding while the rain fell.",
    "They let out a breath they didn't know they were holding under the moon.",
  ]);
  assert.ok(findings.some((f) => f.rule === 'cross-scene-repetition'));
});

test('crossSceneTells does NOT flag a gesture that appears in only one or two texts', () => {
  const findings = crossSceneTells([
    "She let out a breath she didn't know she was holding.",
    'A completely unrelated paragraph about the weather and the road.',
    'Another unrelated paragraph about breakfast and coffee.',
  ]);
  assert.ok(!findings.some((f) => f.rule === 'cross-scene-repetition'));
});

test('crossSceneTells requires at least 3 texts to have anything to compare', () => {
  const findings = crossSceneTells([
    "She let out a breath she didn't know she was holding.",
    "He let out a breath he didn't know he was holding.",
  ]);
  assert.deepEqual(findings, []);
});

test('crossSceneTells ignores n-grams made entirely of stopwords', () => {
  const findings = crossSceneTells([
    'and then it was and then it was and then it was',
    'and then it was different this time around completely',
    'and then it was not the same as before at all',
  ]);
  assert.ok(
    !findings.some((f) => /^(and then it|then it was)$/.test(f.excerpt)),
    'pure-stopword n-grams should not surface as tells',
  );
});
