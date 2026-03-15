import {createInterface, type Interface} from "node:readline/promises";
import {stdin as input, stdout as output} from "node:process";
import {createAppConfig, ensureAppDirectories, loadStoredConfig, saveLocalEnvFile, saveStoredConfig} from "../core/config.ts";
import type {AppConfig, StoredAppConfig} from "../core/types.ts";

type PromptTextOptions = {
  sensitive?: boolean;
  required?: boolean;
};

export function formatConfigSummary(config: AppConfig): string {
  return [
    `配置文件: ${config.configFile}`,
    `本机环境文件: ${config.localEnvFile}`,
    `OPENAI_API_KEY: ${config.provider.apiKey ? "present" : "missing"}`,
    `OPENAI_BASE_URL: ${config.provider.baseUrl ?? "missing"}`,
    `OPENAI_MODEL: ${config.provider.model ?? "missing"}`,
    `BINACLAW_GATEWAY_URL: ${config.gateway.url ?? "disabled"}`,
    `BINACLAW_GATEWAY_HOST: ${config.gateway.host}`,
    `BINACLAW_GATEWAY_PORT: ${config.gateway.port}`,
    `TELEGRAM_BOT_TOKEN: ${config.telegram.botToken ? "present" : "missing"}`,
    `BRAVE_SEARCH_API_KEY: ${config.brave.apiKey ? "present" : "missing"}`,
    `BINANCE_API_KEY: ${config.binance.apiKey ? "present (shell/local env)" : "missing"}`,
    `BINANCE_API_SECRET: ${config.binance.apiSecret ? "present (shell/local env)" : "missing"}`,
    `BINANCE_USE_TESTNET: ${config.binance.useTestnet ? "true" : "false"}`,
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
      `如需管理 Binance 金融密钥，请使用 binaclaw onboard，它会写入本机环境文件: ${config.localEnvFile}`,
      `配置文件会保存到: ${config.configFile}`,
    ].join("\n") + "\n",
  );

  const nextConfig: StoredAppConfig = {
    provider: {
      apiKey: await promptText(rl, "OPENAI_API_KEY", stored.provider?.apiKey, { sensitive: true }),
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
      botToken: await promptText(rl, "TELEGRAM_BOT_TOKEN", stored.telegram?.botToken, { sensitive: true }),
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
      apiKey: await promptText(rl, "BRAVE_SEARCH_API_KEY", stored.brave?.apiKey, { sensitive: true }),
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
  };

  await saveStoredConfig(config.configFile, mergeStoredConfig(stored, nextConfig));
  const refreshed = createAppConfig();
  output.write(`配置已保存。\n${formatConfigSummary(refreshed)}\n`);

  if (!existingRl) {
    rl.close();
  }

  return refreshed;
}

export async function runOnboardingWizard(existingRl?: Interface): Promise<AppConfig> {
  const rl = existingRl ?? createInterface({ input, output });
  const config = createAppConfig();
  await ensureAppDirectories(config);
  const stored = loadStoredConfig(config.configFile);

  output.write(
    [
      "欢迎使用 BinaClaw onboard。",
      "这一步会配置首启需要的 API 与本地服务端口，并准备本地 Gateway 与 Telegram provider。",
      "需要填写 Gateway 端口、OpenAI API Key、OpenAI 模型、Telegram Bot Token、允许访问的 Telegram 用户 ID、Brave Search Key，以及 Binance API Key / Secret。",
      `配置文件位置: ${config.configFile}`,
      `本机环境文件位置: ${config.localEnvFile}`,
    ].join("\n") + "\n",
  );

  const gatewayPort = await promptNumber(
    rl,
    "BINACLAW_GATEWAY_PORT",
    stored.gateway?.port ?? config.gateway.port,
  );
  const localGatewayUrl = `ws://127.0.0.1:${gatewayPort ?? config.gateway.port}`;
  const binanceApiKey = await promptText(rl, "BINANCE_API_KEY", config.binance.apiKey, { sensitive: true });
  const binanceApiSecret = await promptText(rl, "BINANCE_API_SECRET", config.binance.apiSecret, { sensitive: true });

  const nextConfig: StoredAppConfig = {
    provider: {
      apiKey: await promptText(rl, "OPENAI_API_KEY", stored.provider?.apiKey, { sensitive: true, required: true }),
      baseUrl: stored.provider?.baseUrl ?? "https://api.openai.com/v1",
      model: await promptText(rl, "OPENAI_MODEL", stored.provider?.model ?? "gpt-4o-mini", { required: true }),
    },
    gateway: {
      host: "127.0.0.1",
      port: gatewayPort,
      url: localGatewayUrl,
    },
    telegram: {
      botToken: await promptText(rl, "TELEGRAM_BOT_TOKEN", stored.telegram?.botToken, { sensitive: true, required: true }),
      apiBaseUrl: stored.telegram?.apiBaseUrl ?? config.telegram.apiBaseUrl,
      pollingTimeoutSeconds: stored.telegram?.pollingTimeoutSeconds ?? config.telegram.pollingTimeoutSeconds,
      allowedUserIds: await promptCsv(
        rl,
        "TELEGRAM_ALLOWED_USER_IDS",
        stored.telegram?.allowedUserIds ?? config.telegram.allowedUserIds,
        { required: true },
      ),
      allowedChatIds: stored.telegram?.allowedChatIds ?? config.telegram.allowedChatIds,
    },
    brave: {
      apiKey: await promptText(rl, "BRAVE_SEARCH_API_KEY", stored.brave?.apiKey, { sensitive: true }),
      baseUrl: stored.brave?.baseUrl ?? config.brave.baseUrl,
      defaultCountry: stored.brave?.defaultCountry ?? config.brave.defaultCountry,
      searchLanguage: stored.brave?.searchLanguage ?? config.brave.searchLanguage,
      uiLanguage: stored.brave?.uiLanguage ?? config.brave.uiLanguage,
    },
    binance: {
      useTestnet: stored.binance?.useTestnet ?? false,
      recvWindow: stored.binance?.recvWindow ?? config.binance.recvWindow,
      spotBaseUrl: stored.binance?.spotBaseUrl ?? config.binance.spotBaseUrl,
      futuresBaseUrl: stored.binance?.futuresBaseUrl ?? config.binance.futuresBaseUrl,
      sapiBaseUrl: stored.binance?.sapiBaseUrl ?? config.binance.sapiBaseUrl,
      webBaseUrl: stored.binance?.webBaseUrl ?? config.binance.webBaseUrl,
    },
  };

  await saveStoredConfig(config.configFile, mergeStoredConfig(stored, nextConfig));
  await saveLocalEnvFile(config.localEnvFile, {
    BINANCE_API_KEY: binanceApiKey,
    BINANCE_API_SECRET: binanceApiSecret,
  });
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
  };
}

async function promptText(
  rl: Interface,
  key: string,
  current?: string,
  options: PromptTextOptions = {},
): Promise<string | undefined> {
  while (true) {
    const currentLabel = describeCurrentValue(current, options.sensitive ?? false);
    const answer = (await rl.question(`${key} [当前: ${currentLabel}] > `)).trim();
    if (!answer) {
      if (options.required && !current) {
        output.write(`${key} 为必填项，请输入一个值。\n`);
        continue;
      }
      return current;
    }
    if (answer === "-") {
      if (options.required) {
        output.write(`${key} 不能清空。\n`);
        continue;
      }
      return undefined;
    }
    return answer;
  }
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

async function promptCsv(
  rl: Interface,
  key: string,
  current: string[],
  options: { required?: boolean } = {},
): Promise<string[] | undefined> {
  const currentLabel = current.length > 0 ? current.join(",") : "empty";
  while (true) {
    const answer = (await rl.question(`${key} [当前: ${currentLabel}] > `)).trim();
    if (!answer) {
      if (options.required && current.length === 0) {
        output.write(`${key} 为必填项，请至少输入一个值。\n`);
        continue;
      }
      return current;
    }
    if (answer === "-") {
      if (options.required) {
        output.write(`${key} 不能清空。\n`);
        continue;
      }
      return [];
    }
    const values = answer
      .split(",")
      .map((item) => item.trim())
      .filter(Boolean);
    if (options.required && values.length === 0) {
      output.write(`${key} 为必填项，请至少输入一个值。\n`);
      continue;
    }
    return values;
  }
}

function describeCurrentValue(current: string | undefined, sensitive: boolean): string {
  if (!current) {
    return "missing";
  }
  return sensitive ? "configured" : current;
}
