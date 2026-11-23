// The signed-in `/`: the drawing register. Each page is one ruled entry; each grant is one line in
// that entry's access register. Pure rendering: web.ts loads the data. Static HTML, no script.
import type { Grant, User } from "./accounts";
import type { OwnedPage } from "./api";
import { INSTALL_GUIDE, cmd, esc } from "./site";

export interface SharedPage {
  id: string;
  title: string;
  expires_at: number;
  /** The owner's name, else email; null when the owner has no account row. */
  owner: string | null;
}

/** What the redirect after a grant or revoke says: `page` is the entry it belongs to. */
export type Notice = { page?: string; code: NoticeCode } | null;

const NOTICES = {
  granted: { role: "status", text: "Access granted. They open the page after they sign in with that email." },
  exists: { role: "status", text: "That email already has access." },
  revoked: { role: "status", text: "Access revoked. Any tab they have open on this page loses access now." },
  email: { role: "alert", text: "Enter an email address, like name@example.com." },
  limit: { role: "alert", text: "This page has 100 grants, the most it can have. Revoke one first." },
  gone: { role: "alert", text: "That page expired or was taken down." },
} as const;

export type NoticeCode = keyof typeof NOTICES;

/** The notice a dashboard URL asks for; null for an unknown code. `gone` is the only one without a page. */
export function noticeFrom(params: URLSearchParams): Notice {
  const code = params.get("done") ?? params.get("error");
  const page = params.get("page") ?? undefined;
  const isDone = params.has("done");
  const ok = isDone ? code === "granted" || code === "exists" || code === "revoked" : code === "email" || code === "limit" || code === "gone";
  if (!ok) return null;
  return { page: code === "gone" ? undefined : page, code: code as NoticeCode };
}

const DAY = 86_400_000;
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** "23 Dec 2026", in UTC. */
function date(ms: number): string {
  const d = new Date(ms);
  return `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
}

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/** The expiry as text: the state is never color alone. At 3 days or less it reads "Expires in N days" or "Expires today". */
function expiry(ms: number, now: number): string {
  const left = ms - now;
  const iso = new Date(ms).toISOString();
  if (left < DAY) return `<time class="soon" datetime="${iso}">Expires today</time>`;
  const days = Math.ceil(left / DAY);
  if (days <= 3) return `<time class="soon" datetime="${iso}">Expires in ${days} days</time>`;
  return `<time datetime="${iso}">Expires ${date(ms)} · in ${days} days</time>`;
}

function noticeHtml(code: NoticeCode, id: string, cls = ""): string {
  const n = NOTICES[code];
  return `<p class="notice${n.role === "alert" ? " err" : ""}${cls}" id="${id}" role="${n.role}">${esc(n.text)}</p>`;
}

function entry(p: OwnedPage, grants: Grant[], user: User, origin: string, now: number, notice: Notice): string {
  const title = p.title.trim();
  const shown = title ? esc(title) : `<span class="untitled">Untitled page</span>`;
  const mine = notice && notice.page === p.id ? notice.code : null;
  const bad = mine === "email" || mine === "limit";
  const noteId = `n-${p.id}`;
  const rows = grants
    .map(
      (g) => `<tr><th scope="row">${esc(g.email)}</th><td>Added ${date(g.createdAt)}</td><td class="act"><form method="post" action="/dash/pages/${p.id}/grants/remove"><input type="hidden" name="email" value="${esc(g.email)}"><button class="btn ghost sm" aria-label="Revoke access for ${esc(g.email)}">Revoke</button></form></td></tr>`,
    )
    .join("\n");
  return `<article class="entry" id="page-${p.id}" aria-labelledby="t-${p.id}">
<div class="entry-head">
<h3 id="t-${p.id}"><a href="/p/${p.id}">${shown}</a></h3>
<p class="entry-meta"><span>${expiry(p.expires_at, now)}</span><span>${p.notes === 0 ? "No notes yet" : plural(p.notes, "note", "notes")}</span></p>
<div class="url" tabindex="0" role="group" aria-label="Page address">${esc(`${origin.replace(/^https?:\/\//, "")}/p/${p.id}`)}</div>
</div>
${mine ? noticeHtml(mine, noteId) : ""}
<table class="acl"><caption class="vh">Who can open ${esc(title || "Untitled page")}</caption>
<thead><tr><th scope="col">Account</th><th scope="col">Access</th><th scope="col"><span class="vh">Action</span></th></tr></thead>
<tbody>
<tr><th scope="row">${esc(user.email)}</th><td>Owner</td><td class="act"></td></tr>
${rows || `<tr><td class="none" colspan="3">No accounts granted.</td></tr>`}
</tbody></table>
<p class="acl-note">Invite links you make with the CLI are not listed here.</p>
<form class="grant" method="post" action="/dash/pages/${p.id}/grants">
<label for="g-${p.id}">Grant access by email</label>
<div class="grant-row"><input class="field" id="g-${p.id}" name="email" type="email" required autocomplete="off" autocapitalize="none" spellcheck="false" aria-describedby="h-${p.id}${bad ? ` ${noteId}` : ""}"${mine === "email" ? ` aria-invalid="true"` : ""}><button class="btn primary">Grant</button></div>
<p class="help" id="h-${p.id}">They sign in with this email (email code, Google, GitHub or a passkey) to open the page.</p>
</form>
</article>`;
}

function empty(email: string): string {
  return `<div class="dash-empty">
<h3>No pages yet.</h3>
<p>Pages you publish while the CLI is signed in as ${esc(email)} show up here.</p>
${cmd("austere-axi cloud login")}
${cmd("austere-axi publish <file>")}
<p><a href="${INSTALL_GUIDE}">New to austere-axi? Install guide</a></p>
</div>`;
}

function sharedList(shared: SharedPage[], email: string, now: number): string {
  if (!shared.length) return `<p class="shared-empty">Nothing shared with you yet. When an owner grants ${esc(email)}, the page shows up here.</p>`;
  return `<ul class="shared">${shared
    .map(
      (p) =>
        `<li><a href="/p/${p.id}">${p.title.trim() ? esc(p.title) : `<span class="untitled">Untitled page</span>`}</a><span class="meta">${p.owner ? `${esc(p.owner)} · ` : ""}${expiry(p.expires_at, now)}</span></li>`,
    )
    .join("")}</ul>`;
}

export interface DashboardData {
  user: User;
  origin: string;
  pages: OwnedPage[];
  grants: Map<string, Grant[]>;
  shared: SharedPage[];
  notice: Notice;
  now: number;
}

/** The `<main>` content of the signed-in `/`. */
export function dashboardBody(d: DashboardData): string {
  // A notice for a page that is not in the list is dropped.
  const notice = d.notice && (d.notice.page === undefined ? d.notice.code === "gone" : d.pages.some((p) => p.id === d.notice!.page)) ? d.notice : null;
  return `<div class="dash"><div class="wrap dash-in">
<section aria-labelledby="your-pages">
<div class="dash-head"><h1 id="your-pages">Your pages</h1><p class="muted">Signed in as ${esc(d.user.email)} · ${plural(d.pages.length, "page", "pages")}</p></div>
${notice && notice.page === undefined ? noticeHtml(notice.code, "n-top", " top") : ""}
${d.pages.length ? `<div class="dash-list">\n${d.pages.map((p) => entry(p, d.grants.get(p.id) ?? [], d.user, d.origin, d.now, notice)).join("\n")}\n</div>` : empty(d.user.email)}
</section>
<section class="dash-side" aria-labelledby="shared-with-you">
<h2 id="shared-with-you">Shared with you</h2>
${sharedList(d.shared, d.user.email, d.now)}
</section>
</div></div>`;
}
