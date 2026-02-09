# LivePipe

[![Language: English](https://img.shields.io/badge/Language-English-1f6feb)](README.md)
[![语言: 简体中文](https://img.shields.io/badge/语言-简体中文-2ea44f)](README.zh-CN.md)

> **Low-Key Preview** — 当前版本不稳定，效果欠佳，仅供研究与测试。

基于 [Screenpipe](https://github.com/mediar-ai/screenpipe) + 本地大模型 ([Ollama](https://ollama.com)) 的实时屏幕内容分析工具。自动监控屏幕内容，检测到待办、提醒、会议、截止时间等可执行事项时发送桌面通知。

![LivePipe 通知效果预览](public/preview.png)

## THE NEXT STEP

- [ ] 与 OpenClaw 协同审查识别到的屏幕内容，确认是否输出。

## 系统要求

- **macOS**
- 已安装 [Bun](https://bun.sh/)
- 已本地安装 [Ollama](https://ollama.com/)（默认模型：`qwen3:1.7b`）
- 已安装 [Screenpipe CLI](https://github.com/mediar-ai/screenpipe)
- 可用 [PM2](https://pm2.keymetrics.io/)（`scripts/dev.ts` 用它管理 Screenpipe/Ollama）
- 需为终端应用授予：
  - 屏幕录制权限（系统设置 -> 隐私与安全性 -> 屏幕录制）
  - 通知权限（系统设置 -> 通知）

## 通知通道

默认情况下，LivePipe 通过 AppleScript 发送 macOS 桌面通知。
你也可以在 `pipe.json` 里开启 Webhook，把消息推送到第三方客户端（例如飞书或 Telegram）：

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

- `provider` 支持 `feishu`、`telegram`、`generic`
- `desktop: true` 会保留原有 macOS 通知
- `generic` 会发送标准 JSON（含 `title`、`body`、`type`、`dueTime` 等字段）
- 修改 `pipe.json` 后请重启 `live`

## 许可证

MIT
