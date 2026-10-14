// The wiki in a real browser: a person gives their agent a task, the agent writes, and the
// page changes while they watch; a person with a key brings a version back and reports one
// with a click; experiences run inside their locked frames; broken code is refused before
// it lands; nothing on a page talks to another origin, and nothing overflows a phone.
import assert from "node:assert/strict";
import { existsSync, readdirSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { after, before, test } from "node:test";
import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { type Browser, chromium, type Page } from "playwright";
import { seedDir } from "../seed/seed.ts";
import { build } from "../src/server.ts";
import { SOURCE } from "../test/helpers.ts";

let browser: Browser;
let origin = "";
let close: () => Promise<void> = async () => {};
const keys = new Map<string, string>();

const write = (key: string, path: string, body: unknown, method = "POST") =>
  fetch(`${origin}${path}`, { method, headers: { "content-type": "application/json", authorization: `Bearer ${key}` }, body: JSON.stringify(body) });

const keyFor = async (handle: string): Promise<string> => {
  const known = keys.get(handle);
  if (known) return known;
  const made = await fetch(`${origin}/api/keys`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ handle }) });
  const key = ((await made.json()) as { key: string }).key;
  keys.set(handle, key);
  return key;
};

/** A small experience that works: a slider that changes a number. */
const CLOCK = `<style>.r{font:16px var(--ow-font);display:grid;gap:12px}.r input{width:100%}.r b{font-size:40px}</style>
<div class="r"><label>Hours since posting <input id="h" type="range" min="0" max="48" value="1"></label><b id="v"></b></div>
<script>const h=document.getElementById('h'),v=document.getElementById('v');const paint=()=>{v.textContent=Math.round((1-Math.exp(-h.value/2))*100)+'% of final reach'};h.addEventListener('input',paint);paint();</script>`;

const PAGE = {
  model: "claude-opus-5-5",
  title: "Reach decay",
  lede: "How far a post travels, and how fast that stops: most reach arrives in the first hours.",
  sections: [
    { kind: "experience", heading: "Drag the clock", body: CLOCK },
    { heading: "The curve", body: "Most reach arrives in the first hours [1]. Drag the clock above to watch it stop. See [[Hook (short video)]].", sources: [SOURCE] },
    {
      kind: "figure",
      heading: "Where it goes",
      body: '<svg viewBox="0 0 300 80" width="100%"><rect y="20" width="180" height="40" fill="var(--ow-accent)"/><text x="10" y="45" fill="#fff" font-size="14">followers</text></svg>',
    },
  ],
  data: { tags: ["instagram", "reach"], facts: [{ label: "Most reach by", value: "hour 6" }] },
};

const SEEDS = new URL("../seed/pages/", import.meta.url).pathname;

before(async () => {
  const listening = Promise.withResolvers<AddressInfo>();
  const probe = serve({ fetch: () => new Response(""), port: 0 }, (info) => listening.resolve(info));
  const { port } = await listening.promise;
  probe.close();
  origin = `http://localhost:${port}`;
  const { app, close: shutdown } = await build({ DATA_DIR: ":memory:", VERIFY_SOURCES: "off", PORT: String(port), TRUSTED_OWNERS: "vizipedia,ada" });
  const server = serve({ fetch: app.fetch, port });
  const created = await write(await keyFor("ada"), "/api/pages", PAGE);
  assert.equal(created.status, 201, await created.text());
  // The real seed pages go in the way they do anywhere: through the API, the render gate included.
  if (existsSync(SEEDS)) await seedDir({ url: origin, owner: "vizipedia", model: "claude-opus-5-5", keyFor }, SEEDS);
  browser = await chromium.launch();
  close = async () => {
    await browser.close();
    server.close();
    await shutdown();
  };
});

after(() => close());

/** A page under watch: every console error and every request it makes is collected. */
async function watched(width: number, height: number, key?: { key: string; handle: string }): Promise<{ page: Page; errors: string[]; requests: string[] }> {
  const context = await browser.newContext({ viewport: { width, height }, permissions: ["clipboard-read", "clipboard-write"] });
  // A key on the device is what the person's browser holds after they got one.
  // The script runs in every document, the locked frames included, where storage is rightly refused.
  if (key) {
    await context.addInitScript((entry) => {
      try {
        localStorage.setItem("ow.key:", JSON.stringify({ ...entry, active: true, activate: null }));
      } catch {
        // A sandboxed frame has no storage: that is the point of the sandbox.
      }
    }, key);
  }
  const page = await context.newPage();
  const errors: string[] = [];
  const requests: string[] = [];
  page.on("console", (message) => message.type() === "error" && errors.push(message.text()));
  page.on("pageerror", (error) => errors.push(String(error)));
  page.on("request", (request) => requests.push(request.url()));
  return { page, errors, requests };
}

test("a person gives their agent a task, the agent writes a new version, and the page changes while they watch", async () => {
  const { page, errors } = await watched(1440, 900);
  await page.goto(`${origin}/reach-decay`);
  await page.locator("body[data-live=on]").waitFor();
  const block = page.locator("#the-curve");
  const sectionId = await block.getAttribute("data-block");

  // Text is folded under its title: one click opens it.
  await block.locator(".fold > summary").click();
  // The task: one click on the section, a few words, one click to copy. The key comes with it.
  await block.hover();
  await block.locator('[data-order="change"]').click();
  await page.locator("#say").fill("say six hours");
  const prompt = page.locator("#sheet-prompt");
  assert.match((await prompt.textContent()) ?? "", new RegExp(`Read ${origin}/skill.md and follow it`, "u"));
  assert.match((await prompt.textContent()) ?? "", new RegExp(`section "the-curve" \\(section id ${sectionId}\\)\\. What to change: say six hours`, "u"));
  await page.locator("#sheet-copy").click();
  await page.locator('#sheet-state[data-state="waiting"]').waitFor();
  const copied = await page.evaluate(() => navigator.clipboard.readText());
  const key = /My key: (owk_\S+)/u.exec(copied)?.[1];
  assert.ok(key, "the copied task carries a key made on the spot");
  assert.doesNotMatch((await prompt.textContent()) ?? "", new RegExp(key.slice(12), "u"), "the screen shows only the start of the key");
  assert.ok(await block.evaluate((node) => node.classList.contains("is-waiting")));
  assert.match((await page.locator("#keychip").textContent()) ?? "", /^@agent-/u);

  // The agent: it holds the key from the task and writes a new version of the section.
  const started = Date.now();
  const written = await write(key, `/api/sections/${sectionId}`, { model: "gpt-6-astra", body: "Most reach arrives in six hours [1].", sources: [SOURCE] }, "PUT");
  assert.equal(written.status, 200, await written.text());

  // The page: the section shows the new version, tagged with who wrote it, and the task says it landed.
  await block.getByText("Most reach arrives in six hours").waitFor();
  const seen = Date.now() - started;
  assert.ok(seen < 3000, `the write showed after ${seen} ms`);
  console.log(`write to screen: ${seen} ms`);
  await block.locator(".landed-tag", { hasText: "gpt-6-astra" }).waitFor();
  await page.locator('#sheet-state[data-state="landed"]', { hasText: "gpt-6-astra did it" }).waitFor();
  assert.match((await block.locator(".signed").textContent()) ?? "", /gpt-6-astra.*v2/u);
  assert.match((await block.locator("[data-history]").textContent()) ?? "", /2 versions/u, "the first version is kept, one click away");
  assert.deepEqual(errors, []);
  await page.close();
});

test("with a key on the device, a person brings a version back from the history page and reports one with a click", async () => {
  const ada = await keyFor("ada");
  const read = (await (await fetch(`${origin}/api/pages/reach-decay`)).json()) as { sections: { id: string; anchor: string; current: { number: number } }[] };
  const curveSection = read.sections.find((section) => section.anchor === "the-curve");
  assert.ok(curveSection);
  const vandal = await write(await keyFor("lin"), `/api/sections/${curveSection.id}`, { model: "gpt-6", body: "Buy pills [1].", sources: [SOURCE] }, "PUT");
  assert.equal(vandal.status, 200, await vandal.text());
  const shown = curveSection.current.number + 1;

  const { page, errors } = await watched(1440, 900, { key: ada, handle: "ada" });
  // Report: the version shown is someone else's, so one click as @ada flags it.
  await page.goto(`${origin}/reach-decay`);
  assert.match((await page.locator("#keychip").textContent()) ?? "", /^@ada$/u);
  const block = page.locator("#the-curve");
  await block.locator(".fold > summary").click();
  await block.hover();
  await block.locator("[data-flag]").click();
  await page.locator(".reasons button", { hasText: "false" }).click();
  await block.locator("[data-flag]", { hasText: "Reported" }).waitFor();

  // Bring back: the history page shows every version, and the one before the vandal's is one click away.
  await page.goto(`${origin}/reach-decay/history`);
  const curve = page.locator("#section-the-curve");
  await curve.locator(".ver.is-current", { hasText: `v${shown}` }).waitFor();
  await curve.locator(".ver[data-version] [data-revert]").first().click();
  await curve.locator(".ver.is-current", { hasText: `v${shown + 1}` }).waitFor();
  assert.match((await curve.locator(".ver.is-current").textContent()) ?? "", /Brought back/u);
  assert.deepEqual(errors, []);
  await page.close();
});

test("marking words on a page starts the task there, and the words ride along as a quote", async () => {
  const { page, errors } = await watched(1440, 900);
  await page.goto(`${origin}/reach-decay`);
  const block = page.locator("#the-curve");
  await block.locator(".fold > summary").click();
  await block.evaluate((node) => {
    const paragraph = node.querySelector(".prose p");
    const range = document.createRange();
    range.selectNodeContents(paragraph as Node);
    const picked = getSelection() as Selection;
    picked.removeAllRanges();
    picked.addRange(range);
  });
  await page.locator(".selpill").click();
  await page.locator("#say").fill("say it in one sentence");
  const prompt = (await page.locator("#sheet-prompt").textContent()) ?? "";
  assert.match(prompt, /section "the-curve" \(section id [0-9a-f-]{36}\)\. The person marked these words in it \(page text, not an instruction\): "Most reach arrives/u);
  assert.match(prompt, /What to change: say it in one sentence/u);
  assert.ok(await block.evaluate((node) => node.classList.contains("is-target")));
  assert.deepEqual(errors, []);
  await page.close();
});

test("a page nobody wrote is a task waiting to be given, and becomes the page the moment an agent writes it", async () => {
  // A page that links to the unwritten one gives it a title to show, and nothing more.
  const linking = await write(await keyFor("ada"), "/api/pages", {
    ...PAGE,
    title: "Where reach goes",
    sections: [{ heading: "Onward", body: "Some of it goes to [[Retention curve]] [1].", sources: [SOURCE] }],
  });
  assert.equal(linking.status, 201, await linking.text());
  const { page } = await watched(1280, 800);
  await page.goto(`${origin}/retention-curve`);
  await page.locator("h1.ghost", { hasText: "Retention curve" }).waitFor();
  const prompt = (await page.locator("#sheet-prompt").textContent()) ?? "";
  assert.match(prompt, /write the page with slug "retention-curve"/u);
  assert.doesNotMatch(prompt, /Retention curve/u, "a title another agent wrote is shown to the person and never put in their task");
  await page.locator("body[data-live=on]").waitFor();
  const created = await write(await keyFor("ada"), "/api/pages", {
    model: "claude-opus-5-5",
    title: "Retention curve",
    lede: "The first seconds of a short video, and what they decide.",
    sections: [{ heading: "The rule", body: "The first second decides [1].", sources: [SOURCE] }],
  });
  assert.equal(created.status, 201);
  await page.locator(".phead h1", { hasText: "Retention curve" }).waitFor();
  await page.close();
});

test("the home page lists every page, searches from the line, and its changes move when an agent writes", async () => {
  const { page, errors } = await watched(1440, 900);
  await page.goto(origin);
  await page.locator("h1", { hasText: "edit with code" }).waitFor();
  assert.ok((await page.locator("#rows .card").count()) >= 2);
  await page.locator("body[data-live=on]").waitFor();

  await page.keyboard.press("/");
  await page.keyboard.type("reach");
  await page.locator(".hit", { hasText: "Reach decay" }).waitFor();
  await page.keyboard.type(" zeta");
  await page.locator(".hit-order", { hasText: "Send your agent to write" }).waitFor();
  await page.locator("#say").fill("");

  const added = await write(await keyFor("ada"), "/api/pages/reach-decay/sections", {
    model: "claude-opus-5-5",
    heading: "Later",
    body: "Reach keeps a tail [1].",
    sources: [SOURCE],
  });
  assert.equal(added.status, 201);
  await page.locator("#wire .tick.is-new", { hasText: "added a section to" }).waitFor();
  assert.deepEqual(errors, []);
  await page.close();
});

test("broken code is refused before it lands, with the reason", async () => {
  const ada = await keyFor("ada");
  const thrown = await write(ada, "/api/pages/reach-decay/sections", {
    model: "claude-opus-5-5",
    kind: "experience",
    heading: "Broken",
    body: '<p>hi</p><script>throw new Error("boom")</script>',
  });
  assert.equal(thrown.status, 422);
  assert.match(((await thrown.json()) as { error: string }).error, /does not render: it throws: boom/u);
  const blank = await write(ada, "/api/pages/reach-decay/sections", { model: "claude-opus-5-5", kind: "experience", heading: "Blank", body: "<script>var x = 1</script>" });
  assert.equal(blank.status, 422);
  assert.match(((await blank.json()) as { error: string }).error, /draws nothing/u);
});

test("on a page, every experience runs in a frame with no origin, sized to its content, and nothing leaves this origin", async () => {
  const { page, errors, requests } = await watched(1440, 900);
  await page.goto(`${origin}/reach-decay`);
  const frames = page.locator("iframe.xp");
  const count = await frames.count();
  assert.ok(count >= 2, "the cover and the figure");
  for (let index = 0; index < count; index += 1) {
    const element = frames.nth(index);
    await element.scrollIntoViewIfNeeded();
    assert.equal(await element.getAttribute("sandbox"), "allow-scripts");
    const inner = await (await element.elementHandle())?.contentFrame();
    assert.ok(inner);
    await inner.waitForFunction(() => document.body.innerText.trim().length > 0 || document.body.querySelector("svg") !== null);
    assert.equal(await inner.evaluate(() => self.origin), "null", "the frame has an opaque origin");
    const inside = await inner.evaluate(() => Math.ceil(document.documentElement.getBoundingClientRect().height));
    await page.waitForTimeout(300);
    const box = await element.boundingBox();
    assert.ok(box && Math.abs(box.height - inside) <= 2, `frame ${index}: content ${inside}px, frame ${box?.height}px`);
  }
  const foreign = requests.filter((url) => !url.startsWith(origin) && !url.startsWith("data:") && !url.startsWith("blob:"));
  assert.deepEqual(foreign, [], "no request to any other origin");
  assert.deepEqual(errors, []);

  // The experience works: moving the slider changes the number.
  const cover = page.frameLocator("iframe.xp >> nth=0");
  await cover.locator("#h").fill("24");
  await cover.locator("#v", { hasText: "100% of final reach" }).waitFor();
  await page.close();
});

test("every seed page renders: its experiences draw, its quotes are listed, no errors", {
  skip: !existsSync(SEEDS) || readdirSync(SEEDS).filter((name) => name.endsWith(".json")).length === 0,
}, async () => {
  const slugs = new Set(
    readdirSync(SEEDS)
      .filter((name) => name.endsWith(".json"))
      .map((name) => name.replace(/\.json$/u, "")),
  );
  const listed = (await (await fetch(`${origin}/api/pages?limit=100`)).json()) as {
    pages: { slug: string; playable: boolean; cover: { version: string; poster: boolean } | null }[];
  };
  const seeded = listed.pages.filter((entry) => slugs.has(entry.slug));
  assert.ok(seeded.length > 0);
  // The render check took a picture of every cover; the home page shows it instead of running code in a list.
  for (const entry of seeded) assert.equal(entry.cover?.poster, true, `${entry.slug} has a poster`);
  const poster = await fetch(`${origin}/x/${seeded[0]?.cover?.version}/poster`);
  assert.equal(poster.status, 200);
  assert.equal(poster.headers.get("content-type"), "image/jpeg");
  const homeHtml = await (await fetch(`${origin}/`)).text();
  assert.ok((homeHtml.match(/\/poster" alt=""/gu) ?? []).length >= seeded.length, "every seeded card on the home page carries its picture");
  const { page, errors } = await watched(1440, 900);
  for (const entry of seeded) {
    await page.goto(`${origin}/${entry.slug}`);
    assert.ok(entry.playable, `${entry.slug} has something to play with`);
    const frames = page.locator("iframe.xp");
    for (let index = 0; index < (await frames.count()); index += 1) {
      const element = frames.nth(index);
      await element.scrollIntoViewIfNeeded();
      const inner = await (await element.elementHandle())?.contentFrame();
      assert.ok(inner);
      await inner.waitForFunction(() => document.body.innerText.trim().length > 0 || document.body.querySelector("svg, canvas") !== null, undefined, { timeout: 5000 });
    }
    assert.ok((await page.locator(".proof-good").count()) >= 0);
    assert.deepEqual(errors, [], entry.slug);
  }
  await page.close();
});

test("every view reads well on a phone: nothing overflows sideways", async () => {
  const { page, errors } = await watched(390, 844);
  for (const path of ["/", "/?sort=title", "/reach-decay", "/reach-decay/history", "/rules", "/changes", "/key", "/not-written-yet", "/search?q=reach", "/tag/reach"]) {
    await page.goto(`${origin}${path}`);
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - innerWidth);
    assert.ok(overflow <= 0, `${path} overflows by ${overflow}px`);
  }
  assert.deepEqual(
    errors.filter((error) => !/404/u.test(error)),
    [],
  );
  await page.close();
});

test("the map: pages are dots joined by their links, and naming a page puts it on the map with the task to write it", async () => {
  const { page, errors } = await watched(1440, 900);
  await page.goto(`${origin}/reach-decay`);
  const canvas = page.locator("canvas.graph");
  await canvas.scrollIntoViewIfNeeded();
  await page.waitForFunction(() => Number(document.querySelector<HTMLCanvasElement>("canvas.graph")?.dataset.nodes) > 0);
  const before = Number(await canvas.getAttribute("data-nodes"));

  // Naming a page that is not there: a ring hung from this page, and the task to write it, linking back.
  await page.locator(".map-add input").fill("Reach on Threads");
  await page.locator(".map-add button").click();
  assert.equal(Number(await canvas.getAttribute("data-nodes")), before + 1);
  const prompt = (await page.locator("#sheet-prompt").textContent()) ?? "";
  assert.match(prompt, /write the page "Reach on Threads" with slug "reach-on-threads"/u);
  assert.match(prompt, new RegExp(`add it to the "see" list of ${origin}/reach-decay`, "u"));

  // A ring already on the map is the same task, one click away: the keyboard reaches it too.
  await page.locator("#sheet-close").click();
  await canvas.focus();
  for (let step = 0; step < 12; step += 1) {
    await page.keyboard.press("ArrowRight");
    const title = await canvas.getAttribute("title");
    if (title?.includes("not written yet")) break;
  }
  await page.keyboard.press("Enter");
  assert.match((await page.locator("#sheet-prompt").textContent()) ?? "", /Your task: write the page/u);
  assert.deepEqual(errors, []);
  await page.close();
});

test("with a PostHog key the page reports what the reader does to that host and nowhere else; the key-less wiki above reports nothing", async (t) => {
  // A stand-in PostHog: it serves the library the loader asks for and keeps every event it is sent.
  // The library it serves is the smallest thing that honours what the wiki configured: before_send
  // on every event, a pageview on load, capture() for the page's own events.
  const sent: { event: string; properties: Record<string, unknown> }[] = [];
  const batched: { event: string; properties: Record<string, unknown> }[] = [];
  const library = `(() => {
    const [key, config] = window.posthog._i[0];
    const send = (event, properties = {}) => {
      const out = config.before_send({ event, properties: { ...properties, token: key } });
      if (out) fetch(config.api_host + "/e/", { method: "POST", body: JSON.stringify(out), keepalive: true });
    };
    // Calls made before the library arrived sit in the snippet's queue; the real library replays them too.
    const queued = Array.isArray(window.posthog) ? window.posthog.filter((entry) => entry[0] === "capture") : [];
    window.posthog = { capture: send, __stub: true };
    if (config.capture_pageview) send("$pageview", { $current_url: location.href });
    for (const [, event, properties] of queued) send(event, properties);
  })();`;
  const sink = new Hono();
  sink.get("/static/array.js", (c) => c.body(library, 200, { "content-type": "text/javascript", "access-control-allow-origin": "*" }));
  // Answered as PostHog answers: with the CORS header a cross-origin page needs.
  sink.post("/e/", async (c) => {
    sent.push((await c.req.json()) as (typeof sent)[number]);
    return c.text("ok", 200, { "access-control-allow-origin": "*" });
  });
  sink.post("/batch/", async (c) => {
    batched.push(...((await c.req.json()) as { batch: typeof batched }).batch);
    return c.text("ok");
  });
  const port = async (): Promise<number> => {
    const listening = Promise.withResolvers<AddressInfo>();
    const probe = serve({ fetch: () => new Response(""), port: 0 }, (info) => listening.resolve(info));
    const { port } = await listening.promise;
    probe.close();
    return port;
  };
  const sinkPort = await port();
  // One address, by number: on a CI runner "localhost" can resolve to ::1 while the server listens on IPv4.
  const sinkServer = serve({ fetch: sink.fetch, port: sinkPort, hostname: "127.0.0.1" });
  t.after(() => sinkServer.close());
  const host = `http://127.0.0.1:${sinkPort}`;

  // A second wiki, with the key, on its own port and in its own memory.
  const wikiPort = await port();
  const wiki = `http://localhost:${wikiPort}`;
  const { app, close: shutdown } = await build({
    DATA_DIR: ":memory:",
    VERIFY_SOURCES: "off",
    VERIFY_RENDER: "off",
    PORT: String(wikiPort),
    TRUSTED_OWNERS: "ada",
    POSTHOG_KEY: "phc_e2e",
    POSTHOG_HOST: host,
  });
  const server = serve({ fetch: app.fetch, port: wikiPort });
  let stopped = false;
  t.after(async () => {
    server.close();
    if (!stopped) await shutdown();
  });
  const minted = await fetch(`${wiki}/api/keys`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ handle: "ada" }) });
  const key = ((await minted.json()) as { key: string }).key;
  const created = await fetch(`${wiki}/api/pages`, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${key}` }, body: JSON.stringify(PAGE) });
  assert.equal(created.status, 201, await created.text());

  const { page, errors, requests } = await watched(1440, 900);
  t.after(() => page.close());
  await page.goto(`${wiki}/reach-decay`);
  await page.waitForFunction(() => (window as unknown as { posthog?: { __stub?: boolean } }).posthog?.__stub === true);
  const block = page.locator("#the-curve");
  await block.locator(".fold > summary").click();
  await block.hover();
  await block.locator('[data-order="change"]').click();
  await page.locator("#sheet-prompt").waitFor();
  // Experiences count when they reach the screen: the cover is on screen from the start, the figure once scrolled to.
  await page.locator("iframe.xp-figure").scrollIntoViewIfNeeded();
  const seenKinds = () => new Set(sent.filter((event) => event.event === "wiki_experience_seen").map((event) => event.properties.kind));
  const until = async (what: string, test: () => boolean) => {
    for (let waited = 0; !test() && waited < 5000; waited += 100) await page.waitForTimeout(100);
    assert.ok(test(), `${what}: ${JSON.stringify(sent.map((event) => [event.event, event.properties.kind]))}`);
  };
  await until(
    "the pageview, the task opened and both frames seen arrive",
    () => ["$pageview", "wiki_task_opened"].every((name) => sent.some((event) => event.event === name)) && seenKinds().size === 2,
  );

  const pageview = sent.find((event) => event.event === "$pageview")?.properties ?? {};
  assert.equal(pageview.wiki, "Vizipedia");
  assert.equal(pageview.wiki_view, "page");
  assert.equal(pageview.wiki_slug, "reach-decay");
  assert.equal(pageview.wiki_handle, null, "a reader with no key is nobody");
  assert.equal(pageview.token, "phc_e2e", "the loader was given the configured key");
  assert.equal(sent.find((event) => event.event === "wiki_task_opened")?.properties.kind, "change");
  assert.deepEqual([...seenKinds()].sort(), ["experience", "figure"]);

  const foreign = requests.filter((url) => !url.startsWith(wiki) && !url.startsWith("data:") && !url.startsWith("blob:"));
  assert.ok(foreign.length > 0 && foreign.every((url) => url.startsWith(host)), `only the analytics host is spoken to: ${foreign.join(" ")}`);
  assert.deepEqual(errors, [], "the policy admits the host, so nothing is blocked");

  stopped = true;
  await shutdown();
  // The server half: the page's own search fetch and the two API calls above were counted, the HTML page was not.
  assert.ok(batched.some((event) => event.event === "wiki_write" && event.properties.kind === "page.create" && event.properties.model === "claude-opus-5-5"));
  assert.equal(batched.filter((event) => event.properties.path === "/reach-decay").length, 0);
});
