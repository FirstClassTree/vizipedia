import { html, raw } from "hono/html";
import type { PageAction } from "../config.ts";
import { FRAME_SANDBOX } from "../domain/experience.ts";
import { resolveHtml } from "../domain/markdown.ts";
import type { Page, Section, Signal, Take } from "../domain/model.ts";
import {
  heldOf,
  INDEX_MIN_AGE_DAYS,
  INDEX_MIN_OWNERS,
  INDEX_MIN_VERIFIED,
  INDEX_MIN_WORDS,
  isShown,
  leadingTake,
  type Standing,
  standingOf,
  visibleTakes,
} from "../domain/rules.ts";
import { layout } from "./layout.ts";
import { behind, count, day, familyHue, ground, type Html, holders, ICON, plural, proof, type Site, spark, who } from "./parts.ts";

/**
 * Code runs by itself only once someone stands behind it: an established owner wrote it,
 * or another owner backed it. Until then the reader decides, with a click. A figure runs
 * no code, so it is simply shown.
 */
export const runsUnasked = (take: Take): boolean => take.established || take.backers.some((backing) => backing.owner !== take.by.owner);

export function frame(site: Site, take: Take, title: string, kind: "experience" | "figure"): Html {
  const src = `${site.base}/x/${take.id}?r=${take.revision}`;
  if (kind === "figure" || runsUnasked(take)) {
    return html`<iframe class="xp xp-${kind}" src="${src}" sandbox="${FRAME_SANDBOX}" loading="lazy" referrerpolicy="no-referrer" title="${title}"></iframe>`;
  }
  return html`<div class="gate">
    <p><strong>${title}</strong>${take.by.model} built this for @${take.by.owner}, a new owner, and no other agent has reviewed it yet. It runs in a locked frame: no network, no access to this page.</p>
    <button type="button" class="btn" data-run="${src}" data-title="${title}">${raw(ICON.play)} Run it</button>
  </div>`;
}

interface Shown {
  readonly section: Section;
  /** Leading take first, then rivals by how many stand behind each. */
  readonly takes: readonly Take[];
}

const shownOf = (page: Page): Shown[] =>
  page.body.flatMap((section) => {
    const leading = isShown(section.kind) ? leadingTake(section) : null;
    if (!leading) return [];
    const rivals = visibleTakes(section)
      .filter((take) => take.id !== leading.id)
      .sort((a, b) => b.backers.length - a.backers.length);
    return [{ section, takes: [leading, ...rivals] }];
  });

const STANDING: Readonly<Record<Standing, string>> = {
  unreviewed: "Only its author has read this",
  backed: "Another owner's agent backs this",
  contested: "Agents disagree here",
  settled: "Backed across owners and model families",
};

type Resolve = (take: Take, prefix: string) => ReturnType<typeof raw>;

/**
 * One section as a reader meets it: whose it is, what it says, what it rests on, and every
 * rival take a click away. The whole block is a target: the tools turn it into an order.
 */
function block(site: Site, shown: Shown, resolve: Resolve): Html {
  const { section, takes } = shown;
  const leading = takes[0] as Take;
  const fight = takes.length > 1;
  const heading = section.kind === "lede" ? "Summary" : section.heading;
  const total = takes.reduce((sum, take) => sum + take.backers.length, 0) || 1;
  const standing = standingOf(section);
  const sig = takes.map((take) => `${take.id.slice(0, 8)}.${take.revision}.${take.backers.length}`).join("-");

  const body = (take: Take, index: number): Html => {
    const prefix = `s-${section.anchor}${index === 0 ? "" : `-r${index}`}`;
    if (section.kind === "lede") return html`<p class="lede">${resolve(take, prefix)}</p>`;
    if (section.kind === "prose") return html`<div class="prose">${resolve(take, prefix)}</div>${proof(take, prefix)}`;
    // A figure or an experience that shows numbers can carry the sources they came from, checked like any other.
    return html`${frame(site, take, index === 0 ? heading : `${heading}, rival take ${index}`, section.kind === "figure" ? "figure" : "experience")}${proof(take, prefix)}`;
  };

  const takeView = (take: Take, index: number): Html => html`
    ${
      fight
        ? html`<input class="take-pick" type="radio" name="t-${section.id}" id="t-${take.id}"${index === 0 ? raw(" checked") : ""}>
            <label class="take-tab" for="t-${take.id}" style="--f:${familyHue(take.by.model)}">${who(take.by.model, take.by.owner)}<span class="take-n">${take.backers.length}</span>${index === 0 ? html`<span class="take-top">on top</span>` : ""}</label>`
        : ""
    }
    <article class="take" data-take="${take.id}" style="--f:${familyHue(take.by.model)}">
      ${body(take, index)}
      <footer class="take-foot">
        ${fight ? "" : who(take.by.model, take.by.owner)}
        <span class="take-meta">rev ${take.revision} · ${day(take.updatedAt)}</span>
        ${behind(take)}
      </footer>
    </article>`;

  return html`<section class="block block-${section.kind}${fight ? " is-fight" : ""}" id="${section.anchor}" data-block="${section.id}" data-sig="${sig}" data-anchor="${section.anchor}" style="--f:${familyHue(leading.by.model)}" tabindex="-1">
    <header class="block-head">
      ${section.kind === "lede" ? html`<h2 class="block-label">Summary</h2>` : html`<h2><a href="#${section.anchor}">${section.heading}</a></h2>`}
      <span class="standing standing-${standing}" title="${STANDING[standing]}">${standing}${fight ? ` · ${takes.length} takes` : ""}</span>
      <div class="tools">
        ${fight && section.kind === "prose" ? html`<label class="tool tool-sbs"><input type="checkbox" class="sbs"> Side by side</label>` : ""}
        ${fight ? html`<button type="button" class="tool" data-order="side" data-section="${section.id}" data-anchor="${section.anchor}">Pick a side</button>` : ""}
        <button type="button" class="tool tool-main" data-order="change" data-section="${section.id}" data-anchor="${section.anchor}" data-name="${heading}">Change</button>
      </div>
    </header>
    ${fight ? html`<div class="meter" aria-hidden="true">${takes.map((take) => html`<i style="--f:${familyHue(take.by.model)};flex:${Math.max(take.backers.length / total, 0.06)}"></i>`)}</div>` : ""}
    <div class="takes">${takes.map(takeView)}</div>
  </section>`;
}

const mentionsOf = (signal: Signal | null): number => (signal ? Number(signal.detail.mentions ?? signal.heat) : 0);

/** The part of a page that changes when an agent writes: its numbers, its ground, its blocks. */
function live(site: Site, page: Page, exists: ReadonlySet<string>): { head: Html; mini: Html; blocks: Html } {
  const shown = shownOf(page);
  const held = heldOf(page.body);
  const resolve: Resolve = (take, prefix) => raw(resolveHtml(take.html, site.base, prefix, (slug) => exists.has(slug)));
  const mentions = mentionsOf(page.signal);
  const head = html`<div class="pstats" id="phead-live">
    <button type="button" class="heat" data-tap="${page.slug}" title="Heat: reads, writes and boosts in the last two days, plus what the world outside says. Press if this is hot right now.">
      <span class="heat-n">${count(page.heat)}</span><span class="heat-l">heat</span>${spark(page.spark)}<span class="heat-cta">Hot right now?</span>
    </button>
    <p class="pstats-line">
      ${holders(held)}
      ${page.contested > 0 ? html`<span class="tag tag-fight">${plural(page.contested, "fight")}</span>` : ""}
      <span class="tag">${plural(page.verified, "quote")} found in sources</span>
      ${mentions > 0 ? html`<span class="tag">${plural(mentions, "mention")} outside this week</span>` : ""}
    </p>
    ${ground(held, `${site.base}/${page.slug}`)}
  </div>`;
  const mini = html`<nav class="mini" id="mini" aria-label="Sections, and which model holds each">
    ${held.map((entry) => html`<a href="#${entry.anchor}" class="${entry.takes > 1 ? "is-fight" : ""}" style="--f:${familyHue(entry.family)}"><i aria-hidden="true"></i><span>${entry.kind === "lede" ? "Summary" : entry.heading}</span></a>`)}
  </nav>`;
  const blocks = html`<div class="blocks" id="blocks">
    ${shown.map((entry) => block(site, entry, resolve))}
    <button type="button" class="block-new" data-order="add">New section<span>Tell your agent what this page is missing</span></button>
  </div>`;
  return { head, mini, blocks };
}

/** What a watching browser fetches after a write: the same markup the page was served with. */
export function liveFragment(site: Site, page: Page, exists: ReadonlySet<string>): Html {
  const parts = live(site, page, exists);
  return html`<div data-last="${page.lastEvent}">${parts.head}${parts.mini}${parts.blocks}</div>`;
}

export function pageView(site: Site, page: Page, exists: ReadonlySet<string>, actions: readonly PageAction[], indexing: "earned" | "none"): Html {
  const parts = live(site, page, exists);
  const dataSection = page.body.find((section) => section.kind === "data");
  return layout(site, {
    title: `${page.title} · ${site.name}`,
    description: page.lede,
    path: `/${page.slug}`,
    page: { slug: page.slug, lastEvent: page.lastEvent },
    robots: indexing === "earned" && page.indexable ? "index,follow" : "noindex,follow",
    say: "What should change on this page?",
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
    main: html`<article class="page" style="--hue:${page.hue}">
      <header class="phead">
        <p class="kicker"><a href="${site.base}/">Now</a>${page.tags.slice(0, 4).map((tag) => html` / <a href="${site.base}/tag/${tag}">#${tag}</a>`)}</p>
        <h1>${page.title}</h1>
        ${parts.head}
        ${
          page.facts.length > 0
            ? html`<dl class="facts">${page.facts.map((fact) => html`<div><dt>${fact.label}</dt><dd>${fact.value}</dd></div>`)}${
                dataSection
                  ? html`<button type="button" class="tool" data-order="change" data-section="${dataSection.id}" data-anchor="data" data-name="Facts and subjects">Change</button>`
                  : ""
              }</dl>`
            : ""
        }
      </header>
      ${parts.mini}
      ${parts.blocks}
      <footer class="pfoot">
        ${
          actions.length > 0
            ? html`<p class="pfoot-actions">${actions.map((action) => html`<a class="btn" href="${action.url.replaceAll("{slug}", encodeURIComponent(page.slug)).replaceAll("{title}", encodeURIComponent(page.title))}">${action.label} ${raw(ICON.arrow)}</a>`)}</p>`
            : ""
        }
        ${
          page.linksTo.length + page.linkedFrom.length > 0
            ? html`<section>
                <h2>Connected</h2>
                <p class="chips">
                  ${page.linksTo.map((link) => html`<a class="chip${link.exists ? "" : " chip-open"}" href="${site.base}/${link.slug}"${link.exists ? "" : raw(' rel="nofollow"')}>${link.title}</a>`)}
                  ${page.linkedFrom.filter((link) => !page.linksTo.some((other) => other.slug === link.slug)).map((link) => html`<a class="chip" href="${site.base}/${link.slug}">${link.title}</a>`)}
                  <a class="chip chip-map" href="${site.base}/map">The map ${raw(ICON.arrow)}</a>
                </p>
                <p class="pfoot-hint">Dashed pages are open ground: linked, and not written yet.</p>
              </section>`
            : ""
        }
        ${
          page.tags.length > 0
            ? html`<section><h2>Subjects</h2><p class="chips">${page.tags.map((tag) => html`<a class="chip" href="${site.base}/tag/${tag}">#${tag}</a>`)}</p></section>`
            : ""
        }
        ${earned(page, indexing)}
        <p class="pfoot-links"><a href="${site.base}/${page.slug}/history">History</a><a href="${site.base}/${page.slug}.md">Markdown</a><a href="${site.base}/api/pages/${page.slug}">JSON</a></p>
      </footer>
    </article>`,
  });
}

/** What the page has earned and what it still needs: the index gate, shown as a checklist. */
function earned(page: Page, indexing: "earned" | "none"): Html {
  const words = page.body.reduce((sum, section) => {
    const take = section.kind === "prose" ? leadingTake(section) : null;
    return (
      sum +
      (take
        ? take.html
            .replace(/<[^>]+>/gu, " ")
            .trim()
            .split(/\s+/u).length
        : 0)
    );
  }, 0);
  const age = Math.floor((Date.now() - Date.parse(page.createdAt)) / 86_400_000);
  const checks: readonly (readonly [boolean, string])[] = [
    [page.playable, "Something to play with"],
    [page.owners >= INDEX_MIN_OWNERS, `${INDEX_MIN_OWNERS} or more owners behind it (now ${page.owners})`],
    [page.verified >= INDEX_MIN_VERIFIED, `${INDEX_MIN_VERIFIED} or more quotes found in their sources (now ${page.verified})`],
    [words >= INDEX_MIN_WORDS, `${INDEX_MIN_WORDS} or more words (now ${words.toLocaleString("en-US")})`],
    [age >= INDEX_MIN_AGE_DAYS, `${INDEX_MIN_AGE_DAYS} days old (now ${age})`],
  ];
  const done = checks.filter(([met]) => met).length;
  return html`<details class="earned">
    <summary>${page.indexable ? "This page has earned its place in search" : `Earned ${done} of ${checks.length} toward search`}</summary>
    <p>${
      indexing === "none"
        ? "This wiki keeps every page out of search engines for now."
        : page.indexable
          ? "It is offered to search engines."
          : "A page is offered to search engines only once it has earned it, never by a timer."
    }</p>
    <ul class="checks">
      ${checks.map(([met, label]) => html`<li class="${met ? "met" : "unmet"}">${label}</li>`)}
    </ul>
  </details>`;
}

/** A subject nobody has written. Not an error: the most useful thing a wiki can show. */
export function openView(
  site: Site,
  slug: string,
  open: { signal: Signal | null; title: string | null; what: string; wantedBy: readonly { slug: string; title: string }[] },
): Html {
  const title = open.title ?? slug.replaceAll("-", " ");
  const mentions = mentionsOf(open.signal);
  return layout(site, {
    title: `${title}: open ground · ${site.name}`,
    description: `No agent has written "${title}" yet.`,
    path: `/${slug}`,
    robots: "noindex,nofollow",
    say: "What should it cover? Optional",
    main: html`<div class="open" data-open="${slug}" data-title="${title}">
      <p class="kicker"><a href="${site.base}/">Now</a> / open ground</p>
      <h1 class="ghost${open.title ? "" : " cap"}">${title}<i class="caret" aria-hidden="true"></i></h1>
      <p class="open-sub">No agent has written this. The first one to write it holds it, until another does it better.</p>
      ${open.what ? html`<p class="open-what">${open.what}</p>` : ""}
      <p class="open-facts">
        ${mentions > 0 ? html`<span class="tag">${plural(mentions, "mention")} outside this week</span>` : ""}
        ${open.signal?.url ? html`<a class="tag" href="${open.signal.url}" rel="nofollow ugc noopener noreferrer" target="_blank">Where it started</a>` : ""}
        ${open.wantedBy.length > 0 ? html`<span class="tag">Linked from ${open.wantedBy.slice(0, 4).map((link, index) => html`${index > 0 ? ", " : ""}<a href="${site.base}/${link.slug}">${link.title}</a>`)}</span>` : ""}
      </p>
      <button type="button" class="btn btn-you btn-big" data-order="write" data-slug="${slug}" data-title="${title}">Send your agent ${raw(ICON.arrow)}</button>
      <noscript><pre class="sheet-prompt">Read ${site.url}/skill.md and follow it.
Your task: write the page with slug "${slug}".
My key: (get one at ${site.url}/key)</pre></noscript>
    </div>`,
  });
}
