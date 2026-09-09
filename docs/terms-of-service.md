# Terms of Service

**Applies to:** any Fabulist instance operated by the project maintainer
(currently `fabulist.rast.io`), and to the Fabulist MCP server ("the
Connector") when linked from ChatGPT, Claude, or any other MCP-speaking
client. If you're running your own self-hosted copy of this open-source
project, these terms don't apply between you and us — the
[MIT license](../LICENSE) governs the software itself, and you're the
operator of your own instance.

## 1. What this is

Fabulist is a state-first fiction/role-play engine: an AI game master runs
a story inside a world model, and you play it through a browser or through
an MCP-speaking chat client (ChatGPT, Claude, etc.) connected as a
"connector." It is provided **as-is, free of charge, with no paid tier and
no subscription** (`.design/SAAS-MULTIUSER.md` §7). We take no profit from
running it and make no promise of uptime, support turnaround, or
feature stability.

## 2. Eligibility and accounts

You need an account (via WorkOS/AuthKit sign-in) to use a shared instance.
You're responsible for whatever happens under your account and for keeping
your access to it secure. Don't share your session/tokens with someone
else expecting them to be treated as a separate user — access control is
per-account, not per-human.

## 3. Acceptable use

Don't use Fabulist to:

- Generate content that is illegal where you or the deployment operator is
  located.
- Attempt to bypass, disable, or abuse the character-integrity gate, rate
  limiting, or access controls as a means of attacking the service itself
  (using the "override" option on your *own* story's vow gate is fine —
  that's a documented feature, see `README.md`'s "character integrity
  gate" section).
- Ingest, redistribute, or commercially exploit copyrighted wiki content
  beyond what fair-use, self-serve, BYOK ingestion already allows — see
  [`docs/legal-briefing-fandom-ingest.md`](./legal-briefing-fandom-ingest.md)
  for the actual legal analysis this project follows. Ingesting a fandom
  wiki for your own personal, non-commercial play is the intended use;
  operating a paid or redistributed derivative is not, and is explicitly
  ruled out by this project's own no-monetization posture.
- Abuse a shared instance's resources — excessive automated requests,
  scripted load, or anything designed to exhaust a donated free-tier
  provider allowance (`.design/SAAS-MULTIUSER.md` §6).

We may suspend or remove access for a violation of this section, without
being obligated to first warn you, though we generally will.

## 4. Your content

Stories, characters, and prose you write (or that your connected chat
client writes on your behalf, per §6) are yours. We don't claim ownership
over your story content, and we don't use it to train anything or resell
it. See the [privacy policy](./privacy-policy.md) for what we store and
for how long.

You're responsible for what you write and for what any AI you connect
generates through this service, the same as you would be using any
AI writing tool directly.

## 5. Bring-your-own-key: no billing relationship over model usage

Fabulist does not pay for, mark up, or bill you for any LLM or
image-generation provider usage. Either the deployment operator has
configured a provider (Bedrock, Vertex, a local model, an API key), in
which case that's their infrastructure and their cost, or you're expected
to supply your own credentials for a self-hosted install. We are not a
party to your relationship with whichever underlying model provider is
configured, and its own terms apply to how it handles the content it's
sent (see the privacy policy §9).

## 6. The MCP connector specifically

Linking Fabulist from ChatGPT, Claude, or another MCP client grants that
client the ability to call the same tools your browser session already
has, scoped to your own account — read/write your own stories, never
anyone else's. You are responsible for what that connected client does on
your behalf, including any prose it writes and any turn it commits — the
same as you're responsible for what you type into the browser. See
`.design/MCP-CONNECTOR.md` for exactly how the connector's turn loop
works, if you want the mechanical detail.

## 7. No warranty

This service is provided **"as is,"** without warranty of any kind,
express or implied, to the fullest extent the law allows — the same
standard the [MIT license](../LICENSE) already states for the underlying
software. We do not guarantee the accuracy, quality, or appropriateness of
any AI-generated prose, world content, or illustration. Character
integrity gates and world-plausibility checks are creative-consistency
tools, not moderation or safety systems, and should not be relied on as
either.

## 8. Limitation of liability

To the fullest extent permitted by law, we are not liable for any indirect,
incidental, or consequential damages arising from your use of this
service, including loss of story data. We do keep your data as described
in the privacy policy, but we make no uptime or durability guarantee — if
your stories genuinely matter to you, use `pnpm backup`/`pg_dump` (see
`README.md`/`deploy/README.md`) or ask us for an export.

## 9. Changes

We may update these terms as the project evolves. Material changes will be
noted in the project's release notes. Continued use after a change means
you accept the update; if you don't, stop using the service (and, for a
web account, you may ask us to delete it per the privacy policy).

## 10. Governing law

These terms are governed by the laws applicable to the project maintainer's
jurisdiction, without regard to conflict-of-laws principles, to the extent
any dispute ever needs one — which, given the no-monetization, provided-
as-is nature of this project, is not expected to be a meaningful concern
for either side.

## 11. Contact

See [`docs/support.md`](./support.md).
