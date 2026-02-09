# LivePipe

[![Language: English](https://img.shields.io/badge/Language-English-2ea44f)](README.md)
[![语言: 简体中文](https://img.shields.io/badge/语言-简体中文-1f6feb)](README.zh-CN.md)

> **Low-Key Preview** — This version is unstable and underperforms; for research and testing only.

A real-time screen content analysis tool powered by [Screenpipe](https://github.com/mediar-ai/screenpipe) + local LLM ([Ollama](https://ollama.com)). It watches your screen and sends desktop notifications when it detects actionable items — todos, reminders, meetings, deadlines.

![LivePipe Notifications Preview](public/preview.png)

## THE NEXT STEP

- [ ] OpenClaw final review of detected screen content: decide whether to output it.

## Requirements

- **macOS**
- [Bun](https://bun.sh/) installed
- [Ollama](https://ollama.com/) installed locally (default model: `qwen3:1.7b`)
- [Screenpipe CLI](https://github.com/mediar-ai/screenpipe) installed
- [PM2](https://pm2.keymetrics.io/) available (used by `scripts/dev.ts` to manage Screenpipe/Ollama)
- Grant your terminal app:
  - Screen Recording permission (System Settings -> Privacy & Security -> Screen Recording)
  - Notification permission (System Settings -> Notifications)

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

## License

MIT
