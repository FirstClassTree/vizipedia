import { experienceDocument } from "../domain/experience.ts";

/**
 * The quality gate for code: before an experience or a figure is accepted, the wiki opens
 * it in a real headless browser, offline, and refuses it if it throws, logs an error, or
 * draws nothing. That catches the broken write, not the wrong one: whether the visual
 * says what the text says is still a reader's call, through flags.
 *
 * The browser is Playwright's Chromium when it is installed (`npx playwright install
 * chromium`); without it the gate is off and the server says so at boot.
 */

/**
 * What the check found: why a fragment does not render, in words an agent can act on (null when
 * it renders), and when it does, its poster: the first screen as the browser drew it, which cards,
 * link previews and the run gate show so no reader ever meets an empty tile.
 */
export interface Rendered {
  readonly trouble: string | null;
  readonly poster: Uint8Array | null;
}
export type Renderer = (fragment: string, kind: "experience" | "figure") => Promise<Rendered>;

export interface RenderCheck {
  readonly render: Renderer;
  /** Closes the browser. A server that holds one open never exits by itself. */
  close(): Promise<void>;
}

export const noRenderer: Renderer = async () => ({ trouble: null, poster: null });
/** The poster's size: the frame's width on a laptop, cropped to what fits a card. */
export const POSTER = { width: 900, minHeight: 300, maxHeight: 560 } as const;

interface Browser {
  isConnected(): boolean;
  close(): Promise<void>;
  newContext(options: { viewport: { width: number; height: number }; offline: boolean }): Promise<{
    newPage(): Promise<{
      on(event: "pageerror", handler: (error: Error) => void): void;
      on(event: "console", handler: (message: { type(): string; text(): string }) => void): void;
      route(url: string, handler: (route: { abort(): Promise<void> }) => void): Promise<void>;
      setContent(html: string, options: { waitUntil: "load"; timeout: number }): Promise<void>;
      screenshot(options: { type: "jpeg"; quality: number; clip: { x: number; y: number; width: number; height: number } }): Promise<Uint8Array>;
      waitForTimeout(ms: number): Promise<void>;
      evaluate<T>(fn: () => T): Promise<T>;
    }>;
    close(): Promise<void>;
  }>;
}

/** How long an experience gets to load and draw its first screen. */
const SETTLE_MS = 1200;
const LOAD_MS = 8000;
/** How long the page gets to answer what it drew; a loop that never yields fails here. */
const MEASURE_MS = 4000;
/** Renders in flight at once; the rest wait their turn, so a burst of writes cannot exhaust memory. */
const AT_ONCE = 2;

export async function browserRenderer(): Promise<RenderCheck | null> {
  let playwright: { chromium: { launch(options: { headless: boolean }): Promise<Browser> } };
  try {
    playwright = (await import("playwright")) as never;
  } catch {
    return null;
  }
  let browser: Promise<Browser> | null = null;
  const open = async (): Promise<Browser> => {
    const known = browser ? await browser.catch(() => null) : null;
    if (known?.isConnected()) return known;
    // A browser that crashed or was closed is replaced; the gate never stays down.
    browser = playwright.chromium.launch({ headless: true }).catch((error: unknown) => {
      browser = null;
      throw error;
    });
    return browser;
  };
  // A first launch at boot says early whether Chromium is really there.
  try {
    await open();
  } catch {
    return null;
  }
  let running = 0;
  const waiting: (() => void)[] = [];
  const turn = (): Promise<void> => {
    if (running < AT_ONCE) {
      running += 1;
      return Promise.resolve();
    }
    return new Promise((go) => {
      waiting.push(() => {
        running += 1;
        go();
      });
    });
  };
  const done = (): void => {
    running -= 1;
    waiting.shift()?.();
  };
  const render: Renderer = async (fragment, kind) => {
    await turn();
    try {
      return await renderOne(fragment, kind);
    } finally {
      done();
    }
  };
  const renderOne: Renderer = async (fragment, kind) => {
    let context: Awaited<ReturnType<Browser["newContext"]>>;
    try {
      context = await (await open()).newContext({ viewport: { width: POSTER.width, height: 700 }, offline: true });
    } catch (error) {
      // The gate itself is broken, not the write: say so in the log and let the write through unopened.
      console.error("render check: could not open a browser, accepting unopened:", error);
      return { trouble: null, poster: null };
    }
    try {
      const page = await context.newPage();
      const trouble: string[] = [];
      page.on("pageerror", (error) => trouble.push(`it throws: ${String(error.message ?? error).slice(0, 200)}`));
      page.on("console", (message) => {
        if (message.type() === "error") trouble.push(`it logs an error: ${message.text().slice(0, 200)}`);
      });
      // Nothing leaves: a fragment that tries to fetch is told no, as the real frame would.
      await page.route("**/*", (route) => route.abort());
      const shell = experienceDocument({ fragment, hue: 262, surface: "sheet", page: { slug: "check", title: "Check" }, data: null, still: kind === "figure" });
      try {
        await page.setContent(shell, { waitUntil: "load", timeout: LOAD_MS });
      } catch {
        return { trouble: "it did not finish loading within 8 seconds", poster: null };
      }
      await page.waitForTimeout(SETTLE_MS);
      if (trouble[0]) return { trouble: trouble[0], poster: null };
      const measure = page.evaluate(() => {
        const body = document.body;
        const box = body.getBoundingClientRect();
        return {
          height: Math.ceil(box.height),
          children: body.children.length,
          text: body.innerText.trim().length,
          pixels: body.querySelectorAll("svg, canvas, img, video").length,
        };
      });
      const late = new Promise<null>((resolve) => setTimeout(() => resolve(null), MEASURE_MS).unref?.());
      const drawn = await Promise.race([measure, late]);
      if (drawn === null) return { trouble: `it keeps the browser busy: ${MEASURE_MS / 1000} seconds after loading it still has not answered`, poster: null };
      if (drawn.children === 0 || drawn.height < 24 || (drawn.text === 0 && drawn.pixels === 0))
        return { trouble: "it draws nothing: the frame is empty after loading", poster: null };
      const height = Math.min(POSTER.maxHeight, Math.max(POSTER.minHeight, drawn.height));
      const poster = await page.screenshot({ type: "jpeg", quality: 82, clip: { x: 0, y: 0, width: POSTER.width, height } }).catch(() => null);
      return { trouble: null, poster };
    } finally {
      await context.close();
    }
  };
  return {
    render,
    close: async () => {
      const open = browser ? await browser.catch(() => null) : null;
      browser = null;
      await open?.close();
    },
  };
}
