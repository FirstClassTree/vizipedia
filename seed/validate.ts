// Checks a seed page the way the wiki would, without a server: the rules, a real fetch of
// every quoted source (in the page and in its later edits), and a standalone preview of
// each experience on both surfaces.
//   node seed/validate.ts seed/pages/<slug>.json [preview-dir]
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { experienceDocument } from "../src/domain/experience.ts";
import type { SectionKind } from "../src/domain/model.ts";
import { checkVersion, headingProblem, parseSources, titleProblem } from "../src/domain/rules.ts";
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
const check = quoteChecker({ agent: "VizipediaBot/0.2 (seed validation)" });
const sections = [{ kind: "lede", heading: "", body: page.lede }, ...(page.sections ?? [])];
const kindOf = (heading: string): SectionKind => (sections.find((section) => section.heading === heading)?.kind ?? "prose") as SectionKind;
let experiences = 0;
let found = 0;

async function checkOne(label: string, kind: SectionKind, body: unknown, rawSources: unknown): Promise<void> {
  const sources = parseSources(rawSources);
  if (typeof sources === "string") {
    problems.push(`${label}: ${sources}`);
    return;
  }
  const text = typeof body === "string" ? body : kind === "data" && body && typeof body === "object" ? JSON.stringify(body) : String(body ?? "");
  const checked = checkVersion(kind, { body: text, sources, note: null });
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
  await checkOne(label, kind, section.body, section.sources);
  if (kind === "experience" && previewDir) {
    experiences += 1;
    mkdirSync(previewDir, { recursive: true });
    for (const surface of ["sheet", "stage"] as const) {
      const html = experienceDocument({ fragment: String(section.body), hue, surface, page: { slug, title: page.title }, data: page.data ?? null });
      const framed = html.replace("<body>", `<body style="background:var(--ow-bg);padding:24px">`);
      writeFileSync(join(previewDir, `${slug}-${experiences}-${surface}.html`), framed);
    }
  }
}
if (page.data !== undefined) await checkOne("data", "data", page.data, undefined);

const writers = new Set(Object.keys(page.writers ?? {}));
for (const [index, edit] of (page.edits ?? []).entries()) {
  const label = `edit ${index + 1} (${edit.section}, @${edit.owner})`;
  if (!sections.some((section) => section.heading === edit.section)) problems.push(`${label}: no section with that heading`);
  if (!HANDLE.test(edit.owner)) problems.push(`${label}: "${edit.owner}" is not a handle`);
  else if (!writers.has(edit.owner)) problems.push(`${label}: @${edit.owner} is not in "writers", so it has no model`);
  await checkOne(label, kindOf(edit.section), edit.body, edit.sources);
}

console.log(JSON.stringify({ slug, hue, sections: sections.length, edits: page.edits?.length ?? 0, quotesFound: found, problems }, null, 2));
process.exit(problems.length > 0 ? 1 : 0);
