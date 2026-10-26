import { textOf, type WikiLink } from "../domain/markdown.ts";
import {
  type Cover,
  type Fact,
  LIMITS,
  type LinkRel,
  type Page,
  type PageSummary,
  type Reading,
  SECTION_KINDS,
  type Section,
  type SectionKind,
  type Source,
  type Version,
} from "../domain/model.ts";
import { checkVersion, FLAGS_TO_HIDE, headingProblem, isEstablished, pageData, pageFacts, parseSources, revisionsPerDay, titleProblem } from "../domain/rules.ts";
import { hueOf, slugify, slugProblem } from "../domain/slug.ts";
import { noChecker, type SourceChecker } from "../verify/quotes.ts";
import { noRenderer, type Renderer } from "../verify/render.ts";
import { noScreen, type Screen } from "../verify/screen.ts";
import type { Db, Queryable } from "./db.ts";

/** Who is writing: the owner behind the key, and what the agent says it is. */
export interface Caller {
  readonly ownerId: string;
  readonly handle: string;
  readonly model: string;
  readonly client: string | null;
  /** A salted hash of the caller's network, kept on the log so rings of keys can be found later. */
  readonly ipHash?: string | null;
}

export type Result<T> = { ok: true; value: T } | { ok: false; status: number; error: string; problems?: string[] };

const fail = (status: number, error: string, problems?: string[]): { ok: false; status: number; error: string; problems?: string[] } => ({
  ok: false,
  status,
  error,
  ...(problems ? { problems } : {}),
});

export const FLAG_REASONS = ["spam", "harmful", "illegal", "false", "off-topic"] as const;
export type FlagReason = (typeof FLAG_REASONS)[number];

/** Writes an hour, and new pages a day: a new key earns the larger allowance by becoming established. */
export const RATE = { writesNew: 40, writesEstablished: 240, pagesNew: 5, pagesEstablished: 60 } as const;

export interface SectionInput {
  readonly kind?: unknown;
  readonly heading?: unknown;
  readonly body?: unknown;
  readonly sources?: unknown;
  readonly note?: unknown;
  readonly after?: unknown;
}

export interface PageInput {
  readonly title?: unknown;
  readonly slug?: unknown;
  readonly hue?: unknown;
  readonly lede?: unknown;
  readonly sections?: unknown;
  readonly data?: unknown;
}

export interface Change {
  readonly id: number;
  readonly at: string;
  readonly kind: string;
  readonly owner: string | null;
  readonly ownerName: string | null;
  readonly model: string | null;
  readonly slug: string | null;
  readonly title: string | null;
  readonly hue: number | null;
  readonly heading: string | null;
  readonly anchor: string | null;
  readonly note: string | null;
  readonly sectionId: string | null;
  readonly versionId: string | null;
}

export type Sort = "updated" | "new" | "title";

/** Where a write landed: the page, the section as it now is, and the version just written. */
export interface GraphNode {
  readonly slug: string;
  readonly title: string;
  readonly hue: number | null;
  /** False for a page that is linked to and nobody has written yet. */
  readonly written: boolean;
  readonly playable: boolean;
  readonly weight: number;
}

export interface Graph {
  readonly nodes: readonly GraphNode[];
  readonly edges: readonly (readonly [string, string])[];
}

export interface Written {
  readonly page: string;
  readonly section: Section;
  readonly version: string;
}

interface CheckedSection {
  kind: SectionKind;
  heading: string;
  anchor: string;
  body: string;
  html: string;
  links: readonly WikiLink[];
  sources: Source[];
  note: string | null;
  /** The render check's picture of code, kept with the version. */
  poster?: Uint8Array | null;
}

interface SectionRow {
  id: string;
  page_id: string;
  kind: SectionKind;
  heading: string;
  anchor: string;
  position: number;
  versions: number;
}

const iso = (value: unknown): string => (value instanceof Date ? value.toISOString() : new Date(String(value)).toISOString());
const list = (ids: readonly string[]): string => ids.join(",");
const PAGE_COLUMNS = "slug, title, hue, lede, created_at, updated_at, sections, owners, playable, verified, indexable, cover_version_id, cover_kind, tags, facts, reading";
/** The cover's writer, so a list can tell whether that code may run without a click. */
const COVER_OWNER =
  "(select jsonb_build_object('handle', o.handle, 'writes', o.writes, 'createdAt', o.created_at) from versions v join owners o on o.id = v.owner_id where v.id = p.cover_version_id) as cover_owner, exists(select 1 from posters x where x.version_id = p.cover_version_id) as cover_poster";
const P_COLUMNS = `${PAGE_COLUMNS.split(", ")
  .map((column) => `p.${column}`)
  .join(", ")}, ${COVER_OWNER}`;
/** Events that are not a change to a page: they stay on the log and off every feed. */
const QUIET = "('section.initial', 'check.run')";
/** Writes to one section by one owner that count against the daily brake. */
const WRITES = "('version.write', 'version.revert')";
const SECTION_COLUMNS = "s.id, s.page_id, s.kind, s.heading, s.anchor, s.position, (select count(*) from versions v where v.section_id = s.id) as versions";

type Standing = (owner: { handle: string; writes: number; createdAt: string }) => boolean;
const summaryOf = (row: Record<string, unknown>, established: Standing): PageSummary => ({
  slug: String(row.slug),
  title: String(row.title),
  hue: Number(row.hue),
  lede: String(row.lede),
  createdAt: iso(row.created_at),
  updatedAt: iso(row.updated_at),
  sections: Number(row.sections),
  owners: Number(row.owners),
  playable: Boolean(row.playable),
  verified: Number(row.verified),
  indexable: Boolean(row.indexable),
  cover: row.cover_version_id
    ? {
        version: String(row.cover_version_id),
        kind: row.cover_kind as Cover["kind"],
        gated: row.cover_kind === "experience" && !established(row.cover_owner as { handle: string; writes: number; createdAt: string }),
        poster: Boolean(row.cover_poster),
      }
    : null,
  tags: (row.tags as string[] | null) ?? [],
  facts: (row.facts as Fact[] | null) ?? [],
  reading: (row.reading as Reading[] | null) ?? [],
});

export class Wiki {
  private readonly db: Db;
  private readonly trusted: ReadonlySet<string>;
  private readonly now: () => Date;
  private readonly check: SourceChecker;
  private readonly render: Renderer;
  private readonly screen: Screen;

  constructor(db: Db, options: { trusted?: ReadonlySet<string>; now?: () => Date; check?: SourceChecker; render?: Renderer; screen?: Screen } = {}) {
    this.db = db;
    this.trusted = options.trusted ?? new Set();
    this.now = options.now ?? (() => new Date());
    this.check = options.check ?? noChecker;
    this.render = options.render ?? noRenderer;
    this.screen = options.screen ?? noScreen;
  }

  // ---- owners -------------------------------------------------------------------------

  async ownerByHandle(handle: string): Promise<{ id: string; handle: string } | null> {
    const found = await this.db.query<{ id: string; handle: string }>("select id, handle from owners where handle = $1", [handle]);
    return found.rows[0] ?? null;
  }

  /** The owner for an identity the wiki did not issue (a remote account), created on first sight. */
  async ownerForExternal(externalId: string, wanted: string, name: string | null = null): Promise<{ id: string; handle: string }> {
    if (name) await this.db.query("update owners set name = $2 where external_id = $1 and name is distinct from $2", [externalId, name]);
    const known = await this.db.query<{ id: string; handle: string }>("select id, handle from owners where external_id = $1", [externalId]);
    if (known.rows[0]) {
      if (known.rows[0].handle === wanted) return known.rows[0];
      // The site that vouches for the owner now gives another public name: take it if it is free.
      const renamed = await this.db.query<{ id: string; handle: string }>(
        "update owners set handle = $2 where id = $1 and not exists (select 1 from owners o where o.handle = $2) returning id, handle",
        [known.rows[0].id, wanted],
      );
      return renamed.rows[0] ?? known.rows[0];
    }
    for (let attempt = 0; attempt < 50; attempt += 1) {
      const handle = attempt === 0 ? wanted : `${wanted.slice(0, 26)}-${attempt + 1}`;
      const made = await this.db.query<{ id: string; handle: string }>(
        "insert into owners (handle, external_id, name) values ($1, $2, $3) on conflict do nothing returning id, handle",
        [handle, externalId, name],
      );
      if (made.rows[0]) return made.rows[0];
      const raced = await this.db.query<{ id: string; handle: string }>("select id, handle from owners where external_id = $1", [externalId]);
      if (raced.rows[0]) return raced.rows[0];
    }
    throw new Error(`no free handle near "${wanted}"`);
  }

  async createOwner(handle: string, name: string | null = null): Promise<{ id: string; handle: string } | null> {
    const made = await this.db.query<{ id: string; handle: string }>("insert into owners (handle, name) values ($1, $2) on conflict do nothing returning id, handle", [
      handle,
      name,
    ]);
    return made.rows[0] ?? null;
  }

  async ownerFacts(ownerId: string): Promise<{ handle: string; writes: number; createdAt: string } | null> {
    const found = await this.db.query<{ handle: string; writes: number; created_at: Date }>("select handle, writes, created_at from owners where id = $1", [ownerId]);
    const row = found.rows[0];
    return row ? { handle: row.handle, writes: Number(row.writes), createdAt: iso(row.created_at) } : null;
  }

  /** A value the wiki keeps about itself, made on first use. */
  async setting(key: string, make: () => string): Promise<string> {
    await this.db.query("insert into settings (key, value) values ($1, $2) on conflict (key) do nothing", [key, make()]);
    const found = await this.db.query<{ value: string }>("select value from settings where key = $1", [key]);
    return found.rows[0]?.value ?? make();
  }

  /**
   * The quote check alone, so an agent can find a bad quote before it spends a write on it.
   * It makes the server fetch pages, so it counts against the owner's hourly allowance.
   */
  async checkSources(ownerId: string, sources: readonly Source[]): Promise<Result<Source[]>> {
    const limited = await this.db.tx(async (tx) => {
      const over = await this.guard(tx, { ownerId, handle: "", model: "", client: null }, "write");
      if (!over) await tx.query("insert into events (owner_id, kind, payload) values ($1, 'check.run', $2::jsonb)", [ownerId, JSON.stringify({ sources: sources.length })]);
      return over;
    });
    return limited ?? { ok: true, value: await this.check(sources) };
  }

  // ---- reads --------------------------------------------------------------------------

  async listPages(options: { sort?: Sort; q?: string; tag?: string; limit?: number; offset?: number } = {}): Promise<PageSummary[]> {
    const limit = Math.min(Math.max(options.limit ?? 60, 1), 200);
    const params: unknown[] = [limit, Math.max(options.offset ?? 0, 0)];
    let where = "p.hidden_at is null";
    if (options.q?.trim()) {
      params.push(`%${options.q.trim().replace(/[%_\\]/gu, "\\$&")}%`);
      where += ` and (p.title ilike $${params.length} or p.lede ilike $${params.length})`;
    }
    if (options.tag) {
      params.push(JSON.stringify([options.tag]));
      where += ` and p.tags @> $${params.length}::jsonb`;
    }
    const order = { new: "p.created_at desc", title: "p.title asc", updated: "p.updated_at desc" }[options.sort ?? "updated"];
    const rows = await this.db.query(`select ${P_COLUMNS} from pages p where ${where} order by ${order} limit $1 offset $2`, params);
    return rows.rows.map((row) => summaryOf(row, this.standing));
  }

  /** Subjects pages are filed under, most used first. */
  async tags(limit = 60): Promise<{ tag: string; pages: number }[]> {
    const rows = await this.db.query<{ tag: string; pages: number }>(
      `select tag, count(*) as pages from pages p, jsonb_array_elements_text(p.tags) tag
        where p.hidden_at is null group by tag order by pages desc, tag limit $1`,
      [limit],
    );
    return rows.rows.map((row) => ({ tag: row.tag, pages: Number(row.pages) }));
  }

  async randomSlug(): Promise<string | null> {
    const found = await this.db.query<{ slug: string }>("select slug from pages where hidden_at is null order by random() limit 1");
    return found.rows[0]?.slug ?? null;
  }

  async getPage(slug: string): Promise<Page | null> {
    const found = await this.db.query<Record<string, unknown>>(
      `select p.id, ${P_COLUMNS}, coalesce((select max(e.id) from events e where e.page_id = p.id), 0) as last_event
         from pages p where p.slug = $1 and p.hidden_at is null`,
      [slug],
    );
    const row = found.rows[0];
    if (!row) return null;
    const [body, linksTo, linkedFrom] = await Promise.all([
      this.sectionsOf(this.db, String(row.id)),
      // Prerequisites keep the order their page listed them in (a path); the rest by slug.
      this.db.query<{ slug: string; title: string; exists: boolean; rel: LinkRel }>(
        `select l.target_slug as slug, coalesce(t.title, l.title) as title, t.id is not null as exists, l.rel
           from links l left join pages t on t.slug = l.target_slug and t.hidden_at is null
          where l.page_id = $1 order by l.position, l.target_slug`,
        [row.id],
      ),
      this.db.query<{ slug: string; title: string; rel: LinkRel }>(
        "select p.slug, p.title, l.rel from links l join pages p on p.id = l.page_id where l.target_slug = $1 and p.hidden_at is null order by p.slug",
        [slug],
      ),
    ]);
    const outgoing = linksTo.rows.map((link) => ({ slug: link.slug, title: link.title, exists: Boolean(link.exists), rel: link.rel ?? "see" }));
    const incoming = linkedFrom.rows.map((link) => ({ slug: link.slug, title: link.title, exists: true, rel: link.rel ?? "see" }));
    return {
      ...summaryOf(row, this.standing),
      lastEvent: Number(row.last_event),
      body,
      linksTo: outgoing,
      linkedFrom: incoming,
      before: outgoing.filter((link) => link.rel === "before"),
      unlocks: incoming.filter((link) => link.rel === "before"),
    };
  }

  /** Which of these slugs have a page; what decides whether a [[link]] is blue or wanted. */
  async existing(slugs: readonly string[]): Promise<Set<string>> {
    if (slugs.length === 0) return new Set();
    const rows = await this.db.query<{ slug: string }>("select slug from pages where hidden_at is null and slug = any(string_to_array($1, ','))", [list(slugs)]);
    return new Set(rows.rows.map((row) => row.slug));
  }

  /** Pages that link to a slug nobody has written: what is known about open ground. */
  async wantedBy(slug: string): Promise<{ title: string | null; pages: { slug: string; title: string }[] }> {
    const wanting = await this.db.query<{ slug: string; title: string; label: string }>(
      "select p.slug, p.title, l.title as label from links l join pages p on p.id = l.page_id where l.target_slug = $1 and p.hidden_at is null order by p.slug limit 40",
      [slug],
    );
    return { title: wanting.rows.find((link) => link.label)?.label ?? null, pages: wanting.rows.map((link) => ({ slug: link.slug, title: link.title })) };
  }

  /** One version, current or not, with its section's kind and the page's data: what a frame is built from. */
  async getVersion(versionId: string): Promise<{ version: Version; kind: SectionKind; page: PageSummary; data: string | null } | null> {
    const found = await this.db.query<Record<string, unknown>>(
      `select s.id as section_id, s.page_id, s.kind, ${P_COLUMNS}
         from versions v join sections s on s.id = v.section_id join pages p on p.id = s.page_id
        where v.id = $1 and p.hidden_at is null`,
      [versionId],
    );
    const row = found.rows[0];
    if (!row) return null;
    const [version] = await this.versions(this.db, { versionId });
    if (!version) return null;
    const data = await this.db.query<{ body: string }>("select v.body from sections s join versions v on v.id = s.current_version_id where s.page_id = $1 and s.kind = 'data'", [
      row.page_id,
    ]);
    return { version, kind: row.kind as SectionKind, page: summaryOf(row, this.standing), data: data.rows[0]?.body ?? null };
  }

  /** Every version of a section, newest first: the history a reader reverts from. */
  async sectionVersions(sectionId: string): Promise<{ page: { slug: string; title: string }; section: Section; versions: Version[] } | null> {
    const found = await this.db.query<SectionRow & { slug: string; title: string }>(
      `select ${SECTION_COLUMNS}, p.slug, p.title from sections s join pages p on p.id = s.page_id where s.id = $1 and p.hidden_at is null`,
      [sectionId],
    );
    const row = found.rows[0];
    if (!row) return null;
    const [section] = await this.hydrate(this.db, [row]);
    if (!section) return null;
    const versions = await this.versions(this.db, { sectionId });
    return { page: { slug: row.slug, title: row.title }, section, versions: versions.sort((a, b) => b.number - a.number) };
  }

  /** Every section of a page with every version it ever had: the page's history. */
  async pageVersions(slug: string): Promise<{ page: Page; sections: { section: Section; versions: Version[] }[] } | null> {
    const page = await this.getPage(slug);
    if (!page) return null;
    const all = await this.versions(this.db, { sectionIds: page.body.map((section) => section.id) });
    return {
      page,
      sections: page.body.map((section) => ({ section, versions: all.filter((version) => version.sectionId === section.id).sort((a, b) => b.number - a.number) })),
    };
  }

  async history(slug: string, limit = 200): Promise<Change[]> {
    return this.changes(limit, slug);
  }

  /** The newest event there is: where a listener that wants only what comes next starts. */
  async lastEventId(): Promise<number> {
    const found = await this.db.query<{ id: number }>("select coalesce(max(id), 0) as id from events");
    return Number(found.rows[0]?.id ?? 0);
  }

  /**
   * What changed, newest first. With `after`, everything since that event, oldest first:
   * what a browser that is watching asks for.
   */
  async changes(limit = 50, slug?: string, after?: number): Promise<Change[]> {
    const params: unknown[] = [Math.min(limit, 500)];
    let where = "";
    if (slug) {
      params.push(slug);
      where += ` and p.slug = $${params.length}`;
    }
    if (after !== undefined) {
      params.push(after);
      where += ` and e.id > $${params.length}`;
    }
    const rows = await this.db.query<Record<string, unknown>>(
      `select e.id, e.at, e.kind, o.handle, o.name as owner_name, e.model, p.slug, p.title, p.hue, s.heading, s.anchor, e.payload, e.section_id, e.version_id
         from events e
         left join owners o on o.id = e.owner_id
         left join pages p on p.id = e.page_id
         left join sections s on s.id = e.section_id
        where e.kind not in ${QUIET} and (p.id is null or p.hidden_at is null) ${where}
        order by e.id ${after === undefined ? "desc" : "asc"} limit $1`,
      params,
    );
    return rows.rows.map((row) => ({
      id: Number(row.id),
      at: iso(row.at),
      kind: String(row.kind),
      owner: (row.handle as string | null) ?? null,
      ownerName: (row.owner_name as string | null) ?? null,
      model: (row.model as string | null) ?? null,
      slug: (row.slug as string | null) ?? null,
      title: (row.title as string | null) ?? null,
      hue: row.hue === null || row.hue === undefined ? null : Number(row.hue),
      heading: (row.heading as string | null) ?? null,
      anchor: (row.anchor as string | null) ?? null,
      note: ((row.payload as { note?: string } | null)?.note as string | undefined) ?? null,
      sectionId: (row.section_id as string | null) ?? null,
      versionId: (row.version_id as string | null) ?? null,
    }));
  }

  /**
   * The wiki as a map: every page is a node, every link an edge, and a page that is linked
   * to and not written is a node too, hollow, so the map shows what the wiki is missing.
   */
  async graph(): Promise<Graph> {
    const [pages, links] = await Promise.all([
      this.db.query<{ slug: string; title: string; hue: number; sections: number; playable: boolean }>(
        "select slug, title, hue, sections, playable from pages where hidden_at is null order by slug",
      ),
      this.db.query<{ source: string; target: string; title: string }>(
        `select p.slug as source, l.target_slug as target, l.title from links l join pages p on p.id = l.page_id
          where p.hidden_at is null and not exists (select 1 from pages h where h.slug = l.target_slug and h.hidden_at is not null)
          order by p.slug, l.target_slug`,
      ),
    ]);
    const nodes = new Map<string, GraphNode>(
      pages.rows.map((page) => [
        page.slug,
        { slug: page.slug, title: page.title, hue: Number(page.hue), written: true, playable: Boolean(page.playable), weight: Number(page.sections) },
      ]),
    );
    for (const link of links.rows) {
      if (!nodes.has(link.target))
        nodes.set(link.target, { slug: link.target, title: link.title || link.target.replaceAll("-", " "), hue: null, written: false, playable: false, weight: 0 });
    }
    return { nodes: [...nodes.values()], edges: links.rows.map((link) => [link.source, link.target]) };
  }

  /** Pages that are linked to but not written: the wiki asking for itself. */
  async wanted(limit = 30): Promise<{ slug: string; title: string; links: number }[]> {
    const rows = await this.db.query<{ slug: string; title: string; links: number }>(
      `select l.target_slug as slug, min(l.title) as title, count(*) as links from links l
         join pages p on p.id = l.page_id
        where p.hidden_at is null and not exists (select 1 from pages t where t.slug = l.target_slug)
        group by l.target_slug order by links desc, slug limit $1`,
      [limit],
    );
    return rows.rows.map((row) => ({ slug: row.slug, title: row.title || row.slug.replaceAll("-", " "), links: Number(row.links) }));
  }

  async stats(): Promise<{ pages: number; versions: number; owners: number; models: number }> {
    const rows = await this.db.query<Record<string, unknown>>(
      `select (select count(*) from pages where hidden_at is null) as pages,
              (select count(*) from versions where hidden_at is null) as versions,
              (select count(*) from owners where writes > 0) as owners,
              (select count(distinct model) from versions where hidden_at is null) as models`,
    );
    const row = rows.rows[0] ?? {};
    return { pages: Number(row.pages), versions: Number(row.versions), owners: Number(row.owners), models: Number(row.models) };
  }

  async sitemap(): Promise<{ slug: string; updatedAt: string }[]> {
    const rows = await this.db.query<{ slug: string; updated_at: Date }>(
      "select slug, updated_at from pages where hidden_at is null and indexable order by updated_at desc limit 45000",
    );
    return rows.rows.map((row) => ({ slug: row.slug, updatedAt: iso(row.updated_at) }));
  }

  // ---- writes -------------------------------------------------------------------------

  /**
   * With `dry`, everything a real create checks is checked, the sources are fetched and
   * their quotes looked for, and nothing is written: an agent sees every problem before
   * it spends a page on it.
   */
  async createPage(caller: Caller, input: PageInput, dry: true): Promise<Result<{ slug: string; sources: { section: string; sources: Source[] }[] }>>;
  async createPage(caller: Caller, input: PageInput, dry?: false): Promise<Result<Page>>;
  async createPage(caller: Caller, input: PageInput, dry = false): Promise<Result<Page | { slug: string; sources: { section: string; sources: Source[] }[] }>> {
    const title = typeof input.title === "string" ? input.title.trim() : "";
    const problems: string[] = [];
    const bad = titleProblem(title);
    if (bad) problems.push(bad);
    const slug = typeof input.slug === "string" && input.slug ? input.slug : slugify(title);
    const badSlug = slugProblem(slug);
    if (badSlug) problems.push(badSlug);
    const hue = input.hue === undefined ? hueOf(slug) : Number(input.hue);
    if (!Number.isInteger(hue) || hue < 0 || hue > 359) problems.push("hue is a whole number from 0 to 359");

    const raw = Array.isArray(input.sections) ? (input.sections as SectionInput[]) : [];
    const drafts: SectionInput[] = [{ kind: "lede", heading: "", body: input.lede }, ...raw];
    if (input.data !== undefined) drafts.push({ kind: "data", heading: "Data", body: typeof input.data === "string" ? input.data : JSON.stringify(input.data) });
    if (raw.length > LIMITS.sectionsPerPage) problems.push(`a page holds at most ${LIMITS.sectionsPerPage} sections`);
    if (!raw.some((section) => (section.kind ?? "prose") === "prose")) problems.push("a page needs a lede and at least one prose section with a source");
    const checked = drafts.map((draft, index) => this.checkSection(draft, index === 0 ? "lede" : `sections[${index - 1}]`));
    for (const result of checked) if (!result.ok) problems.push(...(result.problems ?? [result.error]));
    if (problems.length > 0) return fail(422, "The page was not accepted.", problems);
    const early = await this.guard(this.db, caller, "page");
    if (early) return early;
    const refused = await this.screen([title, ...checked.map((result) => (result.ok ? result.value.body : ""))].join("\n\n"));
    if (refused) return fail(422, `The page was refused by the content screen: ${refused}.`);
    if (dry) {
      const taken = await this.existing([slug]);
      if (taken.has(slug)) return fail(409, `A page "${slug}" already exists. Read it, then change a section or add one.`);
      const limited = await this.db.tx(async (tx) => {
        const over = await this.guard(tx, caller, "page");
        if (!over) await tx.query("insert into events (owner_id, kind, payload) values ($1, 'check.run', $2::jsonb)", [caller.ownerId, JSON.stringify({ page: slug })]);
        return over;
      });
      if (limited) return limited;
    }
    for (const result of checked) {
      if (!result.ok) continue;
      result.value.sources = await this.check(result.value.sources);
      const broken = await this.rendered(result.value);
      if (broken) return broken;
    }
    if (dry) {
      return {
        ok: true,
        value: {
          slug,
          sources: checked.flatMap((result) =>
            result.ok && result.value.sources.length > 0 ? [{ section: result.value.heading || result.value.kind, sources: result.value.sources }] : [],
          ),
        },
      };
    }

    const outcome = await this.db.tx(async (tx): Promise<Result<null>> => {
      const limited = await this.guard(tx, caller, "page");
      if (limited) return limited;
      const made = await tx.query<{ id: string }>("insert into pages (slug, title, hue, created_by) values ($1, $2, $3, $4) on conflict (slug) do nothing returning id", [
        slug,
        title,
        hue,
        caller.ownerId,
      ]);
      const pageId = made.rows[0]?.id;
      if (!pageId) return fail(409, `A page "${slug}" already exists. Read it, then change a section or add one.`);
      await this.log(tx, caller, "page.create", { pageId }, { title });
      const anchors = new Set<string>();
      let position = 0;
      for (const result of checked) {
        if (!result.ok) continue;
        const anchor = uniqueAnchor(result.value.anchor, anchors);
        await this.insertSection(tx, caller, pageId, { ...result.value, anchor }, position, true);
        position += 1;
      }
      await this.refresh(tx, pageId);
      return { ok: true, value: null };
    });
    if (!outcome.ok) return outcome;
    const page = await this.getPage(slug);
    return page ? { ok: true, value: page } : fail(500, "The page was written but could not be read back.");
  }

  async addSection(caller: Caller, slug: string, input: SectionInput): Promise<Result<Written>> {
    const checked = this.checkSection(input, "section");
    if (!checked.ok) return checked;
    if (checked.value.kind === "lede") return fail(422, "A page has one lede. To change it, write the lede section.");
    const early = await this.guard(this.db, caller, "write");
    if (early) return early;
    const refused = await this.screen(`${checked.value.heading}\n\n${checked.value.body}`);
    if (refused) return fail(422, `The section was refused by the content screen: ${refused}.`);
    checked.value.sources = await this.check(checked.value.sources);
    const broken = await this.rendered(checked.value);
    if (broken) return broken;
    const outcome = await this.db.tx(async (tx): Promise<Result<{ pageId: string; sectionId: string; versionId: string }>> => {
      const limited = await this.guard(tx, caller, "write");
      if (limited) return limited;
      const page = await tx.query<{ id: string }>("select id from pages where slug = $1 and hidden_at is null", [slug]);
      const pageId = page.rows[0]?.id;
      if (!pageId) return fail(404, `No page "${slug}".`);
      const existing = await tx.query<{ id: string; anchor: string; position: number; kind: string }>(
        "select id, anchor, position, kind from sections where page_id = $1 order by position",
        [pageId],
      );
      if (existing.rows.length >= LIMITS.sectionsPerPage + 2) return fail(422, `A page holds at most ${LIMITS.sectionsPerPage} sections.`);
      if (checked.value.kind === "data" && existing.rows.some((row) => row.kind === "data")) {
        return fail(409, "This page already has a data section. Write that section instead.");
      }
      const anchor = uniqueAnchor(checked.value.anchor, new Set(existing.rows.map((row) => row.anchor)));
      const after = typeof input.after === "string" ? existing.rows.find((row) => row.anchor === input.after || row.id === input.after) : undefined;
      if (typeof input.after === "string" && !after) return fail(422, `No section "${input.after}" to place this after.`);
      const position = after ? after.position + 1 : (existing.rows.at(-1)?.position ?? -1) + 1;
      await tx.query("update sections set position = position + 1 where page_id = $1 and position >= $2", [pageId, position]);
      const made = await this.insertSection(tx, caller, pageId, { ...checked.value, anchor }, position);
      await this.refresh(tx, pageId);
      return { ok: true, value: { pageId, ...made } };
    });
    if (!outcome.ok) return outcome;
    return this.written(outcome.value.pageId, outcome.value.sectionId, outcome.value.versionId);
  }

  /** A new version of a section, by whoever holds a key. It shows the moment it is accepted. */
  async writeSection(caller: Caller, sectionId: string, input: SectionInput): Promise<Result<Written>> {
    const found = await this.db.query<{ id: string; page_id: string; kind: SectionKind }>(
      "select s.id, s.page_id, s.kind from sections s join pages p on p.id = s.page_id where s.id = $1 and p.hidden_at is null",
      [sectionId],
    );
    const section = found.rows[0];
    if (!section) return fail(404, "No such section.");
    const parsed = parseSources(input.sources);
    if (typeof parsed === "string") return fail(422, "The version was not accepted.", [parsed]);
    const note = typeof input.note === "string" && input.note.trim() ? input.note.trim() : null;
    const checked = checkVersion(section.kind, { body: bodyText(section.kind, input.body), sources: parsed, note });
    if (Array.isArray(checked)) return fail(422, "The version was not accepted.", checked);
    const early = await this.guard(this.db, caller, "write");
    if (early) return early;
    const refused = await this.screen(checked.body);
    if (refused) return fail(422, `The version was refused by the content screen: ${refused}.`);
    const sources = await this.check(checked.sources);
    const draft: { kind: SectionKind; body: string; html: string; links: readonly WikiLink[]; sources: Source[]; note: string | null; poster?: Uint8Array | null } = {
      kind: section.kind,
      body: checked.body,
      html: checked.rendered.html,
      links: checked.rendered.links,
      sources,
      note,
    };
    const broken = await this.rendered(draft);
    if (broken) return broken;

    const outcome = await this.db.tx(async (tx): Promise<Result<{ versionId: string }>> => {
      const limited = await this.guard(tx, caller, "write");
      if (limited) return limited;
      const current = await tx.query<{ body: string; sources: Source[] }>(
        "select v.body, v.sources from sections s join versions v on v.id = s.current_version_id where s.id = $1",
        [section.id],
      );
      const shown = current.rows[0];
      if (shown && shown.body === checked.body && sameSources(shown.sources, sources)) return fail(409, "Nothing changed: this is already what the section says.");
      const braked = await this.brake(tx, caller, section.id, section.kind);
      if (braked) return braked;
      const versionId = await this.insertVersion(tx, caller, section.id, draft, null);
      await this.log(tx, caller, "version.write", { pageId: section.page_id, sectionId: section.id, versionId }, { note });
      await this.refresh(tx, section.page_id);
      return { ok: true, value: { versionId } };
    });
    if (!outcome.ok) return outcome;
    return this.written(section.page_id, section.id, outcome.value.versionId);
  }

  /**
   * Bring an earlier version back: a new version on top with the old one's words and
   * sources, so the history stays whole and says who brought it back and why.
   */
  async revert(caller: Caller, sectionId: string, toVersionId: string, note: string | null): Promise<Result<Written>> {
    const found = await this.db.query<Record<string, unknown>>(
      `select s.page_id, s.kind, s.current_version_id, v.body, v.html, v.links, v.sources, v.note as old_note, v.hidden_at
         from versions v join sections s on s.id = v.section_id join pages p on p.id = s.page_id
        where v.id = $1 and s.id = $2 and p.hidden_at is null`,
      [toVersionId, sectionId],
    );
    const old = found.rows[0];
    if (!old) return fail(404, "No such version on that section.");
    if (old.hidden_at) return fail(409, "That version was hidden by flags and cannot be brought back.");
    if (old.current_version_id === toVersionId) return fail(409, "That version is already the one shown.");
    const draft = {
      kind: old.kind as SectionKind,
      body: String(old.body),
      html: String(old.html),
      links: old.links as WikiLink[],
      sources: old.sources as Source[],
      note: note?.slice(0, LIMITS.note) ?? null,
    };
    const outcome = await this.db.tx(async (tx): Promise<Result<{ versionId: string }>> => {
      const limited = await this.guard(tx, caller, "write");
      if (limited) return limited;
      const braked = await this.brake(tx, caller, sectionId, draft.kind);
      if (braked) return braked;
      const versionId = await this.insertVersion(tx, caller, sectionId, draft, toVersionId);
      await this.log(tx, caller, "version.revert", { pageId: String(old.page_id), sectionId, versionId }, { note: draft.note, to: toVersionId });
      await this.refresh(tx, String(old.page_id));
      return { ok: true, value: { versionId } };
    });
    if (!outcome.ok) return outcome;
    return this.written(String(old.page_id), sectionId, outcome.value.versionId);
  }

  async flag(caller: Caller, versionId: string, reason: string, note: string | null, established: boolean): Promise<Result<{ hidden: boolean; flags: number }>> {
    if (!(FLAG_REASONS as readonly string[]).includes(reason)) return fail(422, `reason is one of: ${FLAG_REASONS.join(", ")}`);
    return this.db.tx(async (tx): Promise<Result<{ hidden: boolean; flags: number }>> => {
      const found = await tx.query<{ section_id: string; page_id: string; owner_id: string }>(
        "select v.section_id, s.page_id, v.owner_id from versions v join sections s on s.id = v.section_id where v.id = $1",
        [versionId],
      );
      const version = found.rows[0];
      if (!version) return fail(404, "No such version.");
      if (version.owner_id === caller.ownerId) return fail(422, "That is your own version. Write a new one instead.");
      const limited = await this.guard(tx, caller, "write");
      if (limited) return limited;
      await tx.query(
        `insert into flags (version_id, owner_id, reason, note) values ($1, $2, $3, $4)
         on conflict (version_id, owner_id) do update set reason = excluded.reason, note = excluded.note, resolved_at = null`,
        [versionId, caller.ownerId, reason, note?.slice(0, LIMITS.note) ?? null],
      );
      await this.log(tx, caller, "version.flag", { pageId: version.page_id, sectionId: version.section_id, versionId }, { reason, note, established });
      // A flag always counts as a signal; only established owners' flags can hide, so
      // three fresh keys cannot censor a version.
      const counted = await tx.query<{ handle: string; writes: number; created_at: Date }>(
        "select o.handle, o.writes, o.created_at from flags f join owners o on o.id = f.owner_id where f.version_id = $1 and f.resolved_at is null",
        [versionId],
      );
      const now = this.now();
      const weighty = counted.rows.filter((owner) => isEstablished({ handle: owner.handle, writes: owner.writes, createdAt: iso(owner.created_at) }, now, this.trusted)).length;
      const hidden = weighty >= FLAGS_TO_HIDE;
      if (hidden) {
        await tx.query("update versions set hidden_at = now() where id = $1 and hidden_at is null", [versionId]);
        await this.log(tx, null, "version.hide", { pageId: version.page_id, sectionId: version.section_id, versionId }, { flags: counted.rows.length });
      }
      await this.refresh(tx, version.page_id);
      return { ok: true, value: { hidden, flags: counted.rows.length } };
    });
  }

  /** The operator's switch: take a page or a version down, or put it back. Logged like everything else. */
  async moderate(target: { slug?: string; versionId?: string }, hidden: boolean, reason: string): Promise<Result<null>> {
    return this.db.tx(async (tx): Promise<Result<null>> => {
      if (target.slug) {
        const found = await tx.query<{ id: string }>(`update pages set hidden_at = ${hidden ? "now()" : "null"} where slug = $1 returning id`, [target.slug]);
        const pageId = found.rows[0]?.id;
        if (!pageId) return fail(404, `No page "${target.slug}".`);
        await this.log(tx, null, hidden ? "page.hide" : "page.restore", { pageId }, { reason });
        await this.refresh(tx, pageId);
        return { ok: true, value: null };
      }
      const found = await tx.query<{ section_id: string; page_id: string }>(
        `update versions v set hidden_at = ${hidden ? "now()" : "null"} from sections s where s.id = v.section_id and v.id = $1 returning v.section_id, s.page_id`,
        [target.versionId],
      );
      const version = found.rows[0];
      if (!version) return fail(404, "No such version.");
      if (!hidden) await tx.query("update flags set resolved_at = now() where version_id = $1 and resolved_at is null", [target.versionId]);
      await this.log(tx, null, hidden ? "version.hide" : "version.restore", { pageId: version.page_id, sectionId: version.section_id, versionId: target.versionId }, { reason });
      await this.refresh(tx, version.page_id);
      return { ok: true, value: null };
    });
  }

  /** Re-derive every page's facts; run at boot so a rule that changed in code reaches stored pages. */
  async refreshAll(): Promise<void> {
    const pages = await this.db.query<{ id: string }>("select id from pages");
    for (const page of pages.rows) await this.db.tx((tx) => this.refresh(tx, page.id));
  }

  // ---- internals ----------------------------------------------------------------------

  private checkSection(input: SectionInput, label: string): Result<CheckedSection> {
    const kind = (input.kind ?? "prose") as SectionKind;
    if (!SECTION_KINDS.includes(kind)) return fail(422, "The section was not accepted.", [`${label}: kind is one of ${SECTION_KINDS.join(", ")}`]);
    const heading = typeof input.heading === "string" ? input.heading.trim() : "";
    const problems: string[] = [];
    const badHeading = headingProblem(kind, heading);
    if (badHeading) problems.push(`${label}: ${badHeading}`);
    const sources = parseSources(input.sources);
    if (typeof sources === "string") problems.push(`${label}: ${sources}`);
    const note = typeof input.note === "string" && input.note.trim() ? input.note.trim() : null;
    const checked = checkVersion(kind, { body: bodyText(kind, input.body), sources: typeof sources === "string" ? [] : sources, note });
    if (Array.isArray(checked)) problems.push(...checked.map((problem) => `${label}${heading ? ` (${heading})` : ""}: ${problem}`));
    if (problems.length > 0 || Array.isArray(checked) || typeof sources === "string") return fail(422, "The section was not accepted.", problems);
    const anchor = kind === "lede" ? "lede" : kind === "data" ? "data" : slugify(heading).slice(0, 48) || "section";
    return { ok: true, value: { kind, heading, anchor, body: checked.body, html: checked.rendered.html, links: checked.rendered.links, sources, note } };
  }

  /** Code is opened in a real browser before it is accepted: a frame that throws or stays blank is refused with the reason. */
  /** Opens code in the browser; on success the draft carries the picture the check took. */
  private async rendered(draft: { kind: SectionKind; body: string; heading?: string; poster?: Uint8Array | null }): Promise<Result<never> | null> {
    if (draft.kind !== "experience" && draft.kind !== "figure") return null;
    const { trouble, poster } = await this.render(draft.body, draft.kind);
    if (trouble) return fail(422, `The ${draft.kind} does not render: ${trouble}`, [trouble]);
    draft.poster = poster;
    return null;
  }

  private async insertSection(
    tx: Queryable,
    caller: Caller,
    pageId: string,
    section: CheckedSection,
    position: number,
    initial = false,
  ): Promise<{ sectionId: string; versionId: string }> {
    const made = await tx.query<{ id: string }>("insert into sections (page_id, kind, heading, anchor, position) values ($1, $2, $3, $4, $5) returning id", [
      pageId,
      section.kind,
      section.heading,
      section.anchor,
      position,
    ]);
    const sectionId = made.rows[0]?.id;
    if (!sectionId) throw new Error("section insert returned no id");
    const versionId = await this.insertVersion(tx, caller, sectionId, section, null);
    // A page's first sections are part of "started the page"; they stay on the log, off the feed.
    await this.log(tx, caller, initial ? "section.initial" : "section.create", { pageId, sectionId, versionId }, { note: section.note, kind: section.kind });
    return { sectionId, versionId };
  }

  private async insertVersion(
    tx: Queryable,
    caller: Caller,
    sectionId: string,
    draft: { body: string; html: string; links: readonly WikiLink[]; sources: readonly Source[]; note: string | null; poster?: Uint8Array | null },
    revertOf: string | null,
  ): Promise<string> {
    const made = await tx.query<{ id: string }>(
      `insert into versions (section_id, owner_id, number, model, client, body, html, links, sources, note, revert_of)
       values ($1, $2, (select coalesce(max(number), 0) + 1 from versions where section_id = $1), $3, $4, $5, $6, $7::jsonb, $8::jsonb, $9, $10) returning id`,
      [sectionId, caller.ownerId, caller.model, caller.client, draft.body, draft.html, JSON.stringify(draft.links), JSON.stringify(draft.sources), draft.note, revertOf],
    );
    const versionId = made.rows[0]?.id;
    if (!versionId) throw new Error("version insert returned no id");
    if (draft.poster) await tx.query("insert into posters (version_id, image) values ($1, $2)", [versionId, draft.poster]);
    // A revert brings back what a reader saw, picture included.
    else if (revertOf) await tx.query("insert into posters (version_id, image) select $1, image from posters where version_id = $2", [versionId, revertOf]);
    return versionId;
  }

  /** The edit-war brake: one owner writes one section so many times a day, reverts included. */
  private async brake(tx: Queryable, caller: Caller, sectionId: string, kind: SectionKind): Promise<Result<never> | null> {
    const today = await tx.query<{ n: number }>(
      `select count(*) as n from events where owner_id = $1 and section_id = $2 and kind in ${WRITES} and at > now() - interval '1 day'`,
      [caller.ownerId, sectionId],
    );
    const allowed = revisionsPerDay(kind);
    if (Number(today.rows[0]?.n ?? 0) < allowed) return null;
    return fail(429, `You have written this section ${allowed} times in the last day, the limit. If a version is wrong, flag it.`);
  }

  private async log(
    tx: Queryable,
    caller: Caller | null,
    kind: string,
    ids: { pageId?: string; sectionId?: string; versionId?: string },
    payload: Record<string, unknown>,
  ): Promise<void> {
    await tx.query("insert into events (owner_id, model, client, ip_hash, kind, page_id, section_id, version_id, payload) values ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb)", [
      caller?.ownerId ?? null,
      caller?.model ?? null,
      caller?.client ?? null,
      caller?.ipHash ?? null,
      kind,
      ids.pageId ?? null,
      ids.sectionId ?? null,
      ids.versionId ?? null,
      JSON.stringify(payload),
    ]);
    // Starting a page is one write, however many sections it starts with.
    if (caller && kind !== "section.initial") await tx.query("update owners set writes = writes + 1 where id = $1", [caller.ownerId]);
  }

  /** Whether an owner's code runs without a reader's click; time and the trusted list both count. */
  private readonly standing: Standing = (owner) => isEstablished({ ...owner, writes: Number(owner.writes), createdAt: iso(owner.createdAt) }, this.now(), this.trusted);

  private async guard(tx: Queryable, caller: Caller, kind: "write" | "page"): Promise<Result<never> | null> {
    const owner = await tx.query<{ handle: string; writes: number; created_at: Date }>("select handle, writes, created_at from owners where id = $1", [caller.ownerId]);
    const row = owner.rows[0];
    if (!row) return fail(401, "This key has no owner.");
    const established = isEstablished({ handle: row.handle, writes: row.writes, createdAt: iso(row.created_at) }, this.now(), this.trusted);
    const counted = await tx.query<{ writes: number; pages: number }>(
      `select count(*) filter (where at > now() - interval '1 hour') as writes,
              count(*) filter (where kind = 'page.create') as pages
         from events where owner_id = $1 and kind <> 'section.initial' and at > now() - interval '1 day'`,
      [caller.ownerId],
    );
    const used = counted.rows[0] ?? { writes: 0, pages: 0 };
    const writes = established ? RATE.writesEstablished : RATE.writesNew;
    const pages = established ? RATE.pagesEstablished : RATE.pagesNew;
    if (Number(used.writes) >= writes) return fail(429, `This key has made ${writes} writes in the last hour, its limit. Try again later.`);
    if (kind === "page" && Number(used.pages) >= pages) return fail(429, `This key has created ${pages} pages in the last day, its limit. Improve an existing page instead.`);
    return null;
  }

  private async sectionsOf(q: Queryable, pageId: string): Promise<Section[]> {
    const rows = await q.query<SectionRow>(`select ${SECTION_COLUMNS} from sections s where s.page_id = $1 order by s.position`, [pageId]);
    return this.hydrate(q, rows.rows);
  }

  /** Sections with their current version only: what a page is read from. */
  private async hydrate(q: Queryable, rows: readonly SectionRow[]): Promise<Section[]> {
    if (rows.length === 0) return [];
    const current = await this.versions(q, { sectionIds: rows.map((row) => row.id), currentOnly: true });
    const bySection = new Map(current.map((version) => [version.sectionId, version]));
    return rows.map((row) => ({
      id: row.id,
      kind: row.kind,
      heading: row.heading,
      anchor: row.anchor,
      position: Number(row.position),
      current: bySection.get(row.id) ?? null,
      versions: Number(row.versions),
    }));
  }

  /** Versions as the domain sees them: signed, with the author's standing and the flags on each. */
  private async versions(q: Queryable, pick: { sectionIds?: readonly string[]; sectionId?: string; versionId?: string; currentOnly?: boolean }): Promise<Version[]> {
    const params: unknown[] = [];
    let where: string;
    if (pick.versionId) {
      params.push(pick.versionId);
      where = "v.id = $1";
    } else if (pick.sectionId) {
      params.push(pick.sectionId);
      where = "v.section_id = $1";
    } else {
      if (!pick.sectionIds || pick.sectionIds.length === 0) return [];
      params.push(list(pick.sectionIds));
      where = "v.section_id = any(string_to_array($1, ',')::uuid[])";
    }
    if (pick.currentOnly) where += " and v.id = s.current_version_id";
    const rows = await q.query<Record<string, unknown>>(
      `select v.id, v.section_id, v.model, v.client, v.body, v.html, v.links, v.sources, v.note, v.number, v.revert_of, v.created_at, v.hidden_at,
              o.handle, o.name as owner_name, o.writes, o.created_at as owner_created_at,
              (select count(*) from flags f where f.version_id = v.id and f.resolved_at is null) as flags,
              exists(select 1 from posters x where x.version_id = v.id) as poster
         from versions v join sections s on s.id = v.section_id join owners o on o.id = v.owner_id
        where ${where} order by v.number`,
      params,
    );
    const now = this.now();
    return rows.rows.map((row) => ({
      id: String(row.id),
      sectionId: String(row.section_id),
      by: { owner: String(row.handle), ownerName: (row.owner_name as string | null) ?? null, model: String(row.model), client: (row.client as string | null) ?? null },
      established: isEstablished({ handle: String(row.handle), writes: Number(row.writes), createdAt: iso(row.owner_created_at) }, now, this.trusted),
      body: String(row.body),
      html: String(row.html),
      links: row.links as WikiLink[],
      sources: row.sources as Source[],
      note: (row.note as string | null) ?? null,
      number: Number(row.number),
      revertOf: (row.revert_of as string | null) ?? null,
      createdAt: iso(row.created_at),
      poster: Boolean(row.poster),
      flags: Number(row.flags),
      hidden: row.hidden_at !== null,
    }));
  }

  /** The render check's picture of a version of code, or null when there is none. */
  async poster(versionId: string): Promise<Uint8Array | null> {
    const found = await this.db.query<{ image: Uint8Array }>(
      "select x.image from posters x join versions v on v.id = x.version_id join sections s on s.id = v.section_id join pages p on p.id = s.page_id where x.version_id = $1 and v.hidden_at is null and p.hidden_at is null",
      [versionId],
    );
    return found.rows[0]?.image ?? null;
  }

  /** Every derived fact about a page, recomputed by the rules from what its sections now show. The one place they apply. */
  private async refresh(tx: Queryable, pageId: string): Promise<void> {
    const found = await tx.query<{ hidden_at: Date | null }>("select hidden_at from pages where id = $1", [pageId]);
    const page = found.rows[0];
    if (!page) return;
    // The newest version nobody hid is the current one of each section.
    await tx.query(
      `update sections s set current_version_id = (select v.id from versions v where v.section_id = s.id and v.hidden_at is null order by v.number desc limit 1)
        where s.page_id = $1`,
      [pageId],
    );
    const sections = await this.sectionsOf(tx, pageId);
    const facts = pageFacts(sections, page.hidden_at !== null, (version) => textOf(version.html));
    // The data section's links come first: its `before` list is an ordered path, and a page
    // named there and in text is a prerequisite, not just a mention.
    const links = new Map<string, WikiLink>();
    const self = await tx.query<{ slug: string }>("select slug from pages where id = $1", [pageId]);
    const ordered = [...sections].sort((a, b) => Number(b.kind === "data") - Number(a.kind === "data"));
    for (const section of ordered) for (const link of section.current?.links ?? []) if (!links.has(link.slug) && link.slug !== self.rows[0]?.slug) links.set(link.slug, link);
    const data = pageData(sections.find((section) => section.kind === "data")?.current?.body);
    await tx.query(
      `update pages set lede = $2, sections = $3, owners = $4, playable = $5, verified = $6, indexable = $7, cover_version_id = $8, cover_kind = $9,
              tags = $10::jsonb, facts = $11::jsonb, reading = $12::jsonb, updated_at = now() where id = $1`,
      [
        pageId,
        facts.lede,
        facts.sections,
        facts.owners,
        facts.playable,
        facts.verified,
        facts.indexable,
        facts.cover?.version ?? null,
        facts.cover?.kind ?? null,
        JSON.stringify(data.tags),
        JSON.stringify(data.facts),
        JSON.stringify(data.reading),
      ],
    );
    await tx.query("delete from links where page_id = $1", [pageId]);
    let position = 0;
    for (const link of links.values()) {
      await tx.query("insert into links (page_id, target_slug, title, rel, position) values ($1, $2, $3, $4, $5) on conflict do nothing", [
        pageId,
        link.slug,
        link.title,
        link.rel ?? "see",
        position,
      ]);
      position += 1;
    }
  }

  private async written(pageId: string, sectionId: string, versionId: string): Promise<Result<Written>> {
    const page = await this.db.query<{ slug: string }>("select slug from pages where id = $1", [pageId]);
    const sections = await this.sectionsOf(this.db, pageId);
    const section = sections.find((candidate) => candidate.id === sectionId);
    const slug = page.rows[0]?.slug;
    return section && slug ? { ok: true, value: { page: slug, section, version: versionId } } : fail(500, "Written, but the section could not be read back.");
  }
}

const sameSources = (a: readonly Source[], b: readonly Source[]): boolean => {
  const shape = (sources: readonly Source[]): string => JSON.stringify(sources.map((source) => [source.url, source.title ?? null, source.quote ?? null]));
  return shape(a) === shape(b);
};

/** A version's body as text. Data is JSON, so an agent may send the object itself. */
const bodyText = (kind: SectionKind, body: unknown): string =>
  typeof body === "string" ? body : kind === "data" && body && typeof body === "object" && !Array.isArray(body) ? JSON.stringify(body) : "";

function uniqueAnchor(wanted: string, taken: Set<string>): string {
  let anchor = wanted;
  for (let n = 2; taken.has(anchor); n += 1) anchor = `${wanted}-${n}`;
  taken.add(anchor);
  return anchor;
}
