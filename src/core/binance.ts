import {createHmac, randomUUID} from "node:crypto";
import type {AppConfig, BinanceConfig, ToolResult} from "./types.ts";

type RequestMethod = "GET" | "POST" | "DELETE";
type RequestScope = "spot" | "futures" | "wallet";

export class BinanceClient {
  private readonly config: BinanceConfig;
  private readonly fetchImpl: typeof fetch;

  constructor(
    config: BinanceConfig,
    fetchImpl: typeof fetch = fetch,
  ) {
    this.config = config;
    this.fetchImpl = fetchImpl;
  }

  hasAuth(): boolean {
    return Boolean(this.config.apiKey && this.config.apiSecret);
  }

  buildSignedQuery(params: Record<string, string | number | boolean | undefined>, timestamp = Date.now()): string {
    const searchParams = new URLSearchParams();
    for (const [key, value] of Object.entries(params)) {
      if (value !== undefined && value !== null && value !== "") {
        searchParams.set(key, String(value));
      }
    }
    searchParams.set("timestamp", String(timestamp));
    searchParams.set("recvWindow", String(this.config.recvWindow));
    const signature = createHmac("sha256", this.config.apiSecret ?? "")
      .update(searchParams.toString())
      .digest("hex");
    searchParams.set("signature", signature);
    return searchParams.toString();
  }

  private getBaseUrl(scope: RequestScope): string {
    switch (scope) {
      case "futures":
        return this.config.futuresBaseUrl;
      case "wallet":
        return this.config.sapiBaseUrl;
      default:
        return this.config.spotBaseUrl;
    }
  }

  async requestPublic(scope: RequestScope, path: string, params: Record<string, string | number | boolean | undefined> = {}): Promise<unknown> {
    return this.requestAgainstBase({
      baseUrl: this.getBaseUrl(scope),
      method: "GET",
      path,
      params,
    });
  }

  async requestPublicAbsolute(
    baseUrl: string,
    path: string,
    params: Record<string, string | number | boolean | undefined> = {},
    headers: Record<string, string> = {},
    method: RequestMethod = "GET",
  ): Promise<unknown> {
    return this.requestAgainstBase({
      baseUrl,
      method,
      path,
      params,
      headers,
    });
  }

  async requestSignedAbsolute(
    baseUrl: string,
    method: RequestMethod,
    path: string,
    params: Record<string, string | number | boolean | undefined> = {},
    headers: Record<string, string> = {},
  ): Promise<unknown> {
    if (!this.hasAuth()) {
      throw new Error("缺少 BINANCE_API_KEY 或 BINANCE_API_SECRET，当前只能使用只读能力。");
    }
    const query = this.buildSignedQuery(params);
    const url = `${baseUrl}${path}?${query}`;
    const response = await this.fetchImpl(url, {
      method,
      headers: {
        "X-MBX-APIKEY": this.config.apiKey ?? "",
        ...headers,
      },
    });
    return handleResponse(response);
  }

  private async requestAgainstBase(options: {
    baseUrl: string;
    method: RequestMethod;
    path: string;
    params?: Record<string, string | number | boolean | undefined>;
    headers?: Record<string, string>;
  }): Promise<unknown> {
    const searchParams = new URLSearchParams();
    for (const [key, value] of Object.entries(options.params ?? {})) {
      if (value !== undefined && value !== null && value !== "") {
        searchParams.set(key, String(value));
      }
    }
    const query = searchParams.toString();
    const url = `${options.baseUrl}${options.path}${query ? `?${query}` : ""}`;
    const response = await this.fetchImpl(url, {
      method: options.method,
      headers: options.headers,
    });
    return handleResponse(response);
  }

  async requestSigned(
    scope: RequestScope,
    method: RequestMethod,
    path: string,
    params: Record<string, string | number | boolean | undefined> = {},
  ): Promise<unknown> {
    if (!this.hasAuth()) {
      throw new Error("缺少 BINANCE_API_KEY 或 BINANCE_API_SECRET，当前只能使用只读能力。");
    }
    const query = this.buildSignedQuery(params);
    const url = `${this.getBaseUrl(scope)}${path}?${query}`;
    const response = await this.fetchImpl(url, {
      method,
      headers: {
        "X-MBX-APIKEY": this.config.apiKey ?? "",
      },
    });
    return handleResponse(response);
  }

  getTicker(symbol: string): Promise<unknown> {
    return this.requestPublic("spot", "/api/v3/ticker/24hr", { symbol });
  }

  getDepth(symbol: string, limit = 5): Promise<unknown> {
    return this.requestPublic("spot", "/api/v3/depth", { symbol, limit });
  }

  getKlines(symbol: string, interval = "1h", limit = 12): Promise<unknown> {
    return this.requestPublic("spot", "/api/v3/klines", { symbol, interval, limit });
  }

  getFunding(symbol: string): Promise<unknown> {
    return this.requestPublic("futures", "/fapi/v1/premiumIndex", { symbol });
  }

  getSpotAccount(): Promise<unknown> {
    return this.requestSigned("spot", "GET", "/api/v3/account");
  }

  getSpotOpenOrders(symbol?: string): Promise<unknown> {
    return this.requestSigned("spot", "GET", "/api/v3/openOrders", { symbol });
  }

  getSpotTrades(symbol: string, limit = 10): Promise<unknown> {
    return this.requestSigned("spot", "GET", "/api/v3/myTrades", { symbol, limit });
  }

  placeSpotOrder(input: {
    symbol: string;
    side: string;
    type: string;
    quantity?: number;
    quoteOrderQty?: number;
    price?: number;
  }): Promise<unknown> {
    return this.requestSigned("spot", "POST", "/api/v3/order", {
      symbol: input.symbol,
      side: input.side,
      type: input.type,
      quantity: input.quantity,
      quoteOrderQty: input.quoteOrderQty,
      price: input.price,
      timeInForce: input.type === "LIMIT" ? "GTC" : undefined,
      newClientOrderId: `binaclaw-${randomUUID().slice(0, 12)}`,
    });
  }

  cancelSpotOrder(symbol: string, orderId: number): Promise<unknown> {
    return this.requestSigned("spot", "DELETE", "/api/v3/order", { symbol, orderId });
  }

  getFuturesAccount(): Promise<unknown> {
    return this.requestSigned("futures", "GET", "/fapi/v2/account");
  }

  getFuturesPositions(): Promise<unknown> {
    return this.requestSigned("futures", "GET", "/fapi/v2/positionRisk");
  }

  getFuturesOpenOrders(symbol?: string): Promise<unknown> {
    return this.requestSigned("futures", "GET", "/fapi/v1/openOrders", { symbol });
  }

  placeFuturesOrder(input: {
    symbol: string;
    side: string;
    type: string;
    quantity: number;
    price?: number;
  }): Promise<unknown> {
    return this.requestSigned("futures", "POST", "/fapi/v1/order", {
      symbol: input.symbol,
      side: input.side,
      type: input.type,
      quantity: input.quantity,
      price: input.price,
      timeInForce: input.type === "LIMIT" ? "GTC" : undefined,
      newClientOrderId: `binaclaw-${randomUUID().slice(0, 12)}`,
    });
  }

  cancelFuturesOrder(symbol: string, orderId: number): Promise<unknown> {
    return this.requestSigned("futures", "DELETE", "/fapi/v1/order", { symbol, orderId });
  }

  getWalletBalances(): Promise<unknown> {
    return this.requestSigned("wallet", "GET", "/sapi/v1/asset/wallet/balance");
  }
}

async function handleResponse(response: Response): Promise<unknown> {
  const payload = await response.json().catch(() => undefined);
  if (!response.ok) {
    const message =
      typeof payload === "object" && payload !== null && "msg" in payload
        ? String((payload as { msg?: string }).msg)
        : `${response.status} ${response.statusText}`;
    throw new Error(message);
  }
  return payload;
}

export function asToolResult(toolId: string, data: unknown): ToolResult {
  return { ok: true, toolId, data };
}

export function asToolError(toolId: string, error: unknown): ToolResult {
  return {
    ok: false,
    toolId,
    error: error instanceof Error ? error.message : String(error),
  };
}

export function createBinanceClient(config: AppConfig, fetchImpl?: typeof fetch): BinanceClient {
  return new BinanceClient(config.binance, fetchImpl);
}
