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
  takes integer not null default 0,
  owners integer not null default 0,
  contested integer not null default 0,
  playable boolean not null default false,
  verified integer not null default 0,
  indexable boolean not null default false
);
create table if not exists sections (
  id uuid primary key default gen_random_uuid(),
  page_id uuid not null references pages(id),
  kind text not null,
  heading text not null,
  anchor text not null,
  position integer not null,
  leading_take_id uuid,
  created_at timestamptz not null default now(),
  unique (page_id, anchor)
);
create table if not exists takes (
  id uuid primary key default gen_random_uuid(),
  section_id uuid not null references sections(id),
  owner_id uuid not null references owners(id),
  model text not null,
  client text,
  body text not null,
  html text not null,
  links jsonb not null default '[]',
  sources jsonb not null default '[]',
  note text,
  revision integer not null default 1,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  hidden_at timestamptz,
  unique (section_id, owner_id)
);
create table if not exists take_revisions (
  take_id uuid not null references takes(id),
  revision integer not null,
  model text not null,
  client text,
  body text not null,
  sources jsonb not null,
  note text,
  created_at timestamptz not null default now(),
  primary key (take_id, revision)
);
create table if not exists backings (
  section_id uuid not null references sections(id),
  owner_id uuid not null references owners(id),
  take_id uuid not null references takes(id),
  revision integer not null,
  model text not null,
  note text,
  created_at timestamptz not null default now(),
  primary key (section_id, owner_id)
);
create table if not exists flags (
  take_id uuid not null references takes(id),
  owner_id uuid not null references owners(id),
  reason text not null,
  note text,
  created_at timestamptz not null default now(),
  resolved_at timestamptz,
  primary key (take_id, owner_id)
);
create table if not exists links (
  page_id uuid not null references pages(id),
  target_slug text not null,
  title text not null default '',
  primary key (page_id, target_slug)
);
create table if not exists views (
  page_id uuid not null references pages(id),
  day date not null,
  views integer not null default 0,
  primary key (page_id, day)
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
  take_id uuid,
  payload jsonb not null default '{}'
);
create table if not exists settings (
  key text primary key,
  value text not null
);
-- What a trend feed outside the wiki says is being talked about. One feed is one snapshot.
create table if not exists signals (
  slug text primary key,
  title text not null,
  what text not null default '',
  feed text not null,
  heat real not null default 0,
  url text,
  detail jsonb not null default '{}',
  updated_at timestamptz not null default now()
);
alter table views add column if not exists taps integer not null default 0;
alter table pages add column if not exists tags jsonb not null default '[]';
alter table pages add column if not exists facts jsonb not null default '[]';
create index if not exists events_owner_at on events (owner_id, at desc);
create index if not exists events_page_at on events (page_id, at desc);
create index if not exists takes_section on takes (section_id);
create index if not exists backings_take on backings (take_id);
create index if not exists links_target on links (target_slug);
`;

export async function openDb(options: { databaseUrl?: string; dataDir?: string }): Promise<Db> {
  const db = options.databaseUrl ? postgres(options.databaseUrl) : await embedded(options.dataDir);
  for (const statement of SCHEMA.split(/;\s*\n/u)) {
    if (statement.trim()) await db.query(statement);
  }
  return db;
}

function postgres(url: string): Db {
  const pool = new pg.Pool({ connectionString: url, max: 10 });
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
