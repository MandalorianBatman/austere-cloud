import path from "node:path";
import { defineConfig } from "vitest/config";
import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-pool-workers";

export default defineConfig(async () => {
  const migrations = await readD1Migrations(path.join(import.meta.dirname, "migrations"));
  return {
    plugins: [
      cloudflareTest({
        wrangler: { configPath: "./wrangler.toml" },
        miniflare: {
          bindings: { TEST_MIGRATIONS: migrations, IP_HMAC_KEY: "test-hmac-key", MIN_CLI_VERSION: "0.4.1" },
        },
      }),
    ],
    test: { setupFiles: ["./test/setup.ts"] },
  };
});
