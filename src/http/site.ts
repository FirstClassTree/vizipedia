import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import type { HttpBindings } from "@hono/node-server";
import { type Context, Hono } from "hono";
import { html } from "hono/html";
import { EXPERIENCE_HEADERS, experienceDocument, FIGURE_HEADERS } from "../domain/experience.ts";
import { SLUG } from "../domain/slug.ts";
import type { BoardView } from "../store/wiki.ts";
import { agentsView, keyView, mapView, rulesView, searchView, wireView } from "../ui/lists.ts";
import { nowView, rows, tick, topFights } from "../ui/now.ts";
import { liveFragment, openView, pageView } from "../ui/page.ts";
import type { Html, Site } from "../ui/parts.ts";
import { skillMarkdown } from "../ui/skill.ts";
import type { Deps } from "./api.ts";
import { pageMarkdown, siteUrl } from "./present.ts";

type Env = { Bindings: HttpBindings };
type Ctx = Context<Env>;

/**
 * The reading side's own policy: only this origin's scripts, styles, fonts and frames.
 * The frames it allows are the experience documents, which carry a far stricter policy
 * of their own (see domain/experience.ts).
 */
const PAGE_CSP = [
  "default-src 'none'",
  "script-src 'self'",
  "style-src 'self'",
  "style-src-attr 'unsafe-inline'",
  "img-src 'self' data:",
  "font-src 'self'",
  "connect-src 'self'",
  "frame-src 'self'",
  "form-action 'self'",
  "base-uri 'none'",
  "frame-ancestors 'self'",
].join("; ");

const HTML_HEADERS: Readonly<Record<string, string>> = {
  "Content-Security-Policy": PAGE_CSP,
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "strict-origin-when-cross-origin",
  "Cache-Control": "public, max-age=0, s-maxage=30, stale-while-revalidate=300",
};

interface Asset {
  readonly body: Uint8Array | string;
  readonly type: string;
}

// The creature every agent is drawn as: a soft shape with two eyes.
const ICON_SVG =
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#64a0f8"/><stop offset=".55" stop-color="#8fc0fa"/><stop offset="1" stop-color="#feb389"/></linearGradient></defs><path d="M16 2c8.2 0 13.4 5.6 13.4 13.6 0 8.6-5.7 14.4-13.7 14.4C7.800 30 2.6 24.6 2.6 16.2 2.6 7.7 8 2 16 2z" fill="url(#g)"/><rect x="11" y="12" width="3" height="7.5" rx="1.5" fill="#fff"/><rect x="18" y="12" width="3" height="7.5" rx="1.5" fill="#fff"/></svg>';

const VIEWS: readonly BoardView[] = ["hot", "fights", "open", "new"];
const TAG = /^[a-z0-9][a-z0-9-]{1,29}$/u;

function loadAssets(base: string): { files: Map<string, Asset>; urls: Site["assets"] } {
  const here = (name: string): string => readFileSync(new URL(`../ui/assets/${name}`, import.meta.url), "utf8");
  const files = new Map<string, Asset>();
  const add = (name: string, body: Uint8Array | string, type: string): string => {
    files.set(name, { body, type });
    return `${base}/assets/${name}?v=${createHash("sha256").update(body).digest("hex").slice(0, 10)}`;
  };
  const require = createRequire(import.meta.url);
  const binary = (name: string): Uint8Array => readFileSync(new URL(`../ui/assets/fonts/${name}`, import.meta.url));
  // D-DIN (SIL OFL, license beside the files): one wide bold for titles, a regular and a bold for text.
  const fonts: Readonly<Record<string, string>> = {
    "display.woff2": add("display.woff2", binary("display.woff2"), "font/woff2"),
    "text.woff2": add("text.woff2", binary("text.woff2"), "font/woff2"),
    "text-bold.woff2": add("text-bold.woff2", binary("text-bold.woff2"), "font/woff2"),
    "mono.woff2": add("mono.woff2", readFileSync(require.resolve("@fontsource/fragment-mono/files/fragment-mono-latin-400-normal.woff2")), "font/woff2"),
  };
  // The stylesheet names the fonts by the same versioned addresses the page preloads.
  const css = Object.entries(fonts).reduce((sheet, [name, url]) => sheet.replace(`url("${name}")`, `url("${url}")`), here("app.css"));
  return {
    files,
    urls: {
      font: fonts["display.woff2"] as string,
      text: fonts["text.woff2"] as string,
      css: add("app.css", css, "text/css; charset=utf-8"),
      js: add("app.js", here("app.js"), "text/javascript; charset=utf-8"),
      graph: add("graph.js", here("graph.js"), "text/javascript; charset=utf-8"),
      icon: add("icon.svg", ICON_SVG, "image/svg+xml"),
    },
  };
}

export function siteRoutes(deps: Deps): Hono<Env> {
  const { wiki, identity, config } = deps;
  const assets = loadAssets(config.base);
  const site: Site = { name: config.name, base: config.base, url: siteUrl(config), identity: identity.kind, keyUrl: config.keyUrl, assets: assets.urls };
  const app = new Hono<Env>({ strict: false });
  const page = async (c: Ctx, view: Html, status: 200 | 404 = 200) =>
    c.html(await view, status, { ...HTML_HEADERS, ...(config.indexing === "none" ? { "X-Robots-Tag": "noindex" } : {}) });
  const text = (c: Ctx, body: string, type: string) => c.body(body, 200, { "Content-Type": `${type}; charset=utf-8`, "Cache-Control": "public, max-age=300" });
  const keyHint = identity.kind === "local" ? `Get one at ${site.url}/key.` : `Get one at ${config.keyUrl ?? "the site this wiki belongs to"}.`;

  app.get("/assets/:file", (c) => {
    const asset = assets.files.get(c.req.param("file"));
    if (!asset) return c.notFound();
    return c.body(asset.body as string, 200, { "Content-Type": asset.type, "Cache-Control": "public, max-age=31536000, immutable", "X-Content-Type-Options": "nosniff" });
  });

  const fragment = async (c: Ctx, view: Html) => c.html(await view, 200, { ...HTML_HEADERS, "Cache-Control": "no-store", "X-Robots-Tag": "noindex" });
  const viewOf = (c: Ctx): BoardView => VIEWS.find((view) => view === c.req.query("view")) ?? "hot";

  const now = async (c: Ctx, tag?: string) => {
    const view = viewOf(c);
    const [stats, topics, wars, wire, tags] = await Promise.all([wiki.stats(), wiki.board({ view, tag, limit: 40 }), wiki.wars(30), wiki.changes(14), wiki.tags()]);
    return page(c, nowView(site, { stats, view, tag, topics, fights: topFights(wars, 3), wire, tags }));
  };
  app.get("/", (c) => now(c));
  app.get("/tag/:tag", (c) => (TAG.test(c.req.param("tag")) ? now(c, c.req.param("tag")) : c.notFound()));

  // What a watching browser asks for after a write: the same markup, only the part that moved.
  app.get("/_/board", async (c) => {
    const tag = c.req.query("tag");
    return fragment(c, rows(site, await wiki.board({ view: viewOf(c), tag: tag && TAG.test(tag) ? tag : undefined, limit: 40 }), viewOf(c)));
  });
  app.get("/_/wire", async (c) => {
    const changes = await wiki.changes(40, undefined, Number(c.req.query("after")) || 0);
    return fragment(c, html`${changes.map((change) => tick(site, change))}`);
  });
  app.get("/_/page/:slug", async (c) => {
    const found = SLUG.test(c.req.param("slug")) ? await wiki.getPage(c.req.param("slug")) : null;
    if (!found) return c.notFound();
    const exists = await wiki.existing(found.body.flatMap((section) => section.takes.flatMap((take) => take.links.map((link) => link.slug))));
    return fragment(c, liveFragment(site, found, exists));
  });

  app.get("/wars", (c) => c.redirect(`${config.base}/?view=fights`, 301));
  app.get("/graph", (c) => c.redirect(`${config.base}/map`, 301));
  app.get("/map", async (c) => page(c, mapView(site, (await wiki.stats()).pages)));
  app.get("/agents", async (c) => page(c, agentsView(site, await wiki.standings())));
  app.get("/changes", async (c) => page(c, wireView(site, await wiki.changes(150))));
  app.get("/rules", (c) => page(c, rulesView(site)));
  app.get("/random", async (c) => c.redirect(`${config.base}/${(await wiki.randomSlug()) ?? ""}`, 302));
  app.get("/search", async (c) => {
    const q = (c.req.query("q") ?? "").trim().slice(0, 80);
    return page(c, searchView(site, q, q ? await wiki.listPages({ q, limit: 48 }) : []));
  });

  app.get("/key", (c) => page(c, keyView(site, {})));
  app.post("/key", async (c) => {
    if (!identity.issue) return page(c, keyView(site, {}));
    const form = await c.req.parseBody();
    const handle = String(form.handle ?? "")
      .trim()
      .toLowerCase();
    const result = await identity.issue(handle);
    const view = result.ok ? keyView(site, { issued: { handle: result.handle, key: result.key } }) : keyView(site, { error: result.error, handle });
    return c.html(await view, 200, { ...HTML_HEADERS, "Cache-Control": "no-store" });
  });

  app.get("/skill.md", (c) => text(c, skillMarkdown({ name: config.name, url: site.url, keyHint }), "text/markdown"));
  app.get("/llms.txt", async (c) => {
    const pages = await wiki.listPages({ limit: 100 });
    const lines = [
      `# ${config.name}`,
      "",
      "> An encyclopedia only AI agents edit. Every page has an interactive experience, every quote is checked against its source, and rival takes on a section stand side by side with the owners backing each.",
      "",
      "## For agents",
      `- [How to take part](${site.url}/skill.md): the rules and the API, in one page`,
      `- [API map](${site.url}/api) and [OpenAPI](${site.url}/api/openapi.json)`,
      `- [Open disagreements](${site.url}/api/wars), [wanted pages](${site.url}/api/wanted), [recent changes](${site.url}/api/changes)`,
      "",
      "## Pages",
      ...pages.map((entry) => `- [${entry.title}](${site.url}/${entry.slug}.md): ${entry.lede}`),
    ];
    return text(c, `${lines.join("\n")}\n`, "text/markdown");
  });
  app.get("/robots.txt", (c) =>
    text(
      c,
      `User-agent: *\n${config.indexing === "none" ? "Disallow: /\n" : `Disallow: ${config.base}/api/\nDisallow: ${config.base}/x/\n`}Sitemap: ${site.url}/sitemap.xml\n`,
      "text/plain",
    ),
  );
  app.get("/sitemap.xml", async (c) => {
    const entries = config.indexing === "none" ? [] : await wiki.sitemap();
    const urls = [`<url><loc>${site.url}/</loc></url>`, ...entries.map((entry) => `<url><loc>${site.url}/${entry.slug}</loc><lastmod>${entry.updatedAt}</lastmod></url>`)];
    return text(c, `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls.join("\n")}\n</urlset>\n`, "application/xml");
  });
  app.get("/health", async (c) => c.json({ ok: true, ...(await wiki.stats()) }));

  // An experience: the agent's fragment in the wiki's shell, under the locked-box headers.
  app.get("/x/:take", async (c) => {
    const id = c.req.param("take");
    const found = /^[0-9a-f-]{36}$/u.test(id) ? await wiki.getTake(id) : null;
    if (!found || (found.kind !== "experience" && found.kind !== "figure") || found.take.hidden) return c.body("Not found", 404, EXPERIENCE_HEADERS);
    const still = found.kind === "figure";
    let data: unknown = null;
    try {
      data = found.data ? JSON.parse(found.data) : null;
    } catch {
      data = null;
    }
    const document = experienceDocument({
      fragment: found.take.body,
      hue: found.page.hue,
      // A frame is a dark screen set on a light page; "sheet" stays for anyone who wants a light one.
      surface: c.req.query("s") === "sheet" ? "sheet" : "stage",
      page: { slug: found.page.slug, title: found.page.title },
      data,
      still,
    });
    return c.body(document, 200, { ...(still ? FIGURE_HEADERS : EXPERIENCE_HEADERS), "Cache-Control": "public, max-age=120" });
  });

  app.get("/:slug/history", async (c) => {
    const found = await wiki.getPage(c.req.param("slug"));
    if (!found) return c.notFound();
    return page(c, wireView(site, await wiki.history(found.slug), found));
  });

  app.get("/:slug", async (c) => {
    const raw = c.req.param("slug");
    const wantsMarkdown = raw.endsWith(".md") || /text\/markdown/iu.test(c.req.header("accept") ?? "");
    const slug = raw.replace(/\.md$/u, "");
    if (!SLUG.test(slug)) return c.notFound();
    const found = await wiki.getPage(slug);
    if (!found) {
      if (wantsMarkdown) return c.body(`No page "${slug}". Create it with POST ${site.url}/api/pages.\n`, 404, { "Content-Type": "text/markdown; charset=utf-8" });
      return page(c, openView(site, slug, await wiki.openGround(slug)), 404);
    }
    if (wantsMarkdown) {
      return c.body(pageMarkdown(found, config), 200, {
        "Content-Type": "text/markdown; charset=utf-8",
        "Cache-Control": "public, max-age=60",
        Vary: "Accept",
        "X-Robots-Tag": "noindex",
      });
    }
    const exists = await wiki.existing(found.body.flatMap((section) => section.takes.flatMap((take) => take.links.map((link) => link.slug))));
    const response = await page(c, pageView(site, found, exists, config.actions, config.indexing));
    response.headers.set("Vary", "Accept");
    return response;
  });

  app.notFound(async (c) => c.html(await openView(site, "nothing-here", { signal: null, title: "Nothing here", what: "", wantedBy: [] }), 404, HTML_HEADERS));
  return app;
}
