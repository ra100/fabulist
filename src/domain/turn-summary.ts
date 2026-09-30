import type { Delta, Turn } from './types.ts';

function sentence(text: string): string {
  const value = text.trim();
  if (!value) return '';
  return /[.!?]$/.test(value) ? value : `${value}.`;
}

function fields(values: Record<string, unknown>): string {
  return Object.entries(values)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, value]) => `${key}=${JSON.stringify(value)}`)
    .join(', ');
}

export function summarizeDelta(delta: Delta | null): string {
  if (!delta) return '';

  const parts: string[] = [];
  parts.push(...delta.events.map((event) => sentence(event.text)));
  parts.push(...delta.entityUpserts.map((entity) =>
    sentence(`Introduced ${entity.id} (${entity.name})${entity.summary ? `: ${entity.summary}` : ''}`)
  ));
  parts.push(...delta.edgeAsserts.map((edge) =>
    sentence(`Relation added: ${edge.subject} ${edge.predicate} ${edge.object}`)
  ));
  parts.push(...delta.edgeRetires.map((edge) =>
    sentence(`Relation ended: ${edge.subject} ${edge.predicate} ${edge.object}`)
  ));
  parts.push(...delta.conditionUpdates.map((update) =>
    sentence(`Condition changed for ${update.entityId}: ${fields(update.patch)}`)
  ));
  parts.push(...delta.relationshipUpdates.map((update) => {
    const changes = fields({
      ...(update.trustDelta !== undefined ? { trustDelta: update.trustDelta } : {}),
      ...(update.affectionDelta !== undefined ? { affectionDelta: update.affectionDelta } : {}),
      ...(update.respectDelta !== undefined ? { respectDelta: update.respectDelta } : {}),
      ...(update.note ? { note: update.note } : {}),
    });
    return sentence(`Relationship changed from ${update.fromId} to ${update.toId}${changes ? `: ${changes}` : ''}`);
  }));
  parts.push(...delta.factsLearned.map((fact) => sentence(`Fact: ${fact.text}`)));
  parts.push(...delta.threadUpdates.map((thread) => {
    const identity = thread.id ?? thread.title ?? 'new thread';
    const changes = fields({
      ...(thread.title ? { title: thread.title } : {}),
      ...(thread.stakes ? { stakes: thread.stakes } : {}),
      ...(thread.tensionDelta !== undefined ? { tensionDelta: thread.tensionDelta } : {}),
      ...(thread.resolutions?.length ? { resolutions: thread.resolutions } : {}),
      ...(thread.status ? { status: thread.status } : {}),
    });
    return sentence(`Thread ${identity} changed${changes ? `: ${changes}` : ''}`);
  }));
  parts.push(...delta.vowBreaks.map((vow) => sentence(`Vow broken: ${vow.entityId} ${vow.vowId}`)));
  if (delta.sceneAdvance) parts.push('Scene advanced.');

  return parts.filter(Boolean).join(' ') || 'No canonical state change.';
}

export function summaryForTurn(turn: Pick<Turn, 'delta' | 'meta'>): string {
  return turn.meta.summary?.trim() || summarizeDelta(turn.delta);
}
