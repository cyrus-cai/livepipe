#!/usr/bin/env bun
/**
 * LivePipe CLI - Main command interface
 */

import { spawn, spawnSync } from "child_process";
import { existsSync, readFileSync, writeFileSync } from "fs";
import { homedir } from "os";
import { join } from "path";

const HOME = homedir();
const LIVEPIPE_DIR = join(HOME, ".livepipe");
const CONFIG_FILE = join(LIVEPIPE_DIR, "config.json");
const CONFIG_TEMPLATE = join(LIVEPIPE_DIR, "config.template.json");

type ScreenpipeStartupConfig = {
  realtimeVision: boolean;
  adaptiveFps: boolean;
  useAllMonitors: boolean;
  disableAudio: boolean;
  usePiiRemoval: boolean;
  enableUiEvents: boolean;
  disableVision: boolean;
  captureUnfocusedWindows: boolean;
  enableRealtimeAudioTranscription: boolean;
};

const DEFAULT_SCREENPIPE_STARTUP: ScreenpipeStartupConfig = {
  realtimeVision: true,
  adaptiveFps: true,
  useAllMonitors: true,
  disableAudio: true,
  usePiiRemoval: true,
  enableUiEvents: true,
  disableVision: false,
  captureUnfocusedWindows: false,
  enableRealtimeAudioTranscription: false,
};

function normalizeConfig(config: any): any {
  const parsed = config ?? {};
  return {
    version: parsed.version ?? "1.0.0",
    ports: {
      app: Number(parsed?.ports?.app) || 3060,
      ollama: Number(parsed?.ports?.ollama) || 11434,
      screenpipe: Number(parsed?.ports?.screenpipe) || 3030,
    },
    ollama: {
      model: parsed?.ollama?.model ?? "qwen3:1.7b",
      managed: parsed?.ollama?.managed ?? false,
    },
    screenpipe: {
      monitors: parsed?.screenpipe?.monitors ?? "all",
      interval: Number(parsed?.screenpipe?.interval) || 30000,
      startup: {
        ...DEFAULT_SCREENPIPE_STARTUP,
        ...(parsed?.screenpipe?.startup ?? {}),
      },
    },
    app: {
      pollInterval: Number(parsed?.app?.pollInterval) || 35000,
      lookbackMs: Number(parsed?.app?.lookbackMs) || 60000,
    },
    capture: {
      mode: parsed?.capture?.mode ?? "always",
      hotkeyHoldMs: Number(parsed?.capture?.hotkeyHoldMs) || 500,
    },
  };
}

function createDefaultConfig() {
  return normalizeConfig({});
}

function buildScreenpipeArgsFromConfig(config: any): string[] {
  const startup: ScreenpipeStartupConfig = {
    ...DEFAULT_SCREENPIPE_STARTUP,
    ...(config?.screenpipe?.startup ?? {}),
  };

  const args: string[] = [];
  if (startup.realtimeVision) args.push("--enable-realtime-vision");
  if (startup.adaptiveFps) args.push("--adaptive-fps");
  if (startup.useAllMonitors) args.push("--use-all-monitors");
  if (startup.disableAudio) args.push("--disable-audio");
  if (startup.usePiiRemoval) args.push("--use-pii-removal");
  if (startup.enableUiEvents) args.push("--enable-ui-events");
  if (startup.disableVision) args.push("--disable-vision");
  if (startup.captureUnfocusedWindows) args.push("--capture-unfocused-windows");
  if (startup.enableRealtimeAudioTranscription) args.push("--enable-realtime-audio-transcription");
  return args;
}

// Color helpers
const colors = {
  reset: "\x1b[0m",
  red: "\x1b[31m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  blue: "\x1b[34m",
  cyan: "\x1b[36m",
};

function log(msg: string, color: keyof typeof colors = "reset") {
  console.log(`${colors[color]}${msg}${colors.reset}`);
}

function success(msg: string) {
  log(`✓ ${msg}`, "green");
}

function error(msg: string) {
  log(`✗ ${msg}`, "red");
}

function warn(msg: string) {
  log(`⚠ ${msg}`, "yellow");
}

function info(msg: string) {
  log(`→ ${msg}`, "cyan");
}

// Command checker
function commandExists(cmd: string): boolean {
  const result = spawnSync("command", ["-v", cmd], {
    shell: true,
    stdio: "pipe",
  });
  return result.status === 0;
}

function getCommandVersion(cmd: string): string | null {
  try {
    const result = spawnSync(cmd, ["--version"], {
      stdio: "pipe",
      encoding: "utf-8",
    });
    if (result.status === 0) {
      return result.stdout.trim().split("\n")[0];
    }
  } catch {}
  return null;
}

// Config management
function loadConfig(): any {
  if (!existsSync(CONFIG_FILE)) {
    if (existsSync(CONFIG_TEMPLATE)) {
      const template = readFileSync(CONFIG_TEMPLATE, "utf-8");
      writeFileSync(CONFIG_FILE, template);
      return normalizeConfig(JSON.parse(template));
    }
    return null;
  }
  return normalizeConfig(JSON.parse(readFileSync(CONFIG_FILE, "utf-8")));
}

function saveConfig(config: any) {
  writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2));
}

// PM2 helpers
async function pm2List(): Promise<any[]> {
  return new Promise((resolve) => {
    const proc = spawn("pm2", ["jlist"], { stdio: "pipe" });
    let output = "";
    proc.stdout.on("data", (data) => (output += data.toString()));
    proc.on("close", () => {
      try {
        resolve(JSON.parse(output));
      } catch {
        resolve([]);
      }
    });
  });
}

function pm2Start(name: string, script: string, args: string[] = []) {
  const allArgs = ["start", script, "--name", name, ...args];
  const result = spawnSync("pm2", allArgs, { stdio: "inherit" });
  return result.status === 0;
}

function pm2Stop(name: string) {
  const result = spawnSync("pm2", ["stop", name], { stdio: "inherit" });
  return result.status === 0;
}

function pm2Delete(name: string) {
  const result = spawnSync("pm2", ["delete", name], { stdio: "pipe" });
  return result.status === 0;
}

function pm2Restart(name: string) {
  const result = spawnSync("pm2", ["restart", name], { stdio: "inherit" });
  return result.status === 0;
}

function pm2Logs(name?: string) {
  const args = ["logs"];
  if (name) args.push(name);
  spawn("pm2", args, { stdio: "inherit" });
}

// Service checking
async function checkOllamaRunning(): Promise<boolean> {
  try {
    const response = await fetch("http://localhost:11434");
    return response.ok;
  } catch {
    return false;
  }
}

async function checkScreenpipeData(): Promise<boolean> {
  try {
    const { pipe } = await import("@screenpipe/js");
    const result = await pipe.queryScreenpipe({
      contentType: "ocr",
      limit: 1,
      startTime: new Date(Date.now() - 60000).toISOString(),
      endTime: new Date().toISOString(),
    });
    return (result?.data?.length ?? 0) > 0;
  } catch {
    return false;
  }
}

// Commands
async function cmdSetup() {
  log("\n🔍 Checking dependencies...\n", "cyan");

  // Check Bun
  if (commandExists("bun")) {
    const version = getCommandVersion("bun");
    success(`Bun ${version || "installed"}`);
  } else {
    error("Bun not found (this shouldn't happen!)");
  }

  // Check Ollama
  if (commandExists("ollama")) {
    const version = getCommandVersion("ollama");
    success(`Ollama ${version || "installed"}`);
  } else {
    error("Ollama not found");
    info("Install: curl -fsSL https://ollama.com/install.sh | sh");
  }

  // Check Screenpipe
  if (commandExists("screenpipe")) {
    const version = getCommandVersion("screenpipe");
    success(`Screenpipe ${version || "installed"}`);
  } else {
    error("Screenpipe not found");
    info("Install: curl -fsSL get.screenpi.pe/cli | sh");
  }

  // Check PM2
  if (commandExists("pm2")) {
    const version = getCommandVersion("pm2");
    success(`PM2 ${version || "installed"}`);
  } else {
    error("PM2 not found");
    info("Installing PM2...");
    const result = spawnSync("bun", ["install", "-g", "pm2"], {
      stdio: "inherit",
    });
    if (result.status === 0) {
      success("PM2 installed");
    } else {
      error("PM2 installation failed");
    }
  }

  // Check Ollama model
  if (commandExists("ollama")) {
    const result = spawnSync("ollama", ["list"], {
      stdio: "pipe",
      encoding: "utf-8",
    });
    if (result.stdout.includes("qwen3:1.7b")) {
      success("Model qwen3:1.7b ready");
    } else {
      warn("Model qwen3:1.7b not found");
      info("Pulling model (this may take a while)...");
      const pullResult = spawnSync("ollama", ["pull", "qwen3:1.7b"], {
        stdio: "inherit",
      });
      if (pullResult.status === 0) {
        success("Model qwen3:1.7b pulled");
      } else {
        error("Model pull failed");
      }
    }
  }

  // Install project dependencies
  if (existsSync(join(LIVEPIPE_DIR, "package.json"))) {
    if (!existsSync(join(LIVEPIPE_DIR, "node_modules"))) {
      info("Installing project dependencies...");
      const result = spawnSync("bun", ["install", "--frozen-lockfile"], {
        cwd: LIVEPIPE_DIR,
        stdio: "inherit",
      });
      if (result.status === 0) {
        success("Dependencies installed");
      } else {
        error("Dependency installation failed");
      }
    } else {
      success("Project dependencies installed");
    }
  }

  // Setup PM2 log rotation
  if (commandExists("pm2")) {
    const moduleResult = spawnSync("pm2", ["list"], {
      stdio: "pipe",
      encoding: "utf-8",
    });
    if (!moduleResult.stdout.includes("pm2-logrotate")) {
      info("Installing PM2 log rotation...");
      spawnSync("pm2", ["install", "pm2-logrotate"], { stdio: "inherit" });
      spawnSync("pm2", ["set", "pm2-logrotate:max_size", "10M"], {
        stdio: "inherit",
      });
      success("Log rotation configured (10MB max)");
    }
  }

  // Create config if not exists
  if (!existsSync(CONFIG_FILE)) {
    const config = createDefaultConfig();
    saveConfig(config);
    success("Configuration created");
  }

  log("\n✅ Setup complete!\n", "green");
  log("🚀 Get started:\n", "cyan");
  log("  live start\n");
}

async function cmdStart() {
  log("\n🚀 Starting LivePipe...\n", "cyan");

  const config = loadConfig();
  if (!config) {
    error("Config not found. Run: live setup");
    return;
  }

  const services = await pm2List();

  // Check and start Ollama
  const ollamaRunning = await checkOllamaRunning();
  if (ollamaRunning) {
    success("Ollama already running");
  } else {
    const ollamaInPm2 = services.find((s: any) => s.name === "ollama");
    if (ollamaInPm2) {
      info("Starting Ollama via PM2...");
      pm2Start("ollama", "ollama", ["serve"]);
    } else {
      info("Starting Ollama via PM2...");
      pm2Start("ollama", "ollama", ["serve"]);
    }
    // Wait for Ollama to start
    await new Promise((resolve) => setTimeout(resolve, 2000));
    if (await checkOllamaRunning()) {
      success("Ollama started");
    } else {
      error("Ollama failed to start");
    }
  }

  // Start Screenpipe
  const screenpipeArgs = buildScreenpipeArgsFromConfig(config);
  const screenpipeInPm2 = services.find((s: any) => s.name === "screenpipe");
  if (screenpipeInPm2 && screenpipeInPm2.pm2_env?.status === "online") {
    info("Screenpipe already running — recreating to apply config args...");
    pm2Delete("screenpipe");
  }
  info("Starting Screenpipe via PM2...");
  info(`Screenpipe args: ${screenpipeArgs.join(" ") || "(none)"}`);
  pm2Start("screenpipe", "screenpipe", screenpipeArgs);
  success("Screenpipe started");

  // Start LivePipe app
  const appInPm2 = services.find((s: any) => s.name === "livepipe-app");
  if (appInPm2 && appInPm2.pm2_env?.status === "online") {
    success("LivePipe app already running");
  } else {
    info("Starting LivePipe app via PM2...");
    // Use PM2 ecosystem config for proper app startup
    const result = spawnSync("pm2", ["start", join(LIVEPIPE_DIR, "ecosystem.config.js"), "--only", "livepipe-app"], {
      stdio: "inherit",
      cwd: LIVEPIPE_DIR,
    });
    if (result.status === 0) {
      success("LivePipe app started");
    } else {
      error("Failed to start LivePipe app");
    }
  }

  log("\n✅ All services started!\n", "green");
  log("📊 Pipeline will auto-start in 5 seconds...\n", "cyan");
  log("Manage services:\n", "cyan");
  log(`  live status    - Check service status`, "reset");
  log(`  live logs      - View real-time logs`, "reset");
  log(`  live stop      - Stop all services\n`, "reset");
  log(`Dashboard: http://localhost:${config.ports.app}\n`, "blue");
}

async function cmdStop() {
  log("\n🛑 Stopping LivePipe...\n", "cyan");

  const services = await pm2List();

  // Stop app
  const app = services.find((s: any) => s.name === "livepipe-app");
  if (app) {
    pm2Stop("livepipe-app");
    success("LivePipe app stopped");
  }

  // Stop Screenpipe
  const screenpipe = services.find((s: any) => s.name === "screenpipe");
  if (screenpipe) {
    pm2Stop("screenpipe");
    success("Screenpipe stopped");
  }

  // Ask about Ollama
  const ollama = services.find((s: any) => s.name === "ollama");
  if (ollama) {
    warn("Ollama is running (may be used by other apps)");
    info("Stop Ollama? [y/N]");
    // For now, don't stop Ollama automatically
    info("Skipping Ollama (stop manually if needed: pm2 stop ollama)");
  }

  log("\n✅ Services stopped\n", "green");
}

async function cmdStatus() {
  log("\n📊 LivePipe Status\n", "cyan");

  // Check dependencies
  log("Dependencies:", "yellow");
  ["bun", "ollama", "screenpipe", "pm2"].forEach((cmd) => {
    if (commandExists(cmd)) {
      const version = getCommandVersion(cmd);
      success(`${cmd} ${version || ""}`);
    } else {
      error(`${cmd} not found`);
    }
  });

  console.log();

  // Check services
  log("Services:", "yellow");
  const services = await pm2List();

  // Check Ollama (may be running outside PM2)
  const ollamaService = services.find((s: any) => s.name === "ollama");
  if (ollamaService) {
    const status = ollamaService.pm2_env?.status || "unknown";
    const pid = ollamaService.pid || "?";
    const uptime = ollamaService.pm2_env?.pm_uptime
      ? Math.floor((Date.now() - ollamaService.pm2_env.pm_uptime) / 1000 / 60)
      : 0;
    if (status === "online") {
      success(`ollama - running (pid ${pid}, ${uptime}m, managed by PM2)`);
    } else {
      error(`ollama - ${status}`);
    }
  } else {
    // Check if Ollama is running outside PM2
    const ollamaRunning = await checkOllamaRunning();
    if (ollamaRunning) {
      success(`ollama - running (external, port 11434)`);
    } else {
      error(`ollama - not running`);
    }
  }

  // Check other services
  ["screenpipe", "livepipe-app"].forEach((name) => {
    const service = services.find((s: any) => s.name === name);
    if (service) {
      const status = service.pm2_env?.status || "unknown";
      const pid = service.pid || "?";
      const uptime = service.pm2_env?.pm_uptime
        ? Math.floor((Date.now() - service.pm2_env.pm_uptime) / 1000 / 60)
        : 0;
      if (status === "online") {
        success(`${name} - running (pid ${pid}, ${uptime}m)`);
      } else {
        error(`${name} - ${status}`);
      }
    } else {
      error(`${name} - not running`);
    }
  });

  console.log();

  // Check config
  const config = loadConfig();
  if (config) {
    log("Configuration:", "yellow");
    info(`Web UI: http://localhost:${config.ports.app}`);
    info(`Ollama model: ${config.ollama.model}`);
    info(`Poll interval: ${config.app.pollInterval / 1000}s`);
  }

  console.log();
}

async function cmdRestart() {
  log("\n🔄 Restarting LivePipe...\n", "cyan");
  pm2Restart("livepipe-app");
  pm2Restart("screenpipe");
  success("Services restarted");
  log("");
}

async function cmdLogs(serviceName?: string) {
  // "live logs" with no args => show only livepipe-app pipeline logs, filtered
  if (!serviceName) {
    log("\n📋 LivePipe pipeline logs (filtered)\n", "cyan");
    info("Showing only pipeline output. Use 'live logs all' for everything.\n");
    const proc = spawn("pm2", ["logs", "livepipe-app", "--raw", "--lines", "50"], {
      stdio: ["inherit", "pipe", "pipe"],
    });
    const filter = (data: Buffer) => {
      const lines = data.toString().split("\n");
      for (const line of lines) {
        if (line.match(/\[(poll|intent|detect|pipeline|auto-start|notify|dedup)\]/)) {
          process.stdout.write(line + "\n");
        }
      }
    };
    proc.stdout?.on("data", filter);
    proc.stderr?.on("data", filter);
    return;
  }

  if (!["ollama", "screenpipe", "livepipe-app", "all"].includes(serviceName)) {
    error(`Unknown service: ${serviceName}`);
    info("Available: ollama, screenpipe, livepipe-app, all");
    return;
  }
  pm2Logs(serviceName === "all" ? undefined : serviceName);
}

async function cmdUpdate() {
  log("\n⬆️  Updating LivePipe...\n", "cyan");

  if (!existsSync(join(LIVEPIPE_DIR, ".git"))) {
    error("Not a git repository. Cannot update.");
    info("Reinstall using: curl -fsSL <install-url> | bash");
    return;
  }

  info("Pulling latest changes...");
  const pullResult = spawnSync("git", ["pull", "origin", "main"], {
    cwd: LIVEPIPE_DIR,
    stdio: "inherit",
  });

  if (pullResult.status !== 0) {
    error("Git pull failed");
    return;
  }

  info("Installing dependencies...");
  const installResult = spawnSync("bun", ["install", "--frozen-lockfile"], {
    cwd: LIVEPIPE_DIR,
    stdio: "inherit",
  });

  if (installResult.status !== 0) {
    error("Dependency installation failed");
    return;
  }

  success("Update complete");
  info("Restarting services...");
  await cmdRestart();
}

function cmdConfig() {
  if (existsSync(CONFIG_FILE)) {
    info(`Opening config file: ${CONFIG_FILE}`);
    spawnSync("open", [CONFIG_FILE], { stdio: "inherit" });
  } else {
    error("Config file not found. Run: live setup");
  }
}

function showHelp() {
  log("\n📚 LivePipe CLI\n", "cyan");
  log("Usage: live <command>\n");
  log("Commands:");
  log("  setup          Check and install all dependencies");
  log("  start          Start all services");
  log("  stop           Stop all services");
  log("  restart        Restart services");
  log("  status         Show service status");
  log("  logs [name]    View logs (ollama/screenpipe/livepipe-app/all)");
  log("  update         Update LivePipe to latest version");
  log("  config         Edit configuration file");
  log("  help           Show this help message");
  log("");
}

// Main
const args = process.argv.slice(2);
const command = args[0];

(async () => {
  switch (command) {
    case "setup":
      await cmdSetup();
      break;
    case "start":
      await cmdStart();
      break;
    case "stop":
      await cmdStop();
      break;
    case "restart":
      await cmdRestart();
      break;
    case "status":
      await cmdStatus();
      break;
    case "logs":
      await cmdLogs(args[1]);
      break;
    case "update":
      await cmdUpdate();
      break;
    case "config":
      cmdConfig();
      break;
    case "help":
    case "--help":
    case "-h":
      showHelp();
      break;
    default:
      if (command) {
        error(`Unknown command: ${command}\n`);
      }
      showHelp();
      break;
  }
})();
