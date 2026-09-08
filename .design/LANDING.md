# The landing page — what it is and why it looks like this

`web/landing.html` → `web/src/landing/`. Served **before** the session gate, so it is
the only page an unauthenticated visitor can reach. Reachable at `/` when login is on
and you have no session, and at `/welcome` always.

## Why a second entry rather than a route in the app

`web/vite.config.ts` builds two HTML entries. The app bundle pulls in the graph view,
the setup wizard and the whole API client — none of which a visitor without a session
can use, and all of which would have to load before the pitch painted. Both entries
share `styles.css` and `palette.ts`, so the token layer stays single-sourced and a
returning visitor's chosen preset carries across from the app.

## What the server does

`src/server/api.ts`, immediately above the session gate:

- `PUBLIC_PAGES` (`/`, `/welcome`) → serves `landing.html` to a signed-out browser
  instead of a 302 to `/auth/login`.
- `isPublicAsset` → `/assets/*`, the favicon set and the manifest. The hashed bundle is
  not a secret; every route it calls is still gated, and withholding it would only have
  stopped the landing page booting.
- `serveStaticExact` → the same static handler **without** the SPA `index.html`
  fallback. A request for `/landing.html` against a `dist/` built before this existed
  must 404 forward, not hand an anonymous visitor the app shell, which would then 401
  every call it makes and look like a broken product rather than a missing build.
- `/api/auth/me` still 401s for a signed-out caller. That is how the page decides
  between "Sign in" and "Open the chronicle" — a `{ user: null }` body means login is
  off entirely, which is a 200, so the *body* decides and not the status.

## Lineage

The same one, applied to a title page rather than to a reading pane
(`.design/LINEAGE.md`). The page is a **title page and specimen sheet of a book**, which
settles most questions before they are asked:

1. **The ruled column with a marginal gutter.** Section numbers hang in it, in roman,
   the way the app numbers scenes. The left edge is sacred here as it is there.
2. **The pitch is a specimen, not a claim.** The hero sets one real turn — folio, the
   author's raw words, the rubricated initial, the state delta it emitted, the frame
   budget as ruled scales. The thing this engine has that a prompt does not is the
   delta; describing it is weaker than setting it, and the specimen reuses the app's own
   `.turn` / `.folio` / `.prose` rules so it cannot drift from what it depicts.
3. **Reading copy is serif; only chrome is sans.** Lede, body, captions, steps and
   small-caps labels are Hoefler Text. Nav, tabs, buttons, table heads and tags are
   Seravek. Values are PT Mono. Three registers, same domains as the app.
4. **One rule-break, once.** The specimen plate bleeds off the right edge of the
   viewport; everything else obeys the column, which is the only reason the break reads
   as a decision rather than as a mistake.

### The accent budget, per viewport

Three appearances, as the lineage requires — so within the hero it is the masthead call,
the hero call, and the one frame-budget slot actually near its ceiling. The other three
meters are engraved in `--ink-3`. In the connector section it is the masthead call, the
indicator lamp on the live endpoint, and the selected toggle. `write` in the tool table
takes the **divergence** colour, not the accent, because that is what the tag already
means: the tool mutates the chronicle.

## Things that were wrong first, kept as notes in the CSS

- The plate's bleed subtracted the container padding twice, overshooting by 24px and
  cutting the plate's own right padding off against the viewport.
- The bleed lived on the hero *grid*, which below 1080px also widened the column the
  copy shares with the plate — two lines of the lede ran off the right of a phone.
- `display: none` on the hero's empty gutter cell promoted every later grid item one
  column left, putting the lede in a 72px gutter with the plate on top of it.
- Sticky folios read as running heads for most of a scroll, then pinned two numerals on
  screen at once at every section boundary.
- The masthead's call stretched across the whole bar on a phone, because the rule that
  stretches the *hero's* calls was not scoped to them.
- `--ink-4` was used for folio numbers, step numbers and copy labels — seven times. It
  sits at 2.5–3.0:1 by design. `.design/palettes.mjs` forbids exactly this and the guard
  only grepped `styles.css`; it now covers this stylesheet too, which was verified by
  planting a violation and watching it fail.

## Verification

- **Static**: `node .design/palettes.mjs` — 387 pairs, gamut, greyscale spread, and the
  `--ink-4` guard now extended to `landing.css`.
- **Rendered**: a composited-colour sweep of this page over every preset and every
  connector panel — **8,586 text instances across 9 presets × 4 panels, 0 failures**.
  One caveat worth recording for anyone repeating it: a mid-flight `background-color`
  transition computes to `oklab()`, which `canvas` `fillStyle` rejects, so both
  foreground and background read back as black and the whole page appears to fail at
  ~1.05:1. Settle the transitions and move the pointer off the page before measuring.
- **Layout**: no horizontal overflow at 390 / 768 / 1440 / 1920, and the plate reaches
  the viewport's right edge at each of them.

## Honesty

The connector section says out loud that a verified MCP token is not yet tied to
per-user world access. A page selling an engine whose central rule is "the prose must not
imply more than the state records" cannot then imply more than the code does.
