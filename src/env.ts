import type { PageObject } from "./page";

export interface Env {
  DB: D1Database;
  PAGES: R2Bucket;
  /** One page object per page id. */
  PAGE: DurableObjectNamespace<PageObject>;
  /** Lowest austere-axi version that uploads and /rt/ requests accept. */
  MIN_CLI_VERSION: string;
  /** "true": reviewer sockets need only the page id (until invites, RLM-314). */
  PAGE_ID_AS_CREDENTIAL?: string;
  /** HMAC key for ip_hash (secret). */
  IP_HMAC_KEY: string;
  /** Test hook: where /rt/ fetches runtime assets from. Defaults to jsDelivr. */
  RT_ORIGIN?: string;
}
