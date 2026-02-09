#!/usr/bin/env bun

/**
 * Unified dev script:
 * 1. Detect and resolve port conflicts
 * 2. Ensure screenpipe & ollama via PM2 (daemon, auto-restart)
 * 3. Start pipeline directly (foreground)
 * 4. Start Next.js dev server (foreground)
 */

import { spawn, execSync } from "child_process";

const SCREENPIPE_PORT = 3030;
const OLLAMA_PORT = 11434;
const APP_PORT = 3060;

const RED = "\x1b[31m";
const GREEN = "\x1b[32m";
const YELLOW = "\x1b[33m";
const CYAN = "\x1b[36m";
const DIM = "\x1b[2m";
const RESET = "\x1b[0m";

// ── Helpers ──────────────────────────────────────────────

async function isReachable(url: string, timeoutMs = 3000): Promise<boolean> {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const res = await fetch(url, { signal: controller.signal });
    clearTimeout(timer);
    return res.ok || res.status < 500;
  } catch {
    return false;
  }
}

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

function exec(cmd: string): string {
  try {
    return execSync(cmd, { stdio: "pipe", encoding: "utf-8" }).trim();
  } catch {
    return "";
  }
}

// ── Port Conflict Detection ─────────────────────────────

/**
 * Ensure a port is free before starting a service.
 * - Detects PIDs using `lsof`
 * - If the process is PM2-managed, restarts via PM2
 * - Otherwise kills the occupying process
 */
async function ensurePortFree(port: number, serviceName: string): Promise<boolean> {
  const pids = exec(`lsof -ti :${port}`);
  if (!pids) return true; // port is free

  const pidList = pids.split("\n").map((p) => p.trim()).filter(Boolean);
  console.log(
    `${YELLOW}[dev]${RESET} Port ${port} occupied by PID(s): ${pidList.join(", ")} — clearing for ${serviceName}`
  );

  for (const pid of pidList) {
    // Check if this PID belongs to a PM2-managed process
    const pm2Name = getPm2NameForPid(pid);
    if (pm2Name) {
      console.log(`${CYAN}[dev]${RESET} PID ${pid} is PM2 process "${pm2Name}", restarting via PM2...`);
      exec(`pm2 restart ${pm2Name}`);
      continue;
    }

    // Not PM2-managed — kill the orphan process
    const cmdLine = exec(`ps -p ${pid} -o command=`);
    console.log(`${YELLOW}[dev]${RESET} Killing orphan process ${pid}: ${DIM}${cmdLine}${RESET}`);
    try {
      process.kill(Number(pid), "SIGTERM");
    } catch {
      // Process may have already exited
    }
  }

  // Wait for port to become free
  for (let i = 0; i < 10; i++) {
    await sleep(500);
    const stillUsed = exec(`lsof -ti :${port}`);
    if (!stillUsed) {
      console.log(`${GREEN}[dev]${RESET} Port ${port} is now free`);
      return true;
    }
  }

  // Force kill as last resort
  console.log(`${YELLOW}[dev]${RESET} Port ${port} still occupied, force killing...`);
  for (const pid of pidList) {
    try {
      process.kill(Number(pid), "SIGKILL");
    } catch {}
  }
  await sleep(1000);

  const finalCheck = exec(`lsof -ti :${port}`);
  if (!finalCheck) {
    console.log(`${GREEN}[dev]${RESET} Port ${port} is now free`);
    return true;
  }

  console.error(`${RED}[dev]${RESET} ✗ Could not free port ${port}. Please check manually.`);
  return false;
}

// ── PM2 Helpers ─────────────────────────────────────────

function getPm2NameForPid(pid: string): string | null {
  // Parse pm2 jlist to find a process matching this PID
  const raw = exec("pm2 jlist");
  if (!raw) return null;
  try {
    const list = JSON.parse(raw) as Array<{ pid: number; name: string }>;
    const match = list.find((p) => String(p.pid) === pid);
    return match?.name ?? null;
  } catch {
    return null;
  }
}

function pm2IsRunning(name: string): boolean {
  const raw = exec("pm2 jlist");
  if (!raw) return false;
  try {
    const list = JSON.parse(raw) as Array<{ name: string; pm2_env?: { status: string } }>;
    return list.some((p) => p.name === name && p.pm2_env?.status === "online");
  } catch {
    return false;
  }
}

function pm2Start(name: string, script: string, args: string[]): boolean {
  const argsStr = args.length > 0 ? ` -- ${args.join(" ")}` : "";
  const cmd = `pm2 start ${script} --name ${name} --restart-delay 5000 --max-restarts 10${argsStr}`;
  console.log(`${CYAN}[dev]${RESET} Starting ${name} via PM2...`);
  const result = exec(cmd);
  return result !== "" || pm2IsRunning(name);
}

// ── Dependency Checks ────────────────────────────────────

async function checkScreenpipe(): Promise<boolean> {
  if (pm2IsRunning("screenpipe")) {
    console.log(`${GREEN}[dev]${RESET} ✓ screenpipe ${DIM}(PM2, port ${SCREENPIPE_PORT})${RESET}`);
    return true;
  }

  // Port might be occupied by a non-PM2 screenpipe or something else
  await ensurePortFree(SCREENPIPE_PORT, "screenpipe");

  // Check if PM2 has a stopped screenpipe entry — restart it
  const raw = exec("pm2 jlist");
  if (raw) {
    try {
      const list = JSON.parse(raw) as Array<{ name: string; pm2_env?: { status: string } }>;
      const existing = list.find((p) => p.name === "screenpipe");
      if (existing) {
        console.log(`${CYAN}[dev]${RESET} Restarting existing PM2 screenpipe process...`);
        exec("pm2 restart screenpipe");
        await sleep(2000);
        if (pm2IsRunning("screenpipe")) {
          console.log(`${GREEN}[dev]${RESET} ✓ screenpipe restarted via PM2`);
          return await waitForService(`http://localhost:${SCREENPIPE_PORT}/health`, "screenpipe", 15, 2000);
        }
      }
    } catch {}
  }

  // Start fresh via PM2
  console.log(`${YELLOW}[dev]${RESET} screenpipe not running, starting via PM2...`);
  const ok = pm2Start("screenpipe", "screenpipe", ["--enable-realtime-vision"]);
  if (!ok) {
    console.error(`${RED}[dev]${RESET} ✗ screenpipe failed to start. Is it installed?`);
    console.error(`${DIM}       Install: brew install screenpipe${RESET}`);
    return false;
  }

  return await waitForService(`http://localhost:${SCREENPIPE_PORT}/health`, "screenpipe", 15, 2000);
}

async function checkOllama(): Promise<boolean> {
  if (pm2IsRunning("ollama")) {
    console.log(`${GREEN}[dev]${RESET} ✓ ollama ${DIM}(PM2, port ${OLLAMA_PORT})${RESET}`);
    return true;
  }

  // Ollama might already be running outside PM2 (e.g. Ollama.app)
  if (await isReachable(`http://localhost:${OLLAMA_PORT}`)) {
    console.log(`${GREEN}[dev]${RESET} ✓ ollama ${DIM}(external, port ${OLLAMA_PORT})${RESET}`);
    return true;
  }

  // Check for stopped PM2 entry
  const raw = exec("pm2 jlist");
  if (raw) {
    try {
      const list = JSON.parse(raw) as Array<{ name: string; pm2_env?: { status: string } }>;
      const existing = list.find((p) => p.name === "ollama");
      if (existing) {
        console.log(`${CYAN}[dev]${RESET} Restarting existing PM2 ollama process...`);
        exec("pm2 restart ollama");
        await sleep(2000);
        if (pm2IsRunning("ollama")) {
          return await waitForService(`http://localhost:${OLLAMA_PORT}`, "ollama", 10, 1000);
        }
      }
    } catch {}
  }

  // Start fresh via PM2
  console.log(`${YELLOW}[dev]${RESET} ollama not running, starting via PM2...`);
  const ok = pm2Start("ollama", "ollama", ["serve"]);
  if (!ok) {
    console.error(`${RED}[dev]${RESET} ✗ ollama failed to start. Is it installed?`);
    console.error(`${DIM}       Install: brew install ollama${RESET}`);
    return false;
  }

  return await waitForService(`http://localhost:${OLLAMA_PORT}`, "ollama", 10, 1000);
}

async function waitForService(
  url: string,
  name: string,
  maxAttempts: number,
  intervalMs: number
): Promise<boolean> {
  for (let i = 0; i < maxAttempts; i++) {
    if (await isReachable(url)) {
      console.log(`${GREEN}[dev]${RESET} ✓ ${name} started`);
      return true;
    }
    await sleep(intervalMs);
  }
  console.log(`${YELLOW}[dev]${RESET} ~ ${name} started but API slow — continuing`);
  return true;
}

// ── Main ─────────────────────────────────────────────────

async function main() {
  console.log(`\n${CYAN}[dev]${RESET} Checking dependencies...\n`);

  // Check dependencies in parallel
  const [sp, ol] = await Promise.all([checkScreenpipe(), checkOllama()]);

  if (!sp || !ol) {
    const missing = [!sp && "screenpipe", !ol && "ollama"].filter(Boolean);
    console.error(
      `\n${YELLOW}[dev]${RESET} Warning: ${missing.join(", ")} not available. Some features may not work.\n`
    );
  } else {
    console.log(`\n${GREEN}[dev]${RESET} All dependencies ready.\n`);
  }

  // Ensure Next.js port is free before starting
  const portFree = await ensurePortFree(APP_PORT, "next.js");
  if (!portFree) {
    console.error(`${RED}[dev]${RESET} ✗ Cannot start Next.js — port ${APP_PORT} is unavailable`);
    process.exit(1);
  }

  // Start pipeline directly — no Next.js dependency
  const { startPipeline } = await import("../src/lib/pipeline");
  startPipeline();

  // Start Next.js dev server as optional dashboard
  const next = spawn("npx", ["next", "dev", "--turbopack", "--port", String(APP_PORT)], {
    stdio: "inherit",
    cwd: process.cwd(),
    env: { ...process.env },
  });

  // Cleanup handler
  let exiting = false;
  const cleanup = (signal: string) => {
    if (exiting) return;
    exiting = true;

    console.log(`\n${CYAN}[dev]${RESET} Shutting down...`);
    next.kill(signal as NodeJS.Signals);

    // PM2 services keep running in background — that's the point
    console.log(`${DIM}[dev] screenpipe & ollama continue running via PM2.`);
    console.log(`[dev] To stop them: pm2 stop screenpipe ollama${RESET}`);
  };

  process.on("SIGINT", () => cleanup("SIGINT"));
  process.on("SIGTERM", () => cleanup("SIGTERM"));

  next.on("exit", (code) => {
    process.exit(code ?? 0);
  });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
