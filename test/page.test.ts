import assert from "node:assert/strict";
import { test } from "node:test";
import { paintWord } from "../src/ui/page.ts";

test("a prose stroke is painted with its most striking number, never a day of the month", () => {
  assert.equal(paintWord("On 6 October 2026 OpenAI posted 372 results, about 4,000 problems in all.", "What happened"), "4,000");
  assert.equal(paintWord("Switching wins with probability 2/3 and staying 1/3.", "Why switching wins"), "2/3");
  assert.equal(paintWord("Steve Selvin first posed it in 1975 in a letter.", "The puzzle"), "1975");
  assert.equal(paintWord("On 29 September the group published 6 recommendations.", "What the critics asked for"), "critics");
  assert.equal(paintWord("Later looked at 18.1 million posts and found 20 hashtags best.", "What the studies say"), "18.1");
  assert.equal(paintWord("The 1985 paper and the 2018 reversal.", "The hot hand"), "1985");
  assert.equal(paintWord("Nothing numeric here at all.", "A short heading"), "short");
});
