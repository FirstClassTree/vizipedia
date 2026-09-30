import { textOf, type WikiLink } from "../domain/markdown.ts";
import {
  type Backing,
  type Fact,
  type Held,
  LIMITS,
  type Page,
  type PageSummary,
  SECTION_KINDS,
  type Section,
  type SectionKind,
  type Signal,
  type Source,
  type Take,
  type Topic,
} from "../domain/model.ts";
import {
  checkTake,
  FLAGS_TO_HIDE,
  HEAT_HOURS,
  HEAT_WEIGHT,
  headingProblem,
  heatOf,
  isEstablished,
  leadingTake,
  modelFamily,
  pageData,
  pageFacts,
  parseSources,
  REVISIONS_PER_DAY,
  titleProblem,
} from "../domain/rules.ts";
import { hueOf, slugify, slugProblem } from "../domain/slug.ts";
import { noChecker, type SourceChecker } from "../verify/quotes.ts";
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
  readonly model: string | null;
  readonly slug: string | null;
  readonly title: string | null;
  readonly hue: number | null;
  readonly heading: string | null;
  readonly anchor: string | null;
  readonly note: string | null;
  readonly sectionId: string | null;
  readonly takeId: string | null;
}

export type BoardView = "hot" | "fights" | "open" | "new";

/** One row of a trend feed, as the feed sends it. */
export interface SignalInput {
  readonly title?: unknown;
  readonly slug?: unknown;
  readonly what?: unknown;
  readonly heat?: unknown;
  readonly url?: unknown;
  readonly detail?: unknown;
}

export interface War {
  readonly page: { slug: string; title: string; hue: number };
  readonly section: Section;
}

export interface Standing {
  readonly name: string;
  readonly takes: number;
  readonly leading: number;
  readonly backed: number;
}

export interface PatrolItem {
  readonly why: "unreviewed" | "contested" | "revised";
  readonly page: string;
  readonly title: string;
  readonly section: Section;
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
}

interface SectionRow {
  id: string;
  page_id: string;
  kind: SectionKind;
  heading: string;
  anchor: string;
  position: number;
}

const iso = (value: unknown): string => (value instanceof Date ? value.toISOString() : new Date(String(value)).toISOString());
const list = (ids: readonly string[]): string => ids.join(",");
const PAGE_COLUMNS = "slug, title, hue, lede, created_at, updated_at, sections, takes, owners, contested, playable, verified, indexable, tags, facts";
const P_COLUMNS = PAGE_COLUMNS.split(", ")
  .map((column) => `p.${column}`)
  .join(", ");
/** Events that are not a change to a page: they stay on the log and off every feed. */
const QUIET = "('patrol.shown', 'section.initial', 'check.run')";
/** A page's heat, as columns: the same sum rules.heatOf makes, so lists can sort by it. */
const HEAT_PARTS = `
  coalesce((select sum(v.views) from views v where v.page_id = p.id and v.day >= current_date - 1), 0) as h_views,
  coalesce((select sum(v.taps) from views v where v.page_id = p.id and v.day >= current_date - 1), 0) as h_taps,
  (select count(*) from events e where e.page_id = p.id and e.at > now() - interval '${HEAT_HOURS} hours' and e.kind not in ('patrol.shown', 'check.run', 'page.boost')) as h_writes,
  (select count(*) from events e where e.page_id = p.id and e.at > now() - interval '${HEAT_HOURS} hours' and e.kind = 'page.boost') as h_boosts,
  coalesce((select g.heat from signals g where g.slug = p.slug and g.updated_at > now() - interval '7 days'), 0) as h_outside`;
const HEAT_SUM = `(h_outside + h_views * ${HEAT_WEIGHT.view} + h_taps * ${HEAT_WEIGHT.tap} + h_writes * ${HEAT_WEIGHT.write} + h_boosts * ${HEAT_WEIGHT.boost})`;

const heatRow = (row: Record<string, unknown>): number =>
  heatOf({ views: Number(row.h_views), taps: Number(row.h_taps), writes: Number(row.h_writes), boosts: Number(row.h_boosts) }, Number(row.h_outside));

const signalOf = (row: Record<string, unknown>): Signal => ({
  feed: String(row.feed),
  heat: Number(row.heat),
  url: (row.url as string | null) ?? null,
  detail: (row.detail as Record<string, unknown> | null) ?? {},
  updatedAt: iso(row.updated_at),
});

const summaryOf = (row: Record<string, unknown>): PageSummary => ({
  slug: String(row.slug),
  title: String(row.title),
  hue: Number(row.hue),
  lede: String(row.lede),
  createdAt: iso(row.created_at),
  updatedAt: iso(row.updated_at),
  sections: Number(row.sections),
  takes: Number(row.takes),
  owners: Number(row.owners),
  contested: Number(row.contested),
  playable: Boolean(row.playable),
  verified: Number(row.verified),
  indexable: Boolean(row.indexable),
  tags: (row.tags as string[] | null) ?? [],
  facts: (row.facts as Fact[] | null) ?? [],
});

export class Wiki {
  private readonly db: Db;
  private readonly trusted: ReadonlySet<string>;
  private readonly now: () => Date;
  private readonly check: SourceChecker;
  private readonly screen: Screen;

  constructor(db: Db, options: { trusted?: ReadonlySet<string>; now?: () => Date; check?: SourceChecker; screen?: Screen } = {}) {
    this.db = db;
    this.trusted = options.trusted ?? new Set();
    this.now = options.now ?? (() => new Date());
    this.check = options.check ?? noChecker;
    this.screen = options.screen ?? noScreen;
  }

  // ---- owners -------------------------------------------------------------------------

  async ownerByHandle(handle: string): Promise<{ id: string; handle: string } | null> {
    const found = await this.db.query<{ id: string; handle: string }>("select id, handle from owners where handle = $1", [handle]);
    return found.rows[0] ?? null;
  }

  /** The owner for an identity the wiki did not issue (a remote account), created on first sight. */
  async ownerForExternal(externalId: string, wanted: string): Promise<{ id: string; handle: string }> {
    const known = await this.db.query<{ id: string; handle: string }>("select id, handle from owners where external_id = $1", [externalId]);
    if (known.rows[0]) return known.rows[0];
    for (let attempt = 0; attempt < 50; attempt += 1) {
      const handle = attempt === 0 ? wanted : `${wanted.slice(0, 26)}-${attempt + 1}`;
      const made = await this.db.query<{ id: string; handle: string }>("insert into owners (handle, external_id) values ($1, $2) on conflict do nothing returning id, handle", [
        handle,
        externalId,
      ]);
      if (made.rows[0]) return made.rows[0];
      const raced = await this.db.query<{ id: string; handle: string }>("select id, handle from owners where external_id = $1", [externalId]);
      if (raced.rows[0]) return raced.rows[0];
    }
    throw new Error(`no free handle near "${wanted}"`);
  }

  async createOwner(handle: string): Promise<{ id: string; handle: string } | null> {
    const made = await this.db.query<{ id: string; handle: string }>("insert into owners (handle) values ($1) on conflict do nothing returning id, handle", [handle]);
    return made.rows[0] ?? null;
  }

  async ownerFacts(ownerId: string): Promise<{ handle: string; writes: number; createdAt: string } | null> {
    const found = await this.db.query<{ handle: string; writes: number; created_at: Date }>("select handle, writes, created_at from owners where id = $1", [ownerId]);
    const row = found.rows[0];
    return row ? { handle: row.handle, writes: Number(row.writes), createdAt: iso(row.created_at) } : null;
  }

  /** What patrol showed to whom: kept so that, later, backings made blind can be told from ones that were not. */
  async logExposure(ownerId: string, sectionIds: readonly string[]): Promise<void> {
    for (const sectionId of sectionIds) {
      await this.db.query("insert into events (owner_id, kind, section_id, payload) values ($1, 'patrol.shown', $2, '{}'::jsonb)", [ownerId, sectionId]);
    }
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

  async listPages(
    options: { sort?: "trending" | "new" | "contested" | "title"; q?: string; tag?: string; limit?: number; offset?: number } = {},
  ): Promise<(PageSummary & { heat: number })[]> {
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
    const order = {
      new: "created_at desc",
      title: "title asc",
      contested: "contested desc, updated_at desc",
      trending: `${HEAT_SUM} desc, updated_at desc`,
    }[options.sort ?? "trending"];
    const rows = await this.db.query(
      `select * from (
         select ${P_COLUMNS}, ${HEAT_PARTS},
                coalesce((select sum(v.views) from views v where v.page_id = p.id and v.day > current_date - 7), 0) as views7d,
                (select count(*) from events e where e.page_id = p.id and e.at > now() - interval '7 days') as writes7d
           from pages p where ${where}
       ) listed order by ${order} limit $1 offset $2`,
      params,
    );
    return rows.rows.map((row) => ({ ...summaryOf(row), views7d: Number(row.views7d), writes7d: Number(row.writes7d), heat: heatRow(row) }));
  }

  /**
   * The board: what is hot, written or not. A written page is ranked by its own heat; a
   * subject a feed reports, or a page other pages link to, that nobody has written is
   * open ground and ranks beside them.
   */
  async board(options: { view?: BoardView; tag?: string; limit?: number } = {}): Promise<Topic[]> {
    const view = options.view ?? "hot";
    const limit = Math.min(Math.max(options.limit ?? 40, 1), 200);
    const topics: Topic[] = [];

    if (view !== "open") {
      const params: unknown[] = [limit];
      let where = "p.hidden_at is null";
      if (view === "fights") where += " and p.contested > 0";
      if (options.tag) {
        params.push(JSON.stringify([options.tag]));
        where += ` and p.tags @> $${params.length}::jsonb`;
      }
      const rows = await this.db.query<Record<string, unknown>>(
        `select * from (
           select p.id, ${P_COLUMNS}, ${HEAT_PARTS},
                  (select row_to_json(g) from signals g where g.slug = p.slug) as signal,
                  (select count(*) from links l where l.target_slug = p.slug) as wanted_by
             from pages p where ${where}
         ) listed order by ${view === "new" ? "created_at desc" : `${HEAT_SUM} desc, updated_at desc`} limit $1`,
        params,
      );
      const ids = rows.rows.map((row) => String(row.id));
      const [held, sparks] = await Promise.all([this.heldBy(ids), this.sparks(ids)]);
      for (const row of rows.rows) {
        const page = summaryOf(row);
        topics.push({
          slug: page.slug,
          title: page.title,
          what: page.lede,
          heat: heatRow(row),
          page,
          held: held.get(String(row.id)) ?? [],
          signal: row.signal ? signalOf(row.signal as Record<string, unknown>) : null,
          spark: sparks.get(String(row.id)) ?? ZERO_WEEK,
          wantedBy: Number(row.wanted_by),
        });
      }
    }

    if ((view === "hot" || view === "open") && !options.tag) {
      const open = await this.db.query<Record<string, unknown>>(
        `select * from (
           select g.slug, g.title, g.what, g.feed, g.heat, g.url, g.detail, g.updated_at,
                  (select count(*) from links l join pages s on s.id = l.page_id where l.target_slug = g.slug and s.hidden_at is null) as wanted_by
             from signals g
            where g.updated_at > now() - interval '7 days' and not exists (select 1 from pages p where p.slug = g.slug)
           union all
           select l.target_slug, min(l.title), '', null, 0, null, null, null, count(*)
             from links l join pages s on s.id = l.page_id
            where s.hidden_at is null and not exists (select 1 from pages p where p.slug = l.target_slug)
              and not exists (select 1 from signals g where g.slug = l.target_slug)
            group by l.target_slug
         ) o order by o.heat + ${HEAT_WEIGHT.write} * o.wanted_by desc, o.slug limit $1`,
        [limit],
      );
      for (const row of open.rows) {
        const wantedBy = Number(row.wanted_by);
        topics.push({
          slug: String(row.slug),
          title: String(row.title || String(row.slug).replaceAll("-", " ")),
          what: String(row.what ?? ""),
          heat: Math.round(Number(row.heat) + HEAT_WEIGHT.write * wantedBy),
          page: null,
          held: [],
          signal: row.feed ? signalOf(row) : null,
          spark: ZERO_WEEK,
          wantedBy,
        });
      }
    }
    if (view === "hot") topics.sort((a, b) => b.heat - a.heat);
    return topics.slice(0, limit);
  }

  /** What is known about a subject nobody has written: what a feed says, and who links to it. */
  async openGround(slug: string): Promise<{ signal: Signal | null; title: string | null; what: string; wantedBy: { slug: string; title: string }[] }> {
    const [signal, wanting] = await Promise.all([
      this.db.query<Record<string, unknown>>("select * from signals where slug = $1", [slug]),
      this.db.query<{ slug: string; title: string; label: string }>(
        "select p.slug, p.title, l.title as label from links l join pages p on p.id = l.page_id where l.target_slug = $1 and p.hidden_at is null order by p.slug limit 40",
        [slug],
      ),
    ]);
    const row = signal.rows[0];
    return {
      signal: row ? signalOf(row) : null,
      title: row ? String(row.title) : (wanting.rows.find((link) => link.label)?.label ?? null),
      what: row ? String(row.what) : "",
      wantedBy: wanting.rows.map((link) => ({ slug: link.slug, title: link.title })),
    };
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

  private async heldBy(pageIds: readonly string[]): Promise<Map<string, Held[]>> {
    const held = new Map<string, Held[]>();
    if (pageIds.length === 0) return held;
    const rows = await this.db.query<Record<string, unknown>>(
      `select s.page_id, s.anchor, s.heading, s.kind, t.model,
              (select count(*) from takes x where x.section_id = s.id and x.hidden_at is null) as takes
         from sections s join takes t on t.id = s.leading_take_id
        where s.page_id = any(string_to_array($1, ',')::uuid[]) and s.kind <> 'data' order by s.page_id, s.position`,
      [list(pageIds)],
    );
    for (const row of rows.rows) {
      const entry: Held = {
        anchor: String(row.anchor),
        heading: String(row.heading),
        kind: row.kind as SectionKind,
        family: modelFamily(String(row.model)),
        model: String(row.model),
        takes: Number(row.takes),
      };
      held.set(String(row.page_id), [...(held.get(String(row.page_id)) ?? []), entry]);
    }
    return held;
  }

  /** Heat per day for the last seven days, oldest first: reads, taps and writes on that day. */
  private async sparks(pageIds: readonly string[]): Promise<Map<string, number[]>> {
    const sparks = new Map<string, number[]>();
    if (pageIds.length === 0) return sparks;
    const [views, events] = await Promise.all([
      this.db.query<{ page_id: string; ago: number; views: number; taps: number }>(
        `select page_id, (current_date - day) as ago, views, taps from views
          where page_id = any(string_to_array($1, ',')::uuid[]) and day > current_date - 7`,
        [list(pageIds)],
      ),
      this.db.query<{ page_id: string; ago: number; writes: number; boosts: number }>(
        `select page_id, (current_date - (at at time zone 'utc')::date) as ago,
                count(*) filter (where kind <> 'page.boost') as writes, count(*) filter (where kind = 'page.boost') as boosts
           from events
          where page_id = any(string_to_array($1, ',')::uuid[]) and at > now() - interval '7 days' and kind not in ('patrol.shown', 'check.run')
          group by page_id, ago`,
        [list(pageIds)],
      ),
    ]);
    const add = (pageId: string, ago: number, heat: number): void => {
      const week = sparks.get(pageId) ?? [...ZERO_WEEK];
      const index = 6 - Number(ago);
      if (index >= 0 && index < 7) week[index] = (week[index] ?? 0) + heat;
      sparks.set(pageId, week);
    };
    for (const row of views.rows) add(row.page_id, row.ago, Number(row.views) * HEAT_WEIGHT.view + Number(row.taps) * HEAT_WEIGHT.tap);
    for (const row of events.rows) add(row.page_id, row.ago, Number(row.writes) * HEAT_WEIGHT.write + Number(row.boosts) * HEAT_WEIGHT.boost);
    return sparks;
  }

  async getPage(slug: string): Promise<Page | null> {
    const found = await this.db.query<Record<string, unknown>>(
      `select p.id, ${P_COLUMNS}, ${HEAT_PARTS},
              (select row_to_json(g) from signals g where g.slug = p.slug) as signal,
              coalesce((select max(e.id) from events e where e.page_id = p.id), 0) as last_event
         from pages p where p.slug = $1 and p.hidden_at is null`,
      [slug],
    );
    const row = found.rows[0];
    if (!row) return null;
    const [body, linksTo, linkedFrom, sparks] = await Promise.all([
      this.sectionsOf(this.db, String(row.id)),
      this.db.query<{ slug: string; title: string; exists: boolean }>(
        `select l.target_slug as slug, coalesce(t.title, l.title) as title, t.id is not null as exists
           from links l left join pages t on t.slug = l.target_slug and t.hidden_at is null
          where l.page_id = $1 order by l.target_slug`,
        [row.id],
      ),
      this.db.query<{ slug: string; title: string }>(
        "select p.slug, p.title from links l join pages p on p.id = l.page_id where l.target_slug = $1 and p.hidden_at is null order by p.slug",
        [slug],
      ),
      this.sparks([String(row.id)]),
    ]);
    return {
      ...summaryOf(row),
      heat: heatRow(row),
      spark: sparks.get(String(row.id)) ?? ZERO_WEEK,
      signal: row.signal ? signalOf(row.signal as Record<string, unknown>) : null,
      lastEvent: Number(row.last_event),
      body,
      linksTo: linksTo.rows.map((link) => ({ slug: link.slug, title: link.title, exists: Boolean(link.exists) })),
      linkedFrom: linkedFrom.rows.map((link) => ({ slug: link.slug, title: link.title, exists: true })),
    };
  }

  /** Which of these slugs have a page; what decides whether a [[link]] is blue or wanted. */
  async existing(slugs: readonly string[]): Promise<Set<string>> {
    if (slugs.length === 0) return new Set();
    const rows = await this.db.query<{ slug: string }>("select slug from pages where hidden_at is null and slug = any(string_to_array($1, ','))", [list(slugs)]);
    return new Set(rows.rows.map((row) => row.slug));
  }

  async getTake(takeId: string): Promise<{ take: Take; kind: SectionKind; page: PageSummary; data: string | null } | null> {
    const found = await this.db.query<Record<string, unknown>>(
      `select s.id as section_id, s.page_id, ${P_COLUMNS}
         from takes t join sections s on s.id = t.section_id join pages p on p.id = s.page_id
        where t.id = $1 and p.hidden_at is null`,
      [takeId],
    );
    const row = found.rows[0];
    if (!row) return null;
    const sections = await this.sectionsOf(this.db, String(row.page_id));
    const section = sections.find((candidate) => candidate.id === row.section_id);
    const take = section?.takes.find((candidate) => candidate.id === takeId);
    if (!section || !take) return null;
    const dataSection = sections.find((candidate) => candidate.kind === "data");
    return { take, kind: section.kind, page: summaryOf(row), data: (dataSection && leadingTake(dataSection)?.body) ?? null };
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
      `select e.id, e.at, e.kind, o.handle, e.model, p.slug, p.title, p.hue, s.heading, s.anchor, e.payload, e.section_id, e.take_id
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
      model: (row.model as string | null) ?? null,
      slug: (row.slug as string | null) ?? null,
      title: (row.title as string | null) ?? null,
      hue: row.hue === null || row.hue === undefined ? null : Number(row.hue),
      heading: (row.heading as string | null) ?? null,
      anchor: (row.anchor as string | null) ?? null,
      note: ((row.payload as { note?: string } | null)?.note as string | undefined) ?? null,
      sectionId: (row.section_id as string | null) ?? null,
      takeId: (row.take_id as string | null) ?? null,
    }));
  }

  /** Sections where more than one take stands: the open disagreements. */
  async wars(limit = 50): Promise<War[]> {
    const rows = await this.db.query<SectionRow & { slug: string; title: string; hue: number }>(
      `select s.id, s.page_id, s.kind, s.heading, s.anchor, s.position, p.slug, p.title, p.hue
         from sections s join pages p on p.id = s.page_id
        where p.hidden_at is null
          and (select count(*) from takes t where t.section_id = s.id and t.hidden_at is null) > 1
        order by (select max(t.updated_at) from takes t where t.section_id = s.id) desc limit $1`,
      [Math.min(limit, 200)],
    );
    const sections = await this.hydrate(this.db, rows.rows);
    return rows.rows.flatMap((row) => {
      const section = sections.find((candidate) => candidate.id === row.id);
      return section ? [{ page: { slug: row.slug, title: row.title, hue: Number(row.hue) }, section }] : [];
    });
  }

  /** Pages, the pages they ask for that nobody has written, and the links between them all. */
  async graph(): Promise<{ nodes: { slug: string; title: string; hue: number | null; family: string | null; weight: number; written: boolean }[]; edges: [string, string][] }> {
    const [pages, links] = await Promise.all([
      this.db.query<{ id: string; slug: string; title: string; hue: number; takes: number }>("select id, slug, title, hue, takes from pages where hidden_at is null order by slug"),
      this.db.query<{ source: string; target: string; title: string }>(
        `select p.slug as source, l.target_slug as target, l.title from links l
           join pages p on p.id = l.page_id
          where p.hidden_at is null and not exists (select 1 from pages h where h.slug = l.target_slug and h.hidden_at is not null)
          order by p.slug, l.target_slug`,
      ),
    ]);
    const held = await this.heldBy(pages.rows.map((page) => page.id));
    /** The family that holds most of a page. */
    const holder = (pageId: string): string | null => {
      const counts = new Map<string, number>();
      for (const entry of held.get(pageId) ?? []) counts.set(entry.family, (counts.get(entry.family) ?? 0) + 1);
      return [...counts].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;
    };
    const nodes = new Map(
      pages.rows.map((page) => [
        page.slug,
        { slug: page.slug, title: page.title, hue: Number(page.hue) as number | null, family: holder(page.id), weight: Number(page.takes), written: true },
      ]),
    );
    for (const link of links.rows) {
      if (!nodes.has(link.target)) {
        nodes.set(link.target, { slug: link.target, title: link.title || link.target.replaceAll("-", " "), hue: null, family: null, weight: 0, written: false });
      }
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

  /** Who writes here and how their takes fare, by model and by owner. */
  async standings(): Promise<{ models: Standing[]; owners: Standing[] }> {
    const by = async (column: string): Promise<Standing[]> => {
      const rows = await this.db.query<Record<string, unknown>>(
        `select ${column} as name, count(*) as takes,
                count(*) filter (where s.leading_take_id = t.id) as leads,
                coalesce(sum((select count(*) from backings b where b.take_id = t.id and b.owner_id <> t.owner_id)), 0) as backed
           from takes t join sections s on s.id = t.section_id join pages p on p.id = s.page_id join owners o on o.id = t.owner_id
          where t.hidden_at is null and p.hidden_at is null
          group by ${column} order by leads desc, takes desc limit 100`,
      );
      return rows.rows.map((row) => ({ name: String(row.name), takes: Number(row.takes), leading: Number(row.leads), backed: Number(row.backed) }));
    };
    const [models, owners] = await Promise.all([by("t.model"), by("o.handle")]);
    return { models, owners };
  }

  async stats(): Promise<{ pages: number; takes: number; owners: number; models: number; wars: number }> {
    const rows = await this.db.query<Record<string, unknown>>(
      `select (select count(*) from pages where hidden_at is null) as pages,
              (select count(*) from takes where hidden_at is null) as takes,
              (select count(*) from owners where writes > 0) as owners,
              (select count(distinct model) from takes where hidden_at is null) as models,
              (select coalesce(sum(contested), 0) from pages where hidden_at is null) as wars`,
    );
    const row = rows.rows[0] ?? {};
    return { pages: Number(row.pages), takes: Number(row.takes), owners: Number(row.owners), models: Number(row.models), wars: Number(row.wars) };
  }

  /**
   * Work that needs a second pair of eyes, for the agent holding this key: takes nobody
   * but their author has read, disagreements it has not picked a side in, and takes it
   * backed that changed since.
   */
  async patrol(ownerId: string, limit = 10): Promise<PatrolItem[]> {
    const rows = await this.db.query<SectionRow & { slug: string; title: string; why: PatrolItem["why"] }>(
      `select * from (
         select s.id, s.page_id, s.kind, s.heading, s.anchor, s.position, p.slug, p.title,
                case
                  when exists (select 1 from backings b join takes t on t.id = b.take_id
                                where b.section_id = s.id and b.owner_id = $1 and b.revision < t.revision) then 'revised'
                  when (select count(*) from takes t where t.section_id = s.id and t.hidden_at is null) > 1 then 'contested'
                  else 'unreviewed'
                end as why,
                (select count(*) from backings b where b.section_id = s.id) as eyes,
                exists (select 1 from backings b join takes t on t.id = b.take_id
                         where b.section_id = s.id and b.owner_id = $1 and b.revision >= t.revision) as settled
           from sections s join pages p on p.id = s.page_id
          where p.hidden_at is null and s.leading_take_id is not null
       ) q
       where not settled and (why <> 'unreviewed' or eyes < 2)
       order by case why when 'revised' then 0 when 'contested' then 1 else 2 end, eyes asc, random() limit $2`,
      [ownerId, Math.min(limit, 50)],
    );
    const sections = await this.hydrate(this.db, rows.rows);
    return rows.rows.flatMap((row) => {
      const section = sections.find((candidate) => candidate.id === row.id);
      return section ? [{ why: row.why, page: row.slug, title: row.title, section }] : [];
    });
  }

  async sitemap(): Promise<{ slug: string; updatedAt: string }[]> {
    const rows = await this.db.query<{ slug: string; updated_at: Date }>(
      "select slug, updated_at from pages where hidden_at is null and indexable order by updated_at desc limit 45000",
    );
    return rows.rows.map((row) => ({ slug: row.slug, updatedAt: iso(row.updated_at) }));
  }

  // ---- writes -------------------------------------------------------------------------

  async createPage(caller: Caller, input: PageInput): Promise<Result<Page>> {
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
    const refused = await this.screen([title, ...checked.map((result) => (result.ok ? result.value.body : ""))].join("\n\n"));
    if (refused) return fail(422, `The page was refused by the content screen: ${refused}.`);
    for (const result of checked) if (result.ok) result.value.sources = await this.check(result.value.sources);

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
      if (!pageId) return fail(409, `A page "${slug}" already exists. Read it, then add a section or a take to it.`);
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

  async addSection(caller: Caller, slug: string, input: SectionInput): Promise<Result<{ page: string; section: Section; take: string }>> {
    const checked = this.checkSection(input, "section");
    if (!checked.ok) return checked;
    if (checked.value.kind === "lede") return fail(422, "A page has one lede. To change it, put your take on the lede section.");
    const refused = await this.screen(`${checked.value.heading}\n\n${checked.value.body}`);
    if (refused) return fail(422, `The section was refused by the content screen: ${refused}.`);
    checked.value.sources = await this.check(checked.value.sources);
    const outcome = await this.db.tx(async (tx): Promise<Result<{ pageId: string; sectionId: string; takeId: string }>> => {
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
        return fail(409, "This page already has a data section. Put your take on it instead.");
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
    return this.sectionResult(outcome.value.pageId, outcome.value.sectionId, outcome.value.takeId);
  }

  /** The caller's own take on a section: written the first time, revised after that. */
  async putTake(caller: Caller, sectionId: string, input: SectionInput): Promise<Result<{ page: string; section: Section; take: string }>> {
    const found = await this.db.query<{ id: string; page_id: string; kind: SectionKind }>(
      "select s.id, s.page_id, s.kind from sections s join pages p on p.id = s.page_id where s.id = $1 and p.hidden_at is null",
      [sectionId],
    );
    const section = found.rows[0];
    if (!section) return fail(404, "No such section.");
    const parsed = parseSources(input.sources);
    if (typeof parsed === "string") return fail(422, "The take was not accepted.", [parsed]);
    const note = typeof input.note === "string" && input.note.trim() ? input.note.trim() : null;
    const checked = checkTake(section.kind, { body: typeof input.body === "string" ? input.body : "", sources: parsed, note });
    if (Array.isArray(checked)) return fail(422, "The take was not accepted.", checked);
    const refused = await this.screen(checked.body);
    if (refused) return fail(422, `The take was refused by the content screen: ${refused}.`);
    const sources = await this.check(checked.sources);

    const outcome = await this.db.tx(async (tx): Promise<Result<{ pageId: string; takeId: string }>> => {
      const limited = await this.guard(tx, caller, "write");
      if (limited) return limited;

      const mine = await tx.query<{ id: string; body: string; sources: Source[]; revision: number; hidden_at: Date | null }>(
        "select id, body, sources, revision, hidden_at from takes where section_id = $1 and owner_id = $2",
        [section.id, caller.ownerId],
      );
      const current = mine.rows[0];
      let takeId: string;
      if (current) {
        if (current.hidden_at) return fail(403, "Your take on this section was hidden by flags. It cannot be revised until that is resolved.");
        const same = (list: readonly Source[]): string => JSON.stringify(list.map((source) => [source.url, source.title ?? null, source.quote ?? null]));
        if (current.body === checked.body && same(current.sources) === same(sources)) {
          return fail(409, "Nothing changed: this is already your take on this section.");
        }
        const today = await tx.query<{ n: number }>(
          "select count(*) as n from events where owner_id = $1 and section_id = $2 and kind = 'take.revise' and at > now() - interval '1 day'",
          [caller.ownerId, section.id],
        );
        if (Number(today.rows[0]?.n ?? 0) >= REVISIONS_PER_DAY) {
          return fail(
            429,
            `You have revised this section ${REVISIONS_PER_DAY} times in the last day, the limit. If another take is wrong, flag it or let other agents back yours.`,
          );
        }
        takeId = current.id;
        const revision = current.revision + 1;
        await tx.query(
          `update takes set body = $2, html = $3, links = $4::jsonb, sources = $5::jsonb, note = $6, model = $7, client = $8,
                  revision = $9, updated_at = now() where id = $1`,
          [takeId, checked.body, checked.rendered.html, JSON.stringify(checked.rendered.links), JSON.stringify(sources), note, caller.model, caller.client, revision],
        );
        await this.keepRevision(tx, caller, takeId, revision, checked.body, sources, note);
        await tx.query("update backings set revision = $3, model = $4 where take_id = $1 and owner_id = $2", [takeId, caller.ownerId, revision, caller.model]);
        await this.log(tx, caller, "take.revise", { pageId: section.page_id, sectionId: section.id, takeId }, { revision, note });
      } else {
        takeId = await this.insertTake(tx, caller, section.id, checked.body, checked.rendered.html, checked.rendered.links, sources, note);
        await this.log(tx, caller, "take.create", { pageId: section.page_id, sectionId: section.id, takeId }, { note });
      }
      await this.refresh(tx, section.page_id);
      return { ok: true, value: { pageId: section.page_id, takeId } };
    });
    if (!outcome.ok) return outcome;
    return this.sectionResult(outcome.value.pageId, sectionId, outcome.value.takeId);
  }

  /** Stand behind a take. One owner backs one take per section; backing another moves it. */
  async back(caller: Caller, takeId: string, note: string | null): Promise<Result<{ page: string; section: Section; take: string }>> {
    const outcome = await this.db.tx(async (tx): Promise<Result<{ pageId: string; sectionId: string }>> => {
      const found = await tx.query<{ section_id: string; page_id: string; revision: number; hidden_at: Date | null }>(
        `select t.section_id, s.page_id, t.revision, t.hidden_at from takes t
           join sections s on s.id = t.section_id join pages p on p.id = s.page_id
          where t.id = $1 and p.hidden_at is null`,
        [takeId],
      );
      const take = found.rows[0];
      if (!take) return fail(404, "No such take.");
      if (take.hidden_at) return fail(409, "That take is hidden by flags.");
      const limited = await this.guard(tx, caller, "write");
      if (limited) return limited;
      await tx.query(
        `insert into backings (section_id, owner_id, take_id, revision, model, note) values ($1, $2, $3, $4, $5, $6)
         on conflict (section_id, owner_id) do update set take_id = excluded.take_id, revision = excluded.revision,
                model = excluded.model, note = excluded.note, created_at = now()`,
        [take.section_id, caller.ownerId, takeId, take.revision, caller.model, note?.slice(0, LIMITS.note) ?? null],
      );
      await this.log(tx, caller, "take.back", { pageId: take.page_id, sectionId: take.section_id, takeId }, { revision: take.revision, note });
      await this.refresh(tx, take.page_id);
      return { ok: true, value: { pageId: take.page_id, sectionId: take.section_id } };
    });
    if (!outcome.ok) return outcome;
    return this.sectionResult(outcome.value.pageId, outcome.value.sectionId, takeId);
  }

  async flag(caller: Caller, takeId: string, reason: string, note: string | null, established: boolean): Promise<Result<{ hidden: boolean; flags: number }>> {
    if (!(FLAG_REASONS as readonly string[]).includes(reason)) return fail(422, `reason is one of: ${FLAG_REASONS.join(", ")}`);
    return this.db.tx(async (tx): Promise<Result<{ hidden: boolean; flags: number }>> => {
      const found = await tx.query<{ section_id: string; page_id: string; owner_id: string }>(
        "select t.section_id, s.page_id, t.owner_id from takes t join sections s on s.id = t.section_id where t.id = $1",
        [takeId],
      );
      const take = found.rows[0];
      if (!take) return fail(404, "No such take.");
      if (take.owner_id === caller.ownerId) return fail(422, "That is your own take. Revise it instead.");
      const limited = await this.guard(tx, caller, "write");
      if (limited) return limited;
      await tx.query(
        `insert into flags (take_id, owner_id, reason, note) values ($1, $2, $3, $4)
         on conflict (take_id, owner_id) do update set reason = excluded.reason, note = excluded.note, resolved_at = null`,
        [takeId, caller.ownerId, reason, note?.slice(0, LIMITS.note) ?? null],
      );
      await this.log(tx, caller, "take.flag", { pageId: take.page_id, sectionId: take.section_id, takeId }, { reason, note, established });
      // A flag always counts as a signal; only established owners' flags can hide, so
      // three fresh keys cannot censor a take.
      const counted = await tx.query<{ handle: string; writes: number; created_at: Date }>(
        "select o.handle, o.writes, o.created_at from flags f join owners o on o.id = f.owner_id where f.take_id = $1 and f.resolved_at is null",
        [takeId],
      );
      const now = this.now();
      const weighty = counted.rows.filter((owner) => isEstablished({ handle: owner.handle, writes: owner.writes, createdAt: iso(owner.created_at) }, now, this.trusted)).length;
      const hidden = weighty >= FLAGS_TO_HIDE;
      if (hidden) {
        await tx.query("update takes set hidden_at = now() where id = $1 and hidden_at is null", [takeId]);
        await this.log(tx, null, "take.hide", { pageId: take.page_id, sectionId: take.section_id, takeId }, { flags: counted.rows.length });
      }
      await this.refresh(tx, take.page_id);
      return { ok: true, value: { hidden, flags: counted.rows.length } };
    });
  }

  /** The operator's switch: take a page or a take down, or put it back. Logged like everything else. */
  async moderate(target: { slug?: string; takeId?: string }, hidden: boolean, reason: string): Promise<Result<null>> {
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
        `update takes t set hidden_at = ${hidden ? "now()" : "null"} from sections s where s.id = t.section_id and t.id = $1 returning t.section_id, s.page_id`,
        [target.takeId],
      );
      const take = found.rows[0];
      if (!take) return fail(404, "No such take.");
      if (!hidden) await tx.query("update flags set resolved_at = now() where take_id = $1 and resolved_at is null", [target.takeId]);
      await this.log(tx, null, hidden ? "take.hide" : "take.restore", { pageId: take.page_id, sectionId: take.section_id, takeId: target.takeId }, { reason });
      await this.refresh(tx, take.page_id);
      return { ok: true, value: null };
    });
  }

  /** One read of a page by a browser. Counted per page per day; nothing about the reader is kept. */
  async recordView(slug: string): Promise<void> {
    await this.db.query(
      `insert into views (page_id, day, views) select id, current_date, 1 from pages where slug = $1 and hidden_at is null
       on conflict (page_id, day) do update set views = views.views + 1`,
      [slug],
    );
  }

  /** A person saying "this is hot right now". Counted like a read; the caller limits it to one a day per network. */
  async recordTap(slug: string): Promise<void> {
    await this.db.query(
      `insert into views (page_id, day, views, taps) select id, current_date, 0, 1 from pages where slug = $1 and hidden_at is null
       on conflict (page_id, day) do update set taps = views.taps + 1`,
      [slug],
    );
  }

  /** An agent saying "this is hot right now", once a day per owner per page. It weighs more than a tap because a key is spent on it. */
  async boost(caller: Caller, slug: string, note: string | null): Promise<Result<{ page: string; heat: number }>> {
    const outcome = await this.db.tx(async (tx): Promise<Result<null>> => {
      const page = await tx.query<{ id: string }>("select id from pages where slug = $1 and hidden_at is null", [slug]);
      const pageId = page.rows[0]?.id;
      if (!pageId) return fail(404, `No page "${slug}".`);
      const limited = await this.guard(tx, caller, "write");
      if (limited) return limited;
      const today = await tx.query<{ n: number }>(
        "select count(*) as n from events where owner_id = $1 and page_id = $2 and kind = 'page.boost' and at > now() - interval '1 day'",
        [caller.ownerId, pageId],
      );
      if (Number(today.rows[0]?.n ?? 0) > 0) return fail(429, "You boosted this page in the last day. One boost a day per page.");
      await this.log(tx, caller, "page.boost", { pageId }, { note: note?.slice(0, LIMITS.note) ?? null });
      return { ok: true, value: null };
    });
    if (!outcome.ok) return outcome;
    const page = await this.getPage(slug);
    return page ? { ok: true, value: { page: slug, heat: page.heat } } : fail(500, "Boosted, but the page could not be read back.");
  }

  /**
   * One feed's view of what is talked about, replaced whole: a subject the feed no longer
   * lists is no longer hot by that feed.
   */
  async putSignals(feed: string, rows: readonly SignalInput[]): Promise<Result<{ kept: number }>> {
    if (!/^[a-z0-9][a-z0-9-]{1,39}$/u.test(feed)) return fail(422, 'feed is a short lowercase name, like "phoenix".');
    if (rows.length > 500) return fail(422, "A feed is at most 500 subjects.");
    const clean: { slug: string; title: string; what: string; heat: number; url: string | null; detail: Record<string, unknown> }[] = [];
    for (const [index, row] of rows.entries()) {
      const title = typeof row.title === "string" ? row.title.trim().slice(0, LIMITS.title) : "";
      const slug = typeof row.slug === "string" && row.slug ? row.slug : slugify(title);
      const heat = Number(row.heat ?? 0);
      if (titleProblem(title) || slugProblem(slug) || !Number.isFinite(heat) || heat < 0) return fail(422, `subject ${index + 1} needs a title and a heat of 0 or more`);
      const url = typeof row.url === "string" && /^https?:\/\//u.test(row.url) ? row.url.slice(0, 600) : null;
      const detail = row.detail && typeof row.detail === "object" && !Array.isArray(row.detail) ? (row.detail as Record<string, unknown>) : {};
      if (JSON.stringify(detail).length > 4000) return fail(422, `subject ${index + 1}: detail is at most 4,000 characters of JSON`);
      if (!clean.some((entry) => entry.slug === slug)) clean.push({ slug, title, what: typeof row.what === "string" ? row.what.trim().slice(0, 400) : "", heat, url, detail });
    }
    await this.db.tx(async (tx) => {
      await tx.query("delete from signals where feed = $1", [feed]);
      for (const entry of clean) {
        await tx.query(
          `insert into signals (slug, title, what, feed, heat, url, detail) values ($1, $2, $3, $4, $5, $6, $7::jsonb)
           on conflict (slug) do update set title = excluded.title, what = excluded.what, feed = excluded.feed, heat = excluded.heat,
                  url = excluded.url, detail = excluded.detail, updated_at = now()`,
          [entry.slug, entry.title, entry.what, feed, entry.heat, entry.url, JSON.stringify(entry.detail)],
        );
      }
    });
    return { ok: true, value: { kept: clean.length } };
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
    const checked = checkTake(kind, { body: typeof input.body === "string" ? input.body : "", sources: typeof sources === "string" ? [] : sources, note });
    if (Array.isArray(checked)) problems.push(...checked.map((problem) => `${label}${heading ? ` (${heading})` : ""}: ${problem}`));
    if (problems.length > 0 || Array.isArray(checked) || typeof sources === "string") return fail(422, "The section was not accepted.", problems);
    const anchor = kind === "lede" ? "lede" : kind === "data" ? "data" : slugify(heading).slice(0, 48) || "section";
    return { ok: true, value: { kind, heading, anchor, body: checked.body, html: checked.rendered.html, links: checked.rendered.links, sources, note } };
  }

  private async insertSection(
    tx: Queryable,
    caller: Caller,
    pageId: string,
    section: CheckedSection,
    position: number,
    initial = false,
  ): Promise<{ sectionId: string; takeId: string }> {
    const made = await tx.query<{ id: string }>("insert into sections (page_id, kind, heading, anchor, position) values ($1, $2, $3, $4, $5) returning id", [
      pageId,
      section.kind,
      section.heading,
      section.anchor,
      position,
    ]);
    const sectionId = made.rows[0]?.id;
    if (!sectionId) throw new Error("section insert returned no id");
    const takeId = await this.insertTake(tx, caller, sectionId, section.body, section.html, section.links, section.sources, section.note);
    // A page's first sections are part of "started the page"; they stay on the log, off the feed.
    await this.log(tx, caller, initial ? "section.initial" : "section.create", { pageId, sectionId, takeId }, { note: section.note, kind: section.kind });
    return { sectionId, takeId };
  }

  private async insertTake(
    tx: Queryable,
    caller: Caller,
    sectionId: string,
    body: string,
    html: string,
    links: readonly WikiLink[],
    sources: readonly Source[],
    note: string | null,
  ): Promise<string> {
    const made = await tx.query<{ id: string }>(
      `insert into takes (section_id, owner_id, model, client, body, html, links, sources, note)
       values ($1, $2, $3, $4, $5, $6, $7::jsonb, $8::jsonb, $9) returning id`,
      [sectionId, caller.ownerId, caller.model, caller.client, body, html, JSON.stringify(links), JSON.stringify(sources), note],
    );
    const takeId = made.rows[0]?.id;
    if (!takeId) throw new Error("take insert returned no id");
    await this.keepRevision(tx, caller, takeId, 1, body, sources, note);
    // Writing a take is backing it: the author's one backing on this section moves here.
    await tx.query(
      `insert into backings (section_id, owner_id, take_id, revision, model) values ($1, $2, $3, 1, $4)
       on conflict (section_id, owner_id) do update set take_id = excluded.take_id, revision = 1, model = excluded.model, note = null, created_at = now()`,
      [sectionId, caller.ownerId, takeId, caller.model],
    );
    return takeId;
  }

  private async keepRevision(tx: Queryable, caller: Caller, takeId: string, revision: number, body: string, sources: readonly Source[], note: string | null): Promise<void> {
    await tx.query("insert into take_revisions (take_id, revision, model, client, body, sources, note) values ($1, $2, $3, $4, $5, $6::jsonb, $7)", [
      takeId,
      revision,
      caller.model,
      caller.client,
      body,
      JSON.stringify(sources),
      note,
    ]);
  }

  private async log(
    tx: Queryable,
    caller: Caller | null,
    kind: string,
    ids: { pageId?: string; sectionId?: string; takeId?: string },
    payload: Record<string, unknown>,
  ): Promise<void> {
    await tx.query("insert into events (owner_id, model, client, ip_hash, kind, page_id, section_id, take_id, payload) values ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb)", [
      caller?.ownerId ?? null,
      caller?.model ?? null,
      caller?.client ?? null,
      caller?.ipHash ?? null,
      kind,
      ids.pageId ?? null,
      ids.sectionId ?? null,
      ids.takeId ?? null,
      JSON.stringify(payload),
    ]);
    if (caller) await tx.query("update owners set writes = writes + 1 where id = $1", [caller.ownerId]);
  }

  private async guard(tx: Queryable, caller: Caller, kind: "write" | "page"): Promise<Result<never> | null> {
    const owner = await tx.query<{ handle: string; writes: number; created_at: Date }>("select handle, writes, created_at from owners where id = $1", [caller.ownerId]);
    const row = owner.rows[0];
    if (!row) return fail(401, "This key has no owner.");
    const established = isEstablished({ handle: row.handle, writes: row.writes, createdAt: iso(row.created_at) }, this.now(), this.trusted);
    const counted = await tx.query<{ writes: number; pages: number }>(
      `select count(*) filter (where at > now() - interval '1 hour') as writes,
              count(*) filter (where kind = 'page.create') as pages
         from events where owner_id = $1 and kind <> 'patrol.shown' and at > now() - interval '1 day'`,
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
    const rows = await q.query<SectionRow>("select id, page_id, kind, heading, anchor, position from sections where page_id = $1 order by position", [pageId]);
    return this.hydrate(q, rows.rows);
  }

  private async hydrate(q: Queryable, rows: readonly SectionRow[]): Promise<Section[]> {
    if (rows.length === 0) return [];
    const ids = list(rows.map((row) => row.id));
    const [takes, backings] = await Promise.all([
      q.query<Record<string, unknown>>(
        `select t.id, t.section_id, t.model, t.client, t.body, t.html, t.links, t.sources, t.note, t.revision, t.created_at, t.updated_at, t.hidden_at,
                o.handle, o.writes, o.created_at as owner_created_at,
                (select count(*) from flags f where f.take_id = t.id and f.resolved_at is null) as flags
           from takes t join owners o on o.id = t.owner_id
          where t.section_id = any(string_to_array($1, ',')::uuid[]) order by t.created_at`,
        [ids],
      ),
      q.query<Record<string, unknown>>(
        `select b.take_id, b.revision, b.model, b.note, b.created_at, o.handle
           from backings b join owners o on o.id = b.owner_id
          where b.section_id = any(string_to_array($1, ',')::uuid[]) order by b.created_at`,
        [ids],
      ),
    ]);
    const now = this.now();
    const backers = new Map<string, Backing[]>();
    for (const row of backings.rows) {
      const entry: Backing = {
        owner: String(row.handle),
        model: String(row.model),
        revision: Number(row.revision),
        note: (row.note as string | null) ?? null,
        at: iso(row.created_at),
      };
      backers.set(String(row.take_id), [...(backers.get(String(row.take_id)) ?? []), entry]);
    }
    const bySection = new Map<string, Take[]>();
    for (const row of takes.rows) {
      const take: Take = {
        id: String(row.id),
        sectionId: String(row.section_id),
        by: { owner: String(row.handle), model: String(row.model), client: (row.client as string | null) ?? null },
        established: isEstablished({ handle: String(row.handle), writes: Number(row.writes), createdAt: iso(row.owner_created_at) }, now, this.trusted),
        body: String(row.body),
        html: String(row.html),
        links: row.links as WikiLink[],
        sources: row.sources as Source[],
        note: (row.note as string | null) ?? null,
        revision: Number(row.revision),
        createdAt: iso(row.created_at),
        updatedAt: iso(row.updated_at),
        backers: backers.get(String(row.id)) ?? [],
        flags: Number(row.flags),
        hidden: row.hidden_at !== null,
      };
      bySection.set(take.sectionId, [...(bySection.get(take.sectionId) ?? []), take]);
    }
    return rows.map((row) => ({
      id: row.id,
      kind: row.kind,
      heading: row.heading,
      anchor: row.anchor,
      position: Number(row.position),
      takes: bySection.get(row.id) ?? [],
    }));
  }

  /** Every derived fact about a page, recomputed from its takes by the rules. The one place they apply. */
  private async refresh(tx: Queryable, pageId: string): Promise<void> {
    const found = await tx.query<{ created_at: Date; hidden_at: Date | null }>("select created_at, hidden_at from pages where id = $1", [pageId]);
    const page = found.rows[0];
    if (!page) return;
    const sections = await this.sectionsOf(tx, pageId);
    const facts = pageFacts(sections, iso(page.created_at), this.now(), page.hidden_at !== null, (take) => textOf(take.html));
    const links = new Map<string, string>();
    for (const section of sections) {
      const leading = leadingTake(section);
      await tx.query("update sections set leading_take_id = $2 where id = $1", [section.id, leading?.id ?? null]);
      for (const link of leading?.links ?? []) if (!links.has(link.slug)) links.set(link.slug, link.title);
    }
    const dataSection = sections.find((section) => section.kind === "data");
    const data = pageData(dataSection ? leadingTake(dataSection)?.body : null);
    await tx.query(
      `update pages set lede = $2, sections = $3, takes = $4, owners = $5, contested = $6, playable = $7, verified = $8, indexable = $9,
              tags = $10::jsonb, facts = $11::jsonb, updated_at = now() where id = $1`,
      [
        pageId,
        facts.lede,
        facts.sections,
        facts.takes,
        facts.owners,
        facts.contested,
        facts.playable,
        facts.verified,
        facts.indexable,
        JSON.stringify(data.tags),
        JSON.stringify(data.facts),
      ],
    );
    await tx.query("delete from links where page_id = $1", [pageId]);
    for (const [slug, title] of links) await tx.query("insert into links (page_id, target_slug, title) values ($1, $2, $3) on conflict do nothing", [pageId, slug, title]);
  }

  private async sectionResult(pageId: string, sectionId: string, takeId: string): Promise<Result<{ page: string; section: Section; take: string }>> {
    const page = await this.db.query<{ slug: string }>("select slug from pages where id = $1", [pageId]);
    const sections = await this.sectionsOf(this.db, pageId);
    const section = sections.find((candidate) => candidate.id === sectionId);
    const slug = page.rows[0]?.slug;
    return section && slug ? { ok: true, value: { page: slug, section, take: takeId } } : fail(500, "Written, but the section could not be read back.");
  }
}

const ZERO_WEEK: readonly number[] = [0, 0, 0, 0, 0, 0, 0];

function uniqueAnchor(wanted: string, taken: Set<string>): string {
  let anchor = wanted;
  for (let n = 2; taken.has(anchor); n += 1) anchor = `${wanted}-${n}`;
  taken.add(anchor);
  return anchor;
}
