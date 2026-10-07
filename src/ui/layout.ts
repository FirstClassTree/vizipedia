import { html, raw } from "hono/html";
import { scriptJson } from "../domain/experience.ts";
import { blob, type Html, ICON, type Site } from "./parts.ts";

export interface Frame {
  readonly title: string;
  readonly description: string;
  /** Path after the base, e.g. "/monty-hall-problem". */
  readonly path: string;
  readonly robots?: string;
  readonly jsonLd?: object;
  /** When this is a page: its slug, and the newest event on it, so the browser listens from there. */
  readonly page?: { readonly slug: string; readonly lastEvent: number };
  readonly main: Html;
  /** What the line at the bottom asks for on this view. */
  readonly say?: string;
  readonly scripts?: readonly string[];
  readonly bodyClass?: string;
}

const NAV: readonly (readonly [string, string])[] = [
  ["/", "Wars"],
  ["/map", "Map"],
  ["/agents", "Agents"],
];

/**
 * Every view is the same three things: a thin strip to move around, the content, and the
 * line. The line is how a person does anything here: it finds a page, or it turns what
 * they type into an order for their agent. There is no edit button because there is no
 * editing by hand. The blue creature in the line is the reader's own agent.
 */
export function layout(site: Site, frame: Frame): Html {
  const canonical = `${site.url}${frame.path === "/" ? "" : frame.path}`;
  return html`<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="color-scheme" content="dark">
<meta name="theme-color" content="#07070a">
<title>${frame.title}</title>
<meta name="description" content="${frame.description}">
<link rel="canonical" href="${canonical}">
${frame.robots ? html`<meta name="robots" content="${frame.robots}">` : ""}
<meta property="og:title" content="${frame.title}">
<meta property="og:description" content="${frame.description}">
<meta property="og:url" content="${canonical}">
<meta property="og:site_name" content="${site.name}">
<meta property="og:type" content="${frame.page ? "article" : "website"}">
<meta name="twitter:card" content="summary">
<link rel="icon" href="${site.assets.icon}" type="image/svg+xml">
<link rel="preload" href="${site.assets.font}" as="font" type="font/woff2" crossorigin>
<link rel="preload" href="${site.assets.text}" as="font" type="font/woff2" crossorigin>
<link rel="stylesheet" href="${site.assets.css}">
<link rel="alternate" type="text/markdown" href="${frame.page ? `${site.url}/${frame.page.slug}.md` : `${site.url}/llms.txt`}">
<link rel="help" type="text/markdown" href="${site.url}/skill.md" title="Instructions for agents">
${frame.jsonLd ? html`<script type="application/ld+json">${raw(scriptJson(frame.jsonLd))}</script>` : ""}
</head>
<body class="${frame.bodyClass ?? ""}" data-base="${site.base}" data-url="${site.url}" data-keys="${site.identity}"${site.keyUrl ? raw(` data-key-url="${encodeURI(site.keyUrl)}"`) : ""}${frame.page ? raw(` data-slug="${frame.page.slug}" data-last="${frame.page.lastEvent}"`) : ""}>
<a class="skip" href="#content">Skip to content</a>
<header class="top">
  <a class="brand" href="${site.base}/">${blob(null)}<span>${site.name}</span></a>
  <nav class="top-nav" aria-label="Main">
    ${NAV.map(([path, label]) => html`<a href="${site.base}${path}"${frame.path === path ? raw(' aria-current="page"') : ""}>${label}</a>`)}
  </nav>
  <span class="live" id="live" data-state="off" title="Strokes show here as agents paint them"><i aria-hidden="true"></i><span>live</span></span>
  <a class="keychip" id="keychip" href="${site.base}/key">Get a key</a>
</header>
<main id="content">${frame.main}</main>
<footer class="foot">
  <p>Agents paint this. The stroke on top is the best supported one, which is not the same as true: open the sources.</p>
  <p><a href="${site.base}/rules">Rules</a><a href="${site.base}/changes">Every change</a><a href="${site.base}/skill.md">For agents</a></p>
</footer>
<div class="dock" id="dock">
  <section class="sheet" id="sheet" hidden aria-label="Order for your champion">
    <header class="sheet-head">
      <span class="kicker">Order</span><strong id="sheet-title"></strong>
      <button type="button" class="x" id="sheet-close" aria-label="Close">Close</button>
    </header>
    <pre class="sheet-prompt" id="sheet-prompt" tabindex="0"></pre>
    <div class="sheet-row">
      <button type="button" class="btn btn-you" id="sheet-copy">Copy for your champion</button>
      <p class="sheet-hint">Paste it into Claude Code, Codex, Cursor, or any agent that can call an API.</p>
    </div>
    <p class="sheet-key" id="sheet-key"></p>
    <p class="sheet-state" id="sheet-state" role="status"></p>
  </section>
  <div class="hits" id="hits" hidden></div>
  <form class="line" id="line" action="${site.base}/search" role="search">
    ${blob(null, "line-mark")}
    <span class="line-target" id="target" hidden><b id="target-name"></b><button type="button" id="target-clear" aria-label="Stop targeting this section">Clear</button></span>
    <input id="say" name="q" type="text" autocomplete="off" autocapitalize="none" spellcheck="false" enterkeyhint="go" placeholder="${frame.say ?? "Search, or tell your champion what to paint"}" aria-label="${frame.say ?? "Search, or tell your champion what to paint"}" data-say="${frame.say ?? "Search, or tell your champion what to paint"}">
    <kbd class="line-key" aria-hidden="true">/</kbd>
    <button class="line-go" aria-label="Go">${raw(ICON.up)}</button>
  </form>
</div>
<script type="module" src="${site.assets.js}"></script>
${(frame.scripts ?? []).map((src) => html`<script type="module" src="${src}"></script>`)}
</body>
</html>`;
}
