import { describe, expect, test } from "bun:test";
import { parsePipeConfigTextOrThrow } from "../src/lib/pipe-config";

const REQUIRED_CAPTURE_CONFIG = {
  capture: {
    pollIntervalMs: 12000,
    lookbackMs: 24000,
    timestampSkewToleranceMs: 2000,
  },
};

function parseWithRequiredCapture(overrides: Record<string, unknown>) {
  return parsePipeConfigTextOrThrow(
    JSON.stringify({
      ...REQUIRED_CAPTURE_CONFIG,
      ...overrides,
    })
  );
}

describe("pipe config reminders", () => {
  test("defaults reminders/notes/dedup config when fields are missing", () => {
    const parsed = parseWithRequiredCapture({});

    expect(parsed.reminders.enabled).toBe(false);
    expect(parsed.reminders.list).toBe("LivePipe");
    expect(parsed.notes.enabled).toBe(false);
    expect(parsed.notes.folder).toBe("LivePipe");
    expect(parsed.dedup.actionableThreshold).toBe(0.6);
    expect(parsed.dedup.noteworthyThreshold).toBe(0.8);
    expect(parsed.dedup.lookbackDays).toBe(7);
    expect(parsed.clipboard.enabled).toBe(false);
    expect(parsed.clipboard.pollIntervalMs).toBe(3000);
    expect(parsed.clipboard.minTextLength).toBe(10);
  });

  test("accepts custom reminders config", () => {
    const parsed = parseWithRequiredCapture({
      reminders: {
        enabled: true,
        list: "Work Tasks",
      },
    });

    expect(parsed.reminders.enabled).toBe(true);
    expect(parsed.reminders.list).toBe("Work Tasks");
  });

  test("rejects empty reminders list", () => {
    expect(() =>
      parseWithRequiredCapture({
        reminders: {
          enabled: true,
          list: "   ",
        },
      })
    ).toThrow();
  });

  test("accepts custom notes and dedup config", () => {
    const parsed = parseWithRequiredCapture({
      notes: {
        enabled: true,
        folder: "Capture Inbox",
      },
      dedup: {
        actionableThreshold: 0.55,
        noteworthyThreshold: 0.85,
        lookbackDays: 14,
      },
    });

    expect(parsed.notes.enabled).toBe(true);
    expect(parsed.notes.folder).toBe("Capture Inbox");
    expect(parsed.dedup.actionableThreshold).toBe(0.55);
    expect(parsed.dedup.noteworthyThreshold).toBe(0.85);
    expect(parsed.dedup.lookbackDays).toBe(14);
  });

  test("accepts custom clipboard config", () => {
    const parsed = parseWithRequiredCapture({
      clipboard: {
        enabled: true,
        pollIntervalMs: 5000,
        minTextLength: 20,
      },
    });

    expect(parsed.clipboard.enabled).toBe(true);
    expect(parsed.clipboard.pollIntervalMs).toBe(5000);
    expect(parsed.clipboard.minTextLength).toBe(20);
  });
});
