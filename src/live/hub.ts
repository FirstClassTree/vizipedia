import type { Change } from "../store/wiki.ts";

/**
 * What lets a browser watch a page change. The event log is the only source: the hub reads
 * what is new on it and hands each event to whoever is listening. A write on this server
 * pokes it, so a listener here hears within milliseconds; a write on another server behind
 * the same database is heard on the next tick. Nothing is read while nobody listens.
 */

export type Listener = (change: Change) => void;

export interface HubOptions {
  /** How often to look for writes made elsewhere, while someone listens. */
  readonly everyMs?: number;
  /** Open streams this server will hold; past it a browser is told to poll instead. */
  readonly max?: number;
}

export class Hub {
  private readonly listeners = new Set<{ slug: string | null; hear: Listener }>();
  private readonly read: (after: number) => Promise<Change[]>;
  private readonly head: () => Promise<number>;
  private readonly everyMs: number;
  readonly max: number;
  private last: number | null = null;
  private timer: NodeJS.Timeout | null = null;
  private reading: Promise<void> | null = null;
  private again = false;

  constructor(read: (after: number) => Promise<Change[]>, head: () => Promise<number>, options: HubOptions = {}) {
    this.read = read;
    this.head = head;
    this.everyMs = options.everyMs ?? 1500;
    this.max = options.max ?? 2000;
  }

  get size(): number {
    return this.listeners.size;
  }

  get full(): boolean {
    return this.listeners.size >= this.max;
  }

  /** Hear every change, or only one page's. Returns the way to stop. */
  subscribe(slug: string | null, hear: Listener): () => void {
    const entry = { slug, hear };
    this.listeners.add(entry);
    if (!this.timer) {
      this.timer = setInterval(() => this.poke(), this.everyMs);
      this.timer.unref();
    }
    // The first listener fixes where "now" is on the log, before anything can be missed.
    this.poke();
    return () => {
      this.listeners.delete(entry);
      if (this.listeners.size === 0 && this.timer) {
        clearInterval(this.timer);
        this.timer = null;
        // Nobody is listening, so nothing needs replaying: the next listener starts from now.
        this.last = null;
      }
    };
  }

  /** Something was written: read the log now. Safe to call from anywhere, any number of times. */
  poke(): void {
    if (this.listeners.size === 0) return;
    if (this.reading) {
      this.again = true;
      return;
    }
    this.reading = this.drain()
      .catch((error: unknown) => console.error("live: reading the log failed:", error))
      .finally(() => {
        this.reading = null;
        if (this.again) {
          this.again = false;
          this.poke();
        }
      });
  }

  /** Resolves once the log has been read up to now. For tests and for a clean shutdown. */
  async settled(): Promise<void> {
    this.poke();
    while (this.reading) await this.reading;
  }

  private async drain(): Promise<void> {
    if (this.last === null) {
      this.last = await this.head();
      return;
    }
    const changes = await this.read(this.last);
    for (const change of changes) {
      this.last = Math.max(this.last, change.id);
      for (const listener of this.listeners) {
        if (listener.slug !== null && listener.slug !== change.slug) continue;
        try {
          listener.hear(change);
        } catch (error) {
          console.error("live: a listener threw:", error);
        }
      }
    }
  }
}
