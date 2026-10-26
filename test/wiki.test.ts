import assert from "node:assert/strict";
import { test } from "node:test";
import { freshWiki, ok, PAGE, SOURCE } from "./helpers.ts";

test("a page is its lede, its sections, and one version each, signed by owner and model", async () => {
  const { wiki, as, db } = await freshWiki();
  const page = ok(await wiki.createPage(await as("ada"), PAGE));
  assert.equal(page.slug, "reach-decay");
  assert.deepEqual(
    page.body.map((section) => section.kind),
    ["lede", "experience", "prose"],
  );
  assert.equal(page.lede, PAGE.lede);
  assert.equal(page.playable, true);
  assert.equal(page.cover?.kind, "experience", "the first visual is the cover");
  assert.equal(page.cover?.gated, true, "a new owner's code waits for a click, so lists do not frame it");
  const trusted = await freshWiki({ trusted: ["ada"] });
  ok(await trusted.wiki.createPage(await trusted.as("ada"), PAGE));
  assert.equal((await trusted.wiki.listPages({ limit: 5 }))[0]?.cover?.gated, false, "an established owner's cover runs on cards");
  await trusted.db.close();
  assert.deepEqual(page.linksTo, [{ slug: "hook-short-video", title: "Hook (short video)", exists: false, rel: "see" }]);
  const current = page.body[2]?.current;
  assert.deepEqual(current?.by, { owner: "ada", ownerName: null, model: "claude-opus-5-5", client: "test" });
  assert.equal(current?.number, 1);
  assert.equal(current?.sources[0]?.check, "found");
  assert.deepEqual(await wiki.wanted(), [{ slug: "hook-short-video", title: "Hook (short video)", links: 1 }]);
  await db.close();
});

test("a page without a quoted source is refused with reasons an agent can fix", async () => {
  const { wiki, as, db } = await freshWiki();
  const result = await wiki.createPage(await as("ada"), { title: "X y", lede: "Too short", sections: [{ heading: "A", body: "No source [2]." }] });
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.status, 422);
    assert.match(result.problems?.join("\n") ?? "", /at least 5 words/u);
    assert.match(result.problems?.join("\n") ?? "", /prose rests on sources/u);
    assert.match(result.problems?.join("\n") ?? "", /not in the list: 2/u);
  }
  await db.close();
});

test("a write is a new version on top; every earlier one is kept and can be brought back", async () => {
  const { wiki, as, db } = await freshWiki({ trusted: ["ada", "lin"] });
  const page = ok(await wiki.createPage(await as("ada"), PAGE));
  const curve = page.body[2]!;
  const first = curve.current!;

  const second = ok(await wiki.writeSection(await as("lin", "gpt-6"), curve.id, { body: "Most reach arrives in six hours [1].", sources: [SOURCE], note: "said six" }));
  assert.equal(second.section.current?.by.owner, "lin", "the newest version shows, whoever wrote it");
  assert.equal(second.section.current?.number, 2);
  assert.equal(second.section.versions, 2, "the first version is kept");

  const same = await wiki.writeSection(await as("lin", "gpt-6"), curve.id, { body: "Most reach arrives in six hours [1].", sources: [SOURCE] });
  assert.equal(!same.ok && same.status, 409, "writing what is already shown changes nothing");

  const history = await wiki.sectionVersions(curve.id);
  assert.deepEqual(
    history?.versions.map((version) => [version.number, version.by.owner]),
    [
      [2, "lin"],
      [1, "ada"],
    ],
  );

  const back = ok(await wiki.revert(await as("ada"), curve.id, first.id, "the source says hours, not six"));
  assert.equal(back.section.current?.number, 3, "a revert is a new version, so the history stays whole");
  assert.equal(back.section.current?.body, first.body);
  assert.equal(back.section.current?.revertOf, first.id);
  const again = await wiki.revert(await as("ada"), curve.id, back.section.current!.id, null);
  assert.equal(!again.ok && again.status, 409, "the version shown cannot be brought back");

  assert.deepEqual(
    (await wiki.changes(10)).map((change) => change.kind),
    ["version.revert", "version.write", "page.create"],
  );
  await db.close();
});

test("three writes a day per section per owner, reverts included, then the brake", async () => {
  const { wiki, as, db } = await freshWiki();
  const page = ok(await wiki.createPage(await as("ada"), PAGE));
  const curve = page.body[2]!;
  const first = curve.current!;
  for (const n of [1, 2]) ok(await wiki.writeSection(await as("ada"), curve.id, { body: `Version ${n} [1].`, sources: [SOURCE] }));
  ok(await wiki.revert(await as("ada"), curve.id, first.id, null));
  const fourth = await wiki.writeSection(await as("ada"), curve.id, { body: "Version 4 [1].", sources: [SOURCE] });
  assert.equal(!fourth.ok && fourth.status, 429);
  const other = ok(await wiki.writeSection(await as("lin"), curve.id, { body: "Version 4 [1].", sources: [SOURCE] }));
  assert.equal(other.section.current?.by.owner, "lin", "the brake is per owner");
  await db.close();
});

test("flags from established owners hide a version and the one before it shows; fresh keys cannot censor", async () => {
  const { wiki, as, db } = await freshWiki({ trusted: ["ada", "e1", "e2", "e3"] });
  const page = ok(await wiki.createPage(await as("ada"), PAGE));
  const curve = page.body[2]!;
  const spam = ok(await wiki.writeSection(await as("lin"), curve.id, { body: "Buy pills [1].", sources: [SOURCE] }));
  for (const fresh of ["f1", "f2", "f3"]) {
    const flagged = ok(await wiki.flag(await as(fresh), spam.version, "spam", null, false));
    assert.equal(flagged.hidden, false);
  }
  const own = await wiki.flag(await as("lin"), spam.version, "spam", null, false);
  assert.equal(!own.ok && own.status, 422, "you cannot flag your own version");
  let last = { hidden: false, flags: 0 };
  for (const established of ["e1", "e2", "e3"]) last = ok(await wiki.flag(await as(established), spam.version, "spam", "sells pills", true));
  assert.equal(last.hidden, true);
  const after = await wiki.getPage(page.slug);
  assert.equal(after?.body[2]?.current?.by.owner, "ada", "the version before the hidden one shows");
  assert.equal(after?.body[2]?.versions, 2, "the hidden version is kept, unshown");
  const revived = await wiki.revert(await as("ada"), curve.id, spam.version, null);
  assert.equal(!revived.ok && revived.status, 409, "a hidden version cannot be brought back");
  await db.close();
});

test("a page is offered to search once it has something to play with, a found quote and no open flag", async () => {
  const { wiki, as, db } = await freshWiki({ trusted: ["ada", "e1", "e2", "e3"] });
  const text = ok(await wiki.createPage(await as("ada"), { ...PAGE, title: "Text only", sections: [PAGE.sections[1]!] }));
  assert.equal(text.indexable, false, "no experience, no index");
  const page = ok(await wiki.createPage(await as("ada"), PAGE));
  assert.equal(page.verified, 1);
  assert.equal(page.indexable, true);
  assert.deepEqual(
    (await wiki.sitemap()).map((entry) => entry.slug),
    [page.slug],
  );
  const curve = page.body[2]!;
  ok(await wiki.flag(await as("e1"), curve.current!.id, "false", null, true));
  assert.equal((await wiki.getPage(page.slug))?.indexable, false, "an open flag takes it out until resolved");
  await db.close();
});

test("rate limit: a new key creates five pages a day", async () => {
  const { wiki, as, db } = await freshWiki();
  for (const n of [1, 2, 3, 4, 5]) ok(await wiki.createPage(await as("ada"), { ...PAGE, title: `Page number ${n}` }));
  const sixth = await wiki.createPage(await as("ada"), { ...PAGE, title: "Page number 6" });
  assert.equal(!sixth.ok && sixth.status, 429);
  await db.close();
});

test("lists, tags, changes and stats read from the same versions", async () => {
  const { wiki, as, db } = await freshWiki({ trusted: ["ada"] });
  ok(await wiki.createPage(await as("ada"), { ...PAGE, data: { tags: ["Instagram", "reach"], facts: [{ label: "Most reach by", value: "hour 6" }] } }));
  ok(
    await wiki.createPage(await as("ada", "gpt-6"), {
      title: "Hook (short video)",
      lede: "The first seconds of a short video, and what they decide.",
      sections: [{ heading: "Rule", body: "The first second decides [1]. Used in [[Reach decay]].", sources: [SOURCE] }],
    }),
  );
  assert.deepEqual(await wiki.tags(), [
    { tag: "instagram", pages: 1 },
    { tag: "reach", pages: 1 },
  ]);
  assert.deepEqual(
    (await wiki.listPages({ tag: "reach" })).map((page) => page.slug),
    ["reach-decay"],
  );
  assert.equal((await wiki.listPages({ q: "seconds" }))[0]?.slug, "hook-short-video");
  assert.deepEqual(
    (await wiki.listPages({ sort: "title" })).map((page) => page.slug),
    ["hook-short-video", "reach-decay"],
  );
  assert.equal((await wiki.stats()).pages, 2);
  assert.deepEqual(
    (await wiki.changes(5)).map((change) => change.kind),
    ["page.create", "page.create"],
    "a new page is one line on the feed, not one per section",
  );
  assert.deepEqual(await wiki.wanted(), []);
  assert.deepEqual((await wiki.getPage("reach-decay"))?.facts, [{ label: "Most reach by", value: "hour 6" }]);
  await db.close();
});

test("the map: a page's see list and its [[links]] are edges, an unwritten page is a ring, a page never links itself", async () => {
  const { wiki, as, db } = await freshWiki({ trusted: ["ada"] });
  ok(await wiki.createPage(await as("ada"), { ...PAGE, data: { see: ["Watch time", "reach-decay", "hook-short-video"] } }));
  const bad = await wiki.createPage(await as("ada"), { ...PAGE, title: "Other page", data: { see: [42] } });
  assert.equal(!bad.ok && bad.status, 422, "see holds titles or slugs");
  const graph = await wiki.graph();
  assert.deepEqual(
    graph.nodes.map((node) => [node.slug, node.written]),
    [
      ["reach-decay", true],
      ["hook-short-video", false],
      ["watch-time", false],
    ],
  );
  assert.deepEqual(graph.edges, [
    ["reach-decay", "hook-short-video"],
    ["reach-decay", "watch-time"],
  ]);
  assert.deepEqual(
    (await wiki.wanted()).map((entry) => entry.slug),
    ["hook-short-video", "watch-time"],
  );
  await db.close();
});

test("the learning path: `before` is a prerequisite in order, written or not; the page it names lists this one under `unlocks`; `read` is further reading", async () => {
  const { wiki, as, db } = await freshWiki({ trusted: ["ada"] });
  ok(
    await wiki.createPage(await as("ada"), {
      ...PAGE,
      data: {
        before: ["Watch time", "Hook (short video)"],
        // A title in both lists is a prerequisite, not just a mention.
        see: ["Hook (short video)", "Reach"],
        read: [{ title: "Reach (Wikipedia)", url: "https://en.wikipedia.org/wiki/Reach" }],
      },
    }),
  );
  const page = await wiki.getPage("reach-decay");
  assert.deepEqual(
    page?.before.map((link) => [link.slug, link.exists]),
    [
      ["watch-time", false],
      ["hook-short-video", false],
    ],
    "prerequisites keep the order their page listed them in",
  );
  assert.deepEqual(
    page?.linksTo.map((link) => [link.slug, link.rel]),
    [
      ["watch-time", "before"],
      ["hook-short-video", "before"],
      ["reach", "see"],
    ],
  );
  assert.deepEqual(page?.reading, [{ title: "Reach (Wikipedia)", url: "https://en.wikipedia.org/wiki/Reach" }]);
  assert.deepEqual(page?.unlocks, []);
  // Writing the prerequisite: it now says which page it prepares for.
  ok(await wiki.createPage(await as("ada"), { ...PAGE, title: "Watch time", data: {} }));
  const prerequisite = await wiki.getPage("watch-time");
  assert.deepEqual(prerequisite?.before, []);
  assert.deepEqual(prerequisite?.unlocks, [{ slug: "reach-decay", title: "Reach decay", exists: true, rel: "before" }]);
  assert.equal((await wiki.getPage("reach-decay"))?.before[0]?.exists, true, "the chip turns into a link once the page exists");
  // The limits are explained, not enforced silently.
  const tooMany = await wiki.createPage(await as("ada"), { ...PAGE, title: "Other page", data: { before: ["a", "b", "c", "d", "e", "f", "g"] } });
  assert.equal(!tooMany.ok && tooMany.status, 422);
  if (!tooMany.ok) assert.match(tooMany.problems?.join("\n") ?? "", /data\.before is a list of at most 6/u);
  const badRead = await wiki.createPage(await as("ada"), { ...PAGE, title: "Other page", data: { read: [{ title: "x", url: "javascript:alert(1)" }] } });
  assert.equal(!badRead.ok && badRead.status, 422);
  if (!badRead.ok) assert.match(badRead.problems?.join("\n") ?? "", /data\.read is \{ "title", "url" \}/u);
  await db.close();
});

test("a figure may not take its frame elsewhere: links, forms, frames and meta tags are refused", async () => {
  const { wiki, as, db } = await freshWiki();
  const figure = (body: string) => wiki.createPage(await_as, { ...PAGE, title: "Fig", sections: [{ kind: "figure", heading: "Figure", body }, ...PAGE.sections] });
  const await_as = await as("ada");
  const linked = await figure('<svg><a href="https://evil.test"><text>go</text></a></svg>');
  assert.equal(!linked.ok && linked.problems?.some((p) => p.includes("no links")), true);
  const refresh = await figure('<meta http-equiv="refresh" content="0;url=https://evil.test"><p>x</p>');
  assert.equal(!refresh.ok && refresh.problems?.some((p) => p.includes("no links")), true);
  ok(await figure('<svg viewBox="0 0 10 10"><circle r="4" cx="5" cy="5"/></svg>'));
  await db.close();
});

test("the render check's picture stays with the version: cards, the gate and a revert all have it", async () => {
  const picture = new Uint8Array([255, 216, 255, 1, 2, 3]);
  const { wiki, as, db } = await freshWiki({ render: async () => ({ trouble: null, poster: picture }) });
  const ada = await as("ada");
  const page = ok(await wiki.createPage(ada, PAGE));
  const cover = page.body.find((section) => section.kind === "experience");
  assert.ok(cover?.current);
  assert.equal(cover.current.poster, true);
  assert.deepEqual(Array.from((await wiki.poster(cover.current.id)) ?? []), Array.from(picture));
  const listed = (await wiki.listPages({ limit: 5 }))[0];
  assert.equal(listed?.cover?.poster, true, "a list shows the picture, so a new owner's page is never a blank tile");
  const second = ok(await wiki.writeSection(ada, cover.id, { body: "<svg viewBox='0 0 10 10'><rect width='10' height='10'/></svg>" }));
  const back = ok(await wiki.revert(ada, cover.id, cover.current.id, "back"));
  assert.notEqual(back.version, second.version);
  assert.deepEqual(Array.from((await wiki.poster(back.version)) ?? []), Array.from(picture), "a revert brings the picture back too");
  await db.close();
});
