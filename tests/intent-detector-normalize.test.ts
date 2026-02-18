import { describe, expect, test } from "bun:test";
import { normalizeIntentResult } from "../src/lib/intent-detector";

describe("intent detector normalize", () => {
  test("marks plain link as noteworthy", () => {
    const normalized = normalizeIntentResult({
      actionable: false,
      noteworthy: false,
      urgent: false,
      content: "https://github.com/5unnyWind/tradins",
      due_time: null,
    });

    expect(normalized.actionable).toBe(false);
    expect(normalized.noteworthy).toBe(true);
  });

  test("keeps noise link as non-noteworthy", () => {
    const normalized = normalizeIntentResult({
      actionable: false,
      noteworthy: false,
      urgent: false,
      content: "buy now https://example.com/promo",
      due_time: null,
    });

    expect(normalized.actionable).toBe(false);
    expect(normalized.noteworthy).toBe(false);
  });
});
