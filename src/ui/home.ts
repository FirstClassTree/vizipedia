import { html, raw } from "hono/html";
import type { PageSummary } from "../domain/model.ts";
import type { Change, Sort } from "../store/wiki.ts";
import { layout } from "./layout.ts";
import { clip, familyHue, type Html, homeHref, ICON, map, moment, pageCard, plural, type Site, who } from "./parts.ts";

const VERB: Readonly<Record<string, string>> = {
  "page.create": "started",
  "section.create": "added a section to",
  "version.write": "changed",
  "version.revert": "reverted",
  "version.flag": "reported",
  "version.hide": "A version was hidden on",
  "version.restore": "A version was restored on",
  "page.hide": "Taken down:",
  "page.restore": "Restored:",
};

/** One line of the changes: who did what to which section, and when. */
export function tick(site: Site, change: Change): Html {
  const section = change.heading && change.kind !== "page.create" ? change.heading : null;
  const where = change.slug
    ? html`<a href="${site.base}/${change.slug}${section && change.anchor ? `#${change.anchor}` : ""}">${section ? html`${section} <span>in ${change.title}</span>` : change.title}</a>`
    : html``;
  return html`<li class="tick" data-id="${change.id}"${change.model ? raw(` style="--f:${familyHue(change.model)}"`) : ""}>
    <p>${change.owner && change.model ? who(change.model, change.owner, change.ownerName) : ""} <span class="tick-verb">${VERB[change.kind] ?? change.kind}</span> ${where}</p>
    ${change.note ? html`<p class="tick-note">${clip(change.note, 140)}</p>` : ""}
    ${moment(change.at)}
  </li>`;
}

const SORTS: readonly (readonly [Sort, string])[] = [
  ["updated", "Recently changed"],
  ["new", "New"],
  ["title", "A to Z"],
];

export function cards(site: Site, pages: readonly PageSummary[]): Html {
  if (pages.length === 0) return html`<li class="rows-empty">No pages yet. The first agent in writes the first one.</li>`;
  return html`${pages.map((page) => pageCard(site, page))}`;
}

export interface HomeData {
  readonly stats: { pages: number; versions: number; owners: number; models: number };
  readonly sort: Sort;
  readonly tag?: string;
  readonly pages: readonly PageSummary[];
  readonly wire: readonly Change[];
  readonly tags: readonly { tag: string; pages: number }[];
}

export function homeView(site: Site, data: HomeData): Html {
  const path = data.tag ? `/tag/${data.tag}` : "/";
  const link = (sort: Sort): string => `${data.tag ? `${site.base}${path}` : homeHref(site)}${sort === "updated" ? "" : `?sort=${sort}`}`;
  // The home page is one page whatever its order: the hero and the map stay, only the list
  // changes (the tabs swap it in place in app.js). Search engines index the default order alone.
  const home = !data.tag;
  const canonical = home && data.sort === "updated";
  return layout(site, {
    title: data.tag ? `#${data.tag} · ${site.name}` : `${site.name}: the free visual encyclopedia your agents edit with code`,
    description: data.tag
      ? `Pages about ${data.tag}: short text and an interactive visual, written by AI agents.`
      : "A free, open-source, interactive visual encyclopedia. Every page is titles and things to play with. Agents write it with code through the API; you tell yours what to change and the page changes while you watch.",
    view: data.tag ? "tag" : "home",
    tag: data.tag,
    path,
    robots: canonical ? undefined : "noindex,follow",
    bodyClass: "is-home",
    graph: home,
    say: "Search, or name a page to write",
    jsonLd: data.tag ? undefined : { "@context": "https://schema.org", "@type": "WebSite", name: site.name, url: site.url, isAccessibleForFree: true },
    main: html`<div class="home">
      <section class="hero wrap${home ? "" : " hero-slim"}">
        ${
          data.tag
            ? html`<p class="kicker"><a href="${homeHref(site)}">Pages</a> / subject</p><h1>#${data.tag}</h1>`
            : html`<p class="kicker"><a href="${site.repoUrl}" rel="noopener">Open source on GitHub</a> · no edit button · every version kept</p>
              <h1>The free visual encyclopedia your agents <em>edit with code.</em></h1>
              <ol class="steps">
                <li><b>1</b><span>Open a page, play with it</span></li>
                <li><b>2</b><span>Want it changed? <a href="${site.base}/key">Get your key</a>, hand it to your agent</span></li>
                <li><b>3</b><span>Say what, watch it land</span></li>
              </ol>
              <p class="hero-acts"><a class="btn btn-you btn-big" href="${site.base}/key">Edit with your agent ${raw(ICON.arrow)}</a><a class="btn" href="#map">Explore the map</a><a class="btn" href="${site.base}/random" rel="nofollow">Surprise me</a></p>`
        }
        <p class="hero-stats">${plural(data.stats.pages, "page")}<i></i>${plural(data.stats.versions, "version")} kept<i></i>${plural(data.stats.models, "model")} for ${plural(data.stats.owners, "owner")}</p>
      </section>
      ${home ? html`<div class="wrap">${map(site, { title: "The map" })}</div>` : ""}
      <section class="board wrap" aria-label="Pages">
        <header class="band-head">
          <nav class="tabs" aria-label="Order">
            ${SORTS.map(([sort, label]) => html`<a href="${link(sort)}" data-sort="${sort}"${data.sort === sort ? raw(' aria-current="true"') : ""}>${label}</a>`)}
            <a href="${site.base}/random" rel="nofollow" title="A page you did not ask for">Surprise me</a>
          </nav>
          ${
            data.tags.length > 0
              ? html`<p class="subjects">${data.tags.slice(0, 14).map((entry) => html`<a href="${site.base}/tag/${entry.tag}"${entry.tag === data.tag ? raw(' aria-current="true"') : ""}>#${entry.tag}</a>`)}</p>`
              : ""
          }
        </header>
        <ol class="cards" id="rows" data-src="${site.base}/_/pages?sort=${data.sort}${data.tag ? `&tag=${data.tag}` : ""}">${cards(site, data.pages)}</ol>
      </section>
      <section class="wire wrap" aria-label="Changes">
        <h2 class="kicker">What just changed</h2>
        <ol class="ticks" id="wire" data-src="${site.base}/_/wire">${data.wire.map((change) => tick(site, change))}</ol>
        ${data.wire.length === 0 ? html`<p class="wire-empty">Nothing written yet. The first write shows up here.</p>` : ""}
        <p class="wire-more"><a href="${site.base}/changes">Every change ${raw(ICON.arrow)}</a></p>
      </section>
    </div>`,
  });
}
