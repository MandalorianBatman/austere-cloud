// `/security`: who can open a published page, what the service stores, and what is not built yet.
// Every statement here is a fact from the austere-axi and austere-cloud docs; keep it that way.

import type { Theme } from "./theme";
import { ADVISORY, ORIGIN, SHARE_DESIGN, document, pageHeaders, type Meta } from "./site";

const META: Meta = {
  title: "Security: who can open a shared page · austere",
  description: "Who can open a page you publish with austere, what the service stores, how you take access back, and what is not built yet.",
  path: "/security",
  ogTitle: "How austere cloud keeps shared pages private",
  ogDescription: "Who can open a page you publish, what the service stores, and how you take access back.",
  jsonLd: {
    "@context": "https://schema.org",
    "@type": "WebPage",
    name: "Security: who can open a shared page",
    url: `${ORIGIN}/security`,
    isPartOf: { "@id": `${ORIGIN}/#website` },
  },
};

const LIMITS: [string, string][] = [
  ["Publishes", "20 per owner per day, 100 per IP address per day"],
  ["Notes", "60 per reviewer per page per hour"],
  ["Upload", "1 MB after compression, 16 MB unpacked"],
  ["Packs", "16 per page"],
  ["Email grants", "100 per page"],
  ["Page lifetime", "30 days after the last publish"],
];

const BODY = `<div class="read"><div class="wrap read-in">
<header class="read-head">
<p class="label">Security</p>
<h1>How austere cloud keeps shared pages private</h1>
<p class="lede">This page lists who can open a page you publish, what the service stores, how you take access back, and what is not built yet. The full protocol is in the <a href="${SHARE_DESIGN}">hosted share links design doc</a>.</p>
</header>

<section aria-labelledby="who"><h2 id="who">Who can open a page</h2>
<p>Only these people:</p>
<ul class="plain">
<li><b>People you invite:</b> each <code>--invite &lt;name&gt;</code> link belongs to one person, and their notes carry that name</li>
<li><b>Email addresses you grant:</b> the person signs in with that address</li>
<li><b>You:</b> your account owns every page you publish</li>
<li><b>Anyone with the address:</b> only when you publish with <code>--unlisted</code></li>
</ul>
<p>Anyone else gets an empty shell, or a 403 for the content, notes and change feed.</p></section>

<section aria-labelledby="shell"><h2 id="shell">What the plain address shows</h2>
<p>A page address without access shows a shell titled “Shared page · austere”. The title, the content and the notes arrive only after the service accepts an invite, a grant, your sign-in or the open link of an unlisted page.</p></section>

<section aria-labelledby="back"><h2 id="back">Taking access back</h2>
<ul class="plain">
<li><code>austere-axi publish revoke &lt;file&gt; &lt;name&gt;</code> stops one link at once and disconnects any tab that has it open</li>
<li>When you remove an email grant on the dashboard, that person is cut off at once</li>
<li><code>--expires</code> gives new invites a lifetime, such as <code>30m</code>, <code>12h</code>, <code>7d</code> or <code>2w</code></li>
<li><code>austere-axi publish rm &lt;file&gt;</code> stops every link and deletes the page</li>
</ul></section>

<section aria-labelledby="stores"><h2 id="stores">What the service stores</h2>
<ul class="plain">
<li>The page HTML and its packs, named by SHA-256 hash</li>
<li>Notes, replies, and invite names</li>
<li>Your account’s email address and name</li>
<li>Invite tokens, owner sessions, sign-in codes and asset tokens, as SHA-256 hashes only</li>
<li>IP addresses, only as a keyed hash (HMAC) for rate limits</li>
</ul></section>

<section aria-labelledby="runs"><h2 id="runs">How a page runs</h2>
<p>The page renders in a sandboxed frame that can’t make network requests. It loads only the pinned austere runtime and the packs named in the same publish. The tokens that load page files last 10 minutes and work for one page only.</p></section>

<section aria-labelledby="signin"><h2 id="signin">Signing in</h2>
<p>Accounts use WorkOS AuthKit, with an email code, Google, GitHub or a passkey. The CLI signs in through a device code with <code>austere-axi cloud login</code>. <code>austere-axi publish login</code> prints a single-use link for your own browser. The link works once, for 60 seconds.</p></section>

<section class="wide" aria-labelledby="limits"><h2 id="limits">Limits</h2>
<table class="limits"><thead><tr><th scope="col">What</th><th scope="col">Limit</th></tr></thead><tbody>
${LIMITS.map(([k, v]) => `<tr><th scope="row">${k}</th><td>${v}</td></tr>`).join("\n")}
</tbody></table></section>

<section class="notyet" aria-labelledby="not"><h2 id="not">Not built yet</h2>
<p>An expired page stops being served, but its stored files are not deleted on a schedule yet. To delete a page and its files now, use <code>publish rm</code>. Report and takedown tools are planned.</p></section>

<section aria-labelledby="vuln"><h2 id="vuln">Report a vulnerability</h2>
<p>Use a <a href="${ADVISORY}">private GitHub security advisory</a> on austere-axi. Don’t open a public issue.</p></section>
</div></div>`;

/** The security page; `signIn` is the sign-in URL when accounts are on, else null. */
export function security(signIn: string | null, theme: Theme): Response {
  return new Response(document(META, signIn, theme, BODY), {
    // The page depends on the theme cookie: private, and `vary: cookie` from pageHeaders.
    headers: pageHeaders("private, max-age=3600"),
  });
}
