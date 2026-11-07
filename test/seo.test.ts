import assert from "node:assert/strict";
import { test } from "node:test";
import { readConfig } from "../src/config.ts";
import type { PageSummary } from "../src/domain/model.ts";
import { build } from "../src/server.ts";
import { DESCRIPTION_MAX, DESCRIPTION_MIN, fitDescription, fitTitle, TITLE_MAX } from "../src/ui/fit.ts";
import { homeView } from "../src/ui/home.ts";
import type { Site } from "../src/ui/parts.ts";
import { PAGE } from "./helpers.ts";

const boot = (env: Record<string, string> = {}) => build({ DATA_DIR: ":memory:", VERIFY_SOURCES: "off", VERIFY_RENDER: "off", PUBLIC_ORIGIN: "https://wiki.test", ...env });

const ORG = {
  "@type": "Organization",
  "@id": "https://acme.example/#org",
  name: "Acme",
  url: "https://acme.example",
  logo: "https://acme.example/logo.png",
  sameAs: ["https://github.com/acme"],
  founder: { "@id": "https://acme.example/#ada" },
};
const FOUNDER = { "@type": "Person", "@id": "https://acme.example/#ada", name: "Ada" };

const tag = (html: string, pattern: RegExp): string => html.match(pattern)?.[1] ?? "";
const titleOf = (html: string) => tag(html, /<title>([^<]*)<\/title>/u);
const descriptionOf = (html: string) => tag(html, /<meta name="description" content="([^"]*)">/u);
const graphOf = (html: string): Record<string, unknown>[] => {
  const block = tag(html, /<script type="application\/ld\+json">([\s\S]*?)<\/script>/u);
  return block ? ((JSON.parse(block) as { "@graph": Record<string, unknown>[] })["@graph"] ?? []) : [];
};

test("a title drops its optional parts lowest rank first, and is never cut mid-word", () => {
  const brand = { text: " · Vizipedia", drop: 1 };
  const kind = { text: ": interactive visualization", drop: 2 };
  assert.equal(fitTitle(["Bloom filter", kind, brand]), "Bloom filter: interactive visualization · Vizipedia");
  // 2026-11-07 audit: 66 and 69 chars. The wiki's name goes first: the subject's words are what a search matches.
  assert.equal(fitTitle(["Diffie-Hellman key exchange", kind, brand]), "Diffie-Hellman key exchange: interactive visualization");
  assert.equal(fitTitle(["YouTube Shorts recommendations", kind, brand]), "YouTube Shorts recommendations: interactive visualization");
  const long = "The history of the many ways people have measured the speed of light in a vacuum";
  const fitted = fitTitle([long, kind, brand]);
  assert.ok(fitted.length <= TITLE_MAX, fitted);
  assert.ok(long.startsWith(fitted) && long[fitted.length] === " ", `cut at a word: "${fitted}"`);
  assert.doesNotMatch(fitted, /\s(?:of|in|the|a)$/u, "no dangling word");
});

test("a description keeps whole sentences, else a whole clause, else whole words, always within 70-160", () => {
  const short = "Interactive visualization of PageRank: a random surfer scores a page.";
  assert.equal(fitDescription(short), short);
  // From the 2026-11-07 audit: 201 chars, two sentences. The first fits.
  const pagerank =
    "Interactive visualization of PageRank: PageRank scores a web page by how often a random surfer, clicking from link to link, would land on it. It was the link analysis at the heart of Google's first ranking.";
  assert.equal(
    fitDescription(pagerank),
    "Interactive visualization of PageRank: PageRank scores a web page by how often a random surfer, clicking from link to link, would land on it.",
  );
  // One long sentence: it ends on a clause, marked as cut.
  const bayes =
    "Interactive visualization of Bayes' theorem: Bayes' theorem says how much to believe something after new evidence: your prior belief, reweighed by how likely the evidence is if the thing is true versus if it is not";
  const clause = fitDescription(bayes);
  assert.ok(clause.endsWith("…") && clause.length <= DESCRIPTION_MAX && clause.length >= DESCRIPTION_MIN, clause);
  assert.ok(bayes.startsWith(clause.slice(0, -1)), clause);
  // No clause either: whole words.
  const words = `Interactive visualization of ${"word ".repeat(60)}end`;
  const cut = fitDescription(words);
  assert.ok(cut.length <= DESCRIPTION_MAX && /word…$/u.test(cut), cut);
});

test("every view serves its title and description within budget, however long the page's words", async () => {
  const { app, db } = await boot({ TRUSTED_OWNERS: "ada" });
  const key = (
    (await (await app.request("/api/keys", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ handle: "ada" }) })).json()) as { key: string }
  ).key;
  const title = "YouTube Shorts recommendations and watch history";
  // A lede may be 200 characters; with "Interactive visualization of <title>: " in front, 250.
  const lede =
    "YouTube Shorts recommendations fill the swipeable Shorts feed, where people decide in a second whether to keep watching, so the system learns from swipes, replays and how long a viewer stays.";
  const created = await app.request("/api/pages", {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
    body: JSON.stringify({ ...PAGE, title, lede, model: "claude-opus-5-5" }),
  });
  assert.equal(created.status, 201, await created.clone().text());
  const slug = ((await created.json()) as { url: string }).url.split("/").at(-1);
  for (const path of ["/", `/${slug}`, "/tag/reach", "/rules", "/changes", `/${slug}/history`, `/search?q=${"long query ".repeat(7)}`]) {
    const html = await (await app.request(path)).text();
    assert.ok(titleOf(html).length > 0 && titleOf(html).length <= TITLE_MAX, `${path}: title "${titleOf(html)}"`);
    assert.ok(descriptionOf(html).length <= DESCRIPTION_MAX, `${path}: description "${descriptionOf(html)}"`);
  }
  const home = await (await app.request("/")).text();
  assert.ok(descriptionOf(home).length >= DESCRIPTION_MIN, descriptionOf(home));
  await db.close();
});

test("a configured publisher is on every page: its nodes in the graph, and the page names it by id", async () => {
  const { app, db } = await boot({ TRUSTED_OWNERS: "ada", BY_JSONLD: JSON.stringify({ "@context": "https://schema.org", "@graph": undefined, ...ORG }) });
  const withFounder = await boot({ TRUSTED_OWNERS: "ada", BY_JSONLD: JSON.stringify([ORG, FOUNDER]) });
  const key = (
    (await (await withFounder.app.request("/api/keys", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ handle: "ada" }) })).json()) as {
      key: string;
    }
  ).key;
  await withFounder.app.request("/api/pages", {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
    body: JSON.stringify({ ...PAGE, model: "claude-opus-5-5" }),
  });
  for (const path of ["/", "/reach-decay", "/tag/reach", "/rules", "/changes"]) {
    const graph = graphOf(await (await withFounder.app.request(path)).text());
    const org = graph.find((node) => node["@type"] === "Organization");
    assert.deepEqual(org, ORG, `${path}: the Organization as the host gave it`);
    assert.ok(
      graph.some((node) => node["@id"] === FOUNDER["@id"]),
      `${path}: what it references travels with it`,
    );
    assert.ok(!JSON.stringify(graph).includes('"@context"'), `${path}: one context, on the graph`);
  }
  const article = graphOf(await (await withFounder.app.request("/reach-decay")).text()).find((node) => Array.isArray(node["@type"]));
  assert.deepEqual(article?.publisher, { "@id": ORG["@id"] });
  const website = graphOf(await (await withFounder.app.request("/")).text()).find((node) => node["@type"] === "WebSite");
  assert.deepEqual(website?.publisher, { "@id": ORG["@id"] });
  // A lone node, "@context" and all, is taken too.
  assert.equal(graphOf(await (await app.request("/rules")).text())[0]?.name, "Acme");
  await db.close();
  await withFounder.db.close();
});

test("without a publisher no page names one it was not given; a malformed one stops the boot", () => {
  assert.equal(readConfig({}).publisher, undefined);
  assert.equal(readConfig({}).by, undefined, "the wiki names nobody it was not told to");
  assert.throws(() => readConfig({ BY_JSONLD: "{nope" }));
  assert.throws(() => readConfig({ BY_JSONLD: JSON.stringify({ "@type": "Person", name: "Ada" }) }), /Organization/u);
  assert.throws(() => readConfig({ BY_JSONLD: JSON.stringify({ "@type": "Organization", name: "Acme", url: "acme.example" }) }), /absolute url/u);
  assert.equal(readConfig({ BY_JSONLD: JSON.stringify({ "@type": "NewsMediaOrganization", name: "Acme", url: "https://acme.example" }) }).publisher?.organization.name, "Acme");
});

test("the home's link preview shows the newest page that has a picture", async () => {
  const site: Site = {
    name: "Vizipedia",
    base: "",
    url: "https://wiki.test",
    identity: "local",
    keyUrl: undefined,
    signInUrl: undefined,
    repoUrl: "https://example.org/repo",
    by: undefined,
    publisher: undefined,
    live: "poll",
    analytics: undefined,
    assets: { css: "", js: "", graph: "", analytics: "", font: "", text: "", icon: "" },
  };
  const summary = (slug: string, poster: boolean): PageSummary => ({
    slug,
    title: slug,
    hue: 0,
    lede: "",
    createdAt: "2026-11-07T00:00:00.000Z",
    updatedAt: "2026-11-07T00:00:00.000Z",
    sections: 1,
    owners: 1,
    playable: true,
    verified: 0,
    indexable: true,
    cover: { version: `v-${slug}`, kind: "experience", gated: false, poster },
    tags: [],
    facts: [],
    reading: [],
  });
  const data = { stats: { pages: 2, versions: 2, owners: 1, models: 1 }, sort: "updated" as const, wire: [], tags: [] };
  const html = String(await homeView(site, { ...data, pages: [summary("no-picture", false), summary("pictured", true)] }));
  assert.match(html, /<meta property="og:image" content="https:\/\/wiki.test\/x\/v-pictured\/poster">/u);
  assert.equal(html.match(/name="twitter:card"/gu)?.length, 1, "one card type, not two");
  const bare = String(await homeView(site, { ...data, pages: [] }));
  assert.doesNotMatch(bare, /og:image/u);
  assert.match(bare, /<meta name="twitter:card" content="summary">/u);
});
