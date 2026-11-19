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
          // Accounts on, against a WorkOS stub (test/workos.ts answers https://workos.test); no real keys.
          bindings: {
            TEST_MIGRATIONS: migrations,
            IP_HMAC_KEY: "test-hmac-key",
            WORKOS_CLIENT_ID: "client_test",
            WORKOS_API_KEY: "sk_test_stub",
            WORKOS_COOKIE_PASSWORD: "test-cookie-password-0123456789abcdef",
            WORKOS_API_BASE: "https://workos.test",
          },
        },
      }),
    ],
    test: { setupFiles: ["./test/setup.ts"] },
  };
});
