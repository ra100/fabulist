# SQLite Search / Vector / Graph Options for a Narrative Knowledge Graph

**Verification basis:** all benchmarks below were **measured on this machine** (Node **v24.10.0**, bundled SQLite **3.50.4**, Apple Silicon, in-memory DBs). Repo/package status was verified via GitHub and npm registry APIs on **2026-09-05**. Items marked *estimate* were not measured.

---

## 1. FTS5 and extension loading in `node:sqlite`

**FTS5 is compiled in — verified two ways.**

`PRAGMA compile_options` on Node 24.10.0 reports: `ENABLE_FTS5`, `ENABLE_FTS3`, `ENABLE_FTS4`(via FTS3), `ENABLE_RTREE`, `ENABLE_GEOPOLY`, `ENABLE_MATH_FUNCTIONS`, `ENABLE_DBSTAT_VTAB`, `ENABLE_SESSION`, `ENABLE_RBU`, `ENABLE_COLUMN_METADATA`. Executing `CREATE VIRTUAL TABLE ... USING fts5(...)` succeeds, as do `bm25()`, `snippet()`, `fts5vocab`, `tokenize='trigram'`, `tokenize='porter unicode61'`, and `content=''` (contentless) tables.

**Version history — this is the important detail.** I bisected `deps/sqlite/sqlite.gyp` across release tags:

| Tag | `SQLITE_ENABLE_FTS5` |
|---|---|
| v22.5.0 – v22.15.0 | **absent** |
| **v22.16.0**+ | **present** |
| v23.0.0 – **v23.11.0 (all of 23.x)** | **absent** |
| **v24.0.0**+ | **present** |

So: **FTS5 landed in Node 24.0.0 and was backported to 22.16.0. It is in no Node 23.x release at all.** Node 23 is EOL, so this only matters if you support Node 22 — require `>=22.16.0`. Do not assume FTS5 from "Node 22 supports node:sqlite"; probe at startup:

```js
try { db.exec("CREATE VIRTUAL TABLE temp.__fts_probe USING fts5(x)"); } catch { /* no FTS5 */ }
```

**Extension loading is supported.** `loadExtension(path[, entryPoint])` and `enableLoadExtension(allow)` were added in **v23.5.0 / v22.13.0** ([PR #53900](https://github.com/nodejs/node/pull/53900), per CHANGELOG_V22). You must pass `{ allowExtension: true }` to the constructor; `enableLoadExtension(true)` cannot re-enable it if the constructor said `false`. Verified live: without the flag it throws `extension loading is not allowed`; with it, a bad path produces a real `dlopen` error — the dynamic loader is genuinely wired up, not stubbed. Note `loadExtension` appends the platform suffix (`foo.dylib` → `foo.dylib.dylib`), so pass the base name.

Stability as of the current docs: **Release candidate (1.2)** since v25.7.0; still `ExperimentalWarning` on 24.10.0.

**Other SQL features — all verified OK on 24.10.0:** generated columns (STORED and VIRTUAL), partial indexes, expression indexes **including `CREATE INDEX ... (json_extract(col,'$.k'))`**, window functions, `RETURNING`, `STRICT` tables, `json_each`, math functions, `dbstat`. Also available: user-defined functions (`db.function`), window/aggregate functions (`db.aggregate`), `serialize`/`deserialize`, `backup()`, and an authorizer.

## 2. Vector options preserving "one portable file"

### sqlite-vec — actively maintained, and it works with `node:sqlite`

**Verified:** repo `asg017/sqlite-vec` is **not archived**, 8,075 stars, last push **2026-05-18**. npm `latest` = **0.1.9** (2026-03-31); `alpha` = 0.1.10-alpha.4 (2026-05-18) with real bug-fix commits (IVF shadow-table renames, statement finalization). A Mozilla Builders project, also sponsored by Fly.io/Turso/SQLite Cloud. Caveat straight from the README: **"pre-v1, so expect breaking changes."** Cadence has slowed — ~4 months since the last commit at time of writing — so treat it as maintained-but-not-fast-moving.

**Verified working end-to-end** with `node:sqlite` on Node 24.10.0: `npm i sqlite-vec` → `new DatabaseSync(path, { allowExtension: true })` → `sqliteVec.load(db)` → `vec_version()` returns `v0.1.9`. **Dependency weight: 20 KB JS + a 162 KB `vec0.dylib`** (one small optional dep per platform: darwin-arm64/x64, linux-x64/arm64, windows-x64). This is the key advantage.

**Gotcha worth writing down:** `node:sqlite` binds JS `number` as REAL, so a `vec0` `integer primary key` insert **fails** with *"Only integers are allows for primary key values"*. Pass **`BigInt(id)`**. Verified: `run(1, buf)` fails, `run(1n, buf)` succeeds.

**Capabilities (verified):** `vec0` virtual tables; `float[N]`, `int8[N]`, and `bit[N]` column types (so int8 and binary quantization are supported); `vec_quantize_int8`, `vec_normalize`, `vec_distance_cosine`, `vec_distance_l2`; metadata columns usable in `WHERE` during KNN; auxiliary (`+col`) columns for payloads that cannot be filtered; and `partition key` columns for sharding the index. Docs note `vec_quantize_binary`/`vec_distance_hamming` exist but my call signatures errored — verify separately if you need binary. **KNN is brute-force by default**; IVF/ANN is in-progress (0.1.10-alpha commits reference IVF shadow tables) — do not plan on ANN today.

**Measured `vec0` KNN, k=10, single query (mean of 10):**

| N | 384d | 768d | 1536d |
|---|---|---|---|
| 10k | **0.6 ms** | 1.2 ms | 2.5 ms |
| 50k | 2.8 ms | 5.6 ms | 12.2 ms |
| 200k | 11.8 ms | 24.8 ms | 49.2 ms |

Adding a metadata filter (`AND layer='L2'`, 1/5 selectivity) made it slightly *faster* (9.8 ms at 200k×384). Insert throughput: 200k×768 in ~3.1 s.

### sqlite-vss — effectively dead

**Verified:** last push **2024-05-05** (~2.3 years stale). Not formally archived, but sqlite-vec's own README calls itself "a successor to sqlite-vss". **Do not use.**

### LanceDB embedded — capable, heavy

**Verified:** `@lancedb/lancedb` **0.38.0** (2026-08-31), actively released. **Cost: the `darwin-arm64` binary alone unpacks to 232 MB**, with a separate prebuilt per platform (7 platform packages). It is also a *separate directory-based store*, not your SQLite file — you'd run two datastores and lose single-file atomicity. Disproportionate for "garnish" embeddings.

### DuckDB + VSS — wrong shape here

**Verified:** `@duckdb/node-api` 1.5.5-r.4 (2026-08-11); `duckdb/duckdb-vss` active (last push 2026-09-03). Native binding unpacks to **117 MB**. DuckDB is an OLAP engine: excellent for analytical scans, but a poor fit for the many small point-lookups and single-row writes of interactive narrative retrieval. VSS's HNSW index also historically has persistence caveats. Second engine, second file format.

### libSQL / Turso — has native vectors, but a moving target

**Verified:** `tursodatabase/libsql` active (17.2k stars, last push 2026-08-26), `@libsql/client` 0.18.0 (2026-09-02). libSQL is a SQLite fork with **built-in vector types and indexes — no runtime extension needed**. But Turso's effort has visibly shifted to `tursodatabase/turso`, a **Rust SQLite rewrite** (24.2k stars, pushed 2026-09-05, "experimental" Postgres support). Switching means leaving `node:sqlite` for a native addon and betting on which of two codebases is the future. Not worth it for garnish.

### Brute-force cosine in TypeScript over a BLOB column

**Measured** (Float32 BLOBs, single-threaded JS dot product, full scan):

| N | dims | Read-from-SQLite + score | Pre-loaded in RAM | Float32 memory |
|---|---|---|---|---|
| 10k | 384 | **9.6 ms** | 4.7 ms | 14.6 MB |
| 50k | 384 | 39.7 ms | 12.3 ms | 73 MB |
| 200k | 384 | 157 ms | 45.6 ms | 293 MB |
| 10k | 768 | **11.9 ms** | 4.6 ms | 29 MB |
| 50k | 768 | 58.7 ms | 23.0 ms | 147 MB |
| 200k | 768 | 231 ms | 95.0 ms | 586 MB |
| 10k | 1536 | 20.5 ms | 9.3 ms | 59 MB |
| 50k | 1536 | 97.5 ms | 50.7 ms | 293 MB |
| 200k | 1536 | **412 ms** | 187 ms | **1.17 GB** |

**Where it stops being fine:** under ~20k vectors at 384–768d it is genuinely fine (~10–25 ms, no dependency). The **50k row is the inflection point** (40–100 ms per query — noticeable but survivable if queries are rare). At **200k it is not viable** for interactive use: 0.16–0.41 s per query, and at 1536d the RAM cache exceeds 1 GB. Note `DatabaseSync` is **synchronous** — a 400 ms scan blocks the event loop outright. sqlite-vec is **~8–13× faster** at the same N/dims for a 162 KB dependency, which is the whole argument.

## 3. Embedded graph databases

### Kùzu — CONFIRMED wound down

**Refuting nothing; the report is correct.** The GitHub API reports `kuzudb/kuzu` **`archived: true`**, last push 2025-10-10. The README states it verbatim:

> "Kuzu is working on something new! We are archiving the KuzuDB project here… For those using Kuzu currently, prior Kuzu releases will continue to be usable… we have a new release 0.11.3 that bundles many (but not all) of the extensions."

Final release **v0.11.3, 2025-10-10** (npm `kuzu@0.11.3`, same date). Docs/blog moved to `kuzudb.github.io/docs`. Critically, **the extension server that older versions download from is gone** — pre-0.11.3 installs must migrate to 0.11.3 or self-host an extension server. **Do not adopt Kùzu.** It was the strongest technical fit (embedded property graph, Cypher, built-in FTS *and* vector index), which makes this a real loss, but archived-upstream is disqualifying for a datastore.

### Alternatives

- **DuckDB + recursive CTEs / DuckPGQ** — `cwida/duckpgq-extension` is active (487 stars, 2026-08-17) and implements SQL/PGQ. Research-grade; plus the 117 MB binding and OLAP mismatch above.
- **Neo4j embedded** — the embedded Java API still exists but is not a serious option for a Node project: JVM in-process, and Neo4j has steered users to the server protocol for years. Skip.
- **Oxigraph / RDF** — genuinely healthy (`oxigraph` npm 0.5.11, 2026-09-02; last push 2026-09-05). But it's SPARQL/RDF: you'd remodel your character sheets and overlay layers as triples, and **temporal validity in RDF needs reification or named graphs** — strictly harder than two integer columns. Only justified if you want SPARQL/ontology reasoning.

### Are plain recursive CTEs sufficient? — Yes, measured

On a synthetic **200k-edge / 40k-entity** temporal edge table with `INDEX(src, valid_from, valid_to)`:

| Query | Time |
|---|---|
| 1-hop, temporal filter | **0.01 ms** |
| 2-hop self-join, temporal filter both hops | **0.03 ms** |
| Recursive CTE, depth ≤ 3 | 0.01 ms |
| Recursive CTE, depth ≤ 5 | 0.01 ms |

Edge table + index totalled 7.4 MB. **For 1–2 hop traversal from "present" entities, SQL is not the bottleneck and never will be** — it is microseconds against a token-budget assembly step that costs milliseconds. Recursive CTEs handle temporal multi-hop fine as long as you (a) index `(src, valid_from, valid_to)`, (b) use `UNION` not `UNION ALL` to dedupe cycles, and (c) carry an explicit depth column and cap it. Where SQL genuinely gets ugly: variable-length shortest-path, weighted pathfinding, and unbounded traversals over dense graphs. None of those are in your retrieval description. **Keep the node/edge tables.**

## 4. Practical guidance: what to actually add

Your retrieval is graph-first and deterministic; embeddings are garnish. That argues for the smallest thing that covers the cases graph traversal genuinely cannot.

**Where embeddings actually beat traversal (and FTS5):**
- **Paraphrase lookup** — "the scene where she forgives him" when the text never says *forgive*. BM25 fails on zero lexical overlap.
- **"Find the passage that sounds like this"** — tone/voice matching is what dense vectors are uniquely good at; there is no lexical proxy.
- **Entity resolution / dedupe across aliases** — near-identical entities and wiki alias variants.

**Where FTS5 is as good or better, cheaper:** exact names, epithets, quoted phrases, and rare proper nouns. BM25 beats embeddings on rare-term precision — embeddings tend to smear distinctive names into neighbours.

**Important:** for *fuzzy name resolution* and *dedupe*, reach for FTS5 first, not embeddings. FTS5's **`tokenize='trigram'`** (verified available) gives substring/typo-tolerant matching, and cheap deterministic tricks — normalized/`soundex`-style keys, Jaro-Winkler or Levenshtein in TS over the small candidate set from a trigram prefilter — are more predictable and debuggable than cosine on names. Reserve embeddings for the genuinely semantic cases: paraphrase and tone.

**Comparison:**

- **FTS5-only.** Zero new dependencies (verified in-tree ≥24.0.0 / ≥22.16.0). Measured: indexing 50k sections (~150 words each) took **578 ms**; BM25 top-10 = **0.69 ms**, two-term AND = 0.46 ms, phrase = 0.04 ms, `snippet()` = 0.04 ms, prefix = 7.4 ms. Covers exact/phrase/prefix/trigram-fuzzy plus snippet extraction. **Misses paraphrase and tone-matching entirely.**
- **FTS5 + small embedding table (recommended).** Embed only what benefits: section-level wiki text and entity alias strings — likely **hundreds to low thousands of vectors**, not 200k. At that scale, **brute-force cosine in TS over a BLOB column is ~1 ms and needs no dependency at all** (measured 10k×384 = 9.6 ms, so 1k ≈ 1 ms). Store as `BLOB` (Float32Array), keep a `model`/`dim` column for re-embedding. This keeps one file, zero native deps, and full portability. Add sqlite-vec later *only if* the vector count crosses ~20k.
- **Full vector DB (LanceDB/DuckDB/libSQL).** Buys ANN and scale you do not have. Costs 117–232 MB of platform binaries, a second store, and loss of single-file atomicity. **Not justified for garnish.**

**Hybrid retrieval.** When you do combine, use **Reciprocal Rank Fusion** rather than trying to normalize BM25 against cosine (they aren't on comparable scales): `score(d) = Σ 1/(k + rank_i(d))`, k≈60. Take top-50 from FTS5 and top-50 from vectors, fuse, then feed the fused list into your existing priority-slot budget. RRF is a handful of lines of TS and needs no tuning, which fits a deterministic-retrieval system: **keep graph traversal as the spine and let fused text/vector hits fill discretionary slots only**, so a bad embedding can never evict a structurally required entity.

## 5. SQLite scale and limits sanity check

- **Row counts.** 20k–200k entity rows is small — SQLite handles this trivially; the practical DB-size ceiling is terabytes and `MAX_PAGE_COUNT=0xfffffffe`. Your 200k-edge traversal ran in 0.03 ms. **Scale is not your risk.** Verified limits on this build: `MAX_VARIABLE_NUMBER=32766` (matters for bulk `IN (...)` — chunk your parameter lists), `MAX_COLUMN=2000`, `MAX_ATTACHED=10`, `MAX_LENGTH=1e9`.
- **JSON1 performance.** Measured on 100k rows with a ~250-byte JSON sheet: `WHERE json_extract(sheet,'$.faction')='f7'` = **18.3 ms unindexed** (full scan, re-parsing JSON per row). Adding `CREATE INDEX ... (json_extract(sheet,'$.faction'))` → **0.2 ms** (a **90×** win; plan confirms `SEARCH ... USING COVERING INDEX`). A `VIRTUAL` generated column plus an index performs identically (0.2 ms) and is more readable. **Guidance: index any JSON path you filter on; treat unindexed `json_extract` as a full scan.** For array membership, `json_each` as a table-valued join was fast (0.04 ms with LIMIT). Consider the `jsonb` functions in SQLite 3.45+ (you have 3.50.4) to skip re-parsing.
- **WAL growth — reproduced exactly.** I recreated your symptom: rewriting the same 200 rows over 300 transactions produced a **72 KB db with a 4,072 KB WAL** — essentially your 320 KB / 4.6 MB observation. **Cause:** a WAL grows by *appended page images per commit*, not by logical data size; the same hot page is written again in every transaction. It is only reclaimed at a **checkpoint**, and a checkpoint cannot copy pages back while any reader holds an older snapshot. `wal_autocheckpoint` defaults to **1000 pages (~4 MB at 4 KB pages)** — which is precisely where your 4.6 MB file plateaued, so this is **normal, bounded behaviour, not a leak**. Also `journal_size_limit` is **-1** (unlimited), so after a checkpoint the WAL is *reused in place* and stays large on disk rather than shrinking. **Fixes, verified:** `db.exec('PRAGMA wal_checkpoint(TRUNCATE)')` took the WAL to **0 KB**; a clean `close()` also removes it. Set `PRAGMA journal_size_limit=<bytes>` (e.g. 1–4 MB) so it self-truncates; consider `PRAGMA synchronous=NORMAL` under WAL for write throughput; and avoid long-lived read transactions/open iterators, which block checkpointing. Run `wal_checkpoint(TRUNCATE)` at a natural quiet point (e.g. after a scene commits). Remember the WAL and `-shm` mean "one portable file" is really three while open — `VACUUM INTO 'snapshot.db'` (or `database.backup()`) is the correct way to hand out a single clean file.
- **Also worth knowing:** `DEFAULT_MMAP_SIZE=0` — enabling `PRAGMA mmap_size` can speed large read scans. `THREADSAFE=1`, but `DatabaseSync` is synchronous and blocks the event loop, so push heavy scans to a `worker_thread`. Set a `timeout` (busy timeout defaults to **0**) if more than one connection writes.

## Decision table

| Option | What it buys | Cost | Verdict |
|---|---|---|---|
| **FTS5 (built-in)** | BM25, phrase/prefix, trigram fuzzy, `snippet()`. Measured 0.7 ms top-10 over 50k sections | Zero deps. Requires Node **≥24.0.0 or ≥22.16.0** (absent in all 23.x) | **Adopt now.** Highest value per unit of cost |
| **Brute-force cosine over BLOB (TS)** | Paraphrase + tone matching with no dependency; ~1 ms at 1k vectors | Fine <20k; 40–100 ms at 50k; unusable at 200k (0.16–0.41 s, blocks event loop) | **Adopt for the "garnish" tier** — embed only sections + aliases |
| **sqlite-vec** | vec0 tables, 8–13× faster KNN (11.8 ms @200k×384), metadata filters, int8/bit quantization | 162 KB native ext per platform; `allowExtension: true`; pre-v1 breaking changes; needs `BigInt` PKs; no ANN yet | **Keep in reserve.** Adopt if vectors exceed ~20k |
| **sqlite-vss** | — | Last push 2024-05-05; superseded | **Reject** |
| **LanceDB** | Real ANN, scale far beyond your needs | **232 MB** per-platform binary; second store; loses single-file atomicity | **Reject** (disproportionate) |
| **DuckDB + VSS** | Analytical SQL + HNSW | **117 MB** binding; OLAP engine vs. point-lookup workload; second file format | **Reject** |
| **libSQL / Turso** | Native vectors, no extension loading | Leaves `node:sqlite` for a native addon; effort split with Rust rewrite `turso` | **Reject for now**; revisit if you outgrow SQLite |
| **Kùzu** | Embedded property graph, Cypher, built-in FTS + vector | **Repo archived; final release v0.11.3 (2025-10-10); extension server retired** | **Reject — confirmed wound down** |
| **Oxigraph / RDF** | SPARQL, ontology reasoning | Healthy, but full remodel; temporal validity needs reification/named graphs | **Reject** unless you want SPARQL |
| **Neo4j embedded** | — | JVM in-process; long-deprecated usage pattern for non-JVM apps | **Reject** |
| **Plain SQL recursive CTEs (status quo)** | 1–2 hop temporal traversal at **0.01–0.03 ms** on 200k edges | Needs `INDEX(src, valid_from, valid_to)`, `UNION` for cycles, depth cap | **Keep.** Genuinely sufficient — do not replace |

**Minimal sensible addition, in order:** (1) require Node ≥24 (or ≥22.16.0) and add an **FTS5** index over section wiki text with `bm25()` + `snippet()`; (2) add a **trigram** FTS5 index over entity names/aliases for fuzzy resolution and dedupe candidate generation; (3) add a small `embedding` table (`entity_id`/`section_id`, `model`, `dim`, `vec BLOB`) covering only sections and aliases, scored brute-force in TS, fused with FTS5 via **RRF (k=60)** into discretionary budget slots only; (4) set `PRAGMA journal_size_limit` and checkpoint with `wal_checkpoint(TRUNCATE)` at scene boundaries. Defer sqlite-vec until the vector count crosses ~20k — at which point it is a 162 KB drop-in, not a migration.
