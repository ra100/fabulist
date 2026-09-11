import { z } from 'zod';

export const playBodySchema = z.object({
  input: z.string().trim().min(1, 'input required'),
  overrideIntegrity: z.boolean().optional(),
}).strict();

const nonEmptyText = z.string().trim().min(1);
const shortText = z.string().max(10_000);

export const createThreadBodySchema = z.object({
  title: nonEmptyText,
  stakes: shortText.optional(),
  tension: z.number().min(0).max(1).optional(),
  parties: z.array(nonEmptyText).optional(),
  resolutions: z.array(shortText).optional(),
}).strict();

export const updateThreadBodySchema = z.object({
  title: nonEmptyText.optional(),
  stakes: shortText.optional(),
  tension: z.number().min(0).max(1).optional(),
  status: z.enum(['open', 'resolved', 'abandoned']).optional(),
}).strict();

export const directiveBodySchema = z.object({
  text: nonEmptyText,
  scope: z.enum(['scene', 'chapter', 'campaign']).optional(),
  strength: z.enum(['hint', 'push', 'mandate']).optional(),
  lifetimeScenes: z.number().int().nonnegative().nullable().optional(),
}).strict();

export const styleBodySchema = z.object({
  pov: z.enum(['first', 'third-limited', 'third-omniscient', 'second']).optional(),
  tense: z.enum(['past', 'present']).optional(),
  register: z.enum(['plain', 'clipped', 'lyrical', 'ornate', 'archaic']).optional(),
  density: z.enum(['sparse', 'balanced', 'rich']).optional(),
  dialogueRatio: z.number().min(0).max(1).optional(),
  genreLens: shortText.optional(),
  humor: z.enum(['none', 'dry', 'absurd']).optional(),
  pacing: z.enum(['languid', 'steady', 'breakneck']).optional(),
  sceneTarget: z.number().int().positive().optional(),
  comparables: z.array(shortText).optional(),
  forbidden: z.array(shortText).optional(),
  contentBounds: z.array(shortText).optional(),
  visualStyle: z.enum(['realistic', 'drawing', 'sketch', 'draft', 'animation']).optional(),
  visualAnchor: shortText.optional(),
}).strict();

export const knobsBodySchema = z.object({
  canonFidelity: z.enum(['strict', 'flexible', 'au']).optional(),
  characterStrictness: z.enum(['permissive', 'coaching', 'strict', 'iron']).optional(),
  pacing: z.number().min(0).max(1).optional(),
  danger: z.number().min(0).max(1).optional(),
  npcAgency: z.number().min(0).max(1).optional(),
  propagationDepth: z.number().int().min(1).max(5).optional(),
  ignoranceBudget: z.number().int().nonnegative().optional(),
  proseDensity: z.number().min(0).max(1).optional(),
}).strict();
