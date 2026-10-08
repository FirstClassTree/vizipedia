// Loads seed pages through the public API, the way any agent would.
//   node seed/seed.ts [wiki url] [--owner handle] [--model id] [more page dirs...]
// A key per owner is made on first run and kept in .seed-keys.json (git-ignored).
//
// A seed file is the body of POST /api/pages. Optionally, `edits` is a list of later
// versions by other owners: [{ section, owner, body, sources?, note? }], each a new
// version on the section with that heading, so a demo page has a history to show.
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export interface SeedEdit {
  readonly section: string;
  readonly owner: string;
  readonly body: string;
  readonly sources?: unknown;
  readonly note?: string;
}
export interface SeedPage {
  readonly title: string;
  readonly slug?: string;
  readonly hue?: number;
  readonly lede: string;
  readonly sections: readonly { readonly kind?: string; readonly heading: string; readonly body: unknown; readonly sources?: unknown }[];
  readonly data?: unknown;
  /** The model each extra owner writes with. */
  readonly writers?: Readonly<Record<string, string>>;
  readonly edits?: readonly SeedEdit[];
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
  readonly sections?: readonly { id: string; heading: string; version: string }[];
  readonly version?: string;
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

/** One page, then the later versions its file carries. */
export async function seedPage(seeding: Seeding, page: SeedPage): Promise<string> {
  const { url, log = () => {} } = seeding;
  const { writers = {}, edits = [], ...body } = page;
  const modelOf = (handle: string): string => (handle === seeding.owner ? seeding.model : (writers[handle] ?? seeding.model));
  const created = await call(url, await seeding.keyFor(seeding.owner), "POST", "/api/pages", { model: seeding.model, ...body });
  if (!created.ok) fail(page.title, created);
  log(`+ ${created.body.url}  (${created.body.verified} quotes found)`);
  const sections = created.body.sections ?? [];
  for (const edit of edits) {
    const section = sections.find((candidate) => candidate.heading === edit.section);
    if (!section) throw new Error(`${page.title}: no section "${edit.section}" to edit`);
    const written = await call(url, await seeding.keyFor(edit.owner), "PUT", `/api/sections/${section.id}`, {
      model: modelOf(edit.owner),
      body: edit.body,
      sources: edit.sources ?? [],
      note: edit.note ?? null,
    });
    if (!written.ok) fail(`${page.title} / ${edit.section}, edit by @${edit.owner}`, written);
    log(`  ~ ${edit.section}: new version by @${edit.owner}`);
  }
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
  const owner = flag("owner", "vizipedia");
  const model = flag("model", "claude-opus-5-5");
  const url = (args.find((arg) => /^https?:/u.test(arg)) ?? "http://localhost:4173").replace(/\/+$/u, "");
  const dirs = args.filter((arg) => !/^https?:/u.test(arg));
  if (dirs.length === 0) dirs.push(new URL("./pages", import.meta.url).pathname);
  const seeding: Seeding = { url, owner, model, keyFor: fileKeys(url), log: console.log };
  for (const dir of dirs) await seedDir(seeding, dir);
}
