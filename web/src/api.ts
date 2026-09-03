/** Typed API client for the inspector. */

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

export interface StyleContract {
  pov: string; tense: string; register: string; density: string; dialogueRatio: number;
  genreLens: string; humor: string; pacing: string; sceneTarget: number;
  comparables: string[]; forbidden: string[]; contentBounds: string[];
}

export interface Knobs {
  canonFidelity: string; characterStrictness: string; pacing: number; danger: number;
  npcAgency: number; propagationDepth: number; ignoranceBudget: number; proseDensity: number;
}

export interface State {
  session: { scene: number; turn: number; playerCharacterId: string; currentLocationId: string | null; style: StyleContract; knobs: Knobs };
  counts: { entities: number; edges: number; canon: number; chronicle: number };
  scenes: Array<{ scene: number; title: string; summary: string; chapter: number }>;
  threads: Thread[];
  directives: Array<{ id: string; text: string; strength: string; scope: string }>;
  pendingConsequences: number;
  hiddenFired: number;
  divergences: Array<{ id: number; scene: number; kind: string; detail: string }>;
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

async function req<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`/api${path}`, {
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

export const api = {
  state: () => req<State>('/state'),
  graph: (params: { layer?: string; type?: string; limit?: number } = {}) => {
    const q = new URLSearchParams();
    if (params.layer) q.set('layer', params.layer);
    if (params.type) q.set('type', params.type);
    if (params.limit) q.set('limit', String(params.limit));
    return req<{ entities: Entity[]; edges: Edge[]; scene: number }>(`/graph?${q}`);
  },
  entity: (id: string) => req<EntityDetail>(`/entity/${encodeURIComponent(id)}`),
  cast: () => req<Array<{ sheet: Sheet; entity: Entity | null }>>('/cast'),
  book: () => req<{ scenes: State['scenes']; turns: BookTurn[] }>('/book'),
  play: (input: string, overrideIntegrity = false) => post<PlayResponse>('/play', { input, overrideIntegrity }),
  turn: (id: string) => req<{ id: string; meta: TurnMeta; delta: unknown }>(`/turn/${encodeURIComponent(id)}`),
  pin: (id: string, pinned: boolean) => post(`/turn/${encodeURIComponent(id)}/pin`, { pinned }),
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
};
