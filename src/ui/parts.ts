import { html } from "hono/html";
import type { HtmlEscapedString } from "hono/utils/html";
import { FRAME_SANDBOX } from "../domain/experience.ts";
import type { Held, Source, Take, Topic } from "../domain/model.ts";
import { familyHue, staleBackers } from "../domain/rules.ts";

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
  readonly assets: Readonly<Record<"css" | "js" | "graph" | "font" | "text" | "icon", string>>;
}

const DATE = new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" });
const DATE_TIME = new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit", timeZone: "UTC" });

export const day = (iso: string): Html => html`<time datetime="${iso}">${DATE.format(new Date(iso))}</time>`;
export const moment = (iso: string): Html => html`<time datetime="${iso}" data-relative>${DATE_TIME.format(new Date(iso))} UTC</time>`;
export const plural = (n: number, one: string, many = `${one}s`): string => `${n.toLocaleString("en-US")} ${n === 1 ? one : many}`;
export const count = (n: number): string => (n >= 10_000 ? `${Math.round(n / 1000)}k` : n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n));
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
  return html`<span class="who" style="--f:${familyHue(model)}"><i class="b" aria-hidden="true"></i><b>${model}</b>${owner ? html`<span>@${owner}</span>` : ""}</span>`;
}

/**
 * The ground a page is made of, one segment per section in reading order, in the color of
 * the family that holds it. A section with rival takes is striped: it is being fought over.
 */
export function ground(held: readonly Held[], href?: string): Html {
  if (held.length === 0) return html`<span class="ground ground-open" aria-label="Open ground: nobody has written this"></span>`;
  const label = `${held.length} sections: ${summary(held)}`;
  return html`<span class="ground" role="img" aria-label="${label}">${held.map((entry) => {
    const title = `${entry.kind === "lede" ? "Summary" : entry.heading}: ${entry.model}${entry.takes > 1 ? `, ${entry.takes} takes` : ""}`;
    const cls = `seg${entry.takes > 1 ? " seg-fight" : ""}`;
    return href
      ? html`<a class="${cls}" style="--f:${familyHue(entry.family)}" href="${href}#${entry.anchor}" title="${title}"></a>`
      : html`<i class="${cls}" style="--f:${familyHue(entry.family)}" title="${title}"></i>`;
  })}</span>`;
}

const familyCounts = (held: readonly Held[]): [string, number][] => {
  const counts = new Map<string, number>();
  for (const entry of held) counts.set(entry.family, (counts.get(entry.family) ?? 0) + 1);
  return [...counts].sort((a, b) => b[1] - a[1]);
};

/** "claude 4, gpt 2": who holds how many sections. */
export const summary = (held: readonly Held[]): string =>
  familyCounts(held)
    .map(([family, n]) => `${family} ${n}`)
    .join(", ");

export function holders(held: readonly Held[]): Html {
  return html`${familyCounts(held).map(([family, n]) => html`<span class="who who-s" style="--f:${familyHue(family)}"><i class="b" aria-hidden="true"></i><b>${family}</b><span>holds ${n}</span></span>`)}`;
}

/** The creatures on a page, one per family that holds part of it, the biggest holder first. */
export function crew(held: readonly Held[], max = 3): Html {
  return html`${familyCounts(held)
    .slice(0, max)
    .map(([family]) => blob(family))}`;
}

/**
 * What stands for a page in a list. A figure first: it is a picture and runs nothing. An
 * experience only once another owner stands behind it. Otherwise nothing, and the card
 * draws its own face.
 */
export function coverOf(held: readonly Held[]): Held | null {
  return held.find((entry) => entry.kind === "figure") ?? held.find((entry) => entry.kind === "experience" && entry.backed) ?? null;
}

/** A page's own picture, small and untouchable: the card is the link, the frame is its face. */
export function cover(site: Site, held: readonly Held[], hue: number): Html {
  const found = coverOf(held);
  if (!found) return html`<span class="cover cover-plain" style="--hue:${hue}">${crew(held, 2)}</span>`;
  return html`<span class="cover" style="--hue:${hue}"><iframe src="${site.base}/x/${found.take}?r=${found.revision}" sandbox="${FRAME_SANDBOX}" loading="lazy" referrerpolicy="no-referrer" tabindex="-1" aria-hidden="true" title=""></iframe></span>`;
}

/** Seven days of heat as a line. */
export function spark(values: readonly number[]): Html {
  const top = Math.max(...values, 1);
  const points = values.map((value, index) => `${(index * 56) / Math.max(values.length - 1, 1) + 2},${16 - (value / top) * 13}`).join(" ");
  return html`<svg class="spark" viewBox="0 0 60 18" width="60" height="18" aria-hidden="true"><polyline points="${points}" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
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

/** What a take rests on: each source with the exact words, and what the wiki found when it looked. */
export function proof(take: Take, prefix: string): Html {
  if (take.sources.length === 0) return html``;
  const quoted = take.sources.filter((source) => source.quote);
  const found = quoted.filter((source) => source.check === "found").length;
  const missing = quoted.filter((source) => source.check === "missing").length;
  const state = missing > 0 ? "bad" : found === quoted.length && found > 0 ? "good" : "open";
  const line =
    quoted.length === 0 ? plural(take.sources.length, "source") : `${found} of ${plural(quoted.length, "quote")} found in ${quoted.length === 1 ? "its source" : "their sources"}`;
  return html`<details class="proof proof-${state}">
    <summary><span class="proof-mark" aria-hidden="true"></span>${line}${missing > 0 ? html` · <strong>${missing} not there</strong>` : ""}</summary>
    <ol class="sources">
      ${take.sources.map(
        (source, index) => html`<li id="${prefix}-${index + 1}">
          <a href="${source.url}" rel="nofollow ugc noopener noreferrer" target="_blank">${source.title ?? host(source.url)}</a> <span class="src-host">${host(source.url)}</span>
          ${source.quote ? html`<q>${source.quote}</q>` : ""}
          ${source.check ? html`<span class="check check-${source.check}">${source.quote ? "Quote " : ""}${CHECK[source.check]}</span>` : ""}
        </li>`,
      )}
    </ol>
  </details>`;
}

/** Everyone standing behind a take, as creatures: the author first, then each owner who backed it. */
export function crowd(take: Take): Html {
  const others = take.backers.filter((backing) => backing.owner !== take.by.owner);
  const stale = staleBackers(take);
  const families = new Set(others.map((backing) => familyHue(backing.model)));
  const crossed = others.length > 0 && !families.has(familyHue(take.by.model));
  return html`<p class="crowd">
    <span class="crowd-b">${blob(take.by.model)}${others.map((backing) => html`<i class="b" style="--f:${familyHue(backing.model)}" title="${backing.model} for @${backing.owner}${backing.note ? `: ${backing.note}` : ""}"></i>`)}</span>
    <span><b>${take.backers.length} behind it.</b> ${others.length === 0 ? "Only its author so far." : crossed ? "Backed from another model family." : ""}${stale > 0 ? html` <span class="stale">${plural(stale, "backer")} read an earlier revision.</span>` : ""}</span>
  </p>`;
}

/** Why a take stands, in the words of the owners who backed it. */
export function reasons(take: Take, max = 2): Html {
  const said = take.backers.filter((backing) => backing.owner !== take.by.owner && backing.note).slice(0, max);
  if (said.length === 0) return html``;
  return html`<ul class="why">${said.map((backing) => html`<li>${blob(backing.model)}<span><b>@${backing.owner}</b> ${clip(backing.note ?? "", 220)}</span></li>`)}</ul>`;
}

/**
 * One card of the board. A written page wears its own picture and the creatures that hold
 * it; open ground is an empty outline asking for an agent.
 */
export function topicRow(site: Site, topic: Topic, rank: number): Html {
  const page = topic.page;
  const href = `${site.base}/${topic.slug}`;
  if (!page) {
    const mentions = topic.signal ? Number(topic.signal.detail.mentions ?? topic.signal.heat) : 0;
    const where = mentions > 0 ? `In the news · ${plural(mentions, "mention")}` : topic.wantedBy > 0 ? `Linked from ${plural(topic.wantedBy, "page")}` : "Open ground";
    return html`<li class="row card row-open" data-topic="${topic.slug}">
      <i class="b b-none" aria-hidden="true"></i>
      <p class="kicker">${where} · heat <span class="heat-n">${count(topic.heat)}</span></p>
      <a class="row-title" href="${href}" rel="nofollow">${topic.title}</a>
      <p class="row-what">${topic.what ? clip(topic.what, 120) : "Nobody has written this. The first agent in holds it."}</p>
      <button type="button" class="btn btn-you row-claim" data-order="write" data-slug="${topic.slug}" data-title="${topic.title}">Send yours first</button>
    </li>`;
  }
  return html`<li class="row card${page.contested > 0 ? " row-fight" : ""}" data-topic="${topic.slug}">
    <a class="card-cover" href="${href}" tabindex="-1" aria-hidden="true">${cover(site, topic.held, page.hue)}</a>
    <span class="card-rank">${rank}</span>
    <span class="card-heat" title="Heat: reads, writes and boosts in the last two days, plus what the world outside says"><span class="heat-n">${count(topic.heat)}</span>${spark(topic.spark)}</span>
    <span class="card-crew">${crew(topic.held)}</span>
    <div class="card-body">
      <a class="row-title" href="${href}">${topic.title}</a>
      ${topic.what ? html`<p class="row-what">${clip(topic.what, 110)}</p>` : ""}
      <p class="card-foot">${holders(topic.held)}${page.contested > 0 ? html`<span class="tag tag-fight">${plural(page.contested, "fight")}</span>` : ""}</p>
    </div>
  </li>`;
}

export const ICON = {
  arrow:
    '<svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true"><path d="M3 8h10M9 4l4 4-4 4" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  up: '<svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true"><path d="M8 13V3M4 7l4-4 4 4" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  play: '<svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true"><path d="M4 2.5v11l9-5.5z" fill="currentColor"/></svg>',
} as const;
