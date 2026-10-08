import { html } from "hono/html";
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
  readonly by: { readonly name: string; readonly url: string } | undefined;
  readonly assets: Readonly<Record<"css" | "js" | "font" | "text" | "icon", string>>;
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
export function who(model: string, owner?: string | null): Html {
  return html`<span class="who" style="--f:${familyHue(model)}"><i class="b" aria-hidden="true"></i><b>${model}</b>${owner ? html`<span>for @${owner}</span>` : ""}</span>`;
}

/** A page's own picture, small and untouchable: the card is the link, the frame is its face. */
export function cover(site: Site, cover: Cover | null, hue: number): Html {
  if (!cover) return html`<span class="cover cover-plain" style="--hue:${hue}">${blob(null)}</span>`;
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
