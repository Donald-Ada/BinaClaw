import {createInterface, type Interface} from "node:readline/promises";
import {stdin as input, stdout as output} from "node:process";
import {createAppConfig, ensureAppDirectories, loadStoredConfig, saveStoredConfig} from "../core/config.ts";
import type {AppConfig, StoredAppConfig} from "../core/types.ts";

export function formatConfigSummary(config: AppConfig): string {
  return [
    `配置文件: ${config.configFile}`,
    `OPENAI_API_KEY: ${config.provider.apiKey ? "present" : "missing"}`,
    `OPENAI_BASE_URL: ${config.provider.baseUrl ?? "missing"}`,
    `OPENAI_MODEL: ${config.provider.model ?? "missing"}`,
    `BINACLAW_GATEWAY_URL: ${config.gateway.url ?? "disabled"}`,
    `BINACLAW_GATEWAY_HOST: ${config.gateway.host}`,
    `BINACLAW_GATEWAY_PORT: ${config.gateway.port}`,
    `TELEGRAM_BOT_TOKEN: ${config.telegram.botToken ? "present" : "missing"}`,
    `BRAVE_SEARCH_API_KEY: ${config.brave.apiKey ? "present" : "missing"}`,
    `BINANCE_API_KEY: ${config.binance.apiKey ? "present (env)" : "missing (env)"}`,
    `BINANCE_API_SECRET: ${config.binance.apiSecret ? "present (env)" : "missing (env)"}`,
    `BINANCE_USE_TESTNET: ${config.binance.useTestnet ? "true" : "false"}`,
    `SESSION_MESSAGE_LIMIT: ${config.session.messageCompactionLimit}`,
    `SESSION_SCRATCHPAD_LIMIT: ${config.session.scratchpadCompactionLimit}`,
    `SESSION_CHAR_LIMIT: ${config.session.charCompactionLimit}`,
    `SESSION_RETAIN_MESSAGES: ${config.session.retainRecentMessages}`,
    `SESSION_RETAIN_SCRATCHPAD: ${config.session.retainRecentScratchpad}`,
    `SESSION_MAX_COMPACTIONS: ${config.session.maxCompactionRecords}`,
  ].join("\n");
}

export async function runInteractiveConfigWizard(existingRl?: Interface): Promise<AppConfig> {
  const rl = existingRl ?? createInterface({ input, output });
  const config = createAppConfig();
  await ensureAppDirectories(config);
  const stored = loadStoredConfig(config.configFile);

  output.write(
    [
      "开始配置 BinaClaw。",
      "留空表示保持当前值，输入 `-` 表示清空当前配置。",
      "Binance 金融密钥不会写入 config.json，只能通过本机环境变量提供。",
      "请通过本机环境变量设置: BINANCE_API_KEY, BINANCE_API_SECRET。",
      `配置文件会保存到: ${config.configFile}`,
    ].join("\n") + "\n",
  );

  const nextConfig: StoredAppConfig = {
    provider: {
      apiKey: await promptText(rl, "OPENAI_API_KEY", stored.provider?.apiKey),
      baseUrl: await promptText(rl, "OPENAI_BASE_URL", stored.provider?.baseUrl ?? "https://api.openai.com/v1"),
      model: await promptText(rl, "OPENAI_MODEL", stored.provider?.model ?? "gpt-4o-mini"),
    },
    gateway: {
      url: await promptText(rl, "BINACLAW_GATEWAY_URL", stored.gateway?.url),
      host: await promptText(rl, "BINACLAW_GATEWAY_HOST", stored.gateway?.host ?? config.gateway.host),
      port: await promptNumber(
        rl,
        "BINACLAW_GATEWAY_PORT",
        stored.gateway?.port ?? config.gateway.port,
      ),
    },
    telegram: {
      botToken: await promptText(rl, "TELEGRAM_BOT_TOKEN", stored.telegram?.botToken),
      apiBaseUrl: await promptText(rl, "TELEGRAM_BOT_API_BASE_URL", stored.telegram?.apiBaseUrl ?? config.telegram.apiBaseUrl),
      pollingTimeoutSeconds: await promptNumber(
        rl,
        "TELEGRAM_POLLING_TIMEOUT",
        stored.telegram?.pollingTimeoutSeconds ?? config.telegram.pollingTimeoutSeconds,
      ),
      allowedUserIds: await promptCsv(rl, "TELEGRAM_ALLOWED_USER_IDS", stored.telegram?.allowedUserIds ?? config.telegram.allowedUserIds),
      allowedChatIds: await promptCsv(rl, "TELEGRAM_ALLOWED_CHAT_IDS", stored.telegram?.allowedChatIds ?? config.telegram.allowedChatIds),
    },
    brave: {
      apiKey: await promptText(rl, "BRAVE_SEARCH_API_KEY", stored.brave?.apiKey),
      baseUrl: await promptText(rl, "BRAVE_SEARCH_BASE_URL", stored.brave?.baseUrl ?? config.brave.baseUrl),
      defaultCountry: await promptText(rl, "BRAVE_SEARCH_COUNTRY", stored.brave?.defaultCountry ?? config.brave.defaultCountry),
      searchLanguage: await promptText(rl, "BRAVE_SEARCH_LANG", stored.brave?.searchLanguage ?? config.brave.searchLanguage),
      uiLanguage: await promptText(rl, "BRAVE_UI_LANG", stored.brave?.uiLanguage ?? config.brave.uiLanguage),
    },
    binance: {
      useTestnet: await promptBoolean(rl, "BINANCE_USE_TESTNET", stored.binance?.useTestnet ?? false),
      recvWindow: await promptNumber(rl, "BINANCE_RECV_WINDOW", stored.binance?.recvWindow ?? config.binance.recvWindow),
      spotBaseUrl: await promptText(rl, "BINANCE_SPOT_BASE_URL", stored.binance?.spotBaseUrl ?? config.binance.spotBaseUrl),
      futuresBaseUrl: await promptText(rl, "BINANCE_FUTURES_BASE_URL", stored.binance?.futuresBaseUrl ?? config.binance.futuresBaseUrl),
      sapiBaseUrl: await promptText(rl, "BINANCE_SAPI_BASE_URL", stored.binance?.sapiBaseUrl ?? config.binance.sapiBaseUrl),
      webBaseUrl: await promptText(rl, "BINANCE_WEB_BASE_URL", stored.binance?.webBaseUrl ?? config.binance.webBaseUrl),
    },
    session: {
      messageCompactionLimit: await promptNumber(
        rl,
        "SESSION_MESSAGE_LIMIT",
        stored.session?.messageCompactionLimit ?? config.session.messageCompactionLimit,
      ),
      scratchpadCompactionLimit: await promptNumber(
        rl,
        "SESSION_SCRATCHPAD_LIMIT",
        stored.session?.scratchpadCompactionLimit ?? config.session.scratchpadCompactionLimit,
      ),
      charCompactionLimit: await promptNumber(
        rl,
        "SESSION_CHAR_LIMIT",
        stored.session?.charCompactionLimit ?? config.session.charCompactionLimit,
      ),
      retainRecentMessages: await promptNumber(
        rl,
        "SESSION_RETAIN_MESSAGES",
        stored.session?.retainRecentMessages ?? config.session.retainRecentMessages,
      ),
      retainRecentScratchpad: await promptNumber(
        rl,
        "SESSION_RETAIN_SCRATCHPAD",
        stored.session?.retainRecentScratchpad ?? config.session.retainRecentScratchpad,
      ),
      maxCompactionRecords: await promptNumber(
        rl,
        "SESSION_MAX_COMPACTIONS",
        stored.session?.maxCompactionRecords ?? config.session.maxCompactionRecords,
      ),
    },
  };

  await saveStoredConfig(config.configFile, mergeStoredConfig(stored, nextConfig));
  const refreshed = createAppConfig();
  output.write(`配置已保存。\n${formatConfigSummary(refreshed)}\n`);

  if (!existingRl) {
    rl.close();
  }

  return refreshed;
}

function mergeStoredConfig(current: StoredAppConfig, updates: StoredAppConfig): StoredAppConfig {
  return {
    provider: {
      ...current.provider,
      ...updates.provider,
    },
    brave: {
      ...current.brave,
      ...updates.brave,
    },
    gateway: {
      ...current.gateway,
      ...updates.gateway,
    },
    telegram: {
      ...current.telegram,
      ...updates.telegram,
    },
    binance: {
      ...current.binance,
      ...updates.binance,
    },
    session: {
      ...current.session,
      ...updates.session,
    },
  };
}

async function promptText(rl: Interface, key: string, current?: string): Promise<string | undefined> {
  const currentLabel = current ?? "missing";
  const answer = (await rl.question(`${key} [当前: ${currentLabel}] > `)).trim();
  if (!answer) {
    return current;
  }
  if (answer === "-") {
    return undefined;
  }
  return answer;
}

async function promptBoolean(rl: Interface, key: string, current: boolean): Promise<boolean> {
  const answer = (await rl.question(`${key} [当前: ${current ? "true" : "false"}] (true/false) > `)).trim().toLowerCase();
  if (!answer) {
    return current;
  }
  if (answer === "-") {
    return false;
  }
  return answer === "true" || answer === "yes" || answer === "y";
}

async function promptNumber(rl: Interface, key: string, current: number): Promise<number | undefined> {
  while (true) {
    const answer = (await rl.question(`${key} [当前: ${current}] > `)).trim();
    if (!answer) {
      return current;
    }
    if (answer === "-") {
      return undefined;
    }
    const parsed = Number(answer);
    if (Number.isFinite(parsed) && parsed > 0) {
      return parsed;
    }
    output.write("请输入一个大于 0 的数字，或留空保持当前值。\n");
  }
}

async function promptCsv(rl: Interface, key: string, current: string[]): Promise<string[] | undefined> {
  const currentLabel = current.length > 0 ? current.join(",") : "empty";
  const answer = (await rl.question(`${key} [当前: ${currentLabel}] > `)).trim();
  if (!answer) {
    return current;
  }
  if (answer === "-") {
    return [];
  }
  return answer
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}
