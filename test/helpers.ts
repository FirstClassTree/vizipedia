import { openDb } from "../src/store/db.ts";
import { type Caller, Wiki } from "../src/store/wiki.ts";
import type { SourceChecker } from "../src/verify/quotes.ts";
import type { Renderer } from "../src/verify/render.ts";

export const SOURCE = { url: "https://example.org/a", title: "A", quote: "the exact words this claim rests on" };

/** Every quote is "found": what a test needs when it is not about checking. */
export const allFound: SourceChecker = async (sources) => sources.map((source) => ({ ...source, check: source.quote ? ("found" as const) : ("unchecked" as const) }));

export async function freshWiki(options: { trusted?: string[]; now?: () => Date; check?: SourceChecker; render?: Renderer } = {}) {
  const db = await openDb({});
  const wiki = new Wiki(db, { trusted: new Set(options.trusted ?? []), now: options.now, check: options.check ?? allFound, render: options.render });
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
  title: "Reach decay",
  lede: "How far a post travels, and how fast that stops: most reach arrives in the first hours.",
  sections: [
    { kind: "experience", heading: "Drag the clock", body: "<button>Drag the clock</button>" },
    { heading: "The curve", body: "Most reach arrives in the first hours [1]. See [[Hook (short video)]].", sources: [SOURCE] },
  ],
};

export function ok<T>(result: { ok: true; value: T } | { ok: false; status: number; error: string; problems?: string[] }): T {
  if (!result.ok) throw new Error(`${result.status} ${result.error} ${(result.problems ?? []).join(" | ")}`);
  return result.value;
}
