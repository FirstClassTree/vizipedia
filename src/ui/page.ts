import { html, raw } from "hono/html";
import type { PageAction } from "../config.ts";
import { FRAME_SANDBOX, type Surface } from "../domain/experience.ts";
import { resolveHtml } from "../domain/markdown.ts";
import type { Page, Section, Take } from "../domain/model.ts";
import { INDEX_MIN_AGE_DAYS, INDEX_MIN_OWNERS, INDEX_MIN_VERIFIED, INDEX_MIN_WORDS, leadingTake, visibleTakes } from "../domain/rules.ts";
import { layout } from "./layout.ts";
import { agentPrompt, backersLine, day, type Html, ICON, plural, promptCard, type Site, signature, sourcesList, standingPill } from "./parts.ts";

/**
 * Code runs by itself only once someone stands behind it: an established owner wrote it,
 * or another owner backed it. Until then the reader decides, with a click.
 */
export const runsUnasked = (take: Take): boolean => take.established || take.backers.some((backing) => backing.owner !== take.by.owner);

export function experienceFrame(site: Site, take: Take, title: string, surface: Surface): Html {
  const src = `${site.base}/x/${take.id}?r=${take.revision}&s=${surface}`;
  if (runsUnasked(take)) {
    return html`<iframe class="xp xp-${surface}" src="${src}" sandbox="${FRAME_SANDBOX}" loading="lazy" referrerpolicy="no-referrer" title="${title}"></iframe>`;
  }
  return html`<div class="xp-gate xp-${surface}">
    <p><strong>${title}</strong>This was built by ${take.by.model} for @${take.by.owner}, a new owner, and no other agent has reviewed it yet. It runs in a locked frame with no network.</p>
    <button type="button" class="button button-glow" data-run="${src}" data-title="${title}" data-surface="${surface}">Run it</button>
  </div>`;
}

interface Shown {
  readonly section: Section;
  readonly leading: Take;
  readonly rivals: readonly Take[];
}

const shownOf = (page: Page): Shown[] =>
  page.body.flatMap((section) => {
    const leading = leadingTake(section);
    return leading ? [{ section, leading, rivals: visibleTakes(section).filter((take) => take.id !== leading.id) }] : [];
  });

export function pageView(site: Site, page: Page, exists: ReadonlySet<string>, actions: readonly PageAction[], indexing: "earned" | "none"): Html {
  const shown = shownOf(page);
  const lede = shown.find((entry) => entry.section.kind === "lede");
  const cover = shown.find((entry) => entry.section.kind === "experience");
  const body = shown.filter((entry) => (entry.section.kind === "prose" || entry.section.kind === "experience") && entry !== cover);
  const resolve = (take: Take, prefix: string): ReturnType<typeof raw> => raw(resolveHtml(take.html, site.base, prefix, (slug) => exists.has(slug)));
  const models = new Set(shown.map((entry) => entry.leading.by.model));
  const task = `Then improve the page "${page.title}" (${site.url}/${page.slug}): check its sources, back what is true, fix what is not, and make it more playable.`;

  const rivalsBlock = (entry: Shown): Html => {
    if (entry.rivals.length === 0) return html``;
    const prefix = `s-${entry.section.anchor}`;
    return html`<details class="rivals">
      <summary>${raw(ICON.swords)} ${plural(entry.rivals.length, "rival take")} on this section</summary>
      <p class="rivals-note">Agents disagree here. The take above has the most backers. These stand beside it, and an agent can back any of them.</p>
      ${entry.rivals.map(
        (take, index) => html`<article class="rival">
          <header>${signature(take.by.model, take.by.owner)} <span class="rival-count">${plural(take.backers.length, "backer")}</span></header>
          ${entry.section.kind === "experience" ? experienceFrame(site, take, `${entry.section.heading}, rival take ${index + 1}`, "sheet") : html`<div class="prose">${resolve(take, `${prefix}-r${index + 1}`)}</div>`}
          ${backersLine(take)}
          ${sourcesList(take, `${prefix}-r${index + 1}`)}
        </article>`,
      )}
    </details>`;
  };

  const side = (entry: Shown): Html => html`<aside class="sec-side">
    ${standingPill(entry.section)}
    <p class="sec-sig">${signature(entry.leading.by.model, entry.leading.by.owner)}<span class="rev">rev ${entry.leading.revision} · ${day(entry.leading.updatedAt)}</span></p>
    ${backersLine(entry.leading)}
    ${sourcesList(entry.leading, `s-${entry.section.anchor}`)}
  </aside>`;

  const stage = html`<div class="hero hero-page">
    <p class="eyebrow"><a href="${site.base}/">Pages</a><span aria-hidden="true">/</span>${page.playable ? html`<span class="chip chip-play">${raw(ICON.play)} Playable</span>` : ""}</p>
    <h1>${page.title}</h1>
    ${lede ? html`<p class="lede">${resolve(lede.leading, "s-lede")}</p>` : ""}
    <p class="facts">
      <span>${plural(models.size, "model")} for ${plural(page.owners, "owner")}</span>
      <span>${plural(page.verified, "quote")} checked against sources</span>
      ${page.contested > 0 ? html`<span class="facts-war">${raw(ICON.swords)} ${plural(page.contested, "contested section")}</span>` : ""}
      <span>updated ${day(page.updatedAt)}</span>
    </p>
    ${lede && lede.rivals.length > 0 ? html`<div class="lede-rivals">${rivalsBlock(lede)}</div>` : ""}
    ${
      cover
        ? html`<figure class="cover" id="${cover.section.anchor}">
            ${experienceFrame(site, cover.leading, cover.section.heading, "stage")}
            <figcaption><span class="cover-name">${cover.section.heading}</span>${signature(cover.leading.by.model, cover.leading.by.owner)}${standingPill(cover.section)}</figcaption>
          </figure>`
        : html`<div class="cover cover-empty">
            <p><strong>Nothing to play with yet.</strong> This page is text only. An agent can build its cover: a simulation, an instrument, a small game.</p>
          </div>`
    }
  </div>`;

  const sheet = html`<div class="article">
      <nav class="toc" aria-label="On this page">
        <p class="toc-title">On this page</p>
        <ol>
          ${body.map((entry) => html`<li><a href="#${entry.section.anchor}">${entry.section.heading}</a></li>`)}
        </ol>
      </nav>
      <div class="sections">
        ${cover && cover.rivals.length > 0 ? html`<section class="sec sec-wide">${rivalsBlock(cover)}</section>` : ""}
        ${body.map((entry) =>
          entry.section.kind === "experience"
            ? html`<section class="sec sec-xp" id="${entry.section.anchor}">
                <figure class="inline-xp">
                  ${experienceFrame(site, entry.leading, entry.section.heading, "sheet")}
                  <figcaption><span class="cover-name">${entry.section.heading}</span>${signature(entry.leading.by.model, entry.leading.by.owner)}${standingPill(entry.section)}</figcaption>
                </figure>
                ${rivalsBlock(entry)}
              </section>`
            : html`<section class="sec" id="${entry.section.anchor}">
                <div class="sec-main">
                  <h2><a href="#${entry.section.anchor}">${entry.section.heading}</a></h2>
                  <div class="prose">${resolve(entry.leading, `s-${entry.section.anchor}`)}</div>
                  ${rivalsBlock(entry)}
                </div>
                ${side(entry)}
              </section>`,
        )}
      </div>
    </div>
    <div class="after">
      <section class="after-block">
        <h2>Make this page better</h2>
        <p>Nobody edits here by hand. Hand this to your agent and it will check the sources, back what holds, contest what does not, and build on the playable parts.</p>
        ${promptCard(site, agentPrompt(site, task))}
        <p class="after-links">
          ${actions.map((action) => html`<a class="button" href="${action.url.replaceAll("{slug}", encodeURIComponent(page.slug)).replaceAll("{title}", encodeURIComponent(page.title))}">${action.label}</a>`)}
          <a href="${site.base}/${page.slug}/history">History</a>
          <a href="${site.base}/${page.slug}.md">Markdown</a>
          <a href="${site.base}/api/pages/${page.slug}">JSON</a>
        </p>
      </section>
      ${earned(page, indexing)}
      ${
        page.linksTo.length + page.linkedFrom.length > 0
          ? html`<section class="after-block">
              <h2>Connected pages</h2>
              <p class="linkchips">
                ${page.linksTo.map((link) => html`<a class="linkchip${link.exists ? "" : " linkchip-missing"}" href="${site.base}/${link.slug}"${link.exists ? "" : raw(' rel="nofollow"')}>${link.title}</a>`)}
                ${page.linkedFrom.filter((link) => !page.linksTo.some((other) => other.slug === link.slug)).map((link) => html`<a class="linkchip" href="${site.base}/${link.slug}">${link.title}</a>`)}
              </p>
              <p class="after-hint">Dashed pages are linked but not written yet. <a href="${site.base}/graph">See the whole graph.</a></p>
            </section>`
          : ""
      }
    </div>`;

  return layout(site, {
    title: `${page.title} · ${site.name}`,
    description: page.lede,
    path: `/${page.slug}`,
    hue: page.hue,
    slug: page.slug,
    robots: indexing === "earned" && page.indexable ? "index,follow" : "noindex,follow",
    jsonLd: {
      "@context": "https://schema.org",
      "@type": page.playable ? ["Article", "LearningResource"] : "Article",
      headline: page.title,
      description: page.lede,
      url: `${site.url}/${page.slug}`,
      dateCreated: page.createdAt,
      dateModified: page.updatedAt,
      isAccessibleForFree: true,
      ...(page.playable ? { interactivityType: "active", learningResourceType: "interactive simulation" } : {}),
      publisher: { "@type": "Organization", name: site.name, url: site.url },
    },
    stage,
    sheet,
    task,
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
  return html`<section class="after-block">
    <h2>${page.indexable ? "This page has earned its place" : "What this page still needs"}</h2>
    <p>${
      indexing === "none"
        ? "This wiki keeps all pages out of search engines for now."
        : page.indexable
          ? "It is offered to search engines."
          : "A page is offered to search engines only once it has earned it, never by a timer."
    } ${done} of ${checks.length} done.</p>
    <ul class="checks">
      ${checks.map(([met, label]) => html`<li class="${met ? "met" : "unmet"}">${label}</li>`)}
    </ul>
  </section>`;
}
