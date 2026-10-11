import { mkdirSync } from "node:fs";
import { PGlite } from "@electric-sql/pglite";
import pg from "pg";

/**
 * One SQL dialect, two drivers: a real Postgres when DATABASE_URL is set, an embedded
 * one (PGlite, a file on disk or memory) when it is not. So `npm start` needs nothing
 * installed, and production is the same queries on the same engine.
 */

export interface Queryable {
  query<Row = Record<string, unknown>>(sql: string, params?: readonly unknown[]): Promise<{ rows: Row[] }>;
}

export interface Db extends Queryable {
  tx<T>(work: (tx: Queryable) => Promise<T>): Promise<T>;
  close(): Promise<void>;
}

export const SCHEMA = `
create table if not exists owners (
  id uuid primary key default gen_random_uuid(),
  handle text not null unique,
  external_id text unique,
  writes integer not null default 0,
  created_at timestamptz not null default now()
);
-- The person's name, next to the handle on every signature (Tal, 2026-10-11: "not strictly the owner but also a name for its owner").
alter table owners add column if not exists name text;
create table if not exists keys (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references owners(id),
  key_hash text not null unique,
  created_at timestamptz not null default now(),
  last_used_at timestamptz,
  revoked_at timestamptz
);
create table if not exists pages (
  id uuid primary key default gen_random_uuid(),
  slug text not null unique,
  title text not null,
  hue integer not null,
  created_by uuid not null references owners(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  hidden_at timestamptz,
  lede text not null default '',
  sections integer not null default 0,
  owners integer not null default 0,
  playable boolean not null default false,
  verified integer not null default 0,
  indexable boolean not null default false,
  cover_version_id uuid,
  cover_kind text,
  tags jsonb not null default '[]',
  facts jsonb not null default '[]'
);
create table if not exists sections (
  id uuid primary key default gen_random_uuid(),
  page_id uuid not null references pages(id),
  kind text not null,
  heading text not null,
  anchor text not null,
  position integer not null,
  current_version_id uuid,
  created_at timestamptz not null default now(),
  unique (page_id, anchor)
);
-- Every write to a section, kept whole. The newest one nobody hid is what readers see.
create table if not exists versions (
  id uuid primary key default gen_random_uuid(),
  section_id uuid not null references sections(id),
  owner_id uuid not null references owners(id),
  number integer not null,
  model text not null,
  client text,
  body text not null,
  html text not null,
  links jsonb not null default '[]',
  sources jsonb not null default '[]',
  note text,
  revert_of uuid references versions(id),
  created_at timestamptz not null default now(),
  hidden_at timestamptz,
  unique (section_id, number)
);
create table if not exists flags (
  version_id uuid not null references versions(id),
  owner_id uuid not null references owners(id),
  reason text not null,
  note text,
  created_at timestamptz not null default now(),
  resolved_at timestamptz,
  primary key (version_id, owner_id)
);
create table if not exists links (
  page_id uuid not null references pages(id),
  target_slug text not null,
  title text not null default '',
  primary key (page_id, target_slug)
);
-- The raw log: every write, as it happened. Rules change; this does not.
create table if not exists events (
  id bigserial primary key,
  at timestamptz not null default now(),
  owner_id uuid references owners(id),
  model text,
  client text,
  ip_hash text,
  kind text not null,
  page_id uuid,
  section_id uuid,
  version_id uuid,
  payload jsonb not null default '{}'
);
create table if not exists settings (
  key text primary key,
  value text not null
);
create index if not exists events_owner_at on events (owner_id, at desc);
create index if not exists events_page_at on events (page_id, at desc);
create index if not exists versions_section on versions (section_id, number desc);
create table if not exists posters (
  version_id uuid primary key references versions(id),
  image bytea not null,
  created_at timestamptz not null default now()
);
create index if not exists links_target on links (target_slug);
`;

export async function openDb(options: { databaseUrl?: string; dataDir?: string; poolSize?: number }): Promise<Db> {
  const db = options.databaseUrl ? postgres(options.databaseUrl, options.poolSize ?? 10) : await embedded(options.dataDir);
  for (const statement of SCHEMA.split(/;\s*\n/u)) {
    if (statement.trim()) await db.query(statement);
  }
  return db;
}

/** Connections per process: a shared Postgres with few allowed (Cloud SQL's smallest permits 25) wants a small pool per instance. */
function postgres(url: string, max: number): Db {
  const pool = new pg.Pool({ connectionString: url, max });
  return {
    query: (sql, params) => pool.query(sql, params as unknown[]) as never,
    async tx(work) {
      const client = await pool.connect();
      try {
        await client.query("begin");
        const result = await work({ query: (sql, params) => client.query(sql, params as unknown[]) as never });
        await client.query("commit");
        return result;
      } catch (error) {
        await client.query("rollback");
        throw error;
      } finally {
        client.release();
      }
    },
    close: () => pool.end(),
  };
}

async function embedded(dataDir?: string): Promise<Db> {
  if (dataDir) mkdirSync(dataDir, { recursive: true });
  const lite = await PGlite.create(dataDir);
  return {
    query: (sql, params) => lite.query(sql, params as unknown[]) as never,
    tx: (work) => lite.transaction((tx) => work({ query: (sql, params) => tx.query(sql, params as unknown[]) as never })) as never,
    close: () => lite.close(),
  };
}
