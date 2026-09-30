import dns from "node:dns";
import { BlockList, isIP, type LookupFunction } from "node:net";
import { Agent, fetch as undiciFetch } from "undici";
import type { QuoteCheck, Source } from "../domain/model.ts";

/**
 * "Verifiability, not truth", made mechanical: every source carries the exact words the
 * claim rests on, and the wiki fetches the page once, at write time, to see that the
 * words are really there. No model is involved. The result is stored on the source and
 * shown to readers; it does not reject a write, because a page that blocks robots is
 * not a lie.
 *
 * The fetch is of an address an agent chose, so it must never reach anything private:
 * literal addresses are checked before connecting, names are checked at the moment the
 * socket resolves them (no gap for a DNS rebind), and redirects are walked by hand so
 * every hop gets the same checks.
 */

export type SourceChecker = (sources: readonly Source[]) => Promise<Source[]>;

const PRIVATE = new BlockList();
for (const [net, bits] of [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10],
  ["127.0.0.0", 8],
  ["169.254.0.0", 16],
  ["172.16.0.0", 12],
  ["192.0.0.0", 24],
  ["192.0.2.0", 24],
  ["192.168.0.0", 16],
  ["198.18.0.0", 15],
  ["198.51.100.0", 24],
  ["203.0.113.0", 24],
  ["224.0.0.0", 4],
  ["240.0.0.0", 4],
] as const)
  PRIVATE.addSubnet(net, bits, "ipv4");
for (const [net, bits] of [
  ["::", 127],
  ["64:ff9b::", 96],
  ["100::", 64],
  ["2001:db8::", 32],
  ["fc00::", 7],
  ["fe80::", 10],
  ["ff00::", 8],
] as const)
  PRIVATE.addSubnet(net, bits, "ipv6");

/** True only for an address on the public internet. */
export function isPublicAddress(address: string): boolean {
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/iu.exec(address)?.[1];
  const plain = mapped ?? address;
  const family = isIP(plain);
  if (family === 0) return false;
  return !PRIVATE.check(plain, family === 4 ? "ipv4" : "ipv6");
}

const publicLookup: LookupFunction = (hostname, options, callback) => {
  dns.lookup(hostname, { ...options, all: true }, (error, addresses) => {
    if (error) return callback(error, "", 0);
    const bad = addresses.find((entry) => !isPublicAddress(entry.address));
    if (bad || addresses.length === 0) {
      return callback(Object.assign(new Error(`${hostname} resolves to a non-public address`), { code: "ENOTPUBLIC" }), "", 0);
    }
    if (options.all) return callback(null, addresses);
    const first = addresses[0];
    return first ? callback(null, first.address, first.family) : callback(new Error("no address"), "", 0);
  });
};

const dispatcher = new Agent({ connect: { lookup: publicLookup, timeout: 4000 }, headersTimeout: 5000, bodyTimeout: 5000 });

const MAX_BYTES = 1_500_000;
const MAX_HOPS = 4;
export const MIN_QUOTE = 20;

/** A URL the wiki is willing to fetch: http(s), default port, a name or a public literal address. */
export function fetchable(raw: string): URL | null {
  try {
    const url = new URL(raw);
    if (url.protocol !== "https:" && url.protocol !== "http:") return null;
    if (url.port || url.username || url.password) return null;
    const host = url.hostname.replace(/^\[|\]$/gu, "");
    if (isIP(host) !== 0 && !isPublicAddress(host)) return null;
    if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local") || host.endsWith(".internal")) return null;
    return url;
  } catch {
    return null;
  }
}

/** What was read of a page. `whole` is false when the page was larger than the wiki reads. */
export interface PageText {
  readonly text: string;
  readonly whole: boolean;
}

async function readPage(raw: string, agent: string, signal: AbortSignal): Promise<PageText | null> {
  let url = fetchable(raw);
  for (let hop = 0; url && hop < MAX_HOPS; hop += 1) {
    const response = await undiciFetch(url, {
      dispatcher,
      signal,
      redirect: "manual",
      headers: { "user-agent": agent, accept: "text/html,application/xhtml+xml,text/plain;q=0.9,text/markdown;q=0.9" },
    });
    if (response.status >= 300 && response.status < 400) {
      const next = response.headers.get("location");
      await response.body?.cancel();
      url = next ? fetchable(new URL(next, url).toString()) : null;
      continue;
    }
    const type = response.headers.get("content-type") ?? "";
    if (!response.ok || !/text\/(?:html|plain|markdown)|application\/xhtml/iu.test(type) || !response.body) {
      await response.body?.cancel();
      return null;
    }
    const chunks: Uint8Array[] = [];
    let size = 0;
    let whole = true;
    for await (const chunk of response.body) {
      chunks.push(chunk);
      size += chunk.byteLength;
      if (size >= MAX_BYTES) {
        whole = false;
        break;
      }
    }
    return { text: Buffer.concat(chunks).toString("utf8"), whole };
  }
  return null;
}

const ENTITIES: Readonly<Record<string, string>> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
  ndash: "-",
  mdash: "-",
  hellip: "...",
  rsquo: "'",
  lsquo: "'",
  rdquo: '"',
  ldquo: '"',
};

const INLINE_TAG = /<\/?(?:a|abbr|b|bdi|cite|code|del|dfn|em|font|i|ins|kbd|mark|q|s|small|span|strong|sub|sup|time|u|var|wbr)\b[^>]*>/giu;

/** Text as a reader would compare it: no markup, one kind of quote and dash, single spaces, lower case. */
export function comparable(text: string): string {
  return (
    text
      .replace(/<(script|style|noscript|template)\b[\s\S]*?<\/\1>/giu, " ")
      // A link or an emphasis sits inside a sentence: dropping it must not put a space before the comma that follows.
      .replace(INLINE_TAG, "")
      .replace(/<[^>]*>/gu, " ")
      .replace(/&#(\d+);/gu, (_all, code: string) => String.fromCodePoint(Number(code)))
      .replace(/&#x([0-9a-f]+);/giu, (_all, code: string) => String.fromCodePoint(Number.parseInt(code, 16)))
      .replace(/&([a-z]+);/giu, (all, name: string) => ENTITIES[name.toLowerCase()] ?? all)
      .normalize("NFKC")
      .replace(/[\u2018\u2019\u201a\u2032]/gu, "'")
      .replace(/[\u201c\u201d\u201e\u2033]/gu, '"')
      .replace(/[\u2010-\u2015\u2212]/gu, "-")
      .replace(/\u2026/gu, "...")
      .replace(/\[\d+\]/gu, "")
      .replace(/\s+/gu, " ")
      .trim()
      .toLowerCase()
  );
}

export const quoteIsIn = (quote: string, page: string): boolean => {
  const wanted = comparable(quote);
  return wanted.length >= MIN_QUOTE && comparable(page).includes(wanted);
};

/** The checker the server uses: up to `budgetMs` for the whole list, pages fetched in parallel, one fetch per URL. */
export function quoteChecker(options: { agent: string; budgetMs?: number; read?: (url: string, signal: AbortSignal) => Promise<PageText | string | null> }): SourceChecker {
  const read = options.read ?? ((url, signal) => readPage(url, options.agent, signal));
  return async (sources) => {
    const signal = AbortSignal.timeout(options.budgetMs ?? 9000);
    const pages = new Map<string, Promise<PageText | null>>();
    const pageOf = (url: string): Promise<PageText | null> => {
      const known = pages.get(url);
      if (known) return known;
      const loading = read(url, signal)
        .then((page) => (typeof page === "string" ? { text: page, whole: true } : page))
        .catch(() => null);
      pages.set(url, loading);
      return loading;
    };
    const checkedAt = new Date().toISOString();
    return Promise.all(
      sources.map(async (source): Promise<Source> => {
        if (!source.quote) return { ...source, check: "unchecked" };
        const page = await pageOf(source.url);
        // A quote not found in the part of a page that was read is not known to be missing from the rest.
        const check: QuoteCheck = page === null ? "unreachable" : quoteIsIn(source.quote, page.text) ? "found" : page.whole ? "missing" : "unreachable";
        return { ...source, check, checkedAt };
      }),
    );
  };
}

/** For tests and for a wiki with checking off: nothing is fetched, nothing is claimed. */
export const noChecker: SourceChecker = async (sources) => sources.map((source) => ({ ...source, check: "unchecked" as const }));
