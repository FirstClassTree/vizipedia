import assert from "node:assert/strict";
import { test } from "node:test";
import { leadingTake, standingOf } from "../src/domain/rules.ts";
import { freshWiki, ok, PAGE, SOURCE } from "./helpers.ts";

test("a page is its lede, its sections, and one take each, signed by owner and model", async () => {
  const { wiki, as, db } = await freshWiki();
  const page = ok(await wiki.createPage(await as("ada"), PAGE));
  assert.equal(page.slug, "monty-hall-problem");
  assert.deepEqual(
    page.body.map((section) => section.kind),
    ["lede", "experience", "prose"],
  );
  assert.equal(page.lede, PAGE.lede);
  assert.equal(page.playable, true);
  assert.deepEqual(page.linksTo, [{ slug: "bayes-theorem", title: "Bayes theorem", exists: false }]);
  const take = leadingTake(page.body[2]!);
  assert.deepEqual(take?.by, { owner: "ada", model: "claude-opus-5-5", client: "test" });
  assert.equal(take?.backers.length, 1, "writing a take is backing it");
  assert.equal(take?.sources[0]?.check, "found");
  assert.deepEqual(await wiki.wanted(), [{ slug: "bayes-theorem", title: "Bayes theorem", links: 1 }]);
  const graph = await wiki.graph();
  assert.deepEqual(
    graph.nodes.map((node) => [node.title, node.written]),
    [
      ["Monty Hall problem", true],
      ["Bayes theorem", false],
    ],
    "a wanted page is a node too",
  );
  assert.deepEqual(graph.edges, [["monty-hall-problem", "bayes-theorem"]]);
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

test("a second owner's edit is a rival take, never an overwrite; backers decide which leads", async () => {
  const { wiki, as, db } = await freshWiki({ trusted: ["ada", "lin", "sol"] });
  const page = ok(await wiki.createPage(await as("ada"), PAGE));
  const answer = page.body[2]!;
  const original = leadingTake(answer)!;

  const rival = ok(await wiki.putTake(await as("lin", "gpt-6"), answer.id, { body: "Only if the host knows where the car is [1].", sources: [SOURCE] }));
  assert.equal(rival.section.takes.length, 2, "both takes stand");
  assert.equal(leadingTake(rival.section)?.by.owner, "lin", "between established owners a tie goes to the newest");
  assert.equal(standingOf(rival.section), "contested");

  const backed = ok(await wiki.back(await as("sol", "gemini-3"), original.id, "matches the cited source"));
  assert.equal(leadingTake(backed.section)?.id, original.id, "two backers beat one");

  const moved = ok(await wiki.back(await as("sol", "gemini-3"), rival.take, null));
  assert.equal(leadingTake(moved.section)?.by.owner, "lin", "one owner, one backing per section: backing the rival moves it");
  assert.equal(moved.section.takes.find((take) => take.id === original.id)?.backers.length, 1);

  const reloaded = await wiki.getPage(page.slug);
  assert.equal(reloaded?.contested, 1);
  assert.equal((await wiki.wars()).length, 1);
  await db.close();
});

test("a new key cannot displace an established owner's take without backers", async () => {
  const { wiki, as, db } = await freshWiki({ trusted: ["ada"] });
  const page = ok(await wiki.createPage(await as("ada"), PAGE));
  const answer = page.body[2]!;
  const result = ok(await wiki.putTake(await as("newcomer"), answer.id, { body: "Vandalised [1].", sources: [SOURCE] }));
  assert.equal(leadingTake(result.section)?.by.owner, "ada");
  await db.close();
});

test("revising your own take keeps its backers and marks what they read", async () => {
  const { wiki, as, db } = await freshWiki({ trusted: ["ada", "lin"] });
  const page = ok(await wiki.createPage(await as("ada"), PAGE));
  const answer = page.body[2]!;
  const take = leadingTake(answer)!;
  ok(await wiki.back(await as("lin"), take.id, null));
  const revised = ok(await wiki.putTake(await as("ada"), answer.id, { body: "Switching wins two times in three [1].", sources: [SOURCE], note: "plainer wording" }));
  const now = leadingTake(revised.section)!;
  assert.equal(now.revision, 2);
  assert.deepEqual(now.backers.map((backing) => [backing.owner, backing.revision]).sort(), [
    ["ada", 2],
    ["lin", 1],
  ]);
  const same = await wiki.putTake(await as("ada"), answer.id, { body: "Switching wins two times in three [1].", sources: [SOURCE] });
  assert.equal(!same.ok && same.status, 409);
  const patrol = await wiki.patrol((await as("lin")).ownerId);
  assert.equal(patrol.find((item) => item.section.id === answer.id)?.why, "revised");
  await db.close();
});

test("three revisions a day per section, then the brake", async () => {
  const { wiki, as, db } = await freshWiki();
  const page = ok(await wiki.createPage(await as("ada"), PAGE));
  const answer = page.body[2]!;
  for (const n of [1, 2, 3]) ok(await wiki.putTake(await as("ada"), answer.id, { body: `Revision ${n} [1].`, sources: [SOURCE] }));
  const fourth = await wiki.putTake(await as("ada"), answer.id, { body: "Revision 4 [1].", sources: [SOURCE] });
  assert.equal(!fourth.ok && fourth.status, 429);
  await db.close();
});

test("flags from established owners hide a take; fresh keys cannot censor", async () => {
  const { wiki, as, db } = await freshWiki({ trusted: ["ada", "e1", "e2", "e3"] });
  const page = ok(await wiki.createPage(await as("ada"), PAGE));
  const answer = page.body[2]!;
  const spam = ok(await wiki.putTake(await as("lin"), answer.id, { body: "Buy pills [1].", sources: [SOURCE] }));
  for (const fresh of ["f1", "f2", "f3"]) {
    const flagged = ok(await wiki.flag(await as(fresh), leadingTake(answer)!.id, "spam", null, false));
    assert.equal(flagged.hidden, false);
  }
  let last = { hidden: false, flags: 0 };
  for (const established of ["e1", "e2", "e3"]) last = ok(await wiki.flag(await as(established), spam.take, "spam", "sells pills", true));
  assert.equal(last.hidden, true);
  const after = await wiki.getPage(page.slug);
  assert.equal(after?.body[2]?.takes.find((take) => take.id === spam.take)?.hidden, true);
  assert.equal(after?.contested, 0);
  await db.close();
});

test("a page is indexable only once earned: owners, found quotes, words, age, playable, no flags", async () => {
  let now = new Date();
  const { wiki, as, db } = await freshWiki({ trusted: ["ada"], now: () => now });
  const long = Array.from({ length: 320 }, (_, index) => `word${index}`).join(" ");
  const sources = [SOURCE, { ...SOURCE, url: "https://example.org/b" }, { ...SOURCE, url: "https://example.org/c" }];
  const page = ok(await wiki.createPage(await as("ada"), { ...PAGE, sections: [PAGE.sections[0]!, { heading: "The answer", body: `${long} [1][2][3]`, sources }] }));
  assert.equal(page.indexable, false, "one owner is not enough");
  ok(await wiki.back(await as("lin"), leadingTake(page.body[2]!)!.id, null));
  assert.equal((await wiki.getPage(page.slug))?.indexable, false, "and not before it has aged");
  now = new Date(Date.now() + 8 * 86_400_000);
  await wiki.refreshAll();
  const earned = await wiki.getPage(page.slug);
  assert.equal(earned?.verified, 3);
  assert.equal(earned?.indexable, true);
  assert.deepEqual(
    (await wiki.sitemap()).map((entry) => entry.slug),
    [page.slug],
  );
  await db.close();
});

test("rate limit: a new key creates five pages a day", async () => {
  const { wiki, as, db } = await freshWiki();
  for (const n of [1, 2, 3, 4, 5]) ok(await wiki.createPage(await as("ada"), { ...PAGE, title: `Page number ${n}` }));
  const sixth = await wiki.createPage(await as("ada"), { ...PAGE, title: "Page number 6" });
  assert.equal(!sixth.ok && sixth.status, 429);
  await db.close();
});

test("standings, graph, changes and stats read from the same takes", async () => {
  const { wiki, as, db } = await freshWiki({ trusted: ["ada"] });
  ok(await wiki.createPage(await as("ada"), PAGE));
  ok(
    await wiki.createPage(await as("ada", "gpt-6"), {
      title: "Bayes theorem",
      lede: "A rule for updating belief when evidence arrives.",
      sections: [{ heading: "Rule", body: "Posterior is prior times likelihood [1]. Used in [[Monty Hall problem]].", sources: [SOURCE] }],
    }),
  );
  const graph = await wiki.graph();
  assert.deepEqual(
    graph.nodes.map((node) => [node.slug, node.written]),
    [
      ["bayes-theorem", true],
      ["monty-hall-problem", true],
    ],
  );
  assert.deepEqual(graph.edges.map((edge) => edge.join(">")).sort(), ["bayes-theorem>monty-hall-problem", "monty-hall-problem>bayes-theorem"]);
  const { models, owners } = await wiki.standings();
  assert.deepEqual(models.map((row) => row.name).sort(), ["claude-opus-5-5", "gpt-6"]);
  assert.equal(owners[0]?.name, "ada");
  assert.equal((await wiki.stats()).pages, 2);
  assert.deepEqual(
    (await wiki.changes(5)).map((change) => change.kind),
    ["page.create", "page.create"],
    "a new page is one line on the feed, not one per section",
  );
  assert.deepEqual(await wiki.wanted(), []);
  await wiki.recordView("bayes-theorem");
  assert.equal((await wiki.listPages({ sort: "trending" })).length, 2);
  assert.equal((await wiki.listPages({ q: "belief" }))[0]?.slug, "bayes-theorem");
  await db.close();
});
