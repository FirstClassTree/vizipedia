import type { HttpBindings } from "@hono/node-server";
import type { Context } from "hono";

/**
 * Where a request came from, for rate limits and the log's network hash. A proxy that knows the
 * caller says so in CLIENT_IP_HEADER (and must strip the same header off what the caller sent).
 * Otherwise the last X-Forwarded-For entry: the one the nearest hop appended, which a caller
 * cannot choose, unlike the first.
 */
export function network(c: Context<{ Bindings: HttpBindings }>, header: string | undefined): string {
  const named = header ? c.req.header(header)?.trim() : undefined;
  const forwarded = c.req.header("x-forwarded-for")?.split(",").at(-1)?.trim();
  return named || forwarded || (c.env as Partial<HttpBindings> | undefined)?.incoming?.socket?.remoteAddress || "unknown";
}

/** How many keys one network may mint in an hour, on the API and on the key page alike. */
export const KEYS_PER_HOUR = 5;

/** Remembers recent key mints per network; in memory, enough for one server. */
export class KeyMints {
  private readonly recent = new Map<string, number[]>();
  /** True when this network may mint another key now; counts it if so. */
  allow(from: string, now = Date.now()): boolean {
    const hour = now - 3_600_000;
    const mine = (this.recent.get(from) ?? []).filter((at) => at > hour);
    if (mine.length >= KEYS_PER_HOUR) return false;
    if (this.recent.size > 10_000) this.recent.clear();
    this.recent.set(from, [...mine, now]);
    return true;
  }
}
