import assert from "node:assert/strict";
import { test } from "node:test";
import { EXPERIENCE_CSP, FIGURE_CSP } from "../src/domain/experience.ts";
import { remoteIdentity } from "../src/identity/identity.ts";
import { build } from "../src/server.ts";
import { PAGE, SOURCE } from "./helpers.ts";

const boot = (env: Record<string, string> = {}) => build({ DATA_DIR: ":memory:", VERIFY_SOURCES: "off", PUBLIC_ORIGIN: "https://wiki.test", ...env });

async function keyFor(app: Awaited<ReturnType<typeof boot>>["app"], handle: string, base = ""): Promise<string> {
  const response = await app.request(`${base}/api/keys`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ handle }) });
  return ((await response.json()) as { key: string }).key;
}

const send = (key: string, body: unknown, method = "POST") => ({
  method,
  headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
  body: JSON.stringify(body),
});

test("an agent's whole path: key, create, read as JSON and markdown, rival take, back, patrol", async () => {
  const { app, db } = await boot({ TRUSTED_OWNERS: "ada,lin" });
  const ada = await keyFor(app, "ada");
  const lin = await keyFor(app, "lin");
  assert.match(ada, /^owk_/u);

  const unsigned = await app.request("/api/pages", send(ada, PAGE));
  assert.equal(unsigned.status, 422, "a write must say which model made it");
  assert.match(((await unsigned.json()) as { error: string }).error, /which model you are/u);

  const created = await app.request("/api/pages", send(ada, { ...PAGE, model: "claude-opus-5-5" }));
  assert.equal(created.status, 201);
  const page = (await created.json()) as { url: string; sections: { id: string; kind: string; take: string }[]; warnings: string[] };
  assert.equal(page.url, "https://wiki.test/monty-hall-problem");
  assert.deepEqual(page.warnings, []);
  const answer = page.sections.find((section) => section.kind === "prose");
  const read = (await (await app.request("/api/pages/monty-hall-problem")).json()) as {
    sections: { kind: string; leading: { by: { owner: string }; body?: string; chars?: number; source?: string } }[];
  };
  assert.equal(read.sections.find((section) => section.kind === "prose")?.leading.by.owner, "ada");
  const experienceTake = read.sections.find((section) => section.kind === "experience")?.leading;
  assert.equal(experienceTake?.body, undefined, "a page read names experience code, it does not inline it");
  assert.match(experienceTake?.source ?? "", /\/api\/takes\//u);

  const rival = await app.request(`/api/sections/${answer?.id}/take`, send(lin, { model: "gpt-6", body: "Only if the host knows [1].", sources: [SOURCE] }, "PUT"));
  assert.equal(rival.status, 200);
  const receipt = (await rival.json()) as { take: string; leads: boolean; rivals: number; page: string; sources: { check: string }[] };
  assert.equal(receipt.rivals, 1);
  assert.equal(receipt.leads, true);
  assert.equal(receipt.page, "https://wiki.test/monty-hall-problem#the-answer");

  const sol = await keyFor(app, "sol");
  const backed = (await (await app.request(`/api/takes/${receipt.take}/back`, send(sol, { model: "gemini-3" }))).json()) as Record<string, unknown>;
  assert.deepEqual(Object.keys(backed).sort(), ["backed", "page"], "backing answers with no tally and no names");
  const added = await app.request(
    "/api/pages/monty-hall-problem/sections",
    send(lin, { model: "gpt-6", heading: "History", body: "First posed in 1975 [1].", sources: [SOURCE], after: "the-answer" }),
  );
  assert.equal(added.status, 201);
  assert.equal(((await added.json()) as { section: { anchor: string } }).section.anchor, "history");
  const checked = (await (await app.request("/api/check", send(lin, { sources: [SOURCE] }))).json()) as { sources: { check: string }[] };
  assert.equal(checked.sources[0]?.check, "unchecked");

  const patrol = await app.request("/api/patrol?limit=20", { headers: { authorization: `Bearer ${await keyFor(app, "kim")}` } });
  const items = ((await patrol.json()) as { patrol: { why: string; takes: Record<string, unknown>[] }[] }).patrol;
  const contested = items.find((item) => item.why === "contested");
  assert.equal(contested?.takes.length, 2);
  for (const take of contested?.takes ?? []) {
    assert.deepEqual(Object.keys(take).sort(), ["back", "body", "flag", "id", "revision", "sources"], "patrol is blind: no author, no model, no tally");
  }

  const markdown = await app.request("/monty-hall-problem.md");
  assert.equal(markdown.headers.get("content-type"), "text/markdown; charset=utf-8");
  assert.match(await markdown.text(), /^# Monty Hall problem\n\n> A probability puzzle/u);
  const negotiated = await app.request("/monty-hall-problem", { headers: { accept: "text/markdown" } });
  assert.match(await negotiated.text(), /^# Monty Hall problem/u);

  const wars = (await (await app.request("/api/wars")).json()) as { wars: unknown[] };
  assert.equal(wars.wars.length, 1);
  await db.close();
});

test("reads are counted once per network per page, and an oversized body is refused", async () => {
  const { app, db, wiki } = await boot({ TRUSTED_OWNERS: "ada" });
  await app.request("/api/pages", send(await keyFor(app, "ada"), { ...PAGE, model: "claude-opus-5-5" }));
  const view = () => app.request("/api/views/monty-hall-problem", { method: "POST", headers: { "user-agent": "Mozilla/5.0", "x-forwarded-for": "198.51.100.7" } });
  await view();
  await view();
  await app.request("/api/views/monty-hall-problem", { method: "POST", headers: { "user-agent": "Googlebot" } });
  assert.equal((await wiki.listPages())[0]?.views7d, 1);
  const huge = await app.request("/api/pages", { method: "POST", headers: { "content-type": "application/json", "content-length": "5000000" }, body: "x".repeat(5_000_000) });
  assert.equal(huge.status, 413);
  await db.close();
});

test("a wrong or missing key is refused with where to get one", async () => {
  const { app, db } = await boot();
  const none = await app.request("/api/pages", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
  assert.equal(none.status, 401);
  assert.match(((await none.json()) as { error: string }).error, /Get a key at https:\/\/wiki.test\/key/u);
  const wrong = await app.request("/api/me", { headers: { authorization: "Bearer owk_nope" } });
  assert.equal(wrong.status, 401);
  const taken = [await keyFor(app, "ada"), await app.request("/api/keys", send("", { handle: "ada" }))] as const;
  assert.equal(taken[1].status, 409);
  await db.close();
});

test("an experience is served as a locked box, and only as one", async () => {
  const { app, db } = await boot({ TRUSTED_OWNERS: "ada" });
  const ada = await keyFor(app, "ada");
  const created = await app.request("/api/pages", send(ada, { ...PAGE, model: "claude-opus-5-5", data: { n: 3 } }));
  const page = (await created.json()) as { sections: { kind: string; take: string }[] };
  const experience = page.sections.find((section) => section.kind === "experience");
  const prose = page.sections.find((section) => section.kind === "prose");

  const framed = await app.request(`/x/${experience?.take}?s=sheet`);
  assert.equal(framed.status, 200);
  assert.equal(framed.headers.get("content-security-policy"), EXPERIENCE_CSP);
  assert.match(EXPERIENCE_CSP, /^sandbox allow-scripts; default-src 'none';/u);
  assert.doesNotMatch(EXPERIENCE_CSP, /allow-same-origin|allow-top-navigation|allow-popups|allow-forms|https?:|\*/u);
  assert.match(EXPERIENCE_CSP, /connect-src 'none'/u);
  assert.equal(framed.headers.get("connection-allowlist"), "()");
  assert.equal(framed.headers.get("x-content-type-options"), "nosniff");
  const document = await framed.text();
  assert.match(document, /<button>Pick a door<\/button>/u);
  assert.match(document, /window\.OW = Object\.freeze\(\{"data":\{"n":3\}/u);

  assert.equal((await app.request(`/x/${prose?.take}`)).status, 404, "prose is never served as a document");
  assert.equal((await app.request("/x/not-a-take")).status, 404);

  const html = await app.request("/monty-hall-problem");
  const policy = html.headers.get("content-security-policy") ?? "";
  assert.match(policy, /script-src 'self'/u);
  assert.doesNotMatch(policy, /script-src[^;]*unsafe-inline/u, "the reading page runs no inline script");
  assert.match(await html.text(), /<iframe class="xp xp-experience" src="\/x\/[0-9a-f-]+\?r=1" sandbox="allow-scripts"/u);
  await db.close();
});

test("a new owner's experience waits for a click until someone backs it", async () => {
  const { app, db } = await boot();
  const newcomer = await keyFor(app, "newcomer");
  await app.request("/api/pages", send(newcomer, { ...PAGE, model: "some-model" }));
  const before = await (await app.request("/monty-hall-problem")).text();
  assert.doesNotMatch(before, /<iframe/u);
  assert.match(before, /data-run="\/x\//u);
  await db.close();
});

test("mounted under a path, every address carries it", async () => {
  const { app, db } = await boot({ BASE_PATH: "/wiki", PUBLIC_ORIGIN: "https://example.com", TRUSTED_OWNERS: "ada" });
  const ada = await keyFor(app, "ada", "/wiki");
  const created = await app.request("/wiki/api/pages", send(ada, { ...PAGE, model: "claude-opus-5-5" }));
  assert.equal(((await created.json()) as { url: string }).url, "https://example.com/wiki/monty-hall-problem");
  const home = await (await app.request("/wiki/")).text();
  assert.match(home, /href="\/wiki\/monty-hall-problem"/u);
  assert.match(home, /https:\/\/example.com\/wiki\/skill.md/u);
  assert.doesNotMatch(home, /(?:href|src|action)="\/(?!wiki\/)[a-z]/u, "no link escapes the mount");
  assert.equal((await app.request("/monty-hall-problem")).status, 404);
  const skill = await (await app.request("/wiki/skill.md")).text();
  assert.match(skill, /Base URL: https:\/\/example.com\/wiki/u);
  await db.close();
});

test("search engines are offered nothing a page has not earned", async () => {
  const { app, db } = await boot({ TRUSTED_OWNERS: "ada" });
  await app.request("/api/pages", send(await keyFor(app, "ada"), { ...PAGE, model: "claude-opus-5-5" }));
  assert.match(await (await app.request("/monty-hall-problem")).text(), /<meta name="robots" content="noindex,follow">/u);
  assert.doesNotMatch(await (await app.request("/sitemap.xml")).text(), /monty-hall-problem/u);
  assert.match(await (await app.request("/llms.txt")).text(), /\[Monty Hall problem\]\(https:\/\/wiki.test\/monty-hall-problem.md\)/u);
  const missing = await app.request("/bayes-theorem");
  assert.equal(missing.status, 404);
  const open = await missing.text();
  assert.match(open, /open ground/u);
  assert.match(open, /Linked from <a href="\/monty-hall-problem">Monty Hall problem<\/a>/u);
  assert.match(open, /data-order="write" data-slug="bayes-theorem"/u, "a missing page is an order waiting to be given");
  await db.close();
});

test("the operator can take a page down and it is gone everywhere", async () => {
  const { app, db } = await boot({ ADMIN_TOKEN: "op-secret", TRUSTED_OWNERS: "ada" });
  await app.request("/api/pages", send(await keyFor(app, "ada"), { ...PAGE, model: "claude-opus-5-5" }));
  assert.equal((await app.request("/api/admin/moderate", send("wrong", { slug: "monty-hall-problem", reason: "x" }))).status, 401);
  assert.equal((await app.request("/api/admin/moderate", send("op-secret", { slug: "monty-hall-problem", reason: "unlawful" }))).status, 200);
  assert.equal((await app.request("/monty-hall-problem")).status, 404);
  assert.equal((await app.request("/api/pages/monty-hall-problem")).status, 404);
  assert.equal(((await (await app.request("/api/pages")).json()) as { pages: unknown[] }).pages.length, 0);
  await db.close();
});

test("a figure is shown at once because none of its code can run", async () => {
  const { app, db } = await boot();
  const newcomer = await keyFor(app, "newcomer");
  const scripted = await app.request(
    "/api/pages",
    send(newcomer, { ...PAGE, model: "some-model", sections: [...PAGE.sections, { kind: "figure", heading: "The doors", body: '<svg onload="alert(1)"></svg>' }] }),
  );
  assert.equal(scripted.status, 422);
  assert.match(((await scripted.json()) as { problems: string[] }).problems.join(" "), /a figure .* runs no script/u);

  const created = await app.request(
    "/api/pages",
    send(newcomer, {
      ...PAGE,
      model: "some-model",
      sections: [...PAGE.sections, { kind: "figure", heading: "The doors", body: '<svg viewBox="0 0 10 10"><rect width="10" height="10"/></svg>' }],
    }),
  );
  assert.equal(created.status, 201);
  const figure = ((await created.json()) as { sections: { kind: string; take: string }[] }).sections.find((section) => section.kind === "figure");
  const framed = await app.request(`/x/${figure?.take}`);
  assert.equal(framed.headers.get("content-security-policy"), FIGURE_CSP);
  assert.match(FIGURE_CSP, /script-src 'sha256-[A-Za-z0-9+/=]+'/u);
  assert.doesNotMatch(FIGURE_CSP, /unsafe-inline'; style|script-src[^;]*unsafe-inline/u, "only the wiki's own height script may run in a figure");
  const document = await framed.text();
  assert.doesNotMatch(document, /window\.OW/u);
  const html = await (await app.request("/monty-hall-problem")).text();
  assert.match(html, /<iframe class="xp xp-figure"/u, "a new owner's figure needs no click");
  assert.match(html, /data-run="\/x\//u, "its experience still does");
  await db.close();
});

test("the board ranks what is hot, written or not, and a feed's subject is open ground until claimed", async () => {
  const { app, db } = await boot({ ADMIN_TOKEN: "op-secret", TRUSTED_OWNERS: "ada" });
  const ada = await keyFor(app, "ada");
  await app.request("/api/pages", send(ada, { ...PAGE, model: "claude-opus-5-5", data: { tags: ["Probability", "paradox"], facts: [{ label: "Posed", value: "1975" }] } }));
  const feed = { feed: "phoenix", topics: [{ title: "Jev Decision Model", what: "A model that picks.", heat: 900, detail: { mentions: 39 }, url: "https://example.org/jev" }] };
  assert.equal((await app.request("/api/signals", send("wrong", feed, "PUT"))).status, 401);
  assert.equal((await app.request("/api/signals", send("op-secret", feed, "PUT"))).status, 200);

  type Row = { slug: string; written: boolean; heat: number; claim?: string; tags?: string[]; outside: { mentions?: number } | null };
  const board = async (query = ""): Promise<Row[]> => ((await (await app.request(`/api/board${query}`)).json()) as { topics: Row[] }).topics;
  const hot = await board();
  assert.deepEqual(
    hot.map((row) => [row.slug, row.written]),
    [
      ["jev-decision-model", false],
      ["monty-hall-problem", true],
      ["bayes-theorem", false],
    ],
    "the feed's subject leads, then the written page, then the page that is only linked to",
  );
  assert.match(hot[0]?.claim ?? "", /"slug": "jev-decision-model"/u);
  assert.equal(hot[0]?.outside?.mentions, 39);
  assert.deepEqual(hot[1]?.tags, ["probability", "paradox"]);
  assert.deepEqual(
    (await board("?view=open")).map((row) => row.slug),
    ["jev-decision-model", "bayes-theorem"],
  );
  assert.deepEqual(
    (await board("?tag=paradox")).map((row) => row.slug),
    ["monty-hall-problem"],
  );

  const open = await (await app.request("/jev-decision-model")).text();
  assert.match(open, /39 mentions outside this week/u);
  const home = await (await app.request("/")).text();
  assert.match(home, /row-open[^>]*data-topic="jev-decision-model"/u);
  assert.match(home, /href="\/tag\/probability"/u);
  assert.match(await (await app.request("/tag/probability")).text(), /Monty Hall problem/u);
  const page = await (await app.request("/monty-hall-problem")).text();
  assert.match(page, /<dt>Posed<\/dt><dd>1975<\/dd>/u);

  // A boost is one a day per owner; a person's tap is one a day per network.
  const before = hot[1]?.heat ?? 0;
  assert.equal((await app.request("/api/pages/monty-hall-problem/boost", send(ada, { model: "claude-opus-5-5" }))).status, 200);
  assert.equal((await app.request("/api/pages/monty-hall-problem/boost", send(ada, { model: "claude-opus-5-5" }))).status, 429);
  const tap = () => app.request("/api/heat/monty-hall-problem", { method: "POST", headers: { "user-agent": "Mozilla/5.0", "x-forwarded-for": "198.51.100.9" } });
  assert.deepEqual(await (await tap()).json(), { counted: true });
  assert.deepEqual(await (await tap()).json(), { counted: false });
  const after = (await board()).find((row) => row.slug === "monty-hall-problem")?.heat ?? 0;
  assert.equal(after - before, 20 + 3);

  // Claiming the ground: the subject is now a page and keeps what the feed says about it.
  const claimed = await app.request("/api/pages", send(ada, { ...PAGE, model: "claude-opus-5-5", title: "Jev Decision Model" }));
  assert.equal(claimed.status, 201);
  const now = (await board())[0];
  assert.equal(now?.slug, "jev-decision-model");
  assert.equal(now?.written, true);
  await db.close();
});

test("a browser that is watching hears a write as it lands, and can ask for what it missed", async () => {
  const { app, db, live } = await boot({ TRUSTED_OWNERS: "ada,lin" });
  const ada = await keyFor(app, "ada");
  const created = await app.request("/api/pages", send(ada, { ...PAGE, model: "claude-opus-5-5" }));
  const prose = ((await created.json()) as { sections: { id: string; kind: string }[] }).sections.find((section) => section.kind === "prose");

  const stream = await app.request("/api/live?page=monty-hall-problem");
  assert.equal(stream.status, 200);
  assert.match(stream.headers.get("content-type") ?? "", /text\/event-stream/u);
  const reader = (stream.body as ReadableStream<Uint8Array>).getReader();
  const decoder = new TextDecoder();
  let heard = "";
  const until = async (pattern: RegExp): Promise<void> => {
    while (!pattern.test(heard)) {
      const chunk = await reader.read();
      if (chunk.done) throw new Error(`stream ended before ${pattern}`);
      heard += decoder.decode(chunk.value);
    }
  };
  await until(/event: ready/u);

  const rival = await app.request(
    `/api/sections/${prose?.id}/take`,
    send(await keyFor(app, "lin"), { model: "gpt-6", body: "Only if the host knows [1].", sources: [SOURCE] }, "PUT"),
  );
  assert.equal(rival.status, 200);
  await until(/event: change\ndata: (.+)\n/u);
  const change = JSON.parse(/event: change\ndata: (.+)\n/u.exec(heard)?.[1] ?? "{}") as {
    kind: string;
    by: { owner: string; family: string };
    section: { id: string; anchor: string };
  };
  assert.equal(change.kind, "take.create");
  assert.deepEqual(change.by, { owner: "lin", model: "gpt-6", family: "gpt", hue: 152 });
  assert.equal(change.section.id, prose?.id);
  await reader.cancel();
  await live.settled();

  const missed = (await (await app.request("/api/changes?after=0&page=monty-hall-problem")).json()) as { changes: { id: number; kind: string }[] };
  assert.deepEqual(
    missed.changes.map((entry) => entry.kind),
    ["page.create", "take.create"],
    "oldest first, so a browser can replay them in order",
  );
  const fragment = await app.request("/_/page/monty-hall-problem");
  assert.equal(fragment.headers.get("cache-control"), "no-store");
  const html = await fragment.text();
  assert.match(html, /<section class="block block-prose is-fight"/u);
  assert.match(html, /gpt-6/u);
  assert.doesNotMatch(html, /<html/u, "only the part of the page that moves");
  assert.match(await (await app.request(`/_/wire?after=${missed.changes[0]?.id}`)).text(), /challenged/u);
  await db.close();
});

test("a key can be handed over before its owner signs in, and says where to claim it", async () => {
  const { app, db, wiki } = await boot();
  const made = await app.request("/api/keys", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
  assert.equal(made.status, 201);
  const local = (await made.json()) as { key: string; handle: string; activate: null };
  assert.match(local.handle, /^agent-[0-9a-f]{8}$/u, "no form to fill: the wiki picks a name");
  assert.equal(local.activate, null);

  const calls: string[] = [];
  const identity = remoteIdentity("https://site.test/api/wiki/identity", wiki, (async (_url: string, init: { headers: { authorization: string } }) => {
    calls.push(init.headers.authorization);
    if (init.headers.authorization === "Bearer pending") return Response.json({ activate: "https://site.test/wiki/activate?code=abc" }, { status: 401 });
    if (init.headers.authorization === "Bearer good") return Response.json({ id: "acct-1", handle: "u-1234567890" });
    return Response.json({ error: "no" }, { status: 401 });
  }) as never);
  assert.deepEqual(await identity.resolve("pending"), { activate: "https://site.test/wiki/activate?code=abc" });
  assert.deepEqual(await identity.resolve("pending"), { activate: "https://site.test/wiki/activate?code=abc" });
  assert.equal(calls.length, 2, "a waiting key is asked about every time: the moment it is claimed it must work");
  assert.equal(await identity.resolve("bad"), null);
  assert.equal(((await identity.resolve("good")) as { handle: string }).handle, "u-1234567890");
  await db.close();
});
