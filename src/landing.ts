// The signed-out face of `/`: what austere cloud is, and the way in.
// Static HTML and CSS only: the CSP allows no script and no fetch; the only asset is the same-origin favicon.

import type { Theme } from "./theme";
import { INSTALL_GUIDE, ORIGIN, REPO, cmd, document, pageHeaders, type Meta } from "./site";

const TITLE = "Share AI coding agent plans for team review · austere";
const DESCRIPTION =
  "Your coding agent publishes its plan or design as a private page. Each reviewer gets a named link. You approve which notes reach the agent.";

export const LANDING_META: Meta = {
  title: TITLE,
  description: DESCRIPTION,
  path: "/",
  ogTitle: "Send your agent’s plan out for review",
  ogDescription: "Named review links for pages your coding agent writes. Reviewers mark the exact part; notes wait for your approval.",
  jsonLd: {
    "@context": "https://schema.org",
    "@graph": [
      { "@type": "WebSite", "@id": `${ORIGIN}/#website`, name: "austere", url: `${ORIGIN}/` },
      {
        "@type": "SoftwareApplication",
        "@id": `${ORIGIN}/#software`,
        name: "austere",
        url: `${ORIGIN}/`,
        description: DESCRIPTION,
        applicationCategory: "DeveloperApplication",
        operatingSystem: "Any",
        softwareRequirements: "Node.js 22.18 or later",
        sameAs: [REPO, "https://www.npmjs.com/package/austere-axi"],
      },
    ],
  },
};

const DELTA = (n: number) =>
  `<span class="delta" aria-hidden="true"><svg viewBox="0 0 30 30"><path d="M15 3 28 26H2z" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="miter"/><text x="15" y="23" text-anchor="middle">${n}</text></svg></span>`;

const REGISTER = (links: boolean) => `<div class="register" aria-hidden="true">
<div class="reg-r reg-h"><span>Issued to</span><span class="lk">Link</span><span>Status</span></div>
<div class="reg-r"><span>Ana</span><span class="lk">/p/k3v9qz#i=…</span><span class="live">Live</span></div>
<div class="reg-r"><span>Ben</span><span class="lk">/p/k3v9qz#i=…</span><span class="live">Live${links ? " · 7d" : ""}</span></div>
<div class="reg-r"><span class="revoked">Cy</span><span class="lk">/p/k3v9qz#i=…</span><span class="revoked">Revoked</span></div>
</div>`;

const HELD_NOTE = (cls = "") => `<div class="note ${cls}">
<div class="note-h"><b>Ben</b><span class="tag held">Held</span></div>
<p>“Rollback step is missing before writes switch.”</p>
<div class="acts"><span>Send</span><span>Discard</span></div>
</div>`;

const SHEET = `<div class="sheet hero-sheet" role="img" aria-label="Sample review page: Ben highlighted the third rollout step and left a note that waits for the owner’s approval.">
<div class="sheet-app" aria-hidden="true">
<div class="app-bar"><b>Q3 migration plan</b><span class="chips"><span class="chip">Owner</span><span class="chip">Ana</span><span class="chip">Ben</span></span></div>
<div class="app-body">
<h3>Cut over to the new region</h3>
<div class="rows">
<div class="row"><i>1</i><span>Copy data to the new region</span><span>Mon</span></div>
<div class="row"><i>2</i><span>Switch reads</span><span>Tue</span></div>
<div class="row active"><i>3</i><span>Switch writes</span><span>Wed</span></div>
</div>
<div class="notes">
${HELD_NOTE("new")}
<div class="note"><div class="note-h"><b>Ana</b><span class="tag sent">Sent</span></div><p>“Keep the old read path for a week.”</p><p class="reply">Added step 2b: keep old reads until the 14th.</p></div>
</div>
</div>
</div>
${REGISTER(false)}
<div class="reg-foot" aria-hidden="true">Sample page · Sheet 1 of 1</div>
</div>`;

function body(signIn: string | null): string {
  const signInBtn = signIn ? `<a class="btn ghost" href="${signIn}">Sign In</a>` : "";
  return `<section class="hero grid-bg" aria-labelledby="h1">
<div class="wrap hero-in">
<div class="hero-copy">
<p class="label">Review pages for AI coding agents</p>
<h1 id="h1">Send your agent’s plan out for review.</h1>
<p class="lede">Your coding agent publishes its plan, design or report as a private page. Each reviewer gets a link with their name on it and leaves notes on the exact part they mean. You choose which notes reach the agent.</p>
${cmd("npm install -g austere-axi")}
<div class="cta-row"><a class="btn primary" href="#start">Get started</a><a href="${INSTALL_GUIDE}">Read the install guide</a></div>
<p class="facts">Works with Claude Code, Codex and Cursor · Open source CLI · Cloud free for a limited time</p>
</div>
${SHEET}
</div>
</section>

<section class="sec" aria-labelledby="why">
<div class="wrap">
<div class="sec-head"><p class="label">Why a page</p><h2 id="why">Reviewing a plan in chat is slow</h2>
<p class="lede">austere-axi puts your agent’s answer on a page. austere cloud lets other people review it there.</p></div>
<div class="compare">
<div><h3>In chat</h3><ul>
<li>You describe which part you mean before you can say what’s wrong with it</li>
<li>The agent guesses what you pointed at and often rewrites the whole answer</li>
<li>You read all of it again to find what changed</li></ul></div>
<div class="on"><h3>On a page</h3><ul>
<li>You click the cell, box or line you mean and write a note there</li>
<li>The agent changes only that part</li>
<li>The page updates in place and highlights what changed</li></ul></div>
</div>
</div>
</section>

<section class="sec rule-top" id="how" aria-labelledby="how-h">
<div class="wrap">
<div class="sec-head"><p class="label">austere cloud</p><h2 id="how-h">Share the page and keep control of the review</h2></div>

<article class="outcome">
<div class="out-copy"><h3>${DELTA(1)}Publish from your agent</h3>
<p>Ask your agent to publish the page and invite people by name. It runs <code>austere-axi publish</code> and prints one link for each reviewer. When you publish again, the new version goes to the same links.</p></div>
<div class="out-art"><pre class="out" aria-label="Sample output"><span class="ps">$ </span>austere-axi publish plan.html --invite Ana --invite Ben
Ana  ${ORIGIN}/p/k3v9qz#i=…
Ben  ${ORIGIN}/p/k3v9qz#i=…</pre></div>
</article>

<article class="outcome">
<div class="out-copy"><h3>${DELTA(2)}Named links you can revoke</h3>
<p>Each link belongs to one person, and their notes carry their name. Give a link an expiry, such as <code>--expires 7d</code>. When you revoke a link, it stops working at once, even in a tab that is open.</p></div>
<div class="out-art">${REGISTER(true)}${cmd("austere-axi publish revoke plan.html Cy")}</div>
</article>

<article class="outcome">
<div class="out-copy"><h3>${DELTA(3)}Notes wait for your approval</h3>
<p>Reviewers’ notes come to you first. Press <b>Send</b> to pass a note to the agent, or <b>Discard</b> to drop it. The agent’s replies appear on the page under the note. Publish with <code>--auto</code> to send notes straight to the agent.</p></div>
<div class="out-art"><div class="rc-pad" aria-hidden="true">${HELD_NOTE()}</div></div>
</article>

<div class="more">
<h3>Also on every hosted page</h3>
<ul class="feat">
<li><b>See who’s reading</b><span>Chips show who is on the page and whether they’re viewing, away or writing. Turn this off with <code>--no-presence</code>.</span></li>
<li><b>Grant access by email</b><span>From your hub, grant a page to an email address. That person signs in with an email code, Google, GitHub or a passkey.</span></li>
<li><b>Pick up on another machine</b><span><code>austere-axi clone</code> gets your hosted pages on any machine you sign in on, and their notes sync there.</span></li>
<li><b>Keep a copy</b><span><b>Download standalone HTML</b> saves the page as one file that opens in any browser, offline.</span></li>
</ul>
</div>
</div>
</section>

<section class="sec rule-top" id="start" aria-labelledby="start-h">
<div class="wrap">
<div class="sec-head"><p class="label">Get started</p><h2 id="start-h">Share your first page</h2>
<p class="lede">You do steps 1 to 3 once on each machine.</p></div>
<ol class="steps">
<li><b>Install the CLI</b><p class="muted">Needs Node.js 22.18 or later.</p>${cmd("npm install -g austere-axi")}</li>
<li><b>Add the skills to your agent</b>${cmd("npx skills add MandalorianBatman/austere-axi --skill austere --skill austere-setup")}<p class="muted">Then tell your agent “set up austere-axi”. It checks the install and opens a test page.</p></li>
<li><b>Turn on cloud and sign in</b><p class="muted">Cloud features are off until you turn them on.</p>${cmd("austere-axi cloud on")}${cmd("austere-axi cloud login")}</li>
<li><b>Ask your agent to publish</b>${cmd("Publish this plan as a page and invite Ana.", "›")}<p class="muted">The agent prints Ana’s link. Send it to her.</p></li>
</ol>
<div class="aside"><b>Using Claude Code?</b><p>You can install the plugin instead:</p>${cmd("claude plugin marketplace add MandalorianBatman/austere-axi")}${cmd("claude plugin install austere@austere-axi")}<p class="muted">The <a href="${INSTALL_GUIDE}">install guide</a> covers Claude Desktop, Cursor, Codex and manual setup.</p></div>
</div>
</section>

<section class="sec rule-top" aria-labelledby="rev-h">
<div class="wrap split">
<div><p class="label">For reviewers</p><h2 id="rev-h">Your reviewers install nothing</h2></div>
<p class="lede">An invite link opens in any browser. Reviewers click the part they mean, write a note, and see the agent’s reply on the same page. If you grant a page to an email address instead, that person signs in with an email code, Google, GitHub or a passkey and comments under their account name.</p>
</div>
</section>

<section class="sec inverse" id="private" aria-labelledby="priv-h">
<div class="wrap split">
<div class="sec-head"><p class="label">Security</p><h2 id="priv-h">Private until you share it</h2>
<p class="lede">A page leaves your computer only when you publish it. After that, only the people you name can open it.</p>
<p><a class="btn ghost" href="/security">Read how pages stay private</a></p></div>
<ul class="pts">
<li>Cloud features are off by default. Local review needs no account</li>
<li>Every page is invite-only unless you publish with <code>--unlisted</code></li>
<li>The plain page address shows an empty shell, without the title. The content arrives only after the service checks the reviewer’s access</li>
<li>An invite token sits after the <code>#</code> in its link. The browser does not send that part when it requests the page</li>
<li>The service stores invite tokens, sessions and sign-in codes only as SHA-256 hashes</li>
<li>A page stops being served 30 days after your last publish. <code>austere-axi publish rm</code> takes it down now</li>
<li>The <code>austere-axi</code> CLI is open source under the MIT license</li>
<li>austere cloud is a hosted offering, free for a limited time because we don’t have users yet</li>
</ul>
</div>
</section>

<section class="sec rule-top" id="pricing" aria-labelledby="pricing-h">
<div class="wrap split">
<div><p class="label">Pricing</p><h2 id="pricing-h">Free for a limited time</h2></div>
<p class="lede">austere cloud will be a paid service. It is completely free for a limited time because we don’t have users yet. The <code>austere-axi</code> CLI is free and open source under the MIT license.</p>
</div>
</section>

<section class="sec" aria-labelledby="faq-h">
<div class="wrap">
<div class="sec-head"><p class="label">FAQ</p><h2 id="faq-h">Questions before you publish</h2></div>
<div class="faq">
<details><summary>Which agents does it work with?</summary><p>Claude Code, Codex and Cursor. Claude Desktop works through the MCP server. The install guide covers each one.</p></details>
<details><summary>Do I need an account?</summary><p>Not for local review. To publish, you sign in once on each machine with <code>austere-axi cloud login</code>. Reviewers with an invite link don’t need an account.</p></details>
<details><summary>How much does austere cloud cost?</summary><p>austere cloud will be a paid service, but it is free for a limited time because we don’t have users yet. The CLI (<code>austere-axi</code>) is free and open source under MIT.</p></details>
<details><summary>Is austere cloud open source?</summary><p>Only the CLI (<code>austere-axi</code>) is open source under the MIT license. The cloud service is a proprietary hosted offering.</p></details>
<details><summary>Who can read a published page?</summary><p>You, the people you invite, and the email addresses you grant. A page published with <code>--unlisted</code> is the exception: anyone with its address can read it and leave notes.</p></details>
<details><summary>How long does a page stay up?</summary><p>For 30 days after your last publish. Each publish starts the 30 days again. To take a page down now, run <code>austere-axi publish rm</code>.</p></details>
<details><summary>What happens to a note I don’t approve?</summary><p>The note stays on the page, held, until you press <b>Send</b> or <b>Discard</b>. With <code>--auto</code>, notes go straight to the agent.</p></details>
<details><summary>What can I publish?</summary><p>Any page austere-axi makes, such as plans, design reviews, pull request summaries and postmortems. Each upload can be up to 1 MB after compression.</p></details>
<details><summary>What doesn’t it do yet?</summary><p>You can’t attach an image to a note. A page is a snapshot, so it doesn’t show live data.</p></details>
</div>
</div>
</section>

<section class="final grid-bg" aria-labelledby="final-h">
<div class="wrap final-in">
<h2 id="final-h">Send the next plan out for review</h2>
<p class="lede">Install the CLI, sign in once, and ask your agent to publish.</p>
${cmd("npm install -g austere-axi")}
<div class="cta-row"><a class="btn primary" href="#start">Get started</a>${signInBtn}</div>
</div>
</section>`;
}

/** The landing page; `signIn` is the sign-in URL when accounts are on, else null. */
export function landing(signIn: string | null, theme: Theme): Response {
  return new Response(document(LANDING_META, signIn, theme, body(signIn)), {
    // `/` is the hub once signed in, so it is never cached.
    headers: pageHeaders("no-store"),
  });
}
