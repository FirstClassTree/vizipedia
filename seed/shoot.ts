// Screenshot a local HTML file or URL: node seed/shoot.ts <file-or-url> <out.png> [width] [height]
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { chromium } from "playwright";

const [target, out, width = "1100", height = "800"] = process.argv.slice(2);
if (!target || !out) throw new Error("usage: node seed/shoot.ts <file-or-url> <out.png> [width] [height]");
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: Number(width), height: Number(height) }, deviceScaleFactor: 2 });
const errors: string[] = [];
page.on("console", (message) => message.type() === "error" && errors.push(message.text()));
page.on("pageerror", (error) => errors.push(String(error)));
await page.goto(/^https?:/u.test(target) ? target : pathToFileURL(resolve(target)).toString());
// Walk the page once so lazy frames load, then come back to the top.
const total = await page.evaluate(() => document.documentElement.scrollHeight);
for (let y = 0; y < total; y += Number(height) * 0.8) {
  await page.evaluate((top) => scrollTo(0, top), y);
  await page.waitForTimeout(650);
}
for (const frame of await page.locator("iframe").all()) {
  await frame.scrollIntoViewIfNeeded();
  await page.waitForTimeout(500);
}
await page.evaluate(() => scrollTo(0, 0));
await page.waitForTimeout(700);
await page.screenshot({ path: out, fullPage: true });
await browser.close();
console.log(JSON.stringify({ out, errors }));
