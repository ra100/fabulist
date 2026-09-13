# Forward plan

The project has completed its original engine slices. This is a priority order, not
a promise to build every item. Start an item only when its entry condition is met.

## Next: validate and close local-product gaps

1. **Run a real integrity-interrupt session.** Assess prose quality and whether the
   interrupt reads as collaborative rather than punitive; revise copy only from that
   evidence. See [the gap review](../.design/GAPS.md) §4.2.
2. **Make existing depth and branch controls reachable.** Add the branch scene picker
   and expose ingest depth/deepening in the UI. This connects tested engine behavior
   before new engine work. See [the gap review](../.design/GAPS.md) §§1.3, 1.6, 3.2.
3. **Improve ingest boundaries.** Filter distribution/real-world metadata from canon
   and revisit inbound-link ranking only after a representative live ingest exposes a
   material quality problem. See [the gap review](../.design/GAPS.md) §§4.7–4.8.

## Then: searchable, attributable source material

1. Decide that metadata and source manifests are world-scoped.
2. Persist revisioned section text, with clear retention and attribution rules.
3. Add FTS5 for sections and trigram name/alias lookup; evaluate results before
   considering embeddings.

This sequence preserves the existing legal posture and gives retrieval an observable
corpus. See [the database review](../.design/DBFIXES.md) B1–C2 and
[the legal briefing](legal-briefing-fandom-ingest.md).

## Later: multi-user and connector deployment

1. Replace process-global current world/story selection with request-scoped identity,
   world access, story ownership, and permission checks.
2. Only then expose a public MCP endpoint and connect OAuth subjects to app access.
3. Revisit story sharing, collaboration, and encrypted-MCP key grants after the
   identity boundary is proven.

No billing, paid tier, or operator-paid model calls are planned. See
[the multi-user rationale](../.design/SAAS-MULTIUSER.md),
[the MCP rationale](../.design/MCP-CONNECTOR.md), and
[the encryption design](../.design/ENCRYPTION.md).

## Explicitly deferred or declined

- Vector search: require a concrete FTS/trigram failure.
- Real BPE tokenization: require measured budget errors.
- In-world chronology: require real timeline queries.
- Shared canon situation layer: require exported/shared worlds.
- In-place retcon and streaming mechanical roles: deliberate non-goals.

Before starting a roadmap item, add acceptance criteria and an evidence source to its
implementation issue or design note. Move completed items to the relevant detailed
record rather than growing this file into a changelog.
