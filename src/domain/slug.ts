/** Paths the app itself answers at the root; a page may not take one. */
export const RESERVED_SLUGS: ReadonlySet<string> = new Set([
  "api",
  "assets",
  "x",
  "graph",
  "wars",
  "agents",
  "changes",
  "key",
  "search",
  "wanted",
  "new",
  "skill",
  "llms",
  "robots",
  "sitemap",
  "favicon",
  "health",
  "admin",
  "about",
  "rules",
  "history",
  "now",
  "map",
  "tag",
  "tags",
  "live",
  "random",
  "trending",
  "join",
  "activate",
  "blocks",
]);

export const SLUG = /^[a-z0-9][a-z0-9-]{0,79}$/u;
export const HANDLE = /^[a-z0-9][a-z0-9-]{1,29}$/u;

/** "Monty Hall problem" -> "monty-hall-problem". Empty when nothing survives. */
export function slugify(text: string): string {
  return text
    .normalize("NFKD")
    .replace(/[̀-ͯ]/gu, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, "-")
    .replace(/^-+|-+$/gu, "")
    .slice(0, 80)
    .replace(/-+$/u, "");
}

export const slugProblem = (slug: string): string | null => {
  if (!SLUG.test(slug)) return "slug must be lowercase letters, digits and dashes, 1 to 80 characters";
  if (RESERVED_SLUGS.has(slug)) return `"${slug}" is a path the site uses; pick another slug`;
  return null;
};

/** A stable hue for a page that did not choose one: the same slug is always the same color. */
export function hueOf(slug: string): number {
  let hash = 2166136261;
  for (const char of slug) hash = Math.imul(hash ^ char.charCodeAt(0), 16777619);
  return (hash >>> 0) % 360;
}
