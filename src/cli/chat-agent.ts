import {BinaClawAgent, type AgentTurnCallbacks, type AgentTurnResult} from "../core/agent.ts";
import {createAppConfig} from "../core/config.ts";
import type {AppConfig, DeskMarketPulseItem, InstalledSkill, SessionState} from "../core/types.ts";
import {RemoteBinaClawAgentClient} from "../gateway/client.ts";

export interface ChatAgentLike {
  readonly config: AppConfig;
  initialize(): Promise<void>;
  close(): Promise<void>;
  handleInput(input: string, callbacks?: AgentTurnCallbacks): Promise<AgentTurnResult>;
  reloadSkills(): Promise<InstalledSkill[]>;
  getDeskMarketPulse(): Promise<DeskMarketPulseItem[]>;
  getSession(): SessionState;
  clearTrace(): void;
  clearSession(): Promise<SessionState>;
}

export function createChatAgent(config = createAppConfig()): ChatAgentLike {
  if (config.gateway.url) {
    return new RemoteBinaClawAgentClient(config);
  }
  const agent = new BinaClawAgent(config);
  return {
    get config() {
      return agent.config;
    },
    async initialize() {
      await agent.initialize();
    },
    async close() {
      return;
    },
    async handleInput(input, callbacks) {
      return await agent.handleInput(input, callbacks);
    },
    async reloadSkills() {
      return await agent.reloadSkills();
    },
    async getDeskMarketPulse() {
      return await agent.getDeskMarketPulse();
    },
    getSession() {
      return agent.getSession();
    },
    clearTrace() {
      agent.clearTrace();
    },
    async clearSession() {
      return await agent.clearSession();
    },
  };
}
