/**
 * ComfyUI adapter — the local, free, no-API-key image path.
 *
 * Mirrors the existing local-server story for text (`ollama:*`, `vllm:local`,
 * `llamacpp:local` in `providers/http.ts`): Fabulist does not bundle model
 * weights — that is a distribution and licensing problem, not a design
 * problem — it documents the wire format and expects `python main.py` to
 * already be running. `pnpm providers` already tells you "nothing listening
 * at 127.0.0.1:8080, here is the start command"; this adapter's probe entry
 * does the identical thing for `127.0.0.1:8188`.
 *
 * ComfyUI's API is a graph of nodes submitted as one JSON object
 * (`POST /prompt`), polled via `GET /history/<id>` until the output node has
 * written a file, then fetched from `GET /view`. What Fabulist owns is one
 * documented default graph — a plain checkpoint-loader → CLIP-encode →
 * KSampler → VAE-decode → save-image txt2img graph, the same shape every
 * ComfyUI tutorial ships — with named placeholder fields this module fills
 * in. A user who already has a preferred workflow (an img2img graph with an
 * IP-Adapter node for real reference-image conditioning, a ControlNet graph,
 * anything) can supply their own graph JSON via `ComfyUIOptions.workflow` and
 * this adapter fills the same placeholders into it, so upgrading the actual
 * consistency mechanism from "prompt-only" to "real image conditioning" is a
 * config change, not a code change.
 */
import type { ImageCapabilities, ImageProvider, ImageRequest, ImageResult } from './image.ts';

/** The bundled txt2img graph. Node ids match a vanilla ComfyUI install's default `workflow_api.json` export. */
export function defaultWorkflow(checkpoint: string): Record<string, unknown> {
  return {
    '3': {
      class_type: 'KSampler',
      inputs: {
        seed: 0,
        steps: 24,
        cfg: 7,
        sampler_name: 'dpmpp_2m',
        scheduler: 'karras',
        denoise: 1,
        model: ['4', 0],
        positive: ['6', 0],
        negative: ['7', 0],
        latent_image: ['5', 0],
      },
    },
    '4': { class_type: 'CheckpointLoaderSimple', inputs: { ckpt_name: checkpoint } },
    '5': { class_type: 'EmptyLatentImage', inputs: { width: 1024, height: 640, batch_size: 1 } },
    '6': { class_type: 'CLIPTextEncode', inputs: { text: '', clip: ['4', 1] } },
    '7': { class_type: 'CLIPTextEncode', inputs: { text: '', clip: ['4', 1] } },
    '8': { class_type: 'VAEDecode', inputs: { samples: ['3', 0], vae: ['4', 2] } },
    '9': { class_type: 'SaveImage', inputs: { filename_prefix: 'fabulist', images: ['8', 0] } },
  };
}

/**
 * Fills the placeholders a graph is expected to expose. Node ids are the
 * bundled default's; a custom workflow declares its own mapping via
 * `ComfyUIOptions.nodeMap` when its node ids differ.
 */
export interface ComfyNodeMap {
  positivePrompt: string;
  negativePrompt: string;
  seed: string;
  width: string;
  height: string;
  saveImage: string;
}

export const DEFAULT_NODE_MAP: ComfyNodeMap = {
  positivePrompt: '6',
  negativePrompt: '7',
  seed: '3',
  width: '5',
  height: '5',
  saveImage: '9',
};

export interface ComfyUIOptions {
  baseUrl?: string;
  /** Checkpoint filename as ComfyUI's model directory sees it. Wrong values are the #1 failure mode, same as vLLM's model id. */
  checkpoint?: string;
  workflow?: Record<string, unknown>;
  nodeMap?: ComfyNodeMap;
  capabilities?: Partial<ImageCapabilities>;
  fetcher?: typeof fetch;
  timeoutMs?: number;
  /** Poll interval while waiting for the queued job to finish. */
  pollMs?: number;
}

interface HistoryEntry {
  outputs?: Record<string, { images?: Array<{ filename: string; subfolder: string; type: string }> }>;
}

export class ComfyUIProvider implements ImageProvider {
  readonly id = 'comfyui';
  readonly model: string;
  readonly capabilities: ImageCapabilities;
  private baseUrl: string;
  private workflow: Record<string, unknown>;
  private nodeMap: ComfyNodeMap;
  private fetcher: typeof fetch;
  private timeoutMs: number;
  private pollMs: number;

  constructor(opts: ComfyUIOptions = {}) {
    this.baseUrl = (opts.baseUrl ?? 'http://127.0.0.1:8188').replace(/\/$/, '');
    this.model = opts.checkpoint ?? 'default';
    this.workflow = opts.workflow ?? defaultWorkflow(this.model);
    this.nodeMap = opts.nodeMap ?? DEFAULT_NODE_MAP;
    this.fetcher = opts.fetcher ?? fetch;
    this.timeoutMs = opts.timeoutMs ?? 180_000;
    this.pollMs = opts.pollMs ?? 800;
    this.capabilities = {
      // A vanilla txt2img graph has neither lever; both become true the
      // moment a user swaps in a workflow that has an image-input node and a
      // seed the graph actually threads through — declared here, not probed,
      // because there is no reliable way to introspect an arbitrary graph's
      // semantics from its JSON shape alone.
      imageConditioning: false,
      seedControl: true,
      costTier: 'free',
      qualityTier: 0.6,
      ...opts.capabilities,
    };
  }

  async generate(req: ImageRequest): Promise<ImageResult> {
    const graph = structuredClone(this.workflow);
    const set = (nodeId: string, patch: Record<string, unknown>) => {
      const node = graph[nodeId] as { inputs: Record<string, unknown> } | undefined;
      if (node) Object.assign(node.inputs, patch);
    };

    const seed = req.seed ?? Math.floor(Math.random() * 2 ** 32);
    set(this.nodeMap.positivePrompt, { text: req.prompt });
    set(this.nodeMap.negativePrompt, { text: req.negativePrompt ?? '' });
    set(this.nodeMap.seed, { seed });
    if (req.width) set(this.nodeMap.width, { width: req.width });
    if (req.height) set(this.nodeMap.height, { height: req.height });

    const clientId = `fabulist-${Date.now()}`;
    const queued = (await this.postJson('/prompt', { prompt: graph, client_id: clientId })) as { prompt_id?: string };
    const promptId = queued.prompt_id;
    if (!promptId) throw new Error('comfyui: /prompt did not return a prompt_id — is the workflow valid for this install?');

    const entry = await this.awaitHistory(promptId);
    const outputs = entry.outputs?.[this.nodeMap.saveImage]?.images;
    const image = outputs?.[0];
    if (!image) throw new Error(`comfyui: no image produced by node ${this.nodeMap.saveImage} — check the SaveImage node id matches nodeMap.saveImage`);

    const bytes = await this.fetchImage(image);
    return { bytes, mimeType: 'image/png', seed, model: this.model };
  }

  private async postJson(path: string, body: unknown): Promise<unknown> {
    const res = await this.fetcher(`${this.baseUrl}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error(`comfyui ${path} returned ${res.status}: ${(await res.text().catch(() => '')).slice(0, 300)}`);
    return res.json();
  }

  private async awaitHistory(promptId: string): Promise<HistoryEntry> {
    const deadline = Date.now() + this.timeoutMs;
    for (;;) {
      const res = await this.fetcher(`${this.baseUrl}/history/${promptId}`);
      if (res.ok) {
        const history = (await res.json()) as Record<string, HistoryEntry>;
        const entry = history[promptId];
        if (entry?.outputs) return entry;
      }
      if (Date.now() > deadline) throw new Error(`comfyui: job ${promptId} did not finish within ${this.timeoutMs}ms`);
      await new Promise((r) => setTimeout(r, this.pollMs));
    }
  }

  private async fetchImage(img: { filename: string; subfolder: string; type: string }): Promise<Uint8Array> {
    const q = new URLSearchParams({ filename: img.filename, subfolder: img.subfolder, type: img.type });
    const res = await this.fetcher(`${this.baseUrl}/view?${q}`);
    if (!res.ok) throw new Error(`comfyui: could not fetch generated image (${res.status})`);
    return new Uint8Array(await res.arrayBuffer());
  }
}

/** Cheap liveness probe, same shape as `providers/probe.ts`'s `reachable()` for local text servers. */
export async function comfyReachable(baseUrl = 'http://127.0.0.1:8188', fetcher: typeof fetch = fetch, timeoutMs = 2500): Promise<boolean> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetcher(`${baseUrl}/system_stats`, { signal: controller.signal });
    return res.status > 0;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}
