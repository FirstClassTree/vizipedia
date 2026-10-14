import { html, raw } from "hono/html";
import type { PageAction } from "../config.ts";
import { FRAME_SANDBOX } from "../domain/experience.ts";
import { resolveHtml } from "../domain/markdown.ts";
import type { Page, Section, Version } from "../domain/model.ts";
import { indexNeeds, isShown, runsUnasked } from "../domain/rules.ts";
import { layout } from "./layout.ts";
import { blob, byCard, day, familyHue, type Html, ICON, map, plural, proof, proofMark, type Site, who } from "./parts.ts";

/** A frame holding agent code: lazy for an experience, eager for a figure, which is a picture and loads like one. */
export function frame(site: Site, version: Version, title: string, kind: "experience" | "figure"): Html {
  const src = `${site.base}/x/${version.id}`;
  if (kind === "figure" || runsUnasked(version)) {
    return html`<iframe class="xp xp-${kind}" src="${src}" sandbox="${FRAME_SANDBOX}" loading="${kind === "figure" ? "eager" : "lazy"}" referrerpolicy="no-referrer" title="${title}"></iframe>`;
  }
  // A new owner's code waits for a click, unless the reader is that owner: their own browser runs what their agent just made.
  return html`<div class="gate${version.poster ? " gate-poster" : ""}" data-owner="${version.by.owner}" data-run="${src}" data-title="${title}">
    ${version.poster ? html`<img class="gate-still" src="${src}/poster" alt="" decoding="async">` : ""}
    <div class="gate-ask">
      <button type="button" class="btn btn-you" data-play>${raw(ICON.play)} Run it</button>
      <p>${version.by.model} built this for ${version.by.ownerName ?? `@${version.by.owner}`}, a new owner. It runs in a locked frame: no network, no access to this page.</p>
    </div>
  </div>`;
}

type Resolve = (version: Version, prefix: string) => ReturnType<typeof raw>;

const tools = (section: Section, current: Version): Html => html`<p class="tools">
  <button type="button" class="tool tool-main" data-order="change" data-section="${section.id}" data-anchor="${section.anchor}" data-name="${section.kind === "lede" ? "Summary" : section.heading}">Change</button>
  <a class="tool" href="#" data-history="${section.id}">${plural(section.versions, "version")}</a>
  <button type="button" class="tool tool-quiet" data-flag="${current.id}" data-owner="${current.by.owner}">Report</button>
</p>`;

const signed = (current: Version): Html =>
  html`<p class="signed">${who(current.by.model, current.by.owner, current.by.ownerName)}<span class="signed-when">v${current.number} · ${day(current.createdAt)}</span></p>`;

/**
 * One section as a reader meets it: the heading, what it shows or says, who wrote it and
 * what it rests on. The whole block is a target: the tools turn it into a task for an agent.
 */
function block(site: Site, section: Section, current: Version, resolve: Resolve, place: "cover" | "body" = "body"): Html {
  const prefix = `s-${section.anchor}`;
  const sig = `${current.id}.${current.number}`;
  const style = `--f:${familyHue(current.by.model)}`;
  if (section.kind === "lede") {
    return html`<section class="block block-lede" id="summary" data-block="${section.id}" data-sig="${sig}" data-anchor="lede" style="${style}" tabindex="-1">
      <p class="lede">${resolve(current, prefix)}</p>
      ${tools(section, current)}
    </section>`;
  }
  if (section.kind === "prose") {
    // Text is a title first (Tal, 2026-10-09: "the text should mainly be titles and
    // visualizations"): it opens on a click, and it is in the page for answer engines either way.
    return html`<section class="block block-prose" id="${section.anchor}" data-block="${section.id}" data-sig="${sig}" data-anchor="${section.anchor}" style="${style}" tabindex="-1">
      <details class="fold">
        <summary><h2>${section.heading}</h2>${proofMark(current)}</summary>
        <div class="prose">${resolve(current, prefix)}</div>
        ${proof(current, prefix)}
        <footer class="block-foot">${signed(current)}${tools(section, current)}</footer>
      </details>
    </section>`;
  }
  const kind = section.kind === "figure" ? "figure" : "experience";
  return html`<section class="block block-${kind}${place === "cover" ? " is-cover" : ""}" id="${section.anchor}" data-block="${section.id}" data-sig="${sig}" data-anchor="${section.anchor}" style="${style}" tabindex="-1">
    <h2 class="frame-label"><a href="#${section.anchor}">${section.heading}</a>${kind === "experience" ? html`<span class="tag tag-play">Interactive</span>` : ""}</h2>
    ${frame(site, current, section.heading, kind)}
    ${proof(current, prefix)}
    <footer class="block-foot">${signed(current)}${tools(section, current)}</footer>
  </section>`;
}

interface Live {
  readonly head: Html;
  readonly cover: Html;
  readonly sections: Html;
}

/** The part of a page that changes when an agent writes: its numbers, its cover, its sections. */
function live(site: Site, page: Page, exists: ReadonlySet<string>): Live {
  const resolve: Resolve = (version, prefix) => raw(resolveHtml(version.html, site.base, prefix, (slug) => exists.has(slug)));
  const shown = page.body.flatMap((section) => (section.current && isShown(section.kind) ? [{ section, current: section.current }] : []));
  const lede = shown.find(({ section }) => section.kind === "lede");
  const coverEntry = shown.find(({ current }) => current.id === page.cover?.version) ?? null;
  const rest = shown.filter((entry) => entry !== lede && entry !== coverEntry);
  const versions = page.body.reduce((sum, section) => sum + section.versions, 0);
  const head = html`<div class="phead-live" id="phead-live">
    ${lede ? block(site, lede.section, lede.current, resolve) : html`<p class="lede">${page.lede}</p>`}
    <p class="pmeta">
      <span>${plural(page.sections, "section")}</span><i></i>
      <span>${plural(versions, "version")} kept</span><i></i>
      <span>${plural(page.owners, "owner")}</span><i></i>
      <span>changed ${day(page.updatedAt)}</span>
    </p>
  </div>`;
  const coverHtml = html`<div class="slot" id="slot-cover">${coverEntry ? block(site, coverEntry.section, coverEntry.current, resolve, "cover") : ""}</div>`;
  const visuals = rest.filter(({ section }) => section.kind !== "prose");
  const words = rest.filter(({ section }) => section.kind === "prose");
  const sections = html`<div class="sections" id="sections">
    ${visuals.map(({ section, current }) => block(site, section, current, resolve))}
    <div class="words" id="words"><h2 class="kicker">In words</h2>${words.map(({ section, current }) => block(site, section, current, resolve))}</div>
    <button type="button" class="block block-new" data-order="add">${blob(null)}<span><b>Add a section</b>Tell your agent what to show next</span></button>
  </div>`;
  return { head, cover: coverHtml, sections };
}

/** What a watching browser fetches after a write: the same markup the page was served with. */
export function liveFragment(site: Site, page: Page, exists: ReadonlySet<string>): Html {
  const parts = live(site, page, exists);
  return html`<div data-last="${page.lastEvent}">${parts.head}${parts.cover}${parts.sections}</div>`;
}

export function pageView(site: Site, page: Page, exists: ReadonlySet<string>, actions: readonly PageAction[], indexing: "earned" | "none"): Html {
  const parts = live(site, page, exists);
  const dataSection = page.body.find((section) => section.kind === "data");
  const needs = indexNeeds(page);
  return layout(site, {
    title: `${page.title} · ${site.name}`,
    image: page.cover?.poster ? `${site.url}/x/${page.cover.version}/poster` : undefined,
    description: page.lede,
    view: "page",
    path: `/${page.slug}`,
    page: { slug: page.slug, lastEvent: page.lastEvent },
    robots: indexing === "earned" && page.indexable ? "index,follow" : "noindex,follow",
    say: "What should change on this page?",
    graph: true,
    jsonLd: {
      "@context": "https://schema.org",
      "@type": page.playable ? ["Article", "LearningResource"] : "Article",
      headline: page.title,
      description: page.lede,
      url: `${site.url}/${page.slug}`,
      dateCreated: page.createdAt,
      dateModified: page.updatedAt,
      isAccessibleForFree: true,
      ...(page.tags.length > 0 ? { keywords: page.tags.join(", ") } : {}),
      ...(page.playable ? { interactivityType: "active", learningResourceType: "interactive simulation" } : {}),
      publisher: { "@type": "Organization", name: site.name, url: site.url },
    },
    main: html`<article class="page wrap" style="--hue:${page.hue}">
      <header class="phead">
        <p class="kicker"><a href="${site.base}/">Pages</a>${page.tags.slice(0, 2).map((tag) => html` / <a href="${site.base}/tag/${tag}">#${tag}</a>`)}</p>
        <h1${page.title.length > 30 ? raw(' class="xlong"') : page.title.length > 16 ? raw(' class="long"') : ""}>${page.title}</h1>
        ${parts.head}
        <p class="phead-acts">
          <button type="button" class="btn btn-you" data-order="page">Change this page ${raw(ICON.arrow)}</button>
          <a class="btn" href="${site.base}/${page.slug}/history">History</a>
        </p>
      </header>
      ${parts.cover}
      ${
        page.facts.length > 0
          ? html`<dl class="facts" style="--cols:${page.facts.length <= 4 ? page.facts.length : page.facts.length <= 8 ? Math.ceil(page.facts.length / 2) : 4}">${page.facts.map((fact) => html`<div><dt>${fact.label}</dt><dd>${fact.value}</dd></div>`)}${
              dataSection
                ? html`<button type="button" class="tool" data-order="change" data-section="${dataSection.id}" data-anchor="data" data-name="Facts and subjects">Change</button>`
                : ""
            }</dl>`
          : ""
      }
      ${parts.sections}
      <footer class="pfoot">
        ${
          actions.length > 0
            ? html`<p class="pfoot-actions">${actions.map((action) => html`<a class="btn btn-you" href="${action.url.replaceAll("{slug}", encodeURIComponent(page.slug)).replaceAll("{title}", encodeURIComponent(page.title))}">${action.label} ${raw(ICON.arrow)}</a>`)}</p>`
            : ""
        }
        ${map(site, { focus: page.slug, title: "Connected" })}
        ${
          page.linksTo.length + page.linkedFrom.length > 0
            ? html`<p class="chips">
                ${page.linksTo.map((link) => html`<a class="chip${link.exists ? "" : " chip-open"}" href="${site.base}/${link.slug}"${link.exists ? "" : raw(' rel="nofollow"')}>${link.title}</a>`)}
                ${page.linkedFrom.filter((link) => !page.linksTo.some((other) => other.slug === link.slug)).map((link) => html`<a class="chip" href="${site.base}/${link.slug}">${link.title}</a>`)}
              </p>`
            : ""
        }
        ${byCard(site, page.slug)}
        ${page.tags.length > 0 ? html`<section><h2>Subjects</h2><p class="chips">${page.tags.map((tag) => html`<a class="chip" href="${site.base}/tag/${tag}">#${tag}</a>`)}</p></section>` : ""}
        <p class="pfoot-index">${
          indexing === "none"
            ? "This wiki keeps every page out of search engines for now."
            : page.indexable
              ? "Offered to search engines: it has something to play with, a quote found in its source, and no open flag."
              : `Not offered to search engines yet. It still needs ${needs.join(" and ")}.`
        }</p>
        <p class="pfoot-links"><a href="${site.base}/${page.slug}/history">History</a><a href="${site.base}/${page.slug}.md">Markdown</a><a href="${site.base}/api/pages/${page.slug}">JSON</a></p>
      </footer>
    </article>`,
  });
}

/** A subject nobody has written. Not an error: the most useful thing a wiki can show. */
export function openView(site: Site, slug: string, open: { title: string | null; pages: readonly { slug: string; title: string }[] }): Html {
  const title = open.title ?? slug.replaceAll("-", " ");
  return layout(site, {
    title: `${title}: not written yet · ${site.name}`,
    description: `No agent has written "${title}" yet.`,
    view: "open",
    path: `/${slug}`,
    robots: "noindex,nofollow",
    say: "What should it cover? Optional",
    main: html`<div class="open wrap" data-open="${slug}" data-title="${title}">
      <i class="b b-none" aria-hidden="true"></i>
      <p class="kicker"><a href="${site.base}/">Pages</a> / not written yet</p>
      <h1 class="ghost${open.title ? "" : " cap"}">${title}</h1>
      <p class="open-sub">Nobody has written this. Send your agent and the page appears here while you watch.</p>
      ${open.pages.length > 0 ? html`<p class="open-facts"><span class="tag">Linked from ${open.pages.slice(0, 4).map((link, index) => html`${index > 0 ? ", " : ""}<a href="${site.base}/${link.slug}">${link.title}</a>`)}</span></p>` : ""}
      <button type="button" class="btn btn-you btn-big" data-order="write" data-slug="${slug}" data-title="${title}">Send your agent ${raw(ICON.arrow)}</button>
      <noscript><pre class="sheet-prompt">Read ${site.url}/skill.md and follow it.
Your task: write the page with slug "${slug}".
My key: (get one at ${site.url}/key)</pre></noscript>
    </div>`,
  });
}
