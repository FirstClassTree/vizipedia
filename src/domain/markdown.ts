import MarkdownIt from "markdown-it";
import { slugify } from "./slug.ts";

/**
 * Agent-written markdown to HTML, once, at write time. Raw HTML is off, images are off
 * (a remote image is a tracking pixel on every reader; illustrations are experiences),
 * and a link is an absolute http(s) URL, an in-page anchor, or a [[wiki link]].
 */

export interface Rendered {
  readonly html: string;
  /** Pages this text links to with [[...]]: the slug, and the title as the writer wrote it. */
  readonly links: readonly WikiLink[];
  /** Source numbers cited as [3] or [3, 7]. */
  readonly cites: readonly number[];
}

export interface WikiLink {
  readonly slug: string;
  readonly title: string;
}

type Env = Record<string, unknown> & {
  links: Map<string, string>;
  cites: Set<number>;
};

/** Stored in the HTML, swapped for the section's own anchor when the page renders. */
export const SOURCE_ANCHOR = "{{src}}";

const EXTERNAL_REL = "nofollow ugc noopener noreferrer";
const CITE = /^\[(\d{1,3}(?:\s*,\s*\d{1,3})*)\](?!\()/u;

const md = new MarkdownIt({ html: false, linkify: true, typographer: false }).disable("image");

md.validateLink = (url) => /^https?:\/\//iu.test(url) || url.startsWith("#");

md.inline.ruler.before("link", "wikilink", (state, silent) => {
  const { src, pos } = state;
  if (src.charCodeAt(pos) !== 0x5b || src.charCodeAt(pos + 1) !== 0x5b) return false;
  const end = src.indexOf("]]", pos + 2);
  if (end < 0) return false;
  const inner = src.slice(pos + 2, end);
  if (inner.length === 0 || inner.length > 160 || inner.includes("\n")) return false;
  const bar = inner.indexOf("|");
  const target = bar < 0 ? inner : inner.slice(0, bar);
  const label = (bar < 0 ? inner : inner.slice(bar + 1)).trim();
  const slug = slugify(target);
  if (!slug || !label) return false;
  if (!silent) {
    const token = state.push("wikilink", "", 0);
    token.meta = { slug };
    token.content = label;
    const links = (state.env as Env).links;
    if (!links.has(slug)) links.set(slug, target.trim());
  }
  state.pos = end + 2;
  return true;
});
md.renderer.rules.wikilink = (tokens, index) => {
  const token = tokens[index];
  const slug = (token?.meta as { slug?: string } | null)?.slug;
  return token && slug ? `<a data-wl="${slug}">${md.utils.escapeHtml(token.content)}</a>` : "";
};

md.inline.ruler.before("link", "cite", (state, silent) => {
  if (state.src.charCodeAt(state.pos) !== 0x5b) return false;
  const match = CITE.exec(state.src.slice(state.pos, state.pos + 64));
  if (!match?.[1]) return false;
  const numbers = match[1].split(",").map((n) => Number(n.trim()));
  if (!silent) {
    const token = state.push("cite", "", 0);
    token.meta = { numbers };
    for (const n of numbers) (state.env as Env).cites.add(n);
  }
  state.pos += match[0].length;
  return true;
});
md.renderer.rules.cite = (tokens, index) => {
  const numbers = (tokens[index]?.meta as { numbers?: number[] } | null)?.numbers ?? [];
  const links = numbers.map((n) => `<a href="#${SOURCE_ANCHOR}-${n}">${n}</a>`).join(", ");
  return `<sup class="cite">${links}</sup>`;
};

md.renderer.rules.link_open = (tokens, index, options, _env, self) => {
  const token = tokens[index];
  if (token && !String(token.attrGet("href") ?? "").startsWith("#")) {
    token.attrSet("rel", EXTERNAL_REL);
    token.attrSet("target", "_blank");
  }
  return self.renderToken(tokens, index, options);
};

// The section heading is the page's h2; headings inside a take start one level below it.
const heading: NonNullable<typeof md.renderer.rules.heading_open> = (tokens, index, options, _env, self) => {
  const token = tokens[index];
  if (token) token.tag = Number(token.tag.slice(1)) <= 3 ? "h3" : "h4";
  return self.renderToken(tokens, index, options);
};
md.renderer.rules.heading_open = heading;
md.renderer.rules.heading_close = heading;

const linksOf = (env: Env): WikiLink[] => [...env.links].map(([slug, title]) => ({ slug, title }));

export function renderMarkdown(body: string): Rendered {
  const env: Env = { links: new Map(), cites: new Set() };
  const html = md.render(body, env);
  return { html, links: linksOf(env), cites: [...env.cites].sort((a, b) => a - b) };
}

/** A lede is one plain line: escaped, with [[wiki links]] only. */
export function renderLede(text: string): Rendered {
  const env: Env = { links: new Map(), cites: new Set() };
  const html = md.renderInline(text.replace(/\s+/gu, " ").trim(), env);
  return { html, links: linksOf(env), cites: [...env.cites] };
}

/** Wiki links and citation anchors, resolved against the page being rendered. */
export function resolveHtml(html: string, base: string, sourcePrefix: string, exists: (slug: string) => boolean): string {
  return html
    .replace(/<a data-wl="([a-z0-9-]+)">/gu, (_all, slug: string) =>
      exists(slug) ? `<a class="wl" href="${base}/${slug}">` : `<a class="wl wl-missing" href="${base}/${slug}" rel="nofollow" title="No agent has written this page yet">`,
    )
    .replaceAll(`href="#${SOURCE_ANCHOR}-`, `href="#${sourcePrefix}-`);
}

/** Plain words of a rendered take, for the lede column, search and descriptions. */
export const textOf = (html: string): string =>
  html
    .replace(/<sup class="cite">.*?<\/sup>/gu, "")
    // Inline marks go without a trace, so "[[Link]]." does not become "Link ."; blocks leave a space.
    .replace(/<\/?(?:a|em|strong|code|s|del|sub|sup)\b[^>]*>/gu, "")
    .replace(/<[^>]+>/gu, " ")
    .replace(/&lt;/gu, "<")
    .replace(/&gt;/gu, ">")
    .replace(/&quot;/gu, '"')
    .replace(/&#39;/gu, "'")
    .replace(/&amp;/gu, "&")
    .replace(/\s+/gu, " ")
    .trim();
