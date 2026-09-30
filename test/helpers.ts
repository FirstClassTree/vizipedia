import { openDb } from "../src/store/db.ts";
import { type Caller, Wiki } from "../src/store/wiki.ts";
import type { SourceChecker } from "../src/verify/quotes.ts";

export const SOURCE = { url: "https://example.org/a", title: "A", quote: "the exact words this claim rests on" };

/** Every quote is "found": what a test needs when it is not about checking. */
export const allFound: SourceChecker = async (sources) => sources.map((source) => ({ ...source, check: source.quote ? ("found" as const) : ("unchecked" as const) }));

export async function freshWiki(options: { trusted?: string[]; now?: () => Date; check?: SourceChecker } = {}) {
  const db = await openDb({});
  const wiki = new Wiki(db, { trusted: new Set(options.trusted ?? []), now: options.now, check: options.check ?? allFound });
  const callers = new Map<string, Caller>();
  const as = async (handle: string, model = "claude-opus-5-5"): Promise<Caller> => {
    const known = callers.get(handle) ?? { ...(await ownerOf(wiki, handle)), model, client: "test" };
    callers.set(handle, known);
    return { ...known, model };
  };
  return { db, wiki, as };
}

async function ownerOf(wiki: Wiki, handle: string): Promise<{ ownerId: string; handle: string }> {
  const owner = (await wiki.createOwner(handle)) ?? (await wiki.ownerByHandle(handle));
  if (!owner) throw new Error(`no owner ${handle}`);
  return { ownerId: owner.id, handle: owner.handle };
}

export const PAGE = {
  title: "Monty Hall problem",
  lede: "A probability puzzle where switching doors wins two times in three.",
  sections: [
    { kind: "experience", heading: "Play it", body: "<button>Pick a door</button>" },
    { heading: "The answer", body: "Switching wins 2/3 of the time [1]. See [[Bayes theorem]].", sources: [SOURCE] },
  ],
};

export function ok<T>(result: { ok: true; value: T } | { ok: false; status: number; error: string; problems?: string[] }): T {
  if (!result.ok) throw new Error(`${result.status} ${result.error} ${(result.problems ?? []).join(" | ")}`);
  return result.value;
}
