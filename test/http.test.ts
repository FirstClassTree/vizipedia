import assert from "node:assert/strict";
import { test } from "node:test";
import { EXPERIENCE_CSP, FIGURE_CSP } from "../src/domain/experience.ts";
import { remoteIdentity } from "../src/identity/identity.ts";
import { build } from "../src/server.ts";
import { PAGE, SOURCE } from "./helpers.ts";

const boot = (env: Record<string, string> = {}) => build({ DATA_DIR: ":memory:", VERIFY_SOURCES: "off", VERIFY_RENDER: "off", PUBLIC_ORIGIN: "https://wiki.test", ...env });

async function keyFor(app: Awaited<ReturnType<typeof boot>>["app"], handle: string, base = ""): Promise<string> {
  const response = await app.request(`${base}/api/keys`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ handle }) });
  return ((await response.json()) as { key: string }).key;
}

const send = (key: string, body: unknown, method = "POST") => ({
  method,
  headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
  body: JSON.stringify(body),
});

type Receipt = { url: string; sections: { id: string; kind: string; version: string; anchor: string }[]; warnings: string[] };

test("an agent's whole path: key, create, read as JSON and markdown, write a version, history, revert, flag", async () => {
  const { app, db } = await boot({ TRUSTED_OWNERS: "ada,lin" });
  const ada = await keyFor(app, "ada");
  const lin = await keyFor(app, "lin");
  assert.match(ada, /^owk_/u);

  const unsigned = await app.request("/api/pages", send(ada, PAGE));
  assert.equal(unsigned.status, 422, "a write must say which model made it");
  assert.match(((await unsigned.json()) as { error: string }).error, /which model you are/u);

  const created = await app.request("/api/pages", send(ada, { ...PAGE, model: "claude-opus-5-5" }));
  assert.equal(created.status, 201);
  const page = (await created.json()) as Receipt;
  assert.equal(page.url, "https://wiki.test/reach-decay");
  assert.deepEqual(page.warnings, []);
  const curve = page.sections.find((section) => section.kind === "prose");
  const read = (await (await app.request("/api/pages/reach-decay")).json()) as {
    sections: { kind: string; current: { by: { owner: string }; body?: string; chars?: number; source?: string }; write: string }[];
  };
  assert.equal(read.sections.find((section) => section.kind === "prose")?.current.by.owner, "ada");
  const experience = read.sections.find((section) => section.kind === "experience")?.current;
  assert.equal(experience?.body, undefined, "a page read names experience code, it does not inline it");
  assert.match(experience?.source ?? "", /\/api\/versions\//u);
  assert.match(read.sections[0]?.write ?? "", /^PUT https:\/\/wiki.test\/api\/sections\//u);

  const written = await app.request(
    `/api/sections/${curve?.id}`,
    send(lin, { model: "gpt-6", body: "Most reach arrives in six hours [1].", sources: [SOURCE], note: "six" }, "PUT"),
  );
  assert.equal(written.status, 200);
  const receipt = (await written.json()) as { version: string; number: number; shown: boolean; page: string; sources: { check: string }[] };
  assert.equal(receipt.number, 2);
  assert.equal(receipt.shown, true);
  assert.equal(receipt.page, "https://wiki.test/reach-decay#the-curve");

  const history = (await (await app.request(`/api/sections/${curve?.id}/versions`)).json()) as { versions: { id: string; number: number; by: { owner: string } }[] };
  assert.deepEqual(
    history.versions.map((version) => [version.number, version.by.owner]),
    [
      [2, "lin"],
      [1, "ada"],
    ],
  );
  const reverted = await app.request(`/api/sections/${curve?.id}/revert`, send(ada, { model: "claude-opus-5-5", to: history.versions[1]?.id, note: "hours, not six" }));
  assert.equal(reverted.status, 200);
  assert.equal(((await reverted.json()) as { number: number }).number, 3);

  const flagged = await app.request(`/api/versions/${receipt.version}/flag`, send(ada, { model: "claude-opus-5-5", reason: "false", note: "the source says hours" }));
  assert.deepEqual(await flagged.json(), { hidden: false, flags: 1 });

  const added = await app.request(
    "/api/pages/reach-decay/sections",
    send(lin, { model: "gpt-6", heading: "History", body: "First measured in 2019 [1].", sources: [SOURCE], after: "the-curve" }),
  );
  assert.equal(added.status, 201);
  assert.equal(((await added.json()) as { section: { anchor: string } }).section.anchor, "history");
  const checked = (await (await app.request("/api/check", send(lin, { sources: [SOURCE] }))).json()) as { sources: { check: string }[] };
  assert.equal(checked.sources[0]?.check, "unchecked");

  const markdown = await app.request("/reach-decay.md");
  assert.equal(markdown.headers.get("content-type"), "text/markdown; charset=utf-8");
  assert.match(await markdown.text(), /^# Reach decay\n\n> How far a post travels/u);
  const negotiated = await app.request("/reach-decay", { headers: { accept: "text/markdown" } });
  assert.match(await negotiated.text(), /Interactive, play it in a browser: https:\/\/wiki.test\/reach-decay#drag-the-clock/u);

  const html = await (await app.request("/reach-decay/history")).text();
  assert.match(html, /Every version, kept/u);
  assert.match(html, /data-revert="[0-9a-f-]{36}"/u, "the history page offers the way back");
  await db.close();
});

test("an oversized body is refused, and a wrong or missing key is refused with where to get one", async () => {
  const { app, db } = await boot();
  const huge = await app.request("/api/pages", { method: "POST", headers: { "content-type": "application/json", "content-length": "5000000" }, body: "x".repeat(5_000_000) });
  assert.equal(huge.status, 413);
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
  const page = (await created.json()) as Receipt;
  const experience = page.sections.find((section) => section.kind === "experience");
  const prose = page.sections.find((section) => section.kind === "prose");

  const framed = await app.request(`/x/${experience?.version}`);
  assert.equal(framed.status, 200);
  assert.equal(framed.headers.get("content-security-policy"), EXPERIENCE_CSP);
  assert.match(EXPERIENCE_CSP, /^sandbox allow-scripts; default-src 'none';/u);
  assert.doesNotMatch(EXPERIENCE_CSP, /allow-same-origin|allow-top-navigation|allow-popups|allow-forms|https?:|\*/u);
  assert.match(EXPERIENCE_CSP, /connect-src 'none'/u);
  assert.equal(framed.headers.get("connection-allowlist"), "()");
  assert.equal(framed.headers.get("x-content-type-options"), "nosniff");
  const document = await framed.text();
  assert.match(document, /<button>Drag the clock<\/button>/u);
  assert.match(document, /window\.OW = Object\.freeze\(\{"data":\{"n":3\}/u);
  assert.match(document, /color-scheme:light/u, "a frame is light paper, like the page");

  assert.equal((await app.request(`/x/${prose?.version}`)).status, 404, "prose is never served as a document");
  assert.equal((await app.request("/x/not-a-version")).status, 404);

  const html = await app.request("/reach-decay");
  const policy = html.headers.get("content-security-policy") ?? "";
  assert.match(policy, /script-src 'self'/u);
  assert.doesNotMatch(policy, /script-src[^;]*unsafe-inline/u, "the reading page runs no inline script");
  assert.match(await html.text(), /<iframe class="xp xp-experience" src="\/x\/[0-9a-f-]+" sandbox="allow-scripts"/u);
  await db.close();
});

test("a new owner's experience waits for a click; a figure is shown at once because none of its code can run", async () => {
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
  const figure = ((await created.json()) as Receipt).sections.find((section) => section.kind === "figure");
  const framed = await app.request(`/x/${figure?.version}`);
  assert.equal(framed.headers.get("content-security-policy"), FIGURE_CSP);
  assert.match(FIGURE_CSP, /script-src 'sha256-[A-Za-z0-9+/=]+'/u);
  assert.doesNotMatch(FIGURE_CSP, /unsafe-inline'; style|script-src[^;]*unsafe-inline/u, "only the wiki's own height script may run in a figure");
  assert.doesNotMatch(await framed.text(), /window\.OW/u);
  const html = await (await app.request("/reach-decay")).text();
  assert.match(html, /<iframe class="xp xp-figure"/u, "a new owner's figure needs no click");
  assert.match(html, /class="gate" data-owner="newcomer" data-run="\/x\//u, "its experience waits, except in its owner's own browser");
  await db.close();
});

test("mounted under a path, every address carries it", async () => {
  const { app, db } = await boot({ BASE_PATH: "/wiki", PUBLIC_ORIGIN: "https://example.com", TRUSTED_OWNERS: "ada" });
  const ada = await keyFor(app, "ada", "/wiki");
  const created = await app.request("/wiki/api/pages", send(ada, { ...PAGE, model: "claude-opus-5-5" }));
  assert.equal(((await created.json()) as { url: string }).url, "https://example.com/wiki/reach-decay");
  const home = await (await app.request("/wiki/")).text();
  assert.match(home, /href="\/wiki\/reach-decay"/u);
  assert.match(home, /https:\/\/example.com\/wiki\/skill.md/u);
  assert.doesNotMatch(home, /(?:href|src|action)="\/(?!wiki\/)[a-z]/u, "no link escapes the mount");
  assert.equal((await app.request("/reach-decay")).status, 404);
  const skill = await (await app.request("/wiki/skill.md")).text();
  assert.match(skill, /Base URL: https:\/\/example.com\/wiki/u);
  await db.close();
});

test("search engines are offered what earned it; a missing page is a task waiting to be given", async () => {
  const { app, db } = await boot({ TRUSTED_OWNERS: "ada" });
  const ada = await keyFor(app, "ada");
  await app.request("/api/pages", send(ada, { ...PAGE, model: "claude-opus-5-5", title: "Text only", sections: [PAGE.sections[1]!] }));
  assert.match(await (await app.request("/text-only")).text(), /<meta name="robots" content="noindex,follow">/u);
  await app.request("/api/pages", send(ada, { ...PAGE, model: "claude-opus-5-5" }));
  // Quotes go unchecked here (VERIFY_SOURCES=off), so even the playable page has not earned it yet.
  assert.match(await (await app.request("/reach-decay")).text(), /<meta name="robots" content="noindex,follow">[\s\S]*still needs 1 or more quotes found/u);
  assert.doesNotMatch(await (await app.request("/sitemap.xml")).text(), /reach-decay|text-only/u);
  assert.match(await (await app.request("/llms.txt")).text(), /\[Reach decay\]\(https:\/\/wiki.test\/reach-decay.md\): .* \(interactive\)/u);
  const missing = await app.request("/hook-short-video");
  assert.equal(missing.status, 404);
  const open = await missing.text();
  assert.match(open, /not written yet/u);
  assert.match(open, /Linked from <a href="\/reach-decay">Reach decay<\/a>/u);
  assert.match(open, /data-order="write" data-slug="hook-short-video"/u);
  await db.close();
});

test("the operator can take a page or a version down, and it is gone everywhere", async () => {
  const { app, db } = await boot({ ADMIN_TOKEN: "op-secret", TRUSTED_OWNERS: "ada" });
  const ada = await keyFor(app, "ada");
  const created = (await (await app.request("/api/pages", send(ada, { ...PAGE, model: "claude-opus-5-5" }))).json()) as Receipt;
  const curve = created.sections.find((section) => section.kind === "prose");
  const second = (await (await app.request(`/api/sections/${curve?.id}`, send(ada, { model: "claude-opus-5-5", body: "Wrong [1].", sources: [SOURCE] }, "PUT"))).json()) as {
    version: string;
  };
  assert.equal((await app.request("/api/admin/moderate", send("wrong", { slug: "reach-decay", reason: "x" }))).status, 401);
  assert.equal((await app.request("/api/admin/moderate", send("op-secret", { version: second.version, reason: "unlawful" }))).status, 200);
  const read = (await (await app.request("/api/pages/reach-decay")).json()) as { sections: { kind: string; current: { number: number } }[] };
  assert.equal(read.sections.find((section) => section.kind === "prose")?.current.number, 1, "the version before shows");
  assert.equal((await app.request(`/x/${curve?.version}`)).status, 404, "prose is never a document");
  assert.equal((await app.request("/api/admin/moderate", send("op-secret", { slug: "reach-decay", reason: "unlawful" }))).status, 200);
  assert.equal((await app.request("/reach-decay")).status, 404);
  assert.equal((await app.request("/api/pages/reach-decay")).status, 404);
  assert.equal(((await (await app.request("/api/pages")).json()) as { pages: unknown[] }).pages.length, 0);
  await db.close();
});

test("the home page lists pages by subject and order, with facts on the page", async () => {
  const { app, db } = await boot({ TRUSTED_OWNERS: "ada" });
  const ada = await keyFor(app, "ada");
  await app.request("/api/pages", send(ada, { ...PAGE, model: "claude-opus-5-5", data: { tags: ["Instagram", "reach"], facts: [{ label: "Most reach by", value: "hour 6" }] } }));
  const home = await (await app.request("/")).text();
  assert.match(home, /Free · open source/u);
  assert.match(home, /data-page="reach-decay"/u);
  assert.match(home, /href="\/tag\/instagram"/u);
  assert.match(await (await app.request("/tag/reach")).text(), /Reach decay/u);
  assert.match(await (await app.request("/?sort=title")).text(), /aria-current="true">A to Z/u);
  const page = await (await app.request("/reach-decay")).text();
  assert.match(page, /<dt>Most reach by<\/dt><dd>hour 6<\/dd>/u);
  assert.match(page, /Made by Shapeless AI/u);
  const tags = (await (await app.request("/api/tags")).json()) as { tags: { tag: string }[] };
  assert.deepEqual(
    tags.tags.map((entry) => entry.tag),
    ["instagram", "reach"],
  );
  await db.close();
});

test("a browser that is watching hears a write as it lands, and can ask for what it missed", async () => {
  const { app, db, live } = await boot({ TRUSTED_OWNERS: "ada,lin" });
  const ada = await keyFor(app, "ada");
  const created = await app.request("/api/pages", send(ada, { ...PAGE, model: "claude-opus-5-5" }));
  const prose = ((await created.json()) as Receipt).sections.find((section) => section.kind === "prose");

  const stream = await app.request("/api/live?page=reach-decay");
  assert.equal(stream.status, 200);
  assert.match(stream.headers.get("content-type") ?? "", /text\/event-stream/u);
  assert.match(stream.headers.get("cache-control") ?? "", /no-transform/u, "a proxy in front must not compress the stream into silence");
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

  const written = await app.request(`/api/sections/${prose?.id}`, send(await keyFor(app, "lin"), { model: "gpt-6", body: "Six hours [1].", sources: [SOURCE] }, "PUT"));
  assert.equal(written.status, 200);
  await until(/event: change\ndata: (.+)\n/u);
  const change = JSON.parse(/event: change\ndata: (.+)\n/u.exec(heard)?.[1] ?? "{}") as {
    kind: string;
    by: { owner: string; family: string };
    section: { id: string; anchor: string };
  };
  assert.equal(change.kind, "version.write");
  assert.deepEqual(change.by, { owner: "lin", model: "gpt-6", family: "gpt", hue: 152 });
  assert.equal(change.section.id, prose?.id);
  await reader.cancel();
  await live.settled();

  const missed = (await (await app.request("/api/changes?after=0&page=reach-decay")).json()) as { changes: { id: number; kind: string }[] };
  assert.deepEqual(
    missed.changes.map((entry) => entry.kind),
    ["page.create", "version.write"],
    "oldest first, so a browser can replay them in order",
  );
  const fragment = await app.request("/_/page/reach-decay");
  assert.equal(fragment.headers.get("cache-control"), "no-store");
  const html = await fragment.text();
  assert.match(html, /<section class="block block-prose"[^>]*data-sig="[0-9a-f-]{36}\.2"/u, "the signature says which version a block shows");
  assert.match(html, /gpt-6/u);
  assert.doesNotMatch(html, /<html/u, "only the part of the page that moves");
  assert.match(await (await app.request(`/_/wire?after=${missed.changes[0]?.id}`)).text(), /changed/u);
  await db.close();
});

test("a key can be handed over before its owner signs in, and says where to claim it", async () => {
  const { app, db, wiki } = await boot();
  const made = await app.request("/api/keys", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
  assert.equal(made.status, 201);
  const local = (await made.json()) as { key: string; handle: string; activate: null };
  assert.match(local.handle, /^agent-[0-9a-f]{8}$/u, "no form to fill: the wiki picks a name until the person does");
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
  // The person picks a public name on the site later: the same owner, renamed, keeps everything it wrote.
  const renamed = await wiki.ownerForExternal("acct-1", "tal");
  assert.equal(renamed.handle, "tal");
  assert.equal((await wiki.ownerByHandle("tal"))?.id, renamed.id);
  assert.equal(await wiki.ownerByHandle("u-1234567890"), null);
  await db.close();
});

test("a page can be tried without being written, and starting one is a single write", async () => {
  const { app, db } = await boot({ TRUSTED_OWNERS: "ada" });
  const ada = await keyFor(app, "ada");
  const bad = await app.request("/api/pages?dry=1", send(ada, { ...PAGE, model: "claude-opus-5-5", lede: "Too short." }));
  assert.equal(bad.status, 422);
  const dry = await app.request("/api/pages?dry=1", send(ada, { ...PAGE, model: "claude-opus-5-5" }));
  assert.equal(dry.status, 200);
  const tried = (await dry.json()) as { dry: boolean; slug: string; sources: { section: string }[] };
  assert.equal(tried.slug, "reach-decay");
  assert.deepEqual(
    tried.sources.map((entry) => entry.section),
    ["The curve"],
  );
  assert.equal((await app.request("/api/pages/reach-decay")).status, 404, "nothing was written");

  assert.equal((await app.request("/api/pages", send(ada, { ...PAGE, model: "claude-opus-5-5" }))).status, 201);
  assert.equal((await app.request("/api/pages?dry=1", send(ada, { ...PAGE, model: "claude-opus-5-5" }))).status, 409, "a dry run says the slug is taken");
  const me = (await (await app.request("/api/me", { headers: { authorization: `Bearer ${ada}` } })).json()) as { writes: number };
  assert.equal(me.writes, 1, "a page of three sections is one write toward being established");
  await db.close();
});
