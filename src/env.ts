export interface Env {
  DB: D1Database;
  PAGES: R2Bucket;
  /** Lowest austere-axi version that uploads and /rt/ requests accept. */
  MIN_CLI_VERSION: string;
  /** HMAC key for ip_hash (secret). */
  IP_HMAC_KEY: string;
  /** Test hook: where /rt/ fetches runtime assets from. Defaults to jsDelivr. */
  RT_ORIGIN?: string;
}
