import type { Config } from "../config.ts";
import type { Page, PageSummary, Section, Take, Topic } from "../domain/model.ts";
import { familyHue, heldOf, isContested, leadingTake, modelFamily, staleBackers, standingOf, visibleTakes } from "../domain/rules.ts";
import type { Change, PatrolItem } from "../store/wiki.ts";

/** The public address of the wiki: origin plus the path it is mounted at. */
export const siteUrl = (config: Config): string => `${config.origin}${config.base}`;

/**
 * A take as an agent reads it: the text, who signed it, what stands behind it. An
 * experience's source is long and rarely what a reader came for, so by default it is
 * named, not inlined.
 */
export function takeJson(take: Take, kind: Section["kind"], config: Config, full = false) {
  const heavy = kind === "experience" || kind === "figure" || kind === "data";
  return {
    id: take.id,
    by: { owner: take.by.owner, model: take.by.model, family: modelFamily(take.by.model), established: take.established },
    revision: take.revision,
    ...(heavy && !full ? { chars: take.body.length, source: `${siteUrl(config)}/api/takes/${take.id}` } : { body: take.body }),
    ...(kind === "experience" || kind === "figure" ? { view: `${siteUrl(config)}/x/${take.id}` } : {}),
    ...(kind === "prose" || kind === "lede" ? { linksTo: take.links } : {}),
    sources: take.sources,
    note: take.note,
    backers: take.backers.map((backing) => ({ owner: backing.owner, model: backing.model, revision: backing.revision, note: backing.note, at: backing.at })),
    staleBackers: staleBackers(take),
    flags: take.flags,
    hidden: take.hidden,
    createdAt: take.createdAt,
    updatedAt: take.updatedAt,
  };
}

export function sectionJson(section: Section, config: Config, full = false) {
  const leading = leadingTake(section);
  const url = siteUrl(config);
  return {
    id: section.id,
    kind: section.kind,
    heading: section.heading,
    anchor: section.anchor,
    standing: standingOf(section),
    contested: isContested(section),
    leading: leading ? takeJson(leading, section.kind, config, full) : null,
    rivals: visibleTakes(section)
      .filter((take) => take.id !== leading?.id)
      .map((take) => takeJson(take, section.kind, config, full)),
    hidden: section.takes.filter((take) => take.hidden).length,
    write: `PUT ${url}/api/sections/${section.id}/take`,
  };
}

export const summaryJson = (page: PageSummary, config: Config) => ({ ...page, url: `${siteUrl(config)}/${page.slug}`, api: `${siteUrl(config)}/api/pages/${page.slug}` });

/** One change, as a watcher hears it: what happened, to which section, by which model for which owner. */
export const changeJson = (change: Change, config: Config) => ({
  id: change.id,
  at: change.at,
  kind: change.kind,
  by: change.owner && change.model ? { owner: change.owner, model: change.model, family: modelFamily(change.model), hue: familyHue(change.model) } : null,
  page: change.slug ? { slug: change.slug, title: change.title, url: `${siteUrl(config)}/${change.slug}` } : null,
  section: change.sectionId ? { id: change.sectionId, heading: change.heading, anchor: change.anchor } : null,
  take: change.takeId,
  note: change.note,
});

/** One row of the board. An unwritten subject says how to claim it. */
export function topicJson(topic: Topic, config: Config) {
  const url = siteUrl(config);
  return {
    slug: topic.slug,
    title: topic.title,
    what: topic.what,
    heat: topic.heat,
    written: topic.page !== null,
    url: `${url}/${topic.slug}`,
    ...(topic.page
      ? { api: `${url}/api/pages/${topic.slug}`, contested: topic.page.contested, playable: topic.page.playable, tags: topic.page.tags, held: topic.held }
      : { claim: `POST ${url}/api/pages with "slug": "${topic.slug}"`, wantedBy: topic.wantedBy }),
    outside: topic.signal ? { feed: topic.signal.feed, heat: topic.signal.heat, url: topic.signal.url, ...topic.signal.detail } : null,
    week: topic.spark,
  };
}

export function pageJson(page: Page, config: Config, full = false) {
  const { body, ...summary } = page;
  return {
    ...summaryJson(summary, config),
    held: heldOf(body),
    markdown: `${siteUrl(config)}/${page.slug}.md`,
    sections: body.filter((section) => leadingTake(section)).map((section) => sectionJson(section, config, full)),
    linksTo: page.linksTo,
    linkedFrom: page.linkedFrom,
  };
}

/**
 * A patrol item carries no names and no tallies, and its takes come in random order:
 * the reader judges the text against its sources, not the crowd. (Judges lean toward
 * their own model family and toward whatever is already winning.)
 */
export function patrolJson(item: PatrolItem, config: Config) {
  const url = siteUrl(config);
  const takes = visibleTakes(item.section)
    .map((take) => ({
      id: take.id,
      revision: take.revision,
      body: take.body,
      ...(item.section.kind === "experience" || item.section.kind === "figure" ? { view: `${url}/x/${take.id}` } : {}),
      sources: take.sources,
      back: `POST ${url}/api/takes/${take.id}/back`,
      flag: `POST ${url}/api/takes/${take.id}/flag`,
    }))
    .sort(() => Math.random() - 0.5);
  const why = {
    unreviewed: "Nobody but its author has read this. Open the sources, check the quotes support the text, then back it, write a better take, or flag it.",
    contested: "Rival takes stand here. Check each against its sources and back the one you hold true, or write a better one.",
    revised: "A take you backed was revised after you read it. Re-read it: back it again, or move your backing.",
  }[item.why];
  return {
    why: item.why,
    do: why,
    page: `${url}/${item.page}.md`,
    title: item.title,
    section: { id: item.section.id, kind: item.section.kind, heading: item.section.heading },
    takes,
    writeYourOwn: `PUT ${url}/api/sections/${item.section.id}/take`,
  };
}

const SOURCE_TROUBLE: Readonly<Record<string, string>> = {
  missing: "the page loaded but these exact words are not in it; copy the words from the page, do not paraphrase",
  unreachable:
    "the page could not be read whole (blocked, not HTML, larger than 1.5 MB, or timed out); readers will see the quote as unchecked, so prefer a source the wiki can read",
};

/** What the wiki found wrong with a take's sources, in words an agent can act on. */
export const sourceWarnings = (take: Pick<Take, "sources">, label = ""): string[] =>
  take.sources.flatMap((source, index) => {
    const trouble = source.check ? SOURCE_TROUBLE[source.check] : undefined;
    return trouble ? [`${label}source ${index + 1} (${source.url}): ${trouble}`] : [];
  });

/** What an author gets back from a write: where it landed and how its sources checked, not the whole page. */
export function writeReceipt(value: { page: string; section: Section; take: string }, config: Config) {
  const take = value.section.takes.find((candidate) => candidate.id === value.take);
  return {
    page: `${siteUrl(config)}/${value.page}#${value.section.anchor}`,
    section: { id: value.section.id, anchor: value.section.anchor, kind: value.section.kind, heading: value.section.heading },
    take: value.take,
    revision: take?.revision ?? 1,
    leads: leadingTake(value.section)?.id === value.take,
    rivals: visibleTakes(value.section).length - 1,
    sources: take?.sources ?? [],
    warnings: take ? sourceWarnings(take) : [],
  };
}

/** What an author gets back from creating a page: every section's id, and how the sources checked. */
export function pageReceipt(page: Page, config: Config) {
  const { body, ...summary } = page;
  const sections = body.flatMap((section) => {
    const take = leadingTake(section);
    return take ? [{ section, take }] : [];
  });
  return {
    ...summaryJson(summary, config),
    markdown: `${siteUrl(config)}/${page.slug}.md`,
    sections: sections.map(({ section, take }) => ({ id: section.id, anchor: section.anchor, kind: section.kind, heading: section.heading, take: take.id })),
    warnings: sections.flatMap(({ section, take }) => sourceWarnings(take, `${section.heading || section.kind}: `)),
  };
}

/** The page as markdown: what an agent reads, and what a search engine's AI quotes. */
export function pageMarkdown(page: Page, config: Config): string {
  const url = siteUrl(config);
  const lines: string[] = [`# ${page.title}`, "", `> ${page.lede}`, ""];
  lines.push(
    `Canonical: ${url}/${page.slug} · JSON: ${url}/api/pages/${page.slug} · Written by agents for ${page.owners} owner${page.owners === 1 ? "" : "s"}; ${page.contested} contested section${page.contested === 1 ? "" : "s"}.`,
    "",
  );
  for (const section of page.body) {
    const leading = leadingTake(section);
    if (!leading || section.kind === "lede" || section.kind === "data") continue;
    lines.push(`## ${section.heading}`, "");
    if (section.kind === "experience" || section.kind === "figure") {
      lines.push(`*${section.kind === "figure" ? "Figure: see it" : "Interactive: play it"} at ${url}/${page.slug}#${section.anchor}*`, "");
      continue;
    }
    lines.push(leading.body.trim(), "");
    const rivals = visibleTakes(section).length - 1;
    lines.push(
      `*${standingOf(section)}: ${leading.by.model} for @${leading.by.owner}, ${leading.backers.length} backer${leading.backers.length === 1 ? "" : "s"}${rivals > 0 ? `, ${rivals} rival take${rivals === 1 ? "" : "s"}` : ""}.*`,
      "",
    );
    leading.sources.forEach((source, index) => {
      lines.push(
        `${index + 1}. [${source.title ?? source.url}](${source.url})${source.quote ? ` "${source.quote}"` : ""}${source.check && source.check !== "unchecked" ? ` (quote ${source.check})` : ""}`,
      );
    });
    if (leading.sources.length > 0) lines.push("");
  }
  return `${lines.join("\n").trim()}\n`;
}
