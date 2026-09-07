# Fabulist — Legal Briefing: Fandom Ingest, Bundles, Hosted Worlds

**Not legal advice.** I am not a lawyer. This is engineering-grade research from primary sources read directly (Fandom ToU/Licensing, CC legal code, EUR-Lex) on 2026-09-05. Anything commercial needs a real IP attorney.

## 1. Fandom's Actual Terms (verified)

**License: CC BY-SA 3.0 Unported — not 4.0.** [fandom.com/licensing](https://www.fandom.com/licensing) states: *"the text on Fandom communities… is licensed under the Creative Commons Attribution-Share Alike License 3.0 (Unported)."* This matters concretely: 3.0 has **no sui generis database-right grant** (4.0 §4 does), and no 30-day cure period — breach terminates automatically. Some wikis instead use **CC BY-NC / BY-NC-SA / BY-NC-ND**; the license "is made clear on the edit page of that wiki." Fandom's "Commercial Use Waiver" runs **only to Fandom**, not to you, so **a commercial product must check per wiki.** Screen via `api.php?action=query&meta=siteinfo&siprop=rightsinfo` — live on witcher.fandom.com it returns `{"url":"https://www.fandom.com/licensing","text":"CC-BY-SA"}` — but it omits version and NC status, so treat it as a screen, not proof.

**Attribution, as Fandom itself defines it.** The Licensing page pre-blesses: (a) hyperlink/URL to the contributed article(s), (b) URL to a stable license-conforming copy, or (c) a full author list. **Option (a) is the cheap compliant path for a bundle** — store source URL plus revision ID per record.

**ToU (Date of Last Revision: December 19, 2025) — the access problem.** [fandom.com/terms-of-use](https://www.fandom.com/terms-of-use), verbatim:

> "Use any robot, spider, site search and/or retrieval application, or other device to scrape, extract, retrieve or index any portion of the content;"
> "Without our express, prior written consent, use or copy the content for the development of any software program, including, but not limited to, training a machine learning or artificial intelligence (AI) system"
> "not use any robot, spider, scraper or other automated means to access the Services for any purpose without our express written permission;"

That last clause is unqualified — *"for any purpose."* Read literally, **automated `api.php` ingest breaches the ToU** even though the text is CC-licensed, and the "development of any software program" clause reaches Fabulist directly, not just AI training.

**The carve-out and its limit.** The prohibition block opens *"Except as expressly permitted by the Company (for example with respect to the use of text content… as set forth at our licensing page)…"* — that carve-out covers **what you may do with text once you have it** (reproduce, adapt, distribute, commercially). The robot/scraper bullets are separate, and govern **how you obtain it**. Contract and license operate on different layers: Fandom cannot un-CC-license contributor text it does not own, but it can condition server access and terminate accounts.

**robots.txt — genuinely favourable.** On `witcher.fandom.com`, `User-agent: *` includes **`Allow: /api.php?`**, `/api.php?action=`, `/api.php?*&action=`. But `GPTBot`, `ClaudeBot`, `CCBot`, `OAI-SearchBot`, `ImagesiftBot` are each `Disallow: /` **by name**. Fandom's machine-readable policy invites generic API clients and excludes AI-crawler identities. That undercuts any "you circumvented technical restrictions" narrative — but doesn't override the ToU. The ToU separately bars bypassing "robot exclusion headers" and forging headers. **So: honest descriptive User-Agent with contact URL, conservative rate limits, respect `maxlag`. Never spoof a browser** — that keeps you inside the `*` grant instead of outside it.

Exposure from ToU breach: account termination, IP blocking, and the indemnity clause, under California law. CFAA claims over public data are weak post-*Van Buren* / *hiQ v. LinkedIn*, but plain **breach of contract** survives (*Ryanair v. Booking.com*, D. Del. 2024). The ToU never mentions databases, fan fiction, or fair use — those words appear zero times.

## 2. ShareAlike: What Actually Attaches

Split the artifact into three layers; this is the analytically decisive move.

**(i) Facts / structured extraction — mostly free.** Facts are uncopyrightable (*Feist*, 499 U.S. 340 (1991)), including sweat-of-the-brow compilation. Entity tables, relationship edges, timeline nodes — stripped of expressive prose — carry **no CC obligation**, because CC only bites where copyright exists.

**(ii) Verbatim excerpts — ShareAlike attaches. This is your exposure.** `voice_cards` (verbatim dialogue) and `evidence_spans` (verbatim sentences) are copies of protected expression. CC BY-SA 3.0 §1 defines **Adaptation** as a work "recast, transformed, or adapted including in any form recognizably derived from the original." A graph embedding wiki sentences is at least a partial Adaptation. §4(b) then requires distribution only under BY-SA 3.0 or a later/compatible ShareAlike license, the license URI with every copy, notices intact, and — critically — **no terms "that restrict… the ability of the recipient… to exercise the rights granted."** So a paid or EULA-restricted bundle containing verbatim wiki text is a **ShareAlike problem, not just an attribution problem**: you may charge, but you cannot stop a paying customer redistributing that content free. ShareAlike is **content-scoped, not product-scoped** — it does not viralise your engine code, provided the boundary is mechanical: BY-SA for `data/`, your license for code, stated in the manifest.

**(iii) The Collection escape hatch.** A **Collection** under 3.0 includes the Work "in its entirety in unmodified form" alongside independent works and is expressly **not** an Adaptation — ShareAlike does not attach to a Collection (attribution still does). The lever this yields: **the more your bundle is extracted facts plus pointers, the weaker the copyright hook; the more verbatim text it carries, the harder ShareAlike binds.** For reference, 4.0 replaces this with "Adapted Material," licenses sui generis database rights, and says using a database's *contents* doesn't itself create Adapted Material — friendlier, but Fandom is on 3.0. You *may* distribute a 3.0 Adaptation under **BY-SA 4.0** (a "later version with the same License Elements"); that legitimate one-way upgrade is usually the smart choice.

**Attribution in practice:** generated `attribution.json` + `ATTRIBUTION.md` listing per record the wiki, title, canonical URL, revision ID, timestamp, and license URI (`https://creativecommons.org/licenses/by-sa/3.0/`). Assert it in CI. Surface it where content is used, not only in a buried file.

## 3. The Bigger Problem: Third-Party Fictional IP

**This dominates.** CC BY-SA covers contributor prose *about* someone else's universe; it conveys nothing about characters, settings, or names. Fandom's ToU concedes: *"All other trademarks referenced in the Services are the property of their respective owners."*

**Characters are protectable.** *DC Comics v. Towle*, 802 F.3d 1012 (9th Cir. 2015): protection where a character (1) has physical and conceptual qualities, (2) is sufficiently delineated and consistently recognisable, (3) is "especially distinctive," not a stock type. Geralt, Vader, Hermione clear this easily. Copying traits, relationships, and canon voice copies expression, not facts.

**The on-point case is a wiki-derived encyclopedia.** *Warner Bros. & J.K. Rowling v. RDR Books*, 575 F. Supp. 2d 513 (S.D.N.Y. 2008) — the **Harry Potter Lexicon**: a free fan wiki whose operator published it **for profit** as a print reference. Held **not fair use**; publication blocked. The decisive factor was **volume of verbatim and close-paraphrase quotation** exceeding the reference purpose; RDR later reissued with long quotes cut. The mapping to Fabulist is near-exact: **free fan wiki → structured commercial reference → verbatim quotation volume decided it.** Your `voice_cards` and `evidence_spans` *are* that problem.

**Fan fiction: tolerated, not licensed.** There is **no general fair-use safe harbour**. Fan works are presumptively derivative (17 U.S.C. §106(2)), surviving because rightsholders decline to sue non-commercial fans. Fair use is an **affirmative defence raised after suit, at your cost** — not permission. *Warhol v. Goldsmith* (2023) tightened factor one and elevated licensing-market harm, cutting against paid fan-derived products. Note OTW/AO3's own mission is protecting fanwork from "legal snafus **and commercial exploitation**" — fandom's institutions are hostile to monetisation independent of law.

**Commercialisation changes everything:** flips factor one, sharpens factor four (rightsholders now license official companion apps and AI experiences, so you compete in a real market), breaks the tolerance equilibrium, and creates a damages target. It also implicates the **output**: LLM stories starring Geralt in Velen are unauthorised derivative works however the graph was built.

**Trademark is distinct and faster.** Franchise names are registered marks; naming a product, SKU, endpoint, or domain after a fandom risks confusion (§32) and false endorsement (§43(a)) — cheaper to bring, injunction-friendly. *Nominative fair use* (*New Kids on the Block*) permits identifying the thing itself: use no more of the mark than necessary, no logos or trade dress, no implied sponsorship. "Compatible with the Witcher Wiki" is far safer than "Fabulist: Witcher Edition."

**Enforcement patterns are real.** **Nintendo**: killed *AM2R*, *Pokémon Uranium*, ~$2.4M *Yuzu* judgment, mass DMCA. **Games Workshop**: C&Ds against fan animations and 3D models; asserted "space marine" against a novelist. **Disney/Lucasfilm**: killed the *Star Wars* fan feature; continuous TM policing. **Anne Rice / GRRM**: fanfic takedowns. **Paramount v. *Axanar***: trigger was **~$1M crowdfunded** — money. **CDPR is comparatively permissive**, relevant if Witcher is first, but tolerance is revocable, not a license. **The trigger is consistently monetisation, scale, and substitution — rarely private use.**

## 4. Risk Delta Across the Four Models

**(a) Local, user-run ingest.** Lowest by far: user's own ToU relationship, no distribution (no §106(3), no CC duty), private copies, no damages worth pursuing. Residual: contributory/inducement theories (*Grokster*) if the tool is marketed to evade licensing.

**(b) Free pre-built bundles.** The step most underestimated. You become **distributor** of verbatim CC text (full ShareAlike + attribution) *and* of curated machine-readable distillations of protected characters. "Free" removes commercial purpose but **not** infringement — distribution is an exclusive right, and DMCA/C&Ds routinely hit free fan projects. Bundles are also findable and nameable: a release tagged with a franchise name is a search-and-enforce target.

**(c) Paid access / hosted fandom-as-a-service.** Highest and qualitatively different: all of (b), plus commercial purpose, *Warhol* market harm, the *RDR Books* fact pattern almost exactly, a **ShareAlike conflict** (cannot contractually restrict redistribution), and **you** are now the party making at-scale automated API calls in direct breach while acting as the ad-free substitute that costs Fandom revenue. Also a servable defendant with revenue, §512 exposure without a registered agent, and trademark risk spiking because you must market by fandom name.

**(d) Ingest tool only, user-supplied URL.** Recommended, and structurally — not cosmetically — different: you distribute no content, copying happens on the user's machine under their account, mirroring browsers, `wget`, and dump tools. Lets you be commercial about *software* while shipping zero fandom content. Keep it **general-purpose**: any MediaWiki `api.php`, no franchise presets or curated URL lists, since franchise-specific affordances are what create an inducement narrative.

## 5. EU / UK

**DSM Directive (EU) 2019/790.** **Art. 3** (research TDM) is override-proof but limited to research organisations and cultural heritage institutions for scientific research — **a hobbyist or commercial project does not qualify**. **Art. 4** does cover commercial actors: reproductions and extractions of **"lawfully accessible"** works for TDM, retained "as long as is necessary." Two hard limits: (1) **Art. 4(3)** applies only where use is not **"expressly reserved… such as machine-readable means"** — Fandom's AI/software-development prohibition plus named `GPTBot`/`ClaudeBot`/`CCBot` blocks is a credible reservation, at least for AI framings (countervailing: those target *AI crawlers*, `Allow: /api.php?` runs the other way, and *contributors* are the rightholders — unsettled); (2) **Art. 4 authorises mining, not redistribution** — it does not legitimise shipping verbatim excerpts.

**Sui generis database right (96/9/EC).** Protects substantial investment; bars extraction/reuse of a substantial part, including systematic extraction of insubstantial parts (*BHB v. William Hill*; *Innoweb v. Wegener* on repeated querying). Because **BY-SA 3.0 does not license database rights**, wholesale ingest can implicate this independently, with Fandom the plausible claimant. *Football Dataco* confirms the copyright route needs creative selection/arrangement, which factual extraction may avoid. **The UK is worse than the EU**: equivalent database right retained, TDM exception non-commercial-research only (the broad commercial exception was abandoned in 2023).

**EU AI Act (Reg. 2024/1689).** Copyright duties attach to **GPAI model providers** (Art. 53): a Union-copyright policy, "in particular to identify and comply with the reservation of rights pursuant to Article 4(3)," and a **"sufficiently detailed summary of the content used for training."** **Fabulist is almost certainly not a GPAI provider** — you consume a third-party model and build retrieval context. It matters indirectly: **fine-tuning** on ingested text moves you toward provider duties; Art. 4(3) respect is the emerging compliance baseline; and **RAG context injection is not training** — worth stating explicitly in your docs. Art. 50 may require marking generated fiction as AI-generated in the EU.

## 6. Practical Mitigations

1. **"Recipe, not payload" — highest-value move.** Ship a crawl plan (base URL, title/category selectors, extraction schema, parser version, content hashes) and let the **user's machine** build. This is the `youtube-dl` / Homebrew formula / HF loading-script / distro `*-nonfree-installer` pattern; it keeps reproducibility and one-click UX while moving copying and the ToU relationship to the user. **It converts (b) into (d).**
2. **Generated attribution manifests**, CI-asserted so builds fail on missing provenance.
3. **Per-wiki license gating at ingest.** Check `rightsinfo` *and* the wiki's edit-page license; **refuse or hard-flag anything not BY-SA**; record the detected license per record.
4. **Minimise verbatim text — the *RDR Books* lesson.** Cap quote length (~≤25 words) and count per entity; prefer **offset+length pointers into the user's local copy** over stored strings; prefer abstracted **style descriptors** ("terse, sardonic") over stored dialogue. A voice card built from characterisation is defensible; one built from transcription is *RDR* in miniature. If stored, store only locally — never in a distributed artifact.
5. **User-supplied URLs; honest identification.** Descriptive UA with contact, backoff, `maxlag`, honour robots.txt — never impersonate a browser or a blocked AI crawler.
6. **Safe harbour if you host.** Register a §512(c) DMCA agent, publish takedown policy, repeat-infringer termination, and a **per-fandom kill switch** for same-day C&D compliance.
7. **Naming hygiene.** Neutral name; no franchise name in product, domain, logo, or SKU; nominative phrasing only; prominent non-affiliation disclaimer.
8. **Non-commercial framing where affordable.** No ads, no paid tier, no franchise-tied crowdfunding (*Axanar*'s trigger). If you monetise, monetise the **general-purpose engine**, never fandom content or access.
9. **Opt-in routes / safe worlds.** Follow published fan-content policies (CDPR, Paramount fan-film guidelines, Wizards, GW). For shipped bundles, prefer **public-domain or permissive worlds** — Sherlock Holmes, Lovecraft, Oz, mythology, SCP (CC BY-SA), or original settings.
10. **Document reasoning now.** A `LICENSING.md` recording per-wiki checks, the 3.0 basis, Art. 4 analysis, and minimisation choices is good-faith evidence that improves willfulness/damages posture.

## 6.1 Database dumps: a materially better access path than live crawling

Verified directly (2026-09-07): every Fandom wiki's `Special:Statistics` page carries a
"Database download" section linking a `.7z`-compressed MediaWiki XML export of the wiki's
current pages, at `s3.amazonaws.com/wikia_xml_dumps/…`. Fandom's own copy captions the
"current pages" link **"This version is usually best for bot use"**, and
`community.fandom.com/wiki/Help:Database_download` documents the feature explicitly:
generated for "personal backup or for bot maintenance tasks," admin-refreshable roughly
weekly, governed by the same per-wiki license as the wiki itself. This is not a
Fandom-specific format — it is the standard MediaWiki XML export `dumpBackup.php` produces on
any MediaWiki install.

**Why this changes the access-layer analysis, not the content-layer one.** Everything in §1
about CC BY-SA 3.0, and everything in §3 about third-party character/trademark IP, applies
identically — the dump contains the same contributor text about the same fictional universe.
What changes is *how the bytes are obtained*, which is the ToU's separate concern from what
you may do with them once you have them (§1's "different layers" point):

- The live crawl in `client.ts` relies on a favourable-but-contested reading: `robots.txt`'s
  `Allow: /api.php?` for a generic UA, against the ToU's separate, unqualified ban on "any
  robot… to scrape, extract, retrieve or index any portion of the content… for any purpose."
  That tension is real and unresolved (§1).
- A dump download is not that pattern at all. It is a single request against a documented
  bulk-export endpoint that Fandom's own help page frames as the recommended path for exactly
  this use case — bot consumption — and that endpoint is not paginated, repeated, or
  indexing-shaped in the way the ToU's robot clause is worried about. It is closer to
  `wget`-ing a published backup than to crawling a site.
- It also **strictly reduces** exposure versus the live path rather than trading one risk for
  another: fewer requests, no `api.php` traffic pattern to rate-limit or misidentify, and (per
  §5) a stronger claim that any TDM/Art. 4 reservation-of-rights argument does not apply,
  since this is not "extraction… by automated means" of the live site in the sense Art. 4(3)
  contemplates — it is consuming an export the rightsholder's platform itself produces and
  distributes for that purpose.

**Implementation: `src/ingest/dump.ts`.** `ensureDumpXml` downloads and caches the archive
under `data/dumps/<wiki>/` (gitignored, never distributed — consistent with model (d)'s
"copying happens on the user's machine" framing in §4); `DumpSource` streams the XML with a
SAX parser (a multi-hundred-megabyte file is normal for one mid-sized wiki, so this is never
loaded as a DOM) and exposes the same `fetchPages`/`fetchPage` surface `WikiClient` already
does. `HybridSource` composes the two: dump first, live `WikiClient` only for titles the
snapshot does not have. `pnpm ingest --dump` wires this into the CLI; nothing in `scope.ts`,
`passA.ts`, or `passB.ts` changed to support it.

**What does not change.** This is still local, user-run ingest (model (a) in §4) — the
dump is downloaded, decompressed, and consumed on the user's own machine, into their own
local `data/`, and nothing about it is redistributed. Everything §4(a)'s risk assessment says
still applies. It does **not** license the third-party character IP in §3, does not grant
database rights (§5), and does not change the ShareAlike analysis in §2 for anything
extracted from it. Bundling a pre-fetched dump with a shipped product would still be model
(b) or (c) — the mitigation here is about *how one machine obtains the source text*, not
about what may be redistributed afterward.

## Risk Table


| # | Model | Fandom ToU | CC BY-SA 3.0 duty | Third-party copyright | Trademark | EU/UK | Enforcement likelihood | Overall |
|---|---|---|---|---|---|---|---|---|
| a | Local, user-run ingest | Low–Med (user's access; barred literally, never enforced privately) | **None** (no distribution) | Low (private copies) | None | Low (Art. 4 plausibly covers local mining) | Very low — invisible, no damages | 🟢 **Low** |
| b | Free pre-built bundles | **Med–High** (scale; "software program" clause) | **Full** — ShareAlike + attribution; no restrictive EULA | **Med–High** — distributing derivative compilations | Med (naming) | **Med** — DB right unlicensed by 3.0; Art. 4 ≠ redistribution | Med — DMCA/C&D vs free fan projects is routine | 🟡 **Medium** |
| c | Paid / hosted FaaS | **High** (scale + commercial + AI clauses) | **Full + conflict** — can't restrict downstream redistribution | **High** — near-exact *RDR Books*; *Warhol* factor 4 | **High** — must market by fandom name | **Med–High** — DB right, Art. 4(3), Art. 50 | **High** — revenue + visibility + substitution | 🔴 **High** |
| d | Ingest tool only, user URL | Low (user acts; keep general-purpose) | **None** (ship no content) | Low (contributory only if marketed to infringe) | Low (neutral naming) | Low (user-side mining) | Very low | 🟢 **Low** ✅ *recommended* |

**Bottom line.** Two verified facts drive this: Fandom is **CC BY-SA 3.0** (no database-right grant, no cure period, per-wiki NC exceptions), and its ToU bars automated access **"for any purpose"** while robots.txt **explicitly allows `/api.php?`** to generic agents — a real, unresolved tension; stay on the favourable side by identifying honestly and rate-limiting. But the CC layer is the smaller problem. The controlling risk is that the characters and worlds are third-party IP no contributor can license to you, and *RDR Books* is a **decided case** where exactly this input (a free fan wiki) monetised as exactly this output (a structured reference) lost on fair use over **verbatim quotation volume**. Ship the recipe, not the payload; minimise stored verbatim text; keep franchise names off the product; attach monetisation to the general-purpose engine. Get an attorney before (b) at scale, and certainly before (c).
