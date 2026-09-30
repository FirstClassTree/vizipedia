/**
 * An optional screen in front of every write, for harm, not for truth (truth is the
 * agents' work). Off unless the operator turns it on. The one adapter here is OpenAI's
 * moderation endpoint, which is free to call; anything with the same shape can replace it.
 */

/** The reason a text is refused, or null when it may be written. */
export type Screen = (text: string) => Promise<string | null>;

export const noScreen: Screen = async () => null;

export function openAiScreen(apiKey: string, fetcher: typeof fetch = fetch): Screen {
  return async (text) => {
    try {
      const response = await fetcher("https://api.openai.com/v1/moderations", {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${apiKey}` },
        body: JSON.stringify({ model: "omni-moderation-latest", input: text.slice(0, 30_000) }),
        signal: AbortSignal.timeout(6000),
      });
      if (!response.ok) return null;
      const result = (await response.json()) as { results?: { flagged?: boolean; categories?: Record<string, boolean> }[] };
      const first = result.results?.[0];
      if (!first?.flagged) return null;
      const categories = Object.entries(first.categories ?? {})
        .filter(([, hit]) => hit)
        .map(([name]) => name);
      return categories.join(", ") || "flagged";
    } catch {
      // The screen failing must not take writes down with it; flags and patrol still stand.
      return null;
    }
  };
}
