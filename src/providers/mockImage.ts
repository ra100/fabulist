/**
 * Deterministic mock image provider.
 *
 * Same reasoning as `providers/mock.ts` for text: the illustration pipeline —
 * composer, store, routes, UI — has to be testable with no network and no
 * credentials, and a placeholder image has to be a *real* image (a valid PNG
 * a browser will decode), not a stub string, or the store/UI code paths that
 * touch actual bytes go untested.
 *
 * The picture itself is deliberately plain: a flat colour field derived from
 * hashing the prompt, so two calls with the same prompt render identically
 * (useful for asserting reference-image reuse) and different prompts render
 * visibly differently (useful for confirming a portrait and a scene are not
 * the same bytes by accident). It is not trying to look like anything; it
 * exists to prove the machinery, exactly like the text mock's deliberately
 * plain prose.
 */
import { deflateSync } from 'node:zlib';
import type { ImageCapabilities, ImageProvider, ImageRequest, ImageResult } from './image.ts';

function hash(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

function crc32(buf: Uint8Array): number {
  let crc = ~0;
  for (let i = 0; i < buf.length; i++) {
    let c = (crc ^ buf[i]!) & 0xff;
    for (let k = 0; k < 8; k++) c = c & 1 ? (c >>> 1) ^ 0xedb88320 : c >>> 1;
    crc = (crc >>> 8) ^ c;
  }
  return ~crc >>> 0;
}

function chunk(type: string, data: Buffer): Buffer {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, 'ascii');
  const body = Buffer.concat([typeBuf, data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([len, typeBuf, data, crc]);
}

/** A minimal, dependency-free, uncompressed-filter PNG encoder. Flat colour only — enough to be a real decodable image. */
export function flatPng(width: number, height: number, rgb: [number, number, number]): Buffer {
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // colour type: RGB
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;
  const rowLen = 1 + width * 3;
  const raw = Buffer.alloc(rowLen * height);
  const [r, g, b] = rgb;
  for (let y = 0; y < height; y++) {
    raw[y * rowLen] = 0; // no filter
    for (let x = 0; x < width; x++) {
      const o = y * rowLen + 1 + x * 3;
      raw[o] = r;
      raw[o + 1] = g;
      raw[o + 2] = b;
    }
  }
  const idat = deflateSync(raw);
  return Buffer.concat([sig, chunk('IHDR', ihdr), chunk('IDAT', idat), chunk('IEND', Buffer.alloc(0))]);
}

export interface MockImageOptions {
  id?: string;
  capabilities?: Partial<ImageCapabilities>;
  /** Call log, so tests can assert what was requested. */
  calls?: ImageRequest[];
}

export class MockImageProvider implements ImageProvider {
  readonly id: string;
  readonly model = 'mock-image-1';
  readonly capabilities: ImageCapabilities;
  readonly calls: ImageRequest[] = [];

  constructor(opts: MockImageOptions = {}) {
    this.id = opts.id ?? 'mock';
    this.capabilities = {
      imageConditioning: true,
      seedControl: true,
      costTier: 'free',
      qualityTier: 0.2,
      ...opts.capabilities,
    };
  }

  async generate(req: ImageRequest): Promise<ImageResult> {
    this.calls.push(req);
    const seed = req.seed ?? hash(req.prompt);
    // Hue from the seed, not the raw prompt hash, so a caller that reuses a
    // seed on purpose (the consistency lever) visibly gets the same colour
    // even when the prompt text has grown a scene's worth of extra detail.
    const h = seed % 360;
    const rgb = hslToRgb(h, 0.35, 0.45);
    return {
      bytes: new Uint8Array(flatPng(64, 64, rgb)),
      mimeType: 'image/png',
      seed,
      model: this.model,
    };
  }
}

function hslToRgb(h: number, s: number, l: number): [number, number, number] {
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
  const m = l - c / 2;
  let [r, g, b] = [0, 0, 0];
  if (h < 60) [r, g, b] = [c, x, 0];
  else if (h < 120) [r, g, b] = [x, c, 0];
  else if (h < 180) [r, g, b] = [0, c, x];
  else if (h < 240) [r, g, b] = [0, x, c];
  else if (h < 300) [r, g, b] = [x, 0, c];
  else [r, g, b] = [c, 0, x];
  return [Math.round((r + m) * 255), Math.round((g + m) * 255), Math.round((b + m) * 255)];
}
