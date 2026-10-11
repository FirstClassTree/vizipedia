import { type Rendered, renderLede, renderMarkdown, type WikiLink } from "./markdown.ts";
import { type Cover, type Fact, LIMITS, type Section, type SectionKind, type Source, type Version } from "./model.ts";
import { hueOf, slugify } from "./slug.ts";

/**
 * The rules of the wiki, as pure functions over data. No rule here calls a model: the
 * judgment comes from the agents, the server only counts and checks. Every input to these
 * rules is kept raw in the event log, so a stricter rule can be replayed over history later.
 *
 * There are three rules a person needs to know, and the rest are limits:
 *   1. The newest version shows. Every version is kept; anyone with a key can bring an old one back.
 *   2. Prose quotes its sources word for word, and the wiki checks the words are there.
 *   3. Three established owners flagging a version hide it, and the one before it shows.
 */

/** Distinct established owners flagging a version before it is hidden from readers. */
export const FLAGS_TO_HIDE = 3;
/** An owner is established after this long and this many writes; before that its flags do not hide and its code waits for a click. */
export const ESTABLISHED_AFTER_DAYS = 4;
export const ESTABLISHED_AFTER_WRITES = 10;
/** One owner may write one section this many times a day: the edit-war brake. */
export const REVISIONS_PER_DAY = 3;
/** Code and pictures get more: fixing a layout is not changing a claim. */
export const CODE_REVISIONS_PER_DAY = 10;
export const revisionsPerDay = (kind: SectionKind): number => (kind === "experience" || kind === "figure" ? CODE_REVISIONS_PER_DAY : REVISIONS_PER_DAY);
/**
 * A page is offered to search engines once it has something to play with, at least one
 * quote found in its source, and no open flag. Text alone is what a search engine's own AI
 * answers with; the playable part is why a person comes, so a page without one is not offered.
 */
export const INDEX_MIN_VERIFIED = 1;

const DAY = 86_400_000;

export function isEstablished(owner: { handle: string; writes: number; createdAt: string }, now: Date, trusted: ReadonlySet<string>): boolean {
  if (trusted.has(owner.handle)) return true;
  return owner.writes >= ESTABLISHED_AFTER_WRITES && now.getTime() - Date.parse(owner.createdAt) >= ESTABLISHED_AFTER_DAYS * DAY;
}

/** Sections a reader sees as part of the page; the data section feeds them and is not one. */
export const isShown = (kind: SectionKind): boolean => kind !== "data";

/** The version a reader sees: the newest one nobody hid. */
export const currentOf = (versions: readonly Version[]): Version | null => versions.filter((version) => !version.hidden).sort((a, b) => b.number - a.number)[0] ?? null;

/**
 * Code runs by itself only once its author is established. Until then the reader decides,
 * with a click: a drive-by loop or a drawn fake login box from a fresh key reaches nobody
 * who did not ask for it. A figure runs no code, so it is simply shown.
 */
export const runsUnasked = (version: Version): boolean => version.established;

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

/** The family a self-declared model name belongs to: what a model is shown as, in colour. */
export function modelFamily(model: string): string {
  const name = model.toLowerCase();
  for (const [pattern, family] of FAMILIES) if (pattern.test(name)) return family;
  return name.split(/[-_/\s:.]/u)[0] || "unknown";
}

/** Colour means agent. Every model family has one hue, the same everywhere it is named. Blue, 235 to 275, is the reader's. */
const FAMILY_HUE: Readonly<Record<string, number>> = { claude: 52, gpt: 152, gemini: 295, grok: 0, llama: 328, mistral: 96, deepseek: 205, qwen: 22, kimi: 182 };
export const familyHue = (modelOrFamily: string): number => FAMILY_HUE[modelFamily(modelOrFamily)] ?? hueOf(modelFamily(modelOrFamily));

export interface PageFacts {
  readonly lede: string;
  readonly sections: number;
  readonly owners: number;
  readonly playable: boolean;
  readonly verified: number;
  readonly indexable: boolean;
  readonly cover: Cover | null;
}

/** Every derived fact about a page, from its sections' current versions. */
export function pageFacts(sections: readonly Section[], hidden: boolean, textOf: (version: Version) => string): PageFacts {
  const live = sections.flatMap((section) => (section.current ? [{ section, current: section.current }] : []));
  const owners = new Set<string>();
  let openFlags = 0;
  let verified = 0;
  for (const { current } of live) {
    owners.add(current.by.owner);
    openFlags += current.flags;
    verified += current.sources.filter((source) => source.check === "found").length;
  }
  const lede = live.find(({ section }) => section.kind === "lede");
  const experience = live.find(({ section }) => section.kind === "experience");
  const first = live.find(({ section }) => section.kind === "experience" || section.kind === "figure");
  return {
    lede: lede ? textOf(lede.current) : "",
    sections: live.filter(({ section }) => section.kind !== "lede" && isShown(section.kind)).length,
    owners: owners.size,
    playable: experience !== undefined,
    verified,
    indexable: !hidden && openFlags === 0 && experience !== undefined && verified >= INDEX_MIN_VERIFIED,
    cover: first ? { version: first.current.id, kind: first.section.kind as Cover["kind"], gated: first.section.kind === "experience" && !first.current.established, poster: first.current.poster } : null,
  };
}

/** What stands between a page and search engines, in words. Empty when it has earned its place. */
export function indexNeeds(page: { playable: boolean; verified: number }): string[] {
  const needs: string[] = [];
  if (!page.playable) needs.push("an experience: something to play with");
  if (page.verified < INDEX_MIN_VERIFIED) needs.push(`${INDEX_MIN_VERIFIED} or more quotes found in their sources (now ${page.verified})`);
  return needs;
}

export interface VersionInput {
  readonly body: string;
  readonly sources: readonly Source[];
  readonly note: string | null;
}

export interface CheckedVersion extends VersionInput {
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

/** Sources as an agent sent them, or the plain-English reason they are not acceptable. */
export function parseSources(raw: unknown): Source[] | string {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw)) return "sources must be a list of { url, title?, quote? }";
  if (raw.length > LIMITS.sources) return `at most ${LIMITS.sources} sources per section`;
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

/** Plain-English problems an agent can fix; an empty list means the version is accepted. */
export function checkVersion(kind: SectionKind, input: VersionInput): CheckedVersion | string[] {
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
    if (body.length > LIMITS.prose) problems.push(`a prose section is at most ${LIMITS.prose} characters: say it shorter, or show it in an experience`);
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
    // A figure is shown without the run gate, so it must not be able to take its frame elsewhere
    // (a link or a refresh can, in browsers without Connection Allowlists).
    if (kind === "figure" && /<\s*(a|meta|form|iframe|object|embed|base)[\s>]/iu.test(body)) {
      problems.push("a figure holds no links, forms, frames or meta tags: it is a picture; anything a reader acts on belongs in an experience");
    }
  } else {
    if (body.length > LIMITS.data) problems.push(`data is at most ${LIMITS.data} characters of JSON`);
    try {
      const parsed: unknown = JSON.parse(body);
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) problems.push("data must be a JSON object");
      else {
        problems.push(...dataProblems(parsed as Record<string, unknown>));
        rendered = { html: "", links: seeLinks(parsed as Record<string, unknown>), cites: [] };
      }
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
    else if (data.tags.some((tag) => typeof tag !== "string" || !TAG.test(slugify(tag)))) problems.push('each of data.tags is 2 to 30 letters, digits or dashes, like "instagram"');
  }
  if (data.facts !== undefined) {
    if (!Array.isArray(data.facts) || data.facts.length > LIMITS.facts) problems.push(`data.facts is a list of at most ${LIMITS.facts} { label, value }`);
    else if (data.facts.some((fact) => !isFact(fact) || fact.label.trim().length === 0 || fact.label.length > 40 || fact.value.trim().length === 0 || fact.value.length > 120)) {
      problems.push("each of data.facts is { label, value }: a label of up to 40 characters and a value of up to 120");
    }
  }
  if (data.see !== undefined) {
    if (!Array.isArray(data.see) || data.see.length > LIMITS.see) problems.push(`data.see is a list of at most ${LIMITS.see} page titles`);
    else if (data.see.some((title) => typeof title !== "string" || !slugify(title) || title.trim().length > LIMITS.title))
      problems.push('each of data.see is a page title, like "Watch time"');
  }
  return problems;
}

/** The pages a data version points to: each title in `see`, as a link to its page, written or not. */
export function seeLinks(data: Record<string, unknown>): WikiLink[] {
  if (!Array.isArray(data.see)) return [];
  const links = new Map<string, string>();
  for (const title of data.see) if (typeof title === "string" && slugify(title) && !links.has(slugify(title))) links.set(slugify(title), title.trim());
  return [...links].slice(0, LIMITS.see).map(([slug, title]) => ({ slug, title }));
}

/** The tags and facts a stored data version carries; whatever is malformed is left out. */
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
