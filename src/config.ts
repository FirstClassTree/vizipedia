import { HANDLE } from "./domain/slug.ts";

export interface PageAction {
  readonly label: string;
  /** `{slug}` and `{title}` are filled in per page. */
  readonly url: string;
}

export interface Config {
  readonly port: number;
  /** Path prefix when the wiki is mounted inside another site, e.g. "/wiki". No trailing slash. */
  readonly base: string;
  /** Public origin, e.g. "https://example.com". Links in feeds, the sitemap and the agent prompt use it. */
  readonly origin: string;
  readonly name: string;
  readonly databaseUrl: string | undefined;
  readonly dataDir: string | undefined;
  /** When set, keys are checked by this endpoint instead of the wiki's own table. */
  readonly identityUrl: string | undefined;
  /** Where a person gets a key when identity is remote. */
  readonly keyUrl: string | undefined;
  readonly signup: "open" | "closed";
  readonly adminToken: string | undefined;
  /** Handles treated as established from their first write. */
  readonly trusted: ReadonlySet<string>;
  readonly actions: readonly PageAction[];
  /** "none" keeps the whole wiki out of search engines, whatever a page has earned. */
  readonly indexing: "earned" | "none";
  /** A trend feed to follow: where it is, what to call it, how often to read it. */
  readonly signals: { readonly url: string; readonly feed: string; readonly everyMs: number } | undefined;
}

export function readConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const port = Number(env.PORT ?? 4173);
  const base = (env.BASE_PATH ?? "").replace(/\/+$/u, "");
  if (base && !/^(\/[a-z0-9-]+)+$/u.test(base)) throw new Error(`BASE_PATH must look like "/wiki", got "${base}"`);
  const trusted = (env.TRUSTED_OWNERS ?? "")
    .split(",")
    .map((handle) => handle.trim())
    .filter(Boolean);
  for (const handle of trusted) if (!HANDLE.test(handle)) throw new Error(`TRUSTED_OWNERS holds an invalid handle: "${handle}"`);
  return {
    port,
    base,
    origin: (env.PUBLIC_ORIGIN ?? `http://localhost:${port}`).replace(/\/+$/u, ""),
    name: env.SITE_NAME ?? "OpenWiki",
    databaseUrl: env.DATABASE_URL || undefined,
    dataDir: env.DATABASE_URL ? undefined : (env.DATA_DIR ?? "./data"),
    identityUrl: env.IDENTITY_URL || undefined,
    keyUrl: env.KEY_URL || undefined,
    signup: env.SIGNUP === "closed" ? "closed" : "open",
    adminToken: env.ADMIN_TOKEN || undefined,
    trusted: new Set(trusted),
    actions: parseActions(env.PAGE_ACTIONS),
    indexing: env.INDEXING === "none" ? "none" : "earned",
    signals: env.SIGNALS_URL ? { url: env.SIGNALS_URL, feed: env.SIGNALS_FEED ?? "feed", everyMs: Math.max(Number(env.SIGNALS_EVERY_MIN ?? 15) || 15, 1) * 60_000 } : undefined,
  };
}

function parseActions(raw: string | undefined): PageAction[] {
  if (!raw) return [];
  const parsed: unknown = JSON.parse(raw);
  if (!Array.isArray(parsed)) throw new Error("PAGE_ACTIONS must be a JSON list of { label, url }");
  return parsed.map((entry) => {
    if (!entry || typeof entry.label !== "string" || typeof entry.url !== "string" || !/^https?:\/\//u.test(entry.url)) {
      throw new Error("PAGE_ACTIONS entries need a label and an absolute url");
    }
    return { label: entry.label, url: entry.url };
  });
}
