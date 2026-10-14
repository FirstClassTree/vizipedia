import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { test } from "node:test";
import { pageCsp } from "../src/http/site.ts";
import { createAnalytics } from "../src/observe/analytics.ts";
import { build } from "../src/server.ts";
import { PAGE } from "./helpers.ts";

const boot = (env: Record<string, string> = {}) => build({ DATA_DIR: ":memory:", VERIFY_SOURCES: "off", VERIFY_RENDER: "off", PUBLIC_ORIGIN: "https://wiki.test", ...env });

type Sent = { event: string; timestamp: string; properties: Record<string, unknown> };
type Batch = { api_key: string; batch: Sent[] };

test("events are queued and sent as one PostHog batch, distinct_id inside each event's properties", async () => {
  const calls: { url: string; body: Batch }[] = [];
  const send: typeof fetch = async (url, init) => {
    calls.push({ url: String(url), body: JSON.parse(String(init?.body)) as Batch });
    return new Response("ok");
  };
  const analytics = createAnalytics({ key: "phc_test", host: "https://ph.test" }, send);
  analytics.capture("wiki_read", "net:abc", { route: "/pages" });
  analytics.capture("wiki_write", "wiki:o1", { kind: "page.create" });
  assert.equal(calls.length, 0, "nothing is sent on the request's own time");
  await analytics.close();
  assert.equal(calls.length, 1);
  assert.equal(calls[0]?.url, "https://ph.test/batch/");
  assert.equal(calls[0]?.body.api_key, "phc_test");
  assert.deepEqual(
    calls[0]?.body.batch.map((sent) => [sent.event, sent.properties.distinct_id, sent.properties.$lib]),
    [
      ["wiki_read", "net:abc", "vizipedia-server"],
      ["wiki_write", "wiki:o1", "vizipedia-server"],
    ],
  );
  assert.ok(calls[0]?.body.batch.every((sent) => !Number.isNaN(Date.parse(sent.timestamp))));
});

test("a sink that is down costs the events and nothing else", async () => {
  const analytics = createAnalytics({ key: "k", host: "https://ph.test" }, async () => {
    throw new Error("ECONNREFUSED");
  });
  analytics.capture("wiki_read", "net:x");
  await analytics.close();
});

test("without a key the page loads no analytics and the policy admits no other host", async () => {
  const { app, close } = await boot();
  const home = await app.request("/");
  const html = await home.text();
  assert.doesNotMatch(html, /analytics\.js|data-ph-/u);
  assert.match(html, /<body class="is-home" data-base="" data-url="https:\/\/wiki\.test" data-name="Vizipedia" data-view="home"/u);
  const csp = home.headers.get("content-security-policy") ?? "";
  assert.equal(csp, pageCsp(undefined));
  assert.match(csp, /script-src 'self'; /u);
  assert.match(csp, /connect-src 'self'; /u);
  await close();
});

test("with a key: the page carries the loader and the host, the policy admits that host, and the server reports what agents did", async (t) => {
  // A stand-in for PostHog: whatever is posted to /batch/ is kept.
  const batches: { path: string; body: Batch }[] = [];
  const sink = createServer((request, response) => {
    let body = "";
    request.on("data", (chunk) => {
      body += chunk;
    });
    request.on("end", () => {
      batches.push({ path: request.url ?? "", body: JSON.parse(body) as Batch });
      response.end("ok");
    });
  });
  await new Promise<void>((resolve) => sink.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise<void>((resolve) => sink.close(() => resolve())));
  const host = `http://127.0.0.1:${(sink.address() as AddressInfo).port}`;
  const { app, close } = await boot({ POSTHOG_KEY: "phc_test", POSTHOG_HOST: host, TRUSTED_OWNERS: "ada", BASE_PATH: "/wiki" });
  let closed = false;
  t.after(async () => {
    if (!closed) await close();
  });

  const home = await app.request("/wiki/");
  const html = await home.text();
  assert.match(html, new RegExp(`data-view="home" data-keys="local" data-ph-key="phc_test" data-ph-host="${host}"`, "u"));
  const loader = /<script type="module" src="(\/wiki\/assets\/analytics\.js\?v=[0-9a-f]+)"><\/script>\n<script type="module" src="\/wiki\/assets\/app\.js/u.exec(html);
  assert.ok(loader, "the analytics script comes first, from the wiki itself");
  const asset = await app.request(loader[1] as string);
  assert.equal(asset.status, 200);
  assert.match(await asset.text(), /\/static\/array\.js/u);
  const csp = home.headers.get("content-security-policy") ?? "";
  assert.match(csp, new RegExp(`script-src 'self' ${host}; `, "u"));
  assert.match(csp, new RegExp(`connect-src 'self' ${host}; `, "u"));
  assert.equal(csp, pageCsp({ key: "phc_test", host }));

  const minted = await app.request("/wiki/api/keys", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ handle: "ada" }) });
  const key = ((await minted.json()) as { key: string }).key;
  const send = (token: string, body: unknown) => ({
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
    body: JSON.stringify(body),
  });
  assert.equal((await app.request("/wiki/api/pages", send(key, { ...PAGE, model: "claude-opus-5-5" }))).status, 201);
  assert.equal((await app.request("/wiki/api/pages", send("owk_nope", { ...PAGE, model: "claude-opus-5-5" }))).status, 401);
  assert.equal((await app.request("/wiki/reach-decay.md", { headers: { "user-agent": "curl/8.7.1" } })).status, 200);
  assert.equal((await app.request("/wiki/api/pages?q=reach", { headers: { "sec-fetch-site": "same-origin", "user-agent": "Mozilla/5.0 Safari" } })).status, 200);
  assert.equal((await app.request("/wiki/skill.md")).status, 200);
  const page = await app.request("/wiki/reach-decay");
  assert.match(await page.text(), /data-view="page" data-keys="local" data-slug="reach-decay" data-last="\d+" data-ph-key="phc_test"/u);
  closed = true;
  await close();

  assert.ok(batches.length >= 1);
  assert.equal(batches[0]?.path, "/batch/");
  assert.equal(batches[0]?.body.api_key, "phc_test");
  const events = batches.flatMap((batch) => batch.body.batch);
  const one = (event: string, pick: (p: Record<string, unknown>) => boolean): Record<string, unknown> => {
    const found = events.filter((sent) => sent.event === event && pick(sent.properties));
    assert.equal(
      found.length,
      1,
      `${event}: ${JSON.stringify(events.map((sent) => [sent.event, sent.properties.route, sent.properties.kind, sent.properties.path, sent.properties.status]))}`,
    );
    return found[0]?.properties as Record<string, unknown>;
  };
  assert.ok(
    events.every((sent) => sent.properties.wiki === "Vizipedia"),
    "every server event carries the wiki's mark, like the browser's",
  );

  const write = one("wiki_write", (p) => p.kind === "page.create" && p.ok === true);
  assert.equal(write.route, "/pages");
  assert.equal(write.status, 201);
  assert.equal(write.ok, true);
  assert.equal(write.model, "claude-opus-5-5");
  assert.equal(write.wiki_handle, "ada");
  assert.equal(write.caller, "program");
  assert.match(String(write.distinct_id), /^wiki:[0-9a-f-]{36}$/u);
  assert.deepEqual(write.$set, { wiki_handle: "ada" });

  const refused = one("wiki_write", (p) => p.status === 401);
  assert.equal(refused.kind, "page.create");
  assert.match(String(refused.error), /not valid/u);
  assert.match(String(refused.distinct_id), /^net:[0-9a-f]{24}$/u, "an unsigned caller is its network, hashed");
  assert.equal(refused.$process_person_profile, false);

  const markdown = one("wiki_read", (p) => p.path === "/reach-decay.md");
  assert.equal(markdown.route, "/:slug");
  assert.equal(markdown.caller, "program");
  assert.equal(markdown.client, "curl");
  assert.equal(one("wiki_read", (p) => p.path === "/skill.md").route, "/skill.md");

  const search = one("wiki_read", (p) => p.route === "/pages");
  assert.equal(search.caller, "browser", "a browser's own fetch is told apart by Sec-Fetch-Site");
  assert.equal(search.client, "Mozilla");

  assert.equal(events.filter((sent) => sent.properties.path === "/reach-decay" || sent.properties.path === "/").length, 0, "an HTML page is the browser's to report");
  assert.equal(events.filter((sent) => sent.event === "wiki_write" && sent.properties.kind === "key.issue").length, 1);
});

test("the policy admits PostHog's assets twin of a cloud host, and nothing else", () => {
  const csp = pageCsp({ key: "k", host: "https://us.i.posthog.com" });
  assert.match(csp, /script-src 'self' https:\/\/us\.i\.posthog\.com https:\/\/us-assets\.i\.posthog\.com; /u);
  assert.match(csp, /connect-src 'self' https:\/\/us\.i\.posthog\.com https:\/\/us-assets\.i\.posthog\.com; /u);
  assert.match(csp, /img-src 'self' data:; /u);
});
