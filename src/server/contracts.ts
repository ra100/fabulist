import { z } from 'zod';

/**
 * Closed transport contracts for mutation-heavy JSON routes.
 *
 * Deliberate exclusions: raw world database uploads are byte streams bounded in
 * `http.ts`; MCP payloads follow the MCP SDK's own versioned protocol; and
 * provider `capabilities` remain open-ended because capability keys are supplied
 * by provider implementations. Read-only query strings and no-body actions are
 * validated in their handlers rather than represented as request-body schemas.
 */

export const playBodySchema = z.object({
  input: z.string().trim().min(1, 'input required'),
  overrideIntegrity: z.boolean().optional(),
}).strict();

const nonEmptyText = z.string().trim().min(1);
const shortText = z.string().max(10_000);
const optionalTitle = z.string().max(500).optional();
const stringList = z.array(shortText);
const visualStyle = z.enum(['realistic', 'drawing', 'sketch', 'draft', 'animation']);

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

const vowSchema = z.object({
  id: nonEmptyText,
  text: nonEmptyText,
  rank: z.number().int().positive(),
  broken: z.boolean(),
  brokenScene: z.number().int().nonnegative().nullable(),
}).strict();

export const sheetBodySchema = z.object({
  identity: z.object({
    goals: stringList,
    wounds: stringList,
    fears: stringList,
    allegiances: stringList,
    competencies: stringList,
    secrets: stringList,
    arc: shortText,
  }).strict().optional(),
  contract: z.object({
    vows: z.array(vowSchema),
    drives: stringList,
    breakingPoint: shortText,
    costOfBreak: shortText,
  }).strict().optional(),
  voice: z.object({
    diction: shortText,
    tics: stringList,
    samples: stringList,
    never: stringList,
  }).strict().optional(),
  condition: z.object({
    locationId: z.string().nullable(),
    mood: shortText,
    injuries: stringList,
    inventory: stringList,
    intent: shortText,
    presentWith: z.array(z.string()),
  }).strict().optional(),
  appearance: z.object({
    description: shortText.optional(),
    attire: shortText.optional(),
    markers: stringList.optional(),
  }).strict().optional(),
  locks: z.array(nonEmptyText).optional(),
}).strict();

export const sheetLockBodySchema = z.object({
  path: nonEmptyText,
  locked: z.boolean().optional(),
}).strict();

export const turnPinBodySchema = z.object({ pinned: z.boolean().optional() }).strict().default({});
export const regenerateBodySchema = z.object({ note: shortText.optional() }).strict().default({});

export const knowledgeBodySchema = z.object({
  entityId: nonEmptyText,
  level: z.enum(['knows', 'suspects', 'wrong']),
  distortion: z.number().min(0).max(1).optional(),
  sinceScene: z.number().int().nonnegative().optional(),
}).strict();

export const illustrationBodySchema = z.object({ visualStyle: visualStyle.optional() }).strict().default({});
export const imageProfileBodySchema = z.object({ profile: nonEmptyText.nullable().optional() }).strict().default({});
export const profileBodySchema = z.object({ profile: nonEmptyText }).strict();

export const createStoryBodySchema = z.object({ title: optionalTitle }).strict().default({});
const encryptedKeyEnvelopeSchema = z.object({
  nonce: z.string().regex(/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/, 'invalid base64'),
  ciphertext: z.string().regex(/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/, 'invalid base64'),
}).strict();
export const encryptionEnrollmentBodySchema = z.object({
  userKey: z.object({
    version: z.literal(1),
    passphraseKdf: z.literal('pbkdf2-sha256'),
    passphraseKdfParams: z.object({ iterations: z.literal(600_000) }).strict(),
    passphraseSalt: z.string().regex(/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/, 'invalid base64'),
    passphraseWrap: encryptedKeyEnvelopeSchema,
    recoverySalt: z.string().regex(/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/, 'invalid base64'),
    recoveryWrap: encryptedKeyEnvelopeSchema,
    recoveryCodeHint: z.string().regex(/^[A-Za-z0-9_-]{4,32}$/),
  }).strict(),
  storyKeys: z.array(z.object({
    storyId: nonEmptyText,
    version: z.literal(1),
    wrap: encryptedKeyEnvelopeSchema,
  }).strict()).min(1),
}).strict();
export const forkStoryBodySchema = z.object({
  title: optionalTitle,
  atScene: z.number().int().nonnegative().optional(),
  fromStoryId: nonEmptyText.optional(),
}).strict();
export const renameBodySchema = z.object({ title: nonEmptyText }).strict();
export const rollbackBodySchema = z.object({
  scene: z.number().int().nonnegative().optional(),
  chapter: z.number().int().positive().optional(),
  mode: z.enum(['fork', 'destructive']).optional(),
}).strict().refine((body) => (body.scene === undefined) !== (body.chapter === undefined), {
  message: 'provide exactly one of scene or chapter',
});
export const sqliteBranchBodySchema = z.object({
  atScene: z.number().int().nonnegative(),
  toPath: nonEmptyText,
  overwrite: z.boolean().optional(),
}).strict();
export const pgBranchBodySchema = z.object({
  atScene: z.number().int().nonnegative(),
  title: optionalTitle,
}).strict();

export const storySourcesBodySchema = z.object({
  slugs: z.array(nonEmptyText).min(1),
}).strict();
export const visibilityBodySchema = z.object({ visibility: z.enum(['public', 'private']) }).strict();
export const worldAccessBodySchema = z.object({
  userId: nonEmptyText,
  role: z.enum(['reader', 'ingest', 'owner']).optional(),
}).strict();
export const personalBlocklistBodySchema = z.object({
  pattern: nonEmptyText,
  note: shortText.optional(),
}).strict();
const depthMode = z.enum(['skim', 'mid', 'deep', 'all']);
const budget = z.union([z.number().int().positive(), z.literal('all')]);
const budgets = {
  maxPages: budget.optional(),
  hops: budget.optional(),
  passBMaxPages: budget.optional(),
};
const characterSketchSchema = z.object({
  existing: z.string().nullable().default(null),
  name: shortText.default(''),
  role: shortText.default(''),
  goals: stringList.default([]),
  vows: z.array(z.object({ text: nonEmptyText, rank: z.number().int().positive() }).strict()).default([]),
}).strict();
const wikiCandidateSchema = z.object({
  name: nonEmptyText,
  baseUrl: z.string().url(),
  articles: z.number().int().nonnegative(),
  language: nonEmptyText,
  via: z.enum(['directory', 'slug', 'search', 'explicit']),
  confidence: z.number().min(0).max(1),
}).strict();
const setupScope = {
  baseUrl: z.string().url(),
  seeds: z.array(nonEmptyText).min(1),
  mode: depthMode.optional(),
  excludeCategories: stringList.optional(),
  title: shortText.optional(),
  ...budgets,
};

export const setupResolveBodySchema = z.object({ query: nonEmptyText }).strict();
export const setupPlanBodySchema = z.object({ wish: nonEmptyText, wiki: wikiCandidateSchema }).strict();
export const setupPreviewBodySchema = z.object(setupScope).strict();
export const setupDiscoverBodySchema = z.object({ ...setupScope, character: characterSketchSchema.optional() }).strict();
export const setupIngestBodySchema = z.object({
  previewKey: nonEmptyText,
  character: characterSketchSchema.optional(),
  style: styleBodySchema.optional(),
  opening: shortText.optional(),
}).strict();
export const setupCustomBodySchema = z.object({
  description: nonEmptyText,
  style: styleBodySchema.optional(),
}).strict();
export const setupPackBodySchema = z.object({
  packId: nonEmptyText,
  scenarioId: nonEmptyText.optional(),
}).strict();
export const setupPlayerBodySchema = characterSketchSchema;
export const setupContinueBodySchema = z.object({
  seeds: z.array(nonEmptyText).optional(),
  mode: depthMode.optional(),
  excludeCategories: stringList.optional(),
  ...budgets,
}).strict();

const playOutcomeSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('narrated'), prose: z.string(), turn: z.object({ id: z.string(), meta: z.unknown() }).passthrough() }).passthrough(),
  z.object({ kind: z.literal('interrupted'), interrupt: z.object({
    message: z.string(),
    options: z.array(z.object({ key: z.string(), label: z.string(), effect: z.string() }).strict()),
  }).strict(), distance: z.string(), reasoning: z.string() }).strict(),
  z.object({ kind: z.literal('blocked'), reason: z.string(), validation: z.object({
    issues: z.array(z.object({ tier: z.string(), message: z.string(), repaired: z.boolean() }).strict()),
  }).strict() }).strict(),
  z.object({ kind: z.literal('answered'), text: z.string() }).strict(),
]);

export const playResponseSchema = z.object({
  outcome: playOutcomeSchema,
  seeded: z.number().int().nonnegative(),
  tick: z.object({
    fired: z.array(z.object({ event: z.object({ text: z.string(), visibility: z.string() }).passthrough() }).passthrough()),
    transmissions: z.array(z.unknown()),
  }).passthrough().nullable(),
}).strict();

export const stateResponseSchema = z.object({
  worldTitle: z.string(),
  session: z.object({
    scene: z.number().int().nonnegative(),
    turn: z.number().int().nonnegative(),
    playerCharacterId: z.string(),
    currentLocationId: z.string().nullable(),
    style: styleBodySchema,
    knobs: knobsBodySchema,
  }).strict(),
  counts: z.object({
    entities: z.number().int().nonnegative(),
    edges: z.number().int().nonnegative(),
    canon: z.number().int().nonnegative(),
    chronicle: z.number().int().nonnegative(),
  }).strict(),
  scenes: z.array(z.object({
    scene: z.number().int().nonnegative(),
    title: z.string(),
    summary: z.string(),
    chapter: z.number().int().positive(),
  }).passthrough()),
  threads: z.array(z.object({ id: z.string(), title: z.string() }).passthrough()),
  directives: z.array(z.object({
    id: z.string(),
    text: z.string(),
    strength: z.string(),
    scope: z.string(),
  }).passthrough()),
  pendingConsequences: z.number().int().nonnegative(),
  hiddenFired: z.number().int().nonnegative(),
  divergences: z.array(z.object({
    id: z.number(),
    scene: z.number(),
    kind: z.string(),
    detail: z.string(),
  }).passthrough()),
  usage: z.object({
    tokensIn: z.number().nonnegative(),
    tokensOut: z.number().nonnegative(),
    calls: z.number().int().nonnegative(),
    byRole: z.record(z.object({
      tokensIn: z.number().nonnegative(),
      tokensOut: z.number().nonnegative(),
      calls: z.number().int().nonnegative(),
    }).strict()),
  }).strict(),
}).strict();

export const storyResponseSchema = z.object({
  id: z.string(),
  title: z.string(),
  current: z.boolean().optional(),
  scene: z.number(),
  turn: z.number(),
  playerCharacterId: z.string(),
  currentLocationId: z.string().nullable(),
  forkedFrom: z.string().nullable(),
  forkedAtScene: z.number().nullable(),
  createdAt: z.string(),
  lastPlayedAt: z.string(),
}).passthrough();
export const storiesResponseSchema = z.array(storyResponseSchema);
export const worldsResponseSchema = z.object({ worlds: z.array(z.object({
  slug: z.string(),
  title: z.string(),
}).passthrough()) }).passthrough();
