import {randomUUID} from "node:crypto";
import WebSocket from "ws";
import type {AgentTurnCallbacks, AgentTurnResult} from "../core/agent.ts";
import {createAppConfig} from "../core/config.ts";
import type {AppConfig, DeskMarketPulseItem, InstalledSkill, SessionState, SkillEndpointHint} from "../core/types.ts";
import type {
  GatewayChatSendRequest,
  GatewayChatSendResponse,
  GatewayDeskPulseResponse,
  GatewayEventEnvelope,
  GatewayRequestEnvelope,
  GatewayResponseEnvelope,
  GatewaySessionResponse,
  GatewaySkillsResponse,
} from "./protocol.ts";
import {createCliSessionKey} from "./session-key.ts";

type PendingRequest = {
  resolve: (value: GatewayResponseEnvelope["payload"]) => void;
  reject: (error: Error) => void;
  onEvent?: (event: GatewayEventEnvelope) => void;
};

export class GatewayWsClient {
  readonly config: AppConfig;
  private socket?: WebSocket;
  private connectPromise?: Promise<void>;
  private readonly pending = new Map<string, PendingRequest>();

  constructor(config = createAppConfig()) {
    this.config = config;
  }

  async connect(): Promise<void> {
    if (this.socket && this.socket.readyState === WebSocket.OPEN) {
      return;
    }
    if (this.connectPromise) {
      return await this.connectPromise;
    }

    const url = this.requireGatewayUrl();
    this.connectPromise = new Promise<void>((resolve, reject) => {
      const socket = new WebSocket(url);
      this.socket = socket;

      const cleanup = () => {
        socket.off("open", onOpen);
        socket.off("error", onError);
      };

      const onOpen = () => {
        cleanup();
        this.attachSocket(socket);
        resolve();
      };

      const onError = (error: Error) => {
        cleanup();
        reject(error);
      };

      socket.on("open", onOpen);
      socket.on("error", onError);
    }).finally(() => {
      this.connectPromise = undefined;
    });

    return await this.connectPromise;
  }

  async close(): Promise<void> {
    if (!this.socket) {
      return;
    }
    const socket = this.socket;
    this.socket = undefined;
    await new Promise<void>((resolve) => {
      socket.once("close", () => resolve());
      socket.close();
    });
  }

  async request<TPayload = unknown>(
    type: GatewayRequestEnvelope["type"],
    payload?: unknown,
    onEvent?: (event: GatewayEventEnvelope) => void,
  ): Promise<TPayload> {
    await this.connect();
    const socket = this.socket;
    if (!socket || socket.readyState !== WebSocket.OPEN) {
      throw new Error("Gateway WebSocket is not connected.");
    }

    const requestId = randomUUID();
    const envelope: GatewayRequestEnvelope = {
      kind: "request",
      requestId,
      type,
      payload,
    };

    const promise = new Promise<TPayload>((resolve, reject) => {
      this.pending.set(requestId, {
        resolve: (value) => resolve(value as TPayload),
        reject,
        onEvent,
      });
    });

    socket.send(JSON.stringify(envelope));
    return await promise;
  }

  async health(): Promise<void> {
    await this.request("health");
  }

  async getDeskPulse(): Promise<DeskMarketPulseItem[]> {
    const response = await this.request<GatewayDeskPulseResponse>("desk.pulse");
    return response.pulse;
  }

  async getSession(sessionKey: string): Promise<SessionState> {
    const response = await this.request<GatewaySessionResponse>("session.get", { sessionKey });
    return response.session;
  }

  async clearSession(sessionKey: string): Promise<SessionState> {
    const response = await this.request<GatewaySessionResponse>("session.clear", { sessionKey });
    return response.session;
  }

  async clearTrace(sessionKey: string): Promise<SessionState> {
    const response = await this.request<GatewaySessionResponse>("trace.clear", { sessionKey });
    return response.session;
  }

  async listSkills(): Promise<GatewaySkillsResponse["skills"]> {
    const response = await this.request<GatewaySkillsResponse>("skills.list");
    return response.skills;
  }

  async sendChat(
    input: string,
    sessionKey: string,
    callbacks: AgentTurnCallbacks = {},
  ): Promise<{ result: AgentTurnResult; session: SessionState }> {
    let finalResult: AgentTurnResult | null = null;
    let finalSession: SessionState | null = null;

    const response = await this.request<GatewayChatSendResponse>(
      "chat.send",
      {
        input,
        sessionKey,
      } satisfies GatewayChatSendRequest,
      (event) => {
        switch (event.type) {
          case "chat.status":
            if (event.payload && typeof event.payload === "object" && "status" in event.payload && typeof event.payload.status === "string") {
              callbacks.onStatus?.(event.payload.status);
            }
            break;
          case "chat.text_start":
            callbacks.onTextStart?.();
            break;
          case "chat.text_delta":
            if (event.payload && typeof event.payload === "object" && "delta" in event.payload && typeof event.payload.delta === "string") {
              callbacks.onTextDelta?.(event.payload.delta);
            }
            break;
          case "chat.text_done":
            if (event.payload && typeof event.payload === "object" && "text" in event.payload && typeof event.payload.text === "string") {
              callbacks.onTextDone?.(event.payload.text);
            }
            break;
          case "chat.result":
            if (
              event.payload &&
              typeof event.payload === "object" &&
              "result" in event.payload &&
              "session" in event.payload
            ) {
              finalResult = event.payload.result as AgentTurnResult;
              finalSession = event.payload.session as SessionState;
            }
            break;
          default:
            break;
        }
      },
    );

    return {
      result: finalResult ?? response.result,
      session: finalSession ?? response.session,
    };
  }

  private attachSocket(socket: WebSocket): void {
    socket.on("message", (raw: WebSocket.RawData) => {
      this.handleMessage(raw.toString());
    });
    socket.on("close", () => {
      for (const [requestId, pending] of this.pending) {
        pending.reject(new Error("Gateway WebSocket closed before the request completed."));
        this.pending.delete(requestId);
      }
    });
  }

  private handleMessage(raw: string): void {
    const payload = JSON.parse(raw) as GatewayResponseEnvelope | GatewayEventEnvelope;
    if (payload.kind === "event") {
      const pending = this.pending.get(payload.requestId);
      pending?.onEvent?.(payload);
      return;
    }

    const pending = this.pending.get(payload.requestId);
    if (!pending) {
      return;
    }
    this.pending.delete(payload.requestId);
    if (!payload.ok) {
      pending.reject(new Error(payload.error ?? "Unknown gateway error"));
      return;
    }
    pending.resolve(payload.payload);
  }

  private requireGatewayUrl(): string {
    const base = this.config.gateway.url ?? `ws://${this.config.gateway.host}:${this.config.gateway.port}`;
    return base.replace(/^http/, "ws");
  }
}

export class RemoteBinaClawAgentClient {
  readonly config: AppConfig;
  private readonly gateway: GatewayWsClient;
  private readonly sessionKey: string;
  private session: SessionState = {
    messages: [],
    scratchpad: [],
    activeSkills: [],
  };

  constructor(config = createAppConfig(), sessionKey = createCliSessionKey()) {
    this.config = config;
    this.gateway = new GatewayWsClient(config);
    this.sessionKey = sessionKey;
  }

  async initialize(): Promise<void> {
    await this.gateway.connect();
    await this.gateway.health();
    this.session = await this.gateway.getSession(this.sessionKey);
  }

  async close(): Promise<void> {
    await this.gateway.close();
  }

  async getDeskMarketPulse(): Promise<DeskMarketPulseItem[]> {
    return await this.gateway.getDeskPulse();
  }

  getSession(): SessionState {
    return this.session;
  }

  clearTrace(): void {
    void this.gateway.clearTrace(this.sessionKey).then((session) => {
      this.session = session;
    });
  }

  async clearSession(): Promise<SessionState> {
    this.session = await this.gateway.clearSession(this.sessionKey);
    return this.session;
  }

  async reloadSkills(): Promise<InstalledSkill[]> {
    const skills = await this.gateway.listSkills();
    return skills.map((manifest) => ({
      manifest: {
        name: manifest.name,
        version: manifest.version,
        description: manifest.description,
        capabilities: manifest.capabilities,
        requires_auth: manifest.requiresAuth,
        dangerous: manifest.dangerous,
        products: [],
        tools: [],
      },
      toolDefinitions: [],
      knowledge: {
        sections: {
          whenToUse: "",
          instructions: "",
          availableApis: "",
          outputContract: "",
          examples: "",
        },
        endpointHints: createStubEndpointHints(manifest.endpointCount, manifest.requiresAuth, manifest.dangerous),
        authHints: {
          requiresApiKey: manifest.requiresAuth,
          requiresSecretKey: manifest.requiresAuth,
          signatureAlgorithms: [],
          headerNames: [],
          baseUrls: [],
          confirmOnTransactions: manifest.dangerous,
        },
        referenceFiles: [],
        executionHints: [],
        policyRules: [],
      },
      instructions: "",
      sourcePath: "",
      rootDir: "",
      warnings: [],
    }));
  }

  async handleInput(input: string, callbacks: AgentTurnCallbacks = {}): Promise<AgentTurnResult> {
    const response = await this.gateway.sendChat(input, this.sessionKey, callbacks);
    this.session = response.session;
    return response.result;
  }
}

function createStubEndpointHints(
  count: number,
  requiresAuth: boolean,
  dangerous: boolean,
): SkillEndpointHint[] {
  return Array.from({ length: Math.max(count, 0) }, (_, index) => ({
    id: `remote-endpoint-${index + 1}`,
    operation: `endpoint-${index + 1}`,
    description: "",
    method: "GET",
    path: "",
    authRequired: requiresAuth,
    requiredParams: [],
    optionalParams: [],
    transport: requiresAuth ? "binance-signed-http" : "binance-public-http",
    dangerLevel: dangerous ? "mutating" : "readonly",
  }));
}
