// Checks a seed page the way the wiki would, without a server: the rules, a real fetch of
// every quoted source, and a standalone preview of each experience in both surfaces.
//   node seed/validate.ts seed/pages/<slug>.json [preview-dir]
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { experienceDocument } from "../src/domain/experience.ts";
import type { SectionKind } from "../src/domain/model.ts";
import { checkTake, headingProblem, parseSources, titleProblem } from "../src/domain/rules.ts";
import { hueOf, slugify, slugProblem } from "../src/domain/slug.ts";
import { quoteChecker } from "../src/verify/quotes.ts";

const [file, previewDir] = process.argv.slice(2);
if (!file) throw new Error("usage: node seed/validate.ts <page.json> [preview-dir]");
const page = JSON.parse(readFileSync(file, "utf8"));
const problems: string[] = [];
const slug = page.slug ?? slugify(page.title ?? "");
for (const problem of [titleProblem(page.title ?? ""), slugProblem(slug)]) if (problem) problems.push(problem);
const hue = page.hue ?? hueOf(slug);
const check = quoteChecker({ agent: "OpenWikiBot/0.1 (seed validation)" });
const sections = [{ kind: "lede", heading: "", body: page.lede }, ...(page.sections ?? [])];
let experiences = 0;
let found = 0;
for (const [index, section] of sections.entries()) {
  const kind: SectionKind = section.kind ?? "prose";
  const label = kind === "lede" ? "lede" : `section ${index} (${section.heading})`;
  const bad = headingProblem(kind, section.heading ?? "");
  if (bad) problems.push(`${label}: ${bad}`);
  const sources = parseSources(section.sources);
  if (typeof sources === "string") {
    problems.push(`${label}: ${sources}`);
    continue;
  }
  const checked = checkTake(kind, { body: section.body ?? "", sources, note: null });
  if (Array.isArray(checked)) problems.push(...checked.map((problem) => `${label}: ${problem}`));
  for (const [n, source] of (await check(sources)).entries()) {
    if (source.check === "found") found += 1;
    else if (source.quote) problems.push(`${label}: source ${n + 1} quote is ${source.check} at ${source.url}`);
  }
  if (kind === "experience" && previewDir) {
    experiences += 1;
    mkdirSync(previewDir, { recursive: true });
    for (const surface of ["stage", "sheet"] as const) {
      const html = experienceDocument({ fragment: section.body, hue, surface, page: { slug, title: page.title }, data: page.data ?? null });
      const framed = html.replace("<body>", `<body style="background:var(--ow-bg);padding:24px">`);
      writeFileSync(join(previewDir, `${slug}-${experiences}-${surface}.html`), framed);
    }
  }
}
console.log(JSON.stringify({ slug, hue, sections: sections.length, quotesFound: found, problems }, null, 2));
process.exit(problems.length > 0 ? 1 : 0);
