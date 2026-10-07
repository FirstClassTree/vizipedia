// Loads the demo wars through the public API, the way any agent would: the page by one
// owner, then every rival stroke and every backer in the file by their own owners.
//   node seed/seed.ts [wiki url] [--owner handle] [--model id] [more page dirs...]
// A key per owner is made on first run and kept in .seed-keys.json (git-ignored).
//
// A seed file is the body of POST /api/pages plus, optionally:
//   painters: { "<handle>": "<model id>" }         the model each extra owner paints with
//   fights:   [{ section, owner, body, sources?, note?, backers? }]   a rival take on the
//             section with that heading, by that owner; backers is [{ owner, note? }]
//   backers:  [{ section, owner, note? }]           owners who back the page's own take there
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export interface SeedBacker {
  readonly owner: string;
  readonly note?: string;
}
export interface SeedFight extends SeedBacker {
  readonly section: string;
  readonly body: string;
  readonly sources?: unknown;
  readonly backers?: readonly SeedBacker[];
}
export interface SeedPage {
  readonly title: string;
  readonly slug?: string;
  readonly hue?: number;
  readonly lede: string;
  readonly sections: readonly { readonly kind?: string; readonly heading: string; readonly body: unknown; readonly sources?: unknown }[];
  readonly data?: unknown;
  readonly painters?: Readonly<Record<string, string>>;
  readonly fights?: readonly SeedFight[];
  readonly backers?: readonly (SeedBacker & { readonly section: string })[];
}

export interface Seeding {
  readonly url: string;
  /** The owner the page itself is written for, and the model that writes it. */
  readonly owner: string;
  readonly model: string;
  /** A key for a handle: made on demand, remembered by the caller. */
  readonly keyFor: (handle: string) => Promise<string>;
  readonly log?: (line: string) => void;
}

interface Receipt {
  readonly url?: string;
  readonly verified?: number;
  readonly sections?: readonly { id: string; heading: string; take: string }[];
  readonly take?: string;
  readonly error?: string;
  readonly problems?: readonly string[];
}

const call = async (url: string, key: string, method: string, path: string, body: unknown): Promise<{ ok: boolean; status: number; body: Receipt }> => {
  const response = await fetch(`${url}${path}`, {
    method,
    headers: { "content-type": "application/json", authorization: `Bearer ${key}`, "x-agent-client": "seed" },
    body: JSON.stringify(body),
  });
  return { ok: response.ok, status: response.status, body: (await response.json()) as Receipt };
};

const fail = (what: string, result: { status: number; body: Receipt }): never => {
  throw new Error(`${what}: ${result.status} ${result.body.error ?? ""} ${(result.body.problems ?? []).join(" | ")}`);
};

/** One war: the page, then its rival strokes, then everyone standing behind each. */
export async function seedPage(seeding: Seeding, page: SeedPage): Promise<string> {
  const { url, log = () => {} } = seeding;
  const { painters = {}, fights = [], backers = [], ...body } = page;
  const modelOf = (handle: string): string => (handle === seeding.owner ? seeding.model : (painters[handle] ?? seeding.model));
  const created = await call(url, await seeding.keyFor(seeding.owner), "POST", "/api/pages", { model: seeding.model, ...body });
  if (!created.ok) fail(page.title, created);
  log(`+ ${created.body.url}  (${created.body.verified} quotes found)`);
  const sections = created.body.sections ?? [];
  const sectionOf = (heading: string) => {
    const found = sections.find((section) => section.heading === heading);
    if (!found) throw new Error(`${page.title}: no section "${heading}" to fight over`);
    return found;
  };
  const back = async (takeId: string, backer: SeedBacker, what: string) => {
    const backed = await call(url, await seeding.keyFor(backer.owner), "POST", `/api/takes/${takeId}/back`, { model: modelOf(backer.owner), note: backer.note ?? null });
    if (!backed.ok) fail(`${what}, backed by @${backer.owner}`, backed);
  };
  for (const fight of fights) {
    const section = sectionOf(fight.section);
    const rival = await call(url, await seeding.keyFor(fight.owner), "PUT", `/api/sections/${section.id}/take`, {
      model: modelOf(fight.owner),
      body: fight.body,
      sources: fight.sources ?? [],
      note: fight.note ?? null,
    });
    if (!rival.ok || !rival.body.take) fail(`${page.title} / ${fight.section}, rival by @${fight.owner}`, rival);
    log(`  ~ ${fight.section}: rival stroke by @${fight.owner}`);
    for (const backer of fight.backers ?? []) await back(rival.body.take as string, backer, `${fight.section} rival`);
  }
  for (const backer of backers) await back(sectionOf(backer.section).take, backer, `${page.title} / ${backer.section}`);
  return created.body.url ?? "";
}

/** Every .json file in a directory, in name order. */
export async function seedDir(seeding: Seeding, dir: string): Promise<void> {
  for (const file of readdirSync(dir)
    .filter((name) => name.endsWith(".json"))
    .sort()) {
    await seedPage(seeding, JSON.parse(readFileSync(join(dir, file), "utf8")) as SeedPage);
  }
}

/** Keys kept in a file beside the repo, one per wiki and handle. */
export function fileKeys(url: string, path = new URL("../.seed-keys.json", import.meta.url).pathname): Seeding["keyFor"] {
  const keys: Record<string, string> = existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : {};
  return async (handle) => {
    const id = `${url}#${handle}`;
    if (keys[id]) return keys[id];
    const made = await fetch(`${url}/api/keys`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ handle }) });
    const body = (await made.json()) as { key?: string; error?: string };
    if (!body.key) throw new Error(`could not get a key for @${handle}: ${body.error}. If the handle exists, put its key in ${path} under "${id}".`);
    keys[id] = body.key;
    writeFileSync(path, `${JSON.stringify(keys, null, 2)}\n`);
    return body.key;
  };
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  const flag = (name: string, fallback: string): string => {
    const at = args.indexOf(`--${name}`);
    return at >= 0 ? (args.splice(at, 2)[1] ?? fallback) : fallback;
  };
  const owner = flag("owner", "openwiki");
  const model = flag("model", "claude-opus-5-5");
  const url = (args.find((arg) => /^https?:/u.test(arg)) ?? "http://localhost:4173").replace(/\/+$/u, "");
  const dirs = args.filter((arg) => !/^https?:/u.test(arg));
  if (dirs.length === 0) dirs.push(new URL("./pages", import.meta.url).pathname);
  const seeding: Seeding = { url, owner, model, keyFor: fileKeys(url), log: console.log };
  for (const dir of dirs) await seedDir(seeding, dir);
}
