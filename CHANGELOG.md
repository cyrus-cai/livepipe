# Changelog

## v1.0.0 (2024-02-08)

### Major Changes

- 🎉 **Project renamed from `screenpipe-action-pipe` to `LivePipe`**
- 🚀 **One-command installation**: `curl -fsSL <url>/install.sh | bash`
- 📦 **CLI tool**: Global `live` command for managing all services
- ⚙️ **Auto-detection**: Automatically detects Screenpipe OCR capture intervals
- 🛡️ **Permission checking**: Detects missing macOS permissions and guides users
- 📊 **Process management**: PM2 integration with auto-restart and log rotation
- 🔄 **Update mechanism**: `live update` command for easy updates

### New Features

- **CLI Commands**:
  - `live setup` - Check and install all dependencies
  - `live start` - Start all services (Screenpipe + Ollama + LivePipe)
  - `live stop` - Stop all services
  - `live restart` - Restart services
  - `live status` - Show service status and dependency check
  - `live logs [name]` - View logs
  - `live update` - Update to latest version
  - `live config` - Edit configuration file

- **Auto-Detection**:
  - Detects Screenpipe OCR capture interval on startup
  - Auto-adjusts polling interval (Screenpipe interval + 5s)
  - Auto-adjusts lookback window (2x Screenpipe interval)

- **Permission Checking**:
  - Detects Screen Recording permission status
  - Alerts when no OCR data for extended period
  - Provides fix instructions in `live status`

- **Process Management**:
  - PM2 manages all services (Screenpipe, Ollama, LivePipe)
  - Auto-restart on crash (max 10 times)
  - Log rotation (10MB max per file)
  - Health monitoring and alerts

### Configuration Changes

- **Port changed from 3000 to 3060** to avoid common conflicts
- Configuration file moved to `~/.livepipe/config.json`
- Added `config.template.json` for default settings

### Installation Changes

- Project installs to `~/.livepipe/` (user directory, no sudo needed)
- Global `live` command linked to `/usr/local/bin/live`
- Automatic dependency installation (Bun, Ollama, Screenpipe, PM2)
- Automatic Ollama model pull (qwen3:1.7b)

### Breaking Changes

- ⚠️ Project name changed: update your bookmarks and scripts
- ⚠️ Port changed from 3000 to 3060
- ⚠️ Manual setup steps replaced by `live` commands

### Documentation

- Completely rewritten README files (English + Chinese)
- Added installation troubleshooting guide
- Added permission setup instructions
- Added uninstall instructions

### Technical Improvements

- Better error handling and recovery
- Runtime monitoring for data flow issues
- Configurable auto-restart policies
- Improved logging with timestamps
- Better dependency version detection

### Files Added

- `install.sh` - One-command installation script
- `bin/live` - Bash entry point for CLI
- `bin/live.ts` - TypeScript CLI implementation
- `ecosystem.config.js` - PM2 configuration
- `config.template.json` - Default configuration template
- `CHANGELOG.md` - This file

### Migration Guide

If you were using the old `screenpipe-action-pipe`:

1. Stop old services:
   ```bash
   # Stop Next.js dev server (Ctrl+C)
   # Stop Screenpipe and Ollama manually
   ```

2. Install new version:
   ```bash
   curl -fsSL https://raw.githubusercontent.com/cyrus-cai/livepipe/main/install.sh | bash
   ```

3. Start new version:
   ```bash
   live start
   ```

4. Access new port:
   ```
   http://localhost:3060
   ```

---

## Future Plans

- [ ] Linux support (different notification system)
- [ ] Windows support
- [ ] Web UI improvements
- [ ] More AI models support
- [ ] Custom notification rules
- [ ] Integration with task management tools
- [ ] Browser extension
