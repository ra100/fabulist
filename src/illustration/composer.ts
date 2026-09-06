/**
 * Prompt composition. This is where the three consistency problems the ask
 * named directly — visual consistency, place consistency, character
 * consistency — actually get solved, to the extent a text prompt and an
 * optional reference image can solve them. See `.design/ILLUSTRATIONS.md` for
 * the full writeup; this file is the mechanism, that document is the why.
 *
 * Three independent levers, used in combination and never assumed to be
 * alone sufficient:
 *
 * 1. **Restated description, every time.** The single lever every provider
 *    has, because it costs nothing but tokens. `StyleContract.visualAnchor`
 *    (world) and `Appearance.description/attire/markers` (character) are
 *    slow fields by design — see their doc comments in `domain/types.ts` —
 *    and this composer never lets a scene-specific detail *replace* them, only
 *    follow them. Solves visual consistency (the anchor is in every prompt)
 *    and character consistency (the same three sentences describe the same
 *    person in scene 1 and scene 40) through repetition, imperfectly: a
 *    diffusion model reading the same words twice does not guarantee the same
 *    pixels twice. This is the floor every provider gets, not the ceiling.
 *
 * 2. **Seed reuse**, when `ImageCapabilities.seedControl` is true. Cheap,
 *    real, and *not* a guarantee: the same seed plus a materially different
 *    prompt (a new location, new lighting, new attire) can still drift far
 *    from the reference. Reused for portraits, where the prompt is
 *    deliberately kept close to what generated the reference; not reused for
 *    scenes, where the prompt necessarily differs turn to turn.
 *
 * 3. **Reference-image conditioning**, when `ImageCapabilities.imageConditioning`
 *    is true. The only lever that actually looks at pixels rather than
 *    re-describing them, so it is the one that matters most and the one no
 *    provider is required to have. A portrait's own `referenceImagePath`
 *    conditions every later portrait *and* every scene that character
 *    appears in; a location's saved reference (via `IllustrationStore.reference`)
 *    conditions every later scene at that location. Solves place consistency
 *    the same way it solves character consistency — a location is exactly
 *    "an entity most people never call by its `Appearance`", so it gets the
 *    identical treatment through `locationAnchor()` rather than a second type.
 *
 * Nothing here calls a provider. Pure functions, string in, prompt out — same
 * discipline as `lint/rules.ts`, for the same reason: composition should be
 * testable and reviewable without a network or a database.
 */
import type { CharacterSheet, Entity, StyleContract, VisualStyle } from '../domain/types.ts';

export interface StyleFragment {
  /** Appended to every prompt this style produces. */
  positive: string;
  /** Appended to every negative prompt this style produces. */
  negative: string;
}

/**
 * One fragment pair per option on the tin, not a longer taste-driven list —
 * the ask was specifically realistic / drawing / sketch / draft / animation.
 * `draft` is the cheapest-reading option on purpose: it is the default
 * (`defaultStyleContract().visualStyle`) so a fresh world's first generation
 * looks deliberately unfinished rather than falsely premium, mirroring the
 * mock text provider's own "deliberately plain, proves the machinery" stance.
 */
export const STYLE_FRAGMENTS: Record<VisualStyle, StyleFragment> = {
  realistic: {
    positive: 'photorealistic, natural lighting, fine skin and fabric detail, shot on a full-frame camera, 85mm lens',
    negative: 'illustration, painting, cartoon, anime, drawing, sketch, render, cel shading, flat colour',
  },
  drawing: {
    positive: 'digital painting, painterly brushwork, rich colour, considered lighting, finished illustration',
    negative: 'photo, photorealistic, 3d render, blurry, sketch lines visible, unfinished',
  },
  sketch: {
    positive: 'loose pencil sketch, visible construction lines, cross-hatching for shadow, monochrome graphite on paper',
    negative: 'photo, photorealistic, colour, painted, flat vector, glossy render',
  },
  draft: {
    positive: 'rough concept sketch, quick gesture lines, minimal shading, unfinished study, muted limited palette',
    negative: 'photo, photorealistic, glossy, highly detailed, polished render, saturated colour',
  },
  animation: {
    positive: 'animated feature film still, cel-shaded, clean linework, bold flat colour, stylised proportions',
    negative: 'photo, photorealistic, live action, film grain, realistic skin texture',
  },
};

const DEFAULT_NEGATIVE = 'text, watermark, signature, logo, extra limbs, deformed hands, low quality, blurry';

/** The world anchor, or a generic placeholder when the author has not set one yet — never an empty prompt fragment. */
function worldAnchor(style: StyleContract): string {
  return style.visualAnchor.trim() || 'a coherent fictional world, consistent architecture and dress across scenes';
}

/** Restates identity durably: the same sentences every single time, per lever 1 above. */
function appearanceFragment(entity: Entity, sheet: CharacterSheet | undefined): string {
  const a = sheet?.appearance;
  if (a?.description || a?.attire || a?.markers.length) {
    return [
      `${entity.name}: ${a.description || 'appearance not yet described'}`,
      a.attire && `wearing ${a.attire}`,
      a.markers.length ? `distinguishing marks: ${a.markers.join(', ')}` : '',
    ]
      .filter(Boolean)
      .join('. ');
  }
  // No appearance authored yet: fall back to whatever the sheet/entity already
  // says, rather than inventing detail the composer has no authority to add.
  return `${entity.name}: ${entity.summary || sheet?.identity.arc || 'no visual description recorded yet'}`;
}

/**
 * A location's equivalent of `Appearance` — the durable visual description
 * this composer restates every time a scene is set here. Kept on `Entity`
 * itself (`props.visualDescription`) rather than a new sheet-shaped type: a
 * location is functionally "an entity almost nobody calls by its
 * `CharacterSheet`", so giving it a second parallel schema would duplicate
 * the concept the moment someone wanted a shopkeeper's stall to have both.
 */
export function locationAnchor(location: Entity | undefined): string {
  if (!location) return '';
  const visual = typeof location.props.visualDescription === 'string' ? location.props.visualDescription : '';
  return [`${location.name}`, visual || location.summary].filter(Boolean).join(': ');
}

export interface ComposedPrompt {
  prompt: string;
  negativePrompt: string;
}

/**
 * A portrait prompt: one character, no scene context, so later re-generation
 * (a different style, a "make it more X") starts from the same anchor every
 * time. This is also the text a fresh character's *first* portrait is built
 * from, which is why it must not depend on `referenceImagePath` existing yet.
 */
export function composePortraitPrompt(entity: Entity, sheet: CharacterSheet, style: StyleContract): ComposedPrompt {
  const fragment = STYLE_FRAGMENTS[style.visualStyle];
  const prompt = [
    `Character portrait of ${entity.name}.`,
    appearanceFragment(entity, sheet),
    `Set in: ${worldAnchor(style)}.`,
    fragment.positive,
    'head-and-shoulders composition, plain background, looking toward camera',
  ]
    .filter(Boolean)
    .join(' ');
  return { prompt, negativePrompt: [fragment.negative, DEFAULT_NEGATIVE].join(', ') };
}

export interface ScenePresence {
  entity: Entity;
  sheet: CharacterSheet | undefined;
}

/**
 * A scene prompt: the location plus everyone present, each restated through
 * the identical `appearanceFragment` a portrait prompt would use — the same
 * text that anchors the portrait is what anchors their appearance here, so
 * the two are pulling toward the same description rather than two
 * independently-invented ones.
 */
export function composeScenePrompt(
  location: Entity | undefined,
  present: ScenePresence[],
  style: StyleContract,
  sceneDetail = '',
): ComposedPrompt {
  const fragment = STYLE_FRAGMENTS[style.visualStyle];
  const cast = present.map((p) => appearanceFragment(p.entity, p.sheet)).join('. ');
  const prompt = [
    location ? `Scene at ${locationAnchor(location)}.` : 'Scene.',
    cast && `Present: ${cast}.`,
    sceneDetail?.trim(),
    `World: ${worldAnchor(style)}.`,
    fragment.positive,
    'wide establishing composition',
  ]
    .filter(Boolean)
    .join(' ');
  return { prompt, negativePrompt: [fragment.negative, DEFAULT_NEGATIVE].join(', ') };
}
