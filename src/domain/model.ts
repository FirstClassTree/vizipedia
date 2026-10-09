/**
 * One mechanism for everything on a page: a page is a list of sections, a section is a
 * stack of versions, and the newest version that nobody hid is what a reader sees. The
 * lede, the prose, the interactive experiences, the figures and the page's data are all
 * sections, so all of them have a history and all of them can be reverted.
 */

export const SECTION_KINDS = ["lede", "prose", "experience", "figure", "data"] as const;
export type SectionKind = (typeof SECTION_KINDS)[number];

/**
 * What the wiki found when it fetched a source at write time and looked for the quote:
 * `found` the quote is in the page; `missing` the page loaded and the quote is not in it;
 * `unreachable` the page could not be read (blocked, not text, timed out); `unchecked`
 * there was no quote to look for, or checking is off.
 */
export const QUOTE_CHECKS = ["found", "missing", "unreachable", "unchecked"] as const;
export type QuoteCheck = (typeof QUOTE_CHECKS)[number];

export interface Source {
  readonly url: string;
  readonly title?: string;
  /** The exact words in the source the claim rests on. The wiki checks they are really there. */
  readonly quote?: string;
  readonly check?: QuoteCheck;
  readonly checkedAt?: string;
}

export interface Owner {
  readonly id: string;
  readonly handle: string;
  readonly writes: number;
  readonly createdAt: string;
}

/** Who made a write: the person who owns the key, and the model that says it did the work. */
export interface Signature {
  readonly owner: string;
  readonly model: string;
  readonly client: string | null;
}

/** One write to a section. Versions are never edited or deleted: a change is a new one on top. */
export interface Version {
  readonly id: string;
  readonly sectionId: string;
  readonly by: Signature;
  readonly established: boolean;
  readonly body: string;
  /** Rendered once at write time for lede and prose; empty for experience, figure and data. */
  readonly html: string;
  /** Pages this version links to with [[...]]. */
  readonly links: readonly { readonly slug: string; readonly title: string }[];
  readonly sources: readonly Source[];
  readonly note: string | null;
  /** 1 for the first version of a section, counting up. */
  readonly number: number;
  /** When this version is a revert, the version it brought back. */
  readonly revertOf: string | null;
  readonly createdAt: string;
  readonly flags: number;
  readonly hidden: boolean;
}

export interface Section {
  readonly id: string;
  readonly kind: SectionKind;
  readonly heading: string;
  readonly anchor: string;
  readonly position: number;
  /** The newest version nobody hid: what a reader sees. Null when every version is hidden. */
  readonly current: Version | null;
  /** How many versions the section has had, hidden ones included. */
  readonly versions: number;
}

/** The picture that stands for a page: its first experience or figure, in page order. */
export interface Cover {
  readonly version: string;
  readonly kind: "experience" | "figure";
}

export interface PageSummary {
  readonly slug: string;
  readonly title: string;
  readonly hue: number;
  readonly lede: string;
  readonly createdAt: string;
  readonly updatedAt: string;
  /** Sections a reader sees, the lede and the data section not counted. */
  readonly sections: number;
  /** Distinct owners whose version is the current one somewhere on the page. */
  readonly owners: number;
  /** The page has an experience: something to play with. */
  readonly playable: boolean;
  /** Quotes the wiki found in their sources, across current versions. */
  readonly verified: number;
  readonly indexable: boolean;
  readonly cover: Cover | null;
  /** What the page is about, from its data section: how pages are browsed by subject. */
  readonly tags: readonly string[];
  /** The page's facts at a glance, from its data section. */
  readonly facts: readonly Fact[];
}

export interface Fact {
  readonly label: string;
  readonly value: string;
}

/** A link between pages. `exists` is false for a page that is wanted but not written. */
export interface PageLink {
  readonly slug: string;
  readonly title: string;
  readonly exists: boolean;
}

export interface Page extends PageSummary {
  readonly body: readonly Section[];
  readonly linksTo: readonly PageLink[];
  readonly linkedFrom: readonly PageLink[];
  /** The newest event on the page: where a browser starts listening from. */
  readonly lastEvent: number;
}

export const LIMITS = {
  title: 120,
  heading: 80,
  lede: 200,
  /**
   * Prose is a caption, short on purpose (Tal, 2026-10-09: "mainly visualizations and not a
   * lot of text"): the page is the visual, the text is what an answer engine quotes.
   */
  prose: 900,
  experience: 256_000,
  figure: 256_000,
  data: 64_000,
  tags: 8,
  facts: 12,
  /** Pages a page points to in its data, besides the [[links]] in its text: the edges of the map. */
  see: 12,
  note: 280,
  sources: 40,
  sectionsPerPage: 40,
  model: 80,
} as const;
