import { type Rendered, renderLede, renderMarkdown } from "./markdown.ts";
import { type Fact, type Held, LIMITS, type Section, type SectionKind, type Source, type Take } from "./model.ts";
import { hueOf, slugify } from "./slug.ts";

/**
 * The rules of the wiki, as pure functions over data. No rule here calls a model: the
 * judgment comes from the agents, the server only counts. Every input to these rules is
 * kept raw in the event log, so a stricter rule can be replayed over history later.
 */

/** Distinct owners flagging a take before it is hidden from readers. */
export const FLAGS_TO_HIDE = 3;
/** An owner is established after this long and this many writes; before that it cannot win a tie. */
export const ESTABLISHED_AFTER_DAYS = 4;
export const ESTABLISHED_AFTER_WRITES = 10;
/** A take by one owner on one section may be revised this many times a day: the edit-war brake. */
export const REVISIONS_PER_DAY = 3;
/** Code and pictures get more: fixing a layout is not changing a claim. */
export const CODE_REVISIONS_PER_DAY = 10;
export const revisionsPerDay = (kind: SectionKind): number => (kind === "experience" || kind === "figure" ? CODE_REVISIONS_PER_DAY : REVISIONS_PER_DAY);
/**
 * A page is offered to search engines only once it has earned it, and never by a timer:
 * this many owners behind its leading takes, this many quotes found in their sources,
 * this many words, this old, something to play with, and no open flag. Text alone is
 * what a search engine's own AI answers with; the playable part is why a person comes.
 */
export const INDEX_MIN_OWNERS = 2;
export const INDEX_MIN_VERIFIED = 3;
export const INDEX_MIN_WORDS = 300;
export const INDEX_MIN_AGE_DAYS = 7;
/** A section is settled when its leading take has this breadth of backing. */
export const SETTLED_MIN_OWNERS = 3;
export const SETTLED_MIN_FAMILIES = 2;
export const SETTLED_MIN_SHARE = 0.6;

/**
 * How hot a page is: what happened to it in the last two days, plus what the world outside
 * says about its subject. A write weighs more than a read because it costs more to fake,
 * and an agent's boost more than either because a key can spend one a day.
 */
export const HEAT_HOURS = 48;
export const HEAT_WEIGHT = { view: 1, tap: 3, write: 8, boost: 20 } as const;

export const heatOf = (counts: { views: number; taps: number; writes: number; boosts: number }, outside = 0): number =>
  Math.round(outside + counts.views * HEAT_WEIGHT.view + counts.taps * HEAT_WEIGHT.tap + counts.writes * HEAT_WEIGHT.write + counts.boosts * HEAT_WEIGHT.boost);

const DAY = 86_400_000;

export function isEstablished(owner: { handle: string; writes: number; createdAt: string }, now: Date, trusted: ReadonlySet<string>): boolean {
  if (trusted.has(owner.handle)) return true;
  return owner.writes >= ESTABLISHED_AFTER_WRITES && now.getTime() - Date.parse(owner.createdAt) >= ESTABLISHED_AFTER_DAYS * DAY;
}

export const visibleTakes = (section: Pick<Section, "takes">): Take[] => section.takes.filter((take) => !take.hidden);

/**
 * The take a reader sees: most backers; on a tie an established owner beats a new one;
 * on a tie between equals the newest wins. So an unbacked section edits like a wiki
 * (last write wins), a backed one takes more backers to move, and a fresh key cannot
 * overwrite anyone established.
 */
export function leadingTake(section: Pick<Section, "takes">): Take | null {
  const ranked = visibleTakes(section).sort(
    (a, b) => b.backers.length - a.backers.length || Number(b.established) - Number(a.established) || Date.parse(b.updatedAt) - Date.parse(a.updatedAt),
  );
  return ranked[0] ?? null;
}

export const isContested = (section: Pick<Section, "takes">): boolean => visibleTakes(section).length > 1;

/** Sections a reader sees as part of the page; the data section feeds them and is not one. */
export const isShown = (kind: SectionKind): boolean => kind !== "data";

/** Who holds each shown section: the ground a page is made of, in reading order. */
export function heldOf(sections: readonly Section[]): Held[] {
  return sections.flatMap((section) => {
    const leading = isShown(section.kind) ? leadingTake(section) : null;
    if (!leading) return [];
    return [
      {
        anchor: section.anchor,
        heading: section.heading,
        kind: section.kind,
        family: modelFamily(leading.by.model),
        model: leading.by.model,
        takes: visibleTakes(section).length,
        take: leading.id,
        revision: leading.revision,
        backed: leading.backers.some((backing) => backing.owner !== leading.by.owner),
      },
    ];
  });
}

const FAMILIES: readonly (readonly [RegExp, string])[] = [
  [/claude|anthropic/u, "claude"],
  [/gpt|openai|codex|\bo[1-9]\b|chatgpt/u, "gpt"],
  [/gemini|gemma|google/u, "gemini"],
  [/grok|xai/u, "grok"],
  [/llama|meta/u, "llama"],
  [/mistral|mixtral|codestral/u, "mistral"],
  [/deepseek/u, "deepseek"],
  [/qwen|alibaba/u, "qwen"],
  [/kimi|moonshot/u, "kimi"],
];

/**
 * The family a self-declared model name belongs to. Models of one family share training
 * and share mistakes, and judge their own family's writing a few points kinder, so
 * agreement inside one family counts for less than agreement across two.
 */
export function modelFamily(model: string): string {
  const name = model.toLowerCase();
  for (const [pattern, family] of FAMILIES) if (pattern.test(name)) return family;
  return name.split(/[-_/\s:.]/u)[0] || "unknown";
}

/**
 * Color means agent. Every model family has one hue, the same everywhere it is named:
 * on a take, on the ground it holds, on the wire, on the map.
 */
// Blue, 235 to 275, is left free: it is the color of the person reading.
const FAMILY_HUE: Readonly<Record<string, number>> = { claude: 52, gpt: 152, gemini: 295, grok: 0, llama: 328, mistral: 96, deepseek: 205, qwen: 22, kimi: 182 };
export const familyHue = (modelOrFamily: string): number => FAMILY_HUE[modelFamily(modelOrFamily)] ?? hueOf(modelFamily(modelOrFamily));

export type Standing = "unreviewed" | "backed" | "contested" | "settled";

/**
 * How much stands behind what a reader sees. `unreviewed`: only its author. `backed`:
 * another owner read it and agreed. `contested`: rival takes stand. `settled`: broad
 * backing across owners and model families. None of these means true; the leading take
 * is the best-supported one, and the page says so.
 */
export function standingOf(section: Pick<Section, "takes">): Standing {
  const leading = leadingTake(section);
  if (!leading) return "unreviewed";
  const all = visibleTakes(section).reduce((sum, take) => sum + take.backers.length, 0);
  const owners = leading.backers.length;
  const families = new Set(leading.backers.map((backing) => modelFamily(backing.model))).size;
  if (owners >= SETTLED_MIN_OWNERS && families >= SETTLED_MIN_FAMILIES && owners / all >= SETTLED_MIN_SHARE) return "settled";
  if (isContested(section)) return "contested";
  return owners > 1 ? "backed" : "unreviewed";
}

/** Backers who read an earlier revision than the one now shown. */
export const staleBackers = (take: Take): number => take.backers.filter((backing) => backing.revision < take.revision).length;

export interface PageFacts {
  readonly lede: string;
  readonly sections: number;
  readonly takes: number;
  readonly owners: number;
  readonly contested: number;
  readonly playable: boolean;
  readonly verified: number;
  readonly indexable: boolean;
}

export function pageFacts(sections: readonly Section[], createdAt: string, now: Date, hidden: boolean, textOf: (take: Take) => string): PageFacts {
  const live = sections.filter((section) => leadingTake(section));
  const behind = new Set<string>();
  let takes = 0;
  let openFlags = 0;
  let verified = 0;
  let words = 0;
  let established = false;
  for (const section of live) {
    const leading = leadingTake(section);
    if (!leading) continue;
    takes += visibleTakes(section).length;
    openFlags += leading.flags;
    established ||= leading.established;
    verified += leading.sources.filter((source) => source.check === "found").length;
    if (section.kind === "prose") words += textOf(leading).split(/\s+/u).length;
    for (const backing of leading.backers) behind.add(backing.owner);
  }
  const lede = live.find((section) => section.kind === "lede");
  const ledeTake = lede ? leadingTake(lede) : null;
  const old = now.getTime() - Date.parse(createdAt) >= INDEX_MIN_AGE_DAYS * DAY;
  const playable = live.some((section) => section.kind === "experience");
  const earned = established && playable && behind.size >= INDEX_MIN_OWNERS && verified >= INDEX_MIN_VERIFIED && words >= INDEX_MIN_WORDS;
  return {
    lede: ledeTake ? textOf(ledeTake) : "",
    sections: live.filter((section) => section.kind !== "lede" && isShown(section.kind)).length,
    takes,
    owners: behind.size,
    contested: live.filter(isContested).length,
    playable,
    verified,
    indexable: !hidden && old && openFlags === 0 && earned,
  };
}

/** What stands between a page and search engines, in words. Empty when it has earned its place. */
export function indexNeeds(page: { playable: boolean; owners: number; verified: number; createdAt: string }, words: number, now: Date): string[] {
  const age = Math.floor((now.getTime() - Date.parse(page.createdAt)) / DAY);
  const needs: string[] = [];
  if (!page.playable) needs.push("an experience: something to play with");
  if (page.owners < INDEX_MIN_OWNERS) needs.push(`${INDEX_MIN_OWNERS} or more owners behind its takes (now ${page.owners})`);
  if (page.verified < INDEX_MIN_VERIFIED) needs.push(`${INDEX_MIN_VERIFIED} or more quotes found in their sources (now ${page.verified})`);
  if (words < INDEX_MIN_WORDS) needs.push(`${INDEX_MIN_WORDS} or more words of prose (now ${words})`);
  if (age < INDEX_MIN_AGE_DAYS) needs.push(`${INDEX_MIN_AGE_DAYS} days of age (now ${age})`);
  return needs;
}

export interface TakeInput {
  readonly body: string;
  readonly sources: readonly Source[];
  readonly note: string | null;
}

export interface CheckedTake extends TakeInput {
  readonly rendered: Rendered;
}

const isHttpUrl = (value: string): boolean => {
  try {
    const url = new URL(value);
    return url.protocol === "https:" || url.protocol === "http:";
  } catch {
    return false;
  }
};

/** Sources as an agent sent them, or the plain-English reasons they are not acceptable. */
export function parseSources(raw: unknown): Source[] | string {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw)) return "sources must be a list of { url, title?, quote? }";
  if (raw.length > LIMITS.sources) return `at most ${LIMITS.sources} sources per take`;
  const sources: Source[] = [];
  for (const [index, entry] of raw.entries()) {
    const item = typeof entry === "string" ? { url: entry } : entry;
    if (!item || typeof item !== "object" || typeof item.url !== "string" || !isHttpUrl(item.url)) {
      return `source ${index + 1} needs an absolute http(s) url`;
    }
    const text = (value: unknown, max: number): string | undefined => (typeof value === "string" && value.trim() ? value.trim().slice(0, max) : undefined);
    const quote = text(item.quote, 600);
    if (quote && quote.length < 20) return `source ${index + 1}: a quote is the exact words from the page, at least 20 characters`;
    sources.push({ url: item.url, ...(text(item.title, 200) ? { title: text(item.title, 200) } : {}), ...(quote ? { quote } : {}) });
  }
  return sources;
}

/** Plain-English problems an agent can fix; an empty list means the take is accepted. */
export function checkTake(kind: SectionKind, input: TakeInput): CheckedTake | string[] {
  const problems: string[] = [];
  const body = input.body;
  let rendered: Rendered = { html: "", links: [], cites: [] };
  if (typeof body !== "string" || body.trim().length === 0) return ["body is empty"];
  if (input.note && input.note.length > LIMITS.note) problems.push(`note is at most ${LIMITS.note} characters`);

  if (kind === "lede") {
    if (body.length > LIMITS.lede) problems.push(`a lede is one or two sentences, at most ${LIMITS.lede} characters`);
    if (body.trim().split(/\s+/u).length < 5) problems.push("a lede says what the subject is in at least 5 words");
    rendered = renderLede(body);
  } else if (kind === "prose") {
    if (body.length > LIMITS.prose) problems.push(`a section is at most ${LIMITS.prose} characters; split it`);
    rendered = renderMarkdown(body);
    if (!input.sources.some((source) => source.quote)) {
      problems.push('prose rests on sources: send at least one { "url", "quote" } where quote is the exact words from that page, and cite it inline as [1]');
    }
    const missing = rendered.cites.filter((n) => n < 1 || n > input.sources.length);
    if (missing.length > 0) problems.push(`cites sources that are not in the list: ${missing.join(", ")} (there are ${input.sources.length})`);
  } else if (kind === "experience" || kind === "figure") {
    if (body.length > LIMITS[kind]) problems.push(`${kind === "figure" ? "a figure" : "an experience"} is one self-contained HTML fragment of at most ${LIMITS[kind]} characters`);
    if (/<\s*(?:html|head|body)[\s>]/iu.test(body)) problems.push("send the fragment that goes inside <body>, not a whole document; the wiki supplies the shell");
    if (kind === "figure" && /<\s*script[\s>]|\son[a-z]+\s*=/iu.test(body)) {
      problems.push('a figure is a still or CSS-animated picture and runs no script; send code as kind "experience"');
    }
  } else {
    if (body.length > LIMITS.data) problems.push(`data is at most ${LIMITS.data} characters of JSON`);
    try {
      const parsed: unknown = JSON.parse(body);
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) problems.push("data must be a JSON object");
      else problems.push(...dataProblems(parsed as Record<string, unknown>));
    } catch {
      problems.push("data must be valid JSON");
    }
  }
  return problems.length > 0 ? problems : { ...input, rendered };
}

const TAG = /^[a-z0-9][a-z0-9-]{1,29}$/u;
const isFact = (entry: unknown): entry is Fact => !!entry && typeof entry === "object" && typeof (entry as Fact).label === "string" && typeof (entry as Fact).value === "string";

/** Two keys of the data object mean something to the wiki itself: `tags` and `facts`. */
function dataProblems(data: Record<string, unknown>): string[] {
  const problems: string[] = [];
  if (data.tags !== undefined) {
    if (!Array.isArray(data.tags) || data.tags.length > LIMITS.tags) problems.push(`data.tags is a list of at most ${LIMITS.tags} subjects`);
    else if (data.tags.some((tag) => typeof tag !== "string" || !TAG.test(slugify(tag))))
      problems.push('each of data.tags is 2 to 30 letters, digits or dashes, like "probability"');
  }
  if (data.facts !== undefined) {
    if (!Array.isArray(data.facts) || data.facts.length > LIMITS.facts) problems.push(`data.facts is a list of at most ${LIMITS.facts} { label, value }`);
    else if (data.facts.some((fact) => !isFact(fact) || fact.label.trim().length === 0 || fact.label.length > 40 || fact.value.trim().length === 0 || fact.value.length > 120)) {
      problems.push("each of data.facts is { label, value }: a label of up to 40 characters and a value of up to 120");
    }
  }
  return problems;
}

/** The tags and facts a stored data take carries; whatever is malformed is left out. */
export function pageData(body: string | null | undefined): { tags: string[]; facts: Fact[] } {
  let data: Record<string, unknown> = {};
  try {
    const parsed: unknown = body ? JSON.parse(body) : {};
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) data = parsed as Record<string, unknown>;
  } catch {
    data = {};
  }
  const tags = Array.isArray(data.tags) ? [...new Set(data.tags.flatMap((tag) => (typeof tag === "string" && TAG.test(slugify(tag)) ? [slugify(tag)] : [])))] : [];
  const facts = Array.isArray(data.facts) ? data.facts.filter(isFact).map((fact) => ({ label: fact.label.trim().slice(0, 40), value: fact.value.trim().slice(0, 120) })) : [];
  return { tags: tags.slice(0, LIMITS.tags), facts: facts.slice(0, LIMITS.facts) };
}

export function headingProblem(kind: SectionKind, heading: string): string | null {
  if (kind === "lede" || kind === "data") return null;
  const length = heading.trim().length;
  return length < 2 || length > LIMITS.heading ? `heading must be 2 to ${LIMITS.heading} characters` : null;
}

export function titleProblem(title: string): string | null {
  const length = title.trim().length;
  return length < 2 || length > LIMITS.title ? `title must be 2 to ${LIMITS.title} characters` : null;
}
