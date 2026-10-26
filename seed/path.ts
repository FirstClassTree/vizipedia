// Put the seed pages' learning path on a wiki that already has them, without re-seeding:
// for each seed page, the live data section is read, `before` and `read` (and any `see`
// titles the seed has and the live page lacks) are merged in, and the section is written
// once. Everything else in the live data section is kept: a page another agent improved
// keeps its facts.
//
//   node seed/path.ts https://shapelessai.com/vizipedia --owner vizipedia --model <id> [--dry]
//
// The key comes from .seed-keys.json like seed.ts. Pages missing on the wiki are skipped and listed.
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileKeys } from "./seed.ts";

const args = process.argv.slice(2);
const flag = (name: string, fallback: string): string => {
  const at = args.indexOf(`--${name}`);
  return at >= 0 ? (args.splice(at, 2)[1] ?? fallback) : fallback;
};
const dry = args.includes("--dry");
const owner = flag("owner", "vizipedia");
const model = flag("model", "claude-opus-5-5");
const url = (args.find((arg) => /^https?:/u.test(arg)) ?? "http://localhost:4173").replace(/\/+$/u, "");
const dir = new URL("./pages", import.meta.url).pathname;
const key = await fileKeys(url)(owner);

interface Live {
  slug: string;
  sections: { id: string; kind: string; current: { body: string } | null }[];
}

const skipped: string[] = [];
for (const file of readdirSync(dir)
  .filter((name) => name.endsWith(".json"))
  .sort()) {
  const seed = JSON.parse(readFileSync(join(dir, file), "utf8")) as { slug?: string; data?: Record<string, unknown> };
  const slug = seed.slug ?? file.replace(/\.json$/u, "");
  const want = seed.data ?? {};
  if (!Array.isArray(want.before) && !Array.isArray(want.read)) continue;
  const found = await fetch(`${url}/api/pages/${slug}`);
  if (!found.ok) {
    skipped.push(slug);
    continue;
  }
  const live = (await found.json()) as Live;
  const section = live.sections.find((candidate) => candidate.kind === "data");
  const current: Record<string, unknown> = section?.current?.body ? (JSON.parse(section.current.body) as Record<string, unknown>) : {};
  const see = [...new Set([...((current.see as string[] | undefined) ?? []), ...((want.see as string[] | undefined) ?? [])])];
  const next = { ...current, see, before: want.before ?? current.before, read: want.read ?? current.read };
  const same = JSON.stringify(next) === JSON.stringify(current);
  console.log(`${same ? "same " : dry ? "would" : "write"} ${slug}: before ${JSON.stringify(next.before)}`);
  if (same || dry) continue;
  const note = "Learning path: what to know first, and where to read more (seed/path.ts).";
  const written = section
    ? await fetch(`${url}/api/sections/${section.id}`, {
        method: "PUT",
        headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
        body: JSON.stringify({ model, body: next, note }),
      })
    : await fetch(`${url}/api/pages/${slug}/sections`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
        body: JSON.stringify({ model, kind: "data", heading: "data", body: next, note }),
      });
  if (!written.ok) console.error(`  ${written.status} ${await written.text()}`);
}
if (skipped.length > 0) console.log(`not on the wiki: ${skipped.join(", ")}`);
