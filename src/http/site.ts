import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import type { HttpBindings } from "@hono/node-server";
import { type Context, Hono } from "hono";
import { EXPERIENCE_HEADERS, experienceDocument } from "../domain/experience.ts";
import { leadingTake } from "../domain/rules.ts";
import { SLUG } from "../domain/slug.ts";
import { homeView } from "../ui/home.ts";
import { agentsView, changesView, graphView, keyView, missingView, rulesView, searchView, warsView } from "../ui/lists.ts";
import { pageView } from "../ui/page.ts";
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

const ICON_SVG =
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 28 28"><rect width="28" height="28" rx="7" fill="#1b1430"/><path d="M9 6H6v16h3M19 6h3v16h-3" fill="none" stroke="#fff" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"/><path d="M12 9.5v9l7-4.5z" fill="#c4a7ff"/></svg>';

function loadAssets(base: string): { files: Map<string, Asset>; urls: Site["assets"] } {
  const here = (name: string): string => readFileSync(new URL(`../ui/assets/${name}`, import.meta.url), "utf8");
  const files = new Map<string, Asset>();
  const add = (name: string, body: Uint8Array | string, type: string): string => {
    files.set(name, { body, type });
    return `${base}/assets/${name}?v=${createHash("sha256").update(body).digest("hex").slice(0, 10)}`;
  };
  const font = add(
    "display.woff2",
    readFileSync(createRequire(import.meta.url).resolve("@fontsource-variable/bricolage-grotesque/files/bricolage-grotesque-latin-wght-normal.woff2")),
    "font/woff2",
  );
  return {
    files,
    urls: {
      font,
      // The stylesheet names the font by the same versioned address the page preloads.
      css: add("app.css", here("app.css").replace('url("display.woff2")', `url("${font}")`), "text/css; charset=utf-8"),
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

  app.get("/", async (c) => {
    const [stats, pages, wars, changes, wanted] = await Promise.all([wiki.stats(), wiki.listPages({ limit: 24 }), wiki.wars(6), wiki.changes(12), wiki.wanted(18)]);
    const top = pages.find((entry) => entry.playable);
    const full = top ? await wiki.getPage(top.slug) : null;
    const cover = full?.body.find((section) => section.kind === "experience" && leadingTake(section));
    const take = cover ? leadingTake(cover) : null;
    return page(c, homeView(site, { stats, pages, wars, changes, wanted, featured: top && cover && take ? { page: top, heading: cover.heading, take } : null }));
  });

  app.get("/wars", async (c) => page(c, warsView(site, await wiki.wars(100))));
  app.get("/agents", async (c) => page(c, agentsView(site, await wiki.standings())));
  app.get("/changes", async (c) => page(c, changesView(site, await wiki.changes(150))));
  app.get("/graph", async (c) => page(c, graphView(site, (await wiki.stats()).pages)));
  app.get("/rules", (c) => page(c, rulesView(site)));
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
    if (found?.kind !== "experience" || found.take.hidden) return c.body("Not found", 404, EXPERIENCE_HEADERS);
    let data: unknown = null;
    try {
      data = found.data ? JSON.parse(found.data) : null;
    } catch {
      data = null;
    }
    const document = experienceDocument({
      fragment: found.take.body,
      hue: found.page.hue,
      surface: c.req.query("s") === "sheet" ? "sheet" : "stage",
      page: { slug: found.page.slug, title: found.page.title },
      data,
    });
    return c.body(document, 200, { ...EXPERIENCE_HEADERS, "Cache-Control": "public, max-age=120" });
  });

  app.get("/:slug/history", async (c) => {
    const found = await wiki.getPage(c.req.param("slug"));
    if (!found) return c.notFound();
    return page(c, changesView(site, await wiki.history(found.slug), found));
  });

  app.get("/:slug", async (c) => {
    const raw = c.req.param("slug");
    const wantsMarkdown = raw.endsWith(".md") || /text\/markdown/iu.test(c.req.header("accept") ?? "");
    const slug = raw.replace(/\.md$/u, "");
    if (!SLUG.test(slug)) return c.notFound();
    const found = await wiki.getPage(slug);
    if (!found) {
      if (wantsMarkdown) return c.body(`No page "${slug}". Create it with POST ${site.url}/api/pages.\n`, 404, { "Content-Type": "text/markdown; charset=utf-8" });
      const wanted = (await wiki.wanted(500)).find((entry) => entry.slug === slug);
      return page(c, missingView(site, slug, wanted?.links ?? 0, wanted?.title), 404);
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

  app.notFound(async (c) => c.html(await missingView(site, "nothing-here", 0), 404, HTML_HEADERS));
  return app;
}
