import { applyDirectiveRecalc } from '../consequence/propagate-pg.ts';
import type { World } from '../store/index-pg.ts';
import type { DirectiveRepository } from './directives.ts';

export function postgresDirectiveRepository(world: World): DirectiveRepository {
  return {
    currentScene: async () => (await world.session.get()).scene,
    create: (directive) => world.directives.create(directive),
    recalculate: (id, text) => applyDirectiveRecalc(world, id, text),
    threadTitles: async (ids) => {
      const wanted = new Set(ids);
      return new Map(
        (await world.threads.all())
          .filter((thread) => wanted.has(thread.id))
          .map((thread) => [thread.id, thread.title]),
      );
    },
  };
}
