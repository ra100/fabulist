# PrismML Bonsai (1-bit / Ternary LLMs) for On-Device WebGPU Inference

**Verification basis:** researched via direct HTTP fetches of primary sources (PrismML's own docs
at `docs.prismml.com`, GitHub repos, Hugging Face Space READMEs) plus independent technical
write-ups, on **2026-09-07**. Hugging Face's own domain (`huggingface.co`) is blocked by this
network's proxy category filter, so model-card details came from mirrors, GitHub raw READMEs, and
PrismML's own docs quoting HF repo names — not from browsing HF directly. No benchmark in this
document was run locally; all numbers are as published by PrismML or by independent bloggers,
carried with their original sourcing so the reader can judge reliability per claim.

---

## 1. What Bonsai is

**Bonsai** is a family of open-weight (Apache 2.0) LLMs from **PrismML**, a Caltech-spinout lab
(Babak Hassibi's group) that emerged from stealth **March 31, 2026**. The pitch: models trained
*natively* at 1-bit or ternary precision from scratch — not post-training quantization of an
FP16 model. Weights are 1-bit (`{-1, +1}`) or ternary/"1.58-bit" (`{-1, 0, +1}`), applied
uniformly across embeddings, attention, MLP, and the LM head — "no higher-precision escape
hatches," per PrismML's own framing.

There is also an **unrelated, older, much smaller "Bonsai"**: `deepgrove/Bonsai`, a 500M-parameter
ternary-weight research model on Hugging Face, trained on <5B tokens, Llama-architecture with a
Mistral tokenizer. It predates PrismML's Bonsai and is a different project by a different org
(`deepgrove-ai`). The user's question ("Prism Bonsai") is about PrismML's family — this document
covers that one throughout. Do not conflate the two if `deepgrove/Bonsai` shows up in future
searches; it has no WebGPU story and is not commercially positioned.

### Model sizes (PrismML family)

| Model | Params | 1-bit size | Ternary size | FP16 reference | Max context | Modalities |
|---|---|---|---|---|---|---|
| Bonsai 1.7B | 1.7B | ~0.24–0.25 GB | — | — | — | Text |
| Bonsai 4B | 4B | ~0.545 GB | — | — | — | Text |
| Bonsai 8B | 8.2B | **1.15–1.16 GB** | 2.18 GB | 16.38 GB | 65,536 tok (native 16,384, YaRN ×4) | Text |
| Bonsai 27B | 27B | 3.53–3.92 GiB | 6.66–7.05 GiB | ~54 GB | 262,144 tok | Text + image in (base: Qwen3.6-27B) |

Bonsai 27B is a *hybrid* architecture (Qwen3.5/3.6-style: ~75% gated-DeltaNet linear-attention
layers, ~25% full attention) — only 16 of 64 layers grow a full KV cache, which is why the 262K
context stays practical on modest hardware. The 1.7B/4B/8B are dense Qwen3-architecture models.

**Source:** [PrismML docs — Introduction](https://docs.prismml.com/get-started/introduction),
[Bonsai 8B model page](https://docs.prismml.com/models/bonsai-8b),
[Bonsai 27B model page](https://docs.prismml.com/models/bonsai-27b),
[PrismML launch post](https://prismml.com/news/bonsai-8b) (2026-03-31).

### Benchmark claim (PrismML's own numbers, take with the caveat below)

PrismML's launch post claims Bonsai 8B (1.15 GB) scores 70.5 average across MMLU-Redux, MuSR,
GSM8K, HumanEval+, IFEval, BFCLv3 — comparable to Qwen3 8B (79.3, at 16.38 GB) and ahead of
several other FP16 8B-class models on that suite. PrismML frames this via a self-defined
**"intelligence density"** metric (negative log of average error rate, divided by model size in
GB): Bonsai 8B scores 1.06/GB vs. Qwen3 8B's 0.10/GB.

**Caveat, stated plainly:** this metric is designed by the model's own vendor to favor small,
lower-average-accuracy models, and independent commentary flags exactly that
([AI Beat: "One Bit All the Way Down"](https://ai-beat.github.io/news/2026/04/bonsai-1bit-edge-llm/),
2026-04-01) — calling the skepticism "warranted" and noting the benchmark-parity claim "needs to
be tested across more diverse evaluations before it's taken as settled." Treat "competitive with
Qwen3 8B" as a claim to verify against your own workload (prose generation, structured delta
extraction), not as settled fact.

---

## 2. Runtime support — where it actually runs today

### GGUF quantization types

| Family | GGUF type | Upstream llama.cpp status |
|---|---|---|
| Bonsai (1-bit) | `Q1_0` | **Merged upstream** — CPU (generic + optimized x86), Metal, CUDA, Vulkan all ✅ |
| Ternary-Bonsai | `Q2_0` (ggml type 42) | **Not in upstream** (PR in progress: [ggml-org/llama.cpp#24448](https://github.com/ggml-org/llama.cpp/pull/24448)) — requires the [PrismML fork](https://github.com/PrismML-Eng/llama.cpp), `prism` branch, or its pre-built binaries |

This split matters operationally: **stock Ollama and stock llama.cpp builds silently refuse the
ternary GGUF** (or, if a tool claims to recognize the file but lacks the kernel, silently
dequantizes it — losing the entire speed/memory advantage with no error, just much worse
numbers than the published benchmarks). If ternary generation seems fine but slow, check memory
use during inference: several GB above weights+KV-cache is the signature of silent dequantization.
1-bit `Q1_0` has no such trap — it's upstream.

**Source:** [Formats & Runtime Support](https://docs.prismml.com/download/formats),
[Troubleshooting](https://docs.prismml.com/resources/troubleshooting).

### MLX (Apple Silicon)

1-bit MLX support is **pending upstream** ([mlx#3161](https://github.com/ml-explore/mlx/pull/3161));
use the [PrismML MLX fork](https://github.com/PrismML-Eng/mlx) meanwhile. Ternary (2-bit) MLX
works in stock MLX today.

### WebGPU (in-browser) — the part relevant to on-device-without-install

Two independent runtimes exist:

1. **[`bitgpu`](https://github.com/stfurkan/bitgpu)** — purpose-built, zero-runtime-dependency,
   ESM-only WebGPU engine specifically for Bonsai's sign-packed 1-bit weights (dense 1.7B/4B/8B
   gated **bit-exact** against the reference forward pass; the 27B hybrid gated to matching greedy
   tokens / logits-cosine, since its linear-attention recurrence has no fp64 reference path).
   Features: GPU-resident streaming decode, `AbortSignal` cancellation, cross-turn KV-cache reuse,
   optional f16/q8 KV-cache compression, IndexedDB conversation snapshots (survive page reload,
   bit-identical restore), an attention-sinks rolling window for unbounded chat in fixed memory,
   **schema-enforced guaranteed-valid JSON** (token-by-token constrained decoding — a malformed
   tool call or off-schema JSON object is structurally impossible, not just discouraged by
   prompting), and tool calling with per-argument schema enforcement (supports both the Qwen3 JSON
   wire format and the Qwen3.5 XML wire format bitgpu auto-detects from the chat template).
2. **`transformers.js`** with `dtype: 'q1'` — the mainstream/ecosystem path. bitgpu's own
   benchmark against it, same GPU, same identical bit-for-bit weights, one page: bitgpu decodes
   ~1.8x faster (23.8 vs 17.7 tok/s) and prefills ~6x faster (0.9s vs 5.6s for a 156-token
   prompt) on Apple Silicon, Chrome 150, 2026-07 — "point-in-time, one machine... treat it as a
   ballpark, not a leaderboard," per bitgpu's own README.

**Live demos that exist right now, not hypothetically:**
- PrismML's own docs list a WebGPU demo at `huggingface.co/spaces/webml-community/bonsai-webgpu-kernels`
  (blocked on this network; mirror confirmed reachable at
  `webml-community-bonsai-webgpu-kernels.static.hf.space` — runs **Bonsai 27B**, 1-bit, entirely
  in-browser, AI-authored WGSL compute-shader kernels, streams the GGUF straight from HF).
- bitgpu's own hosted demo: https://stfurkan.github.io/bitgpu/examples/chat.html
- Third-party (Aitherium) shipped an in-browser demo covering **all four sizes** (1.7B/4B/8B/27B)
  as of 2026-07-28 ([blog post](https://blog.aitherium.com/blog/all-four-bonsai-sizes-now-run-in-your-browser)).

**Source:** [Try It Without Installing](https://docs.prismml.com/get-started/try-online),
[bitgpu README](https://github.com/stfurkan/bitgpu) (raw README fetched directly).

---

## 3. Performance numbers, with their sourcing (do not blur these together)

| Claim | Number | Hardware | Source | Reliability |
|---|---|---|---|---|
| Bonsai 8B decode | 368 tok/s | RTX 4090 (native llama.cpp, not browser) | PrismML docs / AI Beat | Vendor + independent corroboration |
| Bonsai 8B decode | 131 tok/s | M4 Pro (native llama.cpp) | AI Beat | Independent |
| Bonsai 1.7B decode | 130 tok/s | iPhone 17 Pro Max (native, not browser) | PrismML | Vendor only |
| Bonsai 27B decode | ~11 tok/s | iPhone 17 Pro Max (native) | tinyweights.dev | Independent, "real numbers behind it" per author |
| **In-browser** decode, Bonsai 1.7B | 17–36 tok/s (typ. ~29) | RTX 5090, headless Chrome | Aitherium (their own runtime) | Independent, full range disclosed |
| **In-browser** decode, Bonsai 8B | 22–24 tok/s | RTX 5090, headless Chrome | Aitherium | Independent |
| **In-browser** decode, Bonsai 27B | 4.6–13 tok/s (typ. ~7) | RTX 5090, headless Chrome | Aitherium | Independent; same file via native llama.cpp on same machine: ~50 tok/s — **the browser is 4-10x slower than native on the same hardware**, by the vendor's own admission ("not the fast path and doesn't claim to be") |

**Load-bearing conclusion:** every *native* (non-browser) benchmark number quoted anywhere for
Bonsai — including the 368 tok/s / 131 tok/s / 130 tok/s headline figures used in marketing — is
**not what you get in a browser tab**. The in-browser numbers are meaningfully lower across every
size, on every measured platform. Any planning against WebGPU-in-browser throughput must use the
in-browser numbers, not the native ones.

---

## 4. Android specifically — weaker evidence than iPhone/Mac/desktop

This was checked explicitly because it is easy to over-generalize "runs on phone" from iPhone
claims to Android.

**What is confirmed:**
- Chrome for Android has shipped WebGPU since **v121** (verified via
  [MDN browser-compat-data](https://raw.githubusercontent.com/mdn/browser-compat-data/main/api/GPU.json),
  `api/GPU.json`, `chrome_android.version_added: "121"`). Firefox for Android does **not** support
  WebGPU (`firefox_android.version_added: false` in the same dataset).
- `bitgpu`'s own browser-support table lists **"Android Chrome — device-dependent — works where
  WebGPU is exposed; VRAM limits apply."** This is the vendor's own runtime hedging, not outside
  criticism.
- Aitherium's field report (the one team that shipped a public multi-size in-browser demo) confirms
  phones take the in-browser path, but with two load-bearing details: **the runtime auto-selects
  1.7B or 4B on mobile — never 8B or 27B** — and nothing above ~600 MB downloads without an
  explicit user tap that discloses the size. They also note the loader had to be changed *after*
  it failed in production: it originally asked a real Pixel for a 341 MB allocation in one fetch
  and that broke, so they changed the fetch strategy.

**What is not confirmed, despite a real search effort:**
- **No published Android-specific tok/s benchmark for Bonsai 8B** was found anywhere — not from
  PrismML, not from any independent blog, not on GitHub. Every hard throughput number in this
  document that names specific hardware is Apple Silicon, an iPhone, or a discrete desktop GPU
  (RTX 4090/5090). Android is characterized only qualitatively ("device-dependent").
- Bonsai 8B needs a **~148 MiB single GPU buffer binding for its `lm_head`**, beyond WebGPU's
  guaranteed-minimum device limits (`bitgpu` negotiates this from its own manifest and only
  requests it when the loaded model needs it). Whether a given Android GPU's WebGPU implementation
  grants a binding that large was not tested in anything found — this is exactly the kind of
  driver-dependent behavior that varies phone-to-phone.
- `bitgpu` names its fast "subgroup" execution path as available on "Apple / NVIDIA / recent AMD,"
  falling back to a slower workgroup-reduction path "everywhere else WebGPU is available." Android
  GPUs (Adreno, Mali) are not named as getting the fast path.
- The one production team that tested multi-size in-browser inference on real Android hardware
  made a **product decision to cap mobile at 4B**, not 8B — the strongest available signal, and it
  points away from 8B-on-Android-browser being a validated combination.

**Conclusion for Android specifically:** Bonsai 4B in-browser via WebGPU on Android Chrome is the
combination with actual field validation. Bonsai 8B in-browser via WebGPU on Android is
*plausible given the shipped 1-bit weight size and Chrome's WebGPU support*, but **untested at
scale** — no team publishing results has actually shipped it as a default, and the only team that
tried multi-size mobile deliberately excluded it. Treat it as a capability-probed fallback tier,
not a supported default, until real Android throughput numbers exist.

---

## 5. Relevance to `fabulist`'s provider architecture

`src/providers/provider.ts` already defines exactly the abstraction this would need to slot into:
a `Provider` interface with a `ProviderCapabilities` matrix (`structuredOutput`, `streaming`,
`contextWindow`, `costTier`) and an explicit degradation path (`adaptRequest`, `extractJson`) for
weak structured-output support — see DESIGN.md §9.3's framing: control the degradation path,
because a malformed delta corrupts the graph and every later turn inherits it.

A prospective `webgpu:bonsai-8b` (or `-4b`) provider would differ from every existing preset in
`src/providers/http.ts` in one structural way, not a capability-matrix way: **it runs in the
browser tab, not the Node server.** The engine currently assumes providers are called
server-side. A WebGPU provider needs either (a) the web client calling it directly and posting
results back to the server, or (b) a "browser-local" transport the server proxies — that is the
real design fork this idea introduces, independent of which Bonsai size is chosen.

Specific fit notes, for whoever picks this up:
- `costTier: 'free'`, `streaming: true` — same shape as the existing `mock` and `ollama:*` presets.
- `structuredOutput`: bitgpu's schema-enforced JSON mode is a real candidate for `'native-schema'`
  rather than falling back to `adaptRequest`'s fenced-JSON instruction — but its enforceable
  keyword subset excludes `pattern`, `$ref`, general `oneOf`, and float ranges (throws up front
  rather than silently ignoring them). This needs checking against `fabulist`'s actual delta
  schemas in `src/domain/` before assuming full native-schema support.
- Context: Bonsai 8B's YaRN-extended 65,536 tokens comfortably covers a single-turn frame budget;
  confirm against the worst-case scene assembly in `src/frame/`.
- **Capability probe before load, not after:** query `navigator.gpu` for presence, then
  `adapter.limits.maxStorageBufferBindingSize` against Bonsai 8B's ~148 MiB `lm_head` requirement,
  and step down to 4B (or the existing `mock`/HTTP path) when the device falls short. `bitgpu`
  exports typed `WebGPUUnavailableError` and `GpuOutOfMemoryError` specifically for this branch.

---

## 6. Primary sources referenced

- PrismML docs: https://docs.prismml.com (introduction, model pages, formats, troubleshooting,
  try-online)
- PrismML launch posts: https://prismml.com/news/bonsai-8b,
  https://prismml.com/news/prismml-launches-worlds-first-1-bit-ai-model (2026-03-31)
- `bitgpu` runtime: https://github.com/stfurkan/bitgpu (raw README)
- `deepgrove-ai/Bonsai` (the unrelated older 500M model): https://github.com/deepgrove-ai/Bonsai
- MDN browser-compat-data, `api/GPU.json`: https://github.com/mdn/browser-compat-data
- Independent commentary: AI Beat ("One Bit All the Way Down", 2026-04-01),
  tinyweights.dev ("Run Bonsai 27B Locally", 2026-07-14), Aitherium
  ("All Four Bonsai Sizes Now Run in Your Browser", 2026-07-28)
- `huggingface.co` itself is category-blocked on this network (Zscaler "Blocked AI Domains");
  all HF-hosted content above was reached via raw-GitHub mirrors, `*.static.hf.space` mirrors, or
  quotes in PrismML's own docs. If a future session has unblocked HF access, re-verify model-card
  specifics directly at `huggingface.co/prism-ml/*` rather than trusting only the docs' summary.
</content>
