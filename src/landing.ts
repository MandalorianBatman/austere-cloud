// The signed-out face of `/`: what austere cloud is, and the way in.
// Static HTML and CSS only: the CSP allows no script, no fetch and no external asset.

const REPO = "https://github.com/MandalorianBatman/austere-axi";
const INSTALL_GUIDE = `${REPO}/blob/main/docs/install.md`;

const CSS = `
:root{--bg:#09090b;--ink:#ecebe6;--muted:#8b8a85;--line:#ffffff14;--line2:#ffffff24;--card:#ffffff06;
--a:#b9f5d0;--b:#9db4ff;--c:#f5c97a;--d:#f59ab4;--serif:ui-serif,"Iowan Old Style","Palatino Linotype",Palatino,Georgia,serif;
--sans:ui-sans-serif,system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;--mono:ui-monospace,"SF Mono","Cascadia Code",Menlo,Consolas,monospace}
*{box-sizing:border-box}
html{scroll-behavior:smooth}
body{margin:0;background:var(--bg);color:var(--ink);font:16px/1.6 var(--sans);-webkit-font-smoothing:antialiased;overflow-x:hidden}
a{color:inherit;text-decoration:none}
code,pre{font-family:var(--mono)}
.wrap{max-width:1160px;margin:0 auto;padding:0 24px}
.bgfx{position:fixed;inset:0;z-index:-1;pointer-events:none;
background:radial-gradient(800px 500px at 15% -10%,#b9f5d01c,transparent 60%),radial-gradient(700px 500px at 95% 5%,#9db4ff1f,transparent 60%),radial-gradient(900px 600px at 50% 120%,#f59ab412,transparent 60%)}
.bgfx:after{content:"";position:absolute;inset:0;background-image:linear-gradient(var(--line) 1px,transparent 1px),linear-gradient(90deg,var(--line) 1px,transparent 1px);
background-size:64px 64px;mask-image:radial-gradient(ellipse at 50% 0%,#000 20%,transparent 70%);-webkit-mask-image:radial-gradient(ellipse at 50% 0%,#000 20%,transparent 70%)}

nav{position:sticky;top:0;z-index:10;backdrop-filter:blur(14px) saturate(140%);-webkit-backdrop-filter:blur(14px) saturate(140%);background:#09090bb3;border-bottom:1px solid var(--line)}
nav .wrap{display:flex;align-items:center;gap:28px;height:64px}
.logo{display:flex;align-items:center;gap:10px;font-family:var(--serif);font-size:22px;letter-spacing:-.01em}
.logo i{font-style:normal;font:500 11px/1 var(--mono);letter-spacing:.12em;text-transform:uppercase;color:var(--a);border:1px solid #b9f5d055;border-radius:99px;padding:4px 8px}
nav .links{display:flex;gap:24px;margin-left:auto;font-size:14px;color:var(--muted)}
nav .links a:hover{color:var(--ink)}
.btn{display:inline-flex;align-items:center;gap:8px;border-radius:999px;padding:11px 20px;font-size:14px;font-weight:600;transition:transform .2s,box-shadow .2s,background .2s}
.btn.primary{background:var(--ink);color:#0b0b0d;box-shadow:0 0 0 1px #fff3,0 8px 30px -8px #b9f5d088}
.btn.primary:hover{transform:translateY(-1px);box-shadow:0 0 0 1px #fff6,0 14px 40px -8px #b9f5d0aa}
.btn.ghost{border:1px solid var(--line2);color:var(--ink)}
.btn.ghost:hover{background:#ffffff0d}
.btn.sm{padding:8px 16px}
.arrow{transition:transform .2s}.btn:hover .arrow{transform:translateX(3px)}

.hero{padding:96px 0 72px;display:grid;grid-template-columns:1.05fr 1fr;gap:56px;align-items:center}
.eyebrow{display:inline-flex;align-items:center;gap:10px;font:500 12px/1 var(--mono);letter-spacing:.08em;text-transform:uppercase;color:var(--muted);border:1px solid var(--line2);border-radius:99px;padding:7px 12px 7px 8px;background:#ffffff08}
.dot{width:8px;height:8px;border-radius:50%;background:var(--a);box-shadow:0 0 0 0 #b9f5d0aa;animation:pulse 2.4s infinite}
@keyframes pulse{0%{box-shadow:0 0 0 0 #b9f5d099}70%{box-shadow:0 0 0 10px #b9f5d000}100%{box-shadow:0 0 0 0 #b9f5d000}}
h1{font-family:var(--serif);font-weight:400;font-size:clamp(44px,6.2vw,80px);line-height:1.02;letter-spacing:-.025em;margin:24px 0 22px}
h1 em,h2 em{font-style:italic;background:linear-gradient(100deg,var(--a),var(--b) 55%,var(--d));-webkit-background-clip:text;background-clip:text;color:transparent}
.lede{font-size:19px;color:#bdbcb6;max-width:34em;margin:0 0 34px}
.lede code{color:var(--ink);font-size:.88em;background:#ffffff0f;border:1px solid var(--line);border-radius:6px;padding:1px 6px}
.ctas{display:flex;gap:12px;flex-wrap:wrap}
.trust{margin-top:36px;display:flex;gap:18px;flex-wrap:wrap;font:12px var(--mono);color:var(--muted)}
.trust span:before{content:"✓ ";color:var(--a)}
.quick{margin-top:28px;display:inline-flex;align-items:center;gap:10px;max-width:100%;flex-wrap:wrap;font:13px var(--mono);border:1px solid var(--line2);border-radius:12px;padding:10px 14px;background:#00000050}
.quick a{color:var(--muted);font-family:var(--sans)}
.quick a:hover{color:var(--ink)}

.stage{position:relative;height:520px}
.win{position:absolute;border:1px solid var(--line2);border-radius:14px;background:linear-gradient(180deg,#17171bf2,#0f0f12f2);box-shadow:0 40px 80px -30px #000,0 0 0 1px #00000080,inset 0 1px 0 #ffffff12;overflow:hidden}
.bar{display:flex;align-items:center;gap:7px;padding:11px 14px;border-bottom:1px solid var(--line);font:12px var(--mono);color:var(--muted)}
.bar b{width:11px;height:11px;border-radius:50%;background:#ffffff1c}
.bar .t{margin-left:10px}
.term{left:0;top:0;width:86%;z-index:2;animation:float 9s ease-in-out infinite}
.term pre{margin:0;padding:18px 20px 20px;font-size:13px;line-height:1.75;color:#cfcec8;white-space:pre;overflow:hidden}
.p{color:var(--a)}.k{color:var(--b)}.s{color:var(--c)}.m{color:var(--muted)}.u{color:var(--ink);text-decoration:underline;text-decoration-color:#ffffff40;text-underline-offset:3px}
.caret{display:inline-block;width:8px;height:15px;background:var(--a);vertical-align:-2px;animation:blink 1.1s steps(1) infinite}
@keyframes blink{50%{opacity:0}}
.review{right:0;bottom:0;width:80%;z-index:3;animation:float 9s ease-in-out -4.5s infinite}
@keyframes float{0%,100%{transform:translateY(0)}50%{transform:translateY(-10px)}}
.review .bar .t{flex:1}
.faces{display:flex}
.face{width:24px;height:24px;border-radius:50%;display:grid;place-items:center;font:700 11px var(--sans);color:#0b0b0d;margin-left:-6px;border:2px solid #141417}
.doc{padding:18px 20px 20px;display:grid;grid-template-columns:1fr 168px;gap:16px}
.doc h4{margin:0 0 10px;font:500 17px var(--serif)}
.ln{height:8px;border-radius:4px;background:#ffffff14;margin:9px 0}
.ln.hl{background:linear-gradient(90deg,#f5c97a55,#f5c97a22);box-shadow:0 0 0 1px #f5c97a55}
.cursor{position:absolute;font:600 10px var(--sans);color:#0b0b0d;padding:2px 6px;border-radius:4px 4px 4px 0;animation:roam 7s ease-in-out infinite;z-index:4}
@keyframes roam{0%,100%{transform:translate(0,0)}35%{transform:translate(-60px,22px)}70%{transform:translate(30px,-14px)}}
.note{border:1px solid var(--line2);border-radius:10px;padding:9px 10px;font-size:11.5px;line-height:1.45;background:#ffffff08;margin-bottom:10px}
.note .who{display:flex;align-items:center;gap:6px;font-weight:600;margin-bottom:3px}
.note .who i{width:8px;height:8px;border-radius:50%}
.tag{margin-left:auto;font:500 9.5px var(--mono);text-transform:uppercase;letter-spacing:.06em;padding:2px 6px;border-radius:99px}
.tag.held{color:var(--c);border:1px solid #f5c97a55}
.tag.live{color:var(--a);border:1px solid #b9f5d055}
.note.new{animation:arrive 7s ease-in-out infinite}
@keyframes arrive{0%,12%{opacity:0;transform:translateY(8px)}20%,90%{opacity:1;transform:none}100%{opacity:0}}

.strip{border-block:1px solid var(--line);padding:22px 0;color:var(--muted);font:13px var(--mono)}
.strip .wrap{display:flex;gap:38px;flex-wrap:wrap;justify-content:center;align-items:center}
.strip b{color:var(--ink);font-weight:500}

section{padding:112px 0 0}
.kicker{font:500 12px var(--mono);letter-spacing:.14em;text-transform:uppercase;color:var(--a)}
h2{font-family:var(--serif);font-weight:400;font-size:clamp(34px,4.4vw,54px);line-height:1.08;letter-spacing:-.02em;margin:14px 0 16px;max-width:16em}
.sub{color:#a9a8a2;font-size:18px;max-width:38em;margin:0}

.bento{margin-top:56px;display:grid;grid-template-columns:repeat(6,1fr);gap:16px}
.card{position:relative;grid-column:span 2;border:1px solid var(--line);border-radius:18px;padding:28px;background:linear-gradient(180deg,#ffffff0a,#ffffff03);overflow:hidden;transition:border-color .3s,transform .3s}
.card:hover{border-color:var(--line2);transform:translateY(-2px)}
.card:before{content:"";position:absolute;inset:-1px;border-radius:inherit;padding:1px;background:linear-gradient(140deg,var(--glow,#b9f5d0) ,transparent 40%);
-webkit-mask:linear-gradient(#000 0 0) content-box,linear-gradient(#000 0 0);-webkit-mask-composite:xor;mask-composite:exclude;opacity:0;transition:opacity .3s;pointer-events:none}
.card:hover:before{opacity:.8}
.card.wide{grid-column:span 3}
.card h3{font:500 21px/1.25 var(--serif);margin:18px 0 8px;letter-spacing:-.01em}
.card p{margin:0;color:#a3a29c;font-size:15px}
.card p code{font-size:13px;color:var(--ink)}
.ico{width:42px;height:42px;border-radius:11px;display:grid;place-items:center;border:1px solid var(--line2);background:#ffffff08}
.ico svg{width:20px;height:20px;stroke:var(--glow,var(--a));fill:none;stroke-width:1.6;stroke-linecap:round;stroke-linejoin:round}
.demo{margin-top:22px;font:12.5px/1.9 var(--mono);color:#c9c8c2;border:1px solid var(--line);border-radius:12px;padding:12px 14px;background:#00000040}
.demo .row{display:flex;align-items:center;gap:10px}
.demo .row .r{margin-left:auto}
.strike{text-decoration:line-through;color:var(--muted)}
.pill{font-size:10.5px;padding:1px 8px;border-radius:99px;border:1px solid currentColor}

.steps{margin-top:56px;display:grid;grid-template-columns:repeat(3,1fr);gap:16px;counter-reset:s}
.step{border-top:1px solid var(--line2);padding-top:22px;counter-increment:s}
.step:before{content:"0" counter(s);font:500 12px var(--mono);color:var(--muted)}
.step h3{font:500 24px var(--serif);margin:10px 0 8px}
.step p{color:#a3a29c;margin:0 0 18px}
.step pre{margin:0;padding:14px 16px;border:1px solid var(--line);border-radius:12px;background:#00000050;font-size:12.5px;color:#d6d5cf;white-space:pre-wrap;overflow-wrap:anywhere}
.steps.four{grid-template-columns:repeat(4,1fr)}
.step pre code,.quick code{-webkit-user-select:all;user-select:all;color:var(--ink)}
.step pre .p,.quick .p{-webkit-user-select:none;user-select:none}
.alt{margin-top:28px;border:1px solid var(--line);border-radius:18px;padding:22px 24px;background:#ffffff05;display:grid;grid-template-columns:1fr 1.4fr;gap:24px;align-items:center}
.alt p{margin:0;color:#a3a29c}
.alt p b{color:var(--ink);font-weight:600}
.alt a{color:var(--ink);text-decoration:underline;text-decoration-color:#ffffff40;text-underline-offset:3px}
.alt pre{margin:0;padding:14px 16px;border:1px solid var(--line);border-radius:12px;background:#00000050;font-size:12.5px;color:#d6d5cf;white-space:pre-wrap;overflow-wrap:anywhere}
.alt pre code{-webkit-user-select:all;user-select:all;color:var(--ink)}
.alt pre .p{-webkit-user-select:none;user-select:none}

.sec{display:grid;grid-template-columns:1fr 1.15fr;gap:56px;align-items:start}
.list{display:grid;gap:2px;border:1px solid var(--line);border-radius:18px;overflow:hidden}
.li{display:grid;grid-template-columns:28px 1fr;gap:14px;padding:18px 22px;background:#ffffff05}
.li:nth-child(odd){background:#ffffff09}
.li svg{width:18px;height:18px;margin-top:3px;stroke:var(--a);fill:none;stroke-width:2;stroke-linecap:round;stroke-linejoin:round}
.li b{display:block;font-weight:600;font-size:15px}
.li span{color:#9c9b95;font-size:14px}
.li code{font-size:12.5px;color:var(--ink)}

.arch{margin-top:56px;border:1px solid var(--line);border-radius:22px;padding:36px;background:radial-gradient(600px 300px at 50% 0%,#9db4ff12,transparent),#ffffff04}
.arch svg{width:100%;height:auto;display:block}
.arch text{font-family:var(--mono);font-size:13px;fill:#d6d5cf}
.arch .lbl{font-size:11px;fill:var(--muted)}
.arch .box{fill:#ffffff07;stroke:#ffffff2e}
.arch .hot{fill:#b9f5d00f;stroke:#b9f5d088}
.arch .wire{stroke:#ffffff30;stroke-width:1.4;fill:none}
.arch .flow{stroke:var(--a);stroke-width:1.6;fill:none;stroke-dasharray:4 10;animation:dash 1.6s linear infinite}
@keyframes dash{to{stroke-dashoffset:-28}}

.final{margin:120px 0 0;padding:84px 24px;text-align:center;border:1px solid var(--line);border-radius:28px;position:relative;overflow:hidden;
background:radial-gradient(500px 260px at 50% 0%,#b9f5d022,transparent 70%),radial-gradient(500px 260px at 50% 100%,#9db4ff1c,transparent 70%),#ffffff04}
.final h2{margin:0 auto 14px}
.final .sub{margin:0 auto 32px}
.final .ctas{justify-content:center}
footer{padding:56px 0 48px;color:var(--muted);font-size:13px}
footer .wrap{display:flex;gap:24px;flex-wrap:wrap;align-items:center}
footer .r{margin-left:auto;display:flex;gap:20px}
footer a:hover{color:var(--ink)}

@media (max-width:960px){.hero,.sec,.alt{grid-template-columns:1fr}.stage{height:500px}.bento{grid-template-columns:1fr 1fr}.card,.card.wide{grid-column:span 1}.steps,.steps.four{grid-template-columns:1fr}nav .links{display:none}nav .btn{margin-left:auto}}
@media (max-width:620px){.bento{grid-template-columns:1fr}.stage{height:auto;display:grid;gap:16px}.win{position:relative;width:100%}.term pre{font-size:12px}.doc{grid-template-columns:1fr}.hero{padding-top:56px}}
@media (prefers-reduced-motion:reduce){*,*:before,*:after{animation:none!important;transition:none!important}html{scroll-behavior:auto}}
`;

const icon = (d: string) => `<svg viewBox="0 0 24 24" aria-hidden="true">${d}</svg>`;
const ICONS = {
  send: icon(`<path d="M4 12l16-8-6 16-3-7-7-1z"/>`),
  key: icon(`<circle cx="8" cy="15" r="4"/><path d="M11 12l9-9M16 7l3 3"/>`),
  inbox: icon(`<path d="M3 13l3-8h12l3 8v6H3z"/><path d="M3 13h5l1 3h6l1-3h5"/>`),
  eye: icon(`<path d="M2 12s4-7 10-7 10 7 10 7-4 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/>`),
  users: icon(`<circle cx="9" cy="8" r="3.5"/><path d="M2.5 20c.8-3.5 3.4-5.5 6.5-5.5s5.7 2 6.5 5.5"/><path d="M16 4.5a3.5 3.5 0 010 7M18 14.8c2 .7 3.2 2.5 3.6 5.2"/>`),
  shield: icon(`<path d="M12 3l8 3v6c0 4.5-3.4 8.2-8 9-4.6-.8-8-4.5-8-9V6z"/><path d="M9 12l2 2 4-4"/>`),
  sync: icon(`<path d="M20 11a8 8 0 00-14.6-4.5L3 9"/><path d="M3 4v5h5"/><path d="M4 13a8 8 0 0014.6 4.5L21 15"/><path d="M21 20v-5h-5"/>`),
  check: `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 12l4 4 10-10"/></svg>`,
};

const ARCH = `<svg viewBox="0 0 1040 300" role="img" aria-label="CLI and reviewers connect through a Cloudflare Worker to one Durable Object per page, backed by D1 and R2">
<rect class="box" x="10" y="40" width="190" height="70" rx="12"/><text x="30" y="72">austere-axi CLI</text><text class="lbl" x="30" y="94">publish · grant · revoke</text>
<rect class="box" x="10" y="190" width="190" height="70" rx="12"/><text x="30" y="222">Reviewers</text><text class="lbl" x="30" y="244">invite link or account</text>
<path class="wire" d="M200 75 C 260 75 260 150 320 150"/><path class="flow" d="M200 75 C 260 75 260 150 320 150"/>
<path class="wire" d="M200 225 C 260 225 260 150 320 150"/><path class="flow" d="M200 225 C 260 225 260 150 320 150"/>
<rect class="box" x="320" y="110" width="200" height="80" rx="12"/><text x="342" y="145">Worker</text><text class="lbl" x="342" y="168">auth · handshake · serve</text>
<path class="wire" d="M520 150 L 600 150"/><path class="flow" d="M520 150 L 600 150"/>
<rect class="hot" x="600" y="95" width="230" height="110" rx="14"/><text x="622" y="132">PageObject</text><text class="lbl" x="622" y="155">one Durable Object per page</text><text class="lbl" x="622" y="176">op log · notes · presence</text>
<path class="wire" d="M830 130 C 880 130 880 75 920 75"/><path class="wire" d="M830 170 C 880 170 880 225 920 225"/>
<rect class="box" x="920" y="40" width="110" height="70" rx="12"/><text x="944" y="72">D1</text><text class="lbl" x="944" y="94">the index</text>
<rect class="box" x="920" y="190" width="110" height="70" rx="12"/><text x="944" y="222">R2</text><text class="lbl" x="944" y="244">sha256 objects</text>
</svg>`;

function html(signIn: string | null): string {
  const enter = signIn
    ? `<a class="btn primary" href="${signIn}">Sign in <span class="arrow">→</span></a>`
    : `<a class="btn primary" href="#install">Get started <span class="arrow">→</span></a>`;
  const navEnter = signIn ? `<a class="btn primary sm" href="${signIn}">Sign in</a>` : `<a class="btn ghost sm" href="${REPO}">GitHub</a>`;
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>austere cloud · share a page, keep the conversation</title>
<meta name="description" content="Hosted share links for austere-axi: publish a review page in one command, invite reviewers by name, revoke them live, and collect notes in real time.">
<meta name="color-scheme" content="dark"><meta name="theme-color" content="#09090b">
<style>${CSS}</style></head><body>
<div class="bgfx"></div>
<nav><div class="wrap">
  <a class="logo" href="/">austere <i>cloud</i></a>
  <div class="links"><a href="#install">Install</a><a href="#features">Features</a><a href="#how">How it works</a><a href="#security">Security</a><a href="${REPO}">GitHub</a></div>
  ${navEnter}
</div></nav>

<main class="wrap">
<header class="hero">
  <div>
    <span class="eyebrow"><span class="dot"></span>Hosted share links for austere-axi</span>
    <h1>Share the page.<br><em>Keep the room.</em></h1>
    <p class="lede">One command turns a local review page into a private link per reviewer. Notes, replies and who's looking arrive live; every invite has a name and can be revoked mid-sentence.</p>
    <div class="ctas">${enter}<a class="btn ghost" href="${INSTALL_GUIDE}">Read the docs</a></div>
    <div class="quick"><span class="p">$</span><code>npm install -g austere-axi</code><a href="#install">Node.js 22.18+ · full setup ↓</a></div>
    <div class="trust"><span>Invite-only by default</span><span>Revocable in real time</span><span>Open source, MIT</span></div>
  </div>
  <div class="stage" aria-hidden="true">
    <div class="win term">
      <div class="bar"><b></b><b></b><b></b><span class="t">~/plans</span></div>
<pre><span class="p">$</span> austere-axi publish plan.html \\
    <span class="k">--invite</span> <span class="s">Ana</span> <span class="k">--invite</span> <span class="s">Ben</span>
<span class="m">  uploading 2 objects … done</span>
<span class="m">  published</span> Q3 migration plan
  <span class="s">Ana</span>  <span class="u">/p/k3v9qz#i=…</span>
  <span class="s">Ben</span>  <span class="u">/p/k3v9qz#i=…</span>
<span class="p">$</span> <span class="caret"></span></pre>
    </div>
    <div class="win review">
      <div class="bar"><b></b><b></b><b></b><span class="t">Q3 migration plan</span>
        <span class="faces"><span class="face" style="background:var(--a)">A</span><span class="face" style="background:var(--b)">B</span><span class="face" style="background:var(--c)">O</span></span></div>
      <div class="doc">
        <div style="position:relative">
          <h4>Cut over to the new region</h4>
          <div class="ln" style="width:92%"></div><div class="ln" style="width:78%"></div><div class="ln hl" style="width:86%"></div>
          <div class="ln" style="width:64%"></div><div class="ln" style="width:88%"></div><div class="ln" style="width:52%"></div>
          <div class="ln" style="width:80%"></div><div class="ln" style="width:70%"></div>
          <span class="cursor" style="background:var(--b);left:60%;top:96px">Ben</span>
        </div>
        <div>
          <div class="note"><div class="who"><i style="background:var(--a)"></i>Ana<span class="tag live">live</span></div>Can we keep the old read path for a week?</div>
          <div class="note"><div class="who"><i style="background:var(--c)"></i>Owner</div>Yes, until the 14th.</div>
          <div class="note new"><div class="who"><i style="background:var(--b)"></i>Ben<span class="tag held">held</span></div>Rollback step is missing.</div>
        </div>
      </div>
    </div>
  </div>
</header>
</main>

<div class="strip"><div class="wrap"><span>Runs on</span><b>Cloudflare Workers</b><b>Durable Objects</b><b>R2</b><b>D1</b><b>WorkOS AuthKit</b></div></div>

<main class="wrap">
<section id="install">
  <div class="kicker">Install</div>
  <h2>Set up once, <em>from your terminal</em>.</h2>
  <p class="sub">You need an AI coding agent, such as Claude Code, Codex or Cursor, and <a class="u" href="https://nodejs.org">Node.js</a> 22.18 or later.</p>
  <div class="steps">
    <div class="step"><h3>Install the CLI</h3><p>Run it once in a terminal.</p><pre><span class="p">$ </span><code>npm install -g austere-axi</code></pre></div>
    <div class="step"><h3>Add the skills</h3><p>Give your agent the austere skills.</p><pre><span class="p">$ </span><code>npx skills add MandalorianBatman/austere-axi --skill austere --skill austere-setup</code></pre></div>
    <div class="step"><h3>Ask your agent</h3><p>It checks the install and opens a test page so you can see it work.</p><pre><span class="p">› </span><code>set up austere-axi</code></pre></div>
  </div>
  <div class="alt">
    <p><b>Using Claude Code?</b> Install it as a plugin instead. Claude Desktop, Cursor, Codex and manual setup are in the <a href="${INSTALL_GUIDE}">install guide</a>.</p>
    <pre><span class="p">$ </span><code>claude plugin marketplace add MandalorianBatman/austere-axi</code>
<span class="p">$ </span><code>claude plugin install austere@austere-axi</code></pre>
  </div>
</section>

<section id="features">
  <div class="kicker">Features</div>
  <h2>Everything a review needs. <em>Nothing it doesn't.</em></h2>
  <p class="sub">Built for plans, designs and reports you want eyes on, not for the whole internet.</p>
  <div class="bento">
    <div class="card wide" style="--glow:var(--a)">
      <div class="ico">${ICONS.send}</div>
      <h3>Publish in one command</h3>
      <p><code>austere-axi publish</code> uploads the page and its packs, content-addressed by SHA-256, and prints one link per invited reviewer. Publish again and everyone sees the new version.</p>
      <div class="demo"><div class="row"><span class="p">$</span> austere-axi publish plan.html --invite Ana<span class="r m">1 link</span></div><div class="row"><span class="p">$</span> austere-axi publish plan.html --unlisted<span class="r m">open link, opt-in</span></div></div>
    </div>
    <div class="card wide" style="--glow:var(--d)">
      <div class="ico">${ICONS.key}</div>
      <h3>Named invites, revoked live</h3>
      <p>Every link belongs to someone. Revoke it and their open tab is closed on the spot; re-grant and the old token stops working. Invites can expire on their own.</p>
      <div class="demo"><div class="row"><span style="color:var(--a)">●</span> Ana<span class="r pill" style="color:var(--a)">viewing</span></div><div class="row"><span style="color:var(--d)">●</span> <span class="strike">Ben</span><span class="r pill" style="color:var(--d)">revoked · closed</span></div></div>
    </div>
    <div class="card" style="--glow:var(--c)">
      <div class="ico">${ICONS.inbox}</div>
      <h3>Notes wait for you</h3>
      <p>Reviewer notes arrive held. Release or discard each one, or publish with <code>auto</code> to let them through, and answer in thread.</p>
    </div>
    <div class="card" style="--glow:var(--b)">
      <div class="ico">${ICONS.eye}</div>
      <h3>See who's in the room</h3>
      <p>Live presence: who's viewing, where they're looking, and a steady colour per name. Viewers who go quiet for a minute fade out. Turn it off with <code>--no-presence</code>.</p>
    </div>
    <div class="card" style="--glow:var(--a)">
      <div class="ico">${ICONS.users}</div>
      <h3>One account, every page</h3>
      <p>Sign in once with <code>austere-axi cloud login</code> and you own every page you publish. Grant pages by email from the dashboard; collaborators sign in with an email code, Google, GitHub or a passkey.</p>
    </div>
    <div class="card wide" style="--glow:var(--b)">
      <div class="ico">${ICONS.shield}</div>
      <h3>Private down to the title</h3>
      <p>The public link is an empty shell: no content, not even the page title, until access is proven. The page itself renders in a sandboxed frame that cannot make a single network request.</p>
    </div>
    <div class="card wide" style="--glow:var(--c)">
      <div class="ico">${ICONS.sync}</div>
      <h3>Never lose a note</h3>
      <p>Every change goes through one ordered op log per page, acknowledged exactly once. Drop your connection, come back, and you pick up from where you left off.</p>
      <div class="demo"><div class="row">mutation n=41 <span class="m">→</span> ack<span class="r m">seq 1187</span></div><div class="row">mutation n=41 <span class="m">→</span> ack<span class="r m">same answer, no duplicate</span></div></div>
    </div>
  </div>
</section>

<section id="how">
  <div class="kicker">How it works</div>
  <h2>From a local file to a <em>live review</em> in four steps.</h2>
  <div class="steps four">
    <div class="step"><h3>Connect</h3><p>Cloud features are off by default. Turn them on, then sign in once: publishing needs an account.</p><pre><span class="p">$ </span><code>austere-axi cloud on</code>
<span class="p">$ </span><code>austere-axi cloud login</code></pre></div>
    <div class="step"><h3>Publish</h3><p>Point the CLI at the page you already review locally.</p><pre><span class="p">$</span> austere-axi publish plan.html \\
    --invite Ana --invite Ben</pre></div>
    <div class="step"><h3>Share</h3><p>Send each reviewer their own link, or grant their email from the dashboard.</p><pre>Ana  /p/k3v9qz#i=…
Ben  /p/k3v9qz#i=…</pre></div>
    <div class="step"><h3>Review</h3><p>Notes and replies stream back as they're written. Open the page yourself to answer in place.</p><pre><span class="p">$</span> austere-axi publish login plan.html</pre></div>
  </div>
</section>

<section id="security">
  <div class="sec">
    <div>
      <div class="kicker">Security</div>
      <h2>Austere by <em>design</em>.</h2>
      <p class="sub">We keep as little as we can, and what we keep, we hash. The rules are written down and tested.</p>
    </div>
    <div class="list">
      <div class="li">${ICONS.check}<div><b>Tokens are never stored</b><span>Invite links, sessions and sign-in codes are kept only as SHA-256 hashes.</span></div></div>
      <div class="li">${ICONS.check}<div><b>A sandbox with no network</b><span>The artifact runs with <code>sandbox allow-scripts</code> and <code>connect-src 'none'</code>.</span></div></div>
      <div class="li">${ICONS.check}<div><b>Short-lived asset tokens</b><span>Ten minutes, one page, and dead the moment the access behind them is.</span></div></div>
      <div class="li">${ICONS.check}<div><b>Only the scripts you published</b><span>Every <code>&lt;script src&gt;</code> must be the pinned runtime or a pack named in the same publish.</span></div></div>
      <div class="li">${ICONS.check}<div><b>Single-use owner sign-in</b><span>A code good for 60 seconds, traded for a cookie scoped to that one page.</span></div></div>
      <div class="li">${ICONS.check}<div><b>Rate-limited by design</b><span>Notes are capped per invite, per account and per address; publishes per owner and per address.</span></div></div>
    </div>
  </div>
  <div class="arch">${ARCH}</div>
</section>

<div class="final">
  <h2>Put your plan <em>in front of people</em>.</h2>
  <p class="sub">Publish from the CLI, share a link per reviewer, and keep every note in one place.</p>
  <div class="ctas">${enter}<a class="btn ghost" href="${REPO}">austere-axi on GitHub</a></div>
</div>
</main>

<footer><div class="wrap"><span class="logo" style="font-size:18px">austere</span><span>Hosted share links for austere-axi · MIT</span>
<div class="r"><a href="#features">Features</a><a href="#security">Security</a><a href="${REPO}">GitHub</a></div></div></footer>
</body></html>`;
}

/** The landing page; `signIn` is the sign-in URL when accounts are on, else null. */
export function landing(signIn: string | null): Response {
  return new Response(html(signIn), {
    headers: {
      "content-type": "text/html; charset=utf-8",
      // `/` is the dashboard once signed in, so it is never cached.
      "cache-control": "no-store",
      "referrer-policy": "no-referrer",
      "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'; form-action 'none'; frame-ancestors 'none'; base-uri 'none'",
      "x-content-type-options": "nosniff",
    },
  });
}
