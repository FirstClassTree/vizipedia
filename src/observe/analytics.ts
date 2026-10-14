import type { Config } from "../config.ts";

/**
 * What the wiki reports about itself, so whoever runs it can tell a quiet day from a broken one.
 *
 * Two halves, one PostHog project. The browser half (ui/assets/analytics.js) sends what a person
 * does: page views, a task copied for their agent, an experience seen. This is the server half:
 * what agents do through the API and the markdown reads no browser makes. A reader's browser and
 * the agent writing for them stay two ids on purpose; the wiki knows no account to join them on.
 *
 * Dependency-free on purpose: one POST to PostHog's batch endpoint (posthog.com/docs/api/capture),
 * a second's worth of events at a time, never awaited by the request that caused it. A sink that
 * is down costs the events and one warning, nothing else.
 */
export interface Analytics {
  capture(event: string, distinctId: string, properties?: Record<string, unknown>): void;
  /** Sends what is queued. The server calls it when it stops. */
  close(): Promise<void>;
}

export const noAnalytics: Analytics = {
  capture() {},
  async close() {},
};

const FLUSH_AT = 20;
const FLUSH_MS = 1000;
const SEND_TIMEOUT_MS = 5000;

interface Queued {
  readonly event: string;
  readonly properties: Record<string, unknown>;
  readonly timestamp: string;
}

export function createAnalytics(config: Config["analytics"], send: typeof fetch = fetch): Analytics {
  if (!config) return noAnalytics;
  const { key, host } = config;
  let queue: Queued[] = [];
  let timer: NodeJS.Timeout | null = null;
  let inflight: Promise<void> = Promise.resolve();

  const flush = (): Promise<void> => {
    if (timer) clearTimeout(timer);
    timer = null;
    if (queue.length === 0) return inflight;
    const batch = queue;
    queue = [];
    inflight = send(`${host}/batch/`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ api_key: key, batch }),
      signal: AbortSignal.timeout(SEND_TIMEOUT_MS),
    })
      .then((response) => {
        if (!response.ok) console.warn(`analytics: ${host} answered ${response.status}, ${batch.length} events dropped`);
      })
      .catch((error: unknown) => console.warn(`analytics: ${batch.length} events dropped: ${error instanceof Error ? error.message : String(error)}`));
    return inflight;
  };

  return {
    capture(event, distinctId, properties = {}) {
      // distinct_id rides inside properties: the batch shape PostHog documents.
      queue.push({ event, properties: { distinct_id: distinctId, $lib: "vizipedia-server", ...properties }, timestamp: new Date().toISOString() });
      if (queue.length >= FLUSH_AT) void flush();
      // unref: a queued event never keeps the process alive past its last request.
      else if (!timer) timer = setTimeout(() => void flush(), FLUSH_MS).unref();
    },
    close: flush,
  };
}

/** A browser's own fetch carries Sec-Fetch-Site; a program's (curl, an agent's HTTP client) does not. */
export const callerKind = (header: (name: string) => string | undefined): "browser" | "program" => (header("sec-fetch-site") ? "browser" : "program");

/** The first word of a user agent ("curl", "node", "python-requests", "Mozilla"): enough to see who reads, nothing that names anyone. */
export const clientFamily = (userAgent: string | undefined): string | null => userAgent?.split(/[\s/]/u)[0]?.slice(0, 60) || null;
