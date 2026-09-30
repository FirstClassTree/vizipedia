import assert from "node:assert/strict";
import { test } from "node:test";
import { comparable, fetchable, isPublicAddress, quoteChecker, quoteIsIn } from "../src/verify/quotes.ts";

test("only public addresses are fetchable: no loopback, private ranges, metadata, odd ports or credentials", () => {
  for (const address of [
    "127.0.0.1",
    "10.1.2.3",
    "172.16.0.9",
    "192.168.1.1",
    "169.254.169.254",
    "100.64.0.1",
    "0.0.0.0",
    "::1",
    "fe80::1",
    "fc00::1",
    "::ffff:127.0.0.1",
    "::ffff:10.0.0.1",
    "not-an-ip",
  ]) {
    assert.equal(isPublicAddress(address), false, address);
  }
  for (const address of ["93.184.216.34", "8.8.8.8", "2606:4700:4700::1111"]) assert.equal(isPublicAddress(address), true, address);
  for (const url of [
    "http://127.0.0.1/",
    "http://[::1]/",
    "http://169.254.169.254/latest/meta-data",
    "http://localhost/",
    "http://db.internal/",
    "https://example.org:8443/",
    "https://user:pw@example.org/",
    "ftp://example.org/",
    "file:///etc/passwd",
    "http://printer.local/",
  ]) {
    assert.equal(fetchable(url), null, url);
  }
  assert.equal(fetchable("https://en.wikipedia.org/wiki/Monty_Hall_problem")?.hostname, "en.wikipedia.org");
});

test("a quote is found through markup, entities, curly quotes, dashes and footnote marks", () => {
  const page = `<html><head><style>p{}</style><script>var x = "switching wins";</script></head><body>
    <p>The <b>contestant</b> should&nbsp;switch: it&rsquo;s a &ldquo;2/3&rdquo; chance<sup>[4]</sup> of winning &mdash; not one half.</p></body></html>`;
  assert.equal(quoteIsIn('The contestant should switch: it\'s a "2/3" chance of winning - not one half.', page), true);
  assert.equal(quoteIsIn("the contestant should stay with the first door", page), false);
  assert.equal(quoteIsIn('var x = "switching wins"', page), false, "script text is not the page");
  assert.equal(quoteIsIn("too short", page), false);
  assert.equal(comparable("A  B\n\nC"), "a b c");
});

test("the checker reports found, missing, unreachable and unchecked, fetching each URL once", async () => {
  let reads = 0;
  const check = quoteChecker({
    agent: "test",
    read: async (url) => {
      reads += 1;
      if (url.includes("down")) throw new Error("timeout");
      if (url.includes("pdf")) return null;
      return "<p>Switching doors wins two thirds of the time under the standard assumptions.</p>";
    },
  });
  const checked = await check([
    { url: "https://a.example/page", quote: "wins two thirds of the time under the standard" },
    { url: "https://a.example/page", quote: "staying is just as good as switching here" },
    { url: "https://a.example/down", quote: "wins two thirds of the time under the standard" },
    { url: "https://a.example/paper.pdf", quote: "wins two thirds of the time under the standard" },
    { url: "https://a.example/other" },
  ]);
  assert.deepEqual(
    checked.map((source) => source.check),
    ["found", "missing", "unreachable", "unreachable", "unchecked"],
  );
  assert.equal(reads, 3);
});

test("a quote not found in a page that was too large to read whole is unreadable, not missing", async () => {
  const check = quoteChecker({
    agent: "test",
    read: async () => ({ text: "<p>Only the first part of a very long page was read by the wiki here.</p>", whole: false }),
  });
  const checked = await check([
    { url: "https://a.example/huge", quote: "the first part of a very long page was read" },
    { url: "https://a.example/huge", quote: "words that sit far beyond what was read of it" },
  ]);
  assert.deepEqual(
    checked.map((source) => source.check),
    ["found", "unreachable"],
  );
});
