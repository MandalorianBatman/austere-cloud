import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { CLI, PAGE_HTML, call, createPage, gzip, newOwner, ownerSocket, publish, publishArgs, putObject, sha256Hex } from "./helpers";

const row = (id: string) => env.DB.prepare("SELECT * FROM pages WHERE id = ?").bind(id).first<Record<string, number | string | null>>();
const objectKeys = async () => (await env.PAGES.list({ prefix: "objects/" })).objects.map((o) => o.key).sort();

describe("publish lifecycle", () => {
  it("create -> upload -> publish -> fetch -> republish -> delete", async () => {
    const token = await newOwner();
    const created = await call("/api/pages", { method: "POST", token });
    expect(created.status).toBe(201);
    const { id, url } = (await created.json()) as { id: string; url: string };
    expect(id).toMatch(/^[A-Za-z0-9_-]{22}$/);
    expect(url).toBe(`https://austere.test/p/${id}`);
    // Unpublished: nothing to serve or list, and it expires in a day.
    expect((await call(`/p/${id}`)).status).toBe(404);
    expect((await call(`/p/${id}/a/`)).status).toBe(404);
    expect(await (await call("/api/pages", { token })).json()).toEqual({ pages: [] });
    expect(Number((await row(id))!.expires_at)).toBeLessThan(Date.now() + 86400_001);

    const { ack } = await publish(token, { id });
    expect(ack.error).toBeUndefined();
    const art = await call(`/p/${id}/a/`);
    expect(art.status).toBe(200);
    expect(await art.text()).toBe(PAGE_HTML);
    const shell = await (await call(`/p/${id}`)).text();
    expect(shell).toContain(`/rt/${CLI}/chrome/chrome.js`);
    expect(shell).toContain(`"base":"/p/${id}"`);
    const first = (await row(id))!;
    expect(first).toMatchObject({ title: "Plan", cli_version: CLI, html: await sha256Hex(PAGE_HTML), bytes: PAGE_HTML.length, notes: 0 });
    expect(Number(first.expires_at)).toBeGreaterThan(Date.now() + 29 * 86400_000);
    expect(await (await call("/api/pages", { token })).json()).toEqual({
      pages: [{ id, title: "Plan", url, expiresAt: first.expires_at, notes: 0 }],
    });

    // Republish keeps the id, replaces the content, resets the clock, drops the old object.
    await new Promise((r) => setTimeout(r, 5));
    const html2 = PAGE_HTML.replace("Hello", "Hello again");
    expect((await publish(token, { id, html: html2, args: { title: "Plan v2" } })).ack.error).toBeUndefined();
    expect(await (await call(`/p/${id}/a/`)).text()).toBe(html2);
    const second = (await row(id))!;
    expect(second.title).toBe("Plan v2");
    expect(Number(second.published_at)).toBeGreaterThan(Number(first.published_at));
    expect(await objectKeys()).toEqual([`objects/${await sha256Hex(html2)}`]);

    const owner = await ownerSocket(token, id);
    expect((await owner.mutate("delete", {})).error).toBeUndefined();
    expect((await call(`/p/${id}`)).status).toBe(404);
    expect((await call(`/p/${id}/a/`)).status).toBe(404);
    expect(await row(id)).toBeNull();
    expect(await objectKeys()).toEqual([]);
    expect(await (await call("/api/pages", { token })).json()).toEqual({ pages: [] });
  });

  it("keeps an object another page still names", async () => {
    const token = await newOwner();
    const a = await publish(token);
    const b = await publish(token);
    const owner = await ownerSocket(token, a.id);
    await owner.mutate("delete", {});
    expect((await call(`/p/${b.id}/a/`)).status).toBe(200);
    expect(await objectKeys()).toEqual([`objects/${await sha256Hex(PAGE_HTML)}`]);
  });

  it("the replaced REST routes are gone", async () => {
    const token = await newOwner();
    const { id } = await publish(token);
    expect((await call(`/api/pages/${id}`, { method: "PUT", token, json: {} })).status).toBe(404);
    expect((await call(`/api/pages/${id}`, { method: "DELETE", token })).status).toBe(404);
    expect((await call(`/api/pages/${id}/notes?after=0`, { token })).status).toBe(404);
    expect((await call(`/p/${id}/conversation`)).status).toBe(404);
    expect((await call(`/p/${id}/send`, { method: "POST", json: {} })).status).toBe(404);
  });
});

describe("objects", () => {
  it("stores an object under its sha256, plain or gzip, once", async () => {
    const token = await newOwner();
    const { res, sha } = await putObject(token, PAGE_HTML);
    expect(res.status).toBe(204);
    const obj = (await env.PAGES.get(`objects/${sha}`))!;
    expect(await obj.text()).toBe(PAGE_HTML);
    expect(obj.httpMetadata?.contentType).toBe("text/html; charset=utf-8");

    const code = "window.__pack = 1;";
    const gz = await call(`/api/objects/${await sha256Hex(code)}`, {
      method: "PUT",
      token,
      headers: { "content-type": "text/javascript", "content-encoding": "gzip" },
      body: await gzip(code),
    });
    expect(gz.status).toBe(204);
    expect(await (await env.PAGES.get(`objects/${await sha256Hex(code)}`))!.text()).toBe(code);
    expect((await putObject(token, PAGE_HTML)).res.status).toBe(204); // existing: no-op
  });

  it("rejects a body that does not match its name, an unknown type, a bad name, no token", async () => {
    const token = await newOwner();
    const sha = await sha256Hex("good");
    const put = (path: string, init: Parameters<typeof call>[1]) => call(path, { method: "PUT", ...init });
    const mismatch = await put(`/api/objects/${sha}`, { token, body: "evil", headers: { "content-type": "text/html" } });
    expect(mismatch.status).toBe(400);
    expect(((await mismatch.json()) as { error: string }).error).toMatch(/sha256/);
    expect((await put(`/api/objects/${sha}`, { token, body: "good", headers: { "content-type": "image/svg+xml" } })).status).toBe(400);
    expect((await put(`/api/objects/${sha.toUpperCase()}`, { token, body: "good", headers: { "content-type": "text/html" } })).status).toBe(400);
    expect((await put(`/api/objects/${sha}`, { body: "good", headers: { "content-type": "text/html" } })).status).toBe(401);
    expect((await put(`/api/objects/${sha}`, { token, headers: { "content-type": "text/html", "content-encoding": "gzip" }, body: new Uint8Array([0x1f, 0x8b, 1, 2, 3]) })).status).toBe(400);
    expect(await objectKeys()).toEqual([]);
  });
});

describe("auth", () => {
  it("rejects missing and wrong tokens", async () => {
    expect((await call("/api/pages", { method: "POST" })).status).toBe(401);
    expect((await call("/api/pages", { method: "POST", token: "nope" })).status).toBe(401);
    expect((await call("/api/pages", { token: "nope" })).status).toBe(401);
  });

  it("hides one owner's pages from another", async () => {
    const alice = await newOwner();
    const mallory = await newOwner("203.0.113.9");
    await publish(alice);
    expect(await (await call("/api/pages", { token: mallory })).json()).toEqual({ pages: [] });
  });

  it("stores only a hash of the token", async () => {
    const token = await newOwner();
    const r = await env.DB.prepare("SELECT token_hash FROM owners").first<{ token_hash: string }>();
    expect(r!.token_hash).toBe(await sha256Hex(token));
    expect(r!.token_hash).not.toContain(token);
  });

  it("refuses a blocked owner", async () => {
    const token = await newOwner();
    await env.DB.prepare("UPDATE owners SET blocked = 1").run();
    expect((await call("/api/pages", { method: "POST", token })).status).toBe(403);
  });
});

describe("publish validation", () => {
  const rejected = [
    ["foreign host", `<script src="https://evil.example/x.js"></script>`],
    ["protocol-relative", `<script src="//evil.example/x.js"></script>`],
    ["single quotes", `<script src='https://evil.example/x.js'></script>`],
    ["unquoted, upper-case attribute", `<script SRC=https://evil.example/x.js></script>`],
    ["newline before src", `<script\n  async\n  src="https://evil.example/x.js"></script>`],
    ["other runtime version", `<script src="/rt/9.9.9/austere.js"></script>`],
    ["runtime asset not on the allow-list", `<script src="/rt/${CLI}/cli.mjs"></script>`],
    ["mermaid.min.js (Mermaid is a pack now)", `<script src="/rt/${CLI}/mermaid.min.js"></script>`],
    ["runtime path traversal", `<script src="/rt/${CLI}/packs/../../x.js"></script>`],
    ["runtime pack fallback path", `<script src="/rt/${CLI}/packs/shadcn/pack.js"></script>`],
    ["query string on a runtime asset", `<script src="/rt/${CLI}/austere.js?x=1"></script>`],
    ["pack the publish does not name", `<script src="/pk/${"a".repeat(64)}.js"></script>`],
    ["data URL", `<script src="data:text/javascript,alert(1)"></script>`],
    ["relative", `<script src="austere.js"></script>`],
    ["empty src", `<script src></script>`],
  ] as const;

  for (const [name, tag] of rejected) {
    it(`rejects a script src: ${name}`, async () => {
      const token = await newOwner();
      const { id, ack } = await publish(token, { html: PAGE_HTML.replace("</head>", `${tag}</head>`) });
      expect(ack.error).toMatchObject({ code: "invalid", message: expect.stringMatching(/script src/) });
      expect((await row(id))!.published_at).toBeNull();
    });
  }

  it("ignores a src attribute mentioned inside another attribute's value", async () => {
    const token = await newOwner();
    const html = PAGE_HTML.replace("</head>", `<script data-x="src='https://evil.example/x.js'"></script></head>`);
    expect((await publish(token, { html })).ack.error).toBeUndefined();
  });

  it("accepts runtime assets and named packs, and serves packs by sha", async () => {
    const token = await newOwner();
    const code = "window.__pack = 1;";
    const sha = await sha256Hex(code);
    const html = PAGE_HTML.replace("</head>", `<script src="/rt/${CLI}/packs/shadcn.js"></script><script src="/pk/${sha}.js"></script></head>`);
    // Uploaded but not yet named: not served.
    await putObject(token, code, "text/javascript");
    expect((await call(`/pk/${sha}.js`)).status).toBe(404);
    const { id, ack } = await publish(token, { html, packs: [{ name: "@acme/charts", code }] });
    expect(ack.error).toBeUndefined();

    const pk = await call(`/pk/${sha}.js`);
    expect(pk.status).toBe(200);
    expect(await pk.text()).toBe(code);
    expect(pk.headers.get("content-type")).toContain("text/javascript");
    expect(pk.headers.get("cache-control")).toContain("immutable");
    expect(pk.headers.get("x-content-type-options")).toBe("nosniff");
    // A named HTML object is not served as a pack.
    expect((await call(`/pk/${(await row(id))!.html}.js`)).status).toBe(404);
  });

  it("rejects a cliVersion below MIN_CLI_VERSION or not a release version", async () => {
    const token = await newOwner();
    const id = await createPage(token);
    // 0.8.1 is the austere-axi release before `publish` existed.
    for (const v of ["0.8.1", "0.4.0", "0.0.1", "1.0.0-rc.1"]) {
      const { ack } = await publish(token, { id, html: PAGE_HTML.replace(CLI, v), args: { cliVersion: v } });
      expect(ack.error, v).toMatchObject({ code: "invalid", message: expect.stringContaining(env.MIN_CLI_VERSION) });
    }
    // The floor itself and anything above it, including a double-digit minor, are accepted.
    expect((await publish(token, { id })).ack.error).toBeUndefined();
    expect((await publish(token, { id, html: PAGE_HTML.replace(CLI, "0.10.0"), args: { cliVersion: "0.10.0" } })).ack.error).toBeUndefined();
  });

  it("caps the title and defaults an empty one", async () => {
    const token = await newOwner();
    const { id } = await publish(token, { args: { title: "  " } });
    expect((await row(id))!.title).toBe("Untitled");
    await publish(token, { id, args: { title: "t".repeat(300) } });
    expect(String((await row(id))!.title)).toHaveLength(200);
  });
});

describe("size cap", () => {
  const noise = (n: number) => {
    // Incompressible text, so the gzip size tracks the input size.
    let s = "";
    while (s.length < n) {
      for (const b of crypto.getRandomValues(new Uint8Array(65536))) s += String.fromCharCode(33 + (b % 90));
    }
    return s.slice(0, n);
  };
  const putGzip = async (token: string, text: string, headers: Record<string, string> = {}) => {
    const body = await gzip(text);
    const res = await call(`/api/objects/${await sha256Hex(text)}`, {
      method: "PUT",
      token,
      headers: { "content-type": "text/html", "content-encoding": "gzip", ...headers },
      body,
    });
    return { res, body };
  };

  it("returns 413 when the gzip body exceeds 1 MB, naming the size", async () => {
    const token = await newOwner();
    const text = PAGE_HTML + `<!--${noise(1_300_000)}-->`;
    const size = (await gzip(text)).byteLength;
    expect(size).toBeGreaterThan(1024 * 1024);
    const { res } = await putGzip(token, text, { "content-length": String(size) });
    expect(res.status).toBe(413);
    expect(((await res.json()) as { error: string }).error).toContain(String(size));
    expect(await objectKeys()).toEqual([]);
  });

  it("enforces the cap without trusting content-length", async () => {
    const token = await newOwner();
    const { res } = await putGzip(token, PAGE_HTML + `<!--${noise(1_300_000)}-->`, { "content-length": "100" });
    expect(res.status).toBe(413);
  });

  it("accepts an object just under the cap that is far larger once inflated", async () => {
    const token = await newOwner();
    expect((await putGzip(token, PAGE_HTML + `<!--${"x".repeat(5_000_000)}-->`)).res.status).toBe(204);
  });

  it("returns 413 for a gzip bomb instead of inflating it", async () => {
    const token = await newOwner();
    const { res, body } = await putGzip(token, PAGE_HTML + `<!--${"x".repeat(40_000_000)}-->`);
    expect(body.byteLength).toBeLessThan(1024 * 1024);
    expect(res.status).toBe(413);
  });
});

describe("rate limits", () => {
  it("limits new owners to 5 per IP per day", async () => {
    for (let i = 0; i < 5; i++) expect((await call("/api/owners", { method: "POST", ip: "198.51.100.1" })).status).toBe(201);
    const res = await call("/api/owners", { method: "POST", ip: "198.51.100.1" });
    expect(res.status).toBe(429);
    expect(Number(res.headers.get("retry-after"))).toBeGreaterThan(0);
    // Another IP is unaffected.
    expect((await call("/api/owners", { method: "POST", ip: "198.51.100.2" })).status).toBe(201);
  });

  it("limits publishes to 100 per IP per day across owners", async () => {
    const tokens = [];
    for (let i = 0; i < 5; i++) tokens.push(await newOwner(`198.51.100.${10 + i}`));
    const sockets = [];
    for (const token of tokens) {
      const id = await createPage(token);
      sockets.push(await ownerSocket(token, id, { ip: "192.0.2.50" }));
    }
    const { sha } = await putObject(tokens[0], PAGE_HTML);
    for (let i = 0; i < 100; i++) expect((await sockets[i % 5].mutate("publish", publishArgs(sha))).error, String(i)).toBeUndefined();
    expect((await sockets[0].mutate("publish", publishArgs(sha))).error).toMatchObject({ code: "rate_limited" });
  });

  it("starts a new window once the old one has elapsed", async () => {
    for (let i = 0; i < 5; i++) await call("/api/owners", { method: "POST", ip: "198.51.100.3" });
    expect((await call("/api/owners", { method: "POST", ip: "198.51.100.3" })).status).toBe(429);
    await env.DB.prepare("UPDATE limits SET window_start = window_start - 86400001").run();
    expect((await call("/api/owners", { method: "POST", ip: "198.51.100.3" })).status).toBe(201);
  });

  it("keys limits on an HMAC of the IP, not the address", async () => {
    await call("/api/owners", { method: "POST", ip: "198.51.100.4" });
    const rows = await env.DB.prepare("SELECT key FROM limits").all<{ key: string }>();
    expect(rows.results.length).toBe(1);
    expect(rows.results[0].key).not.toContain("198.51.100.4");
  });
});
