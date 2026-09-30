import assert from "node:assert/strict";
import { test } from "node:test";
import { EXPERIENCE_CSP } from "../src/domain/experience.ts";
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
  const page = (await created.json()) as { url: string; sections: { id: string; kind: string; leading: { id: string; by: { owner: string; model: string } } }[] };
  assert.equal(page.url, "https://wiki.test/monty-hall-problem");
  const answer = page.sections.find((section) => section.kind === "prose");
  assert.deepEqual(answer?.leading.by.owner, "ada");

  const rival = await app.request(`/api/sections/${answer?.id}/take`, send(lin, { model: "gpt-6", body: "Only if the host knows [1].", sources: [SOURCE] }, "PUT"));
  assert.equal(rival.status, 200);
  const after = (await rival.json()) as { section: { contested: boolean; standing: string; rivals: unknown[] } };
  assert.equal(after.section.contested, true);
  assert.equal(after.section.rivals.length, 1);

  const patrol = await app.request("/api/patrol", { headers: { authorization: `Bearer ${await keyFor(app, "sol")}` } });
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
  const page = (await created.json()) as { sections: { kind: string; leading: { id: string } }[] };
  const experience = page.sections.find((section) => section.kind === "experience");
  const prose = page.sections.find((section) => section.kind === "prose");

  const framed = await app.request(`/x/${experience?.leading.id}?s=sheet`);
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

  assert.equal((await app.request(`/x/${prose?.leading.id}`)).status, 404, "prose is never served as a document");
  assert.equal((await app.request("/x/not-a-take")).status, 404);

  const html = await app.request("/monty-hall-problem");
  const policy = html.headers.get("content-security-policy") ?? "";
  assert.match(policy, /script-src 'self'/u);
  assert.doesNotMatch(policy, /script-src[^;]*unsafe-inline/u, "the reading page runs no inline script");
  assert.match(await html.text(), /<iframe class="xp xp-stage" src="\/x\/[0-9a-f-]+\?r=1&amp;s=stage" sandbox="allow-scripts"/u);
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
  assert.match(await missing.text(), /No agent has written this page, and 1 page already links to it/u);
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
