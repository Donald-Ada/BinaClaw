import {existsSync, readFileSync, readdirSync, statSync} from "node:fs";
import {chmod, mkdir, readFile, rm, writeFile} from "node:fs/promises";
import {homedir} from "node:os";
import {dirname, join, resolve} from "node:path";
import {fileURLToPath} from "node:url";
import type {AppConfig, StoredAppConfig} from "./types.ts";

const MODULE_DIR = dirname(fileURLToPath(import.meta.url));

export function createAppConfig(
  env: Record<string, string | undefined> = process.env,
  cwd = process.cwd(),
): AppConfig {
  const appHome = resolve(env.BINACLAW_HOME ?? join(homedir(), ".binaclaw"));
  const configFile = join(appHome, "config.json");
  const localEnvFile = join(appHome, "env.local");
  const stored = loadStoredConfig(configFile);
  const localEnv = loadLocalEnvFile(localEnvFile);
  const useTestnet = readBoolean(env.BINANCE_USE_TESTNET, stored.binance?.useTestnet ?? false);
  const recvWindow = readNumber(env.BINANCE_RECV_WINDOW, stored.binance?.recvWindow ?? 5000);
  const gatewayPort = readNumber(
    env.BINACLAW_GATEWAY_PORT,
    stored.gateway?.port ?? 8787,
  );
  const telegramPollingTimeoutSeconds = readNumber(
    env.TELEGRAM_POLLING_TIMEOUT,
    stored.telegram?.pollingTimeoutSeconds ?? 20,
  );

  return {
    cwd,
    appHome,
    configFile,
    localEnvFile,
    bundledSkillsDir: resolve(env.BINACLAW_BUNDLED_SKILLS_DIR ?? resolveBundledSkillsDir()),
    runtimeDir: join(appHome, "run"),
    logDir: join(appHome, "logs"),
    workspaceDir: join(appHome, "workspace"),
    workspaceAgentsFile: join(appHome, "workspace", "AGENTS.md"),
    workspaceSoulFile: join(appHome, "workspace", "SOUL.md"),
    workspaceUserFile: join(appHome, "workspace", "USER.md"),
    workspaceIdentityFile: join(appHome, "workspace", "IDENTITY.md"),
    workspaceHeartbeatFile: join(appHome, "workspace", "HEARTBEAT.md"),
    workspaceBootstrapFile: join(appHome, "workspace", "BOOTSTRAP.md"),
    workspaceSessionsDir: join(appHome, "workspace", "sessions"),
    workspaceSessionsIndexFile: join(appHome, "workspace", "sessions", "sessions.json"),
    workspaceSessionTranscriptsDir: join(appHome, "workspace", "sessions"),
    workspaceSkillsDir: join(appHome, "workspace", "skills"),
    workspaceToolsFile: join(appHome, "workspace", "TOOLS.md"),
    workspaceMemoryDir: join(appHome, "workspace", "memory"),
    workspaceLongTermMemoryFile: join(appHome, "workspace", "MEMORY.md"),
    globalSkillsDir: join(appHome, "skills"),
    localSkillsDir: resolve(cwd, "skills"),
    memoryFile: join(appHome, "memory.json"),
    gateway: {
      url: env.BINACLAW_GATEWAY_URL ?? stored.gateway?.url,
      host: env.BINACLAW_GATEWAY_HOST ?? stored.gateway?.host ?? "127.0.0.1",
      port: gatewayPort,
    },
    telegram: {
      botToken: env.TELEGRAM_BOT_TOKEN ?? stored.telegram?.botToken,
      apiBaseUrl: env.TELEGRAM_BOT_API_BASE_URL ?? stored.telegram?.apiBaseUrl ?? "https://api.telegram.org",
      pollingTimeoutSeconds: telegramPollingTimeoutSeconds,
      allowedUserIds: readCsv(env.TELEGRAM_ALLOWED_USER_IDS, stored.telegram?.allowedUserIds ?? []),
      allowedChatIds: readCsv(env.TELEGRAM_ALLOWED_CHAT_IDS, stored.telegram?.allowedChatIds ?? []),
    },
    provider: {
      apiKey: env.OPENAI_API_KEY ?? stored.provider?.apiKey,
      baseUrl: env.OPENAI_BASE_URL ?? stored.provider?.baseUrl ?? "https://api.openai.com/v1",
      model: env.OPENAI_MODEL ?? stored.provider?.model ?? "gpt-4o-mini",
    },
    binance: {
      apiKey: env.BINANCE_API_KEY ?? localEnv.BINANCE_API_KEY,
      apiSecret: env.BINANCE_API_SECRET ?? localEnv.BINANCE_API_SECRET,
      squareOpenApiKey: env.BINANCE_SQUARE_OPENAPI_KEY ?? localEnv.BINANCE_SQUARE_OPENAPI_KEY,
      useTestnet,
      recvWindow,
      spotBaseUrl:
        env.BINANCE_SPOT_BASE_URL ??
        stored.binance?.spotBaseUrl ??
        (useTestnet ? "https://testnet.binance.vision" : "https://api.binance.com"),
      futuresBaseUrl:
        env.BINANCE_FUTURES_BASE_URL ??
        stored.binance?.futuresBaseUrl ??
        (useTestnet ? "https://testnet.binancefuture.com" : "https://fapi.binance.com"),
      sapiBaseUrl:
        env.BINANCE_SAPI_BASE_URL ??
        stored.binance?.sapiBaseUrl ??
        (useTestnet ? "https://testnet.binance.vision" : "https://api.binance.com"),
      webBaseUrl: env.BINANCE_WEB_BASE_URL ?? stored.binance?.webBaseUrl ?? "https://www.binance.com",
    },
    brave: {
      apiKey: env.BRAVE_SEARCH_API_KEY ?? stored.brave?.apiKey,
      baseUrl: env.BRAVE_SEARCH_BASE_URL ?? stored.brave?.baseUrl ?? "https://api.search.brave.com/res/v1",
      defaultCountry: env.BRAVE_SEARCH_COUNTRY ?? stored.brave?.defaultCountry ?? "US",
      searchLanguage: env.BRAVE_SEARCH_LANG ?? stored.brave?.searchLanguage ?? "zh-hans",
      uiLanguage: env.BRAVE_UI_LANG ?? stored.brave?.uiLanguage ?? "zh-CN",
    },
  };
}

function resolveBundledSkillsDir(): string {
  const candidates = [
    resolve(MODULE_DIR, "../../skills"),
    resolve(MODULE_DIR, "../skills"),
    resolve(MODULE_DIR, "skills"),
  ];
  const matched = candidates.find((candidate) => hasSkillPackages(candidate));
  return matched ?? candidates[0]!;
}

function hasSkillPackages(directory: string): boolean {
  if (!existsSync(directory)) {
    return false;
  }
  try {
    const entries = readdirSync(directory, { withFileTypes: true });
    return entries.some((entry) => {
      if (entry.isFile() && entry.name.toLowerCase() === "skill.md") {
        return true;
      }
      if (!entry.isDirectory()) {
        return false;
      }
      const nested = join(directory, entry.name, "SKILL.md");
      return existsSync(nested) && statSync(nested).isFile();
    });
  } catch {
    return false;
  }
}

export async function ensureAppDirectories(config: AppConfig): Promise<void> {
  await mkdir(config.appHome, { recursive: true });
  await mkdir(config.runtimeDir, { recursive: true });
  await mkdir(config.logDir, { recursive: true });
  await mkdir(config.globalSkillsDir, { recursive: true });
  await mkdir(config.workspaceDir, { recursive: true });
  await mkdir(config.workspaceSessionsDir, { recursive: true });
  await mkdir(config.workspaceSkillsDir, { recursive: true });
  await mkdir(config.workspaceMemoryDir, { recursive: true });
  await purgeStoredSecrets(config.configFile);
}

export function loadLocalEnvFile(localEnvFile: string): Record<string, string> {
  if (!existsSync(localEnvFile)) {
    return {};
  }

  try {
    return parseEnvFile(readFileSync(localEnvFile, "utf8"));
  } catch {
    return {};
  }
}

export async function saveLocalEnvFile(
  localEnvFile: string,
  updates: Record<string, string | undefined>,
): Promise<void> {
  const current = loadLocalEnvFile(localEnvFile);
  const next = {
    ...current,
    ...updates,
  };

  for (const [key, value] of Object.entries(next)) {
    if (!value) {
      delete next[key];
    }
  }

  const keys = Object.keys(next).sort();
  if (keys.length === 0) {
    await rm(localEnvFile, { force: true });
    return;
  }

  const body = `${keys.map((key) => `${key}=${quoteEnvValue(next[key]!)}`).join("\n")}\n`;
  await writeFile(localEnvFile, body, { encoding: "utf8", mode: 0o600 });
  await chmod(localEnvFile, 0o600);
}

export function loadStoredConfig(configFile: string): StoredAppConfig {
  if (!existsSync(configFile)) {
    return {};
  }

  try {
    const raw = readFileSync(configFile, "utf8");
    const parsed = JSON.parse(raw) as StoredAppConfig;
    return parsed && typeof parsed === "object" ? stripStoredSecrets(parsed) : {};
  } catch {
    return {};
  }
}

export async function saveStoredConfig(configFile: string, input: StoredAppConfig): Promise<void> {
  const sanitized = sanitizeStoredConfig(input);
  await writeFile(configFile, `${JSON.stringify(sanitized, null, 2)}\n`, "utf8");
}

function sanitizeStoredConfig(input: StoredAppConfig): StoredAppConfig {
  const stripped = stripStoredSecrets(input);
  return {
    provider: sanitizeSection(stripped.provider),
    binance: sanitizeSection(stripped.binance),
    brave: sanitizeSection(stripped.brave),
    gateway: sanitizeSection(stripped.gateway),
    telegram: sanitizeSection(stripped.telegram),
  };
}

function stripStoredSecrets(input: StoredAppConfig): StoredAppConfig {
  return {
    provider: input.provider,
    binance: input.binance
      ? {
          useTestnet: input.binance.useTestnet,
          recvWindow: input.binance.recvWindow,
          spotBaseUrl: input.binance.spotBaseUrl,
          futuresBaseUrl: input.binance.futuresBaseUrl,
          sapiBaseUrl: input.binance.sapiBaseUrl,
          webBaseUrl: input.binance.webBaseUrl,
        }
      : undefined,
    brave: input.brave,
    gateway: input.gateway,
    telegram: input.telegram,
  };
}

async function purgeStoredSecrets(configFile: string): Promise<void> {
  if (!existsSync(configFile)) {
    return;
  }

  try {
    const raw = await readFile(configFile, "utf8");
    const parsed = JSON.parse(raw) as StoredAppConfig;
    const sanitized = sanitizeStoredConfig(parsed && typeof parsed === "object" ? parsed : {});
    const nextRaw = `${JSON.stringify(sanitized, null, 2)}\n`;
    if (raw !== nextRaw) {
      await writeFile(configFile, nextRaw, "utf8");
    }
  } catch {
    return;
  }
}

function sanitizeSection<T extends object>(section: T | undefined): T | undefined {
  if (!section) {
    return undefined;
  }
  const filtered = Object.fromEntries(
    Object.entries(section).filter(([, value]) => value !== undefined && value !== ""),
  );
  return Object.keys(filtered).length > 0 ? (filtered as T) : undefined;
}

function parseEnvFile(raw: string): Record<string, string> {
  const values: Record<string, string> = {};
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) {
      continue;
    }
    const normalized = trimmed.startsWith("export ") ? trimmed.slice(7).trim() : trimmed;
    const delimiter = normalized.indexOf("=");
    if (delimiter <= 0) {
      continue;
    }
    const key = normalized.slice(0, delimiter).trim();
    const value = normalized.slice(delimiter + 1).trim();
    values[key] = unquoteEnvValue(value);
  }
  return values;
}

function quoteEnvValue(value: string): string {
  return JSON.stringify(value);
}

function unquoteEnvValue(value: string): string {
  if (
    (value.startsWith("\"") && value.endsWith("\"")) ||
    (value.startsWith("'") && value.endsWith("'"))
  ) {
    try {
      return JSON.parse(value.startsWith("'") ? `"${value.slice(1, -1).replace(/"/g, "\\\"")}"` : value);
    } catch {
      return value.slice(1, -1);
    }
  }
  return value;
}

function readBoolean(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined) {
    return fallback;
  }
  return value === "true";
}

function readNumber(value: string | undefined, fallback: number): number {
  if (value === undefined) {
    return fallback;
  }
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function readCsv(value: string | undefined, fallback: string[]): string[] {
  if (value === undefined) {
    return fallback;
  }
  return value
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}
