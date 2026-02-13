# LivePipe

[![Language: English](https://img.shields.io/badge/Language-English-1f6feb)](README.md)
[![语言: 简体中文](https://img.shields.io/badge/语言-简体中文-2ea44f)](README.zh-CN.md)

> **Low-Key Preview** — 当前版本不稳定，效果欠佳，仅供研究与测试。

LivePipe 通过 OCR 实时监控你的屏幕，用本地大模型识别其中的可执行事项（待办、提醒、会议、截止日期），然后推送到桌面通知、Webhook 或 Apple Reminders。无需手动输入——正常工作就好，LivePipe 帮你捕捉关键信息。

## 工作原理

```
屏幕 OCR（Screenpipe）
    ↓
应用 & 窗口过滤 ── 跳过无关应用 / 屏蔽窗口
    ↓
Local LLM（Ollama / Qwen 1.7B）── 快速意图识别
    ↓
去重 ── 避免重复提醒
    ↓
云端审查（可选，Gemini）── 过滤误报
    ↓
通知 ── 桌面 / 飞书 / Telegram / Webhook / Apple Reminders
```

管道每分钟运行一次。本地模型速度快但噪声较多；开启云端审查可以显著减少误报，代价是每个检测到的事项需要一次 API 调用。

## 快速开始

### 环境依赖

| 依赖 | 安装方式 |
|---|---|
| **macOS** | — |
| [Bun](https://bun.sh/) | `curl -fsSL https://bun.sh/install \| bash` |
| [Ollama](https://ollama.com/) | 从官网下载 |
| [Screenpipe](https://github.com/mediar-ai/screenpipe) | `brew install screenpipe` 或从 GitHub 下载 |
| [PM2](https://pm2.keymetrics.io/) | `bun install -g pm2` |

### 安装 & 运行

```bash
git clone https://github.com/cyrus-cai/livepipe.git
cd livepipe
bun install

# 拉取默认本地模型
ollama pull qwen3:1.7b

# 创建配置文件
cp config.template.json config.json
cp pipe.template.json pipe.json

# 启动（通过 PM2 自动管理 Screenpipe + Ollama）
bun run dev
```

启动后会：
1. 检查所有依赖是否已安装
2. 通过 PM2 启动 Screenpipe 和 Ollama
3. 在 `http://localhost:3060` 启动 Dashboard
4. 开始监控屏幕内容并发送通知

### macOS 权限

在 **System Settings > Privacy & Security** 中为终端应用授予以下权限：

- **Screen Recording** — Screenpipe 捕获屏幕内容所需
- **Notifications** — 桌面通知所需
- **Automation (Reminders)** — 仅当 `reminders.enabled` 为 `true` 时需要

## 配置

所有设置都在 `pipe.json` 中。修改后会热加载，无需重启。

### 应用过滤

控制监控哪些应用：

```json
{
  "filter": {
    "allowedApps": ["Notes", "WeChat", "Slack", "Google Chrome", "..."],
    "blockedWindows": ["livepipe", "screenpipe"],
    "minTextLength": 20
  }
}
```

### 云端审查（可选）

添加 Cloud LLM 层来过滤 Local LLM 的误报：

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

- 两阶段审查：可执行性验证 + 内容质量检查
- `failOpen: true` 表示云端 API 不可用时任务仍会通过

### 通知通道

默认开启桌面通知。添加 Webhook 推送到其他应用：

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

支持的 provider：`feishu`、`telegram`、`generic`（发送包含 `title`、`body`、`type`、`dueTime` 的 JSON）。

### Apple Reminders 同步

将检测到的任务单向推送到 Apple Reminders：

```json
{
  "reminders": {
    "enabled": false,
    "list": "LivePipe"
  }
}
```

- 默认关闭，更安全
- 目标列表不存在时会自动创建
- 同步采用 fire-and-forget 模式——失败仅记录日志，不阻塞主流程

### 输出语言

通过 `outputLanguage` 设置检测到的任务的输出语言：

```json
{
  "outputLanguage": "zh-CN"
}
```

## Tech Stack

- **Runtime**：[Bun](https://bun.sh/) + TypeScript
- **OCR**：[Screenpipe](https://github.com/mediar-ai/screenpipe)
- **Local LLM**：[Ollama](https://ollama.com/)（默认：Qwen 1.7B）
- **Cloud LLM**：Google Gemini（可选）
- **Dashboard**：Next.js
- **Process Manager**：PM2

## License

MIT
