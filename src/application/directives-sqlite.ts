import { applyDirectiveRecalc } from '../consequence/propagate.ts';
import type { World } from '../store/index.ts';
import type { DirectiveRepository } from './directives.ts';

export function sqliteDirectiveRepository(world: World): DirectiveRepository {
  return {
    currentScene: () => world.session.get().scene,
    create: (directive) => world.directives.create(directive),
    recalculate: (id, text) => applyDirectiveRecalc(world, id, text),
    threadTitles: (ids) => new Map(ids.map((id) => [id, world.threads.get(id)?.title ?? id])),
  };
}
