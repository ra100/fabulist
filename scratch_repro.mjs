import { lintProse } from './src/lint/engine.ts';

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

Later, packing the kitchen boxes, Mara found herself thinking about the house differently: the crack in the ceiling that had always been there, the smell of her grandmother's coffee that had never quite left the cabinets, the particular slant of afternoon light across the counter that no other house she'd lived in had managed to reproduce. She wrapped the last of the plates in newspaper and did not cry, though she had expected to.

They loaded the van in silence broken only by directions — left here, mind the step, careful with that one — and by the time the house was empty the sun had gone orange over the ridge behind it. Devon locked the door out of habit, though the house would be someone else's within the month.

"You never told me what it said," he said, when they were back on the highway.

"I know."

He didn't ask again. Some things she would tell him in her own time, or not at all, and after four years together he had stopped needing the difference explained to him.
`.trim();

const r = lintProse(CLEAN_FICTION, { profile: 'fiction' });
console.log('score', r.score);
for (const f of r.findings) console.log(f.rule, '|', f.message);
