import { applyD1Migrations, reset } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { afterEach, beforeEach } from "vitest";
import { clients } from "./helpers";

beforeEach(async () => {
  await reset();
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
});

afterEach(() => {
  for (const c of clients) c.close();
  clients.clear();
});
