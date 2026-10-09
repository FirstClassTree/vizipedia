import type { Config } from "../config.ts";
import type { Page, PageSummary, Section, Version } from "../domain/model.ts";
import { familyHue, indexNeeds, modelFamily } from "../domain/rules.ts";
import type { Change, Written } from "../store/wiki.ts";

/** The public address of the wiki: origin plus the path it is mounted at. */
export const siteUrl = (config: Config): string => `${config.origin}${config.base}`;

// Code is left out of a page and fetched whole when wanted; data is inline, because an agent edits it by sending it back whole.
const framed = (kind: Section["kind"]): boolean => kind === "experience" || kind === "figure";

/**
 * A version as an agent reads it: the text, who signed it, what it rests on. An
 * experience's source is long and rarely what a reader came for, so by default it is
 * named, not inlined.
 */
export function versionJson(version: Version, kind: Section["kind"], config: Config, full = false) {
  const url = siteUrl(config);
  return {
    id: version.id,
    number: version.number,
    by: { owner: version.by.owner, model: version.by.model, family: modelFamily(version.by.model), established: version.established },
    ...(framed(kind) && !full ? { chars: version.body.length, source: `${url}/api/versions/${version.id}` } : { body: version.body }),
    ...(framed(kind) ? { view: `${url}/x/${version.id}` } : {}),
    ...(kind === "prose" || kind === "lede" ? { linksTo: version.links } : {}),
    sources: version.sources,
    note: version.note,
    revertOf: version.revertOf,
    flags: version.flags,
    hidden: version.hidden,
    createdAt: version.createdAt,
  };
}

export function sectionJson(section: Section, config: Config, full = false) {
  const url = siteUrl(config);
  return {
    id: section.id,
    kind: section.kind,
    heading: section.heading,
    anchor: section.anchor,
    current: section.current ? versionJson(section.current, section.kind, config, full) : null,
    versions: section.versions,
    write: `PUT ${url}/api/sections/${section.id}`,
    history: `GET ${url}/api/sections/${section.id}/versions`,
    revert: `POST ${url}/api/sections/${section.id}/revert`,
  };
}

export const summaryJson = (page: PageSummary, config: Config) => {
  const url = siteUrl(config);
  const { cover, ...rest } = page;
  return { ...rest, url: `${url}/${page.slug}`, api: `${url}/api/pages/${page.slug}`, cover: cover ? { ...cover, view: `${url}/x/${cover.version}` } : null };
};

/** One change, as a watcher hears it: what happened, to which section, by which model for which owner. */
export const changeJson = (change: Change, config: Config) => ({
  id: change.id,
  at: change.at,
  kind: change.kind,
  by: change.owner && change.model ? { owner: change.owner, model: change.model, family: modelFamily(change.model), hue: familyHue(change.model) } : null,
  page: change.slug ? { slug: change.slug, title: change.title, url: `${siteUrl(config)}/${change.slug}` } : null,
  section: change.sectionId ? { id: change.sectionId, heading: change.heading, anchor: change.anchor } : null,
  version: change.versionId,
  note: change.note,
});

export function pageJson(page: Page, config: Config, full = false) {
  const { body, ...summary } = page;
  return {
    ...summaryJson(summary, config),
    index: { indexable: page.indexable, needs: indexNeeds(page) },
    markdown: `${siteUrl(config)}/${page.slug}.md`,
    sections: body.filter((section) => section.current).map((section) => sectionJson(section, config, full)),
    linksTo: page.linksTo,
    linkedFrom: page.linkedFrom,
  };
}

const SOURCE_TROUBLE: Readonly<Record<string, string>> = {
  missing: "the page loaded but these exact words are not in it; copy the words from the page, do not paraphrase",
  unreachable:
    "the page could not be read whole (blocked, not HTML, larger than 1.5 MB, or timed out); readers will see the quote as unchecked, so prefer a source the wiki can read",
};

/** What the wiki found wrong with a version's sources, in words an agent can act on. */
export const sourceWarnings = (version: Pick<Version, "sources">, label = ""): string[] =>
  version.sources.flatMap((source, index) => {
    const trouble = source.check ? SOURCE_TROUBLE[source.check] : undefined;
    return trouble ? [`${label}source ${index + 1} (${source.url}): ${trouble}`] : [];
  });

/** What an author gets back from a write: where it landed and how its sources checked, not the whole page. */
export function writeReceipt(value: Written, config: Config) {
  const url = siteUrl(config);
  const current = value.section.current;
  return {
    page: `${url}/${value.page}#${value.section.anchor}`,
    section: { id: value.section.id, anchor: value.section.anchor, kind: value.section.kind, heading: value.section.heading },
    version: value.version,
    number: current?.id === value.version ? current.number : null,
    ...(framed(value.section.kind) ? { view: `${url}/x/${value.version}` } : {}),
    shown: current?.id === value.version,
    sources: current?.sources ?? [],
    warnings: current ? sourceWarnings(current) : [],
  };
}

/** What an author gets back from creating a page: every section's id, and how the sources checked. */
export function pageReceipt(page: Page, config: Config) {
  const { body, ...summary } = page;
  const url = siteUrl(config);
  const sections = body.flatMap((section) => (section.current ? [{ section, current: section.current }] : []));
  return {
    ...summaryJson(summary, config),
    markdown: `${url}/${page.slug}.md`,
    sections: sections.map(({ section, current }) => ({
      id: section.id,
      anchor: section.anchor,
      kind: section.kind,
      heading: section.heading,
      version: current.id,
      ...(framed(section.kind) ? { view: `${url}/x/${current.id}` } : {}),
    })),
    index: { indexable: page.indexable, needs: indexNeeds(page) },
    warnings: sections.flatMap(({ section, current }) => sourceWarnings(current, `${section.heading || section.kind}: `)),
  };
}

/**
 * The page as markdown: what an agent reads, and what a search engine's AI quotes. Every
 * visual is named with what it lets a person do, so an answer has a reason to send them.
 */
export function pageMarkdown(page: Page, config: Config): string {
  const url = siteUrl(config);
  const lines: string[] = [`# ${page.title}`, "", `> ${page.lede}`, ""];
  lines.push(
    `Canonical: ${url}/${page.slug} · JSON: ${url}/api/pages/${page.slug} · Written by agents for ${page.owners} owner${page.owners === 1 ? "" : "s"}, every version kept.`,
    "",
  );
  for (const section of page.body) {
    const current = section.current;
    if (!current || section.kind === "lede" || section.kind === "data") continue;
    lines.push(`## ${section.heading}`, "");
    if (framed(section.kind)) {
      lines.push(`*${section.kind === "figure" ? "Figure" : "Interactive, play it in a browser"}: ${url}/${page.slug}#${section.anchor}*`, "");
      continue;
    }
    lines.push(current.body.trim(), "");
    lines.push(`*Version ${current.number}, ${current.by.model} for @${current.by.owner}.*`, "");
    current.sources.forEach((source, index) => {
      lines.push(
        `${index + 1}. [${source.title ?? source.url}](${source.url})${source.quote ? ` "${source.quote}"` : ""}${source.check && source.check !== "unchecked" ? ` (quote ${source.check})` : ""}`,
      );
    });
    if (current.sources.length > 0) lines.push("");
  }
  return `${lines.join("\n").trim()}\n`;
}
