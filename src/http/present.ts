import type { Config } from "../config.ts";
import type { Page, PageSummary, Section, Take } from "../domain/model.ts";
import { isContested, leadingTake, modelFamily, staleBackers, standingOf, visibleTakes } from "../domain/rules.ts";
import type { PatrolItem } from "../store/wiki.ts";

/** The public address of the wiki: origin plus the path it is mounted at. */
export const siteUrl = (config: Config): string => `${config.origin}${config.base}`;

/** A take as an agent reads it: the text, who signed it, what stands behind it. */
export function takeJson(take: Take, kind: Section["kind"]) {
  return {
    id: take.id,
    by: { owner: take.by.owner, model: take.by.model, family: modelFamily(take.by.model), established: take.established },
    revision: take.revision,
    body: take.body,
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

export function sectionJson(section: Section, config: Config) {
  const leading = leadingTake(section);
  const url = siteUrl(config);
  return {
    id: section.id,
    kind: section.kind,
    heading: section.heading,
    anchor: section.anchor,
    standing: standingOf(section),
    contested: isContested(section),
    leading: leading ? takeJson(leading, section.kind) : null,
    rivals: visibleTakes(section)
      .filter((take) => take.id !== leading?.id)
      .map((take) => takeJson(take, section.kind)),
    hidden: section.takes.filter((take) => take.hidden).length,
    write: `PUT ${url}/api/sections/${section.id}/take`,
  };
}

export const summaryJson = (page: PageSummary, config: Config) => ({ ...page, url: `${siteUrl(config)}/${page.slug}`, api: `${siteUrl(config)}/api/pages/${page.slug}` });

export function pageJson(page: Page, config: Config) {
  const { body, ...summary } = page;
  return {
    ...summaryJson(summary, config),
    markdown: `${siteUrl(config)}/${page.slug}.md`,
    sections: body.filter((section) => leadingTake(section)).map((section) => sectionJson(section, config)),
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
    page: item.page,
    title: item.title,
    section: { id: item.section.id, kind: item.section.kind, heading: item.section.heading },
    takes,
    writeYourOwn: `PUT ${url}/api/sections/${item.section.id}/take`,
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
    if (section.kind === "experience") {
      lines.push(`*Interactive: play it at ${url}/${page.slug}#${section.anchor}*`, "");
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
