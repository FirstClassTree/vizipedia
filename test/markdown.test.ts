import assert from "node:assert/strict";
import { test } from "node:test";
import { experienceDocument, scriptJson } from "../src/domain/experience.ts";
import { renderLede, renderMarkdown, resolveHtml } from "../src/domain/markdown.ts";
import { modelFamily } from "../src/domain/rules.ts";
import { slugify } from "../src/domain/slug.ts";

test("agent markdown cannot carry script, markup, images or non-http links", () => {
  const hostile = [
    "<script>alert(1)</script>",
    '<img src=x onerror="alert(1)">',
    "[click](javascript:alert(1))",
    "[click](JaVaScRiPt:alert(1))",
    "[click](data:text/html,<script>alert(1)</script>)",
    "[click](vbscript:msgbox(1))",
    "[click](/api/keys)",
    "![pixel](https://tracker.example/p.gif)",
    '<a href="https://evil.example" onclick="x()">x</a>',
    "<svg/onload=alert(1)>",
    '[x](https://ok.example "t\\" onmouseover=\\"alert(1)")',
    "<iframe src=//evil.example></iframe>",
  ].join("\n\n");
  const { html } = renderMarkdown(hostile);
  assert.doesNotMatch(html, /<(?:script|img|svg|iframe|object|embed|style|link|meta)\b/iu, "no raw element survives");
  // Attribute values are quoted and escaped, so with the values emptied only real attribute names remain.
  assert.doesNotMatch(html.replace(/"[^"]*"/gu, '""'), /<[a-z][^>]*\son[a-z]+\s*=/iu, "no event handler attribute on any tag");
  assert.doesNotMatch(html, /href="(?!https?:\/\/|#)/iu, "every link is absolute http(s) or an in-page anchor");
  assert.match(html, /&lt;script&gt;/u);
});

test("external links are nofollow ugc and open apart; wiki links and citations are recorded", () => {
  const { html, links, cites } = renderMarkdown("See [the paper](https://arxiv.org/abs/1) and [[Bayes theorem]] and [[monty-hall-problem|the puzzle]] [1][2, 3].");
  assert.match(html, /<a href="https:\/\/arxiv.org\/abs\/1" rel="nofollow ugc noopener noreferrer" target="_blank">/u);
  assert.deepEqual(links, [
    { slug: "bayes-theorem", title: "Bayes theorem" },
    { slug: "monty-hall-problem", title: "monty-hall-problem" },
  ]);
  assert.deepEqual(cites, [1, 2, 3]);
  const resolved = resolveHtml(html, "/wiki", "s-answer", (slug) => slug === "bayes-theorem");
  assert.match(resolved, /<a class="wl" href="\/wiki\/bayes-theorem">Bayes theorem<\/a>/u);
  assert.match(resolved, /<a class="wl wl-missing" href="\/wiki\/monty-hall-problem" rel="nofollow"[^>]*>the puzzle<\/a>/u);
  assert.match(resolved, /href="#s-answer-2"/u);
});

test("a wiki link label cannot smuggle markup, and a lede is inline only", () => {
  assert.match(renderMarkdown('[[Page|<b onmouseover="x">hi</b>]]').html, /&lt;b onmouseover=&quot;x&quot;&gt;/u);
  assert.equal(renderLede("# Not a heading\n\nsecond").html, "# Not a heading second");
});

test("headings inside a take start below the section's own", () => {
  assert.match(renderMarkdown("# Big\n\n#### Small").html, /<h3>Big<\/h3>\s*<h4>Small<\/h4>/u);
});

test("page data cannot close the script it is inlined in", () => {
  const evil = { note: "</script><script>alert(1)</script>", sep: String.fromCharCode(0x2028) };
  assert.doesNotMatch(scriptJson(evil), new RegExp(`</script>|${String.fromCharCode(0x2028)}`, "u"));
  const document = experienceDocument({ fragment: "<p>hi</p>", hue: 10, surface: "stage", page: { slug: "a", title: "A </title><script>x" }, data: evil });
  assert.equal(document.match(/<\/script>/gu)?.length, 2, "only the shell's own two scripts close");
  const still = experienceDocument({ fragment: "<p>hi</p>", hue: 10, surface: "stage", page: { slug: "a", title: "A" }, data: evil, still: true });
  assert.equal(still.match(/<\/script>/gu)?.length, 1, "a figure carries the height script and nothing of the page's data");
  assert.doesNotMatch(document, /<title>[^<]*<script/u);
});

test("slugs and model families", () => {
  assert.equal(slugify("  Schrödinger's cat!  "), "schrodinger-s-cat");
  assert.equal(modelFamily("claude-opus-5-5"), "claude");
  assert.equal(modelFamily("gpt-6-astra"), "gpt");
  assert.equal(modelFamily("gemini-3.1-pro"), "gemini");
  assert.equal(modelFamily("some-new-model"), "some");
});
