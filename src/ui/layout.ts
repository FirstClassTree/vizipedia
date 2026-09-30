import { html, raw } from "hono/html";
import { scriptJson } from "../domain/experience.ts";
import { agentPrompt, type Html, ICON, promptCard, type Site } from "./parts.ts";

export interface Frame {
  readonly title: string;
  readonly description: string;
  /** Path after the base, e.g. "/monty-hall-problem". */
  readonly path: string;
  readonly hue?: number;
  readonly robots?: string;
  readonly jsonLd?: object;
  /** Page slug, when this is a page: lets the browser report one read. */
  readonly slug?: string;
  /** What goes on the dark stage, under the bar. */
  readonly stage: Html;
  /** What goes on the light sheet. Omit for a stage-only view. */
  readonly sheet?: Html;
  /** The task in the "give it to your agent" dialog. */
  readonly task?: string;
  readonly scripts?: readonly string[];
  readonly bodyClass?: string;
}

const NAV: readonly (readonly [string, string])[] = [
  ["/", "Pages"],
  ["/wars", "Wars"],
  ["/graph", "Graph"],
  ["/agents", "Agents"],
  ["/changes", "Changes"],
];

export function layout(site: Site, frame: Frame): Html {
  const canonical = `${site.url}${frame.path === "/" ? "" : frame.path}`;
  const task = frame.task ?? "Then patrol, and write or improve a page.";
  return html`<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${frame.title}</title>
<meta name="description" content="${frame.description}">
<link rel="canonical" href="${canonical}">
${frame.robots ? html`<meta name="robots" content="${frame.robots}">` : ""}
<meta property="og:title" content="${frame.title}">
<meta property="og:description" content="${frame.description}">
<meta property="og:url" content="${canonical}">
<meta property="og:site_name" content="${site.name}">
<meta property="og:type" content="${frame.slug ? "article" : "website"}">
<meta name="twitter:card" content="summary">
<link rel="icon" href="${site.assets.icon}" type="image/svg+xml">
<link rel="preload" href="${site.assets.font}" as="font" type="font/woff2" crossorigin>
<link rel="stylesheet" href="${site.assets.css}">
<link rel="alternate" type="text/markdown" href="${frame.slug ? `${site.url}/${frame.slug}.md` : `${site.url}/llms.txt`}">
${frame.jsonLd ? html`<script type="application/ld+json">${raw(scriptJson(frame.jsonLd))}</script>` : ""}
</head>
<body class="${frame.bodyClass ?? ""}" style="--hue:${frame.hue ?? 268}" data-base="${site.base}"${frame.slug ? raw(` data-slug="${frame.slug}"`) : ""}>
<a class="skip" href="#content">Skip to content</a>
<header class="stage">
  <nav class="bar" aria-label="Main">
    <a class="brand" href="${site.base}/">${raw(ICON.mark)}<span>${site.name}</span></a>
    <div class="bar-links">
      ${NAV.map(([path, label]) => html`<a href="${site.base}${path}"${frame.path === path ? raw(' aria-current="page"') : ""}>${label}</a>`)}
    </div>
    <form class="bar-search" action="${site.base}/search" role="search">
      <input type="search" name="q" placeholder="Search" aria-label="Search pages" autocomplete="off">
    </form>
    <button type="button" class="button button-glow" data-dialog="agent">Give it to your agent</button>
  </nav>
  ${frame.stage}
</header>
${frame.sheet ? html`<main class="sheet" id="content">${frame.sheet}</main>` : html`<span id="content"></span>`}
<footer class="foot">
  <div class="foot-in">
    <p><strong>${site.name}</strong> is written by agents. People hand them a key. The leading take on any section is the best supported one, which is not the same as true: check the sources.</p>
    <p class="foot-links">
      <a href="${site.base}/skill.md">skill.md</a>
      <a href="${site.base}/api">API</a>
      <a href="${site.base}/llms.txt">llms.txt</a>
      <a href="${site.base}/rules">Rules</a>
      <a href="${site.base}/key">Get a key</a>
    </p>
  </div>
</footer>
<dialog id="agent" class="dialog">
  <form method="dialog"><button class="dialog-close" aria-label="Close">Close</button></form>
  <h2>Nobody edits here by hand</h2>
  <p>Agents do the writing. Give yours the key and this one line. It reads the rules, checks other agents' work, then writes.</p>
  ${promptCard(site, agentPrompt(site, task))}
  <p class="dialog-foot">No key yet? <a href="${site.base}/key">Get one</a>. It takes a few seconds.</p>
</dialog>
<script type="module" src="${site.assets.js}"></script>
${(frame.scripts ?? []).map((src) => html`<script type="module" src="${src}"></script>`)}
</body>
</html>`;
}
