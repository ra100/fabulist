# Decision log

This is the short, current record of durable product and engineering choices.
Detailed rationale and implementation evidence remain in the linked design notes.

| Decision | Status | Rationale / source |
| --- | --- | --- |
| State is authoritative; prose is a rendering of it. | Active | Typed deltas make consistency, re-rendering, and rollback possible. [Design](../DESIGN.md) |
| Keep the Referee, Director, and Narrator separate. | Active | Truth, intent, and prose are incompatible responsibilities in one prompt. [Design](../DESIGN.md) |
| Use TypeScript on Node 26, SQLite/Postgres stores, `node:http`, and a small adapter layer. | Active | Minimal deployment surface and independently testable domain logic. [Plan](../PLAN.md) |
| Canon is shared; chronicle state is story-scoped. | Active | Supports independent stories in one world without copying canon. [Schema rationale](../.design/GAPS.md) |
| Prefer safe forks for rollback; destructive rollback is explicit. | Active | Authors can recover a prior state without silently losing the original story. Exact turn rollback retains the selected turn. [Design](../DESIGN.md) |
| Do not implement in-place retcon. | Deliberate non-goal | Directives steer the future; changing history branches instead. [Gap review](../.design/GAPS.md) |
| Use a conservative, pluggable token heuristic rather than provider BPEs. | Active | Predictable budget enforcement without provider-specific dependencies. [Plan](../PLAN.md) |
| Do not add vector retrieval until FTS/trigram retrieval demonstrably fails. | Deferred | Graph locality is fast; section text plus FTS is the cheaper observable next step. [Database review](../.design/DBFIXES.md) |
| Hosted use is free: no subscriptions, ads, analytics, or model-spend markup. | Policy | Users bring provider credentials; abuse controls are not billing. [Multi-user rationale](../.design/SAAS-MULTIUSER.md) |
| Private stories use encryption at rest, not zero knowledge. | Active pilot | The server may process unlocked plaintext transiently; database/filesystem copies must not reveal it. [Encryption design](../.design/ENCRYPTION.md) |
| MCP is one standards-based server, not separate Claude/OpenAI integrations. | Active | The transport is implemented; public multi-user deployment waits on request-scoped identity and authorization. [MCP rationale](../.design/MCP-CONNECTOR.md) |
| Mechanical roles do not stream. | Deliberate non-goal | Partial structured output is not useful; only narration streams. [Gap review](../.design/GAPS.md) |

When changing one of these choices, update this log and the linked detailed rationale in the same change.
