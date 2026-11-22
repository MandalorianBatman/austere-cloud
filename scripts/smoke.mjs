// Smoke test against a running Worker (`npm run dev`): publish a page through the sync
// contract, then exercise the page object's sockets the way the CLI and the chrome will.
//   AUSTERE_ACCESS_TOKEN=<access token> node scripts/smoke.mjs [base URL, default http://localhost:8787]
// The owner is an account (RLM-434): after `austere-axi cloud login`, `cloud.json`'s `account.accessToken`
// (it lives 5 minutes; `austere-axi cloud whoami` refreshes it). Needs Node 22+ (global WebSocket).
// Exits non-zero on the first failed check.
import { request } from "node:http";
import { request as httpsRequest } from "node:https";
import { createHash, randomBytes } from "node:crypto";
import { gzipSync } from "node:zlib";
import { mutation, parseServerFrame, syncProtocols } from "austere-axi/sync";

const BASE = (process.argv[2] ?? "http://localhost:8787").replace(/\/$/, "");
const WS = BASE.replace(/^http/, "ws");
const CLI = process.env.CLI_VERSION ?? "0.9.0";
const token = process.env.AUSTERE_ACCESS_TOKEN;
if (!token) {
  console.error("AUSTERE_ACCESS_TOKEN is not set: run `austere-axi cloud login` and use account.accessToken from cloud.json");
  process.exit(2);
}

function check(ok, what, detail) {
  if (!ok) {
    console.error(`FAIL ${what}${detail === undefined ? "" : `: ${JSON.stringify(detail)}`}`);
    process.exit(1);
  }
  console.log(`ok   ${what}`);
}

async function http(method, path, { token, body, headers = {} } = {}) {
  const res = await fetch(BASE + path, { method, body, headers: { ...headers, ...(token && { authorization: `Bearer ${token}` }) } });
  const text = await res.text();
  return { status: res.status, text, json: text ? JSON.parse(text.startsWith("{") ? text : "null") : null };
}

/** A raw upgrade request, to see the status of a refused handshake. */
function handshake(path, protocols, bearer) {
  return new Promise((resolve, reject) => {
    const req = (BASE.startsWith("https:") ? httpsRequest : request)(BASE + path, {
      headers: {
        connection: "Upgrade",
        upgrade: "websocket",
        "sec-websocket-version": "13",
        "sec-websocket-key": randomBytes(16).toString("base64"),
        "sec-websocket-protocol": protocols.join(", "),
        ...(bearer && { authorization: `Bearer ${bearer}` }),
      },
    });
    req.on("upgrade", (res, socket) => {
      socket.destroy();
      resolve({ status: 101, protocol: res.headers["sec-websocket-protocol"] });
    });
    req.on("response", (res) => {
      let body = "";
      res.on("data", (c) => (body += c));
      res.on("end", () => resolve({ status: res.statusCode, body: JSON.parse(body) }));
    });
    req.on("error", reject);
    req.end();
  });
}

/** One socket; frames are parsed with austere-axi/sync. `bearer`: the owner's access token. */
async function connect(path, credentials, { bearer, clientId = randomBytes(16).toString("base64url") } = {}) {
  const ws = new WebSocket(WS + path, { protocols: syncProtocols(credentials), headers: bearer ? { authorization: `Bearer ${bearer}` } : {} });
  const frames = [];
  const waiters = [];
  let closed = null;
  const wake = () => waiters.splice(0).forEach((w) => w());
  /** Resolves on the next frame or close, or after `ms`. */
  const event = (ms) => {
    const { promise, resolve } = Promise.withResolvers();
    const t = setTimeout(resolve, ms);
    waiters.push(() => (clearTimeout(t), resolve()));
    return promise;
  };
  ws.addEventListener("message", (e) => {
    const parsed = parseServerFrame(e.data);
    if (!parsed.ok) throw new Error(`bad server frame: ${parsed.error.message}`);
    if (parsed.value) frames.push(parsed.value);
    wake();
  });
  ws.addEventListener("close", (e) => {
    closed = { code: e.code, reason: e.reason };
    wake();
  });
  await new Promise((resolve, reject) => {
    ws.addEventListener("open", resolve, { once: true });
    ws.addEventListener("error", reject, { once: true });
  });
  let n = 0;
  const c = {
    ws,
    clientId,
    protocol: ws.protocol,
    get closed() {
      return closed;
    },
    async take(pred, ms = 5000) {
      const deadline = Date.now() + ms;
      for (;;) {
        const i = frames.findIndex(pred);
        if (i >= 0) return frames.splice(i, 1)[0];
        if (closed) throw new Error(`closed ${closed.code} while waiting; buffered ${JSON.stringify(frames)}`);
        const left = deadline - Date.now();
        if (left <= 0) throw new Error(`timed out; buffered ${JSON.stringify(frames)}`);
        await event(left);
      }
    },
    changes: () => c.take((f) => f.t === "changes"),
    async pull(after) {
      ws.send(JSON.stringify({ v: 1, t: "pull", after }));
      const out = [await c.changes()];
      while (out.at(-1).more) out.push(await c.changes());
      return out;
    },
    async mutate(name, args, at = ++n) {
      ws.send(JSON.stringify(mutation(name, args, { clientId, n: at })));
      return c.take((f) => f.t === "ack" && f.clientId === clientId && f.n === at);
    },
    async closedWith(ms = 5000) {
      const deadline = Date.now() + ms;
      while (!closed && Date.now() < deadline) await event(deadline - Date.now());
      return closed;
    },
  };
  return c;
}

// ── Owner: account, empty page, object upload ──────────────────────────────
const noOwners = await http("POST", "/api/owners");
check(noOwners.status === 410, "POST /api/owners -> 410 (no anonymous owners)", noOwners);
const anon = await http("GET", "/api/pages", { token: randomBytes(32).toString("base64url") });
check(anon.status === 401, "an anonymous owner token on /api -> 401", anon);
const created = await http("POST", "/api/pages", { token });
check(created.status === 201, `POST /api/pages -> 201 ${created.json.url}`, created);
const id = created.json.id;
check((await http("GET", `/p/${id}`)).status === 404, "unpublished page -> 404");

const html = `<!doctype html><html><head><meta charset="utf-8"><title>Smoke</title>
<script src="/rt/${CLI}/austere.js"></script></head><body><script type="text/openui">
root = Card([CardHeader("Smoke test")])
</script></body></html>`;
const sha = createHash("sha256").update(html).digest("hex");
const put = await http("PUT", `/api/objects/${sha}`, { token, body: gzipSync(html), headers: { "content-type": "text/html", "content-encoding": "gzip" } });
check(put.status === 204, `PUT /api/objects/${sha.slice(0, 12)}… (gzip) -> 204`, put);

// ── Handshakes ──────────────────────────────────────────────────────────────
const noToken = await handshake(`/api/pages/${id}/sync?cli=${CLI}`, ["austere-sync.1"]);
check(noToken.status === 403 && noToken.body.error.code === "forbidden", "owner socket without token -> 403 forbidden", noToken);
const legacy = await handshake(`/api/pages/${id}/sync?cli=${CLI}`, syncProtocols({ owner: randomBytes(32).toString("base64url") }));
check(legacy.status === 403, "owner socket with an anonymous owner token -> 403", legacy);
const oldCli = await handshake(`/api/pages/${id}/sync?cli=0.8.1`, syncProtocols({}), token);
check(oldCli.status === 426 && oldCli.body.error.code === "upgrade_required", "owner socket with cli=0.8.1 -> 426 upgrade_required", oldCli);
const good = await handshake(`/api/pages/${id}/sync?cli=${CLI}`, syncProtocols({}), token);
check(good.status === 101 && good.protocol === "austere-sync.1", "owner handshake -> 101, protocol austere-sync.1 (token not echoed)", good);

// ── Publish over the owner socket ───────────────────────────────────────────
const o = await connect(`/api/pages/${id}/sync?cli=${CLI}`, {}, { bearer: token });
const [empty] = await o.pull(0);
check(empty.rows.length === 0 && empty.cursor === 0, "owner pull(0) on an unpublished page -> no rows, cursor 0", empty);
const pub = await o.mutate("publish", { title: "Smoke", cliVersion: CLI, html: sha, packs: [], auto: false, unlisted: false, presence: true });
check(!pub.error, "publish -> ack", pub);
const pageRow = (await o.changes()).rows[0];
check(pageRow.type === "page" && pageRow.seq === 1 && pageRow.html === sha, "owner gets page row seq 1 live", pageRow);
check((await http("GET", `/p/${id}`)).status === 200, "GET /p/:id shell -> 200 (public, holds no content)");

// ── Invites: grant two, as `publish --invite` does ─────────────────────────
const inviteToken = () => randomBytes(32).toString("base64url");
const tokenHash = (t) => createHash("sha256").update(t).digest("base64url");
const ana = inviteToken();
const ben = inviteToken();
for (const [name, t] of [["Ana", ana], ["Ben", ben]]) {
  const g = await o.mutate("grant", { name, tokenHash: tokenHash(t), expiresAt: null });
  check(!g.error, `grant ${name} -> ack`, g);
  const acl = (await o.changes()).rows[0];
  check(acl.type === "acl" && acl.name === name && !("tokenHash" in acl), `owner gets acl row ${name} (no token hash)`, acl);
}
const noInvite = await handshake(`/p/${id}/sync`, ["austere-sync.1"]);
check(noInvite.status === 403 && noInvite.body.error.code === "forbidden", "reviewer socket without invite -> 403 forbidden", noInvite);
check((await http("POST", `/p/${id}/asset-token`)).status === 403, "asset-token without invite -> 403");
check((await http("GET", `/p/${id}/a/`)).status === 403, "artifact without asset token -> 403");
const traded = await http("POST", `/p/${id}/asset-token`, { headers: { "x-austere-invite": ana } });
check(traded.status === 200 && traded.json.name === "Ana", "asset-token with Ana's invite -> 200, name Ana", traded.json);
const art = await http("GET", `/p/${id}/a/${traded.json.token}/`);
check(art.status === 200 && art.text === html, "GET /p/:id/a/<assetToken>/ serves the uploaded object byte-for-byte");

// ── Reviewer: note, owner sees it, reply comes back ─────────────────────────
const r = await connect(`/p/${id}/sync`, { invite: ana });
const [first] = await r.pull(0);
check(first.rows.length === 1 && first.rows[0].type === "page" && first.cursor === 3, "reviewer pull(0) -> page row only (no acl), cursor 3", first);
const noteAck = await r.mutate("addNote", { name: "Mallory", items: [{ kind: "annotation", target: "intro", note: "Why now?" }] });
check(!noteAck.error, "reviewer addNote -> ack", noteAck);
const noteRow = (await o.changes()).rows[0];
check(noteRow.type === "note" && noteRow.author === "Ana" && noteRow.state === "held" && noteRow.seq === 4, "owner receives note row live (held, author = invite name Ana)", noteRow);
await r.changes();
const replyAck = await o.mutate("addReply", { text: "Because the deadline moved." });
check(!replyAck.error, "owner addReply -> ack", replyAck);
const replyRow = (await r.changes()).rows[0];
check(replyRow.type === "reply" && replyRow.seq === 5, "reviewer receives reply row live", replyRow);
await o.changes();

// ── Idempotency, roles, reconnect ───────────────────────────────────────────
const dup = await r.mutate("addNote", { items: [{ kind: "message", text: "dup" }] }, 1);
check(JSON.stringify(dup) === JSON.stringify(noteAck), "re-sent (clientId, n=1) -> same ack, nothing applied", dup);
const forbidden = await r.mutate("addReply", { text: "not mine" });
check(forbidden.error?.code === "forbidden", "reviewer addReply -> ack forbidden", forbidden);
const big = await r.mutate("addNote", { items: [{ kind: "message", text: "x".repeat(5000) }] });
check(big.error?.code === "too_large", "addNote with 5 KB items -> ack too_large", big);
r.ws.close();
await o.mutate("releaseNote", { note: noteRow.id });
const released = (await o.changes()).rows[0];
check(released.id === noteRow.id && released.state === "released" && released.seq === 6, "releaseNote -> note row at seq 6, released", released);
const r2 = await connect(`/p/${id}/sync`, { invite: ana });
const [since] = await r2.pull(first.cursor);
check(
  JSON.stringify(since.rows.map((x) => [x.type, x.seq])) === JSON.stringify([["reply", 5], ["note", 6]]) && since.cursor === 6,
  "reviewer reconnect pull(after=3) -> only reply 5 and note 6",
  since,
);

// ── Revoke one invite live ──────────────────────────────────────────────────
const rb = await connect(`/p/${id}/sync`, { invite: ben });
await rb.pull(0);
const benAsset = (await http("POST", `/p/${id}/asset-token`, { headers: { "x-austere-invite": ben } })).json.token;
const rev = await o.mutate("revoke", { name: "Ben" });
check(!rev.error, "revoke Ben -> ack", rev);
const revErr = await rb.take((f) => f.t === "error");
check(revErr.code === "forbidden", "Ben's open socket gets error forbidden", revErr);
const benClosed = await rb.closedWith();
check(benClosed?.code === 1008, "Ben's open socket closed with 1008", benClosed);
const benAgain = await handshake(`/p/${id}/sync`, syncProtocols({ invite: ben }));
check(benAgain.status === 403, "Ben's invite on a new handshake -> 403", benAgain);
check((await http("GET", `/p/${id}/a/${benAsset}/`)).status === 403, "Ben's earlier asset token -> 403");
check(!r2.closed && !(await r2.mutate("addNote", { items: [{ kind: "message", text: "still here" }] })).error, "Ana's socket stays open and can still send");
await o.changes(); // Ben's revoked acl row
await o.changes(); // Ana's note
await r2.changes(); // the revoke's frame: no rows (acl is the owner's), the page's counter
await r2.changes(); // Ana's note

// ── Delete ──────────────────────────────────────────────────────────────────
const del = await o.mutate("delete", {});
check(!del.error, "owner delete -> ack", del);
const gone = (await r2.changes()).rows[0];
check(gone.type === "page" && gone.deleted === true, "reviewer receives page row with deleted: true", gone);
const closed = await r2.closedWith();
check(closed?.code === 1000, "reviewer socket closed with 1000", closed);
check((await http("GET", `/p/${id}`)).status === 404, "GET /p/:id after delete -> 404");
const after = await handshake(`/p/${id}/sync`, ["austere-sync.1"]);
check(after.status === 404, "reviewer handshake after delete -> 404", after);
console.log("smoke: all checks passed");
process.exit(0);
