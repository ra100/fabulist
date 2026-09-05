# Illustration: bringing scenes to life

*A companion to `DESIGN.md`, in its register — the reasoning, not the API reference. The
API reference is the code: `src/illustration/`, `src/providers/{image,mockImage,comfyui,bedrockImage,imageConfig}.ts`, `src/store/illustration.ts`.*

## The ask

Accompany scenes with visuals. Tweakable style — realistic, drawing, sketch, draft,
animation. If a vision model is not available, fall back to copy-pasteable prompts. Solve
the three consistency problems that make illustrated interactive fiction fail: **visual**
(the world doesn't look like one world), **place** (a room looks different every time you
return to it), and **character** (a face changes between panels).

This document is the *why* behind the mechanism actually shipped, and an honest account of
what is verified against a real provider and what is not.

---

## 1. The three consistency problems, and what actually solves each

None of these has a complete solution with today's tools short of a fine-tuned LoRA per
character — that is out of scope for a local-first tool with no training pipeline. What
exists instead is three independent, composable levers, used together and never assumed
alone sufficient. See `src/illustration/composer.ts`'s file comment for the code-level
version of this; here is the reasoning behind it.

### Lever 1 — restated description, every time (every provider gets this, free)

The cheapest lever, and the only one every provider has regardless of capability. Two slow
fields carry it:

- `StyleContract.visualAnchor` — the *world's* visual anchor. One paragraph, written once,
  appended to every portrait and every scene prompt. "Iron-gall ink oxidised to warm
  brown, stone corridors, secular garrison uniforms in crown-blue" — the same sentence a
  designer would write for `.design/LINEAGE.md`, but feeding a diffusion prompt instead of
  a CSS token file. This is *visual consistency*: the reason two illustrations from the same
  world look like they belong together is that they were both told the same thing about
  what the world looks like.
- `Appearance.description` / `.attire` / `.markers` — the *character's* visual anchor,
  parallel in spirit to `Identity` and `VoiceCard`, and deliberately living on the same
  `CharacterSheet` next to them rather than in a separate table. "A lean man of
  fifty-four, close-cropped grey hair, ink permanently under the nails of his right hand"
  gets restated in the portrait prompt *and* in every scene prompt where that character is
  present — the same three sentences, not independently re-derived each time. This is
  *character consistency*'s baseline: repetition of the same text, not an image the model
  is shown.

  A location gets the identical treatment without a second type: `locationAnchor()` reads
  `Entity.props.visualDescription` (or falls back to `Entity.summary`) exactly the way
  `appearanceFragment()` reads `Appearance`. A location is functionally "an entity nobody
  calls by its `CharacterSheet`" — giving it a parallel schema would have meant deciding,
  the day someone wants a shopkeeper's stall to have both, which schema wins. It does not
  need deciding: it is the same mechanism.

**Honest limit.** A diffusion model reading the same words twice does not reliably render
the same pixels twice. This lever makes drift *less likely*, not impossible. It is the
floor every provider gets, never presented as the ceiling.

### Lever 2 — seed reuse (providers with `seedControl`)

`ImageCapabilities.seedControl`. When a provider reports it, a portrait's regeneration
reuses its own previous seed (`IllustrationService.illustratePortrait`) rather than rolling
a new one — the cheapest real lever a seed-based text-to-image model exposes, and one every
image tool a player might paste the prompt into (Midjourney, a local ComfyUI seed field)
already understands as a concept even without this app's help.

Scenes deliberately do **not** reuse a seed. A scene's prompt necessarily differs turn to
turn — new dialogue detail, new characters present, a changed mood — and holding the seed
fixed against a materially different prompt does not anchor the image to the location; it
anchors it to whatever the model happened to render for the *previous* prompt, which is a
worse failure mode than no anchor at all.

**Honest limit.** Same seed plus a different prompt can still drift arbitrarily far from
the reference. This is a floor, not a guarantee — stated identically in the code comment,
on purpose, so nobody downstream mistakes "the seed matched" for "the character matched."

### Lever 3 — reference-image conditioning (providers with `imageConditioning`)

The only lever that inspects pixels rather than re-describing them, so it is the one that
actually matters most, and the one no provider is required to have.

- **Character consistency.** A portrait's own generated image, once one exists, becomes
  `Appearance.referenceImagePath`. Every later portrait *and* every scene that character
  appears in is offered that path as a conditioning reference when the active provider
  supports it (`IllustrationService`, both methods). This is the actual mechanism, not
  just an artifact sitting in a database: the write to `referenceImagePath` is what makes
  every later generation start from what this character has actually looked like, not
  from a re-rolled guess at the same three sentences.
- **Place consistency.** `IllustrationStore.latestLocationReference(locationId)` is the
  identical idea applied to a room instead of a face: the most recent *done* scene
  illustration set at a location becomes the reference the next scene at that location is
  offered. First visit to a place has no reference and falls back entirely on levers 1–2;
  the second visit onward has a real image to condition on.

**Honest limit.** Depends entirely on the provider actually supporting image input in a way
that keeps a likeness — a vanilla text-to-image checkpoint through a plain ComfyUI graph
does not, and this app declares that graph's `imageConditioning: false` rather than
pretending. Nothing here fabricates a capability a provider does not have.

### What "solved" actually means here

Not "guaranteed." **Meaningfully improved over the default of asking a fresh model for
"the same character" with no mechanism at all**, which is where every other AI role-play
tool that bolts on image generation currently sits. Three independent, honestly-labelled
levers, stacked, is the realistic ceiling without a per-character fine-tune — and the
composer, store, and service are built so that ceiling rises automatically the day a better
provider (a real IP-Adapter graph, a per-story LoRA) is plugged in, with zero changes to
the prompt-composition logic itself.

---

## 2. The five-way style picker

Realistic, drawing, sketch, draft, animation — the five options asked for directly, not a
longer taste-driven list. `VisualStyle` in `domain/types.ts`; the actual prompt fragments
live in `STYLE_FRAGMENTS` (`composer.ts`), one positive/negative pair per option, each
distinct enough that two styles never collide (tested: `illustration-composer.test.ts`).

`draft` is the default (`defaultStyleContract().visualStyle`), on purpose, echoing the
mock text provider's own stance: *deliberately plain, proving the machinery rather than
impressing with it.* A fresh world's first generated image should look like a rough
concept sketch, not a falsely-finished piece the mock's flat-colour placeholder cannot
actually deliver on anyway.

Independent of the prose register (`StyleContract.register`) on purpose — a noir mystery
told in clipped prose can still be illustrated as `drawing` rather than forced into
`realistic` just because the tone is grim, and the reverse. Both are regenerable
projections over the same committed state, mirroring §7.2's argument for prose:
`visualStyle`/`visualAnchor` describe *how it is shown*, never *what happened*.

---

## 3. Local-first and the ComfyUI question

The direct question this was built to answer: *"for model generation, if we want to go
local, do we need pre-prepared models, or allow a ComfyUI connection?"*

**ComfyUI: in scope, and built** (`providers/comfyui.ts`). **Bundled model weights: out of
scope, on purpose, and consistent with how this app already treats every other local
server.**

Look at how the existing text-provider story already answers the identical question for
`ollama:*` / `vllm:local` / `llamacpp:local`: Fabulist does not ship a checkpoint, it
documents the wire format, starts a server, and tells you the fix when nothing is
listening (`pnpm providers`; `providers/probe.ts`). ComfyUI is the same shape of problem —
an HTTP API (`POST /prompt` with a graph JSON, poll `/history`, `GET /view` for bytes) —
so it is one more adapter behind `ImageProvider`, the image-generation mirror of
`Provider`. Fabulist owns:

- One documented default graph (`defaultWorkflow()`) — a plain checkpoint-loader →
  CLIP-encode → KSampler → VAE-decode → save-image txt2img graph, the shape every ComfyUI
  tutorial installs by default, with named node-id placeholders filled at request time.
- A liveness probe (`comfyReachable`) with the same "nothing listening → here's the start
  command" fix-hint every local text server already gets.
- An escape hatch: `ComfyUIOptions.workflow` + `.nodeMap` accept a *user's own* graph —
  an img2img graph with a real IP-Adapter node, a ControlNet graph, anything — and this
  adapter fills the same named placeholders into it. Upgrading from "prompt restated only"
  to "real image conditioning" becomes a config change (point at a different workflow
  JSON, flip `imageConditioning: true` in the spec), not a code change.

Bundling actual model weights would be a distribution and licensing problem — checkpoint
files are gigabytes, come with their own model-specific licences, and change constantly —
not a design problem, and every other local-server story in this codebase already draws
that line in the same place.

---

## 4. What is actually verified in this environment, and what is not

Checked directly rather than assumed, because the codebase's own convention throughout
`providers/*.ts` is "confirmed directly against the API, not assumed from the docs" —
worth holding this feature to the same bar, including admitting where that bar was not met.

**Reachable in this session:** the `mock` profile (offline, deterministic, real PNG bytes —
see `providers/mockImage.ts`), and Bedrock text models via the one AWS profile that
resolved (`cline-pilot-role`). No local server (ComfyUI, Ollama, vLLM, llama.cpp, LM
Studio) was running; `OPENAI_API_KEY` / `ANTHROPIC_API_KEY` / `DEEPSEEK_API_KEY` unset;
`gcloud` not installed.

**Bedrock image models, checked with `aws bedrock list-foundation-models`:** this
account/region carries `amazon.nova-canvas-v1:0` (legacy, access-denied on invocation) and
every `stability.*` model — but only the Stability *editing* tools (style-guide,
control-sketch, inpaint, search-and-replace, upscalers). No plain text-to-image
Ultra/Core/SD3 id is entitled here. Every invocation attempt — including a deliberately
empty request body, to read the validation error ahead of the entitlement check — returned
the same AWS Marketplace `AccessDeniedException` before any request-shape feedback was
possible.

**Consequence:** `providers/bedrockImage.ts` implements Stability's publicly documented
Platform REST contract (`prompt`/`negative_prompt`/`seed`/`aspect_ratio` in, base64
`images[]`/`seeds[]` out) — which Bedrock's docs describe as a pass-through — but this was
**never exercised against a live, entitled model in this session**. The file's own comment
says so plainly, and `imageConfig.ts`'s probe reports this preset as `unknown` rather than
`ready`, rather than overclaiming a status nothing here actually confirmed. Treat it as
unverified until one real call against an entitled model succeeds.

**What this means practically:** the mock is what the whole pipeline (composer → service →
store → API → UI) was actually exercised against, end to end, including a live browser
session — screenshots exist for portrait generation, scene illustration, the style picker,
and the no-provider prompt fallback, all under the real UI, real routes, real SQLite
storage. ComfyUI's wire contract is implemented against its publicly documented API but
was not reachable to test live in this sandbox (nothing listening at `127.0.0.1:8188`).
Bedrock Stability is the least-verified adapter of the three, for the reason stated above.

---

## 5. What ships, concretely

**Domain** (`domain/types.ts`): `Appearance` (durable visual identity, parallel to
`Identity`/`VoiceCard`), `VisualStyle`, `StyleContract.visualStyle`/`.visualAnchor`,
`Illustration` (a generated image record, scene- or portrait-tagged).

**Storage** (`store/illustration.ts`, additive `sheets.appearance` column in `db.ts`):
`illustrations` table, bytes on disk beside the database (not inside SQLite — a save stays
one portable directory, and a generated PNG does not belong inside a transaction the way a
delta commit does).

**Composition** (`illustration/composer.ts`): pure functions, no network, no database —
`composePortraitPrompt`, `composeScenePrompt`, `locationAnchor`, `STYLE_FRAGMENTS`. Directly
unit-tested (`test/illustration-composer.test.ts`).

**Providers** (`providers/{image,mockImage,comfyui,bedrockImage,imageConfig}.ts`): the
`ImageProvider` interface mirrors text's `Provider` deliberately. Three adapters — mock
(offline, real PNG bytes), ComfyUI (local, free, bring-your-own-graph), Bedrock Stability
(cloud, unverified as noted above).

**Orchestration** (`illustration/service.ts`): `IllustrationService` — compose, resolve a
reference, call the provider, persist, update `Appearance` on success. Also exposes
`composePortrait`/`composeScene` directly, with no provider call at all, which is what
makes the copy-paste fallback (§6) possible without an image model ever being configured.

**API** (`server/api.ts`): `/api/illustrate/{portrait,scene}/:id[/prompt]`,
`/api/illustrations/{turn,entity}/:id`, `/api/illustration/:id[/image]`,
`/api/images/{providers,profile}`.

**UI** (`web/src/views/Illustration.tsx`): `StylePicker`, `PortraitPanel` +
`AppearanceEditor` (in the cast tab's expanded sheet), `SceneIllustration` (inline in the
book, per turn, opt-in per scene rather than automatic), and `PromptText` — the fallback.

**Config** (`config/config.ts`, `providers/imageConfig.ts`): `imageProfile`/
`imageProviders`, mirroring `profile`/`providers` for text, with one deliberate asymmetry —
absent `imageProfile` means illustration is off, not "fall back to the mock." Illustration
is optional in a way narration never is; a fresh install should not silently start writing
image files nobody asked for.

---

## 6. The no-vision-model fallback

Explicit requirement from the ask, not an afterthought: *"if a vision model is not
available, provide just image-gen prompts that can be copy-pastable."*

Built by keeping composition and generation as two separate calls all the way through the
stack, not by catching a provider error after the fact. `IllustrationService.composePortrait`/
`.composeScene` call the same `composer.ts` functions `illustratePortrait`/`illustrateScene`
call, but never touch `providers.get()` — so `/api/illustrate/portrait/:id/prompt` and
`/api/illustrate/scene/:turnId/prompt` work on a server with **no image provider configured
and no `IllustrationService` even wired up**, needing only `world` (tested directly:
`illustration-api.test.ts`'s two "with no illustration service configured at all" cases).

In the UI, `PortraitPanel` and `SceneIllustration` probe `/api/images/providers` once on
mount. No provider ready: the "generate" button disappears entirely rather than sitting
there to fail, replaced by "copy prompt," a one-line explanation, and — on click — the
composed prompt and negative prompt as plain, selectable, individually-copyable text
(`PromptText`). A provider ready: both buttons appear, because "give me the prompt anyway"
— a different tool, a higher-resolution render, a second opinion — is still a reasonable
thing to want.

---

## 7. Composition note

The first working render of the scene-illustration panel put a 640px-tall image under
three lines of prose, making the illustration the visually dominant object on the page —
the exact inversion `.design/CRITIQUE.md` already flagged once for this app's sidebar gold
bars ("the prose is the product... it never wins a single screen"). Caught by actually
looking at a screenshot rather than trusting the markup, and fixed by capping the scene
image to `max-height: 260px` at a 16:9 crop — a companion to the text, not a competing
headline. The portrait panel's own first render left roughly two-thirds of its row empty
with no counterweight; fixed by bounding the whole row to `--measure-prose` rather than
letting an unfilled `flex: 1` column claim the sheet's full width. Both are recorded here
because the lineage they violated is already written down in `LINEAGE.md`/`CRITIQUE.md`,
and a new feature inheriting an old app's discipline only works if it is actually checked
against that discipline, not assumed to follow from using the same CSS variables.

---

## 8. Known gaps, stated the way `README.md`'s "Known gaps" section states its own

- **No batch/background illustration.** Every image is generated on an explicit click,
  never automatically on scene advance — deliberate, since illustration is optional and a
  provider call nobody asked for is a real cost on a paid provider, but it means a long
  session accumulates zero images unless a player keeps clicking.
- **Bedrock Stability is unverified**, per §4. Treat `bedrock:stability-style-guide` as a
  best-effort implementation of a documented contract, not a confirmed-working adapter,
  until one real call against an entitled model succeeds.
- **ComfyUI's default graph is a plain txt2img graph with `imageConditioning: false`.** A
  user who wants real reference-image conditioning locally needs to supply their own
  workflow JSON with an IP-Adapter (or similar) node via `ComfyUIOptions.workflow`/
  `.nodeMap` — nothing here builds that graph automatically, because the "right" IP-Adapter
  setup depends on the checkpoint and is a modelling decision, not a wiring one.
- **No upscaling or inpainting pass.** Stability's Bedrock catalog in this account is
  mostly editing tools (upscale, inpaint, erase-object, search-and-replace) that this
  feature does not use at all — a deliberate scope cut for this pass, not an oversight, but
  worth naming since the tools are sitting right there unused.
