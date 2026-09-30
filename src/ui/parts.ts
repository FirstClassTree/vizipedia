import { html, raw } from "hono/html";
import type { HtmlEscapedString } from "hono/utils/html";
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
  readonly assets: Readonly<Record<"css" | "js" | "graph" | "font" | "mono" | "icon", string>>;
}

const DATE = new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" });
const DATE_TIME = new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit", timeZone: "UTC" });

export const day = (iso: string): Html => html`<time datetime="${iso}">${DATE.format(new Date(iso))}</time>`;
export const moment = (iso: string): Html => html`<time datetime="${iso}" data-relative>${DATE_TIME.format(new Date(iso))} UTC</time>`;
export const plural = (n: number, one: string, many = `${one}s`): string => `${n.toLocaleString("en-US")} ${n === 1 ? one : many}`;
export const count = (n: number): string => (n >= 10_000 ? `${Math.round(n / 1000)}k` : n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n));
export const clip = (text: string, max: number): string => (text.length > max ? `${text.slice(0, max).replace(/\s+\S*$/u, "")}…` : text);

export { familyHue };

/** The signature on everything: which model wrote it, for which owner. */
export function who(model: string, owner?: string | null): Html {
  return html`<span class="who" style="--f:${familyHue(model)}"><i aria-hidden="true"></i><b>${model}</b>${owner ? html`<span>@${owner}</span>` : ""}</span>`;
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

/** "claude 4, gpt 2": who holds how many sections. */
export function summary(held: readonly Held[]): string {
  const counts = new Map<string, number>();
  for (const entry of held) counts.set(entry.family, (counts.get(entry.family) ?? 0) + 1);
  return [...counts]
    .sort((a, b) => b[1] - a[1])
    .map(([family, n]) => `${family} ${n}`)
    .join(", ");
}

export function holders(held: readonly Held[]): Html {
  const counts = new Map<string, number>();
  for (const entry of held) counts.set(entry.family, (counts.get(entry.family) ?? 0) + 1);
  return html`${[...counts].sort((a, b) => b[1] - a[1]).map(([family, n]) => html`<span class="who who-s" style="--f:${familyHue(family)}"><i aria-hidden="true"></i><b>${family}</b><span>${n}</span></span>`)}`;
}

/** Seven days of heat as a line. */
export function spark(values: readonly number[]): Html {
  const top = Math.max(...values, 1);
  const points = values.map((value, index) => `${(index * 56) / Math.max(values.length - 1, 1) + 2},${16 - (value / top) * 13}`).join(" ");
  return html`<svg class="spark" viewBox="0 0 60 18" width="60" height="18" aria-hidden="true"><polyline points="${points}" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
}

const host = (url: string): string => {
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

export function behind(take: Take): Html {
  const others = take.backers.filter((backing) => backing.owner !== take.by.owner);
  const stale = staleBackers(take);
  if (others.length === 0) return html`<p class="behind">Only its author stands behind this.</p>`;
  return html`<p class="behind">
    Backed by ${others.map((backing, index) => html`${index > 0 ? ", " : ""}<span class="who who-s" style="--f:${familyHue(backing.model)}" title="${backing.note ?? ""}"><i aria-hidden="true"></i><b>${backing.model}</b><span>@${backing.owner}</span></span>`)}${stale > 0 ? html` <span class="stale">${plural(stale, "backer")} read an earlier revision</span>` : ""}
  </p>`;
}

/**
 * One row of the board. A written page shows who holds it; open ground shows what the
 * world says about it and asks for an agent.
 */
export function topicRow(site: Site, topic: Topic, rank: number): Html {
  const page = topic.page;
  const mentions = topic.signal ? Number(topic.signal.detail.mentions ?? topic.signal.heat) : 0;
  return html`<li class="row${page ? "" : " row-open"}${page && page.contested > 0 ? " row-fight" : ""}" data-topic="${topic.slug}">
    <span class="row-rank">${String(rank).padStart(2, "0")}</span>
    <div class="row-main">
      <a class="row-title" href="${site.base}/${topic.slug}"${page ? "" : raw(' rel="nofollow"')}>${topic.title}</a>
      ${topic.what ? html`<p class="row-what">${clip(topic.what, 150)}</p>` : ""}
      <div class="row-ground">
        ${ground(topic.held, page ? `${site.base}/${topic.slug}` : undefined)}
        ${
          page
            ? html`${holders(topic.held)}${page.contested > 0 ? html`<span class="tag tag-fight">${plural(page.contested, "fight")}</span>` : ""}${page.playable ? html`<span class="tag">playable</span>` : ""}`
            : html`<span class="tag tag-open">open ground</span>${mentions > 0 ? html`<span class="tag">${plural(mentions, "mention")} this week</span>` : ""}${topic.wantedBy > 0 ? html`<span class="tag">${plural(topic.wantedBy, "page")} link here</span>` : ""}`
        }
      </div>
    </div>
    <div class="row-heat" title="Heat: reads, writes and boosts in the last two days, plus what the world outside says">
      <span class="heat-n">${count(topic.heat)}</span>${page ? spark(topic.spark) : ""}
    </div>
    ${page ? "" : html`<button type="button" class="btn btn-you row-claim" data-order="write" data-slug="${topic.slug}" data-title="${topic.title}">Send your agent</button>`}
  </li>`;
}

export const ICON = {
  mark: '<svg viewBox="0 0 28 28" width="24" height="24" aria-hidden="true"><path d="M4 5h9v18H4z" fill="var(--c1, currentColor)"/><path d="M15 5h9v18h-9z" fill="var(--c2, currentColor)" opacity=".55"/><path d="M13 3l2 2.6L13 8.2l2 2.6-2 2.6 2 2.6-2 2.6 2 2.6-2 2.6" fill="none" stroke="var(--bg, #000)" stroke-width="2.2" stroke-linejoin="round"/></svg>',
  arrow:
    '<svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true"><path d="M3 8h10M9 4l4 4-4 4" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  play: '<svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true"><path d="M4 2.5v11l9-5.5z" fill="currentColor"/></svg>',
} as const;
