/**
 * The public face — the one page a visitor with no session can reach.
 *
 * Same lineage as the app (`.design/LINEAGE.md`): the chronicle and the instrument. Which
 * means this is a *title page and specimen sheet*, not a SaaS landing page. Three decisions
 * follow from that and are worth stating, because each one is a thing a landing page
 * normally does that this deliberately does not:
 *
 *  - **Sections are numbered in the gutter, in roman**, the way the app numbers scenes. The
 *    left edge is sacred here as it is there; the numbers hang outside it as marginalia.
 *  - **The pitch is a specimen, not a claim.** The hero shows a real turn — folio, raw
 *    input, rubricated initial, the state delta it emitted — because the one thing this
 *    engine has that a prompt does not is the delta, and describing it is weaker than
 *    setting it.
 *  - **One rule-break, once.** The specimen plate bleeds off the right edge of the
 *    viewport. Everything else obeys the column.
 *
 * Copy is the README's voice, deliberately: dry, specific, and willing to name what is not
 * built yet. A page that oversells an engine whose whole argument is "the prose must not
 * imply more than the state records" would be arguing against itself.
 */

import { useCallback, useEffect, useState } from 'react';
import { PRESETS, resolvePalette, savePalette } from '../palette.ts';

const MCP_URL = 'https://fabulist.rast.io/mcp';
const REPO = 'https://github.com/ra100/fabulist';
const KOFI = 'https://ko-fi.com/D4I523F8EW';

/* -------------------------------------------------------------------- pieces */

/** Roman, lowercase — the same numbering the app gives its scenes. */
const ROMAN = ['i', 'ii', 'iii', 'iv', 'v', 'vi', 'vii', 'viii', 'ix'];

function Section({
  n,
  id,
  title,
  kicker,
  children,
  wide,
}: {
  n: number;
  id?: string;
  title: string;
  kicker?: string;
  children: React.ReactNode;
  wide?: boolean;
}) {
  return (
    <section className="lp-sec" {...(id ? { id } : {})}>
      <div className="lp-folio" aria-hidden="true">
        {ROMAN[n - 1]}
      </div>
      <div className={wide ? 'lp-body wide' : 'lp-body'}>
        <h2 className="lp-h2">
          {title}
          <i />
        </h2>
        {kicker ? <p className="lp-kicker">{kicker}</p> : null}
        {children}
      </div>
    </section>
  );
}

/**
 * A code block with a caption and a copy control.
 *
 * The caption is set in small caps in the text serif, which is the whole reason the serif
 * carries the apparatus and not just the prose — an engraved label above a monospace block
 * is how a manual does this, and it is not the same gesture as a sans-serif heading.
 */
function useCopy(code: string): [boolean, () => void] {
  const [copied, setCopied] = useState(false);
  const copy = useCallback(() => {
    navigator.clipboard?.writeText(code).then(
      () => {
        setCopied(true);
        setTimeout(() => setCopied(false), 1400);
      },
      () => {
        // A clipboard the browser refuses is not worth an error state; the text
        // is right there and selectable.
      },
    );
  }, [code]);
  return [copied, copy];
}

function Snippet({ label, code }: { label: string; code: string }) {
  const [copied, copy] = useCopy(code);
  return (
    <figure className="lp-snip">
      <figcaption>
        <span className="eyebrow">{label}</span>
        <button type="button" onClick={copy} className="lp-copy">
          {copied ? 'copied' : 'copy'}
        </button>
      </figcaption>
      <pre>{code}</pre>
    </figure>
  );
}

/* ---------------------------------------------------------------------- hero */

/**
 * The specimen: one committed turn, exactly as the book view sets it.
 *
 * Reuses `.turn` / `.folio` / `.prose.opens-scene` from the app's own stylesheet rather
 * than restyling them here — if the book view's typography changes, this changes with it,
 * which is the point of a specimen.
 */
function Specimen() {
  return (
    <div className="lp-plate">
      <div className="lp-plate-head">
        <span className="eyebrow">a committed turn</span>
        <span className="mono dimmer">saint verrow · scene i</span>
      </div>

      <article className="turn book opens-scene">
        <div className="folio">i·4</div>
        <div className="raw">i try to talk him down, mention his sister, dont draw</div>
        <p className="prose">
          The captain’s hand stayed exactly where it was. Anselm did not step back — stepping back would
          have been a kind of answer — and said the girl’s name once, quietly, the way you set an object
          down on a table between two men who are both armed.
        </p>
        <div className="turn-tools">
          <span className="move">escalate, then withhold</span>
          <span className="tag canon">canon</span>
        </div>
      </article>

      <div className="lp-delta">
        <span className="eyebrow rule">the delta it emitted</span>
        <dl className="lp-delta-rows">
          <div>
            <dt>edges</dt>
            <dd>
              <span className="lp-add">+2</span> anselm —knows→ vela.whereabouts
            </dd>
          </div>
          <div>
            <dt>sheets</dt>
            <dd>captain.regard[anselm] → wary</dd>
          </div>
          <div>
            <dt>threads</dt>
            <dd>
              the garrison’s quota <span className="lp-add">tension 4→6</span>
            </dd>
          </div>
          <div>
            <dt>facts</dt>
            <dd>vela.location known-by: anselm, captain</dd>
          </div>
        </dl>
        <p className="lp-plate-foot">
          Anything the prose implied but the delta omitted did not happen. That is the contract, and it
          is enforced, not encouraged.
        </p>
      </div>

      {/* The instrument half of the lineage: what the frame actually cost, drawn as ruled
          scales rather than filled progress bars. This is what `/why` reports, and putting
          it under the prose is the argument — the book and the panel are the same object. */}
      <div className="lp-budget">
        <span className="eyebrow rule">frame budget · 4,180 of 8,000</span>
        {[
          ['canon', 52],
          ['cast', 71],
          ['threads', 38],
          ['recent turns', 84],
        ].map(([label, pct]) => (
          <div className="lp-budget-row" key={label as string}>
            <span>{label}</span>
            {/* Engraved, except one. The accent is an indicator lamp on a
                three-appearance budget, so only the slot actually close to its
                ceiling lights up — four accent bars would spend the whole
                budget on a decoration. */}
            <span className={(pct as number) > 80 ? 'meter high' : 'meter'}>
              <i style={{ width: `${pct}%` }} />
            </span>
            <span className="mono">{pct}%</span>
          </div>
        ))}
      </div>
    </div>
  );
}

/* ----------------------------------------------------------------------- mcp */

type ChatTab = 'claude' | 'chatgpt' | 'other' | 'self';

const CHAT_TABS: Array<{ key: ChatTab; label: string }> = [
  { key: 'claude', label: 'Claude' },
  { key: 'chatgpt', label: 'ChatGPT' },
  { key: 'other', label: 'Any MCP client' },
  { key: 'self', label: 'Your own server' },
];

/**
 * The connector URL, once.
 *
 * It was originally repeated in each tab as a snippet as well, which meant the same string
 * appeared twice within one screen and neither copy looked authoritative. The lamp lives
 * here, so this is the place the URL belongs.
 */
function Endpoint() {
  const [copied, copy] = useCopy(MCP_URL);
  return (
    <div className="lp-lamp-box">
      <span className="lp-lamp" aria-hidden="true" />
      <span className="eyebrow">live endpoint</span>
      <button type="button" className="lp-endpoint" onClick={copy} title="copy">
        <code>{MCP_URL}</code>
        <span className="lp-endpoint-copy">{copied ? 'copied' : 'copy'}</span>
      </button>
      <span className="mono dimmer">streamable http · oauth 2.1 · rfc 9728</span>
    </div>
  );
}

function ChatPanel({ tab }: { tab: ChatTab }) {
  if (tab === 'claude') {
    return (
      <>
        <ol className="lp-steps">
          <li>
            In Claude, open <b>Settings → Connectors</b> and choose <b>Add custom connector</b>.
          </li>
          <li>Paste the server URL. Claude registers itself as an OAuth client; there is nothing to create by hand on either side.</li>
          <li>Sign in on the consent screen that opens, and approve access to your worlds.</li>
          <li>
            Ask it to start a story. It will call <code>list_worlds</code>, then{' '}
            <code>propose_turn</code>, and write the prose itself.
          </li>
        </ol>
        <p className="lp-note">
          Claude connects from Anthropic’s cloud rather than from your machine, so the server has to be
          reachable on the public internet — a <code>127.0.0.1</code> URL cannot work here. Use the
          hosted instance above, or put your own behind a real hostname.
        </p>
      </>
    );
  }

  if (tab === 'chatgpt') {
    return (
      <>
        <ol className="lp-steps">
          <li>
            In ChatGPT, open <b>Settings → Connectors</b> and add a custom MCP server.
          </li>
          <li>Paste the same URL. Same wire format, same OAuth handshake — this is one server, not two integrations.</li>
        </ol>
        <p className="lp-note">
          The general connector path works unmodified. ChatGPT’s <i>deep research</i> surface
          additionally expects a <code>search</code>/<code>fetch</code> compatibility pair, which is not
          implemented yet — so Fabulist will not appear in that particular picker until it is.
        </p>
      </>
    );
  }

  if (tab === 'other') {
    return (
      <>
        <p className="lp-p">
          The transport is Streamable HTTP with a bearer token on every request. Anything that speaks
          MCP — Codex, Continue, Zed, your own script against the reference SDK — connects the same way.
        </p>
        <Snippet
          label="mcp client config"
          code={`{
  "mcpServers": {
    "fabulist": {
      "type": "http",
      "url": "http://127.0.0.1:4317/mcp",
      "headers": { "Authorization": "Bearer $MCP_DEV_TOKEN" }
    }
  }
}`}
        />
      </>
    );
  }

  return (
    <>
      <p className="lp-p">
        <code>/mcp</code> is not mounted until you say how it should authenticate. Two ways, and the
        first is for one operator on one machine:
      </p>
      <Snippet
        label="enable /mcp"
        code={`# one static bearer, constant-time compared
export MCP_DEV_TOKEN=$(openssl rand -hex 32)
pnpm serve

# or verify real tokens against any RFC 8414 issuer
export MCP_OAUTH_ISSUER=https://your-tenant.authkit.app
export MCP_OAUTH_AUDIENCE=client_01...
export MCP_RESOURCE_URL=https://your-host/mcp`}
      />
      <p className="lp-note">
        With neither variable set the route does not exist — it is never mounted-but-open. On any
        non-localhost bind the server refuses to guess a resource URL and will not mount{' '}
        <code>/mcp</code> without an explicit <code>MCP_RESOURCE_URL</code>, because the failure that
        guard prevents is handing a real client a metadata document pointing at{' '}
        <code>http://0.0.0.0</code>.
      </p>
    </>
  );
}

const TOOLS: Array<[string, string, string]> = [
  ['propose_turn', 'write', 'Runs the real pipeline: classify, integrity gate, referee verdict, director move, delta extraction. Returns the scene frame for your model to narrate.'],
  ['commit_narration', 'write', 'Hands the prose back. It goes through the same prose gate, extraction and commit as a turn narrated in-process.'],
  ['resolve_interrupt', 'write', 'Answers the integrity gate when a turn was stopped rather than written.'],
  ['get_scene_frame', 'read', 'The budgeted frame a narrator role would receive — entities, threads and recent turns actually in scope.'],
  ['get_state', 'read', 'Session, counts, pending consequences, token usage.'],
  ['get_cast · get_entity', 'read', 'Sheets, locks, appearance, relations.'],
  ['get_threads · get_facts', 'read', 'Tension dials and who knows what.'],
  ['list_worlds · list_stories', 'read', 'What this token can reach.'],
];

/* ------------------------------------------------------------------- palettes */

/**
 * The app's own picker, reused whole — `.palettes` / `.palette-choice` / `.swatch`, and each
 * swatch carrying its own `data-palette` so it renders in the preset it offers rather than in
 * the active one. Duplicating it here would have meant a second place for nine colours to
 * drift out of agreement.
 */
function PaletteStrip() {
  const [current, setCurrent] = useState(resolvePalette);
  return (
    <div className="palettes">
      {PRESETS.map((p) => (
        <button
          type="button"
          key={p.key}
          className={`palette-choice${current === p.key ? ' selected' : ''}`}
          aria-pressed={current === p.key}
          title={p.source}
          onClick={() => {
            savePalette(p.key);
            setCurrent(p.key);
          }}
        >
          <span className="swatch" data-palette={p.key} aria-hidden="true" />
          <span className="palette-text">
            <b>
              {p.label}
              {p.mode === 'light' ? <span className="tag">light</span> : null}
            </b>
            <span className="palette-genre">{p.genre}</span>
            <span>{p.source}</span>
          </span>
        </button>
      ))}
    </div>
  );
}

/* ---------------------------------------------------------------------- page */

export function Landing() {
  const [tab, setTab] = useState<ChatTab>('claude');
  // null while unknown: a visitor who already has a session should be offered the
  // chronicle, not a sign-in they do not need. 401 here is the normal answer and
  // not an error — it is how the gate says "not signed in".
  const [signedIn, setSignedIn] = useState<boolean | null>(null);

  useEffect(() => {
    let live = true;
    fetch('/api/auth/me')
      .then((r) => (r.ok ? r.json() : null))
      // `{ user: null }` is the honest answer when login is not configured at
      // all, and it is a 200 — so the body decides this, not the status.
      .then((d) => {
        if (live) setSignedIn(!!d?.user);
      })
      .catch(() => {
        if (live) setSignedIn(false);
      });
    return () => {
      live = false;
    };
  }, []);

  const enter = signedIn ? { href: '/', label: 'Open the chronicle' } : { href: '/auth/login', label: 'Sign in' };

  return (
    <div className="lp">
      <header className="lp-bar">
        <a className="lp-word" href="#top">
          <img className="lp-badge" src="/favicon.svg" width={22} height={22} alt="" />
          <span>Fabulist</span>
        </a>
        <nav className="lp-nav">
          <a href="#engine">the engine</a>
          <a href="#chat">your own chat</a>
          <a href="#local">run it</a>
          <a href="#worlds">worlds</a>
        </nav>
        <a className="lp-cta primary" href={enter.href}>
          {enter.label}
        </a>
      </header>

      <main className="lp-main" id="top">
        {/* --- hero: the one place the column is broken --------------------- */}
        <section className="lp-hero">
          <div className="lp-folio" aria-hidden="true" />

          <div className="lp-hero-copy">
            <p className="eyebrow">a state-first fiction engine</p>
            <h1 className="lp-h1">
              The prose is a view.
              <br />
              The world is the graph underneath.
            </h1>
            <p className="lp-lede">
              An AI game master runs your story inside a universe it has actually read, keeps a typed
              world-model behind the scenes, and stays consistent when you do something nobody planned
              for.
            </p>
            <p className="lp-lede">
              Every narrated turn has to emit a state delta. That single rule is why it can still tell
              you who knows what forty turns later, and why a contradiction is a caught error rather
              than a thing you notice in chapter nine.
            </p>
            <div className="lp-actions">
              <a className="lp-cta primary lg" href={enter.href}>
                {enter.label}
              </a>
              <a className="lp-cta" href="#local">
                Run it locally
              </a>
              <a className="lp-quiet" href="#chat">
                or drive it from Claude and ChatGPT →
              </a>
            </div>
          </div>

          <div className="lp-hero-plate">
            <Specimen />
          </div>
        </section>

        {/* --- ii ---------------------------------------------------------- */}
        <Section
          n={1}
          id="engine"
          title="Three roles, because one prompt cannot hold three jobs"
          kicker="A single instruction asking a model to adjudicate, pace and write at once does all three badly, and gives you no way to tell which one failed. So the game master is split, and each part is answerable for one question."
        >
          <div className="lp-roles">
            {[
              ['Referee', 'What is true?', 'Reads canon and the chronicle overlay, and refuses what contradicts either. Its verdict is structured, not prose.'],
              ['Director', 'What happens next?', 'Chooses the move, owns pacing, and queues the consequences that will surface turns later whether you remember them or not.'],
              ['Narrator', 'How is it said?', 'Writes the prose and nothing else. It is the one role designed to be swapped — which is what makes the next section possible.'],
            ].map(([name, q, body]) => (
              <div className="lp-role" key={name}>
                <h3 className="name">{name}</h3>
                <p className="lp-role-q">{q}</p>
                <p className="lp-p sm">{body}</p>
              </div>
            ))}
          </div>
          <p className="lp-note">
            <code>/why</code> shows the frame that was assembled, the move that fired, both verdicts,
            the prose lint score and the token budget per slot. The machinery is inspectable on purpose;
            a writing tool you cannot audit is a writing tool you end up fighting.
          </p>
        </Section>

        {/* --- iii --------------------------------------------------------- */}
        <Section
          n={2}
          title="It will stop rather than write your character out of character"
          kicker="Brother Anselm has held a vow of nonviolence for thirty years. Ask for this and the game master does not narrate it, and does not silently soften it either."
        >
          <div className="lp-gate">
            <div className="raw">i stab the captain</div>
            <div className="interrupt">
              <p>
                Brother Anselm holds this: harm no living thing. Nothing in this scene forces it. Taken
                straight, this is not a choice they have access to.
              </p>
              <div className="opts">
                <div className="opt">
                  <b>a</b> Rewrite it — I want a different approach
                </div>
                <div className="opt">
                  <b>b</b> Something has broken in Brother Anselm. Establish what, and play the fallout.
                </div>
                <div className="opt">
                  <b>c</b> I meant a different character
                </div>
                <div className="opt">
                  <b>d</b> Override — deliberate heel turn, play it straight
                </div>
              </div>
            </div>
          </div>
          <p className="lp-p">
            Option <b>d</b> always exists. An author has to be able to break their own character on
            purpose; the gate exists to make it <i>cost</i> something rather than to prevent it. Take it
            and the break is written onto the sheet, spawns the highest-tension thread in the story, and
            is recorded in the divergence ledger where you can find it again.
          </p>
          <p className="lp-p">
            Strictness is a dial: <b>permissive</b> narrates anything, <b>coaching</b> pushes back only
            in fiction, <b>strict</b> interrupts on a genuine breach, <b>iron</b> also stops on off-key.
            World facts get the opposite default — mention a tavern that does not exist and it is quietly
            created, and real from then on.
          </p>
        </Section>

        {/* --- iv ---------------------------------------------------------- */}
        <Section
          n={3}
          id="chat"
          wide
          title="Or keep the chat you already use"
          kicker="Fabulist speaks MCP, so the front end does not have to be this app. Point Claude or ChatGPT at the server and it becomes the world-model behind a conversation you were having anyway."
        >
          <div className="lp-split">
            <div>
              <p className="lp-p">
                The division is the one the engine already made. The mechanical roles you want
                deterministic — the integrity gate, the referee, delta extraction — keep running on the
                server. Only the narrator moves, and the narrator was always the swappable one: prose is
                a view of state, so it does not matter which model renders it.
              </p>
              <p className="lp-p">
                Which means for that turn the server makes <b>zero model calls</b>. Your subscription
                writes the prose; the graph remembers what it meant. There is no key to add and no
                per-turn cost on this side.
              </p>
            </div>
            <Endpoint />
          </div>

          {/* Not `role="tablist"` / `role="tab"`. That role carries a keyboard
              contract — arrow keys move between tabs, Home/End jump to the ends —
              and announcing a widget whose contract is not implemented is worse
              for a screen-reader user than announcing four honest buttons. These
              are toggles over one region, and they say so. */}
          <div className="lp-tabs" role="group" aria-label="How to connect">
            {CHAT_TABS.map((t) => (
              <button
                type="button"
                key={t.key}
                aria-pressed={tab === t.key}
                className={tab === t.key ? 'active' : ''}
                onClick={() => setTab(t.key)}
              >
                {t.label}
              </button>
            ))}
          </div>
          <div className="lp-panel">
            <ChatPanel tab={tab} />
          </div>

          <span className="eyebrow rule lp-mt">what your chat gets to call</span>
          <div className="scroll-x">
            <table className="lp-tools">
              <thead>
                <tr>
                  <th>tool</th>
                  <th>kind</th>
                  <th>does</th>
                </tr>
              </thead>
              <tbody>
                {TOOLS.map(([name, kind, body]) => (
                  <tr key={name}>
                    <td>
                      <code>{name}</code>
                    </td>
                    <td>
                      <span className={kind === 'write' ? 'tag chronicle' : 'tag'}>{kind}</span>
                    </td>
                    <td className="dim">{body}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="lp-note">
            The a/b/c/d gate survives the move to a chat window as a two-call exchange:{' '}
            <code>propose_turn</code> returns the interrupt instead of a committed turn, your chat puts
            the choice to you in plain language, and <code>resolve_interrupt</code> commits what you
            decided.
          </p>
          <p className="lp-note caveat">
            One thing to know before pointing a shared account at it: a verified token is not yet tied
            to per-user world access, so any valid token sees the world that server has open. That is
            fine for one operator and it is not yet a multi-tenant boundary. Said here rather than
            discovered later.
          </p>
        </Section>

        {/* --- v ----------------------------------------------------------- */}
        <Section
          n={4}
          id="local"
          title="Run the whole thing on your own machine"
          kicker="Nothing needs an API key to start. The default provider is a deterministic mock that runs offline — it writes deliberately plain prose, because its job is to prove the machinery rather than to write well."
        >
          <div className="lp-two">
            <Snippet
              label="from source"
              code={`git clone ${REPO}
cd fabulist
pnpm install
pnpm build:web
pnpm serve            # http://127.0.0.1:4317`}
            />
            <Snippet
              label="or docker"
              code={`docker run -p 4317:4317 \\
  -v ./fabulist-data:/data \\
  ra100/fabulist:latest`}
            />
          </div>
          <p className="lp-p">
            An empty save opens a setup wizard. It asks three things — where are we playing, where and
            when in it, and who are you — and turns the answers into a world. Nothing is read or spent
            before you have seen a page count and a cost. The fastest route through is the built-in
            example: Saint Verrow, a monastery under a secular garrison.
          </p>

          <span className="eyebrow rule lp-mt">then point it at a model</span>
          <p className="lp-p">
            Every one of these fails differently, and most of them fail hours into a session rather than
            at startup. So there is a command whose whole job is to say which are usable here, and to
            print the one-line fix for the ones that are not.
          </p>
          <Snippet label="check this machine" code={'pnpm providers'} />
          <div className="scroll-x">
            <table className="lp-tools compact">
              <thead>
                <tr>
                  <th>profile</th>
                  <th>auth</th>
                  <th>narrator</th>
                </tr>
              </thead>
              <tbody>
                {[
                  ['mock', 'none', 'deterministic, offline'],
                  ['local', 'none', 'ollama qwen2.5'],
                  ['vllm · llamacpp', 'none', 'whatever you launched'],
                  ['bedrock', 'AWS profile', 'claude sonnet'],
                  ['google', 'gcloud OAuth', 'gemini pro'],
                  ['copilot', 'Copilot OAuth', 'gpt-4o'],
                  ['cheap · balanced · premium', 'API key', 'deepseek → anthropic sonnet'],
                ].map(([p, a, m]) => (
                  <tr key={p}>
                    <td>
                      <code>{p}</code>
                    </td>
                    <td className="dim">{a}</td>
                    <td className="dim">{m}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="lp-note">
            A local server needs no key and gets no <code>Authorization</code> header, because vLLM and
            llama.cpp reject a bogus bearer. Switching to a profile this machine cannot reach refuses
            outright rather than quietly degrading — finding out three turns later that the mock has
            been writing is worse than being told no.
          </p>
        </Section>

        {/* --- vi ---------------------------------------------------------- */}
        <Section
          n={5}
          id="worlds"
          title="Play inside a universe it has read"
          kicker="Name a franchise. It finds the wiki, proposes which corner of it to read, and reports the page count, the cast it found and the token spend before committing to any of it."
        >
          <div className="scroll-x">
            <table className="lp-tools compact">
              <thead>
                <tr>
                  <th>depth</th>
                  <th className="num">pages</th>
                  <th className="num">hops</th>
                  <th>prose pass</th>
                  <th>voice cards</th>
                </tr>
              </thead>
              <tbody>
                <tr>
                  <td>
                    <code>skim</code>
                  </td>
                  <td className="num mono">~150</td>
                  <td className="num mono">1</td>
                  <td className="dim">no</td>
                  <td className="dim">no</td>
                </tr>
                <tr>
                  <td>
                    <code>mid</code>
                  </td>
                  <td className="num mono">~600</td>
                  <td className="num mono">2</td>
                  <td className="dim">core entities</td>
                  <td className="dim">main cast</td>
                </tr>
                <tr>
                  <td>
                    <code>deep</code>
                  </td>
                  <td className="num mono">~3000</td>
                  <td className="num mono">3</td>
                  <td className="dim">everything</td>
                  <td className="dim">all speakers</td>
                </tr>
              </tbody>
            </table>
          </div>
          <p className="lp-p">
            Depth is per-subgraph rather than global, because you play in a small corner of a universe:
            a shallow baseline with deep pockets only where you have actually been is the right shape.
            The first pass needs no model at all and produces a playable cast out of infoboxes and
            categories. The second adds what only prose contains — typed relations, timeline events,
            how a character speaks — and it refuses more than it accepts.
          </p>
          <Snippet
            label="what a real pass reports"
            code={`pass B: 12 pages, 18 relations, 17 events, 2 voice cards
dropped: 18 unevidenced, 12 off-vocabulary, 11 unknown target`}
          />
          <p className="lp-note">
            Watch the second line. Every relation has to carry a verbatim quote that is then checked
            back against the page, predicates come from a closed vocabulary, and targets must be
            entities that already exist — so one bad extraction cannot seed a subgraph of fiction. A
            suspiciously low drop rate means the extractor is inventing, not that the wiki was clean.
          </p>
        </Section>

        {/* --- vii --------------------------------------------------------- */}
        <Section
          n={6}
          title="Nine palettes, one per genre"
          kicker="A genre name on its own is a mood, and a mood forbids nothing — which is how science fiction ends up blue-and-cyan every time. So each preset is pinned to a specific artefact instead, and that source is the tie-breaker for every later colour question."
          wide
        >
          <PaletteStrip />
          <p className="lp-note">
            Pick one; this page changes with it, and so will the app when you sign in. All nine keep the
            same discipline — one accent on a three-appearance budget, a second colour reserved for
            divergence from canon, tinted neutrals, and no component that knows a colour by name. A
            preset may move the hue. It may not loosen the rules.
          </p>
        </Section>
      </main>

      <footer className="lp-foot">
        <div className="lp-folio" aria-hidden="true">
          <img className="lp-badge" src="/favicon.svg" width={20} height={20} alt="" />
        </div>
        <div className="lp-body">
          <span className="eyebrow rule">colophon</span>
          <div className="lp-foot-grid">
            <p className="lp-p sm">
              MIT licensed, and the reasoning is in the repository rather than in a pitch:{' '}
              <a href={`${REPO}/blob/main/DESIGN.md`}>DESIGN.md</a> is the argument,{' '}
              <a href={`${REPO}/blob/main/README.md`}>README.md</a> is how to run it, and the known gaps
              are listed with the same care as the features.
            </p>
            <p className="lp-p sm">
              Node 24 runs the TypeScript directly, so there is no backend build step. 736 tests, all
              offline. Set in Hoefler Text and Seravek, on iron gall.
            </p>
          </div>
          <div className="lp-foot-links">
            <a href={REPO}>github.com/ra100/fabulist</a>
            <a href={KOFI}>ko-fi</a>
            <a href="#top">back to top</a>
          </div>
        </div>
      </footer>
    </div>
  );
}
