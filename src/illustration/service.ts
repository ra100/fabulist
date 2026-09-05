/**
 * Illustration service: the one entry point the API layer calls to generate a
 * scene image or a character portrait. Owns the orchestration — compose the
 * prompt, resolve a reference image if one exists, call the provider, persist
 * the result — the way `Engine` owns the turn loop, so `server/api.ts` stays
 * thin and the whole pipeline is unit-testable against a `MockImageProvider`
 * with no server involved.
 *
 * Composition and generation are deliberately split (`composePortrait` /
 * `composeScene` vs. `illustratePortrait` / `illustrateScene`): the ask this
 * was built against was explicit that a vision model might not be available
 * at all, and the fallback for that case is not an error, it is *the prompt
 * itself*, ready to paste into whatever image tool the player already has
 * open. `illustrate*` calls `compose*` and then hands the result to a
 * provider; the API layer exposes `compose*` directly so a copy-pasteable
 * prompt costs nothing even when `providers.get()` is null.
 */
import type { Entity, EntityId, StyleContract, VisualStyle } from '../domain/types.ts';
import type { Illustration } from '../domain/types.ts';
import type { ImageProvider } from '../providers/image.ts';
import type { World } from '../store/index.ts';
import { composePortraitPrompt, composeScenePrompt, type ComposedPrompt, type ScenePresence } from './composer.ts';

export interface IllustrationRegistry {
  get(): ImageProvider | null;
}

export interface IllustrationServiceOptions {
  world: World | (() => World);
  providers: IllustrationRegistry;
}

/** Thrown when generation is attempted with no image provider configured. Distinct from a provider error, so the API layer can 400 rather than 500. */
export class NoImageProviderError extends Error {
  constructor() {
    super('no image provider configured — set one in settings, or start a local ComfyUI/Ollama-style server');
  }
}

export class IllustrationService {
  private getWorld: () => World;
  private providers: IllustrationRegistry;

  constructor(opts: IllustrationServiceOptions) {
    this.getWorld = typeof opts.world === 'function' ? opts.world : () => opts.world as World;
    this.providers = opts.providers;
  }

  private resolveStyle(overrideStyle?: VisualStyle): StyleContract {
    const style = this.getWorld().session.get().style;
    return overrideStyle ? { ...style, visualStyle: overrideStyle } : style;
  }

  /** The prompt alone, for the "no provider — copy this into whatever you have" path. Never touches the provider or the illustrations table. */
  composePortrait(entityId: EntityId, overrideStyle?: VisualStyle): ComposedPrompt {
    const world = this.getWorld();
    const entity = world.graph.get(entityId);
    if (!entity) throw new Error(`no such entity: ${entityId}`);
    return composePortraitPrompt(entity, world.cast.getOrBlank(entityId), this.resolveStyle(overrideStyle));
  }

  /** Same split for scenes, reading present cast the same way `illustrateScene` does. */
  composeScene(turnId: string, locationId: EntityId | null, presentIds: EntityId[], sceneDetail: string, overrideStyle?: VisualStyle): ComposedPrompt {
    const world = this.getWorld();
    const location = locationId ? world.graph.get(locationId) : undefined;
    const present: ScenePresence[] = presentIds
      .map((id) => world.graph.get(id))
      .filter((e): e is Entity => !!e)
      .map((entity) => ({ entity, sheet: world.cast.get(entity.id) }));
    return composeScenePrompt(location, present, this.resolveStyle(overrideStyle), sceneDetail);
  }

  /**
   * Generates (or regenerates) a character's portrait. On success, updates
   * `Appearance.referenceImagePath` and `.seed` — this is the write that
   * makes every later portrait and every scene this character appears in
   * conditionable on this specific image, which is the actual mechanism
   * behind the character-consistency claim, not just a stored artifact.
   */
  async illustratePortrait(entityId: EntityId, overrideStyle?: VisualStyle): Promise<Illustration> {
    const world = this.getWorld();
    const provider = this.providers.get();
    if (!provider) throw new NoImageProviderError();

    const entity = world.graph.get(entityId);
    if (!entity) throw new Error(`no such entity: ${entityId}`);
    const sheet = world.cast.getOrBlank(entityId);
    const style = this.resolveStyle(overrideStyle);

    const { prompt, negativePrompt } = composePortraitPrompt(entity, sheet, style);
    // A portrait reuses its own previous seed when one exists and the model
    // supports seed control, on purpose (composer.ts §2): re-rolling a
    // portrait without a seed change is how "regenerate" would silently drift
    // from the character players already recognise.
    const seed = provider.capabilities.seedControl ? sheet.appearance.seed : null;

    const reserved = world.illustrations.reserve({
      subject: { kind: 'portrait', entityId },
      visualStyle: style.visualStyle,
      prompt,
      negativePrompt,
      seed,
      provider: provider.id,
      createdScene: world.session.get().scene,
    });

    try {
      const result = await provider.generate({
        prompt,
        negativePrompt,
        seed,
        referenceImagePath: provider.capabilities.imageConditioning ? sheet.appearance.referenceImagePath : null,
        referenceStrength: 0.55,
      });
      const done = world.illustrations.complete(reserved.id, result.bytes, result.mimeType, result.seed);
      if (done) {
        world.cast.put({
          ...sheet,
          appearance: { ...sheet.appearance, referenceImagePath: world.illustrations.absolutePath(done), seed: result.seed },
        });
        return done;
      }
      throw new Error('illustration vanished immediately after being written');
    } catch (err) {
      const failed = world.illustrations.fail(reserved.id, err instanceof Error ? err.message : String(err));
      if (failed) return failed;
      throw err;
    }
  }

  /**
   * Generates a scene image for a turn: the location plus everyone present,
   * each conditioned through the same restated `Appearance` a portrait uses.
   * `turnId` is required — a scene illustration with no turn to hang off is
   * not distinguishable from a portrait's "no context" case, which is exactly
   * the ambiguity `IllustrationSubject`'s tagged union exists to rule out.
   */
  async illustrateScene(
    turnId: string,
    locationId: EntityId | null,
    presentIds: EntityId[],
    sceneDetail: string,
    overrideStyle?: VisualStyle,
  ): Promise<Illustration> {
    const world = this.getWorld();
    const provider = this.providers.get();
    if (!provider) throw new NoImageProviderError();

    const location = locationId ? world.graph.get(locationId) : undefined;
    const present: ScenePresence[] = presentIds
      .map((id) => world.graph.get(id))
      .filter((e): e is Entity => !!e)
      .map((entity) => ({ entity, sheet: world.cast.get(entity.id) }));

    const style = this.resolveStyle(overrideStyle);
    const { prompt, negativePrompt } = composeScenePrompt(location, present, style, sceneDetail);

    // Place consistency's second lever (composer.ts §3): if this location has
    // a prior scene image and the provider can condition on one, hand it the
    // last real look of the place rather than only its restated description.
    const reference = locationId ? world.illustrations.latestLocationReference(locationId) : undefined;
    const referencePath = reference ? world.illustrations.absolutePath(reference) : null;

    const reserved = world.illustrations.reserve({
      subject: { kind: 'scene', turnId, locationId },
      visualStyle: style.visualStyle,
      prompt,
      negativePrompt,
      seed: null, // scenes deliberately do not reuse a seed — see composer.ts §2
      provider: provider.id,
      createdScene: world.session.get().scene,
    });

    try {
      const result = await provider.generate({
        prompt,
        negativePrompt,
        referenceImagePath: provider.capabilities.imageConditioning ? referencePath : null,
        referenceStrength: 0.4, // looser than a portrait's: a scene should evolve, not repeat
      });
      const done = world.illustrations.complete(reserved.id, result.bytes, result.mimeType, result.seed);
      if (done) return done;
      throw new Error('illustration vanished immediately after being written');
    } catch (err) {
      const failed = world.illustrations.fail(reserved.id, err instanceof Error ? err.message : String(err));
      if (failed) return failed;
      throw err;
    }
  }
}
