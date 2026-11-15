import { createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { mutation, parseServerFrame, syncProtocols } from "austere-axi/sync";
import type { AckFrame, ErrorCode, MutationArgs, MutationName, PublishArgs, ReceivedChanges, ReceivedFrame } from "austere-axi/sync";
import worker from "../src/index";
import { randomId, sha256B64url, sha256Hex } from "../src/util";

/** The version floor: the one value in wrangler.toml, so tests follow it when RLM-271 changes it. */
export const CLI = env.MIN_CLI_VERSION;
export const ORIGIN = "https://austere.test";

type CallInit = RequestInit & { ip?: string; token?: string; json?: unknown; env?: Env };

export async function call(path: string, init: CallInit = {}): Promise<Response> {
  const headers = new Headers(init.headers);
  headers.set("cf-connecting-ip", init.ip ?? "203.0.113.1");
  if (init.token) headers.set("authorization", `Bearer ${init.token}`);
  let body = init.body;
  if (init.json !== undefined) {
    body = JSON.stringify(init.json);
    headers.set("content-type", "application/json");
  }
  const ctx = createExecutionContext();
  const res = await worker.fetch(new Request(ORIGIN + path, { ...init, headers, body }), init.env ?? env, ctx);
  await waitOnExecutionContext(ctx);
  return res;
}

export async function newOwner(ip?: string): Promise<string> {
  const res = await call("/api/owners", { method: "POST", ip });
  if (res.status !== 201) throw new Error(`owner create failed: ${res.status}`);
  return ((await res.json()) as { token: string }).token;
}

export const PAGE_HTML = `<!doctype html>
<html><head><meta charset="utf-8"><title>Plan</title>
<script src="/rt/${CLI}/austere.js"></script></head>
<body><script type="text/openui">
root = Card([CardHeader("Hello")])
</script></body></html>`;

export async function putObject(token: string, body: string, type = "text/html"): Promise<{ res: Response; sha: string }> {
  const sha = await sha256Hex(body);
  const res = await call(`/api/objects/${sha}`, { method: "PUT", token, body, headers: { "content-type": type } });
  return { res, sha };
}

export async function createPage(token: string): Promise<string> {
  const res = await call("/api/pages", { method: "POST", token });
  if (res.status !== 201) throw new Error(`page create failed: ${res.status}`);
  return ((await res.json()) as { id: string }).id;
}

/** Every socket a test opened; test/setup.ts closes them after each test. */
export const clients = new Set<Client>();

/** A test client on one socket: frames are read with austere-axi/sync's `parseServerFrame`. */
export class Client {
  readonly frames: ReceivedFrame[] = [];
  closed: { code: number; reason: string } | null = null;
  private waiters: (() => void)[] = [];
  private n = 0;

  constructor(
    readonly ws: WebSocket,
    readonly clientId = `test-${crypto.randomUUID().slice(0, 8)}`,
  ) {
    clients.add(this);
    ws.accept();
    ws.addEventListener("message", (e) => {
      const parsed = parseServerFrame(e.data);
      if (!parsed.ok) throw new Error(`bad server frame: ${parsed.error.message}`);
      if (parsed.value) this.frames.push(parsed.value);
      this.wake();
    });
    ws.addEventListener("close", (e) => {
      this.closed = { code: e.code, reason: e.reason };
      this.wake();
    });
  }

  /** Resolves on the next frame or close, or after `ms` (the timeout guard of a test that waits). */
  private event(ms: number): Promise<void> {
    const { promise, resolve } = Promise.withResolvers<void>();
    const t = setTimeout(resolve, ms);
    this.waiters.push(() => (clearTimeout(t), resolve()));
    return promise;
  }

  private wake(): void {
    for (const w of this.waiters.splice(0)) w();
  }

  /** The first unread frame matching `pred`, removed from the buffer. */
  async take<F extends ReceivedFrame>(pred: (f: ReceivedFrame) => f is F, ms?: number): Promise<F>;
  async take(pred: (f: ReceivedFrame) => boolean, ms?: number): Promise<ReceivedFrame>;
  async take(pred: (f: ReceivedFrame) => boolean, ms = 2000): Promise<ReceivedFrame> {
    const deadline = Date.now() + ms;
    for (;;) {
      const i = this.frames.findIndex(pred);
      if (i >= 0) return this.frames.splice(i, 1)[0];
      if (this.closed) throw new Error(`socket closed (${this.closed.code}) while waiting`);
      const left = deadline - Date.now();
      if (left <= 0) throw new Error(`no matching frame; buffered: ${JSON.stringify(this.frames)}`);
      await this.event(left);
    }
  }

  changes(ms?: number): Promise<ReceivedChanges> {
    return this.take((f): f is ReceivedChanges => f.t === "changes", ms);
  }

  /** Waits for the server to close the socket. */
  async closedWith(ms = 2000): Promise<{ code: number; reason: string }> {
    const deadline = Date.now() + ms;
    while (!this.closed) {
      const left = deadline - Date.now();
      if (left <= 0) throw new Error("socket stayed open");
      await this.event(left);
    }
    return this.closed;
  }

  sendRaw(data: unknown): void {
    this.ws.send(typeof data === "string" ? data : JSON.stringify(data));
  }

  /** Sends a pull and collects frames up to the one without `more`. */
  async pull(after: number): Promise<ReceivedChanges[]> {
    this.sendRaw({ v: 1, t: "pull", after });
    const out = [await this.changes()];
    while (out[out.length - 1].more) out.push(await this.changes());
    return out;
  }

  /** Sends a mutation with the next `n` (or the given one) and returns its ack. */
  async mutate<N extends MutationName>(name: N, args: MutationArgs[N], n = ++this.n): Promise<AckFrame> {
    this.sendRaw(mutation(name, args, { clientId: this.clientId, n }));
    return this.take((f): f is AckFrame => f.t === "ack" && f.clientId === this.clientId && f.n === n);
  }

  close(): void {
    try {
      this.ws.close(1000);
    } catch {
      // already closed
    }
  }
}

type SocketInit = { protocols?: string[]; origin?: string | null; ip?: string; env?: Env; clientId?: string };

/** Opens a socket at `path`; resolves to a Client on 101, or to the refusal Response. */
export async function open(path: string, init: SocketInit = {}): Promise<Client | Response> {
  const headers: Record<string, string> = { upgrade: "websocket" };
  if (init.protocols) headers["sec-websocket-protocol"] = init.protocols.join(", ");
  if (init.origin !== null) headers.origin = init.origin ?? ORIGIN;
  const res = await call(path, { headers, ip: init.ip, env: init.env });
  if (res.status !== 101 || !res.webSocket) return res;
  if (res.headers.get("sec-websocket-protocol") !== "austere-sync.1") throw new Error(`answered protocol ${res.headers.get("sec-websocket-protocol")}`);
  return new Client(res.webSocket, init.clientId);
}

async function client(path: string, init: SocketInit): Promise<Client> {
  const c = await open(path, init);
  if (c instanceof Response) throw new Error(`${path}: handshake ${c.status} ${await c.text()}`);
  return c;
}

export function ownerSocket(token: string, id: string, init: SocketInit & { cli?: string } = {}): Promise<Client> {
  return client(`/api/pages/${id}/sync?cli=${init.cli ?? CLI}`, { protocols: syncProtocols({ owner: token }), ...init });
}

export function reviewerSocket(id: string, init: SocketInit & { invite?: string } = {}): Promise<Client> {
  return client(`/p/${id}/sync`, { protocols: syncProtocols({ invite: init.invite }), ...init });
}

/** Grants invite `name` on an owner socket and returns its token, as `publish --invite` does. */
export async function grant(owner: Client, name: string, expiresAt: number | null = null): Promise<string> {
  const token = randomId(32);
  const ack = await owner.mutate("grant", { name, tokenHash: await sha256B64url(token), expiresAt });
  if (ack.error) throw new Error(`grant ${name}: ${ack.error.message}`);
  return token;
}

/** `grant` on a fresh owner socket. */
export async function invite(token: string, id: string, name = "Ana", expiresAt: number | null = null): Promise<string> {
  const owner = await ownerSocket(token, id);
  const t = await grant(owner, name, expiresAt);
  owner.close();
  return t;
}

/** POST /p/:id/asset-token with the invite (if any) in X-Austere-Invite. */
export function assetToken(id: string, invite?: string, init: { ip?: string } = {}): Promise<Response> {
  return call(`/p/${id}/asset-token`, { method: "POST", headers: invite === undefined ? {} : { "x-austere-invite": invite }, ip: init.ip });
}

/** The artifact as the chrome loads it: trade the invite for an asset token, then GET /p/:id/a/<token>/. */
export async function artifact(id: string, invite?: string): Promise<Response> {
  const res = await assetToken(id, invite);
  if (res.status !== 200) return res;
  const { token } = (await res.json()) as { token: string };
  return call(`/p/${id}/a/${token}/`);
}

/** The code of a refused handshake (`{ error: { code, message } }`). */
export async function refusalCode(res: Response): Promise<ErrorCode> {
  const body: { error: { code: ErrorCode } } = await res.json();
  return body.error.code;
}

export function publishArgs(html: string, over: Partial<PublishArgs> = {}): PublishArgs {
  return { title: "Plan", cliVersion: CLI, html, packs: [], auto: false, unlisted: false, presence: true, ...over };
}

/**
 * The full publish flow the CLI runs: create the page (unless `id` is given), upload the HTML
 * and packs, then send `publish` on an owner socket. Returns the page id and the ack.
 */
export async function publish(
  token: string,
  opts: { id?: string; html?: string; packs?: { name: string; code: string }[]; args?: Partial<PublishArgs>; ip?: string } = {},
): Promise<{ id: string; ack: AckFrame }> {
  const id = opts.id ?? (await createPage(token));
  const { sha } = await putObject(token, opts.html ?? PAGE_HTML);
  const packs = [];
  for (const p of opts.packs ?? []) {
    const { sha: sha256 } = await putObject(token, p.code, "text/javascript");
    packs.push({ sha256, name: p.name, version: "1.0.0" });
  }
  const owner = await ownerSocket(token, id, { ip: opts.ip });
  const ack = await owner.mutate("publish", publishArgs(sha, { packs, ...opts.args }));
  owner.close();
  return { id, ack };
}

export async function gzip(text: string): Promise<Uint8Array> {
  const stream = new Blob([text]).stream().pipeThrough(new CompressionStream("gzip"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

export { sha256B64url, sha256Hex };
