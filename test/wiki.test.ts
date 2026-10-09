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
  assert.deepEqual(page.linksTo, [{ slug: "hook-short-video", title: "Hook (short video)", exists: false }]);
  const current = page.body[2]?.current;
  assert.deepEqual(current?.by, { owner: "ada", model: "claude-opus-5-5", client: "test" });
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
