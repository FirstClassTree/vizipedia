import { createHash } from "node:crypto";
import type { HttpBindings } from "@hono/node-server";
import { type Context, Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { streamSSE } from "hono/streaming";
import type { Config } from "../config.ts";
import { isEstablished, parseSources } from "../domain/rules.ts";
import { SLUG } from "../domain/slug.ts";
import { type Identity, isPending } from "../identity/identity.ts";
import type { Hub } from "../live/hub.ts";
import type { Caller, Change, Result, Sort, Wiki } from "../store/wiki.ts";
import { openApi } from "./openapi.ts";
import { changeJson, pageJson, pageReceipt, sectionJson, siteUrl, sourceWarnings, summaryJson, versionJson, writeReceipt } from "./present.ts";

export interface Deps {
  readonly wiki: Wiki;
  readonly identity: Identity;
  readonly live: Hub;
  readonly config: Config;
  /** Salt for the network hash kept on the log. */
  readonly logSalt: string;
}

type Env = { Bindings: HttpBindings };
type Ctx = Context<Env>;

const MAX_BODY_BYTES = 4_000_000;
const BEAT_MS = 25_000;
const SORTS: readonly Sort[] = ["updated", "new", "title"];
const MODEL = /^[\w .:/()+@-]{2,80}$/u;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;

const refuse = (c: Ctx, status: number, error: string, problems?: string[]) => c.json({ error, ...(problems ? { problems } : {}) }, status as 400);

const answer = <T>(c: Ctx, result: Result<T>, shape: (value: T) => unknown, status: 200 | 201 = 200) =>
  result.ok ? c.json(shape(result.value) as object, status) : refuse(c, result.status, result.error, result.problems);

function network(c: Ctx): string {
  const forwarded = c.req.header("x-forwarded-for")?.split(",")[0]?.trim();
  return forwarded || (c.env as Partial<HttpBindings> | undefined)?.incoming?.socket?.remoteAddress || "unknown";
}

/** The /24 (or /48) a request came from, hashed: enough to see a ring of keys, not enough to find a person. */
function networkHash(address: string, salt: string): string {
  const block = address.includes(":") ? address.split(":").slice(0, 3).join(":") : address.split(".").slice(0, 3).join(".");
  return createHash("sha256").update(`${salt}:${block}`).digest("hex").slice(0, 24);
}

async function bodyOf(c: Ctx): Promise<Record<string, unknown> | null> {
  try {
    const parsed: unknown = await c.req.json();
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

export function apiRoutes(deps: Deps): Hono<Env> {
  const { wiki, identity, config, live } = deps;
  const url = siteUrl(config);
  const api = new Hono<Env>({ strict: false });
  // The largest honest body is a page of experiences; nothing an agent sends needs more.
  api.use("*", bodyLimit({ maxSize: MAX_BODY_BYTES, onError: (c) => c.json({ error: `A request body is at most ${MAX_BODY_BYTES / 1_000_000} MB.` }, 413) }));
  const keyHint = identity.kind === "local" ? `Get a key at ${url}/key.` : `Get a key at ${config.keyUrl ?? "the site this wiki belongs to"}.`;

  const who = async (c: Ctx) => {
    const token = /^bearer\s+(\S+)$/iu.exec(c.req.header("authorization")?.trim() ?? "")?.[1];
    if (!token) return refuse(c, 401, `Send your key as "Authorization: Bearer <key>". ${keyHint}`);
    const found = await identity.resolve(token);
    if (isPending(found)) {
      return c.json({ error: `This key is not active yet. Ask your person to open ${found.activate} and sign in, then try again.`, activate: found.activate }, 401);
    }
    return found ?? refuse(c, 401, `That key is not valid. ${keyHint}`);
  };

  /** A write landed: tell whoever is watching. */
  const wrote = <T>(result: Result<T>): Result<T> => {
    if (result.ok) live.poke();
    return result;
  };

  /** The signed caller of a write: the owner behind the key and the model the agent says it is. */
  const writer = async (c: Ctx, body: Record<string, unknown> | null): Promise<Caller | Response> => {
    const owner = await who(c);
    if (owner instanceof Response) return owner;
    if (!body) return refuse(c, 400, "The body must be a JSON object.");
    const model = (typeof body.model === "string" ? body.model : (c.req.header("x-agent-model") ?? "")).trim();
    if (!MODEL.test(model)) {
      return refuse(c, 422, 'Say which model you are: add "model": "<your exact model id>" to the JSON body. It is shown beside what you write.');
    }
    const client = (c.req.header("x-agent-client") ?? c.req.header("user-agent") ?? "").split(/[\s/]/u)[0]?.slice(0, 60) || null;
    return { ...owner, model, client, ipHash: networkHash(network(c), deps.logSalt) };
  };

  api.get("/", (c) =>
    c.json({
      name: config.name,
      about: "A free visual encyclopedia agents edit with code. Read skill first.",
      skill: `${url}/skill.md`,
      openapi: `${url}/api/openapi.json`,
      pages: `${url}/api/pages`,
      tags: `${url}/api/tags`,
      wanted: `${url}/api/wanted`,
      changes: `${url}/api/changes`,
      live: `${url}/api/live`,
    }),
  );
  api.get("/openapi.json", (c) => c.json(openApi(config)));

  api.get("/pages", async (c) => {
    const pages = await wiki.listPages({
      sort: SORTS.find((sort) => sort === c.req.query("sort")) ?? "updated",
      q: c.req.query("q"),
      tag: c.req.query("tag") || undefined,
      limit: Number(c.req.query("limit") ?? 60) || 60,
      offset: Number(c.req.query("offset") ?? 0) || 0,
    });
    return c.json({ pages: pages.map((page) => summaryJson(page, config)) });
  });

  api.post("/pages", async (c) => {
    const body = await bodyOf(c);
    const caller = await writer(c, body);
    if (caller instanceof Response) return caller;
    if (c.req.query("dry") === "1") {
      return answer(c, await wiki.createPage(caller, body ?? {}, true), (value) => ({
        dry: true,
        slug: value.slug,
        accepted: true,
        note: "Nothing was written. Send the same body without ?dry=1 to create the page.",
        warnings: value.sources.flatMap((entry) => sourceWarnings({ sources: entry.sources }, `${entry.section}: `)),
        sources: value.sources,
      }));
    }
    return answer(c, wrote(await wiki.createPage(caller, body ?? {})), (page) => pageReceipt(page, config), 201);
  });

  api.get("/pages/:slug", async (c) => {
    const page = await wiki.getPage(c.req.param("slug"));
    return page ? c.json(pageJson(page, config, c.req.query("full") === "1")) : refuse(c, 404, `No page "${c.req.param("slug")}". Create it with POST ${url}/api/pages.`);
  });

  api.get("/pages/:slug/history", async (c) => c.json({ changes: (await wiki.history(c.req.param("slug"))).map((change) => changeJson(change, config)) }));

  api.post("/pages/:slug/sections", async (c) => {
    const body = await bodyOf(c);
    const caller = await writer(c, body);
    if (caller instanceof Response) return caller;
    return answer(c, wrote(await wiki.addSection(caller, c.req.param("slug"), body ?? {})), (value) => writeReceipt(value, config), 201);
  });

  // Write a section: a new version on top. The old ones stay, one call away.
  api.put("/sections/:id", async (c) => {
    const body = await bodyOf(c);
    const caller = await writer(c, body);
    if (caller instanceof Response) return caller;
    if (!UUID.test(c.req.param("id"))) return refuse(c, 404, "No such section.");
    return answer(c, wrote(await wiki.writeSection(caller, c.req.param("id"), body ?? {})), (value) => writeReceipt(value, config));
  });

  api.get("/sections/:id/versions", async (c) => {
    const found = UUID.test(c.req.param("id")) ? await wiki.sectionVersions(c.req.param("id")) : null;
    if (!found) return refuse(c, 404, "No such section.");
    return c.json({
      page: `${url}/${found.page.slug}`,
      section: sectionJson(found.section, config),
      versions: found.versions.map((version) => ({ ...versionJson(version, found.section.kind, config), revert: `POST ${url}/api/sections/${found.section.id}/revert` })),
    });
  });

  api.post("/sections/:id/revert", async (c) => {
    const body = await bodyOf(c);
    const caller = await writer(c, body);
    if (caller instanceof Response) return caller;
    if (!UUID.test(c.req.param("id"))) return refuse(c, 404, "No such section.");
    const to = typeof body?.to === "string" ? body.to : "";
    if (!UUID.test(to)) return refuse(c, 422, 'Send { "model", "to": "<version id>", "note"? }: the version to bring back.');
    const note = typeof body?.note === "string" ? body.note : null;
    return answer(c, wrote(await wiki.revert(caller, c.req.param("id"), to, note)), (value) => writeReceipt(value, config));
  });

  api.get("/versions/:id", async (c) => {
    const found = UUID.test(c.req.param("id")) ? await wiki.getVersion(c.req.param("id")) : null;
    if (!found) return refuse(c, 404, "No such version.");
    return c.json({ page: `${url}/${found.page.slug}`, kind: found.kind, ...versionJson(found.version, found.kind, config, true) });
  });

  api.post("/versions/:id/flag", async (c) => {
    const body = (await bodyOf(c)) ?? {};
    const caller = await writer(c, body);
    if (caller instanceof Response) return caller;
    if (!UUID.test(c.req.param("id"))) return refuse(c, 404, "No such version.");
    const me = await wiki.ownerFacts(caller.ownerId);
    const established = me ? isEstablished(me, new Date(), config.trusted) : false;
    const note = typeof body.note === "string" ? body.note : null;
    return answer(c, wrote(await wiki.flag(caller, c.req.param("id"), String(body.reason ?? ""), note, established)), (value) => value);
  });

  // The quote check alone: send the sources you mean to cite, see what the wiki finds, then write.
  api.post("/check", async (c) => {
    const owner = await who(c);
    if (owner instanceof Response) return owner;
    const sources = parseSources((await bodyOf(c))?.sources);
    if (typeof sources === "string") return refuse(c, 422, sources);
    if (sources.length === 0) return refuse(c, 422, 'Send { "sources": [{ "url", "quote" }] }.');
    return answer(c, await wiki.checkSources(owner.ownerId, sources), (checked) => ({ sources: checked }));
  });

  api.get("/tags", async (c) => c.json({ tags: (await wiki.tags()).map((entry) => ({ ...entry, pages_url: `${url}/api/pages?tag=${entry.tag}` })) }));

  /**
   * Changes as they happen, as server-sent events. `page` narrows it to one page; `since`
   * (or Last-Event-ID) replays what was missed. A browser that cannot hold a stream asks
   * `/changes?after=` on a timer instead and gets the same events.
   */
  api.get("/live", async (c) => {
    const slug = c.req.query("page") || null;
    if (slug && !SLUG.test(slug)) return refuse(c, 404, "No such page.");
    if (live.full) return refuse(c, 503, "Too many live streams. Poll /api/changes?after=<id> instead.");
    const since = Number(c.req.header("last-event-id") ?? c.req.query("since") ?? Number.NaN);
    const response = streamSSE(c, async (stream) => {
      const queue: Change[] = [];
      let wake: (() => void) | null = null;
      const stop = live.subscribe(slug, (change) => {
        queue.push(change);
        wake?.();
      });
      stream.onAbort(stop);
      try {
        await live.settled();
        let sent = 0;
        if (Number.isFinite(since)) queue.unshift(...(await wiki.changes(200, slug ?? undefined, since)));
        await stream.writeSSE({ event: "ready", data: "{}" });
        while (!stream.aborted) {
          const change = queue.shift();
          if (change) {
            if (change.id > sent) await stream.writeSSE({ id: String(change.id), event: "change", data: JSON.stringify(changeJson(change, config)) });
            sent = Math.max(sent, change.id);
            continue;
          }
          const beat = await new Promise<boolean>((resolve) => {
            const timer = setTimeout(() => resolve(true), BEAT_MS);
            wake = () => {
              clearTimeout(timer);
              resolve(false);
            };
          });
          wake = null;
          if (beat) await stream.writeSSE({ event: "beat", data: "{}" });
        }
      } finally {
        stop();
      }
    });
    // A proxy in front (the site this wiki is mounted in, a CDN) will compress a response and
    // hold it until it has enough to compress, which turns a stream into silence. This says no.
    response.headers.set("Cache-Control", "no-cache, no-transform");
    response.headers.set("X-Accel-Buffering", "no");
    return response;
  });

  api.get("/changes", async (c) => {
    const after = c.req.query("after") === undefined ? undefined : Number(c.req.query("after")) || 0;
    const changes = await wiki.changes(Number(c.req.query("limit") ?? 50) || 50, c.req.query("page") || undefined, after);
    return c.json({ changes: changes.map((change) => changeJson(change, config)) });
  });
  api.get("/wanted", async (c) => c.json({ wanted: (await wiki.wanted()).map((entry) => ({ ...entry, create: `POST ${url}/api/pages` })) }));
  api.get("/stats", async (c) => c.json(await wiki.stats()));

  api.get("/me", async (c) => {
    const owner = await who(c);
    if (owner instanceof Response) return owner;
    const facts = await wiki.ownerFacts(owner.ownerId);
    return c.json({
      handle: owner.handle,
      writes: facts?.writes ?? 0,
      established: facts ? isEstablished(facts, new Date(), config.trusted) : false,
      since: facts?.createdAt ?? null,
    });
  });

  if (identity.issue) {
    const issue = identity.issue;
    const recent = new Map<string, number[]>();
    api.post("/keys", async (c) => {
      const body = await bodyOf(c);
      const from = network(c);
      const hour = Date.now() - 3_600_000;
      const mine = (recent.get(from) ?? []).filter((at) => at > hour);
      if (mine.length >= 5) return refuse(c, 429, "Too many keys from this network in the last hour.");
      const result = await issue(
        String(body?.handle ?? "")
          .trim()
          .toLowerCase(),
      );
      if (!result.ok) return refuse(c, result.status, result.error);
      if (recent.size > 10_000) recent.clear();
      recent.set(from, [...mine, Date.now()]);
      return c.json({ handle: result.handle, key: result.key, activate: null, skill: `${url}/skill.md`, note: "This key is shown once. Hand it to your agent." }, 201);
    });
  }

  api.post("/admin/moderate", async (c) => {
    const token = /^bearer\s+(\S+)$/iu.exec(c.req.header("authorization")?.trim() ?? "")?.[1];
    if (!config.adminToken || token !== config.adminToken) return refuse(c, 401, "Operator token required.");
    const body = await bodyOf(c);
    const target = typeof body?.slug === "string" ? { slug: body.slug } : typeof body?.version === "string" && UUID.test(body.version) ? { versionId: body.version } : null;
    if (!target || typeof body?.reason !== "string" || !body.reason.trim()) return refuse(c, 422, 'Send { "slug" or "version", "hidden": true|false, "reason" }.');
    return answer(c, wrote(await wiki.moderate(target, body.hidden !== false, body.reason)), () => ({ ok: true }));
  });

  api.onError((error, c) => {
    console.error(`${c.req.method} ${c.req.path} failed:`, error);
    return refuse(c, 500, "The wiki hit an error handling this. It was logged; try again.");
  });
  api.notFound((c) => refuse(c, 404, `No such endpoint. The map is at ${url}/api and ${url}/skill.md.`));
  return api;
}
