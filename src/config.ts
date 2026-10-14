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
  /** Postgres connections this process may hold open (DB_POOL, default 10). */
  readonly dbPool: number;
  readonly dataDir: string | undefined;
  /** When set, keys are checked by this endpoint instead of the wiki's own table. */
  readonly identityUrl: string | undefined;
  /** Where a person gets a key when identity is remote. */
  readonly keyUrl: string | undefined;
  /**
   * Where a person signs in when identity is remote, with `{next}` for the path to come back
   * to: one sign-in for the product and the wiki (Tal, 2026-10-09: "sign up should be the
   * same as ShapelessAI"). The wiki then asks the product for a key as that person.
   */
  readonly signInUrl: string | undefined;
  readonly signup: "open" | "closed";
  /** The open source repo, linked from the home page and the footer (Tal, 2026-10-11). */
  readonly repoUrl: string;
  readonly adminToken: string | undefined;
  /** A header a trusting proxy sets to the caller's address; see network() in http/api.ts. */
  readonly clientIpHeader: string | undefined;
  /** Handles treated as established from their first write. */
  readonly trusted: ReadonlySet<string>;
  readonly actions: readonly PageAction[];
  /** "none" keeps the whole wiki out of search engines, whatever a page has earned. */
  readonly indexing: "earned" | "none";
  /** Who runs this wiki: named in the header and footer, and pitched once on every page. */
  readonly by: { readonly name: string; readonly url: string; readonly pitch: string | null } | undefined;
  /** Where the wiki reports what happens on it (observe/analytics.ts). Unset, it loads no script and sends nothing anywhere. */
  readonly analytics: { readonly key: string; readonly host: string } | undefined;
}

// ShapelessAI runs this wiki and makes social content with agents, which is what most of its
// pages are about: one line on every page says so, once (Tal, 2026-10-09: "plug ShapelessAI more").
const SHAPELESS_PITCH = "Put this to work: agents that make and post your social content. Free to start.";

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
    name: env.SITE_NAME ?? "Vizipedia",
    databaseUrl: env.DATABASE_URL || undefined,
    dbPool: Math.max(1, Math.floor(Number(env.DB_POOL) || 10)),
    dataDir: env.DATABASE_URL ? undefined : (env.DATA_DIR ?? "./data"),
    identityUrl: env.IDENTITY_URL || undefined,
    keyUrl: env.KEY_URL || undefined,
    signInUrl: env.SIGN_IN_URL || undefined,
    signup: env.SIGNUP === "closed" ? "closed" : "open",
    repoUrl: env.REPO_URL || "https://github.com/FirstClassTree/vizipedia",
    adminToken: env.ADMIN_TOKEN || undefined,
    clientIpHeader: env.CLIENT_IP_HEADER?.trim().toLowerCase() || undefined,
    trusted: new Set(trusted),
    actions: parseActions(env.PAGE_ACTIONS),
    indexing: env.INDEXING === "none" ? "none" : "earned",
    by:
      env.BY_NAME && env.BY_URL && /^https?:\/\//u.test(env.BY_URL)
        ? { name: env.BY_NAME, url: env.BY_URL, pitch: env.BY_PITCH || null }
        : { name: "ShapelessAI", url: "https://shapelessai.com", pitch: env.BY_PITCH ?? SHAPELESS_PITCH },
    analytics: analyticsConfig(env),
  };
}

// PostHog by name: it is open source, and its capture API is what every compatible sink speaks. The key
// is the project's public, ingestion-only token; the host is where events go, which may be your own
// proxy. Both the browser (ui/assets/analytics.js) and the server (observe/analytics.ts) report there.
function analyticsConfig(env: NodeJS.ProcessEnv): Config["analytics"] {
  if (!env.POSTHOG_KEY) return undefined;
  const host = (env.POSTHOG_HOST || "https://us.i.posthog.com").replace(/\/+$/u, "");
  if (!/^https?:\/\/[^/\s]+$/u.test(host)) throw new Error(`POSTHOG_HOST must be an origin like "https://us.i.posthog.com", got "${host}"`);
  return { key: env.POSTHOG_KEY, host };
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
