import { describe, expect, test } from "bun:test";
import { parsePipeConfigTextOrThrow } from "../src/lib/pipe-config";

describe("pipe config reminders", () => {
  test("defaults reminders config when field is missing", () => {
    const parsed = parsePipeConfigTextOrThrow("{}");

    expect(parsed.reminders.enabled).toBe(false);
    expect(parsed.reminders.list).toBe("LivePipe");
  });

  test("accepts custom reminders config", () => {
    const parsed = parsePipeConfigTextOrThrow(
      JSON.stringify({
        reminders: {
          enabled: true,
          list: "Work Tasks",
        },
      })
    );

    expect(parsed.reminders.enabled).toBe(true);
    expect(parsed.reminders.list).toBe("Work Tasks");
  });

  test("rejects empty reminders list", () => {
    expect(() =>
      parsePipeConfigTextOrThrow(
        JSON.stringify({
          reminders: {
            enabled: true,
            list: "   ",
          },
        })
      )
    ).toThrow();
  });
});
