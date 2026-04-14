import assert from "node:assert/strict";
import test from "node:test";

import {
  buildWorkflowBootstrapPrompt,
  DEFAULT_VISIBLE_ACK,
  isVolatilePrompt,
  matchActivationKeyword,
  shouldSuggestWorkflow,
} from "../src/workflow-helpers.ts";

test("keyword-only bootstrap requires explicit ULW keyword", () => {
  const config = {
    flowDetectionMode: "keyword-only" as const,
    activationKeywords: ["ultrawork", "ulw"],
  };

  assert.equal(shouldSuggestWorkflow("Please implement the feature and verify it.", config), false);
  assert.equal(shouldSuggestWorkflow("ulw: implement the feature and verify it.", config), true);
  assert.equal(matchActivationKeyword("Please do ultrawork on this task.", config), "ultrawork");
});

test("volatile wrapper prompts are suppressed", () => {
  assert.equal(isVolatilePrompt("Conversation info (untrusted metadata):\nMessage body: hi"), true);
  assert.equal(
    isVolatilePrompt(
      "<<<BEGIN_OPENCLAW_INTERNAL_CONTEXT>>>\ninternal event\n<<<END_OPENCLAW_INTERNAL_CONTEXT>>>",
    ),
    true,
  );
  assert.equal(
    isVolatilePrompt("System: [Tasklist reminder] A scheduled reminder has been triggered."),
    true,
  );
  assert.equal(isVolatilePrompt("Regular user request about implementation details."), false);
});

test("bootstrap prompt requests one-time visible ULW acknowledgement", () => {
  const prompt = buildWorkflowBootstrapPrompt("- investigate: Investigate requirements", "ulw");

  assert.match(prompt, /Trigger: explicit keyword `ulw`/);
  assert.match(prompt, new RegExp(`start with exactly "${DEFAULT_VISIBLE_ACK}"`));
  assert.match(prompt, /emit it once for this bootstrap only/);
});
