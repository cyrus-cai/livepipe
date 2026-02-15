import { describe, expect, test } from "bun:test";
import { parsePipeConfigTextOrThrow } from "../src/lib/pipe-config";

describe("pipe config reminders", () => {
  test("defaults reminders/notes/dedup config when fields are missing", () => {
    const parsed = parsePipeConfigTextOrThrow("{}");

    expect(parsed.reminders.enabled).toBe(false);
    expect(parsed.reminders.list).toBe("LivePipe");
    expect(parsed.notes.enabled).toBe(false);
    expect(parsed.notes.folder).toBe("LivePipe");
    expect(parsed.dedup.actionableThreshold).toBe(0.6);
    expect(parsed.dedup.noteworthyThreshold).toBe(0.8);
    expect(parsed.dedup.lookbackDays).toBe(7);
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

  test("accepts custom notes and dedup config", () => {
    const parsed = parsePipeConfigTextOrThrow(
      JSON.stringify({
        notes: {
          enabled: true,
          folder: "Capture Inbox",
        },
        dedup: {
          actionableThreshold: 0.55,
          noteworthyThreshold: 0.85,
          lookbackDays: 14,
        },
      })
    );

    expect(parsed.notes.enabled).toBe(true);
    expect(parsed.notes.folder).toBe("Capture Inbox");
    expect(parsed.dedup.actionableThreshold).toBe(0.55);
    expect(parsed.dedup.noteworthyThreshold).toBe(0.85);
    expect(parsed.dedup.lookbackDays).toBe(14);
  });
});
