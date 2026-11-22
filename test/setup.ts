import { applyD1Migrations, reset } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { afterEach, beforeEach, vi } from "vitest";
import { clients } from "./helpers";
import { installWorkos } from "./workos";

// Every owner is an account (RLM-434), so every test signs in through the WorkOS stub.
beforeEach(async () => {
  await reset();
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
  installWorkos();
});

afterEach(() => {
  for (const c of clients) c.close();
  clients.clear();
  vi.restoreAllMocks();
});
