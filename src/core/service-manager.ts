import {spawn, spawnSync} from "node:child_process";
import {closeSync, openSync} from "node:fs";
import {mkdir, readFile, rm, writeFile} from "node:fs/promises";
import {basename, join} from "node:path";
import {setTimeout as delay} from "node:timers/promises";
import {GatewayWsClient} from "../gateway/client.ts";
import type {AppConfig} from "./types.ts";

export type ManagedServiceName = "gateway" | "telegram";

export interface ManagedServicePaths {
  pidFile: string;
  readyFile: string;
  logFile: string;
}

export interface ManagedServiceStartResult {
  name: ManagedServiceName;
  pid: number;
  logFile: string;
  alreadyRunning: boolean;
}

const SERVICE_READY_ENV = "BINACLAW_SERVICE_READY_FILE";
const READY_TIMEOUT_MS: Record<ManagedServiceName, number> = {
  gateway: 12_000,
  telegram: 25_000,
};

export function getManagedServicePaths(config: AppConfig, name: ManagedServiceName): ManagedServicePaths {
  return {
    pidFile: join(config.runtimeDir, `${name}.pid`),
    readyFile: join(config.runtimeDir, `${name}.ready.json`),
    logFile: join(config.logDir, `${name}.log`),
  };
}

export function getLocalGatewayUrl(config: AppConfig): string {
  const host = config.gateway.host === "0.0.0.0" ? "127.0.0.1" : config.gateway.host;
  return `ws://${host}:${config.gateway.port}`;
}

export async function markManagedServiceReady(name: ManagedServiceName, details?: Record<string, unknown>): Promise<void> {
  const readyFile = process.env[SERVICE_READY_ENV];
  if (!readyFile) {
    return;
  }

  await writeFile(
    readyFile,
    `${JSON.stringify({
      name,
      pid: process.pid,
      readyAt: new Date().toISOString(),
      ...details,
    })}\n`,
    "utf8",
  );
}

export async function startManagedService(
  config: AppConfig,
  name: ManagedServiceName,
  entryScript = process.argv[1],
): Promise<ManagedServiceStartResult> {
  if (!entryScript) {
    throw new Error("无法确定当前 CLI 入口，无法启动后台服务。");
  }

  const paths = getManagedServicePaths(config, name);
  await mkdir(config.runtimeDir, { recursive: true });
  await mkdir(config.logDir, { recursive: true });

  const existingPid = await readPid(paths.pidFile);
  if (existingPid && isProcessRunning(existingPid) && isManagedServiceProcess(existingPid, name, entryScript)) {
    if (name === "gateway") {
      await assertGatewayHealthy(config);
    }
    return {
      name,
      pid: existingPid,
      logFile: paths.logFile,
      alreadyRunning: true,
    };
  }

  await cleanupManagedServiceFiles(paths);

  const logFd = openSync(paths.logFile, "a");
  const child = spawn(process.execPath, [entryScript, name], {
    cwd: config.cwd,
    detached: true,
    stdio: ["ignore", logFd, logFd],
    env: {
      ...process.env,
      BINACLAW_HOME: config.appHome,
      BINACLAW_GATEWAY_URL: name === "telegram" ? getLocalGatewayUrl(config) : process.env.BINACLAW_GATEWAY_URL,
      [SERVICE_READY_ENV]: paths.readyFile,
    },
  });
  closeSync(logFd);
  child.unref();

  if (!child.pid) {
    throw new Error(`启动 ${name} 服务失败。`);
  }

  await writeFile(paths.pidFile, `${child.pid}\n`, "utf8");

  try {
    await waitForReadyFile(paths.readyFile, child.pid, READY_TIMEOUT_MS[name]);
    if (name === "gateway") {
      await assertGatewayHealthy(config);
    }
  } catch (error) {
    await stopManagedService(config, name);
    const logTail = await readLogTail(paths.logFile);
    throw new Error(
      [
        error instanceof Error ? error.message : String(error),
        logTail ? `最近日志:\n${logTail}` : "",
      ]
        .filter(Boolean)
        .join("\n\n"),
    );
  }

  return {
    name,
    pid: child.pid,
    logFile: paths.logFile,
    alreadyRunning: false,
  };
}

export async function stopManagedService(config: AppConfig, name: ManagedServiceName): Promise<boolean> {
  const paths = getManagedServicePaths(config, name);
  const pid = await readPid(paths.pidFile);
  if (!pid) {
    await cleanupManagedServiceFiles(paths);
    return false;
  }

  if (isProcessRunning(pid) && isManagedServiceProcess(pid, name, process.argv[1])) {
    process.kill(pid, "SIGTERM");
    const stopped = await waitForProcessExit(pid, 5_000);
    if (!stopped && isProcessRunning(pid)) {
      process.kill(pid, "SIGKILL");
      await waitForProcessExit(pid, 2_000);
    }
  }

  await cleanupManagedServiceFiles(paths);
  return true;
}

async function assertGatewayHealthy(config: AppConfig): Promise<void> {
  const client = new GatewayWsClient({
    ...config,
    gateway: {
      ...config.gateway,
      url: getLocalGatewayUrl(config),
    },
  });

  try {
    await client.connect();
    await client.health();
  } finally {
    await client.close();
  }
}

async function waitForReadyFile(readyFile: string, pid: number, timeoutMs: number): Promise<void> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    try {
      const raw = await readFile(readyFile, "utf8");
      if (raw.trim()) {
        return;
      }
    } catch {
      // Keep waiting.
    }

    if (!isProcessRunning(pid)) {
      throw new Error("后台服务在完成初始化前就退出了。");
    }
    await delay(200);
  }

  throw new Error("后台服务启动超时。");
}

async function waitForProcessExit(pid: number, timeoutMs: number): Promise<boolean> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (!isProcessRunning(pid)) {
      return true;
    }
    await delay(100);
  }
  return !isProcessRunning(pid);
}

function isProcessRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "EPERM") {
      return true;
    }
    return false;
  }
}

function isManagedServiceProcess(pid: number, name: ManagedServiceName, entryScript = process.argv[1]): boolean {
  if (!entryScript || process.platform === "win32") {
    return false;
  }

  const result = spawnSync("ps", ["-p", String(pid), "-o", "command="], {
    encoding: "utf8",
  });
  if (result.status !== 0) {
    return false;
  }

  const commandLine = result.stdout.trim();
  const entryName = basename(entryScript);
  return commandLine.includes(entryName) && commandLine.includes(` ${name}`);
}

async function readPid(pidFile: string): Promise<number | undefined> {
  try {
    const raw = await readFile(pidFile, "utf8");
    const pid = Number(raw.trim());
    return Number.isInteger(pid) && pid > 0 ? pid : undefined;
  } catch {
    return undefined;
  }
}

async function cleanupManagedServiceFiles(paths: ManagedServicePaths): Promise<void> {
  await Promise.all([
    rm(paths.pidFile, { force: true }),
    rm(paths.readyFile, { force: true }),
  ]);
}

async function readLogTail(logFile: string): Promise<string> {
  try {
    const raw = await readFile(logFile, "utf8");
    return raw
      .trim()
      .split("\n")
      .slice(-12)
      .join("\n");
  } catch {
    return "";
  }
}
