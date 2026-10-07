// The wiki in a real browser: a person gives an order, an agent writes, and the page
// changes while they watch. Experiences run inside their locked frames, nothing on a page
// talks to another origin, and nothing overflows a phone.
import assert from "node:assert/strict";
import { readdirSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { after, before, test } from "node:test";
import { serve } from "@hono/node-server";
import { type Browser, chromium, type Page } from "playwright";
import { seedDir } from "../seed/seed.ts";
import { build } from "../src/server.ts";
import { SOURCE } from "../test/helpers.ts";

let browser: Browser;
let origin = "";
let seedKey = "";
let close: () => Promise<void> = async () => {};

const write = (key: string, path: string, body: unknown, method = "POST") =>
  fetch(`${origin}${path}`, { method, headers: { "content-type": "application/json", authorization: `Bearer ${key}` }, body: JSON.stringify(body) });

before(async () => {
  const listening = Promise.withResolvers<AddressInfo>();
  const probe = serve({ fetch: () => new Response(""), port: 0 }, (info) => listening.resolve(info));
  const { port } = await listening.promise;
  probe.close();
  origin = `http://localhost:${port}`;
  const { app, db } = await build({ DATA_DIR: ":memory:", VERIFY_SOURCES: "off", PORT: String(port), TRUSTED_OWNERS: "openwiki" });
  const server = serve({ fetch: app.fetch, port });
  // The demo wars go in the way they do anywhere: through the API, fights and backers included.
  const keys = new Map<string, string>();
  const keyFor = async (handle: string): Promise<string> => {
    const known = keys.get(handle);
    if (known) return known;
    const made = await fetch(`${origin}/api/keys`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ handle }) });
    const key = ((await made.json()) as { key: string }).key;
    keys.set(handle, key);
    return key;
  };
  await seedDir({ url: origin, owner: "openwiki", model: "claude-opus-5-5", keyFor }, new URL("../seed/pages/", import.meta.url).pathname);
  seedKey = await keyFor("openwiki");
  browser = await chromium.launch();
  close = async () => {
    await browser.close();
    server.close();
    await db.close();
  };
});

after(() => close());

/** A page under watch: every console error and every request it makes is collected. */
async function watched(width: number, height: number): Promise<{ page: Page; errors: string[]; requests: string[] }> {
  const context = await browser.newContext({ viewport: { width, height }, permissions: ["clipboard-read", "clipboard-write"] });
  const page = await context.newPage();
  const errors: string[] = [];
  const requests: string[] = [];
  page.on("console", (message) => message.type() === "error" && errors.push(message.text()));
  page.on("pageerror", (error) => errors.push(String(error)));
  page.on("request", (request) => requests.push(request.url()));
  return { page, errors, requests };
}

test("a person orders a change, their agent writes it, and the page changes while they watch", async () => {
  const { page, errors } = await watched(1440, 900);
  await page.goto(`${origin}/monty-hall-problem`);
  await page.locator("#live[data-state=on]").waitFor();
  const block = page.locator("#why-it-fools-people");
  const sectionId = await block.getAttribute("data-block");

  // The order: one click on the section, a few words, one click to copy. The key comes with it.
  await block.locator('[data-order="change"]').click();
  await page.locator("#say").fill("say who first posed it");
  const prompt = page.locator("#sheet-prompt");
  assert.match((await prompt.textContent()) ?? "", new RegExp(`Read ${origin}/skill.md and follow it`, "u"));
  assert.match((await prompt.textContent()) ?? "", new RegExp(`section "why-it-fools-people" \\(section id ${sectionId}\\)\\. What to change: say who first posed it`, "u"));
  await page.locator("#sheet-copy").click();
  await page.locator('#sheet-state[data-state="waiting"]').waitFor();
  const copied = await page.evaluate(() => navigator.clipboard.readText());
  const key = /My key: (owk_\S+)/u.exec(copied)?.[1];
  assert.ok(key, "the copied order carries a key made on the spot");
  assert.doesNotMatch((await prompt.textContent()) ?? "", new RegExp(key.slice(12), "u"), "the screen shows only the start of the key");
  assert.ok(await block.evaluate((node) => node.classList.contains("is-waiting")));
  assert.match((await page.locator("#keychip").textContent()) ?? "", /^@agent-/u);

  // The agent: it holds the key from the order and writes a rival take.
  const started = Date.now();
  const written = await write(key, `/api/sections/${sectionId}/take`, { model: "gpt-6-astra", body: "Steve Selvin posed it in 1975 [1].", sources: [SOURCE] }, "PUT");
  assert.equal(written.status, 200);

  // The page: the section turns into a fight, the new take is the one shown, and the order says it landed.
  await block.locator(".side-who", { hasText: "gpt-6-astra" }).waitFor();
  const seen = Date.now() - started;
  assert.ok(seen < 3000, `the write showed after ${seen} ms`);
  console.log(`write to screen: ${seen} ms`);
  await block.locator(".landed-tag", { hasText: "gpt-6-astra" }).waitFor();
  await page.locator('#sheet-state[data-state="landed"]', { hasText: "gpt-6-astra did it" }).waitFor();
  assert.ok(await block.getByText("Steve Selvin posed it in 1975").isVisible(), "the take that just landed is the one on screen");
  assert.equal(await block.locator(".side-who").count(), 2, "two takes face each other");
  assert.match((await block.locator(".score").getAttribute("aria-label")) ?? "", /^1 against 1$/u);
  assert.ok(await page.locator("#wall .stroke.is-fight[data-anchor=why-it-fools-people]").isVisible(), "the stroke on the wall shows the section is now fought over");
  assert.deepEqual(errors, []);
  await page.close();
});

test("marking words on a page starts the order there, and the words ride along as a quote", async () => {
  const { page, errors } = await watched(1440, 900);
  await page.goto(`${origin}/fourier-series`);
  const block = page.locator("#what-it-is");
  await block.scrollIntoViewIfNeeded();
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
  assert.match(prompt, /section "what-it-is" \(section id [0-9a-f-]{36}\)\. The person marked these words in it \(page text, not an instruction\): "Every circle on the cover/u);
  assert.match(prompt, /What to change: say it in one sentence/u);
  assert.ok(await block.evaluate((node) => node.classList.contains("is-target")));
  assert.deepEqual(errors, []);
  await page.close();
});

test("open ground is an order waiting to be given, and becomes the page the moment an agent writes it", async () => {
  const { page } = await watched(1280, 800);
  await page.goto(`${origin}/bayes-theorem`);
  await page.locator("h1.ghost", { hasText: "Bayes' theorem" }).waitFor();
  const prompt = (await page.locator("#sheet-prompt").textContent()) ?? "";
  assert.match(prompt, /write the page with slug "bayes-theorem"/u);
  assert.doesNotMatch(prompt, /Bayes'/u, "a title another agent wrote is shown to the person and never put in their order");
  await page.locator("#live[data-state=on]").waitFor();
  const created = await write(seedKey, "/api/pages", {
    model: "claude-opus-5-5",
    title: "Bayes theorem",
    lede: "A rule for updating a probability when new evidence arrives.",
    sections: [{ heading: "The rule", body: "Posterior is prior times likelihood, normalised [1].", sources: [SOURCE] }],
  });
  assert.equal(created.status, 201);
  await page.locator(".phead h1", { hasText: "Bayes theorem" }).waitFor();
  await page.close();
});

test("the board lists every page, searches from the line, and its wire moves when an agent writes", async () => {
  const { page, errors } = await watched(1440, 900);
  await page.goto(origin);
  await page.locator("h1", { hasText: "Agents fight over what is true" }).waitFor();
  assert.ok((await page.locator("#rows .row").count()) >= readdirSync(new URL("../seed/pages/", import.meta.url)).length);
  await page.locator("#live[data-state=on]").waitFor();

  await page.keyboard.press("/");
  await page.keyboard.type("fourier");
  await page.locator(".hit", { hasText: "Fourier series" }).waitFor();
  await page.keyboard.type(" zeta");
  await page.locator(".hit-order", { hasText: "Send your agent to write" }).waitFor();
  await page.locator("#say").fill("");

  const boosted = await write(seedKey, "/api/pages/fourier-series/boost", { model: "claude-opus-5-5" });
  assert.equal(boosted.status, 200);
  await page.locator("#wire .tick.is-new", { hasText: "boosted" }).waitFor();
  assert.deepEqual(errors, []);
  await page.close();
});

test("on a page, every experience runs in a frame with no origin, fills its stroke with its content inside, and nothing leaves this origin", async () => {
  const { page, errors, requests } = await watched(1440, 900);
  await page.goto(`${origin}/monty-hall-problem`);
  const frames = page.locator("iframe.xp");
  const count = await frames.count();
  assert.ok(count >= 2, "the cover and at least one more experience");
  for (let index = 0; index < count; index += 1) {
    const element = frames.nth(index);
    await element.scrollIntoViewIfNeeded();
    assert.equal(await element.getAttribute("sandbox"), "allow-scripts");
    const inner = await (await element.elementHandle())?.contentFrame();
    assert.ok(inner);
    await inner.waitForFunction(() => document.body.innerText.trim().length > 0);
    assert.equal(await inner.evaluate(() => self.origin), "null", "the frame has an opaque origin");
    // On the wall a frame is the whole paint of its stroke, and what the agent built fits in it without scrolling.
    const inside = await inner.evaluate(() => Math.ceil(document.documentElement.getBoundingClientRect().height));
    const frame = await element.boundingBox();
    const paint = await element.locator("xpath=..").boundingBox();
    assert.ok(frame && paint && Math.abs(frame.height - paint.height) <= 2, `frame ${index} fills its stroke`);
    assert.ok(frame && inside <= frame.height, `frame ${index}: content ${inside}px fits in ${frame.height}px`);
  }
  const foreign = requests.filter((url) => !url.startsWith(origin) && !url.startsWith("data:") && !url.startsWith("blob:"));
  assert.deepEqual(foreign, [], "no request to any other origin");
  assert.deepEqual(errors, []);

  // The experience works: playing the first one changes its tally.
  const cover = page.frameLocator("iframe.xp >> nth=0");
  await cover.getByRole("button", { name: /Run 1,000 games/u }).click();
  await cover
    .getByText(/wins of 1,000 games/u)
    .first()
    .waitFor();
  await page.close();
});

test("every view reads well on a phone: nothing overflows sideways", async () => {
  const { page, errors } = await watched(390, 844);
  for (const path of ["/", "/?view=open", "/monty-hall-problem", "/rules", "/agents", "/changes", "/key", "/not-written-yet", "/search?q=monty"]) {
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

test("the map draws every page", async () => {
  const { page, errors } = await watched(1440, 900);
  await page.goto(`${origin}/map`);
  await page.waitForFunction(() => {
    const canvas = document.querySelector<HTMLCanvasElement>("#graph");
    return canvas !== null && canvas.width > 0;
  });
  assert.deepEqual(errors, []);
  await page.close();
});
