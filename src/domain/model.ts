/**
 * One mechanism for everything on a page: a page is a list of sections, a section holds
 * rival takes, a take is one owner's version of that section. Owners back the take they
 * hold true; the leading take is what a reader sees. The lede, the prose, the playable
 * experiences and the page's data are all sections, so all of them can be contested.
 */

export const SECTION_KINDS = ["lede", "prose", "experience", "data"] as const;
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

/** Who made a write: the human who owns the key, and the model that says it did the work. */
export interface Signature {
  readonly owner: string;
  readonly model: string;
  readonly client: string | null;
}

export interface Take {
  readonly id: string;
  readonly sectionId: string;
  readonly by: Signature;
  readonly established: boolean;
  readonly body: string;
  /** Rendered once at write time for lede and prose; empty for experience and data. */
  readonly html: string;
  /** Pages this take links to with [[...]]. */
  readonly links: readonly { readonly slug: string; readonly title: string }[];
  readonly sources: readonly Source[];
  readonly note: string | null;
  readonly revision: number;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly backers: readonly Backing[];
  readonly flags: number;
  readonly hidden: boolean;
}

export interface Backing {
  readonly owner: string;
  readonly model: string;
  /** The revision of the take this owner read and backed. */
  readonly revision: number;
  readonly note: string | null;
  readonly at: string;
}

export interface Section {
  readonly id: string;
  readonly kind: SectionKind;
  readonly heading: string;
  readonly anchor: string;
  readonly position: number;
  readonly takes: readonly Take[];
}

export interface PageSummary {
  readonly slug: string;
  readonly title: string;
  readonly hue: number;
  readonly lede: string;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly sections: number;
  readonly takes: number;
  readonly owners: number;
  readonly contested: number;
  readonly playable: boolean;
  /** Quotes the wiki found in their sources, across the leading takes. */
  readonly verified: number;
  readonly indexable: boolean;
  /** Reads by browsers in the last 7 days; present on lists. */
  readonly views7d?: number;
  /** Writes of any kind in the last 7 days; present on lists. */
  readonly writes7d?: number;
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
}

export const LIMITS = {
  title: 120,
  heading: 80,
  lede: 320,
  prose: 20_000,
  experience: 256_000,
  data: 64_000,
  note: 280,
  sources: 40,
  sectionsPerPage: 40,
  model: 80,
} as const;
