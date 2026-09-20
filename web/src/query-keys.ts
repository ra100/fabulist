// Central TanStack Query keys. Every story-scoped request goes through
// withStoryId() in api.ts, so every key carries the selected story: switching
// stories swaps the whole cache slice instead of racing an in-flight refetch
// from the old story into the new one.
export const queryKeys = {
  appState: (storyId: string | null) => ['app-state', storyId] as const,
  book: (storyId: string | null) => ['book', storyId] as const,
  turnMeta: (storyId: string | null, turnId: string) => ['turn-meta', storyId, turnId] as const,
  timeline: (storyId: string | null, revision: number) => ['timeline', storyId, revision] as const,
  threads: (storyId: string | null) => ['threads', storyId] as const,
  facts: (storyId: string | null) => ['facts', storyId] as const,
  consequences: (storyId: string | null) => ['consequences', storyId] as const,
  cast: (storyId: string | null) => ['cast', storyId] as const,
  graph: (storyId: string | null, layer: string, type: string, showMentions: boolean) =>
    ['graph', storyId, layer, type, showMentions] as const,
  entity: (storyId: string | null, entityId: string) => ['entity', storyId, entityId] as const,
  graphSearch: (storyId: string | null, q: string) => ['graph-search', storyId, q] as const,
  chapters: (storyId: string | null) => ['chapters', storyId] as const,
  style: (storyId: string | null) => ['style', storyId] as const,
  knobs: (storyId: string | null) => ['knobs', storyId] as const,
  anchors: (storyId: string | null) => ['anchors', storyId] as const,
  providers: (storyId: string | null) => ['providers', storyId] as const,
  imageProviders: (storyId: string | null) => ['image-providers', storyId] as const,
  imagesStatus: (storyId: string | null) => ['images-status', storyId] as const,
  illustrationGallery: (storyId: string | null, entityId: string) => ['illustration-gallery', storyId, entityId] as const,
  sceneIllustrations: (storyId: string | null, turnId: string) => ['scene-illustrations', storyId, turnId] as const,
  configBundle: (storyId: string | null) => ['config-bundle', storyId] as const,
  stories: (storyId: string | null) => ['stories', storyId] as const,
  setupJob: (storyId: string | null, jobId: string) => ['setup-job', storyId, jobId] as const,
  setupCharacters: (storyId: string | null) => ['setup-characters', storyId] as const,
  setupPacks: (storyId: string | null) => ['setup-packs', storyId] as const,
  ingestHealth: (storyId: string | null) => ['ingest-health', storyId] as const,
  authMe: () => ['auth-me'] as const,
  serverMeta: () => ['server-meta'] as const,
  serverFreshness: () => ['server-freshness'] as const,
  privateStorage: (userId: string | null) => ['private-storage', userId] as const,
};
