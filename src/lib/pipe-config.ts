import { existsSync, readFileSync, watchFile } from "fs";
import { join } from "path";
import { z } from "zod";

export const PIPE_CONFIG_FILE = join(process.cwd(), "pipe.json");

export type CaptureMode = "always" | "hotkey" | "both";
export type WebhookProvider = "generic" | "feishu" | "telegram";

export interface FilterConfig {
  allowedApps: string[];
  blockedWindows: string[];
  minTextLength: number;
}

export interface CaptureConfig {
  mode: CaptureMode;
  hotkeyHoldMs: number;
}

export interface ReviewConfig {
  enabled: boolean;
  provider: string;
  model: string;
  apiKey: string;
  failOpen: boolean;
}

export interface WebhookConfig {
  url: string;
  enabled: boolean;
  provider: WebhookProvider;
  headers?: Record<string, string>;
  chatId?: string;
}

export interface NotificationConfig {
  desktop: boolean;
  webhooks: WebhookConfig[];
}

export interface RemindersConfig {
  enabled: boolean;
  list: string;
}

export interface NotesConfig {
  enabled: boolean;
  folder: string;
}

export interface DedupConfig {
  actionableThreshold: number;
  noteworthyThreshold: number;
  lookbackDays: number;
}

export interface PipeConfig {
  filter: FilterConfig;
  capture: CaptureConfig;
  review: ReviewConfig;
  outputLanguage: string;
  notification: NotificationConfig;
  reminders: RemindersConfig;
  notes: NotesConfig;
  dedup: DedupConfig;
}

export interface EffectiveConfigSnapshot {
  reviewEnabled: boolean;
  provider: string;
  model: string;
  outputLanguage: string;
}

export type PipeConfigChangeType = "hot-reloaded" | "restart-required" | "validation-error";

export interface PipeConfigChangeEvent {
  type: PipeConfigChangeType;
  at: string;
  message: string;
  changedFields: string[];
  hotReloaded: string[];
  restartRequired: string[];
  issues?: string[];
}

export class PipeConfigValidationError extends Error {
  readonly issues: string[];

  constructor(issues: string[]) {
    super(["pipe.json validation failed", ...issues.map((issue) => `- ${issue}`)].join("\n"));
    this.name = "PipeConfigValidationError";
    this.issues = issues;
  }
}

const DEFAULT_FILTER_CONFIG: FilterConfig = {
  allowedApps: [],
  blockedWindows: ["livepipe", "opencode", "screenpipe"],
  minTextLength: 20,
};

const DEFAULT_CAPTURE_CONFIG: CaptureConfig = {
  mode: "always",
  hotkeyHoldMs: 500,
};

const DEFAULT_REVIEW_CONFIG: ReviewConfig = {
  enabled: false,
  provider: "",
  model: "",
  apiKey: "",
  failOpen: true,
};

const DEFAULT_NOTIFICATION_CONFIG: NotificationConfig = {
  desktop: true,
  webhooks: [],
};

const DEFAULT_REMINDERS_CONFIG: RemindersConfig = {
  enabled: false,
  list: "LivePipe",
};

const DEFAULT_NOTES_CONFIG: NotesConfig = {
  enabled: false,
  folder: "LivePipe",
};

const DEFAULT_DEDUP_CONFIG: DedupConfig = {
  actionableThreshold: 0.6,
  noteworthyThreshold: 0.8,
  lookbackDays: 7,
};

const DEFAULT_OUTPUT_LANGUAGE = "zh-CN";

const webhookSchema = z
  .object({
    url: z.string().trim().min(1, "must be a non-empty string"),
    enabled: z.boolean().optional().default(true),
    provider: z.enum(["generic", "feishu", "telegram"]).optional().default("generic"),
    headers: z.record(z.string()).optional(),
    chatId: z.string().trim().optional(),
  })
  .superRefine((value, ctx) => {
    if (value.provider === "telegram" && !value.chatId) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["chatId"],
        message: "is required when notification.webhooks.provider is \"telegram\"",
      });
    }
  });

const pipeConfigSchema = z
  .object({
    filter: z
      .object({
        allowedApps: z.array(z.string()).default(DEFAULT_FILTER_CONFIG.allowedApps),
        blockedWindows: z.array(z.string()).default(DEFAULT_FILTER_CONFIG.blockedWindows),
        minTextLength: z
          .number()
          .int("must be an integer")
          .min(1, "must be >= 1")
          .default(DEFAULT_FILTER_CONFIG.minTextLength),
      })
      .default(DEFAULT_FILTER_CONFIG),
    capture: z
      .object({
        mode: z.enum(["always", "hotkey", "both"]).default(DEFAULT_CAPTURE_CONFIG.mode),
        hotkeyHoldMs: z
          .number()
          .int("must be an integer")
          .min(1, "must be >= 1")
          .default(DEFAULT_CAPTURE_CONFIG.hotkeyHoldMs),
      })
      .default(DEFAULT_CAPTURE_CONFIG),
    review: z
      .object({
        enabled: z.boolean().default(DEFAULT_REVIEW_CONFIG.enabled),
        provider: z.string().trim().default(DEFAULT_REVIEW_CONFIG.provider),
        model: z.string().trim().default(DEFAULT_REVIEW_CONFIG.model),
        apiKey: z.string().default(DEFAULT_REVIEW_CONFIG.apiKey),
        failOpen: z.boolean().default(DEFAULT_REVIEW_CONFIG.failOpen),
      })
      .superRefine((value, ctx) => {
        if (!value.enabled) return;
        if (!value.provider) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ["provider"],
            message: "is required when review.enabled is true",
          });
        }
        if (!value.model) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ["model"],
            message: "is required when review.enabled is true",
          });
        }
        if (!value.apiKey) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ["apiKey"],
            message: "is required when review.enabled is true",
          });
        }
      })
      .default(DEFAULT_REVIEW_CONFIG),
    outputLanguage: z
      .string()
      .trim()
      .min(1, "must be a non-empty string")
      .default(DEFAULT_OUTPUT_LANGUAGE),
    notification: z
      .object({
        desktop: z.boolean().default(DEFAULT_NOTIFICATION_CONFIG.desktop),
        webhooks: z.array(webhookSchema).default(DEFAULT_NOTIFICATION_CONFIG.webhooks),
      })
      .default(DEFAULT_NOTIFICATION_CONFIG),
    reminders: z
      .object({
        enabled: z.boolean().default(DEFAULT_REMINDERS_CONFIG.enabled),
        list: z.string().trim().min(1, "must be a non-empty string").default(DEFAULT_REMINDERS_CONFIG.list),
      })
      .default(DEFAULT_REMINDERS_CONFIG),
    notes: z
      .object({
        enabled: z.boolean().default(DEFAULT_NOTES_CONFIG.enabled),
        folder: z.string().trim().min(1, "must be a non-empty string").default(DEFAULT_NOTES_CONFIG.folder),
      })
      .default(DEFAULT_NOTES_CONFIG),
    dedup: z
      .object({
        actionableThreshold: z
          .number()
          .min(0, "must be >= 0")
          .max(1, "must be <= 1")
          .default(DEFAULT_DEDUP_CONFIG.actionableThreshold),
        noteworthyThreshold: z
          .number()
          .min(0, "must be >= 0")
          .max(1, "must be <= 1")
          .default(DEFAULT_DEDUP_CONFIG.noteworthyThreshold),
        lookbackDays: z
          .number()
          .int("must be an integer")
          .min(1, "must be >= 1")
          .default(DEFAULT_DEDUP_CONFIG.lookbackDays),
      })
      .default(DEFAULT_DEDUP_CONFIG),
  })
  .passthrough();

const HOT_RELOAD_FIELDS = new Set([
  "filter.allowedApps",
  "filter.blockedWindows",
  "filter.minTextLength",
  "review.enabled",
  "review.provider",
  "review.model",
  "review.apiKey",
  "review.failOpen",
  "outputLanguage",
  "notification.desktop",
  "notification.webhooks",
  "reminders.enabled",
  "reminders.list",
  "notes.enabled",
  "notes.folder",
  "dedup.actionableThreshold",
  "dedup.noteworthyThreshold",
  "dedup.lookbackDays",
]);

const RESTART_REQUIRED_FIELDS = new Set(["capture.mode", "capture.hotkeyHoldMs"]);

let currentConfig: PipeConfig | null = null;
let watcherStarted = false;
let lastConfigEvent: PipeConfigChangeEvent | null = null;

function formatPath(path: (string | number)[]): string {
  return path.length > 0 ? path.join(".") : "(root)";
}

function formatZodIssues(error: z.ZodError): string[] {
  return error.issues.map((issue) => `${formatPath(issue.path)}: ${issue.message}`);
}

function readPipeConfigFileOrThrow(): string {
  if (!existsSync(PIPE_CONFIG_FILE)) {
    throw new PipeConfigValidationError([`(root): file not found at ${PIPE_CONFIG_FILE}`]);
  }

  try {
    return readFileSync(PIPE_CONFIG_FILE, "utf-8");
  } catch (error) {
    throw new PipeConfigValidationError([`(root): failed to read file: ${String(error)}`]);
  }
}

export function parsePipeConfigTextOrThrow(text: string): PipeConfig {
  let parsedJson: unknown;
  try {
    parsedJson = JSON.parse(text);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new PipeConfigValidationError([`(root): invalid JSON: ${message}`]);
  }

  const result = pipeConfigSchema.safeParse(parsedJson);
  if (!result.success) {
    throw new PipeConfigValidationError(formatZodIssues(result.error));
  }

  return result.data;
}

function readAndParsePipeConfigOrThrow(): PipeConfig {
  const text = readPipeConfigFileOrThrow();
  return parsePipeConfigTextOrThrow(text);
}

function getComparableFields(config: PipeConfig): Record<string, unknown> {
  return {
    "filter.allowedApps": config.filter.allowedApps,
    "filter.blockedWindows": config.filter.blockedWindows,
    "filter.minTextLength": config.filter.minTextLength,
    "capture.mode": config.capture.mode,
    "capture.hotkeyHoldMs": config.capture.hotkeyHoldMs,
    "review.enabled": config.review.enabled,
    "review.provider": config.review.provider,
    "review.model": config.review.model,
    "review.apiKey": config.review.apiKey,
    "review.failOpen": config.review.failOpen,
    outputLanguage: config.outputLanguage,
    "notification.desktop": config.notification.desktop,
    "notification.webhooks": config.notification.webhooks,
    "reminders.enabled": config.reminders.enabled,
    "reminders.list": config.reminders.list,
    "notes.enabled": config.notes.enabled,
    "notes.folder": config.notes.folder,
    "dedup.actionableThreshold": config.dedup.actionableThreshold,
    "dedup.noteworthyThreshold": config.dedup.noteworthyThreshold,
    "dedup.lookbackDays": config.dedup.lookbackDays,
  };
}

function getChangedFields(previous: PipeConfig, next: PipeConfig): string[] {
  const prevFields = getComparableFields(previous);
  const nextFields = getComparableFields(next);
  const changed: string[] = [];

  for (const path of Object.keys(nextFields)) {
    const left = JSON.stringify(prevFields[path]);
    const right = JSON.stringify(nextFields[path]);
    if (left !== right) {
      changed.push(path);
    }
  }

  return changed;
}

function buildChangeEvent(
  changedFields: string[],
  issues?: string[]
): PipeConfigChangeEvent {
  const hotReloaded = changedFields.filter((path) => HOT_RELOAD_FIELDS.has(path));
  const restartRequired = changedFields.filter((path) => RESTART_REQUIRED_FIELDS.has(path));

  if (issues && issues.length > 0) {
    return {
      type: "validation-error",
      at: new Date().toISOString(),
      message: `配置校验失败: ${issues[0]}`,
      changedFields,
      hotReloaded: [],
      restartRequired: [],
      issues,
    };
  }

  const type: PipeConfigChangeType = restartRequired.length > 0 ? "restart-required" : "hot-reloaded";

  const messageParts: string[] = [];
  if (hotReloaded.length > 0) {
    messageParts.push(`已热加载: ${hotReloaded.join(", ")}`);
  }
  if (restartRequired.length > 0) {
    messageParts.push(`需要重启: ${restartRequired.join(", ")}`);
  }

  return {
    type,
    at: new Date().toISOString(),
    message: messageParts.join(" | "),
    changedFields,
    hotReloaded,
    restartRequired,
  };
}

export function loadPipeConfigOrThrow(): PipeConfig {
  const parsed = readAndParsePipeConfigOrThrow();
  currentConfig = parsed;
  return parsed;
}

export function getPipeConfig(): PipeConfig {
  if (!currentConfig) {
    return loadPipeConfigOrThrow();
  }
  return currentConfig;
}

export function getEffectiveConfigSnapshot(config: PipeConfig = getPipeConfig()): EffectiveConfigSnapshot {
  return {
    reviewEnabled: config.review.enabled,
    provider: config.review.provider,
    model: config.review.model,
    outputLanguage: config.outputLanguage,
  };
}

export function getLastPipeConfigEvent(): PipeConfigChangeEvent | null {
  return lastConfigEvent;
}

export function startPipeConfigWatcher(onEvent: (event: PipeConfigChangeEvent) => void): void {
  if (watcherStarted) {
    return;
  }

  watcherStarted = true;

  watchFile(PIPE_CONFIG_FILE, { interval: 1200 }, (curr, prev) => {
    if (curr.mtimeMs === prev.mtimeMs) {
      return;
    }

    const previousConfig = currentConfig;

    try {
      const nextConfig = readAndParsePipeConfigOrThrow();

      if (!previousConfig) {
        currentConfig = nextConfig;
        return;
      }

      const changedFields = getChangedFields(previousConfig, nextConfig);
      currentConfig = nextConfig;

      if (changedFields.length === 0) {
        return;
      }

      lastConfigEvent = buildChangeEvent(changedFields);
      onEvent(lastConfigEvent);
    } catch (error) {
      if (error instanceof PipeConfigValidationError) {
        lastConfigEvent = buildChangeEvent([], error.issues);
        onEvent(lastConfigEvent);
        return;
      }

      const issues = [`(root): failed to reload config: ${String(error)}`];
      lastConfigEvent = buildChangeEvent([], issues);
      onEvent(lastConfigEvent);
    }
  });
}
