import type { D1Migration } from "cloudflare:test";
import type { Env as AppEnv } from "../src/env";

// `env` from cloudflare:workers is typed by the global Env / Cloudflare.Env.
declare global {
  interface Env extends AppEnv {
    TEST_MIGRATIONS: D1Migration[];
  }
  namespace Cloudflare {
    interface Env extends globalThis.Env {}
  }
}
