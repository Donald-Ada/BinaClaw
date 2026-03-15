import {randomUUID} from "node:crypto";
import {asToolError, asToolResult, BinanceClient} from "./binance.ts";
import {BraveSearchClient} from "./brave.ts";
import {MemoryStore} from "./memory.ts";
import type {AppConfig, InstalledSkill, SkillToolDefinition, ToolDefinition, ToolExecutionContext, ToolResult} from "./types.ts";
import {getWorkspaceDocumentPaths} from "./workspace.ts";

type ToolRegistry = Map<string, ToolDefinition>;

async function withToolResult(toolId: string, action: () => Promise<unknown>): Promise<ToolResult> {
  try {
    const data = await action();
    return asToolResult(toolId, data);
  } catch (error) {
    return asToolError(toolId, error);
  }
}

export function createToolRegistry(config: AppConfig, client = new BinanceClient(config.binance)): ToolRegistry {
  return createToolRegistryFromSkills(config, [], client);
}

export function createToolRegistryFromSkills(
  config: AppConfig,
  skills: InstalledSkill[],
  client = new BinanceClient(config.binance),
): ToolRegistry {
  const braveClient = new BraveSearchClient(config.brave);
  const memoryStore = new MemoryStore(
    config.memoryFile,
    config.workspaceMemoryDir,
    config.workspaceLongTermMemoryFile,
    getWorkspaceDocumentPaths(config),
  );
  const context: ToolExecutionContext = {
    config,
    now: () => new Date(),
  };

  const builtinTools: ToolDefinition[] = [
    {
      id: "market.getTicker",
      description: "获取现货 24 小时 ticker",
      operation: "24hr ticker",
      method: "GET",
      path: "/api/v3/ticker/24hr",
      inputSchema: { type: "object", required: ["symbol"], properties: { symbol: { type: "string" } } },
      outputSchema: { type: "object" },
      dangerous: false,
      authScope: "none",
      handler: (input) => withToolResult("market.getTicker", () => client.getTicker(String(input.symbol))),
    },
    {
      id: "market.getDepth",
      description: "获取盘口深度",
      operation: "order book depth",
      method: "GET",
      path: "/api/v3/depth",
      inputSchema: { type: "object", required: ["symbol"], properties: { symbol: { type: "string" }, limit: { type: "number" } } },
      outputSchema: { type: "object" },
      dangerous: false,
      authScope: "none",
      handler: (input) =>
        withToolResult("market.getDepth", () => client.getDepth(String(input.symbol), Number(input.limit ?? 5))),
    },
    {
      id: "market.getKlines",
      description: "获取 K 线数据",
      operation: "klines",
      method: "GET",
      path: "/api/v3/klines",
      inputSchema: { type: "object", required: ["symbol"], properties: { symbol: { type: "string" }, interval: { type: "string" } } },
      outputSchema: { type: "array" },
      dangerous: false,
      authScope: "none",
      handler: (input) =>
        withToolResult("market.getKlines", () =>
          client.getKlines(String(input.symbol), String(input.interval ?? "1h"), Number(input.limit ?? 12)),
        ),
    },
    {
      id: "market.getFunding",
      description: "获取合约 funding 概览",
      operation: "premium index",
      method: "GET",
      path: "/fapi/v1/premiumIndex",
      inputSchema: { type: "object", required: ["symbol"], properties: { symbol: { type: "string" } } },
      outputSchema: { type: "object" },
      dangerous: false,
      authScope: "none",
      handler: (input) => withToolResult("market.getFunding", () => client.getFunding(String(input.symbol))),
    },
    {
      id: "spot.getAccount",
      description: "获取现货账户余额",
      operation: "spot account",
      method: "GET",
      path: "/api/v3/account",
      inputSchema: { type: "object" },
      outputSchema: { type: "object" },
      dangerous: false,
      authScope: "spot",
      handler: () => withToolResult("spot.getAccount", () => client.getSpotAccount()),
    },
    {
      id: "spot.getOpenOrders",
      description: "获取现货未完成订单",
      operation: "spot open orders",
      method: "GET",
      path: "/api/v3/openOrders",
      inputSchema: { type: "object", properties: { symbol: { type: "string" } } },
      outputSchema: { type: "array" },
      dangerous: false,
      authScope: "spot",
      handler: (input) => withToolResult("spot.getOpenOrders", () => client.getSpotOpenOrders(input.symbol as string | undefined)),
    },
    {
      id: "spot.getTrades",
      description: "获取现货成交历史",
      operation: "spot trade history",
      method: "GET",
      path: "/api/v3/myTrades",
      inputSchema: { type: "object", required: ["symbol"], properties: { symbol: { type: "string" }, limit: { type: "number" } } },
      outputSchema: { type: "array" },
      dangerous: false,
      authScope: "spot",
      handler: (input) =>
        withToolResult("spot.getTrades", () => client.getSpotTrades(String(input.symbol), Number(input.limit ?? 10))),
    },
    {
      id: "spot.placeOrder",
      description: "提交现货订单",
      operation: "spot new order",
      method: "POST",
      path: "/api/v3/order",
      inputSchema: {
        type: "object",
        required: ["symbol", "side", "type"],
        properties: {
          symbol: { type: "string" },
          side: { type: "string", enum: ["BUY", "SELL"] },
          type: { type: "string", enum: ["MARKET", "LIMIT"] },
          quantity: { type: "number" },
          quoteOrderQty: { type: "number" },
          price: { type: "number" },
        },
        anyOf: [
          { type: "object", required: ["quantity"] },
          { type: "object", required: ["quoteOrderQty"] },
        ],
      },
      outputSchema: { type: "object" },
      dangerous: true,
      authScope: "spot",
      handler: (input) =>
        withToolResult("spot.placeOrder", () =>
          client.placeSpotOrder({
            symbol: String(input.symbol),
            side: String(input.side),
            type: String(input.type),
            quantity: input.quantity !== undefined ? Number(input.quantity) : undefined,
            quoteOrderQty: input.quoteOrderQty !== undefined ? Number(input.quoteOrderQty) : undefined,
            price: input.price ? Number(input.price) : undefined,
          }),
        ),
    },
    {
      id: "spot.cancelOrder",
      description: "撤销现货订单",
      operation: "spot cancel order",
      method: "DELETE",
      path: "/api/v3/order",
      inputSchema: { type: "object", required: ["symbol", "orderId"], properties: { symbol: { type: "string" }, orderId: { type: "number" } } },
      outputSchema: { type: "object" },
      dangerous: true,
      authScope: "spot",
      handler: (input) =>
        withToolResult("spot.cancelOrder", () => client.cancelSpotOrder(String(input.symbol), Number(input.orderId))),
    },
    {
      id: "futures.getAccount",
      description: "获取合约账户",
      operation: "futures account",
      method: "GET",
      path: "/fapi/v2/account",
      inputSchema: { type: "object" },
      outputSchema: { type: "object" },
      dangerous: false,
      authScope: "futures",
      handler: () => withToolResult("futures.getAccount", () => client.getFuturesAccount()),
    },
    {
      id: "futures.getPositions",
      description: "获取合约持仓",
      operation: "futures position risk",
      method: "GET",
      path: "/fapi/v2/positionRisk",
      inputSchema: { type: "object" },
      outputSchema: { type: "array" },
      dangerous: false,
      authScope: "futures",
      handler: () => withToolResult("futures.getPositions", () => client.getFuturesPositions()),
    },
    {
      id: "futures.getOpenOrders",
      description: "获取合约未完成订单",
      operation: "futures open orders",
      method: "GET",
      path: "/fapi/v1/openOrders",
      inputSchema: { type: "object", properties: { symbol: { type: "string" } } },
      outputSchema: { type: "array" },
      dangerous: false,
      authScope: "futures",
      handler: (input) =>
        withToolResult("futures.getOpenOrders", () => client.getFuturesOpenOrders(input.symbol as string | undefined)),
    },
    {
      id: "futures.placeOrder",
      description: "提交合约订单",
      operation: "futures new order",
      method: "POST",
      path: "/fapi/v1/order",
      inputSchema: {
        type: "object",
        required: ["symbol", "side", "type", "quantity"],
        properties: {
          symbol: { type: "string" },
          side: { type: "string" },
          type: { type: "string" },
          quantity: { type: "number" },
          price: { type: "number" },
        },
      },
      outputSchema: { type: "object" },
      dangerous: true,
      authScope: "futures",
      handler: (input) =>
        withToolResult("futures.placeOrder", () =>
          client.placeFuturesOrder({
            symbol: String(input.symbol),
            side: String(input.side),
            type: String(input.type),
            quantity: Number(input.quantity),
            price: input.price ? Number(input.price) : undefined,
          }),
        ),
    },
    {
      id: "futures.cancelOrder",
      description: "撤销合约订单",
      operation: "futures cancel order",
      method: "DELETE",
      path: "/fapi/v1/order",
      inputSchema: { type: "object", required: ["symbol", "orderId"], properties: { symbol: { type: "string" }, orderId: { type: "number" } } },
      outputSchema: { type: "object" },
      dangerous: true,
      authScope: "futures",
      handler: (input) =>
        withToolResult("futures.cancelOrder", () => client.cancelFuturesOrder(String(input.symbol), Number(input.orderId))),
    },
    {
      id: "wallet.getBalances",
      description: "获取资金钱包余额",
      operation: "wallet balance",
      method: "GET",
      path: "/sapi/v1/asset/wallet/balance",
      inputSchema: { type: "object" },
      outputSchema: { type: "array" },
      dangerous: false,
      authScope: "wallet",
      handler: () => withToolResult("wallet.getBalances", () => client.getWalletBalances()),
    },
    {
      id: "web3.getTokenInfo",
      description: "通过 Brave Web Search 获取 Web3 代币/项目信息线索",
      inputSchema: { type: "object", properties: { symbol: { type: "string" }, query: { type: "string" } } },
      outputSchema: { type: "object" },
      dangerous: false,
      authScope: "none",
      handler: (input) =>
        withToolResult("web3.getTokenInfo", async () => {
          if (!braveClient.hasApiKey()) {
            return {
              configured: false,
              source: "brave-web-search",
              query: String(input.query ?? input.symbol ?? "web3"),
              results: [],
              message: "缺少 BRAVE_SEARCH_API_KEY，当前无法检索 Web3 外部信息。",
            };
          }
          const query = buildWeb3Query(input);
          return await braveClient.searchWeb(query, { count: 5, freshness: "pm" });
        }),
    },
    {
      id: "news.getSignal",
      description: "通过 Brave News Search 获取热点新闻与资讯线索",
      inputSchema: { type: "object", properties: { symbol: { type: "string" }, query: { type: "string" } } },
      outputSchema: { type: "object" },
      dangerous: false,
      authScope: "none",
      handler: (input) =>
        withToolResult("news.getSignal", async () => {
          if (!braveClient.hasApiKey()) {
            return {
              configured: false,
              source: "brave-news-search",
              query: String(input.query ?? input.symbol ?? "crypto market"),
              results: [],
              message: "缺少 BRAVE_SEARCH_API_KEY，当前无法检索实时新闻。",
            };
          }
          const query = buildNewsQuery(input);
          return await braveClient.searchNews(query, { count: 5, freshness: "pd" });
        }),
    },
    {
      id: "memory.search",
      description: "搜索 workspace memory 中的相关片段",
      inputSchema: {
        type: "object",
        required: ["query"],
        properties: {
          query: { type: "string" },
          limit: { type: "number" },
        },
      },
      outputSchema: { type: "array" },
      dangerous: false,
      authScope: "none",
      handler: (input) =>
        withToolResult("memory.search", () =>
          memoryStore.searchWorkspaceMemory(String(input.query), Number(input.limit ?? 5)),
        ),
    },
    {
      id: "memory.getRecent",
      description: "读取最近的 workspace memory 日志与长期记忆概览",
      inputSchema: {
        type: "object",
        properties: {
          limit: { type: "number" },
        },
      },
      outputSchema: { type: "object" },
      dangerous: false,
      authScope: "none",
      handler: (input) =>
        withToolResult("memory.getRecent", () =>
          memoryStore.getWorkspaceContext(Number(input.limit ?? 2)),
        ),
    },
  ];

  const registry = new Map(builtinTools.map((tool) => [tool.id, tool]));
  for (const skill of skills) {
    for (const definition of skill.toolDefinitions) {
      registry.set(definition.id, createSkillBackedToolDefinition(definition, client));
    }
  }

  return registry;
}

export async function executeToolCall(
  registry: ToolRegistry,
  toolId: string,
  input: Record<string, unknown>,
  config: AppConfig,
): Promise<ToolResult> {
  const tool = registry.get(toolId);
  if (!tool) {
    return asToolError(toolId, `未找到工具 ${toolId}`);
  }
  return tool.handler(input, {
    config,
    now: () => new Date(),
  });
}

function buildNewsQuery(input: Record<string, unknown>): string {
  const symbol = typeof input.symbol === "string" ? input.symbol : undefined;
  const rawQuery = typeof input.query === "string" ? input.query.trim() : "";
  if (rawQuery) {
    return rawQuery;
  }
  return symbol ? `${symbol} crypto market news` : "binance crypto market news";
}

function buildWeb3Query(input: Record<string, unknown>): string {
  const symbol = typeof input.symbol === "string" ? input.symbol : undefined;
  const rawQuery = typeof input.query === "string" ? input.query.trim() : "";
  if (rawQuery) {
    return `${rawQuery} token contract chain`;
  }
  return symbol ? `${symbol} token contract chain` : "web3 token contract chain";
}

function createSkillBackedToolDefinition(
  definition: SkillToolDefinition,
  client: BinanceClient,
): ToolDefinition {
  return {
    id: definition.id,
    description: definition.description,
    inputSchema: definition.inputSchema,
    outputSchema: definition.outputSchema,
    dangerous: definition.dangerous,
    authScope: definition.authScope,
    handler: (input) =>
      withToolResult(definition.id, () =>
        executeSkillBackedTool(definition, input, client),
      ),
  };
}

async function executeSkillBackedTool(
  definition: SkillToolDefinition,
  input: Record<string, unknown>,
  client: BinanceClient,
): Promise<unknown> {
  const params = buildBinanceRestParams(definition, input);
  if (definition.binance.signed) {
    return client.requestSigned(
      definition.binance.scope,
      definition.binance.method,
      definition.binance.path,
      params,
    );
  }
  return client.requestPublic(definition.binance.scope, definition.binance.path, params);
}

function buildBinanceRestParams(
  definition: SkillToolDefinition,
  input: Record<string, unknown>,
): Record<string, string | number | undefined> {
  const rawParams = {
    ...(definition.binance.defaultParams ?? {}),
    ...input,
  };
  const normalized = normalizeBinanceParams(rawParams);

  if (
    definition.binance.method === "POST" &&
    /\/order$/i.test(definition.binance.path) &&
    normalized.newClientOrderId === undefined
  ) {
    normalized.newClientOrderId = `binaclaw-${randomUUID().slice(0, 12)}`;
  }

  if (
    definition.binance.method === "POST" &&
    /\/order$/i.test(definition.binance.path) &&
    normalized.type === "LIMIT" &&
    normalized.timeInForce === undefined
  ) {
    normalized.timeInForce = "GTC";
  }

  return normalized;
}

function normalizeBinanceParams(
  params: Record<string, unknown>,
): Record<string, string | number | undefined> {
  const normalized: Record<string, string | number | undefined> = {};
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null || value === "") {
      continue;
    }
    if (typeof value === "string" || typeof value === "number") {
      normalized[key] = value;
      continue;
    }
    if (typeof value === "boolean") {
      normalized[key] = value ? "true" : "false";
    }
  }
  return normalized;
}
