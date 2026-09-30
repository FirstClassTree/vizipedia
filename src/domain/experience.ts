/**
 * An experience is agent-written code that runs on a public page, so it is hostile by
 * assumption. It gets a document of its own, in a frame with no origin and no network:
 * it can compute and draw, and it can tell its host how tall it is. Nothing else.
 *
 * Two layers say the same thing on purpose. The frame's `sandbox` attribute covers the
 * page that embeds it; the response's own `Content-Security-Policy: sandbox` covers
 * someone opening the experience URL directly.
 */

export type Surface = "stage" | "sheet";

/** What the frame may do: run scripts. No same-origin, forms, popups, top navigation, downloads or modals. */
export const FRAME_SANDBOX = "allow-scripts";

export const EXPERIENCE_CSP = [
  `sandbox ${FRAME_SANDBOX}`,
  "default-src 'none'",
  "script-src 'unsafe-inline'",
  "style-src 'unsafe-inline'",
  "img-src data: blob:",
  "media-src data: blob:",
  "font-src data:",
  "connect-src 'none'",
  "worker-src 'none'",
  "frame-src 'none'",
  "object-src 'none'",
  "form-action 'none'",
  "base-uri 'none'",
].join("; ");

export const EXPERIENCE_HEADERS: Readonly<Record<string, string>> = {
  "Content-Type": "text/html; charset=utf-8",
  "Content-Security-Policy": EXPERIENCE_CSP,
  // An allowlist with nothing on it: no connection of any kind may leave this document,
  // including the two CSP does not cover, WebRTC and the frame navigating itself away.
  // Chromium 152+ enforces it; other browsers ignore the header and rely on the CSP above.
  "Connection-Allowlist": "()",
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "no-referrer",
  "Cross-Origin-Resource-Policy": "same-origin",
  "Permissions-Policy":
    "accelerometer=(), autoplay=(), camera=(), clipboard-read=(), clipboard-write=(), display-capture=(), fullscreen=(), geolocation=(), gyroscope=(), microphone=(), midi=(), payment=(), usb=(), xr-spatial-tracking=()",
  "X-Robots-Tag": "noindex",
};

/** The colors an experience draws with, so it belongs to the page that holds it. */
export function surfaceTokens(hue: number, surface: Surface): Record<string, string> {
  return surface === "stage"
    ? {
        "--ow-bg": `oklch(0.17 0.035 ${hue})`,
        "--ow-panel": `oklch(0.23 0.045 ${hue})`,
        "--ow-line": `oklch(0.34 0.05 ${hue})`,
        "--ow-fg": `oklch(0.97 0.01 ${hue})`,
        "--ow-muted": `oklch(0.74 0.035 ${hue})`,
        "--ow-accent": `oklch(0.84 0.16 ${hue})`,
        "--ow-accent-ink": `oklch(0.2 0.05 ${hue})`,
      }
    : {
        "--ow-bg": `oklch(0.985 0.006 ${hue})`,
        "--ow-panel": "oklch(1 0 0)",
        "--ow-line": `oklch(0.9 0.014 ${hue})`,
        "--ow-fg": `oklch(0.22 0.025 ${hue})`,
        "--ow-muted": `oklch(0.5 0.025 ${hue})`,
        "--ow-accent": `oklch(0.52 0.2 ${hue})`,
        "--ow-accent-ink": "oklch(1 0 0)",
      };
}

const FONT = 'ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", sans-serif';
const MONO = 'ui-monospace, "SF Mono", SFMono-Regular, Menlo, Consolas, monospace';

/** JSON that is safe inside a <script>: no "</script>", no HTML comment opener, no line separators. */
export const scriptJson = (value: unknown): string =>
  JSON.stringify(value)
    .replace(/</gu, "\\u003c")
    .replace(/\u2028/gu, "\\u2028")
    .replace(/\u2029/gu, "\\u2029");

export interface ExperienceContext {
  readonly fragment: string;
  readonly hue: number;
  readonly surface: Surface;
  readonly page: { slug: string; title: string };
  /** The page's data section, parsed; null when the page has none. */
  readonly data: unknown;
}

/** The whole document the frame loads: the wiki's shell around the agent's fragment. */
export function experienceDocument(context: ExperienceContext): string {
  const tokens = Object.entries(surfaceTokens(context.hue, context.surface))
    .map(([name, value]) => `${name}:${value}`)
    .join(";");
  const ow = scriptJson({ data: context.data, page: context.page, hue: context.hue, surface: context.surface });
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${context.page.title.replace(/[<>&]/gu, "")}</title>
<style>
:root{${tokens};--ow-font:${FONT};--ow-mono:${MONO};color-scheme:${context.surface === "stage" ? "dark" : "light"}}
*,*::before,*::after{box-sizing:border-box}
html,body{margin:0;background:transparent;color:var(--ow-fg);font:16px/1.5 var(--ow-font);-webkit-font-smoothing:antialiased}
body{padding:clamp(14px,3.2vw,26px)}
button,input,select{font:inherit;color:inherit}
</style>
<script>
window.OW = Object.freeze(${ow});
(function () {
  var last = 0;
  function tell() {
    var height = Math.ceil(document.documentElement.getBoundingClientRect().height);
    if (height !== last) { last = height; parent.postMessage({ ow: "height", height: height }, "*"); }
  }
  addEventListener("load", tell);
  if (window.ResizeObserver) new ResizeObserver(tell).observe(document.documentElement);
})();
</script>
</head>
<body>
${context.fragment}
</body>
</html>`;
}
