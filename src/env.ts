import type { PageObject } from "./page";

export interface Env {
  DB: D1Database;
  PAGES: R2Bucket;
  /** One page object per page id. */
  PAGE: DurableObjectNamespace<PageObject>;
  /** Lowest austere-axi version that uploads and /rt/ requests accept. */
  MIN_CLI_VERSION: string;
  /** HMAC key for ip_hash (secret). */
  IP_HMAC_KEY: string;
  /** The austere-axi release whose hub shell (`chrome/shell.js`, `shell.css`) the signed-in `/` loads through /rt. Pinned: a hub change reaches the cloud only through a deliberate bump. */
  HUB_VERSION: string;
  /** Test hook: where /rt/ fetches runtime assets from. Defaults to jsDelivr. */
  RT_ORIGIN?: string;
  /** WorkOS AuthKit client id (secret by convention; it is public). Unset: accounts are off and /auth/* answers 503. */
  WORKOS_CLIENT_ID?: string;
  /** WorkOS API key (secret): the browser code exchange, its refresh, and user lookups. */
  WORKOS_API_KEY?: string;
  /** Seals the `austere_session` cookie (secret, 32+ characters). */
  WORKOS_COOKIE_PASSWORD?: string;
  /** WorkOS API origin. Defaults to https://api.workos.com. */
  WORKOS_API_BASE?: string;
  /** Accepted access-token issuers, comma-separated. Defaults to the two WorkOS uses (src/jwt.ts `issuers`). */
  WORKOS_ISSUER?: string;
}
