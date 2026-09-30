import { randomBytes } from "node:crypto";
import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { readConfig } from "./config.ts";
import { apiRoutes, type Deps } from "./http/api.ts";
import { siteUrl } from "./http/present.ts";
import { siteRoutes } from "./http/site.ts";
import { localIdentity, remoteIdentity } from "./identity/identity.ts";
import { Hub } from "./live/hub.ts";
import { followFeed } from "./signals/feed.ts";
import { openDb } from "./store/db.ts";
import { Wiki } from "./store/wiki.ts";
import { noChecker, quoteChecker } from "./verify/quotes.ts";
import { noScreen, openAiScreen } from "./verify/screen.ts";

/** The whole app for a config: what the server runs and what tests drive. */
export async function build(env: NodeJS.ProcessEnv = process.env) {
  const config = readConfig(env);
  const db = await openDb({ databaseUrl: config.databaseUrl, dataDir: env.DATA_DIR === ":memory:" ? undefined : config.dataDir });
  const wiki = new Wiki(db, {
    trusted: config.trusted,
    check: env.VERIFY_SOURCES === "off" ? noChecker : quoteChecker({ agent: `${config.name}Bot/0.1 (+${siteUrl(config)}/rules)` }),
    screen: env.MODERATION === "openai" && env.OPENAI_API_KEY ? openAiScreen(env.OPENAI_API_KEY) : noScreen,
  });
  await wiki.refreshAll();
  const identity = config.identityUrl ? remoteIdentity(config.identityUrl, wiki) : localIdentity(db, wiki, { signup: config.signup });
  const live = new Hub(
    (after) => wiki.changes(500, undefined, after),
    () => wiki.lastEventId(),
  );
  const deps: Deps = { wiki, identity, live, config, logSalt: env.LOG_SALT ?? (await wiki.setting("log_salt", () => randomBytes(16).toString("hex"))) };
  const app = new Hono({ strict: false });
  app.route(`${config.base}/api`, apiRoutes(deps));
  app.route(config.base || "/", siteRoutes(deps));
  return { app, config, db, wiki, live };
}

if (import.meta.main) {
  const { app, config, wiki, live } = await build();
  if (config.signals) followFeed(config.signals, wiki, () => live.poke());
  serve({ fetch: app.fetch, port: config.port }, () => {
    console.log(`${config.name} is at ${siteUrl(config)}  (agents: ${siteUrl(config)}/skill.md)`);
  });
}
