// The display budget for every <title> and meta description the wiki serves. Google cuts a title
// by pixel width, roughly 60 to 65 characters on desktop, and a description near 160; past that
// the reader sees a word cut in half. Every view's title and description goes through here
// (layout.ts), so no page can serve one over budget.

export const TITLE_MAX = 65;
export const DESCRIPTION_MIN = 70;
export const DESCRIPTION_MAX = 160;

/**
 * A required part is a string; an optional part carries a drop rank (1 goes first). Parts are
 * joined as written, so each carries its own separator (": interactive visualization", " · Wiki").
 */
export type TitlePart = string | { readonly text: string; readonly drop: number };

// A cut must not end on a word that promises more ("Notes on the history of").
const DANGLING = new Set([
  "a",
  "an",
  "and",
  "as",
  "at",
  "by",
  "for",
  "from",
  "in",
  "into",
  "of",
  "on",
  "or",
  "the",
  "to",
  "vs",
  "with",
  "without",
  "&",
  "-",
  "–",
  "—",
  "+",
  "your",
  "its",
  "their",
]);

const tidyTail = (text: string): string => {
  let out = text.trim();
  for (;;) {
    const before = out;
    out = out.replace(/[\s,:;.\-–—/(+&·]+$/u, "");
    const words = out.split(/\s+/u);
    if (words.length > 1 && DANGLING.has(words.at(-1)?.toLowerCase() ?? "")) out = words.slice(0, -1).join(" ");
    // an opened bracket the cut left unclosed goes with what it opened
    const open = out.lastIndexOf("(");
    if (open > out.lastIndexOf(")")) out = out.slice(0, open);
    if (out === before) return out;
  }
};

/** Cut at the last whole word that fits, then drop a dangling tail. Never mid-word. */
export const trimToWords = (text: string, max: number): string => {
  if (text.length <= max) return text;
  const cut = text.slice(0, max + 1);
  const space = cut.lastIndexOf(" ");
  return tidyTail(space > 0 ? cut.slice(0, space) : text.slice(0, max));
};

const textOf = (part: TitlePart): string => (typeof part === "string" ? part : part.text);

/**
 * Fit a title: drop optional parts, lowest rank first, until it fits, then trim what is left at
 * a word. The required parts are the words that answer the query, so they lead and they stay.
 */
export const fitTitle = (parts: readonly TitlePart[], max: number = TITLE_MAX): string => {
  const kept = [...parts];
  const join = () => kept.map(textOf).join("").replace(/\s+/gu, " ").trim();
  const ranks = parts.flatMap((part) => (typeof part === "string" ? [] : [part.drop])).sort((a, b) => a - b);
  for (const rank of ranks) {
    if (join().length <= max) break;
    const index = kept.findIndex((part) => typeof part !== "string" && part.drop === rank);
    if (index >= 0) kept.splice(index, 1);
  }
  return trimToWords(join(), max);
};

/**
 * Fit a description: keep whole sentences while they fit and reach the minimum, else end on a
 * whole clause, else on a whole word, and mark the cut with an ellipsis.
 */
export const fitDescription = (text: string, max: number = DESCRIPTION_MAX): string => {
  const clean = text
    .replace(/\s+/gu, " ")
    .replace(/\.{2,}/gu, ".")
    .trim();
  if (clean.length <= max) return clean;
  // a sentence ends at . ! or ? followed by a space and a capital or a digit
  const ends = [...clean.matchAll(/[.!?](?=\s+[A-Z0-9"“$])/gu)].map((match) => (match.index ?? 0) + 1);
  const sentence = ends.filter((end) => end <= max).at(-1);
  if (sentence && sentence >= DESCRIPTION_MIN) return clean.slice(0, sentence);
  // a clause ending reads as a pause rather than a cut word
  const clauses = [...clean.slice(0, max).matchAll(/[,;:](?=\s)|\s[-–—](?=\s)/gu)].map((match) => match.index ?? 0);
  const clause = clauses.filter((end) => end >= DESCRIPTION_MIN).at(-1);
  if (clause) return `${tidyTail(clean.slice(0, clause))}…`;
  return `${trimToWords(clean, max - 1)}…`;
};
