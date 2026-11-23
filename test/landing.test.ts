// The landing page teaches install before any austere-axi command, and cloud on/login before publish (RLM-443).
import { describe, expect, it } from "vitest";
import { landing } from "../src/landing";

const textOf = (html: string) => html.replace(/<[^>]+>/g, "");

describe("landing install path", () => {
  it("shows the install commands before the first austere-axi command", async () => {
    const html = await landing(null).text();
    // The hero's own install line sits before the sample sheet.
    const hero = html.slice(0, html.indexOf('class="sheet hero-sheet"'));
    expect(hero).toContain("<code>npm install -g austere-axi</code>");
    const text = textOf(html.slice(html.indexOf("</header>")));
    // Skip the hero's sample sheet and the outcomes: the first command a reader is told to run is in Get started.
    const start = text.indexOf("Share your first page");
    const guide = text.slice(start);
    const firstCommand = guide.search(/austere-axi (publish|cloud)/);
    for (const cmd of [
      "npm install -g austere-axi",
      "npx skills add MandalorianBatman/austere-axi --skill austere --skill austere-setup",
      "set up austere-axi",
    ]) {
      const at = guide.indexOf(cmd);
      expect(at, cmd).toBeGreaterThanOrEqual(0);
      expect(at, cmd).toBeLessThan(firstCommand);
    }
    expect(text).toContain("claude plugin marketplace add MandalorianBatman/austere-axi");
    expect(text).toContain("claude plugin install austere@austere-axi");
  });

  it("runs cloud on, then cloud login, before publish in Get started", async () => {
    const html = await landing(null).text();
    const start = textOf(html.slice(html.indexOf('id="start"'), html.indexOf('id="private"')));
    const on = start.indexOf("austere-axi cloud on");
    const login = start.indexOf("austere-axi cloud login");
    const publish = start.indexOf("Publish this plan as a page");
    expect(on).toBeGreaterThanOrEqual(0);
    expect(on).toBeLessThan(login);
    expect(login).toBeLessThan(publish);
  });

  it("points Get started at the install section", async () => {
    expect(await landing(null).text()).toContain('href="#start">Get started');
  });
});

describe("landing content", () => {
  it("sells the review, not the stack", async () => {
    const text = textOf(await landing(null).text());
    expect(text).toContain("Send your agent’s plan out for review.");
    expect(text).not.toMatch(/Runs on|Cloudflare|Durable Object|mutation n=/);
  });

  it("shows Sign In only when accounts are on", async () => {
    const off = await landing(null).text();
    const on = await landing("/auth/login?return_to=%2F").text();
    expect(off).not.toContain("Sign In");
    expect(on).toContain('href="/auth/login?return_to=%2F">Sign In');
  });

  it("carries canonical, social and structured metadata, without pricing", async () => {
    const html = await landing(null).text();
    expect(html).toContain('<link rel="canonical" href="https://austere.blundertech.com/">');
    expect(html).toContain('<meta property="og:image" content="https://austere.blundertech.com/og.png">');
    expect(html).toContain('<meta name="twitter:card" content="summary_large_image">');
    const ld = /<script type="application\/ld\+json">(.*?)<\/script>/s.exec(html);
    const graph = JSON.parse(ld![1])["@graph"] as { "@type": string }[];
    expect(graph.map((n) => n["@type"])).toEqual(["WebSite", "SoftwareApplication"]);
    expect(ld![1]).not.toMatch(/offers|aggregateRating/);
  });

  it("runs no script and loads only same-origin images", async () => {
    const res = landing(null);
    const html = await res.text();
    expect(html).not.toMatch(/<script(?![^>]*ld\+json)/);
    expect(html).not.toMatch(/(src|href)="https?:\/\/[^"]*\.(png|jpe?g|svg|woff2?)"/);
    const csp = res.headers.get("content-security-policy")!;
    expect(csp).toContain("default-src 'none'");
    expect(csp).toContain("img-src 'self'");
    expect(csp).not.toContain("script-src");
  });
});
