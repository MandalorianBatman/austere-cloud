// The public routes: /security and the crawler and brand files.
import { describe, expect, it } from "vitest";
import { call } from "./helpers";

describe("/security", () => {
  it("is an indexable HTML page with its own canonical URL", async () => {
    const res = await call("/security");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("text/html; charset=utf-8");
    expect(res.headers.get("x-robots-tag")).toBeNull();
    expect(res.headers.get("content-security-policy")).toContain("img-src 'self'");
    const html = await res.text();
    expect(html).toContain('<link rel="canonical" href="https://austere.blundertech.com/security">');
    expect(html).toContain("<h1>How austere cloud keeps shared pages private</h1>");
    expect(html).toContain("Not built yet");
    expect(html).not.toMatch(/<meta name="robots"/);
  });

  it("is public: no session needed, GET and HEAD only", async () => {
    expect((await call("/security", { method: "HEAD" })).status).toBe(200);
    const post = await call("/security", { method: "POST" });
    expect(post.status).toBe(405);
    expect(post.headers.get("allow")).toBe("GET, HEAD");
  });
});

describe("/", () => {
  it("is indexable when signed out", async () => {
    const res = await call("/");
    expect(res.headers.get("content-type")).toBe("text/html; charset=utf-8");
    expect(res.headers.get("x-robots-tag")).toBeNull();
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(await res.text()).not.toMatch(/<meta name="robots"/);
  });
});

describe("robots.txt", () => {
  it("allows the marketing pages and disallows every private path", async () => {
    const res = await call("/robots.txt");
    expect(res.headers.get("content-type")).toBe("text/plain; charset=utf-8");
    const body = await res.text();
    expect(body).toContain("Allow: /\n");
    for (const p of ["/p/", "/api/", "/auth/", "/dash/", "/rt/", "/pk/"]) expect(body).toContain(`Disallow: ${p}\n`);
    expect(body).toContain("Sitemap: https://austere.blundertech.com/sitemap.xml");
  });
});

describe("sitemap.xml", () => {
  it("lists exactly the two indexable pages on the canonical host", async () => {
    const res = await call("/sitemap.xml");
    expect(res.headers.get("content-type")).toBe("application/xml; charset=utf-8");
    const locs = [...(await res.text()).matchAll(/<loc>(.*?)<\/loc>/g)].map((m) => m[1]);
    expect(locs).toEqual(["https://austere.blundertech.com/", "https://austere.blundertech.com/security"]);
  });
});

describe("llms.txt", () => {
  it("is markdown that names the product and links the docs", async () => {
    const res = await call("/llms.txt");
    expect(res.headers.get("content-type")).toBe("text/plain; charset=utf-8");
    const body = await res.text();
    expect(body.startsWith("# austere\n")).toBe(true);
    expect(body).toContain("](https://austere.blundertech.com/security)");
    expect(body).toContain("## Docs");
  });
});

describe("brand files", () => {
  it("serves the favicon as SVG", async () => {
    const res = await call("/favicon.svg");
    expect(res.headers.get("content-type")).toBe("image/svg+xml");
    expect(await res.text()).toMatch(/^<svg /);
  });

  it("serves og.png as a 1200x630 PNG", async () => {
    const res = await call("/og.png");
    expect(res.headers.get("content-type")).toBe("image/png");
    const bytes = new Uint8Array(await res.arrayBuffer());
    expect([...bytes.slice(0, 8)]).toEqual([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    const view = new DataView(bytes.buffer);
    expect([view.getUint32(16), view.getUint32(20)]).toEqual([1200, 630]);
  });

  it("serves apple-touch-icon.png as a 180x180 PNG", async () => {
    const res = await call("/apple-touch-icon.png");
    expect(res.headers.get("content-type")).toBe("image/png");
    const view = new DataView(await res.arrayBuffer());
    expect([view.getUint32(16), view.getUint32(20)]).toEqual([180, 180]);
  });

  it("answers other methods with 405", async () => {
    expect((await call("/robots.txt", { method: "POST" })).status).toBe(405);
  });
});
