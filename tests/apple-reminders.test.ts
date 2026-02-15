import { describe, expect, test } from "bun:test";
import {
  escapeJXA,
  mapUrgencyToReminderPriority,
  normalizeDueDateForReminder,
} from "../src/lib/apple-reminders";

describe("apple reminders helpers", () => {
  test("maps urgency to reminder priority", () => {
    expect(mapUrgencyToReminderPriority(true)).toBe(1);
    expect(mapUrgencyToReminderPriority(false)).toBe(0);
  });

  test("normalizes due date only when parseable", () => {
    expect(normalizeDueDateForReminder(null)).toBeUndefined();
    expect(normalizeDueDateForReminder("not-a-date")).toBeUndefined();

    const normalized = normalizeDueDateForReminder("2026-02-13T15:30");
    expect(normalized).toBeDefined();
    expect(Number.isNaN(new Date(normalized!).getTime())).toBe(false);
  });

  test("escapes quotes and control chars for JXA string literals", () => {
    const escaped = escapeJXA('line1 "quoted"\nline2\\');
    expect(escaped).toContain('\\"quoted\\"');
    expect(escaped).toContain("\\n");
    expect(escaped).toContain("\\\\");
  });
});
