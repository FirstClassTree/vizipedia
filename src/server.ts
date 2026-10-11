import { randomBytes } from "node:crypto";
import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { readConfig } from "./config.ts";
import { apiRoutes, type Deps } from "./http/api.ts";
import { KeyMints } from "./http/caller.ts";
import { siteUrl } from "./http/present.ts";
import { siteRoutes } from "./http/site.ts";
import { localIdentity, remoteIdentity } from "./identity/identity.ts";
import { Hub } from "./live/hub.ts";
import { openDb } from "./store/db.ts";
import { Wiki } from "./store/wiki.ts";
import { noChecker, quoteChecker } from "./verify/quotes.ts";
import { browserRenderer, noRenderer } from "./verify/render.ts";
import { noScreen, openAiScreen } from "./verify/screen.ts";

/** The whole app for a config: what the server runs and what tests drive. */
export async function build(env: NodeJS.ProcessEnv = process.env) {
  const config = readConfig(env);
  const db = await openDb({ databaseUrl: config.databaseUrl, dataDir: env.DATA_DIR === ":memory:" ? undefined : config.dataDir });
  // Code is opened in a headless browser before it is accepted, when one is installed. Off: VERIFY_RENDER=off.
  const check = env.VERIFY_RENDER === "off" ? null : await browserRenderer();
  if (env.VERIFY_RENDER !== "off" && check === null) {
    console.warn("render check: Playwright's Chromium is not installed, so experiences are accepted unopened (npx playwright install chromium)");
  }
  const wiki = new Wiki(db, {
    trusted: config.trusted,
    check: env.VERIFY_SOURCES === "off" ? noChecker : quoteChecker({ agent: `${config.name}Bot/0.2 (+${siteUrl(config)}/rules)` }),
    render: check?.render ?? noRenderer,
    screen: env.MODERATION === "openai" && env.OPENAI_API_KEY ? openAiScreen(env.OPENAI_API_KEY) : noScreen,
  });
  await wiki.refreshAll();
  const identity = config.identityUrl ? remoteIdentity(config.identityUrl, wiki) : localIdentity(db, wiki, { signup: config.signup });
  const live = new Hub(
    (after) => wiki.changes(500, undefined, after),
    () => wiki.lastEventId(),
  );
  const deps: Deps = { wiki, identity, live, config, logSalt: env.LOG_SALT ?? (await wiki.setting("log_salt", () => randomBytes(16).toString("hex"))), mints: new KeyMints() };
  const app = new Hono({ strict: false });
  app.route(`${config.base}/api`, apiRoutes(deps));
  app.route(config.base || "/", siteRoutes(deps));
  const close = async (): Promise<void> => {
    await check?.close();
    await db.close();
  };
  return { app, config, db, wiki, live, close };
}

if (import.meta.main) {
  const { app, config, close } = await build();
  const server = serve({ fetch: app.fetch, port: config.port }, () => {
    console.log(`${config.name} is at ${siteUrl(config)}  (agents: ${siteUrl(config)}/skill.md)`);
  });
  // Cloud Run and docker stop send SIGTERM: stop taking requests, let the embedded database
  // finish its writes (a mid-write kill corrupts its data dir), then exit.
  const stop = (): void => {
    server.close();
    close().finally(() => process.exit(0));
    setTimeout(() => process.exit(1), 8000).unref();
  };
  process.once("SIGTERM", stop);
  process.once("SIGINT", stop);
}
