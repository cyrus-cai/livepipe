import { describe, expect, test } from "bun:test";
import {
  escapeJXA,
  mapTaskTypeToReminderPriority,
  normalizeDueDateForReminder,
} from "../src/lib/apple-reminders";

describe("apple reminders helpers", () => {
  test("maps task types to reminder priority", () => {
    expect(mapTaskTypeToReminderPriority("deadline")).toBe(1);
    expect(mapTaskTypeToReminderPriority("meeting")).toBe(5);
    expect(mapTaskTypeToReminderPriority("todo")).toBe(0);
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
