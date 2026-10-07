// Checks a seed war the way the wiki would, without a server: the rules, a real fetch of
// every quoted source (in the page's own strokes and in its rival strokes), and a
// standalone preview of each experience in both surfaces.
//   node seed/validate.ts seed/pages/<slug>.json [preview-dir]
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { experienceDocument } from "../src/domain/experience.ts";
import type { SectionKind } from "../src/domain/model.ts";
import { checkTake, headingProblem, parseSources, titleProblem } from "../src/domain/rules.ts";
import { HANDLE, hueOf, slugify, slugProblem } from "../src/domain/slug.ts";
import { quoteChecker } from "../src/verify/quotes.ts";
import type { SeedPage } from "./seed.ts";

const [file, previewDir] = process.argv.slice(2);
if (!file) throw new Error("usage: node seed/validate.ts <page.json> [preview-dir]");
const page = JSON.parse(readFileSync(file, "utf8")) as SeedPage;
const problems: string[] = [];
const slug = page.slug ?? slugify(page.title ?? "");
for (const problem of [titleProblem(page.title ?? ""), slugProblem(slug)]) if (problem) problems.push(problem);
const hue = page.hue ?? hueOf(slug);
const check = quoteChecker({ agent: "OpenWikiBot/0.1 (seed validation)" });
const sections = [{ kind: "lede", heading: "", body: page.lede }, ...(page.sections ?? [])];
const kindOf = (heading: string): SectionKind => (sections.find((section) => section.heading === heading)?.kind ?? "prose") as SectionKind;
let experiences = 0;
let found = 0;

async function checkStroke(label: string, kind: SectionKind, body: unknown, rawSources: unknown): Promise<void> {
  const sources = parseSources(rawSources);
  if (typeof sources === "string") {
    problems.push(`${label}: ${sources}`);
    return;
  }
  const checked = checkTake(kind, { body: String(body ?? ""), sources, note: null });
  if (Array.isArray(checked)) problems.push(...checked.map((problem) => `${label}: ${problem}`));
  for (const [n, source] of (await check(sources)).entries()) {
    if (source.check === "found") found += 1;
    else if (source.quote) problems.push(`${label}: source ${n + 1} quote is ${source.check} at ${source.url}`);
  }
}

for (const [index, section] of sections.entries()) {
  const kind = (section.kind ?? "prose") as SectionKind;
  const label = kind === "lede" ? "lede" : `section ${index} (${section.heading})`;
  const bad = headingProblem(kind, section.heading ?? "");
  if (bad) problems.push(`${label}: ${bad}`);
  await checkStroke(label, kind, section.body, section.sources);
  if (kind === "experience" && previewDir) {
    experiences += 1;
    mkdirSync(previewDir, { recursive: true });
    for (const surface of ["stage", "sheet"] as const) {
      const html = experienceDocument({ fragment: String(section.body), hue, surface, page: { slug, title: page.title }, data: page.data ?? null });
      const framed = html.replace("<body>", `<body style="background:var(--ow-bg);padding:24px">`);
      writeFileSync(join(previewDir, `${slug}-${experiences}-${surface}.html`), framed);
    }
  }
}

const handles = new Set(Object.keys(page.painters ?? {}));
const knownHandle = (handle: string, where: string) => {
  if (!HANDLE.test(handle)) problems.push(`${where}: "${handle}" is not a handle`);
  else if (!handles.has(handle)) problems.push(`${where}: @${handle} is not in "painters", so it has no model`);
};
for (const [index, fight] of (page.fights ?? []).entries()) {
  const label = `fight ${index + 1} (${fight.section}, @${fight.owner})`;
  if (!sections.some((section) => section.heading === fight.section)) problems.push(`${label}: no section with that heading`);
  knownHandle(fight.owner, label);
  await checkStroke(label, kindOf(fight.section), fight.body, fight.sources);
  for (const backer of fight.backers ?? []) knownHandle(backer.owner, `${label} backer`);
}
for (const [index, backer] of (page.backers ?? []).entries()) {
  const label = `backer ${index + 1} (${backer.section}, @${backer.owner})`;
  if (!sections.some((section) => section.heading === backer.section)) problems.push(`${label}: no section with that heading`);
  knownHandle(backer.owner, label);
}

console.log(JSON.stringify({ slug, hue, sections: sections.length, fights: page.fights?.length ?? 0, quotesFound: found, problems }, null, 2));
process.exit(problems.length > 0 ? 1 : 0);
