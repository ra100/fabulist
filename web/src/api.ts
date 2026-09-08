/** Typed API client for the inspector. */

/**
 * Which of *this user's own* stories the current browser tab is looking at,
 * when a user has more than one and login is on. Server-side story
 * selection is now per-user (`worldFor`, `src/store/index.ts`) rather than
 * the old shared `CurrentStory` pointer every tab used to mutate for every
 * other tab and every other user — so "switch story" can no longer be a
 * server-side mutation with no request context. This is the client half of
 * that: a plain per-tab value (`sessionStorage`, not `localStorage` — a new
 * tab should land on "my most recently played," not inherit whichever
 * story an old tab happened to leave selected), appended as `?storyId=` to
 * every request once set. Reading it costs nothing when unset (the server
 * then falls back to "most recently played," exactly today's behaviour)
 * and nothing at all in login-off mode, where the server ignores the
 * parameter entirely.
 */
const STORY_ID_KEY = 'fabulist_story_id';

export function getSelectedStoryId(): string | null {
  try {
    return sessionStorage.getItem(STORY_ID_KEY);
  } catch {
    // Storage can throw in a locked-down embed/private-browsing context;
    // "no story selected" (the most-recently-played fallback) is a safe
    // default to fall back to, not a reason to break every request.
    return null;
  }
}

export function setSelectedStoryId(id: string | null): void {
  try {
    if (id) sessionStorage.setItem(STORY_ID_KEY, id);
    else sessionStorage.removeItem(STORY_ID_KEY);
  } catch {
    // Same reasoning as the read side above.
  }
}

/** Appends `?storyId=`/`&storyId=` to a path when one is selected, otherwise returns the path unchanged. */
function withStoryId(path: string): string {
  const id = getSelectedStoryId();
  if (!id) return path;
  return `${path}${path.includes('?') ? '&' : '?'}storyId=${encodeURIComponent(id)}`;
}

export interface Entity {
  id: string;
  type: string;
  layer: 'canon' | 'chronicle';
  name: string;
  summary: string;
  provenance: string;
  confidence: number;
  salience: number;
  depthLevel: number;
  props: Record<string, unknown>;
  createdScene: number;
}

export interface Edge {
  id: number;
  subject: string;
  predicate: string;
  object: string;
  layer: string;
  validFrom: number;
  validTo: number | null;
  weight: number;
  evidence: string | null;
}

export interface Vow {
  id: string;
  text: string;
  rank: number;
  broken: boolean;
  brokenScene: number | null;
}

export interface Appearance {
  description: string;
  attire: string;
  markers: string[];
  referenceImagePath: string | null;
  seed: number | null;
}

export interface Sheet {
  entityId: string;
  identity: {
    goals: string[]; wounds: string[]; fears: string[]; allegiances: string[];
    competencies: string[]; secrets: string[]; arc: string;
  };
  contract: { vows: Vow[]; drives: string[]; breakingPoint: string; costOfBreak: string };
  voice: { diction: string; tics: string[]; samples: string[]; never: string[] };
  condition: {
    locationId: string | null; mood: string; injuries: string[];
    inventory: string[]; intent: string; presentWith: string[];
  };
  appearance: Appearance;
  locks: string[];
  isPlayer: boolean;
}

export interface Thread {
  id: string; title: string; stakes: string; tension: number;
  parties: string[]; resolutions: string[]; status: string; createdScene: number;
}

export interface Consequence {
  id: string; causeEventId: string; actorId: string; actorName: string; action: string;
  visibility: 'onscreen' | 'offscreen-discoverable' | 'offscreen-hidden';
  maturity: 'pending' | 'ripening' | 'fired' | 'expired' | 'superseded';
  depth: number; significance: number; createdScene: number; firedScene: number | null;
  trigger: { kind: string; scenes?: number };
}

export type VisualStyle = 'realistic' | 'drawing' | 'sketch' | 'draft' | 'animation';
export const VISUAL_STYLES: Array<{ key: VisualStyle; label: string }> = [
  { key: 'realistic', label: 'realistic' },
  { key: 'drawing', label: 'drawing' },
  { key: 'sketch', label: 'sketch' },
  { key: 'draft', label: 'draft' },
  { key: 'animation', label: 'animation' },
];

export interface StyleContract {
  pov: string; tense: string; register: string; density: string; dialogueRatio: number;
  genreLens: string; humor: string; pacing: string; sceneTarget: number;
  comparables: string[]; forbidden: string[]; contentBounds: string[];
  visualStyle: VisualStyle; visualAnchor: string;
}

export interface Knobs {
  canonFidelity: string; characterStrictness: string; pacing: number; danger: number;
  npcAgency: number; propagationDepth: number; ignoranceBudget: number; proseDensity: number;
}

export interface WorldSummary {
  slug: string;
  title: string;
  storyCount: number;
  entityCount: number;
  lastPlayedAt: string;
  bytes: number;
  current: boolean;
}

export interface Story {
  id: string;
  title: string;
  /** Server-supplied rather than derived: see `GET /api/stories`. */
  current?: boolean;
  scene: number;
  turn: number;
  playerCharacterId: string;
  currentLocationId: string | null;
  forkedFrom: string | null;
  forkedAtScene: number | null;
  createdAt: string;
  lastPlayedAt: string;
}

export interface ForkResult {
  story: Story;
  copiedFrom: string | null;
  copiedUpToScene: number | null;
}

export interface State {
  worldTitle: string;
  session: { scene: number; turn: number; playerCharacterId: string; currentLocationId: string | null; style: StyleContract; knobs: Knobs };
  counts: { entities: number; edges: number; canon: number; chronicle: number };
  scenes: Array<{ scene: number; title: string; summary: string; chapter: number }>;
  threads: Thread[];
  directives: Array<{ id: string; text: string; strength: string; scope: string }>;
  pendingConsequences: number;
  hiddenFired: number;
  divergences: Array<{ id: number; scene: number; kind: string; detail: string }>;
  usage: { tokensIn: number; tokensOut: number; calls: number; byRole: Record<string, { tokensIn: number; tokensOut: number; calls: number }> };
}

export interface BookTurn {
  id: string; scene: number; turn: number; rawInput: string; bookProse: string;
  pinned: boolean; move: string | null; integrity: string | null; lintScore: number | null;
}

export interface Interrupt {
  message: string;
  options: Array<{ key: string; label: string; effect: string }>;
}

export type Outcome =
  | { kind: 'narrated'; prose: string; turn: { id: string; meta: TurnMeta } }
  | { kind: 'interrupted'; interrupt: Interrupt; distance: string; reasoning: string }
  | { kind: 'blocked'; reason: string; validation: { issues: Array<{ tier: string; message: string; repaired: boolean }> } }
  | { kind: 'answered'; text: string };

export interface TurnMeta {
  move: string | null;
  integrity: { distance: string; reasoning: string; violatedVows: string[] } | null;
  referee: { ruling: string; reasoning: string; cost: string | null } | null;
  lint: { score: number; tripped: boolean; findings: Array<{ rule: string; message: string; excerpt: string }> } | null;
  frameLog: FrameLog | null;
  providerCalls: Array<{ role: string; provider: string; model: string; tokensIn: number; tokensOut: number }>;
}

export interface FrameLog {
  budget: number;
  used: number;
  slots: Array<{ name: string; tokens: number }>;
  evicted: string[];
  compressed: string[];
}

export interface PlayResponse {
  outcome: Outcome;
  seeded: number;
  tick: { fired: Array<{ event: { text: string; visibility: string } }>; transmissions: unknown[] } | null;
}

export interface Fact {
  id: string; text: string; scene: number;
  knowers: Array<{ entityId: string; name: string; level: string; distortion: number }>;
}

export interface EntityDetail {
  entity: Entity;
  canon: Entity | null;
  sheet: Sheet | null;
  edgesOut: Edge[];
  edgesIn: Edge[];
  relationships: Array<{ toId: string; trust: number; affection: number; respect: number; note: string }>;
  relationshipsToward: Array<{ fromId: string; trust: number; affection: number; respect: number; note: string }>;
  knowledge: Array<{ factId: string; text: string; level: string; distortion: number }>;
}

export interface CausalityGraph {
  nodes: Array<{ id: string; kind: string; label: string; scene: number; visibility: string; fromConsequenceId: string | null }>;
  links: Array<{ from: string; to: string; kind: string; maturity: string }>;
}

export interface DirectiveResult {
  directive: { id: string; text: string };
  diff: {
    supersededConsequences: string[]; retimedConsequences: string[];
    raisedThreads: string[]; loweredThreads: string[];
    raisedThreadTitles: string[]; loweredThreadTitles: string[];
  };
}

// ---------------------------------------------------------------------- setup

export interface WikiCandidate {
  name: string;
  baseUrl: string;
  articles: number;
  language: string;
  via: 'directory' | 'slug' | 'search' | 'explicit';
  confidence: number;
}

export interface StartingPoint {
  title: string;
  kind: string;
  members: number;
}

export interface CharacterSketch {
  existing: string | null;
  name: string;
  role: string;
  goals: string[];
  vows: Array<{ text: string; rank: number }>;
}

/** Page/hop/pass-B budgets, in the wire form the server uses (`'all'`, never `Infinity`). */
export interface IngestBudgets {
  maxPages: number | 'all';
  hops: number | 'all';
  passBMaxPages: number | 'all';
}

/** What a caller may override per run; absent fields fall back to the mode preset. */
export type IngestBudgetOverrides = Partial<IngestBudgets>;

export type DepthMode = 'skim' | 'mid' | 'deep' | 'all';

export interface IngestPlan {
  seeds: string[];
  mode: DepthMode;
  reasoning: string;
  excludeCategories: string[];
  character: CharacterSketch;
  style: StyleContract;
  opening: string;
  startingPoints: StartingPoint[];
}

export interface DiscoveryPreview {
  candidatePages: number;
  byHop: Record<string, number>;
  byType: Record<string, number>;
  topEntities: Array<{ title: string; type: string; score: number; summary: string }>;
  characters: string[];
  factions: string[];
  locations: string[];
  estimatedTokens: number;
  estimatedCostUsd: number;
  seedCategories: string[];
}

export interface PreviewResult {
  preview: DiscoveryPreview;
  mode: DepthMode;
  seeds: string[];
  estimatedSeconds: number;
  /** The budgets the crawl actually ran with — preset plus any overrides. */
  budgets: IngestBudgets;
  previewKey: string;
}

/** What `/setup/discover`'s job resolves to: a preview plus a sharpened character. */
export interface DiscoverResult extends PreviewResult {
  character: CharacterSketch;
}

export interface IngestContext {
  baseUrl: string;
  mode: DepthMode;
  budgets?: Partial<IngestBudgets>;
  seeds: string[];
  excludeCategories: string[];
  title: string;
  wikiName: string;
}

/** What Settings shows about a world's ingest: whether one exists, and how much is left. */
export interface IngestHealth {
  hasContext: boolean;
  context: IngestContext | null;
  pagesDone: number;
  pagesFailed: number;
  pagesPending: number;
}

export interface Job<T = unknown> {
  id: string;
  kind: string;
  status: 'running' | 'done' | 'failed' | 'cancelled';
  progress: { stage: string; detail: string; current: number; total: number | null };
  log: string[];
  result: T | null;
  error: string | null;
}

export interface SetupStatus {
  fresh: boolean;
  /** Whether this book has a protagonist. A world can be full of canon and still have none. */
  hasPlayer: boolean;
  playerCharacterId: string;
}

/**
 * One shipped original world, as the picker sees it. Deliberately not the whole
 * pack: canon is seventy-odd entities with full sheets, and the gallery needs a
 * card rather than a world.
 */
export interface PackSummary {
  id: string;
  title: string;
  genre: 'science-fiction' | 'fantasy' | 'historical' | 'contemporary';
  blurb: string;
  premise: string;
  entities: number;
  scenarios: Array<{ id: string; title: string; premise: string; playerName: string }>;
}

export interface PackInstalled {
  storyId: string;
  scenarioId: string;
  title: string;
  playerCharacterId: string;
  opening: string;
  scenarios: Array<{ id: string; title: string; storyId: string }>;
  warnings: string[];
}

export interface ProbeResult {
  key: string;
  kind: string;
  model: string;
  auth: string;
  status: 'ready' | 'unavailable' | 'unknown';
  detail: string;
  fix: string;
  note?: string;
}

// ------------------------------------------------------------- illustration

export interface ComposedPrompt {
  prompt: string;
  negativePrompt: string;
}

export type IllustrationSubject =
  | { kind: 'scene'; turnId: string; locationId: string | null }
  | { kind: 'portrait'; entityId: string };

export interface Illustration {
  id: string;
  subject: IllustrationSubject;
  visualStyle: VisualStyle;
  prompt: string;
  negativePrompt: string;
  seed: number | null;
  provider: string;
  status: 'pending' | 'done' | 'failed';
  path: string | null;
  error: string | null;
  createdScene: number;
  createdAt: string;
}

export interface ImageProbeResult {
  key: string;
  kind: string;
  model: string;
  status: 'ready' | 'unavailable' | 'unknown';
  detail: string;
  fix: string;
}

export interface ImageProvidersReport {
  profile: string;
  results: ImageProbeResult[];
}

export interface ProvidersReport {
  profile: string;
  results: ProbeResult[];
  usableProfiles: string[];
  profiles: string[];
}

export interface ProviderSpec {
  kind: string;
  model: string;
  baseUrl?: string;
  auth?: string;
  apiKeyEnv?: string;
  dialect?: string;
  profile?: string;
  region?: string;
  project?: string;
  location?: string;
  allowUnofficial?: boolean;
  note?: string;
  capabilities?: Record<string, unknown>;
}

export interface AppConfig {
  profile: string;
  routes: Record<string, string>;
  providers: Record<string, ProviderSpec>;
  dbPath: string;
  proseLintThreshold: number;
  blocklist: string[];
  mockTokenDelayMs?: number;
}

export interface ConfigBundle {
  config: AppConfig;
  providerKeys: string[];
  profiles: string[];
  roles: string[];
  presets: Record<string, ProviderSpec | undefined>;
}

export interface ValidationIssue {
  field: string;
  message: string;
}

export interface PatchResult {
  config: AppConfig;
  issues: ValidationIssue[];
  registryRebuilt: boolean;
}

export interface CandidateCharacter {
  id: string;
  name: string;
  summary: string;
  salience: number;
  hasVows: boolean;
  connections: number;
}

async function req<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`/api${withStoryId(path)}`, {
    ...init,
    headers: { 'content-type': 'application/json', ...(init?.headers ?? {}) },
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error((body as { error?: string }).error ?? `${res.status} on ${path}`);
  return body as T;
}

const post = <T>(path: string, body?: unknown) =>
  req<T>(path, { method: 'POST', body: body === undefined ? undefined : JSON.stringify(body) });
const put = <T>(path: string, body: unknown) => req<T>(path, { method: 'PUT', body: JSON.stringify(body) });

export interface ServerMeta {
  routes: string[];
  startedAt: string;
}

/**
 * Mirrors `SessionUser` in `src/auth/config.ts`. `isAdmin` is what
 * `SettingsTab` (App.tsx) reads to decide whether to render the
 * system-wide panels (providers, config, ingest) at all — those routes
 * already 403 a non-admin server-side (`requireAdmin` in
 * `src/server/api.ts`), so hiding the controls client-side is a courtesy,
 * not the actual boundary; a non-admin poking the API directly still gets
 * refused.
 */
export interface CurrentUser {
  id: string;
  email: string;
  firstName: string | null;
  lastName: string | null;
  isAdmin: boolean;
}

/**
 * Routes this bundle needs that a server predating them will not have.
 *
 * Only the ones whose absence breaks a *visible* feature belong here: the point
 * is to explain a confusing 404 before the user hits it, not to assert that
 * every route matches. Append when a new tab or panel starts depending on a new
 * route.
 *
 * Exported so `test/api.test.ts` can assert every entry is actually served. A
 * typo or a renamed route here would fire the "page is newer than the server"
 * banner permanently against a perfectly healthy server — a false alarm in the
 * mechanism whose whole job is telling truth about staleness.
 */
export const REQUIRED_ROUTES = [
  'GET /api/meta',
  'GET /api/stories',
  'POST /api/stories',
  'POST /api/stories/fork',
  'POST /api/stories/:id/switch',
  'PUT /api/stories/:id/title',
  'DELETE /api/stories/:id',
  'GET /api/worlds',
  'POST /api/worlds',
  'POST /api/worlds/:slug/switch',
  'PUT /api/worlds/:slug/title',
  'DELETE /api/worlds/:slug',
  'GET /api/images/providers',
  'POST /api/images/profile',
] as const;

export interface StaleServer {
  missing: string[];
}

/**
 * Detects a server older than this page.
 *
 * `dist/` is a static bundle, so `pnpm build:web` while an old server keeps
 * running leaves the two out of step, and the symptom is a 404 from a control
 * that renders correctly. A server with no `/api/meta` at all is by definition
 * older than this check, which is why the fetch failing is itself a positive
 * result rather than an error to swallow.
 */
export async function checkServerFreshness(): Promise<StaleServer | null> {
  let meta: ServerMeta;
  try {
    meta = await req<ServerMeta>('/meta');
  } catch {
    // No /api/meta: predates this mechanism entirely.
    return { missing: [...REQUIRED_ROUTES] };
  }
  const have = new Set(meta.routes);
  const missing = REQUIRED_ROUTES.filter((r) => !have.has(r));
  return missing.length ? { missing } : null;
}

export const api = {
  meta: () => req<ServerMeta>('/meta'),
  /** `{ user: null }` is the honest, 200 answer when login is off entirely or this browser has no session — never an error to handle. */
  auth: { me: () => req<{ user: CurrentUser | null }>('/auth/me') },
  state: () => req<State>('/state'),
  /**
   * `minWeight` omitted lets the server apply its own default (0.5 — typed
   * relationships only, mentions excluded). Pass 0 to include everything.
   */
  graph: (params: { layer?: string; type?: string; limit?: number; minWeight?: number } = {}) => {
    const q = new URLSearchParams();
    if (params.layer) q.set('layer', params.layer);
    if (params.type) q.set('type', params.type);
    if (params.limit) q.set('limit', String(params.limit));
    if (params.minWeight !== undefined) q.set('minWeight', String(params.minWeight));
    return req<{ entities: Entity[]; edges: Edge[]; scene: number; hiddenEdges: number; minWeight: number }>(`/graph?${q}`);
  },
  entity: (id: string) => req<EntityDetail>(`/entity/${encodeURIComponent(id)}`),
  cast: () => req<Array<{ sheet: Sheet; entity: Entity | null }>>('/cast'),
  book: () => req<{ scenes: State['scenes']; turns: BookTurn[] }>('/book'),
  play: (input: string, overrideIntegrity = false) => post<PlayResponse>('/play', { input, overrideIntegrity }),
  turn: (id: string) => req<{ id: string; meta: TurnMeta; delta: unknown }>(`/turn/${encodeURIComponent(id)}`),
  pin: (id: string, pinned: boolean) => post(`/turn/${encodeURIComponent(id)}/pin`, { pinned }),
  /** Re-renders a turn's prose from its stored delta; what happened never changes. */
  regenerate: (id: string, note?: string) =>
    post<{ id: string; bookProse: string; pinned: boolean }>(`/turn/${encodeURIComponent(id)}/regenerate`, note ? { note } : {}),
  threads: () => req<Thread[]>('/threads'),
  updateThread: (id: string, patch: Partial<Thread>) => put<Thread>(`/thread/${encodeURIComponent(id)}`, patch),
  consequences: () => req<Consequence[]>('/consequences'),
  causality: () => req<CausalityGraph>('/causality'),
  facts: () => req<Fact[]>('/facts'),
  style: () => req<StyleContract>('/style'),
  setStyle: (patch: Partial<StyleContract>) => put<StyleContract>('/style', patch),
  knobs: () => req<Knobs>('/knobs'),
  setKnobs: (patch: Partial<Knobs>) => put<Knobs>('/knobs', patch),
  directives: () => req<Array<{ id: string; text: string; strength: string; scope: string }>>('/directives'),
  addDirective: (text: string, strength: string) => post<DirectiveResult>('/directive', { text, strength }),
  retireDirective: (id: string) => req(`/directive/${encodeURIComponent(id)}`, { method: 'DELETE' }),
  lock: (id: string, path: string, locked: boolean) => post(`/sheet/${encodeURIComponent(id)}/lock`, { path, locked }),
  saveSheet: (id: string, patch: Partial<Sheet>) => put<Sheet>(`/sheet/${encodeURIComponent(id)}`, patch),
  frames: () => req<Record<string, FrameLog>>('/frames'),
  tick: () => post<{ tick: unknown; notes: string[] }>('/tick'),
  anchors: () => req<Array<{ id: number; text: string; note: string }>>('/anchors'),
  addAnchor: (text: string, note: string) => post('/anchor', { text, note }),
  search: (q: string) => req<Entity[]>(`/search?q=${encodeURIComponent(q)}`),
  providers: () => req<ProvidersReport>('/providers'),
  closeScene: () =>
    post<{ closedScene: number; nowScene: number; summary: string | null; scenesSummarised: number[]; chaptersSummarised: number[] }>(
      '/scene/close',
    ),

  config: {
    get: () => req<ConfigBundle>('/config'),
    patch: (partial: Partial<AppConfig>) => put<PatchResult>('/config', partial),
    putProvider: (key: string, spec: ProviderSpec) => put<PatchResult>(`/config/provider/${encodeURIComponent(key)}`, spec),
    removeProvider: (key: string) => req<PatchResult>(`/config/provider/${encodeURIComponent(key)}`, { method: 'DELETE' }),
    testProvider: (key: string, spec: ProviderSpec) =>
      post<ProbeResult & { issues: ValidationIssue[] }>('/config/provider/test', { key, spec }),
    block: (phrase: string) => post<PatchResult>('/config/blocklist', { phrase }),
    unblock: (phrase: string) => post<PatchResult>('/config/blocklist', { phrase, remove: true }),
  },
  setProfile: (profile: string) => post<{ profile: string; ok: boolean; notes: string[] }>('/providers/profile', { profile }),

  illustrate: {
    portrait: (entityId: string, visualStyle?: VisualStyle) =>
      post<Illustration>(`/illustrate/portrait/${encodeURIComponent(entityId)}`, visualStyle ? { visualStyle } : {}),
    scene: (turnId: string, visualStyle?: VisualStyle) =>
      post<Illustration>(`/illustrate/scene/${encodeURIComponent(turnId)}`, visualStyle ? { visualStyle } : {}),
    /** The prompt alone, no provider required — the copy-paste fallback when no vision model is configured. */
    portraitPrompt: (entityId: string, visualStyle?: VisualStyle) =>
      req<ComposedPrompt>(`/illustrate/portrait/${encodeURIComponent(entityId)}/prompt${visualStyle ? `?visualStyle=${visualStyle}` : ''}`),
    scenePrompt: (turnId: string, visualStyle?: VisualStyle) =>
      req<ComposedPrompt>(`/illustrate/scene/${encodeURIComponent(turnId)}/prompt${visualStyle ? `?visualStyle=${visualStyle}` : ''}`),
    forTurn: (turnId: string) => req<Illustration[]>(`/illustrations/turn/${encodeURIComponent(turnId)}`),
    forEntity: (entityId: string) => req<Illustration[]>(`/illustrations/entity/${encodeURIComponent(entityId)}`),
    remove: (id: string) => req(`/illustration/${encodeURIComponent(id)}`, { method: 'DELETE' }),
    /** The bytes live behind this URL; components hand it straight to an `<img src>`. */
    imageUrl: (id: string) => withStoryId(`/api/illustration/${encodeURIComponent(id)}/image`),
  },
  images: {
    providers: () => req<ImageProvidersReport>('/images/providers'),
    setProfile: (profile: string | null) => post<{ profile: string; ok: boolean; notes: string[] }>('/images/profile', { profile }),
  },

  /**
   * Streams a turn. Narration arrives as it is written, which for a writing tool
   * is the difference between watching and waiting.
   */
  playStream: async (
    input: string,
    overrideIntegrity: boolean,
    handlers: {
      onStage?: (stage: string) => void;
      onToken?: (chunk: string) => void;
      onDone?: (res: PlayResponse) => void;
      onError?: (message: string) => void;
    },
  ): Promise<void> => {
    const res = await fetch(`/api${withStoryId('/play/stream')}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ input, overrideIntegrity }),
    });
    if (!res.ok || !res.body) {
      const body = await res.json().catch(() => ({}));
      handlers.onError?.((body as { error?: string }).error ?? `stream failed (${res.status})`);
      return;
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let event = '';

    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      let newline = buffer.indexOf('\n');
      while (newline >= 0) {
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        if (line.startsWith('event:')) {
          event = line.slice(6).trim();
        } else if (line.startsWith('data:')) {
          const payload = line.slice(5).trim();
          try {
            const data = JSON.parse(payload) as Record<string, never>;
            if (event === 'stage') handlers.onStage?.(String(data.stage));
            else if (event === 'token') handlers.onToken?.(String(data.chunk));
            else if (event === 'done') handlers.onDone?.(data as unknown as PlayResponse);
            else if (event === 'error') handlers.onError?.(String(data.error));
          } catch {
            // A partial event; the next read completes it.
          }
        }
        newline = buffer.indexOf('\n');
      }
    }
  },

  stories: {
    list: () => req<Story[]>('/stories'),
    create: (title?: string) => post<Story>('/stories', title ? { title } : {}),
    /** `fromStoryId` defaults server-side to whichever story is current; pass it explicitly to fork a story other than the one currently open, with no switch required. */
    fork: (fromStoryId: string, title?: string, atScene?: number) =>
      post<ForkResult>('/stories/fork', { fromStoryId, ...(title ? { title } : {}), ...(atScene !== undefined ? { atScene } : {}) }),
    switchTo: (id: string) => post<{ current: string }>(`/stories/${encodeURIComponent(id)}/switch`),
    rename: (id: string, title: string) => put<{ id: string; title: string }>(`/stories/${encodeURIComponent(id)}/title`, { title }),
    remove: (id: string) => req<{ ok: boolean }>(`/stories/${encodeURIComponent(id)}`, { method: 'DELETE' }),
  },

  /**
   * Worlds are files; stories are rows inside one. Switching a world closes one
   * database and opens another, so unlike a story switch it invalidates every
   * cached view — callers should refetch state wholesale afterwards.
   */
  worlds: {
    list: () => req<{ current: string | null; worlds: WorldSummary[] }>('/worlds'),
    create: (title?: string) => post<WorldSummary>('/worlds', title ? { title } : {}),
    switchTo: (slug: string) => post<{ current: string }>(`/worlds/${encodeURIComponent(slug)}/switch`),
    rename: (slug: string, title: string) => put<WorldSummary>(`/worlds/${encodeURIComponent(slug)}/title`, { title }),
    remove: (slug: string) => req<{ ok: boolean }>(`/worlds/${encodeURIComponent(slug)}`, { method: 'DELETE' }),
  },

  setup: {
    status: () => req<SetupStatus>('/setup/status'),
    resolve: (query: string) => post<{ candidates: WikiCandidate[] }>('/setup/resolve', { query }),
    plan: (wish: string, wiki: WikiCandidate) => post<IngestPlan>('/setup/plan', { wish, wiki }),
    preview: (
      baseUrl: string,
      seeds: string[],
      mode: string,
      excludeCategories: string[] = [],
      title = '',
      budgets: IngestBudgetOverrides = {},
    ) => post<PreviewResult>('/setup/preview', { baseUrl, seeds, mode, excludeCategories, title, ...budgets }),
    discover: (
      baseUrl: string,
      seeds: string[],
      mode: string,
      character: CharacterSketch,
      excludeCategories: string[] = [],
      title = '',
      budgets: IngestBudgetOverrides = {},
    ) => post<Job<DiscoverResult>>('/setup/discover', { baseUrl, seeds, mode, character, excludeCategories, title, ...budgets }),
    ingest: (previewKey: string, character: CharacterSketch, style: Partial<StyleContract>, opening: string) =>
      post<Job>('/setup/ingest', { previewKey, character, style, opening }),
    custom: (description: string, style?: Partial<StyleContract>) => post<Job>('/setup/custom', { description, style }),
    sample: () => post<{ playerCharacterId: string; opening: string }>('/setup/sample'),
    packs: () => req<{ packs: PackSummary[] }>('/setup/packs'),
    pack: (packId: string, scenarioId?: string) => post<PackInstalled>('/setup/pack', { packId, scenarioId }),
    job: (id: string) => req<Job>(`/setup/job/${encodeURIComponent(id)}`),
    cancel: (id: string) => post<{ cancelled: boolean }>(`/setup/job/${encodeURIComponent(id)}/cancel`),
    characters: () => req<CandidateCharacter[]>('/setup/characters'),
    setPlayer: (sketch: Partial<CharacterSketch>) => post<{ playerCharacterId: string; created: boolean; warnings: string[]; opening: string }>('/setup/player', sketch),
    reset: () => post<{ ok: boolean }>('/setup/reset'),
    ingestHealth: () => req<IngestHealth>('/setup/ingest-health'),
    continue: (
      overrides: { seeds?: string[]; mode?: string; excludeCategories?: string[] } & IngestBudgetOverrides = {},
    ) => post<Job>('/setup/continue', overrides),
  },
};
