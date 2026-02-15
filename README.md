# LivePipe

[![Language: English](https://img.shields.io/badge/Language-English-2ea44f)](README.md)
[![语言: 简体中文](https://img.shields.io/badge/语言-简体中文-1f6feb)](README.zh-CN.md)

> **Low-Key Preview** — This version is unstable and underperforms; for research and testing only.

LivePipe watches your screen in real time through OCR, uses a local LLM to detect two intent dimensions (`actionable` + `noteworthy`), and routes them to desktop notifications, webhooks, Apple Reminders, and Apple Notes. No manual input required: just work normally, and LivePipe catches what matters.

## How It Works

```
Screen OCR (Screenpipe)
    ↓
App & Window Filter ── skip irrelevant apps / blocked windows
    ↓
Local LLM (Ollama / Qwen 1.7B) ── fast intent detection
    ↓
Deduplication ── avoid duplicate alerts
    ↓
Cloud Review (optional, Gemini) ── filter false positives
    ↓
Notify & Sync ── Desktop / Feishu / Telegram / Webhook / Apple Reminders / Apple Notes
```

The pipeline runs every minute. The local model is fast but noisy; enabling cloud review significantly reduces false positives at the cost of an API call per detected item.

## Quick Start

### Prerequisites

| Dependency | Install |
|---|---|
| **macOS** | — |
| [Bun](https://bun.sh/) | `curl -fsSL https://bun.sh/install \| bash` |
| [Ollama](https://ollama.com/) | Download from website |
| [Screenpipe](https://github.com/mediar-ai/screenpipe) | `brew install screenpipe` or download from GitHub |
| [PM2](https://pm2.keymetrics.io/) | `bun install -g pm2` |

### Install & Run

```bash
git clone https://github.com/cyrus-cai/livepipe.git
cd livepipe
bun install

# Pull the default local model
ollama pull qwen3:1.7b

# Create your config files
cp config.template.json config.json
cp pipe.template.json pipe.json

# Start (auto-manages Screenpipe + Ollama via PM2)
bun run dev
```

This will:
1. Check that all dependencies are installed
2. Start Screenpipe and Ollama as PM2 processes
3. Launch a dashboard at `http://localhost:3060`
4. Begin monitoring your screen and sending notifications

### macOS Permissions

Grant your terminal the following in **System Settings > Privacy & Security**:

- **Screen Recording** — for Screenpipe to capture screen content
- **Notifications** — for desktop alerts
- **Automation (Reminders / Notes)** — only if `reminders.enabled` or `notes.enabled` is `true`

## Configuration

All settings live in `pipe.json`. Changes are hot-reloaded — no restart needed.

### App Filtering

Control which apps are monitored:

```json
{
  "filter": {
    "allowedApps": ["Notes", "WeChat", "Slack", "Google Chrome", "..."],
    "blockedWindows": ["livepipe", "screenpipe"],
    "minTextLength": 20
  }
}
```

### Cloud Review (Optional)

Add a cloud LLM layer to filter the local model's false positives:

```json
{
  "review": {
    "enabled": true,
    "provider": "gemini",
    "model": "gemini-3-flash-preview",
    "apiKey": "your-google-ai-studio-key",
    "failOpen": true
  }
}
```

- Two-stage review: actionability validation + content quality check
- `failOpen: true` means tasks still pass through if the cloud API is down

### Notification Channels

Desktop notifications are on by default. Add webhooks for push to other apps:

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
        "headers": { "X-Api-Key": "your-secret" }
      }
    ]
  }
}
```

Supported providers: `feishu`, `telegram`, `generic` (sends JSON with `title`, `body`, `actionable`, `noteworthy`, `urgent`, `dueTime`).

### Apple Reminders Sync

Push detected tasks into Apple Reminders (one-way):

```json
{
  "reminders": {
    "enabled": false,
    "list": "LivePipe"
  }
}
```

- Off by default for safety
- The target list is auto-created if it doesn't exist
- Sync is fire-and-forget — failures are logged but don't block the pipeline

### Apple Notes Sync

Append noteworthy content into Apple Notes (one-way, grouped by day):

```json
{
  "notes": {
    "enabled": false,
    "folder": "LivePipe"
  }
}
```

- Off by default for safety
- The target folder is auto-created if it doesn't exist
- Each noteworthy entry is appended into a daily note

### Output Language

Set `outputLanguage` to control the language of detected task output:

```json
{
  "outputLanguage": "zh-CN"
}
```

## Tech Stack

- **Runtime**: [Bun](https://bun.sh/) + TypeScript
- **OCR**: [Screenpipe](https://github.com/mediar-ai/screenpipe)
- **Local LLM**: [Ollama](https://ollama.com/) (default: Qwen 1.7B)
- **Cloud LLM**: Google Gemini (optional)
- **Dashboard**: Next.js
- **Process Manager**: PM2

## License

MIT
