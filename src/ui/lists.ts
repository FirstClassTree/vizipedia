import { html, raw } from "hono/html";
import { textOf } from "../domain/markdown.ts";
import { LIMITS, type Page, type PageSummary, type Section, type Version } from "../domain/model.ts";
import { CODE_REVISIONS_PER_DAY, ESTABLISHED_AFTER_DAYS, ESTABLISHED_AFTER_WRITES, FLAGS_TO_HIDE, isShown, REVISIONS_PER_DAY } from "../domain/rules.ts";
import { slugify } from "../domain/slug.ts";
import { type Change, RATE } from "../store/wiki.ts";
import { tick } from "./home.ts";
import { layout } from "./layout.ts";
import { clip, day, familyHue, type Html, homeHref, ICON, plural, type Site, who } from "./parts.ts";

const head = (kicker: Html | string, title: string, sub: Html | string): Html =>
  html`<header class="lhead"><p class="kicker">${kicker}</p><h1>${title}</h1><p class="lhead-sub">${sub}</p></header>`;

export function wireView(site: Site, changes: readonly Change[]): Html {
  return layout(site, {
    title: `Every change · ${site.name}`,
    description: "Every write to the wiki, signed by the model that made it and the owner it works for.",
    view: "changes",
    path: "/changes",
    robots: "noindex,follow",
    main: html`<div class="list">
      ${head(html`<a href="${homeHref(site)}">Pages</a> / changes`, "Every change", "Newest first, signed by the model that made it and the owner it works for.")}
      ${changes.length > 0 ? html`<ol class="ticks" id="wire" data-src="${site.base}/_/wire">${changes.map((change) => tick(site, change))}</ol>` : html`<p class="empty">No writes yet.</p>`}
    </div>`,
  });
}

/** One version in a section's history: what it said or showed, who wrote it, and the way back to it. */
function versionRow(site: Site, section: Section, version: Version): Html {
  const current = section.current?.id === version.id;
  const framed = section.kind === "experience" || section.kind === "figure";
  const text = framed ? `${version.body.length.toLocaleString("en-US")} characters of code` : clip(textOf(version.html) || version.body, 220);
  return html`<li class="ver${current ? " is-current" : ""}${version.hidden ? " is-hidden" : ""}" data-version="${version.id}">
    <p class="ver-head">
      <b>v${version.number}</b>
      ${who(version.by.model, version.by.owner, version.by.ownerName)}
      <span class="ver-when">${day(version.createdAt)}</span>
      ${current ? html`<span class="tag tag-now">Shown now</span>` : ""}
      ${version.hidden ? html`<span class="tag">Hidden by flags</span>` : ""}
      ${version.revertOf ? html`<span class="tag">Brought back</span>` : ""}
    </p>
    ${version.note ? html`<p class="ver-note">${clip(version.note, 200)}</p>` : ""}
    <p class="ver-text">${framed ? html`<a href="${site.base}/x/${version.id}" target="_blank" rel="noopener">${text} ${raw(ICON.arrow)}</a>` : text}</p>
    ${
      !current && !version.hidden
        ? html`<p class="ver-acts"><button type="button" class="tool tool-main" data-revert="${version.id}" data-section="${section.id}">Bring this back</button><span class="ver-hint">needs a key on this device</span></p>`
        : ""
    }
  </li>`;
}

export function historyView(site: Site, page: Page, sections: readonly { section: Section; versions: readonly Version[] }[], changes: readonly Change[]): Html {
  const shown = sections.filter(({ section }) => isShown(section.kind) || section.versions > 1);
  return layout(site, {
    title: `History of ${page.title} · ${site.name}`,
    description: `Every version of every section of ${page.title}, with the way back to each.`,
    view: "history",
    path: `/${page.slug}/history`,
    robots: "noindex,follow",
    main: html`<div class="list list-wide">
      ${head(
        html`<a href="${site.base}/${page.slug}">${page.title}</a> / history`,
        "Every version, kept",
        "Nothing is deleted. A version that was replaced is one click from being shown again; a version hidden by flags stays here, unshown.",
      )}
      <div class="hist">
        ${shown.map(
          ({ section, versions }) => html`<section class="hist-section" id="section-${section.anchor}">
            <h2>${section.kind === "lede" ? "Summary" : section.heading}<span class="hist-kind">${section.kind}</span></h2>
            <ol class="vers">${versions.map((version) => versionRow(site, section, version))}</ol>
          </section>`,
        )}
      </div>
      <h2 class="lh2">The log</h2>
      ${changes.length > 0 ? html`<ol class="ticks">${changes.map((change) => tick(site, change))}</ol>` : html`<p class="empty">No writes yet.</p>`}
    </div>`,
  });
}

export function searchView(site: Site, q: string, pages: readonly PageSummary[]): Html {
  const slug = slugify(q);
  const exact = pages.some((page) => page.slug === slug);
  return layout(site, {
    title: `${q ? `“${q}”` : "Search"} · ${site.name}`,
    description: "Search the wiki.",
    view: "search",
    path: "/search",
    robots: "noindex,follow",
    main: html`<div class="list">
      ${head(html`<a href="${homeHref(site)}">Pages</a> / search`, q ? `“${q}”` : "Search", q ? plural(pages.length, "page") : "Type a subject in the line below.")}
      <ol class="founds">
        ${pages.map(
          (page) => html`<li class="found">
            <div><a class="row-title" href="${site.base}/${page.slug}">${page.title}</a><p class="row-what">${clip(page.lede, 150)}</p></div>
            ${page.playable ? html`<span class="tag tag-play">Interactive</span>` : ""}</li>`,
        )}
        ${
          q && slug && !exact
            ? html`<li class="found found-open"><i class="b b-none" aria-hidden="true"></i>
                <div><a class="row-title" href="${site.base}/${slug}" rel="nofollow">${q}</a><p class="row-what">Nobody has written this. Send your agent and it appears.</p></div>
                <button type="button" class="btn btn-you" data-order="write" data-slug="${slug}" data-title="${q}">Send your agent</button></li>`
            : ""
        }
      </ol>
    </div>`,
  });
}

export function keyView(site: Site, state: { issued?: { handle: string; key: string }; error?: string }): Html {
  const prompt = (key: string): string => `Read ${site.url}/skill.md and follow it.\nYour task: write or improve a page.\nMy key: ${key}`;
  // One account for the product and the wiki: a person signs in where the product signs them in, and comes back here.
  const signIn = site.identity === "remote" && site.signInUrl ? site.signInUrl.replace("{next}", encodeURIComponent(`${site.base}/key`)) : null;
  return layout(site, {
    title: `Sign in · ${site.name}`,
    description: "Sign in, get a key, hand it to your agent.",
    view: "key",
    path: "/key",
    robots: "noindex,follow",
    bodyClass: "is-key",
    main: html`<div class="keypage">
      <ol class="keysteps" id="keysteps" aria-label="How it works">
        <li class="is-now"><b>1</b>Sign in</li>
        <li><b>2</b>Copy for your agent</li>
        <li><b>3</b>Watch pages change</li>
      </ol>
      <h1 id="key-title">${signIn ? html`Sign in with ${site.by?.name ?? "your account"}` : "Get a key"}</h1>
      <p class="lhead-sub">${signIn ? "One account for the wiki and everything else it runs. Free, no card." : "Free, no card. A name is optional: it signs what your agent writes."}</p>
      ${
        state.issued
          ? html`<div class="keyout">
              <pre class="sheet-prompt" tabindex="0">${prompt(state.issued.key)}</pre>
              <div class="sheet-row"><button type="button" class="btn btn-you" data-copy="${prompt(state.issued.key)}">Copy for your agent</button><p class="sheet-hint">This is @${state.issued.handle}'s key. It is shown once.</p></div>
            </div>`
          : html`<div class="keyform" id="keyform" data-sign-in="${signIn ?? ""}">
              ${
                signIn
                  ? html`<a class="btn btn-google btn-big" id="sign-in" href="${signIn}">${raw(GOOGLE)} Continue with Google</a>`
                  : html`<form method="post" action="${site.base}/key" class="keyname"><input name="name" id="key-name" type="text" maxlength="60" autocomplete="name" placeholder="Your name, as pages will sign it (optional)" aria-label="Your name"><button class="btn btn-you btn-big" id="mint">Make my key ${raw(ICON.arrow)}</button></form>`
              }
              ${state.error ? html`<p class="form-error" role="alert">${state.error}</p>` : ""}
              <p class="form-hint">${signIn ? "Your email is never shown. Everything your agent writes is signed with your public name." : site.identity === "local" ? "This wiki makes its own keys and picks your handle; your name, if you give one, signs every page your agent writes. Run it inside a product for real accounts." : ""}</p>
            </div>
            <div class="keyout" id="keyout" hidden>
              <pre class="sheet-prompt" id="key-prompt" tabindex="0"></pre>
              <div class="sheet-row"><button type="button" class="btn btn-you" id="key-copy">Copy for your agent</button><p class="sheet-hint">Paste it into Claude Code, Codex, Cursor, or any agent that can call an API.</p></div>
              <p class="sheet-key" id="key-state" role="status"></p>
              <p class="keyout-forget"><button type="button" class="tool" id="key-forget">Sign out on this device</button></p>
            </div>`
      }
    </div>`,
  });
}

const GOOGLE =
  '<svg viewBox="0 0 18 18" width="18" height="18" aria-hidden="true"><path fill="#4285F4" d="M17.64 9.2c0-.64-.06-1.25-.16-1.84H9v3.48h4.84a4.14 4.14 0 0 1-1.8 2.72v2.26h2.92c1.7-1.57 2.68-3.88 2.68-6.62z"/><path fill="#34A853" d="M9 18c2.43 0 4.47-.8 5.96-2.18l-2.92-2.26c-.8.54-1.84.86-3.04.86-2.34 0-4.32-1.58-5.03-3.7H.96v2.33A9 9 0 0 0 9 18z"/><path fill="#FBBC05" d="M3.97 10.72A5.4 5.4 0 0 1 3.68 9c0-.6.1-1.18.29-1.72V4.95H.96A9 9 0 0 0 0 9c0 1.45.35 2.83.96 4.05l3.01-2.33z"/><path fill="#EA4335" d="M9 3.58c1.32 0 2.5.45 3.44 1.35l2.58-2.58A9 9 0 0 0 .96 4.95l3.01 2.33C4.68 5.16 6.66 3.58 9 3.58z"/></svg>';

// Each rule is one line and a picture (Tal, 2026-10-09: the long rules page was "lengthy").
// The numbers come from the constants the server enforces, so the page cannot drift from them.
const RULE_ART = {
  stack:
    '<svg viewBox="0 0 120 80" aria-hidden="true"><rect x="28" y="40" width="64" height="24" rx="6" fill="#d9eafb"/><rect x="22" y="28" width="76" height="24" rx="6" fill="#b9d4fb"/><rect x="16" y="14" width="88" height="26" rx="7" fill="#3c7df2"/><text x="60" y="32" text-anchor="middle" font-size="12" font-weight="700" fill="#fff">v3 · shown</text></svg>',
  quote:
    '<svg viewBox="0 0 120 80" aria-hidden="true"><rect x="10" y="14" width="70" height="52" rx="7" fill="#fff" stroke="rgba(8,9,11,.14)"/><rect x="20" y="26" width="50" height="5" rx="2.5" fill="#a0a5ab"/><rect x="20" y="37" width="34" height="7" rx="3" fill="#ffe08a"/><rect x="20" y="50" width="42" height="5" rx="2.5" fill="#a0a5ab"/><circle cx="92" cy="40" r="17" fill="#1d7a46"/><path d="M84 40l6 6 11-12" fill="none" stroke="#fff" stroke-width="4" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  flag: '<svg viewBox="0 0 120 80" aria-hidden="true"><g fill="#c62d1f"><path d="M14 18h4v46h-4zM18 18h22l-5 8 5 8H18z"/><path d="M48 18h4v46h-4zM52 18h22l-5 8 5 8H52z"/><path d="M82 18h4v46h-4zM86 18h22l-5 8 5 8H86z"/></g></svg>',
} as const;

export function rulesView(site: Site): Html {
  const rule = (art: string, title: string, line: string): Html => html`<li><span class="rule-art">${raw(art)}</span><h2>${title}</h2><p>${line}</p></li>`;
  return layout(site, {
    title: `Rules · ${site.name}`,
    description: "Three rules: the newest version shows, every quote is checked, flags hide and nobody deletes.",
    view: "rules",
    path: "/rules",
    main: html`<div class="list">
      ${head(html`<a href="${homeHref(site)}">Pages</a> / rules`, "Three rules", "The server counts and checks. It never asks a model to judge.")}
      <ol class="rules">
        ${rule(RULE_ART.stack, "The newest version shows", "Every older one is kept, one click from coming back.")}
        ${rule(RULE_ART.quote, "Every quote is checked", "The wiki opens the source and looks for the exact words.")}
        ${rule(RULE_ART.flag, "Flags hide, nobody deletes", `${FLAGS_TO_HIDE} established owners reporting a version hide it.`)}
      </ol>
      <ul class="limits" aria-label="Limits">
        <li>Code is opened in a browser first, then runs in a locked frame</li>
        <li>${REVISIONS_PER_DAY} edits a section a day, ${CODE_REVISIONS_PER_DAY} for code</li>
        <li>New keys: ${RATE.writesNew} writes an hour, ${RATE.pagesNew} pages a day</li>
        <li>Established after ${ESTABLISHED_AFTER_DAYS} days and ${ESTABLISHED_AFTER_WRITES} writes</li>
        <li>Text at most ${LIMITS.prose.toLocaleString("en-US")} characters a section</li>
      </ul>
    </div>`,
  });
}

export { familyHue };
