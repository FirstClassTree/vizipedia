import type { SignalInput, Wiki } from "../store/wiki.ts";

/**
 * A trend feed is whatever knows what people are talking about right now: a news
 * aggregator, a search-trends export, another product's ranking. The wiki reads it on a
 * timer and ranks its subjects on the board beside its own pages, so what the world is
 * asking about and nobody has written shows up as open ground.
 *
 * The feed is `GET <url>` answering `{ "topics": [{ "title", "heat", "what"?, "slug"?, "url"?, "detail"? }] }`.
 * `heat` is the feed's own measure, on the same scale as the wiki's: about one per mention.
 */
export function followFeed(
  source: { url: string; feed: string; everyMs: number },
  wiki: Wiki,
  onChange: () => void,
  fetcher: typeof fetch = fetch,
): { read: () => Promise<number>; stop: () => void } {
  const read = async (): Promise<number> => {
    const response = await fetcher(source.url, { headers: { accept: "application/json" }, signal: AbortSignal.timeout(15_000) });
    if (!response.ok) throw new Error(`${source.url} answered ${response.status}`);
    const body = (await response.json()) as { topics?: unknown };
    if (!Array.isArray(body.topics)) throw new Error(`${source.url} has no "topics" list`);
    const result = await wiki.putSignals(source.feed, body.topics as SignalInput[]);
    if (!result.ok) throw new Error(result.error);
    onChange();
    return result.value.kept;
  };
  const tick = (): void => {
    read().catch((error: unknown) => console.error(`signals: reading ${source.feed} failed:`, error instanceof Error ? error.message : error));
  };
  tick();
  const timer = setInterval(tick, source.everyMs);
  timer.unref();
  return { read, stop: () => clearInterval(timer) };
}
