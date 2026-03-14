import {BinaClawAgent} from "../core/agent.ts";
import {BinanceClient} from "../core/binance.ts";
import {createAppConfig} from "../core/config.ts";
import {MemoryStore} from "../core/memory.ts";
import {OpenAICompatibleProvider} from "../core/provider.ts";
import {SessionManager} from "../core/session.ts";
import type {AgentTurnResult} from "../core/agent.ts";
import type {AppConfig, DeskMarketPulseItem, InstalledSkill, SessionState} from "../core/types.ts";
import {getWorkspaceDocumentPaths} from "../core/workspace.ts";
import type {
  GatewayChatSendRequest,
  GatewayChatSendResponse,
  GatewayDeskPulseResponse,
  GatewayEventEnvelope,
  GatewayHealthResponse,
  GatewayRequestEnvelope,
  GatewayRequestType,
  GatewaySessionRequest,
  GatewaySessionResponse,
  GatewaySkillsResponse,
} from "./protocol.ts";

const DEFAULT_SESSION_KEY = "cli:main";

export interface GatewayAgentLike {
  readonly config: AppConfig;
  initialize(): Promise<void>;
  handleInput(
    input: string,
    callbacks?: {
      onStatus?: (status: string) => void;
      onTextStart?: () => void;
      onTextDelta?: (delta: string) => void;
      onTextDone?: (fullText: string) => void;
    },
  ): Promise<AgentTurnResult>;
  reloadSkills(): Promise<InstalledSkill[]>;
  getDeskMarketPulse(): Promise<DeskMarketPulseItem[]>;
  getSession(): SessionState;
  clearTrace(): void;
  clearSession(): Promise<SessionState>;
  compactSessionNow(): Promise<SessionState>;
}

export type GatewayAgentFactory = (sessionKey: string) => Promise<GatewayAgentLike>;

export interface GatewayHandleOptions {
  emit?: (event: GatewayEventEnvelope) => void;
}

export class GatewayRuntime {
  readonly config: AppConfig;
  private readonly createAgent: GatewayAgentFactory;
  private readonly queue = new Map<string, Promise<unknown>>();

  constructor(config = createAppConfig(), createAgent?: GatewayAgentFactory) {
    this.config = config;
    this.createAgent = createAgent ?? createDefaultAgentFactory(config);
  }

  async handleRequest(
    envelope: GatewayRequestEnvelope,
    options: GatewayHandleOptions = {},
  ): Promise<GatewayHealthResponse | GatewayDeskPulseResponse | GatewaySkillsResponse | GatewaySessionResponse | GatewayChatSendResponse> {
    const sessionKey = extractSessionKey(envelope.payload);
    switch (envelope.type) {
      case "health":
        return { ok: true, name: "BinaClaw Gateway" };
      case "desk.pulse": {
        const agent = await this.createAgent(DEFAULT_SESSION_KEY);
        return {
          pulse: await agent.getDeskMarketPulse(),
        };
      }
      case "skills.list": {
        const agent = await this.createAgent(DEFAULT_SESSION_KEY);
        const skills = await agent.reloadSkills();
        return {
          skills: skills.map((skill) => ({
            name: skill.manifest.name,
            description: skill.manifest.description,
            version: skill.manifest.version,
            capabilities: skill.manifest.capabilities,
            requiresAuth: skill.manifest.requires_auth,
            dangerous: skill.manifest.dangerous,
            endpointCount: skill.knowledge.endpointHints.length || skill.toolDefinitions.length,
            warningCount: skill.warnings.length,
          })),
        };
      }
      case "session.get": {
        const agent = await this.createAgent(sessionKey);
        return { session: agent.getSession() };
      }
      case "session.clear": {
        const agent = await this.createAgent(sessionKey);
        const session = await this.enqueue(sessionKey, async () => await agent.clearSession());
        return { session };
      }
      case "session.compact": {
        const agent = await this.createAgent(sessionKey);
        const session = await this.enqueue(sessionKey, async () => await agent.compactSessionNow());
        return { session };
      }
      case "trace.clear": {
        const agent = await this.createAgent(sessionKey);
        await this.enqueue(sessionKey, async () => {
          agent.clearTrace();
        });
        return { session: agent.getSession() };
      }
      case "chat.send": {
        const payload = (envelope.payload ?? {}) as GatewayChatSendRequest;
        const agent = await this.createAgent(sessionKey);
        const result = await this.enqueue(sessionKey, async () =>
          await agent.handleInput(payload.input, {
            onStatus: (status) => {
              options.emit?.({
                kind: "event",
                requestId: envelope.requestId,
                type: "chat.status",
                payload: { status },
              });
            },
            onTextStart: () => {
              options.emit?.({
                kind: "event",
                requestId: envelope.requestId,
                type: "chat.text_start",
                payload: {},
              });
            },
            onTextDelta: (delta) => {
              options.emit?.({
                kind: "event",
                requestId: envelope.requestId,
                type: "chat.text_delta",
                payload: { delta },
              });
            },
            onTextDone: (text) => {
              options.emit?.({
                kind: "event",
                requestId: envelope.requestId,
                type: "chat.text_done",
                payload: { text },
              });
            },
          })
        );
        const response = {
          result,
          session: agent.getSession(),
        };
        options.emit?.({
          kind: "event",
          requestId: envelope.requestId,
          type: "chat.result",
          payload: response,
        });
        return response;
      }
      default:
        return assertNever(envelope.type);
    }
  }

  private async enqueue<T>(sessionKey: string, task: () => Promise<T>): Promise<T> {
    const previous = this.queue.get(sessionKey) ?? Promise.resolve();
    const run = previous.then(task, task);
    this.queue.set(sessionKey, run.then(() => undefined, () => undefined));
    return await run;
  }
}

function extractSessionKey(payload: unknown): string {
  if (payload && typeof payload === "object" && "sessionKey" in payload) {
    const value = (payload as GatewaySessionRequest).sessionKey;
    if (typeof value === "string" && value.trim()) {
      return value;
    }
  }
  return DEFAULT_SESSION_KEY;
}

export function createDefaultAgentFactory(config: AppConfig): GatewayAgentFactory {
  const cache = new Map<string, Promise<BinaClawAgent>>();
  const memoryStore = new MemoryStore(
    config.memoryFile,
    config.workspaceMemoryDir,
    config.workspaceLongTermMemoryFile,
    getWorkspaceDocumentPaths(config),
  );
  const provider = new OpenAICompatibleProvider(config.provider);
  const binanceClient = new BinanceClient(config.binance);

  return async (sessionKey: string) => {
    const existing = cache.get(sessionKey);
    if (existing) {
      return await existing;
    }

    const sessionManager = new SessionManager(
      config.workspaceSessionsIndexFile,
      config.workspaceSessionTranscriptsDir,
      memoryStore,
      config.session,
      provider,
      () => new Date(),
      sessionKey,
    );
    const agentPromise = (async () => {
      const agent = new BinaClawAgent(config, {
        provider,
        memoryStore,
        sessionManager,
        binanceClient,
      });
      await agent.initialize();
      return agent;
    })();
    cache.set(sessionKey, agentPromise);
    return await agentPromise;
  };
}

function assertNever(value: never): never {
  throw new Error(`Unsupported gateway request type: ${String(value)}`);
}
