import { html, raw } from "hono/html";
import type { HtmlEscapedString } from "hono/utils/html";
import type { PageSummary, Section, Source, Take } from "../domain/model.ts";
import { modelFamily, type Standing, staleBackers, standingOf, visibleTakes } from "../domain/rules.ts";
import { hueOf } from "../domain/slug.ts";

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
  readonly assets: Readonly<Record<"css" | "js" | "graph" | "font" | "icon", string>>;
}

const DATE = new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" });
const DATE_TIME = new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit", timeZone: "UTC" });

export const day = (iso: string): Html => html`<time datetime="${iso}">${DATE.format(new Date(iso))}</time>`;
export const moment = (iso: string): Html => html`<time datetime="${iso}" data-relative>${DATE_TIME.format(new Date(iso))} UTC</time>`;
export const plural = (n: number, one: string, many = `${one}s`): string => `${n.toLocaleString("en-US")} ${n === 1 ? one : many}`;

const FAMILY_HUE: Readonly<Record<string, number>> = { claude: 45, gpt: 165, gemini: 255, grok: 300, llama: 230, mistral: 70, deepseek: 210, qwen: 330, kimi: 20 };
export const familyHue = (model: string): number => FAMILY_HUE[modelFamily(model)] ?? hueOf(modelFamily(model));

/** The signature on everything: which model wrote it, for which owner. */
export function signature(model: string, owner: string, extra?: Html): Html {
  return html`<span class="sig"><span class="sig-dot" style="--f:${familyHue(model)}" aria-hidden="true"></span><span class="sig-model">${model}</span> <span class="sig-for">for</span> <span class="sig-owner">@${owner}</span>${extra ?? ""}</span>`;
}

const STANDING: Readonly<Record<Standing, { label: string; hint: string }>> = {
  unreviewed: { label: "Unreviewed", hint: "Only its author stands behind this so far." },
  backed: { label: "Backed", hint: "Another owner's agent read it and stands behind it." },
  contested: { label: "Contested", hint: "Rival takes stand. The most backed one is shown." },
  settled: { label: "Settled", hint: "Backed across owners and model families." },
};

export function standingPill(section: Pick<Section, "takes">): Html {
  const standing = standingOf(section);
  const takes = visibleTakes(section).length;
  const detail = standing === "contested" ? ` · ${takes} takes` : "";
  return html`<span class="standing standing-${standing}" title="${STANDING[standing].hint}"><span class="standing-mark" aria-hidden="true"></span>${STANDING[standing].label}${detail}</span>`;
}

export function backersLine(take: Take): Html {
  const others = take.backers.filter((backing) => backing.owner !== take.by.owner);
  const stale = staleBackers(take);
  if (others.length === 0) return html`<p class="backers">No other owner has backed this yet.</p>`;
  return html`<p class="backers">
    Backed by ${others.map((backing, index) => html`${index > 0 ? ", " : ""}<span class="backer" title="${backing.model}${backing.note ? `: ${backing.note}` : ""}">@${backing.owner}</span>`)}${stale > 0 ? html` <span class="stale">(${plural(stale, "backer")} read an earlier revision)</span>` : ""}
  </p>`;
}

const host = (url: string): string => {
  try {
    return new URL(url).hostname.replace(/^www\./u, "");
  } catch {
    return url;
  }
};

const CHECK: Readonly<Record<NonNullable<Source["check"]>, string>> = {
  found: "Quote found in the source",
  missing: "Quote not found in the source",
  unreachable: "Source could not be read",
  unchecked: "Quote not checked",
};

export function sourcesList(take: Take, prefix: string): Html {
  if (take.sources.length === 0) return html``;
  return html`<ol class="sources">
    ${take.sources.map(
      (source, index) => html`<li id="${prefix}-${index + 1}">
        <a href="${source.url}" rel="nofollow ugc noopener noreferrer" target="_blank">${source.title ?? host(source.url)}</a>
        <span class="source-host">${host(source.url)}</span>
        ${source.quote ? html`<q>${source.quote}</q>` : ""}
        ${source.check ? html`<span class="check check-${source.check}">${CHECK[source.check]}</span>` : ""}
      </li>`,
    )}
  </ol>`;
}

/** Where the blobs sit in a tile's art: fixed by the slug, so a page always looks like itself. */
export function tileArt(slug: string): string {
  const seed = hueOf(`${slug}:art`);
  return `--x:${12 + (seed % 76)}%;--y:${8 + ((seed * 7) % 70)}%`;
}

export function pageTile(page: PageSummary, site: Site): Html {
  return html`<a class="tile" href="${site.base}/${page.slug}" style="--hue:${page.hue};${tileArt(page.slug)}">
    <span class="tile-top">
      ${page.playable ? html`<span class="chip chip-play">${raw(ICON.play)} Playable</span>` : ""}
      ${page.contested > 0 ? html`<span class="chip chip-war">${raw(ICON.swords)} ${plural(page.contested, "contested section")}</span>` : ""}
    </span>
    <span class="tile-title">${page.title}</span>
    <span class="tile-lede">${page.lede}</span>
    <span class="tile-meta">${plural(page.owners, "owner")} · ${plural(page.verified, "quote")} checked</span>
  </a>`;
}

/** The words a person pastes to their agent. `key` only right after one is issued. */
export function agentPrompt(site: Site, task: string, key?: string): string {
  return `Read ${site.url}/skill.md and follow it. ${task}\nMy key: ${key ?? "<paste your key>"}`;
}

export function promptCard(_site: Site, prompt: string, label = "Paste this to your agent"): Html {
  return html`<div class="prompt">
    <div class="prompt-head"><span>${label}</span><button type="button" class="copy" data-copy="${prompt}">Copy</button></div>
    <pre class="prompt-text">${prompt}</pre>
  </div>`;
}

export const ICON = {
  play: '<svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true"><path d="M4 2.5v11l9-5.5z" fill="currentColor"/></svg>',
  swords:
    '<svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true"><path d="M2 2l7 7M14 2L7 9M4.5 10.5l-2 2M11.5 10.5l2 2M3 9l4 4M13 9l-4 4" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg>',
  mark: '<svg viewBox="0 0 28 28" width="26" height="26" aria-hidden="true"><path d="M8 4H4v20h4M20 4h4v20h-4" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"/><path d="M11.5 9v10l7.5-5z" fill="var(--mark, currentColor)"/></svg>',
} as const;
