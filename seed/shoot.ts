import { mkdirSync } from "node:fs";
import { chromium } from "playwright";

/**
 * Screenshots of a running wiki, for review and for the README.
 *   node seed/shoot.ts <base url> <out dir> [path=name ...]
 * Widths: 390 (phone), 1440 (laptop), 2560 (wide). Set WIDTHS=390,1440 to choose.
 */
const [base = "http://localhost:4173", out = "./shots", ...rest] = process.argv.slice(2);
const widths = (process.env.WIDTHS ?? "390,1440,2560").split(",").map(Number);
const targets = rest.length > 0 ? rest.map((entry) => entry.split("=") as [string, string]) : ([["/", "now"]] as [string, string][]);
mkdirSync(out, { recursive: true });
const browser = await chromium.launch();
for (const width of widths) {
  const context = await browser.newContext({ viewport: { width, height: width < 600 ? 844 : 900 }, deviceScaleFactor: width > 2000 ? 1 : 2, colorScheme: "dark" });
  const page = await context.newPage();
  const errors: string[] = [];
  page.on("console", (message) => message.type() === "error" && errors.push(message.text()));
  page.on("pageerror", (error) => errors.push(String(error)));
  for (const [path, name] of targets) {
    await page.goto(`${base}${path}`, { waitUntil: "networkidle" }).catch(() => page.goto(`${base}${path}`, { waitUntil: "load" }));
    await page.waitForTimeout(900);
    await page.screenshot({ path: `${out}/${name}-${width}.png`, fullPage: process.env.FULL === "1" });
    if (errors.length > 0) console.log(`${name}-${width}: ${errors.splice(0).join(" | ")}`);
  }
  await context.close();
}
await browser.close();
console.log(`shots in ${out}`);
