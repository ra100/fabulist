import type { Directive } from '../domain/types.ts';

export interface DirectiveDraft {
  text: string;
  scope?: Directive['scope'];
  strength?: Directive['strength'];
  lifetimeScenes?: number | null;
}

export interface DirectiveRecalculation {
  raisedThreads: string[];
  loweredThreads: string[];
  [key: string]: unknown;
}

export interface DirectiveRepository {
  currentScene(): number | Promise<number>;
  create(directive: Omit<Directive, 'id'>): Directive | Promise<Directive>;
  recalculate(id: string, text: string): DirectiveRecalculation | Promise<DirectiveRecalculation>;
  threadTitles(ids: string[]): Map<string, string> | Promise<Map<string, string>>;
}

export async function createDirective(repository: DirectiveRepository, draft: DirectiveDraft) {
  const created = await repository.create({
    text: draft.text,
    scope: draft.scope ?? 'chapter',
    strength: draft.strength ?? 'push',
    lifetimeScenes: draft.lifetimeScenes ?? 5,
    status: 'active',
    createdScene: await repository.currentScene(),
  });
  const diff = await repository.recalculate(created.id, created.text);
  const titles = await repository.threadTitles([...diff.raisedThreads, ...diff.loweredThreads]);
  return {
    directive: created,
    diff: {
      ...diff,
      raisedThreadTitles: diff.raisedThreads.map((id) => titles.get(id) ?? id),
      loweredThreadTitles: diff.loweredThreads.map((id) => titles.get(id) ?? id),
    },
  };
}
