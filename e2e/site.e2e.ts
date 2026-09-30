// The wiki in a real browser: pages render, experiences run inside their locked frames,
// nothing on a page talks to another origin, and nothing overflows a phone.
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { after, before, test } from "node:test";
import { serve } from "@hono/node-server";
import { type Browser, chromium, type Page } from "playwright";
import { build } from "../src/server.ts";

let browser: Browser;
let origin = "";
let close: () => Promise<void> = async () => {};

before(async () => {
  const listening = Promise.withResolvers<AddressInfo>();
  const probe = serve({ fetch: () => new Response(""), port: 0 }, (info) => listening.resolve(info));
  const { port } = await listening.promise;
  probe.close();
  origin = `http://localhost:${port}`;
  const { app, db } = await build({ DATA_DIR: ":memory:", VERIFY_SOURCES: "off", PORT: String(port), TRUSTED_OWNERS: "openwiki" });
  const server = serve({ fetch: app.fetch, port });
  const made = await fetch(`${origin}/api/keys`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ handle: "openwiki" }) });
  const { key } = (await made.json()) as { key: string };
  const dir = new URL("../seed/pages/", import.meta.url);
  for (const file of readdirSync(dir).filter((name) => name.endsWith(".json"))) {
    const page = JSON.parse(readFileSync(new URL(file, dir), "utf8"));
    const response = await fetch(`${origin}/api/pages`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
      body: JSON.stringify({ model: "claude-opus-5-5", ...page }),
    });
    assert.equal(response.status, 201, `${file}: ${await response.clone().text()}`);
  }
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
  const page = await browser.newPage({ viewport: { width, height } });
  const errors: string[] = [];
  const requests: string[] = [];
  page.on("console", (message) => message.type() === "error" && errors.push(message.text()));
  page.on("pageerror", (error) => errors.push(String(error)));
  page.on("request", (request) => requests.push(request.url()));
  return { page, errors, requests };
}

test("the front page plays a real experience and links every page", async () => {
  const { page, errors } = await watched(1440, 900);
  await page.goto(origin);
  await assert.doesNotReject(page.locator("h1", { hasText: "The encyclopedia you can play" }).waitFor());
  assert.equal(await page.locator(".tile").count(), readdirSync(new URL("../seed/pages/", import.meta.url)).length);
  const frame = page.frameLocator(".cover-home iframe");
  await frame.locator("button, canvas, svg, input").first().waitFor();
  await page.locator('[data-dialog="agent"]').click();
  assert.match((await page.locator("#agent .prompt-text").textContent()) ?? "", new RegExp(`Read ${origin}/skill.md`, "u"));
  assert.deepEqual(errors, []);
  await page.close();
});

test("on a page, every experience runs in a frame with no origin, sized to its content, and nothing leaves this origin", async () => {
  const { page, errors, requests } = await watched(1440, 900);
  await page.goto(`${origin}/monty-hall-problem`);
  const frames = page.locator("iframe.xp");
  const count = await frames.count();
  assert.ok(count >= 2, "the cover and at least one inline experience");
  for (let index = 0; index < count; index += 1) {
    const element = frames.nth(index);
    await element.scrollIntoViewIfNeeded();
    assert.equal(await element.getAttribute("sandbox"), "allow-scripts");
    const inner = await (await element.elementHandle())?.contentFrame();
    assert.ok(inner);
    await inner.waitForFunction(() => document.body.innerText.trim().length > 0);
    assert.equal(await inner.evaluate(() => self.origin), "null", "the frame has an opaque origin");
    const inside = await inner.evaluate(() => Math.ceil(document.documentElement.getBoundingClientRect().height));
    await page.waitForFunction(([node, wanted]) => Math.abs((node as HTMLElement).getBoundingClientRect().height - Math.max(120, Math.min(960, wanted as number))) <= 2, [
      await element.elementHandle(),
      inside,
    ] as const);
  }
  const foreign = requests.filter((url) => !url.startsWith(origin) && !url.startsWith("data:") && !url.startsWith("blob:"));
  assert.deepEqual(foreign, [], "no request to any other origin");
  assert.deepEqual(errors, []);

  // The experience works: playing a full round of the cover game changes the tally.
  const cover = page.frameLocator("figure.cover iframe");
  await cover.getByRole("button", { name: /Run 1,000 games/u }).click();
  await cover
    .getByText(/wins of 1,000 games/u)
    .first()
    .waitFor();
  await page.close();
});

test("a page reads well on a phone: nothing overflows sideways", async () => {
  const { page, errors } = await watched(390, 844);
  for (const path of ["/", "/monty-hall-problem", "/rules", "/agents", "/changes", "/key", "/not-written-yet"]) {
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

test("the graph draws every page", async () => {
  const { page, errors } = await watched(1440, 900);
  await page.goto(`${origin}/graph`);
  await page.waitForFunction(() => {
    const canvas = document.querySelector<HTMLCanvasElement>("#graph");
    return canvas !== null && canvas.width > 0;
  });
  assert.deepEqual(errors, []);
  await page.close();
});
