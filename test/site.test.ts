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
    for (const p of ["/p/", "/api/", "/auth/", "/hub/", "/rt/", "/pk/"]) expect(body).toContain(`Disallow: ${p}\n`);
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

describe("theme", () => {
  const light = { cookie: "austere_theme=light" };
  const themeOf = (html: string) => /<html lang="en" data-theme="(\w+)">/.exec(html)![1];

  it("is dark with no cookie, on / and /security, and the toggle offers light", async () => {
    for (const path of ["/", "/security"]) {
      const html = await (await call(path)).text();
      expect(themeOf(html)).toBe("dark");
      expect(html).toContain('<meta name="color-scheme" content="dark">');
      expect(html).toContain('<meta name="theme-color" content="#000000">');
      expect(html).toContain('<button class="theme" name="theme" value="light" aria-label="Switch to light theme">');
      expect(html).toContain(`<input type="hidden" name="return_to" value="${path}">`);
    }
  });

  it("the light cookie renders light and the toggle offers dark; an unknown value is dark", async () => {
    for (const path of ["/", "/security"]) {
      const html = await (await call(path, { headers: light })).text();
      expect(themeOf(html)).toBe("light");
      expect(html).toContain('<meta name="theme-color" content="#F3F5F7">');
      expect(html).toContain('aria-label="Switch to dark theme"');
    }
    expect(themeOf(await (await call("/", { headers: { cookie: "austere_theme=neon" } })).text())).toBe("dark");
  });

  it("POST /theme sets a year-long cookie and redirects to the same-origin return_to", async () => {
    const res = await call("/theme", { method: "POST", body: new URLSearchParams({ theme: "light", return_to: "/security" }) });
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe("/security");
    const cookie = res.headers.get("set-cookie")!;
    expect(cookie).toContain("austere_theme=light");
    expect(cookie).toContain("Max-Age=31536000");
    expect(cookie).toContain("Path=/");
    expect(cookie).toContain("SameSite=Lax");
  });

  it("POST /theme never redirects off site", async () => {
    for (const bad of ["https://evil.test/", "//evil.test", "/\\evil.test", "javascript:alert(1)", ""]) {
      const res = await call("/theme", { method: "POST", body: new URLSearchParams({ theme: "dark", return_to: bad }) });
      expect(res.status).toBe(303);
      expect(res.headers.get("location")).toBe("/");
    }
  });

  it("POST /theme refuses an unknown theme and other methods", async () => {
    expect((await call("/theme", { method: "POST", body: new URLSearchParams({ theme: "neon" }) })).status).toBe(400);
    const get = await call("/theme");
    expect(get.status).toBe(405);
    expect(get.headers.get("allow")).toBe("POST");
  });

  it("the toggle's form is allowed by the CSP, which still has no script", async () => {
    for (const path of ["/", "/security"]) {
      const csp = (await call(path)).headers.get("content-security-policy")!;
      expect(csp).toContain("form-action 'self'");
      expect(csp).not.toContain("script-src");
      expect(csp).toContain("default-src 'none'");
    }
  });

  it("/security is not shared across themes by caches", async () => {
    const res = await call("/security");
    expect(res.headers.get("vary")).toBe("cookie");
    expect(res.headers.get("cache-control")).toBe("private, max-age=3600");
  });
});

describe("unknown route", () => {
  it("answers 404 inside the site chrome", async () => {
    const res = await call("/no/such/page");
    expect(res.status).toBe(404);
    expect(res.headers.get("content-type")).toContain("text/html");
    const html = await res.text();
    expect(html).toContain("Page not found");
    expect(html).toContain('<a class="skip"');
    expect(html).toContain("<nav");
    expect(html).toContain("<footer");
  });
});
