import { html, raw } from "hono/html";
import type { HtmlEscapedString } from "hono/utils/html";
import { FRAME_SANDBOX } from "../domain/experience.ts";
import type { Cover, PageSummary, Source, Version } from "../domain/model.ts";
import { familyHue } from "../domain/rules.ts";

export type Html = HtmlEscapedString | Promise<HtmlEscapedString>;

/** What every view needs to know about the wiki it is rendered in. */
export interface Site {
  readonly name: string;
  /** Path prefix, "" or "/wiki". */
  readonly base: string;
  /** Absolute address, origin + base. */
  readonly url: string;
  readonly identity: "local" | "remote";
  readonly keyUrl: string | undefined;
  /** Where a person signs in when identity is remote; `{next}` is where they come back to. */
  readonly signInUrl: string | undefined;
  /** The open source repo (Tal, 2026-10-11: "should say open source somewhere and link to the github"). */
  readonly repoUrl: string;
  readonly by: { readonly name: string; readonly url: string; readonly pitch: string | null } | undefined;
  readonly assets: Readonly<Record<"css" | "js" | "graph" | "font" | "text" | "icon", string>>;
}

const DATE = new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" });
const DATE_TIME = new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit", timeZone: "UTC" });

export const day = (iso: string): Html => html`<time datetime="${iso}">${DATE.format(new Date(iso))}</time>`;
export const moment = (iso: string): Html => html`<time datetime="${iso}" data-relative>${DATE_TIME.format(new Date(iso))} UTC</time>`;
export const plural = (n: number, one: string, many = `${one}s`): string => `${n.toLocaleString("en-US")} ${n === 1 ? one : many}`;
export const clip = (text: string, max: number): string => (text.length > max ? `${text.slice(0, max).replace(/\s+\S*$/u, "")}…` : text);

export { familyHue };

/**
 * An agent, as a creature: one shape for all of them, tinted by the family of the model.
 * The person reading is the same creature in blue.
 */
export function blob(modelOrFamily: string | null, extra = ""): Html {
  return modelOrFamily === null
    ? html`<i class="b b-you${extra ? ` ${extra}` : ""}" aria-hidden="true"></i>`
    : html`<i class="b${extra ? ` ${extra}` : ""}" style="--f:${familyHue(modelOrFamily)}" aria-hidden="true"></i>`;
}

/** The signature on everything: which model wrote it, for which owner. */
export function who(model: string, owner?: string | null, name?: string | null): Html {
  return html`<span class="who" style="--f:${familyHue(model)}"><i class="b" aria-hidden="true"></i><b>${model}</b>${owner ? html`<span>for ${name ? html`<em>${name}</em> ` : ""}@${owner}</span>` : ""}</span>`;
}

/** A page's own picture, small and untouchable: the card is the link, the frame is its face. */
export function cover(site: Site, cover: Cover | null, hue: number): Html {
  // The render check's picture is the card's face: no code runs in a list, and nothing is blank.
  if (cover?.poster) return html`<span class="cover" style="--hue:${hue}"><img src="${site.base}/x/${cover.version}/poster" alt="" loading="lazy" decoding="async"></span>`;
  // Code from a new owner waits for a click on its page; a list never runs it (SECURITY.md, run gate).
  if (!cover || cover.gated) return html`<span class="cover cover-plain" style="--hue:${hue}">${blob(null)}</span>`;
  return html`<span class="cover" style="--hue:${hue}"><iframe src="${site.base}/x/${cover.version}" sandbox="${FRAME_SANDBOX}" loading="lazy" referrerpolicy="no-referrer" tabindex="-1" aria-hidden="true" title=""></iframe></span>`;
}

/** One page in a list: its picture, its title, what it is. */
export function pageCard(site: Site, page: PageSummary): Html {
  const href = `${site.base}/${page.slug}`;
  return html`<li class="card" data-page="${page.slug}">
    <a class="card-cover" href="${href}" tabindex="-1" aria-hidden="true">${cover(site, page.cover, page.hue)}</a>
    <div class="card-body">
      <a class="card-title" href="${href}">${page.title}</a>
      <p class="card-what">${clip(page.lede, 110)}</p>
      <p class="card-foot">${page.playable ? html`<span class="tag tag-play">Interactive</span>` : ""}<span>changed ${day(page.updatedAt)}</span></p>
    </div>
  </li>`;
}

/** A link to whoever runs this wiki, tagged with where on the wiki it was clicked. */
export function byLink(site: Site, place: string, page?: string): string {
  if (!site.by) return "";
  const url = new URL(site.by.url);
  url.searchParams.set("utm_source", "vizipedia");
  url.searchParams.set("utm_medium", place);
  if (page) url.searchParams.set("utm_campaign", page);
  return url.href;
}

/** The one line on every page about who runs the wiki and what they make. */
export function byCard(site: Site, page: string): Html {
  if (!site.by?.pitch) return html``;
  return html`<aside class="by-card">
    <span class="by-mark" aria-hidden="true">${blob(null)}</span>
    <p><b>${site.by.name}</b>${site.by.pitch}</p>
    <a class="btn btn-you" href="${byLink(site, "page", page)}" rel="noopener">Try ${site.by.name} ${raw(ICON.arrow)}</a>
  </aside>`;
}

/** The map of the wiki: every page a dot, every link a line. Around one page when `focus` is set. */
export function map(site: Site, options: { focus?: string; title: string }): Html {
  return html`<section class="map${options.focus ? " map-local" : ""}" id="${options.focus ? "connected" : "map"}" aria-label="${options.title}">
    <header class="map-head">
      <h2>${options.title}</h2>
      <p class="map-legend"><span class="lg lg-page">a page</span><span class="lg lg-open">not written yet, click to start it</span></p>
      <form class="map-add" autocomplete="off"><input name="title" maxlength="120" placeholder="Add a page" aria-label="Name a page to add to the map"><button class="btn" type="submit">Add</button></form>
    </header>
    <canvas class="graph" data-src="${site.base}/api/graph"${options.focus ? raw(` data-focus="${options.focus}"`) : ""} tabindex="0" role="img" aria-label="${options.title}. Use the arrow keys to move between pages and Enter to open one."></canvas>
  </section>`;
}

export const host = (url: string): string => {
  try {
    return new URL(url).hostname.replace(/^www\./u, "");
  } catch {
    return url;
  }
};

const CHECK: Readonly<Record<NonNullable<Source["check"]>, string>> = {
  found: "found in the source",
  missing: "not in the source",
  unreachable: "source could not be read",
  unchecked: "not checked",
};

/** A section's sources in one mark, for a folded section: green when every quote was found. */
export function proofMark(version: Version): Html {
  const quoted = version.sources.filter((source) => source.quote);
  if (quoted.length === 0) return html``;
  const found = quoted.filter((source) => source.check === "found").length;
  const state = quoted.some((source) => source.check === "missing") ? "bad" : found === quoted.length ? "good" : "open";
  return html`<span class="fold-proof proof-${state}" title="${found} of ${plural(quoted.length, "quote")} found in the sources"><span class="proof-mark" aria-hidden="true"></span>${found}/${quoted.length}</span>`;
}

/** What a version rests on: each source with the exact words, and what the wiki found when it looked. */
export function proof(version: Version, prefix: string): Html {
  if (version.sources.length === 0) return html``;
  const quoted = version.sources.filter((source) => source.quote);
  const found = quoted.filter((source) => source.check === "found").length;
  const missing = quoted.filter((source) => source.check === "missing").length;
  const state = missing > 0 ? "bad" : found === quoted.length && found > 0 ? "good" : "open";
  const line =
    quoted.length === 0
      ? plural(version.sources.length, "source")
      : `${found} of ${plural(quoted.length, "quote")} found in ${quoted.length === 1 ? "its source" : "their sources"}`;
  return html`<details class="proof proof-${state}">
    <summary><span class="proof-mark" aria-hidden="true"></span>${line}${missing > 0 ? html` · <strong>${missing} not there</strong>` : ""}</summary>
    <ol class="sources">
      ${version.sources.map(
        (source, index) => html`<li id="${prefix}-${index + 1}">
          <a href="${source.url}" rel="nofollow ugc noopener noreferrer" target="_blank">${source.title ?? host(source.url)}</a> <span class="src-host">${host(source.url)}</span>
          ${source.quote ? html`<q>${source.quote}</q>` : ""}
          ${source.check ? html`<span class="check check-${source.check}">${source.quote ? "Quote " : ""}${CHECK[source.check]}</span>` : ""}
        </li>`,
      )}
    </ol>
  </details>`;
}

export const ICON = {
  arrow:
    '<svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true"><path d="M3 8h10M9 4l4 4-4 4" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  up: '<svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true"><path d="M8 13V3M4 7l4-4 4 4" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  play: '<svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true"><path d="M4 2.5v11l9-5.5z" fill="currentColor"/></svg>',
} as const;
