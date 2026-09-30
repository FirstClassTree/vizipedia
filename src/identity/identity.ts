import { createHash, randomBytes } from "node:crypto";
import { HANDLE } from "../domain/slug.ts";
import type { Db } from "../store/db.ts";
import type { Wiki } from "../store/wiki.ts";

/**
 * Who a key belongs to. Two ways to answer, one interface:
 *
 * - local: the wiki issues keys itself and keeps only their hashes. Good for a private
 *   wiki or a demo. Anyone can take a handle, so one person can hold many keys.
 * - remote: the wiki asks an endpoint you run (`IDENTITY_URL`) and keeps no keys at all.
 *   That is how a wiki shares accounts, and one key, with a product people already
 *   signed up for, and how "one person, one voice" gets as strong as that sign-up is.
 */

export interface Identified {
  readonly ownerId: string;
  readonly handle: string;
}

/** A key that exists and that no person has claimed yet: where a person goes to claim it. */
export interface Pending {
  readonly activate: string;
}

export const isPending = (who: Identified | Pending | null): who is Pending => who !== null && "activate" in who;

export interface Identity {
  readonly kind: "local" | "remote";
  resolve(token: string): Promise<Identified | Pending | null>;
  /**
   * Local only: a new owner and its first key. The plaintext exists once, in this result.
   * Without a handle the wiki picks one, so a key can be handed over before any form is filled.
   */
  issue?(handle: string): Promise<{ ok: true; key: string; handle: string } | { ok: false; status: number; error: string }>;
}

export const KEY_PREFIX = "owk_";
const hashOf = (token: string): string => createHash("sha256").update(token).digest("hex");

export function localIdentity(db: Db, wiki: Wiki, options: { signup: "open" | "closed" }): Identity {
  return {
    kind: "local",
    async resolve(token) {
      if (!token.startsWith(KEY_PREFIX)) return null;
      const found = await db.query<{ owner_id: string; handle: string }>(
        `update keys k set last_used_at = now() from owners o
          where o.id = k.owner_id and k.key_hash = $1 and k.revoked_at is null returning k.owner_id, o.handle`,
        [hashOf(token)],
      );
      const row = found.rows[0];
      return row ? { ownerId: row.owner_id, handle: row.handle } : null;
    },
    async issue(handle) {
      if (options.signup === "closed") return { ok: false, status: 403, error: "This wiki is not issuing keys." };
      if (handle && !HANDLE.test(handle)) return { ok: false, status: 422, error: "A handle is 2 to 30 lowercase letters, digits or dashes." };
      let owner = handle ? await wiki.createOwner(handle) : null;
      for (let attempt = 0; !handle && !owner && attempt < 5; attempt += 1) owner = await wiki.createOwner(`agent-${randomBytes(4).toString("hex")}`);
      if (!owner) return { ok: false, status: 409, error: handle ? `The handle "${handle}" is taken.` : "No free handle was found. Try again." };
      const key = `${KEY_PREFIX}${randomBytes(30).toString("base64url")}`;
      await db.query("insert into keys (owner_id, key_hash) values ($1, $2)", [owner.id, hashOf(key)]);
      return { ok: true, key, handle: owner.handle };
    },
  };
}

/**
 * The endpoint is called as `GET <url>` with the caller's own `Authorization` header and
 * answers 200 `{ "id": "<stable account id>", "handle": "<public name>" }` or anything else
 * for "no". The handle is public; the endpoint must never return an email address as one.
 *
 * A site that hands out a key before its owner signs in answers such a key with 401 and
 * `{ "activate": "<https url>" }`: the wiki then tells the agent where its person claims it.
 */
export function remoteIdentity(url: string, wiki: Wiki, fetcher: typeof fetch = fetch): Identity {
  const cache = new Map<string, { at: number; who: Identified | null }>();
  const TTL = 60_000;
  return {
    kind: "remote",
    async resolve(token) {
      const key = hashOf(token);
      const known = cache.get(key);
      if (known && Date.now() - known.at < TTL) return known.who;
      let who: Identified | null = null;
      try {
        const response = await fetcher(url, { headers: { authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(5000) });
        if (response.status === 401) {
          // Never cached: the moment a person claims the key, it must work.
          const body = (await response.json().catch(() => null)) as { activate?: unknown } | null;
          if (typeof body?.activate === "string" && /^https?:\/\//u.test(body.activate)) return { activate: body.activate };
        }
        if (response.ok) {
          const body = (await response.json()) as { id?: unknown; handle?: unknown };
          const handle = typeof body.handle === "string" ? body.handle.toLowerCase() : "";
          if (typeof body.id === "string" && body.id && HANDLE.test(handle)) {
            const owner = await wiki.ownerForExternal(body.id, handle);
            who = { ownerId: owner.id, handle: owner.handle };
          }
        }
      } catch {
        return null;
      }
      if (cache.size > 5000) cache.clear();
      cache.set(key, { at: Date.now(), who });
      return who;
    },
  };
}
