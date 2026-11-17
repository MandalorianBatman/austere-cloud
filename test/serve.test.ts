import { env } from "cloudflare:workers";
import { afterEach, describe, expect, it, vi } from "vitest";
import { syncProtocols } from "austere-axi/sync";
import { CLI, PAGE_HTML, artifact, call, invite, newOwner, open, publish } from "./helpers";

describe("hosted page headers", () => {
  it("shell: strict CSP with the boot script allowed by hash, noindex", async () => {
    const body = await publish(await newOwner());
    const res = await call(`/p/${body.id}`);
    const csp = res.headers.get("content-security-policy")!;
    for (const d of ["default-src 'none'", "frame-src 'self'", "frame-ancestors 'none'", "connect-src 'self'", "base-uri 'none'", "font-src data:"]) {
      expect(csp).toContain(d);
    }
    expect(res.headers.get("x-robots-tag")).toBe("noindex, nofollow");
    expect(res.headers.get("referrer-policy")).toBe("no-referrer");

    // The inline boot script must match a hash in script-src, or the browser blocks it.
    const html = await res.text();
    const inline = /<script>([\s\S]*?)<\/script>/.exec(html)![1];
    const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(inline)));
    expect(csp).toContain(`'sha256-${btoa(String.fromCharCode(...digest))}'`);
    expect(csp.match(/script-src[^;]*/)![0]).not.toContain("unsafe-inline");
  });

  it("shell boot has the design's fields and never carries the page title", async () => {
    const body = await publish(await newOwner(), { args: { title: `</script><img src=x onerror=alert(1)>` } });
    const html = await (await call(`/p/${body.id}`)).text();
    expect(html).not.toContain("</script><img");
    expect(html).not.toContain("onerror");
    expect(html).toContain("<title>Shared page · austere</title>");
    const boot = JSON.parse(/window\.__AUSTERE__=(.*?)<\/script>/.exec(html)![1].replace(/\\u003c/g, "<"));
    expect(boot).toMatchObject({
      id: body.id,
      viewer: { role: "reviewer", name: "" },
      hosted: { base: `/p/${body.id}`, report: `/p/${body.id}/report` },
      artifactUrl: `/p/${body.id}/a/`,
      version: CLI,
    });
    expect(boot).toMatchObject({ title: "Shared page", name: "Shared page" });
  });

  it("artifact: sandbox CSP without allow-same-origin, no network, noindex", async () => {
    const token = await newOwner();
    const body = await publish(token);
    const res = await artifact(body.id, await invite(token, body.id));
    expect(res.status).toBe(200);
    expect(res.headers.get("referrer-policy")).toBe("no-referrer");
    const csp = res.headers.get("content-security-policy")!;
    expect(csp).toContain("sandbox allow-scripts;");
    expect(csp).not.toContain("allow-same-origin");
    expect(csp).toContain("connect-src 'none'");
    expect(csp).toContain("font-src data:");
    expect(csp).toContain("default-src 'none'");
    expect(res.headers.get("x-robots-tag")).toBe("noindex, nofollow");
    expect(res.headers.get("content-type")).toContain("text/html");
    expect(await res.text()).toBe(PAGE_HTML);
  });
});

describe("page availability", () => {
  it("404s for unknown, malformed and expired pages; 410 once taken down", async () => {
    const token = await newOwner();
    const body = await publish(token);
    expect((await call(`/p/${"A".repeat(22)}`)).status).toBe(404);
    expect((await call(`/p/short`)).status).toBe(404);
    expect((await call(`/p/${body.id}/a`)).status).toBe(404);
    expect((await call(`/p/${body.id}/other`)).status).toBe(404);

    await env.DB.prepare("UPDATE pages SET expires_at = ?").bind(Date.now() - 1).run();
    expect((await call(`/p/${body.id}`)).status).toBe(404);
    expect((await call(`/p/${body.id}/a/`)).status).toBe(404);
    // The owner can't reach an expired page's object either.
    const expired = await open(`/api/pages/${body.id}/sync?cli=${CLI}`, { protocols: syncProtocols({ owner: token }) });
    expect((expired as Response).status).toBe(404);

    await env.DB.prepare("UPDATE pages SET expires_at = ?, taken_down = 1").bind(Date.now() + 1e9).run();
    expect((await call(`/p/${body.id}`)).status).toBe(410);
    expect((await call(`/p/${body.id}/a/`)).status).toBe(410);
    await env.DB.prepare("UPDATE pages SET taken_down = 0").run();
    expect((await call(`/p/${body.id}`)).status).toBe(200);
    await env.DB.prepare("INSERT INTO blocked_ids (page_id) VALUES (?)").bind(body.id).run();
    expect((await call(`/p/${body.id}`)).status).toBe(410);
    await env.DB.prepare("DELETE FROM pages").run();
    expect((await call(`/p/${body.id}`)).status).toBe(410); // the tombstone outlives the row
    await env.DB.prepare("DELETE FROM blocked_ids").run();
    expect((await call(`/p/${body.id}`)).status).toBe(404);
  });

  it("410s every page of a blocked owner", async () => {
    const body = await publish(await newOwner());
    await env.DB.prepare("UPDATE owners SET blocked = 1").run();
    expect((await call(`/p/${body.id}`)).status).toBe(410);
    expect((await call(`/p/${body.id}/a/`)).status).toBe(410);
  });

  it("only GET and HEAD reach the pages", async () => {
    const body = await publish(await newOwner());
    expect((await call(`/p/${body.id}`, { method: "POST" })).status).toBe(405);
  });
});

describe("/rt/<version>/<asset> proxy", () => {
  afterEach(() => vi.restoreAllMocks());

  function upstream(over: (url: string) => Response | undefined = () => undefined) {
    const real = globalThis.fetch;
    return vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const url = String(input instanceof Request ? input.url : input);
      if (!url.startsWith("https://cdn.jsdelivr.net/")) return real(input as any, init);
      return over(url) ?? new Response(`// ${url}`, { headers: { "content-type": "application/octet-stream" } });
    });
  }

  it("proxies allow-listed assets from jsDelivr with the right type and caching, once", async () => {
    const spy = upstream();
    const a = await call("/rt/1.0.0/austere.js");
    expect(a.status).toBe(200);
    expect(await a.text()).toBe("// https://cdn.jsdelivr.net/npm/austere-axi@1.0.0/dist/austere.js");
    expect(a.headers.get("content-type")).toBe("text/javascript; charset=utf-8");
    expect(a.headers.get("cache-control")).toContain("immutable");
    expect(a.headers.get("x-content-type-options")).toBe("nosniff");

    expect((await (await call("/rt/1.0.0/austere.js")).text())).toContain("austere.js"); // second hit: cache
    expect(spy.mock.calls.filter(([u]) => String(u).includes("1.0.0/dist/austere.js")).length).toBe(1);
  });

  it("maps assets onto the package layout", async () => {
    const spy = upstream();
    const css = await call("/rt/1.0.1/chrome/chrome.css");
    expect(css.headers.get("content-type")).toBe("text/css; charset=utf-8");
    await call("/rt/1.0.1/chrome/chrome.js");
    await call("/rt/1.0.1/packs/shadcn.js");
    expect(spy.mock.calls.map(([u]) => String(u).replace("https://cdn.jsdelivr.net/npm/austere-axi@1.0.1/dist/", ""))).toEqual([
      "chrome/chrome.css",
      "chrome/chrome.js",
      "packs/shadcn/pack.js",
    ]);
  });

  it("404s mermaid.min.js without contacting jsDelivr (Mermaid is a pack now)", async () => {
    const spy = upstream();
    expect((await call("/rt/1.0.1/mermaid.min.js")).status).toBe(404);
    expect(spy).not.toHaveBeenCalled();
  });

  it("404s a version below MIN_CLI_VERSION without contacting jsDelivr", async () => {
    const spy = upstream();
    for (const v of ["0.0.1", "0.8.1"]) expect((await call(`/rt/${v}/austere.js`)).status, v).toBe(404);
    expect(spy).not.toHaveBeenCalled();
  });

  it("never fetches anything off the allow-list or below MIN_CLI_VERSION", async () => {
    const spy = upstream();
    for (const p of [
      "/rt/1.0.2/cli.mjs",
      "/rt/1.0.2/package.json",
      "/rt/1.0.2/../austere.js",
      "/rt/1.0.2/packs/shadcn/pack.js",
      "/rt/1.0.2/packs/Bad.js",
      "/rt/1.0.2/packs/%2e%2e/x.js",
      "/rt/1.0.2/austere.js/extra",
      "/rt/latest/austere.js",
      "/rt/1.0.2-beta.1/austere.js",
      "/rt/1.0/austere.js",
    ]) {
      expect((await call(p)).status, p).toBe(404);
    }
    expect(spy).not.toHaveBeenCalled();
  });

  it("passes upstream 404 through and reports other upstream failures as 502, uncached", async () => {
    upstream((u) => (u.includes("@1.1.0/") ? new Response("nope", { status: 404 }) : new Response("boom", { status: 503 })));
    expect((await call("/rt/1.1.0/austere.js")).status).toBe(404);
    expect((await call("/rt/1.1.1/austere.js")).status).toBe(502);
    const spy = upstream();
    spy.mockClear();
    expect((await call("/rt/1.1.1/austere.js")).status).toBe(200);
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it("rejects other methods", async () => {
    expect((await call("/rt/1.0.0/austere.js", { method: "POST" })).status).toBe(405);
  });
});
