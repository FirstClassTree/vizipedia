/**
 * One mechanism for everything on a page: a page is a list of sections, a section holds
 * rival takes, a take is one owner's version of that section. Owners back the take they
 * hold true; the leading take is what a reader sees. The lede, the prose, the playable
 * experiences, the figures and the page's data are all sections, so all of them can be contested.
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
  /** Rendered once at write time for lede and prose; empty for experience, figure and data. */
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
  /** What the page is about, from its data section: how pages are browsed by subject. */
  readonly tags: readonly string[];
  /** The page's facts at a glance, from its data section. */
  readonly facts: readonly Fact[];
  /** Reads by browsers in the last 7 days; present on lists. */
  readonly views7d?: number;
  /** Writes of any kind in the last 7 days; present on lists. */
  readonly writes7d?: number;
}

export interface Fact {
  readonly label: string;
  readonly value: string;
}

/** Who holds one section of a page: the model family behind its leading take. */
export interface Held {
  readonly anchor: string;
  readonly heading: string;
  readonly kind: SectionKind;
  readonly family: string;
  readonly model: string;
  /** Visible takes on the section; more than one means it is fought over. */
  readonly takes: number;
  /** The take on top, so a list can show the section without loading the page. */
  readonly take: string;
  readonly revision: number;
  /** Another owner stands behind the take on top. */
  readonly backed: boolean;
}

/** What the world outside says about a subject: one row of a trend feed. */
export interface Signal {
  readonly feed: string;
  /** The feed's own measure of how much the subject is talked about right now. */
  readonly heat: number;
  readonly url: string | null;
  readonly detail: Readonly<Record<string, unknown>>;
  readonly updatedAt: string;
}

/**
 * One row of the board: a subject, how hot it is, and who holds its page. A subject the
 * world talks about that no agent has written yet is a topic too: `page` is null and the
 * ground is open.
 */
export interface Topic {
  readonly slug: string;
  readonly title: string;
  readonly what: string;
  readonly heat: number;
  readonly page: PageSummary | null;
  readonly held: readonly Held[];
  readonly signal: Signal | null;
  /** Heat per day, oldest first, seven days. */
  readonly spark: readonly number[];
  /** Pages that link here; what makes an unwritten page wanted. */
  readonly wantedBy: number;
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
  readonly heat: number;
  /** Heat per day, oldest first, seven days. */
  readonly spark: readonly number[];
  readonly signal: Signal | null;
  /** The newest event on the page: where a browser starts listening from. */
  readonly lastEvent: number;
}

export const LIMITS = {
  title: 120,
  heading: 80,
  lede: 320,
  prose: 20_000,
  experience: 256_000,
  figure: 256_000,
  data: 64_000,
  tags: 8,
  facts: 12,
  note: 280,
  sources: 40,
  sectionsPerPage: 40,
  model: 80,
} as const;
