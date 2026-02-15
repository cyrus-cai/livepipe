import { exec } from "child_process";
import type { IntentResult } from "./schemas";
import { getPipeConfig, type NotificationConfig, type WebhookConfig } from "./pipe-config";
import { debugError, debugLog, type NotifyResult } from "./pipeline-logger";

const DEFAULT_NOTIFICATION_CONFIG: NotificationConfig = {
  desktop: true,
  webhooks: [],
};

interface DeliveryResult {
  ok: boolean;
  channel: "desktop" | "webhook";
  provider: string;
  error?: string;
}

function getNotificationConfig(): NotificationConfig {
  try {
    return getPipeConfig().notification;
  } catch (error) {
    debugError("[notify] failed to read notification config:", error);
    return DEFAULT_NOTIFICATION_CONFIG;
  }
}

function escapeAppleScript(str: string): string {
  return str.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

function buildNotificationMessage(result: IntentResult): {
  title: string;
  body: string;
} {
  const title = result.urgent ? "Urgent Action" : "Maybe Need Action";
  const body = result.due_time
    ? `${result.content}\nDue: ${result.due_time}`
    : result.content;
  return { title, body };
}

async function sendDesktopNotification(title: string, body: string): Promise<DeliveryResult> {
  const escapedTitle = escapeAppleScript(title);
  const escapedBody = escapeAppleScript(body);
  const script = `display notification "${escapedBody}" with title "${escapedTitle}" sound name "Glass"`;

  return await new Promise<DeliveryResult>((resolve) => {
    exec(`osascript -e '${script.replace(/'/g, "'\\''")}'`, (error) => {
      if (error) {
        resolve({
          ok: false,
          channel: "desktop",
          provider: "desktop",
          error: `desktop: ${error.message}`,
        });
        return;
      }
      debugLog(`[notify] sent desktop notification: "${title}"`);
      resolve({ ok: true, channel: "desktop", provider: "desktop" });
    });
  });
}

function buildWebhookPayload(
  config: WebhookConfig,
  result: IntentResult,
  title: string,
  body: string
): unknown {
  if (config.provider === "feishu") {
    return {
      msg_type: "text",
      content: {
        text: `${title}\n${body}`,
      },
    };
  }

  if (config.provider === "telegram") {
    return {
      chat_id: config.chatId,
      text: `${title}\n${body}`,
    };
  }

  return {
    source: "livepipe",
    timestamp: new Date().toISOString(),
    title,
    body,
    dueTime: result.due_time,
    actionable: result.actionable,
    noteworthy: result.noteworthy,
    urgent: result.urgent,
    content: result.content,
  };
}

async function sendWebhookNotification(
  config: WebhookConfig,
  result: IntentResult,
  title: string,
  body: string
): Promise<DeliveryResult | null> {
  if (config.enabled === false) {
    return null;
  }

  const provider = config.provider ?? "generic";

  if (config.provider === "telegram" && !config.chatId) {
    return {
      ok: false,
      channel: "webhook",
      provider,
      error: `webhook(${provider}) missing chatId`,
    };
  }

  const payload = buildWebhookPayload(config, result, title, body);
  const headers = {
    "Content-Type": "application/json",
    ...(config.headers ?? {}),
  };

  try {
    const response = await fetch(config.url, {
      method: "POST",
      headers,
      body: JSON.stringify(payload),
    });

    if (!response.ok) {
      const text = await response.text();
      return {
        ok: false,
        channel: "webhook",
        provider,
        error: `webhook(${provider}) HTTP ${response.status}: ${text.slice(0, 120)}`,
      };
    }

    debugLog(`[notify] sent webhook notification (${provider}): ${config.url}`);
    return { ok: true, channel: "webhook", provider };
  } catch (error) {
    return {
      ok: false,
      channel: "webhook",
      provider,
      error: `webhook(${provider}) error: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

export async function sendNotification(result: IntentResult): Promise<NotifyResult> {
  const { title, body } = buildNotificationMessage(result);
  const notificationConfig = getNotificationConfig();

  const summary: NotifyResult = {
    desktop: false,
    webhooks: [],
    errors: [],
  };

  const jobs: Promise<DeliveryResult | null>[] = [];

  if (notificationConfig.desktop) {
    jobs.push(sendDesktopNotification(title, body));
  }

  for (const webhook of notificationConfig.webhooks) {
    jobs.push(sendWebhookNotification(webhook, result, title, body));
  }

  const outcomes = await Promise.all(jobs);

  for (const outcome of outcomes) {
    if (!outcome) continue;

    if (outcome.channel === "desktop") {
      summary.desktop = outcome.ok;
      if (!outcome.ok && outcome.error) {
        summary.errors.push(outcome.error);
      }
      continue;
    }

    if (outcome.ok) {
      if (!summary.webhooks.includes(outcome.provider)) {
        summary.webhooks.push(outcome.provider);
      }
    } else if (outcome.error) {
      summary.errors.push(outcome.error);
    }
  }

  if (summary.errors.length > 0) {
    debugError("[notify] failures:", summary.errors.join(" | "));
  }

  return summary;
}
