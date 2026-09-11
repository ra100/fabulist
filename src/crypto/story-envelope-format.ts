export const STORY_ENVELOPE_VERSION = 1;

export interface StoryValueContext {
  storyId: string;
  table: string;
  recordId: string;
  field: string;
}

export function storyValueAad(context: StoryValueContext): string {
  if (!context.storyId || !context.table || !context.recordId || !context.field) {
    throw new Error('incomplete encrypted story-value context');
  }
  return `fabulist:story-value:v${STORY_ENVELOPE_VERSION}:${JSON.stringify([
    context.storyId,
    context.table,
    context.recordId,
    context.field,
  ])}`;
}
