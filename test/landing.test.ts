// The landing page teaches install before any austere-axi command, and cloud on/login before publish (RLM-443).
import { describe, expect, it } from "vitest";
import { landing } from "../src/landing";

describe("landing install path", () => {
  it("shows the install commands before the first austere-axi command", async () => {
    const html = await landing(null).text();
    // The hero terminal (aria-hidden) is an illustration; the hero's own install line sits before it.
    const hero = html.slice(0, html.indexOf('<div class="stage"'));
    expect(hero).toContain("<code>npm install -g austere-axi</code>");
    const text = html.slice(html.indexOf("</header>")).replace(/<[^>]+>/g, "");
    const firstCommand = text.search(/austere-axi (publish|cloud)/);
    for (const cmd of [
      "npm install -g austere-axi",
      "npx skills add MandalorianBatman/austere-axi --skill austere --skill austere-setup",
      "set up austere-axi",
    ]) {
      const at = text.indexOf(cmd);
      expect(at, cmd).toBeGreaterThanOrEqual(0);
      expect(at, cmd).toBeLessThan(firstCommand);
    }
    expect(text).toContain("claude plugin marketplace add MandalorianBatman/austere-axi");
    expect(text).toContain("claude plugin install austere@austere-axi");
  });

  it("runs cloud on, then cloud login, before publish in How it works", async () => {
    const html = await landing(null).text();
    const how = html.slice(html.indexOf('id="how"'), html.indexOf('id="security"')).replace(/<[^>]+>/g, "");
    const on = how.indexOf("austere-axi cloud on");
    const login = how.indexOf("austere-axi cloud login");
    const publish = how.indexOf("austere-axi publish");
    expect(on).toBeGreaterThanOrEqual(0);
    expect(on).toBeLessThan(login);
    expect(login).toBeLessThan(publish);
  });

  it("points Get started at the install section", async () => {
    expect(await landing(null).text()).toContain('href="#install">Get started');
  });
});
