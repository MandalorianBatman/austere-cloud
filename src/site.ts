// Shared shell for the public pages (`/` and `/security`): head metadata, nav, footer, and the design system CSS.
// Static HTML and CSS only: the CSP allows no script, no fetch and no external asset except same-origin images.
import { otherTheme, type Theme } from "./theme";

export const ORIGIN = "https://austere.blundertech.com";
export const REPO = "https://github.com/MandalorianBatman/austere-axi";
export const CLOUD_REPO = "https://github.com/MandalorianBatman/austere-cloud";
export const DOCS = `${REPO}/blob/main/docs`;
export const INSTALL_GUIDE = `${DOCS}/install.md`;
export const HOSTED_PAGES = `${DOCS}/hosted-pages.md`;
export const SHARE_DESIGN = `${DOCS}/hosted-share-links.md`;
export const ADVISORY = `${REPO}/security/advisories/new`;

export const OG_ALT = "A review page with a red revision cloud around the third rollout step and a held note from a reviewer.";

export const CSP = "default-src 'none'; style-src 'unsafe-inline'; img-src 'self'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'";

export function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

/** A command block. The prompt is not selectable; clicking the command selects it whole. */
export function cmd(text: string, prompt = "$"): string {
  return `<div class="cmd"><span class="ps" aria-hidden="true">${prompt}</span><code>${esc(text)}</code></div>`;
}

/** The austere-axi "A" delta, redline on black. */
export const FAVICON_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><rect width="32" height="32" fill="#000000"/><path d="M16 5 27 26H21.4L16 15.2 10.6 26H5z" fill="none" stroke="#F2553C" stroke-width="3" stroke-linejoin="miter"/><path d="M11.5 22h9" stroke="#F2553C" stroke-width="3"/></svg>`;

export interface Meta {
  title: string;
  description: string;
  /** Path of the canonical URL, e.g. "/security". */
  path: string;
  ogTitle: string;
  ogDescription: string;
  jsonLd?: unknown;
}

/** Head lines every document shares: the rendered theme as color scheme and theme color, icons. */
function headChrome(theme: Theme): string {
  return `<meta name="color-scheme" content="${theme}">
<meta name="theme-color" content="${theme === "dark" ? "#000000" : "#F3F5F7"}">
<link rel="icon" href="/favicon.svg" type="image/svg+xml">
<link rel="apple-touch-icon" href="/apple-touch-icon.png">`;
}

function head(m: Meta, theme: Theme): string {
  const url = ORIGIN + m.path;
  const image = `${ORIGIN}/og.png`;
  return `<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(m.title)}</title>
<meta name="description" content="${esc(m.description)}">
<link rel="canonical" href="${url}">
${headChrome(theme)}
<meta property="og:type" content="website">
<meta property="og:site_name" content="austere">
<meta property="og:title" content="${esc(m.ogTitle)}">
<meta property="og:description" content="${esc(m.ogDescription)}">
<meta property="og:url" content="${url}">
<meta property="og:image" content="${image}">
<meta property="og:image:width" content="1200">
<meta property="og:image:height" content="630">
<meta property="og:image:alt" content="${esc(OG_ALT)}">
<meta name="twitter:card" content="summary_large_image">
<meta name="twitter:title" content="${esc(m.ogTitle)}">
<meta name="twitter:description" content="${esc(m.ogDescription)}">
<meta name="twitter:image" content="${image}">
<meta name="twitter:image:alt" content="${esc(OG_ALT)}">${m.jsonLd ? `\n<script type="application/ld+json">${JSON.stringify(m.jsonLd).replace(/</g, "\\u003c")}</script>` : ""}
<style>${CSS}</style>`;
}

/** One button, no script: `POST /theme` sets the cookie and comes back to `returnTo`. The label names the target theme. */
function themeToggle(theme: Theme, returnTo: string): string {
  const target = otherTheme(theme);
  const cell = (t: Theme) => `<span class="${t === theme ? "on" : "off"}" aria-hidden="true">${t === "dark" ? "Dark" : "Light"}</span>`;
  return `<form class="theme-f" method="post" action="/theme"><input type="hidden" name="return_to" value="${esc(returnTo)}"><button class="theme" name="theme" value="${target}" aria-label="Switch to ${target} theme">${cell("dark")}${cell("light")}</button></form>`;
}

function nav(signIn: string | null, theme: Theme, path: string): string {
  return `<header class="nav"><div class="wrap nav-in">
<a class="logo" href="/" aria-label="austere cloud, home">austere<small>cloud</small></a>
<nav aria-label="Main"><ul>
<li><a href="/#how">How It Works</a></li>
<li><a href="/security">Security</a></li>
<li><a href="${INSTALL_GUIDE}">Docs</a></li>
<li><a href="${REPO}">GitHub</a></li>
</ul></nav>
${themeToggle(theme, path)}
${signIn ? `<a class="btn ghost sm" href="${esc(signIn)}">Sign In</a>` : ""}
</div></header>`;
}

/** The private pages' nav: no How It Works; the theme toggle always, the account's email and Sign Out when signed in. */
function privateNav(account: { email: string } | null, theme: Theme): string {
  return `<header class="nav"><div class="wrap nav-in priv">
<a class="logo" href="/" aria-label="austere cloud, home">austere<small>cloud</small></a>
<nav aria-label="Main"><ul>
<li><a href="${INSTALL_GUIDE}">Docs</a></li>
<li><a href="/security">Security</a></li>
<li><a href="${REPO}">GitHub</a></li>
</ul></nav>
<div class="acct">${themeToggle(theme, "/")}${
    account ? `<span class="acct-email">${esc(account.email)}</span><form method="post" action="/auth/logout"><button class="btn ghost sm">Sign Out</button></form>` : ""
  }</div>
</div></header>`;
}

function footer(): string {
  return `<footer class="foot"><div class="wrap"><div class="tb">
<div class="tb-c tb-brand"><span class="logo">austere</span></div>
<div class="tb-c"><b>Project</b><span>austere cloud, hosted review pages for austere-axi</span></div>
<div class="tb-c"><b>Source</b><span><a href="${REPO}">austere-axi</a> · <a href="${CLOUD_REPO}">austere-cloud</a></span></div>
<div class="tb-c"><b>Docs</b><span><a href="${INSTALL_GUIDE}">Install guide</a> · <a href="${HOSTED_PAGES}">Hosted pages</a> · <a href="/security">Security</a></span></div>
<div class="tb-c"><b>License</b><span>MIT</span></div>
<div class="tb-c"><b>Security issues</b><span><a href="${ADVISORY}">Report privately</a></span></div>
</div></div></footer>`;
}

/** A full document: head, nav, `body` (the `<main>` content) and footer. */
export function document(m: Meta, signIn: string | null, theme: Theme, body: string): string {
  return `<!doctype html>
<html lang="en" data-theme="${theme}"><head>
${head(m, theme)}
</head><body>
<a class="skip" href="#main">Skip to content</a>
${nav(signIn, theme, m.path)}
<main id="main">
${body}
</main>
${footer()}
</body></html>`;
}

/**
 * A signed-in or error page: the same shell, but private. noindex, no canonical, no Open Graph,
 * no JSON-LD. Pair it with `privateHeaders`.
 */
export function privateDocument(title: string, account: { email: string } | null, theme: Theme, body: string): string {
  return `<!doctype html>
<html lang="en" data-theme="${theme}"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)}</title>
<meta name="robots" content="noindex, nofollow">
${headChrome(theme)}
<style>${CSS}</style>
</head><body>
<a class="skip" href="#main">Skip to content</a>
${privateNav(account, theme)}
<main id="main">
${body}
</main>
${footer()}
</body></html>`;
}

/** Response headers shared by the public pages. The HTML depends on the theme cookie, so `cache` must not be shared. */
export function pageHeaders(cache: string): Record<string, string> {
  return {
    "content-type": "text/html; charset=utf-8",
    "cache-control": cache,
    vary: "cookie",
    "referrer-policy": "no-referrer",
    "content-security-policy": CSP,
    "x-content-type-options": "nosniff",
  };
}

const CSS = `
@font-face{font-family:"Display Fallback";font-weight:700;size-adjust:69%;src:local("Arial Bold"),local("Arial-BoldMT"),local("Helvetica Bold"),local("Helvetica-Bold"),local("Liberation Sans Bold"),local("LiberationSans-Bold"),local("Roboto Bold"),local("Segoe UI Bold"),local("DejaVu Sans Bold")}
:root{color-scheme:light;
--p-paper-0:#FFFFFF;--p-paper-50:#F3F5F7;--p-paper-100:#E6EBF0;--p-grid-150:#E3E9EF;
--p-ink-950:#0A1628;--p-ink-900:#13223A;--p-ink-700:#3B4A62;--p-ink-600:#56657B;
--p-redline-600:#BF2E18;--p-redline-700:#9E2412;--p-redline-400:#F2553C;--p-redline-300:#FF6A4D;--p-marker-300:#F3DD4A;
--p-prussian-900:#0D2741;--p-chalk-50:#EDF3F9;--p-chalk-200:#BFD0E2;
--p-carbon-1000:#000000;--p-carbon-950:#0A0A0A;--p-carbon-900:#111113;--p-carbon-800:#222226;--p-carbon-700:#3F3F46;--p-carbon-500:#71717A;--p-carbon-400:#A1A1AA;--p-carbon-200:#D4D4D8;--p-carbon-50:#EDEDED;
--p-app-bg:#0A0A0A;--p-app-panel:#111113;--p-app-line:#26262B;--p-app-text:#EDEDEF;--p-app-muted:#A1A1AA;--p-app-accent:#3B82F6;

--color-ground:var(--p-paper-50);--color-sheet:var(--p-paper-0);--color-panel:var(--p-paper-100);--color-grid:var(--p-grid-150);
--color-line:var(--p-ink-900);--color-line-heavy:var(--p-ink-900);--color-line-control:var(--p-ink-900);
--color-ink:var(--p-ink-900);--color-ink-2:var(--p-ink-700);--color-muted:var(--p-ink-600);
--color-markup:var(--p-redline-600);--color-markup-strong:var(--p-redline-700);--color-held:var(--p-marker-300);--color-on-held:var(--p-ink-900);
--color-action:var(--p-ink-900);--color-action-hover:var(--p-ink-950);--color-on-action:var(--p-paper-50);
--color-inverse:var(--p-prussian-900);--color-on-inverse:var(--p-chalk-50);--color-on-inverse-2:var(--p-chalk-200);

--font-display:"DIN Condensed","Bahnschrift Condensed","Bahnschrift","Display Fallback",system-ui,sans-serif;
--font-body:system-ui,-apple-system,"Segoe UI",Roboto,"Helvetica Neue",Arial,sans-serif;
--font-mono:ui-monospace,"SF Mono","Cascadia Mono",Menlo,Consolas,"Liberation Mono",monospace;
--display-weight:700;--display-stretch:75%;
--text-hero:clamp(3rem,1.6rem + 6vw,7rem);--text-h2:clamp(2rem,1.4rem + 2.6vw,3.5rem);--text-h3:1.375rem;--text-lede:1.1875rem;
--text-body:1.0625rem;--text-small:.875rem;--text-label:.75rem;
--leading-display:.95;--leading-heading:1.1;--leading-body:1.6;--tracking-label:.08em;
--measure:62ch;--measure-lede:34em;

--space-1:4px;--space-2:8px;--space-3:12px;--space-4:16px;--space-5:24px;--space-6:32px;--space-7:48px;--space-8:64px;--space-9:96px;
--section-y:clamp(72px,10vw,128px);--page-max:1200px;--gutter:clamp(16px,4vw,40px);--grid-minor:24px;
--rule-hair:1px;--rule-ink:1.5px;--rule-heavy:3px;--radius-app:8px;--shadow-mock:0 24px 48px -24px rgb(19 34 58 / .35);
--ease-draw:cubic-bezier(.65,0,.35,1);--dur-ui:160ms;--dur-pop:240ms;--dur-draw:700ms;
--btn-h:48px;--btn-pad-x:24px;
--revcloud-r:10px;--revcloud-stroke:2px;--revcloud-color:var(--color-markup);--delta-size:30px;
--focus-ring:2px solid var(--color-markup);--focus-offset:3px}
:root[data-theme="dark"]{color-scheme:dark;
--color-ground:var(--p-carbon-1000);--color-sheet:var(--p-carbon-950);--color-panel:var(--p-carbon-900);--color-grid:var(--p-carbon-900);
--color-line:var(--p-carbon-800);--color-line-heavy:var(--p-carbon-700);--color-line-control:var(--p-carbon-500);
--color-ink:var(--p-carbon-50);--color-ink-2:var(--p-carbon-200);--color-muted:var(--p-carbon-400);
--color-markup:var(--p-redline-400);--color-markup-strong:var(--p-redline-300);
--color-action:var(--p-carbon-50);--color-action-hover:var(--p-paper-0);--color-on-action:var(--p-carbon-1000);
--color-inverse:var(--p-carbon-50);--color-on-inverse:var(--p-carbon-950);--color-on-inverse-2:var(--p-carbon-700);
--shadow-mock:none}

*,*::before,*::after{box-sizing:border-box}
html{-webkit-text-size-adjust:100%;scroll-padding-top:80px}
@media (prefers-reduced-motion:no-preference){html{scroll-behavior:smooth}}
body{margin:0;background:var(--color-ground);color:var(--color-ink);font:var(--text-body)/var(--leading-body) var(--font-body);-webkit-font-smoothing:antialiased}
a{color:inherit;text-decoration-thickness:1px;text-underline-offset:3px}
a:hover{text-decoration-thickness:2px}
:is(a,button,summary):focus-visible{outline:var(--focus-ring);outline-offset:var(--focus-offset)}
code,pre{font-family:var(--font-mono)}
code{font-size:.92em}
h1,h2,h3,p,ul,ol,dl,figure,pre{margin:0}
ul,ol{padding:0;list-style:none}
.wrap{max-width:var(--page-max);margin:0 auto;padding:0 var(--gutter)}
.skip{position:absolute;left:var(--space-3);top:-100px;background:var(--color-action);color:var(--color-on-action);padding:var(--space-2) var(--space-4);z-index:20}
.skip:focus{top:var(--space-3)}

.display,h1,h2{font-family:var(--font-display);font-weight:var(--display-weight);font-stretch:var(--display-stretch);text-transform:none}
h1{font-size:var(--text-hero);line-height:var(--leading-display);letter-spacing:-.01em;max-width:none;text-wrap:balance;padding-top:.06em;overflow-wrap:break-word}
h2{font-size:var(--text-h2);line-height:var(--leading-heading);letter-spacing:-.005em;max-width:20ch;text-wrap:balance}
h3{font-size:var(--text-h3);line-height:1.25;font-weight:650}
.label{font-size:var(--text-label);font-weight:600;letter-spacing:var(--tracking-label);text-transform:uppercase;color:var(--color-muted)}
.lede{font-size:var(--text-lede);color:var(--color-ink-2);max-width:var(--measure-lede)}
.prose{max-width:var(--measure)}
.muted{color:var(--color-muted)}

/* nav */
.nav{position:static;z-index:10;background:var(--color-ground);border-bottom:var(--rule-ink) solid var(--color-line)}
@media (min-width:640px){.nav{position:sticky;top:0}}
.nav-in{display:flex;align-items:center;gap:var(--space-5);min-height:64px;flex-wrap:wrap;padding-top:var(--space-2);padding-bottom:var(--space-2)}
.logo{font-family:var(--font-display);font-weight:var(--display-weight);font-stretch:var(--display-stretch);font-size:1.75rem;line-height:1;text-decoration:none;display:inline-flex;align-items:baseline;gap:var(--space-2)}
.logo small{font:600 var(--text-label)/1 var(--font-body);letter-spacing:var(--tracking-label);text-transform:uppercase;color:var(--color-muted)}
.nav nav{margin-left:auto}
.nav ul{display:flex;gap:var(--space-5);flex-wrap:wrap}
.nav li a{display:inline-block;padding:var(--space-3) 0;font-size:var(--text-small);font-weight:600;text-decoration:none}
.nav li a:hover{text-decoration:underline}
.nav .btn{margin-left:0}

/* buttons, commands */
.btn{display:inline-flex;align-items:center;justify-content:center;min-height:var(--btn-h);padding:0 var(--btn-pad-x);font:600 1rem/1 var(--font-body);text-decoration:none;border:var(--rule-ink) solid var(--color-line-control);transition:background-color var(--dur-ui),color var(--dur-ui)}
.btn.primary{background:var(--color-action);color:var(--color-on-action);border-color:var(--color-action)}
.btn.primary:hover{background:var(--color-action-hover);text-decoration:none}
.btn.ghost{background:transparent;color:var(--color-ink)}
.btn.ghost:hover{background:var(--color-panel);text-decoration:none}
.btn.sm{min-height:40px;padding:0 var(--space-4);font-size:var(--text-small)}
.cmd{display:flex;gap:var(--space-3);align-items:center;background:var(--color-sheet);border:var(--rule-ink) solid var(--color-line);padding:var(--space-3) var(--space-4);font:500 .9375rem/1.5 var(--font-mono);max-width:100%;overflow-x:auto;white-space:nowrap}
.cmd .ps{color:var(--color-muted);user-select:none;-webkit-user-select:none}
.cmd code{font-size:inherit;user-select:all;-webkit-user-select:all}
pre.out{background:var(--color-sheet);border:var(--rule-ink) solid var(--color-line);padding:var(--space-4);font-size:.875rem;line-height:1.6;overflow-x:auto;white-space:pre}
.out .ps{color:var(--color-muted);user-select:none;-webkit-user-select:none}

/* sections */
.sec{padding:var(--section-y) 0}
.sec-head{display:grid;gap:var(--space-4);margin-bottom:var(--space-7);align-content:start}
.split .sec-head{margin-bottom:0}
.sec-head p{max-width:var(--measure)}
.grid-bg{background-color:var(--color-ground);background-image:linear-gradient(var(--color-grid) 1px,transparent 1px),linear-gradient(90deg,var(--color-grid) 1px,transparent 1px);background-size:var(--grid-minor) var(--grid-minor);background-position:-1px -1px}
.rule-top{border-top:var(--rule-ink) solid var(--color-line)}

/* hero */
.hero{padding:var(--space-7) 0 var(--space-8)}
.hero-in{display:grid;gap:var(--space-8);align-items:center}
.hero-copy{display:grid;gap:var(--space-4);justify-items:start;min-width:0}
.hero-copy .cmd{width:100%;max-width:30rem}
.cta-row{display:flex;gap:var(--space-5);align-items:center;flex-wrap:wrap}
.facts{font-size:var(--text-small);color:var(--color-muted)}
@media (min-width:1024px){.hero-in{grid-template-columns:repeat(12,1fr);gap:var(--space-6)}.hero-copy{grid-column:span 6}.hero-sheet{grid-column:span 6}}

/* sample sheet */
.sheet{background:var(--color-sheet);border:var(--rule-ink) solid var(--color-line);box-shadow:var(--shadow-mock);display:grid;min-width:0}
.sheet-app{background:var(--p-app-bg);color:var(--p-app-text);border-radius:var(--radius-app);margin:var(--space-4);overflow:hidden;font-size:.875rem;line-height:1.4;border:1px solid var(--p-app-line)}
.app-bar{display:flex;gap:var(--space-3);align-items:center;flex-wrap:wrap;background:var(--p-app-panel);border-bottom:1px solid var(--p-app-line);padding:var(--space-3) var(--space-4)}
.app-bar b{font-weight:600}
.chips{display:flex;gap:var(--space-2);margin-left:auto}
.chip{font-size:.75rem;border:1px solid var(--p-app-line);border-radius:99px;padding:2px 10px;color:var(--p-app-muted)}
.chip::before{content:"";display:inline-block;width:6px;height:6px;border-radius:50%;background:var(--p-app-accent);margin-right:6px;vertical-align:1px}
.app-body{padding:var(--space-5) var(--space-5) var(--space-6);display:grid;gap:var(--space-4)}
.app-body h3{font:600 1.125rem/1.3 var(--font-body)}
.rows{display:grid;gap:var(--space-3);padding:var(--revcloud-r)}
.row{display:grid;grid-template-columns:1.5rem 1fr auto;gap:var(--space-3);align-items:center;padding:var(--space-3) var(--space-4);border:1px solid var(--p-app-line);background:var(--p-app-panel);border-radius:6px}
.row i{font-style:normal;color:var(--p-app-muted);font-variant-numeric:tabular-nums}
.row span:last-child{color:var(--p-app-muted)}
.rowwrap{position:relative}
.delta{position:absolute;right:-14px;top:-32px;width:var(--delta-size);height:var(--delta-size);color:var(--color-markup);z-index:2}
.delta svg{display:block;width:100%;height:100%;overflow:visible}
.delta text{font:700 20px/1 var(--font-display);font-stretch:75%;fill:var(--p-app-text)}
.leader{width:2px;height:var(--space-6);background:var(--color-markup);margin:calc(var(--revcloud-r) * -1 + 2px) 0 calc(var(--space-4) * -1) var(--space-7);position:relative;z-index:1;transform-origin:top}
.notes{display:grid;gap:var(--space-3)}
.out-art .note{font-size:.875rem;background:var(--p-app-bg)}
.note{color:var(--p-app-text);border:1px solid var(--p-app-line);background:var(--p-app-panel);border-radius:6px;padding:var(--space-3) var(--space-4);display:grid;gap:var(--space-2)}
.note-h{display:flex;gap:var(--space-2);align-items:center;flex-wrap:wrap}
.note-h b{font-weight:600}
.note .reply{border-left:2px solid var(--p-app-accent);padding-left:var(--space-3);color:var(--p-app-muted)}
.tag{font:600 var(--text-label)/1 var(--font-body);letter-spacing:var(--tracking-label);text-transform:uppercase;padding:4px 6px}
.tag.held{background:var(--color-held);color:var(--color-on-held)}
.tag.sent{color:var(--p-app-muted);padding:4px 0}
.acts{display:flex;gap:var(--space-2)}
.acts span{font-size:.75rem;font-weight:600;padding:5px 12px;border-radius:4px;border:1px solid var(--p-app-line)}
.acts span:first-child{background:var(--p-app-accent);border-color:var(--p-app-accent);color:#fff}

/* revision cloud: only on the hero rows and the outcome 3 note */
.revcloud{position:relative}
.revcloud::after{content:"";position:absolute;pointer-events:none;inset:calc(var(--revcloud-r) * -1);padding:var(--revcloud-r);
--arc:radial-gradient(circle closest-side,transparent 8px,var(--revcloud-color) 8px 10px,transparent 10px);
background-image:var(--arc),var(--arc),var(--arc),var(--arc);background-size:20px 20px;
background-position:left top,left bottom,left top,right top;background-repeat:round no-repeat,round no-repeat,no-repeat round,no-repeat round;
-webkit-mask:linear-gradient(#000 0 0) content-box,linear-gradient(#000 0 0);-webkit-mask-composite:xor;
mask:linear-gradient(#000 0 0) content-box exclude,linear-gradient(#000 0 0)}

/* title block (the issue register and the footer) */
.tb{display:grid;border:var(--rule-heavy) solid var(--color-line-heavy);background:var(--color-sheet)}
.tb-c{padding:var(--space-3) var(--space-4);border-top:var(--rule-hair) solid var(--color-line);display:grid;gap:2px;align-content:start;font-size:var(--text-small)}
.tb-c:first-child{border-top:0}
.tb-c b{font-size:var(--text-label);letter-spacing:var(--tracking-label);text-transform:uppercase;color:var(--color-muted);font-weight:600}
.tb-brand{align-content:center}
.register{border-top:var(--rule-heavy) solid var(--color-line-heavy);display:grid;font-size:var(--text-small);background:var(--color-sheet)}
.reg-r{display:grid;align-items:center;grid-template-columns:1fr 1fr;border-top:var(--rule-hair) solid var(--color-line)}
.reg-r:first-child{border-top:0}
.reg-r>*{padding:var(--space-2) var(--space-4);min-width:0}
.reg-r .lk{display:none;font-family:var(--font-mono);font-size:.8125rem;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.reg-h>*{white-space:nowrap}
.reg-h{background:var(--color-panel);font-size:var(--text-label);font-weight:600;letter-spacing:var(--tracking-label);text-transform:uppercase;color:var(--color-muted)}
.revoked{color:var(--color-markup-strong);text-decoration:line-through;text-decoration-thickness:2px}
.live{color:var(--color-ink)}
.reg-foot{padding:var(--space-2) var(--space-4);border-top:var(--rule-heavy) solid var(--color-line-heavy);font-size:var(--text-label);font-weight:600;letter-spacing:var(--tracking-label);text-transform:uppercase;color:var(--color-muted);background:var(--color-panel)}
@media (min-width:640px){
.reg-r{grid-template-columns:6.5rem 1fr 8rem}.reg-r .lk{display:block}
.tb{grid-template-columns:repeat(3,1fr)}
.tb-c{border-top:0;border-left:var(--rule-hair) solid var(--color-line)}.tb-c:nth-child(3n+1){border-left:0}.tb-c:nth-child(n+4){border-top:var(--rule-hair) solid var(--color-line)}
.tb-c:first-child{border-top:0}}

/* compare */
.compare{display:grid;gap:var(--space-5)}
.compare>div{border:var(--rule-ink) solid var(--color-line);padding:var(--space-5);background:var(--color-sheet);display:grid;gap:var(--space-4);align-content:start}
.compare ul{display:grid;gap:var(--space-3)}
.compare li{padding-left:var(--space-5);position:relative}
.compare li::before{content:"";position:absolute;left:0;top:.7em;width:10px;height:2px;background:var(--color-muted)}
.compare .on li::before{background:var(--color-markup);height:2px}
.compare .on{border-width:var(--rule-heavy);border-color:var(--color-line-heavy)}
@media (min-width:768px){.compare{grid-template-columns:1fr 1fr}}

/* outcomes */
.outcome{display:grid;gap:var(--space-5);padding:var(--space-7) 0;border-top:var(--rule-hair) solid var(--color-line)}
.outcome:first-of-type{border-top:var(--rule-ink) solid var(--color-line)}
.out-copy{display:grid;gap:var(--space-3);align-content:start;max-width:var(--measure)}
.out-copy h3{display:flex;gap:var(--space-3);align-items:center}
.out-copy .delta{position:static;flex:none}
.out-copy .delta text{fill:var(--color-ink)}
.out-art{display:grid;gap:var(--space-3);align-content:start;min-width:0}
@media (min-width:900px){.outcome{grid-template-columns:5fr 6fr;gap:var(--space-8)}}
.more{margin-top:var(--space-8);display:grid;gap:var(--space-5)}
.feat{display:grid;gap:var(--space-5)}
.feat li{border-top:var(--rule-ink) solid var(--color-line);padding-top:var(--space-3);display:grid;gap:var(--space-2);align-content:start}
.feat li b{font-weight:650}
.feat li span{color:var(--color-ink-2);font-size:var(--text-small);line-height:1.55}
@media (min-width:768px){.feat{grid-template-columns:repeat(2,1fr)}}
@media (min-width:1100px){.feat{grid-template-columns:repeat(4,1fr)}}
.rc-pad{padding:calc(var(--revcloud-r) * 2) var(--revcloud-r)}

/* start */
.steps{display:grid;gap:var(--space-6);counter-reset:s;max-width:60rem}
.steps li{counter-increment:s;display:grid;grid-template-columns:minmax(0,1fr);gap:var(--space-3);padding-left:var(--space-8);position:relative}
.steps li::before{content:counter(s);position:absolute;left:0;top:-.1em;font:700 2.5rem/1 var(--font-display);font-stretch:75%;width:var(--space-7);color:var(--color-markup-strong)}
.steps li>b{font-size:var(--text-h3);font-weight:650;line-height:1.25}
.steps .cmd{width:fit-content}
.aside{margin-top:var(--space-7);border:var(--rule-ink) solid var(--color-line);padding:var(--space-5);display:grid;gap:var(--space-3);max-width:46rem;background:var(--color-sheet)}
.aside b{font-weight:650}
@media (max-width:639px){.steps li{padding-left:0;padding-top:var(--space-7)}.steps li::before{top:0}}

/* reviewers, inverse band, faq, final */
.split{display:grid;gap:var(--space-6)}
@media (min-width:900px){.split{grid-template-columns:5fr 6fr;gap:var(--space-8)}}
.inverse{background:var(--color-inverse);color:var(--color-on-inverse)}
.inverse .label,.inverse .lede,.inverse .pts li span{color:var(--color-on-inverse-2)}
.inverse a{color:inherit}
.inverse .btn.ghost{border-color:var(--color-on-inverse);color:var(--color-on-inverse)}
.inverse .btn.ghost:hover{background:transparent;text-decoration:underline}
.inverse :is(a,summary):focus-visible{outline-color:var(--color-on-inverse)}
.pts{display:grid;gap:var(--space-4)}
.pts li{padding-left:var(--space-5);position:relative;border-top:var(--rule-hair) solid var(--color-on-inverse-2);padding-top:var(--space-4);padding-left:0}
.faq{max-width:46rem;border-top:var(--rule-ink) solid var(--color-line)}
.faq details{border-bottom:var(--rule-hair) solid var(--color-line)}
.faq summary{cursor:pointer;padding:var(--space-4) var(--space-7) var(--space-4) 0;font-weight:650;list-style:none;position:relative}
.faq summary::-webkit-details-marker{display:none}
.faq summary::after{content:"+";position:absolute;right:var(--space-2);top:var(--space-3);font:400 1.5rem/1.4 var(--font-mono)}
.faq details[open] summary::after{content:"–"}
.faq details p{padding:0 0 var(--space-5);color:var(--color-ink-2);max-width:var(--measure)}
.final{padding:var(--section-y) 0;border-top:var(--rule-ink) solid var(--color-line)}
.final-in{display:grid;gap:var(--space-5);justify-items:start}
.final .cmd{max-width:30rem;width:100%}
.final h2{max-width:14ch}

/* footer */
.foot{border-top:var(--rule-ink) solid var(--color-line);padding:var(--space-7) 0 var(--space-8)}
.tb-brand .logo{font-size:2rem}

/* read pages (/security) */
.read{padding:var(--space-8) 0 var(--section-y)}
.read-in{display:grid;gap:var(--space-8)}
.read h1{max-width:16ch;font-size:clamp(2.75rem,1rem + 5vw,5rem)}
.read section{display:grid;gap:var(--space-4);max-width:var(--measure);border-top:var(--rule-ink) solid var(--color-line);padding-top:var(--space-5)}
.read h2{font-size:clamp(1.75rem,1.3rem + 1.4vw,2.5rem);max-width:none}
.read .plain{display:grid;gap:var(--space-3)}
.read .plain li{padding-left:var(--space-5);position:relative}
.read .plain li::before{content:"";position:absolute;left:0;top:.75em;width:10px;height:2px;background:var(--color-markup)}
.read-head{display:grid;gap:var(--space-5)}
.read .wide{max-width:none}
.limits{width:100%;border-collapse:collapse;border:var(--rule-heavy) solid var(--color-line-heavy);background:var(--color-sheet);font-size:var(--text-small)}
.limits th,.limits td{text-align:left;padding:var(--space-3) var(--space-4);border-top:var(--rule-hair) solid var(--color-line);vertical-align:top}
.limits thead th{background:var(--color-panel);font-size:var(--text-label);letter-spacing:var(--tracking-label);text-transform:uppercase;color:var(--color-muted);border-top:0}
.limits tbody th{font-weight:600;width:35%}
.notyet{border:var(--rule-heavy) solid var(--color-line-heavy)!important;padding:var(--space-5)!important;background:var(--color-sheet)}

/* private pages: nav, account and the theme toggle (the signed-in hub has its own shell) */
.nav-in.priv nav{order:3;flex-basis:100%;margin-left:0}
.acct{order:2;margin-left:auto;display:flex;align-items:center;gap:var(--space-4)}
.acct-email{display:none;font-size:var(--text-small);overflow-wrap:anywhere}
.acct form{margin:0}
.theme-f{margin:0}
.theme{display:inline-grid;grid-template-columns:1fr 1fr;min-height:40px;padding:0;cursor:pointer;border:var(--rule-ink) solid var(--color-line-control);background:transparent;color:var(--color-muted);font:600 var(--text-label)/1 var(--font-body);letter-spacing:var(--tracking-label);text-transform:uppercase}
.theme span{display:flex;align-items:center;justify-content:center;padding:0 var(--space-3)}
.theme .on{background:var(--color-action);color:var(--color-on-action)}
.theme:hover .off{background:var(--color-panel);color:var(--color-ink)}
.theme:focus-visible{outline:var(--focus-ring);outline-offset:var(--focus-offset)}
@media (max-width:639px){.theme{min-height:44px}}
@media (max-width:639px){.nav-in.priv li a{min-height:44px;display:inline-flex;align-items:center;padding:0}.nav-in.priv .btn{min-height:44px}}
@media (min-width:640px){.nav-in.priv nav{order:1;flex-basis:auto;margin-left:auto}.acct{margin-left:0}.acct-email{display:inline}}

/* one load sequence on the hero sheet, then the page stays still */
@media (prefers-reduced-motion:no-preference){
.hero-sheet .revcloud::after{animation:draw var(--dur-draw) var(--ease-draw) .2s backwards}
.hero-sheet .delta{animation:pop var(--dur-pop) var(--ease-draw) .9s backwards}
.hero-sheet .leader{animation:grow 300ms var(--ease-draw) 1.05s backwards}
.hero-sheet .note.new{animation:rise 300ms var(--ease-draw) 1.2s backwards}
.hero-sheet .tag.held{animation:stamp var(--dur-ui) var(--ease-draw) 1.4s backwards}
}
@keyframes draw{from{clip-path:inset(-20px 100% -20px -20px)}to{clip-path:inset(-20px -20px -20px -20px)}}
@keyframes pop{from{transform:scale(.6);opacity:0}}
@keyframes grow{from{transform:scaleY(0)}}
@keyframes rise{from{transform:translateY(8px);opacity:0}}
@keyframes stamp{from{transform:scale(1.15);opacity:0}}
`;
