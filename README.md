# LivePipe

[![Language: English](https://img.shields.io/badge/Language-English-2ea44f)](README.md)
[![语言: 简体中文](https://img.shields.io/badge/语言-简体中文-1f6feb)](README.zh-CN.md)

> **Low-Key Preview** — This version is unstable and underperforms; for research and testing only.

A real-time screen content analysis tool powered by [Screenpipe](https://github.com/mediar-ai/screenpipe) + local LLM ([Ollama](https://ollama.com)). It watches your screen and sends desktop notifications when it detects actionable items — todos, reminders, meetings, deadlines.

![LivePipe Notifications Preview](public/preview.png)

## Cloud Review Layer (Optional)

The local small model (Qwen 1.7B) is fast but noisy. You can add a cloud LLM review layer that filters the small model's output before notifying. Configure in `pipe.json`:

```json
"review": {
  "enabled": true,
  "provider": "gemini",
  "model": "gemini-3-flash-preview",
  "apiKey": "your-google-ai-studio-key",
  "failOpen": true
}
```

When enabled, the pipeline becomes:

```
Screen OCR → Local model → Dedup (tasks-raw.md) → Cloud review → Record (tasks.md) → Notify
```

- Two-stage review: actionability validation + content quality check
- `tasks-raw.md` deduplicates at the local model level to minimize cloud API calls
- `tasks.md` only contains cloud-reviewed, high-quality tasks

## Getting Started

### Prerequisites

- **macOS**
- [Bun](https://bun.sh/)
- [Ollama](https://ollama.com/) (default model: `qwen3:1.7b`)
- [Screenpipe CLI](https://github.com/mediar-ai/screenpipe)
- [PM2](https://pm2.keymetrics.io/) (`bun install -g pm2`)

### Setup

```bash
git clone https://github.com/cyrus-cai/livepipe.git
cd livepipe
bun install

# Pull the default LLM model
ollama pull qwen3:1.7b

# Copy config templates
cp config.template.json config.json
cp pipe.template.json pipe.json
```

### Run

```bash
# Start dev mode (auto-manages Screenpipe + Ollama via PM2)
bun run dev
```

The dev script will:
1. Check that Screenpipe, Ollama, and PM2 are installed
2. Start Screenpipe and Ollama as PM2 processes
3. Launch the Next.js dev server on `http://localhost:3060`
4. Begin polling screen content and sending notifications

### macOS Permissions

Grant your terminal app the following permissions in **System Settings -> Privacy & Security**:

- **Screen Recording** — required by Screenpipe to capture screen content
- **Notifications** — required for desktop notifications
- **Automation (Reminders)** — required when `reminders.enabled` is `true`

## Notification Channels

By default, LivePipe sends macOS desktop notifications via AppleScript.
You can also enable webhook push to third-party clients (for example Feishu or Telegram) in `pipe.json`:

```json
{
  "notification": {
    "desktop": true,
    "webhooks": [
      {
        "enabled": true,
        "provider": "feishu",
        "url": "https://open.feishu.cn/open-apis/bot/v2/hook/your-hook"
      },
      {
        "enabled": true,
        "provider": "telegram",
        "url": "https://api.telegram.org/bot<token>/sendMessage",
        "chatId": "<chat-id>"
      },
      {
        "enabled": true,
        "provider": "generic",
        "url": "https://your-webhook-endpoint.example.com/livepipe",
        "headers": {
          "X-Api-Key": "your-secret"
        }
      }
    ]
  }
}
```

- `provider` supports `feishu`, `telegram`, `generic`
- `desktop: true` keeps the existing macOS notification
- `generic` sends a JSON payload with `title`, `body`, `type`, `dueTime`, etc.

## Apple Reminders Sync

LivePipe can also push newly recorded tasks into Apple Reminders (one-way sync only).

```json
{
  "reminders": {
    "enabled": false,
    "list": "LivePipe"
  }
}
```

- `enabled` defaults to `false` for safety
- `list` is the target reminders list name (auto-created if missing)
- Sync is fail-silent and does not block the main pipeline

## License

MIT
