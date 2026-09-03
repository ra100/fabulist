/**
 * Budgeted frame assembly. See DESIGN.md §4 (Scene Frame) and §9.2.
 *
 * Retrieval here is a deterministic assembly of slots, mostly graph traversal.
 * Vector similarity is garnish; graph locality plus fixed slots is the meal.
 *
 * At 64k the budget is enforced, not hoped for: slots have hard caps, a fixed
 * eviction order, and compression is attempted before anything is dropped.
 * Every decision is logged so a thin scene can be diagnosed rather than guessed at.
 */
import type { Frame, FrameLog, FrameSlot } from '../domain/types.ts';
import type { Tokenizer } from './tokenizer.ts';

/** Priorities. Higher survives longer. Never-evictable slots sit above 100. */
export const Priority = {
  styleContract: 120,
  agreedBeat: 118,
  presentCast: 115,
  playerSheet: 114,
  locationCard: 90,
  openThreads: 80,
  recentProse: 70,
  epistemicMask: 60,
  neighbourhood: 50,
  pendingArrivals: 45,
  sceneSummaries: 40,
  castThumbnails: 30,
  vectorFlavour: 10,
} as const;

export interface SlotSpec {
  name: string;
  priority: number;
  content: string;
  /** Hard cap for this slot regardless of remaining budget. */
  maxTokens?: number;
  evictable?: boolean;
  compressible?: boolean;
}

export interface BudgetOptions {
  /** Total input budget for this call, already net of expected output. */
  budget: number;
  tokenizer: Tokenizer;
  /** Floor below which a compressed slot is not worth keeping. */
  minSlotTokens?: number;
}

/**
 * Fits slots into the budget.
 *
 * Order of operations matters: cap each slot first, then if still over, compress
 * the compressible ones from lowest priority up, then evict. Compression before
 * eviction is deliberate — a summarised location card is worth far more than a
 * missing one.
 */
export function assembleFrame(specs: SlotSpec[], opts: BudgetOptions): Frame {
  const { budget, tokenizer } = opts;
  const minSlotTokens = opts.minSlotTokens ?? 24;

  const slots: FrameSlot[] = specs
    .filter((s) => s.content.trim().length > 0)
    .map((s) => {
      const capped =
        s.maxTokens !== undefined ? tokenizer.truncate(s.content, s.maxTokens) : s.content;
      return {
        name: s.name,
        priority: s.priority,
        content: capped,
        tokens: tokenizer.count(capped),
        evictable: s.evictable ?? s.priority < 100,
        compressible: s.compressible ?? true,
      };
    });

  const evicted: string[] = [];
  const compressed: string[] = [];
  const total = () => slots.reduce((n, s) => n + s.tokens, 0);

  // Compress from the least important upward, taking exactly the overage from
  // each slot rather than a fixed fraction. A fixed ratio needs several passes
  // to converge and tends to evict slots that could have survived shrunken.
  if (total() > budget) {
    const order = [...slots].sort((a, b) => a.priority - b.priority);
    for (const slot of order) {
      const over = total() - budget;
      if (over <= 0) break;
      if (!slot.compressible) continue;
      const target = Math.max(minSlotTokens, slot.tokens - over);
      if (target >= slot.tokens) continue;
      slot.content = tokenizer.truncate(slot.content, target);
      slot.tokens = tokenizer.count(slot.content);
      compressed.push(slot.name);
    }
  }

  // Then evict, still least important first, never touching the protected slots.
  if (total() > budget) {
    const order = [...slots].sort((a, b) => a.priority - b.priority);
    for (const slot of order) {
      if (total() <= budget) break;
      if (!slot.evictable) continue;
      evicted.push(slot.name);
      slot.tokens = 0;
      slot.content = '';
    }
  }

  const live = slots.filter((s) => s.content.length > 0);
  live.sort((a, b) => b.priority - a.priority);

  const log: FrameLog = {
    budget,
    used: live.reduce((n, s) => n + s.tokens, 0),
    slots: live.map((s) => ({ name: s.name, tokens: s.tokens })),
    evicted,
    compressed,
  };

  const text = live.map((s) => `<${s.name}>\n${s.content}\n</${s.name}>`).join('\n\n');

  return { slots: live, log, text };
}

/**
 * Splits a total context window into an input budget, reserving room for output.
 * Over-reserving is the cheap mistake; under-reserving truncates the reply.
 */
export function inputBudget(contextWindow: number, expectedOutputTokens: number, margin = 0.9): number {
  return Math.max(512, Math.floor((contextWindow - expectedOutputTokens) * margin));
}
