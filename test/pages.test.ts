import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { CLI, PAGE_HTML, call, gzip, newOwner, publish, sha256Hex, upload } from "./helpers";

describe("publish lifecycle", () => {
  it("create -> fetch -> republish -> delete", async () => {
    const token = await newOwner();
    const { res, body } = await publish(token);
    expect(res.status).toBe(201);
    expect(body.id).toMatch(/^[A-Za-z0-9_-]{22}$/);
    expect(body.url).toBe(`https://austere.test/p/${body.id}`);
    expect(body.expiresAt).toBeGreaterThan(Date.now() + 29 * 86400_000);

    // The artifact is served byte-for-byte.
    const art = await call(`/p/${body.id}/a/`);
    expect(art.status).toBe(200);
    expect(await art.text()).toBe(PAGE_HTML);

    // The shell boots hosted chrome from the pinned runtime.
    const shell = await call(`/p/${body.id}`);
    expect(shell.status).toBe(200);
    const html = await shell.text();
    expect(html).toContain(`/rt/${CLI}/chrome/chrome.js`);
    expect(html).toContain(`"base":"/p/${body.id}"`);

    const list = await call("/api/pages", { token });
    expect(await list.json()).toEqual({
      pages: [{ id: body.id, title: "Plan", url: body.url, expiresAt: body.expiresAt, notes: 0 }],
    });

    // Republish keeps the id and URL, replaces the content, resets the clock.
    const before = await env.DB.prepare("SELECT published_at, expires_at FROM pages WHERE id = ?").bind(body.id).first<any>();
    await new Promise((r) => setTimeout(r, 5));
    const html2 = PAGE_HTML.replace("Hello", "Hello again");
    const put = await call(`/api/pages/${body.id}`, { method: "PUT", token, json: upload({ html: html2, title: "Plan v2" }) });
    expect(put.status).toBe(200);
    expect(((await put.json()) as any).id).toBe(body.id);
    expect(await (await call(`/p/${body.id}/a/`)).text()).toBe(html2);
    const after = await env.DB.prepare("SELECT title, published_at, expires_at FROM pages WHERE id = ?").bind(body.id).first<any>();
    expect(after.title).toBe("Plan v2");
    expect(after.published_at).toBeGreaterThan(before.published_at);
    expect(after.expires_at).toBeGreaterThan(before.expires_at);

    const del = await call(`/api/pages/${body.id}`, { method: "DELETE", token });
    expect(del.status).toBe(204);
    expect((await call(`/p/${body.id}`)).status).toBe(404);
    expect((await call(`/p/${body.id}/a/`)).status).toBe(404);
    expect(await env.PAGES.head(`pages/${body.id}/index.html`)).toBeNull();
    expect(await (await call("/api/pages", { token })).json()).toEqual({ pages: [] });
  });

  it("deleting a page removes its notes and replies but keeps the rest", async () => {
    const token = await newOwner();
    const a = (await publish(token)).body.id;
    const b = (await publish(token)).body.id;
    for (const id of [a, b]) {
      await env.DB.prepare("INSERT INTO notes (page_id, author, items, ip_hash, at) VALUES (?, 'x', '[]', 'h', 1)").bind(id).run();
      await env.DB.prepare("INSERT INTO replies (page_id, text, at) VALUES (?, 'r', 1)").bind(id).run();
    }
    await call(`/api/pages/${a}`, { method: "DELETE", token });
    const left = await env.DB.prepare("SELECT page_id FROM notes UNION ALL SELECT page_id FROM replies").all<any>();
    expect(left.results.map((r) => r.page_id)).toEqual([b, b]);
  });

  it("accepts a gzip-encoded body and a plain one", async () => {
    const token = await newOwner();
    const gz = await call("/api/pages", {
      method: "POST",
      token,
      headers: { "content-encoding": "gzip", "content-type": "application/json" },
      body: await gzip(JSON.stringify(upload())),
    });
    expect(gz.status).toBe(201);
    const row = await env.DB.prepare("SELECT bytes FROM pages").first<{ bytes: number }>();
    expect(row!.bytes).toBeLessThan(JSON.stringify(upload()).length); // stored size is the wire size
    expect((await publish(token)).res.status).toBe(201);
  });
});

describe("auth", () => {
  it("rejects missing and wrong tokens", async () => {
    expect((await call("/api/pages", { method: "POST", json: upload() })).status).toBe(401);
    expect((await call("/api/pages", { method: "POST", token: "nope", json: upload() })).status).toBe(401);
    expect((await call("/api/pages", { token: "nope" })).status).toBe(401);
  });

  it("hides one owner's pages from another", async () => {
    const alice = await newOwner();
    const mallory = await newOwner("203.0.113.9");
    const { body } = await publish(alice);
    const put = await call(`/api/pages/${body.id}`, { method: "PUT", token: mallory, json: upload() });
    const del = await call(`/api/pages/${body.id}`, { method: "DELETE", token: mallory });
    expect([put.status, del.status]).toEqual([404, 404]);
    expect(await (await call("/api/pages", { token: mallory })).json()).toEqual({ pages: [] });
    expect((await call(`/p/${body.id}`)).status).toBe(200); // still there
  });

  it("stores only a hash of the token", async () => {
    const token = await newOwner();
    const row = await env.DB.prepare("SELECT token_hash FROM owners").first<{ token_hash: string }>();
    expect(row!.token_hash).toBe(await sha256Hex(token));
    expect(row!.token_hash).not.toContain(token);
  });

  it("refuses a blocked owner", async () => {
    const token = await newOwner();
    await env.DB.prepare("UPDATE owners SET blocked = 1").run();
    expect((await publish(token)).res.status).toBe(403);
  });
});

describe("upload validation", () => {
  const rejected = [
    ["foreign host", `<script src="https://evil.example/x.js"></script>`],
    ["protocol-relative", `<script src="//evil.example/x.js"></script>`],
    ["single quotes", `<script src='https://evil.example/x.js'></script>`],
    ["unquoted, upper-case attribute", `<script SRC=https://evil.example/x.js></script>`],
    ["newline before src", `<script\n  async\n  src="https://evil.example/x.js"></script>`],
    ["other runtime version", `<script src="/rt/9.9.9/austere.js"></script>`],
    ["runtime asset not on the allow-list", `<script src="/rt/${CLI}/cli.mjs"></script>`],
    ["runtime path traversal", `<script src="/rt/${CLI}/packs/../../x.js"></script>`],
    ["query string on a runtime asset", `<script src="/rt/${CLI}/austere.js?x=1"></script>`],
    ["pack that was not uploaded", `<script src="/pk/${"a".repeat(64)}.js"></script>`],
    ["data URL", `<script src="data:text/javascript,alert(1)"></script>`],
    ["relative", `<script src="austere.js"></script>`],
    ["empty src", `<script src></script>`],
  ] as const;

  for (const [name, tag] of rejected) {
    it(`rejects a script src: ${name}`, async () => {
      const token = await newOwner();
      const { res, body } = await publish(token, { html: PAGE_HTML.replace("</head>", `${tag}</head>`) });
      expect(res.status).toBe(400);
      expect(body.error).toMatch(/script src/);
      expect((await env.DB.prepare("SELECT COUNT(*) AS n FROM pages").first<any>()).n).toBe(0);
    });
  }

  it("ignores a src attribute mentioned inside another attribute's value", async () => {
    const token = await newOwner();
    const html = PAGE_HTML.replace("</head>", `<script data-x="src='https://evil.example/x.js'"></script></head>`);
    expect((await publish(token, { html })).res.status).toBe(201);
  });

  it("accepts runtime assets and uploaded packs, and serves packs by sha", async () => {
    const token = await newOwner();
    const code = "window.__pack = 1;";
    const sha = await sha256Hex(code);
    const html = PAGE_HTML.replace(
      "</head>",
      `<script src="/rt/${CLI}/mermaid.min.js"></script><script src="/rt/${CLI}/packs/shadcn.js"></script><script src="/pk/${sha}.js"></script></head>`,
    );
    const { res, body } = await publish(token, { html, packs: [{ sha256: sha, name: "@acme/charts", version: "1.2.0", code }] });
    expect(res.status).toBe(201);

    const pk = await call(`/pk/${sha}.js`);
    expect(pk.status).toBe(200);
    expect(await pk.text()).toBe(code);
    expect(pk.headers.get("content-type")).toContain("text/javascript");
    expect(pk.headers.get("cache-control")).toContain("immutable");
    expect(pk.headers.get("x-content-type-options")).toBe("nosniff");

    const row = await env.DB.prepare("SELECT packs FROM pages WHERE id = ?").bind(body.id).first<{ packs: string }>();
    expect(JSON.parse(row!.packs)).toEqual([{ sha256: sha, name: "@acme/charts", version: "1.2.0" }]);
  });

  it("does not store uploaded packs the page never references", async () => {
    const token = await newOwner();
    const code = "unused();";
    const sha = await sha256Hex(code);
    expect((await publish(token, { packs: [{ sha256: sha, name: "x", version: "1.0.0", code }] })).res.status).toBe(201);
    expect((await call(`/pk/${sha}.js`)).status).toBe(404);
  });

  it("rejects a pack whose code does not match its sha256", async () => {
    const token = await newOwner();
    const sha = await sha256Hex("good();");
    const html = PAGE_HTML.replace("</head>", `<script src="/pk/${sha}.js"></script></head>`);
    const { res, body } = await publish(token, { html, packs: [{ sha256: sha, name: "x", version: "1.0.0", code: "evil();" }] });
    expect(res.status).toBe(400);
    expect(body.error).toMatch(/sha256/);
    expect((await call(`/pk/${sha}.js`)).status).toBe(404);
  });

  it("rejects a cliVersion below MIN_CLI_VERSION or not a release version", async () => {
    const token = await newOwner();
    for (const v of ["0.4.0", "0.3.9", "1.0.0-rc.1", "latest", 5]) {
      expect((await publish(token, { cliVersion: v })).res.status).toBe(400);
    }
    expect((await publish(token, { cliVersion: "0.10.0", html: PAGE_HTML.replace(CLI, "0.10.0") })).res.status).toBe(201);
  });

  it("rejects malformed bodies", async () => {
    const token = await newOwner();
    expect((await call("/api/pages", { method: "POST", token, body: "{nope" })).status).toBe(400);
    expect((await call("/api/pages", { method: "POST", token, body: "[]" })).status).toBe(400);
    expect((await publish(token, { html: "" })).res.status).toBe(400);
    expect((await publish(token, { html: 5 })).res.status).toBe(400);
    expect((await call("/api/pages", { method: "POST", token, headers: { "content-encoding": "gzip" }, body: new Uint8Array([0x1f, 0x8b, 1, 2, 3]) })).status).toBe(400);
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

  it("returns 413 when the gzip body exceeds 1 MB, naming the size", async () => {
    const token = await newOwner();
    const body = await gzip(JSON.stringify(upload({ html: PAGE_HTML + `<!--${noise(1_300_000)}-->` })));
    expect(body.byteLength).toBeGreaterThan(1024 * 1024);
    const res = await call("/api/pages", {
      method: "POST",
      token,
      headers: { "content-encoding": "gzip", "content-length": String(body.byteLength) },
      body,
    });
    expect(res.status).toBe(413);
    expect(((await res.json()) as any).error).toContain(String(body.byteLength));
    expect((await env.DB.prepare("SELECT COUNT(*) AS n FROM pages").first<any>()).n).toBe(0);
  });

  it("enforces the cap without trusting content-length", async () => {
    const token = await newOwner();
    const body = await gzip(JSON.stringify(upload({ html: PAGE_HTML + `<!--${noise(1_300_000)}-->` })));
    const res = await call("/api/pages", { method: "POST", token, headers: { "content-encoding": "gzip", "content-length": "100" }, body });
    expect(res.status).toBe(413);
  });

  it("accepts a page just under the cap that is far larger once inflated", async () => {
    const token = await newOwner();
    const html = PAGE_HTML + `<!--${"x".repeat(5_000_000)}-->`;
    expect((await call("/api/pages", { method: "POST", token, headers: { "content-encoding": "gzip" }, body: await gzip(JSON.stringify(upload({ html }))) })).status).toBe(201);
  });

  it("returns 413 for a gzip bomb instead of inflating it", async () => {
    const token = await newOwner();
    const bomb = await gzip(JSON.stringify(upload({ html: PAGE_HTML + `<!--${"x".repeat(40_000_000)}-->` })));
    expect(bomb.byteLength).toBeLessThan(1024 * 1024);
    expect((await call("/api/pages", { method: "POST", token, headers: { "content-encoding": "gzip" }, body: bomb })).status).toBe(413);
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

  it("limits publishes to 20 per owner per day, creates and updates together", async () => {
    const token = await newOwner();
    const id = (await publish(token)).body.id;
    for (let i = 0; i < 19; i++) {
      const res = await call(`/api/pages/${id}`, { method: "PUT", token, json: upload() });
      expect(res.status).toBe(200);
    }
    expect((await call(`/api/pages/${id}`, { method: "PUT", token, json: upload() })).status).toBe(429);
    expect((await publish(token)).res.status).toBe(429);
    // Another owner (from another IP) is unaffected.
    expect((await publish(await newOwner("198.51.100.7"), {}, "198.51.100.7")).res.status).toBe(201);
  });

  it("limits publishes to 100 per IP per day across owners", async () => {
    const tokens = [];
    for (let i = 0; i < 5; i++) tokens.push(await newOwner(`198.51.100.${10 + i}`));
    let n = 0;
    for (let i = 0; i < 100; i++) {
      const { res } = await publish(tokens[i % 5], {}, "192.0.2.50");
      expect(res.status).toBe(201);
      n++;
    }
    expect(n).toBe(100);
    expect((await publish(tokens[0], {}, "192.0.2.50")).res.status).toBe(429);
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
