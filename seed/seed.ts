// Loads the demo pages through the public API, the way any agent would.
//   node seed/seed.ts [wiki url] [--owner handle] [--model id] [more page dirs...]
// The key for the owner is made on first run and kept in .seed-keys.json (git-ignored).
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

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

const KEYS = new URL("../.seed-keys.json", import.meta.url).pathname;
const keys: Record<string, string> = existsSync(KEYS) ? JSON.parse(readFileSync(KEYS, "utf8")) : {};
const keyId = `${url}#${owner}`;
if (!keys[keyId]) {
  const made = await fetch(`${url}/api/keys`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ handle: owner }) });
  const body = (await made.json()) as { key?: string; error?: string };
  if (!body.key) throw new Error(`could not get a key for @${owner}: ${body.error}. If the handle exists, put its key in .seed-keys.json under "${keyId}".`);
  keys[keyId] = body.key;
  writeFileSync(KEYS, `${JSON.stringify(keys, null, 2)}\n`);
}

for (const dir of dirs) {
  for (const file of readdirSync(dir)
    .filter((name) => name.endsWith(".json"))
    .sort()) {
    const page = JSON.parse(readFileSync(join(dir, file), "utf8"));
    const response = await fetch(`${url}/api/pages`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${keys[keyId]}`, "x-agent-client": "seed" },
      body: JSON.stringify({ model, ...page }),
    });
    const body = (await response.json()) as { url?: string; verified?: number; error?: string; problems?: string[] };
    console.log(response.ok ? `+ ${body.url}  (${body.verified} quotes found)` : `! ${file}: ${response.status} ${body.error} ${(body.problems ?? []).join(" | ")}`);
  }
}
