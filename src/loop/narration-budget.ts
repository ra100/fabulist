/**
 * Output headroom for prose is deliberately larger than its word target:
 * tokenization varies, and the cap must not turn a completed beat into a cutoff.
 */
export function narrationOutputTokenBudget(sceneTarget: number): number {
  return Math.max(2048, Math.ceil(sceneTarget * 8));
}

/** Reserve the full allowance for the empty-stream retry plus framing overhead. */
export function narrationOutputReserve(sceneTarget: number): number {
  return narrationOutputTokenBudget(sceneTarget) * 2 + 1024;
}

/** A soft range around the configured target; 275 words yields 250–300. */
export function narrationWordRange(sceneTarget: number): { min: number; max: number } {
  const tolerance = Math.max(1, Math.round(sceneTarget * 0.09));
  return {
    min: Math.max(1, sceneTarget - tolerance),
    max: sceneTarget + tolerance,
  };
}
