import { lintProse, availableRules, crossSceneTells } from './src/lint/engine.ts';

function show(label, text, opts) {
  const r = lintProse(text, opts);
  console.log('---', label, '---');
  console.log('score', r.score, 'tripped', r.tripped);
  for (const f of r.findings) console.log(' ', f.rule, '|', f.severity, '|', JSON.stringify(f.excerpt));
}

show('superficial-ing', 'The bridge was rebuilt in 1990, highlighting the growing importance of infrastructure investment.', { profile: 'prose-doc' });
show('negative-parallelism-1', "This is not just a tool, it's a movement.", { profile: 'prose-doc' });
show('negative-parallelism-2', "The plan was not only ambitious but also risky.", { profile: 'prose-doc' });
show('hedging', 'The results could possibly potentially indicate a trend.', { profile: 'prose-doc' });
show('vague-attribution', 'Experts argue that the change was inevitable.', { profile: 'prose-doc' });
show('rule-of-three-doc-single', 'The room had chairs, tables, and lamps.', { profile: 'prose-doc' });
show('rule-of-three-doc-double', 'The room had chairs, tables, and lamps. The hall had rugs, drapes, and sconces.', { profile: 'prose-doc' });
show('title-case', '## The Complete Guide To Modern Software Architecture Patterns', { profile: 'prose-doc' });
show('title-case-neutral', '## Modern software architecture patterns explained', { profile: 'prose-doc' });
show('inline-bullets', '- **Performance:** it is fast\n- **Cost:** it is cheap', { profile: 'prose-doc' });
show('passive-fragment', 'No configuration needed. Results are generated automatically.', { profile: 'prose-doc' });
show('emoji-heading', '## 🚀 Getting Started', { profile: 'prose-doc' });
show('hyphen-pair-single', 'This is a real-time system.', { profile: 'prose-doc' });
show('hyphen-pair-triple', 'This data-driven, cross-functional, client-facing system is real-time.', { profile: 'prose-doc' });

show('sensory-triad', 'The smell of old paper, dust, and something faintly metallic filled the room.', { profile: 'fiction' });
show('portentous-oneliner-single', 'She walked to the window. It began to rain. Hers, probably, from before.', { profile: 'fiction' });
show('em-dash-fiction-moderate', 'I just—" "Don\'t." He turned away — just for a moment — and said nothing more today.', { profile: 'fiction' });
show('em-dash-fiction-extreme', 'She ran — fast — through the trees — never stopping — never looking back — until the light — faded.', { profile: 'fiction' });

const uniformDialogue = `
"I am fine." "I am okay." "I am well." "I am good."
`;
show('uniform-dialogue', uniformDialogue, { profile: 'fiction' });

const variedDialogue = `
"No." "I don't know, honestly, and I'm not sure I want to." "Wait." "Could you just—could you just give me a minute here, please, before you say anything else?"
`;
show('varied-dialogue', variedDialogue, { profile: 'fiction' });

const symParas = `One sentence here. Another one follows. And a third completes it.

Different opening now. It continues onward. Then it closes out.

Yet again it starts. The middle carries on. The end arrives quietly.

Once more it begins. Something happens next. Finally it stops.
`;
show('symmetrical-paragraphs', symParas, { profile: 'fiction' });

console.log('fiction rules:', availableRules('fiction'));
console.log('doc rules:', availableRules('prose-doc'));

const cross = crossSceneTells([
  "She let out a breath she didn't know she was holding as the door creaked shut.",
  "He let out a breath he didn't know he was holding while the rain fell outside.",
  "They let out a breath they didn't know they were holding under the pale moon.",
]);
console.log('cross-scene:', cross);
