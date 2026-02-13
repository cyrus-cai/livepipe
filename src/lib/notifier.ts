import { exec } from "child_process";
import type { IntentResult } from "./schemas";
import { getPipeConfig, type NotificationConfig, type WebhookConfig } from "./pipe-config";

const TYPE_LABELS: Record<string, string> = {
  reminder: "Reminder",
  todo: "To-Do",
  meeting: "Meeting",
  deadline: "Deadline",
  note: "Note",
};

const DEFAULT_NOTIFICATION_CONFIG: NotificationConfig = {
  desktop: true,
  webhooks: [],
};

function getNotificationConfig(): NotificationConfig {
  try {
    return getPipeConfig().notification;
  } catch (error) {
    console.error("[notify] failed to read notification config:", error);
    return DEFAULT_NOTIFICATION_CONFIG;
  }
}

function escapeAppleScript(str: string): string {
  return str.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

function buildNotificationMessage(result: IntentResult): {
  typeLabel: string;
  title: string;
  body: string;
} {
  const typeLabel = TYPE_LABELS[result.type] || result.type;
  const title = "Maybe Need Action";
  const body = result.content;
  return { typeLabel, title, body };
}

async function sendDesktopNotification(title: string, body: string): Promise<void> {
  const escapedTitle = escapeAppleScript(title);
  const escapedBody = escapeAppleScript(body);

  const script = `display notification "${escapedBody}" with title "${escapedTitle}" sound name "Glass"`;

  await new Promise<void>((resolve) => {
    exec(`osascript -e '${script.replace(/'/g, "'\\''")}'`, (error) => {
      if (error) {
        console.error("[notify] osascript error:", error.message);
      } else {
        console.log(`[notify] sent desktop notification: "${title}" — ${body}`);
      }
      resolve();
    });
  });
}

function buildWebhookPayload(
  config: WebhookConfig,
  result: IntentResult,
  typeLabel: string,
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
    type: result.type,
    typeLabel,
    dueTime: result.due_time,
    actionable: result.actionable,
    content: result.content,
  };
}

async function sendWebhookNotification(
  config: WebhookConfig,
  result: IntentResult,
  typeLabel: string,
  title: string,
  body: string
): Promise<void> {
  if (config.enabled === false) {
    return;
  }

  if (config.provider === "telegram" && !config.chatId) {
    console.error(`[notify] telegram webhook missing chatId for ${config.url}`);
    return;
  }

  const payload = buildWebhookPayload(config, result, typeLabel, title, body);
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
      console.error(
        `[notify] webhook failed (${response.status}) ${config.url}: ${text.slice(0, 300)}`
      );
      return;
    }

    console.log(`[notify] sent webhook notification (${config.provider ?? "generic"}): ${config.url}`);
  } catch (error) {
    console.error(`[notify] webhook error ${config.url}:`, error);
  }
}

export async function sendNotification(result: IntentResult): Promise<void> {
  const { typeLabel, title, body } = buildNotificationMessage(result);
  const notificationConfig = getNotificationConfig();

  const jobs: Promise<void>[] = [];

  if (notificationConfig.desktop) {
    jobs.push(sendDesktopNotification(title, body));
  }

  for (const webhook of notificationConfig.webhooks) {
    jobs.push(sendWebhookNotification(webhook, result, typeLabel, title, body));
  }

  await Promise.all(jobs);
}
