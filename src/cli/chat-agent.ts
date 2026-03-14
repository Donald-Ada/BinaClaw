import {BinaClawAgent, type AgentTurnCallbacks, type AgentTurnResult} from "../core/agent.ts";
import {createAppConfig} from "../core/config.ts";
import type {AppConfig, DeskMarketPulseItem, InstalledSkill, SessionState} from "../core/types.ts";
import {RemoteBinaClawAgentClient} from "../gateway/client.ts";

export interface ChatAgentLike {
  readonly config: AppConfig;
  initialize(): Promise<void>;
  handleInput(input: string, callbacks?: AgentTurnCallbacks): Promise<AgentTurnResult>;
  reloadSkills(): Promise<InstalledSkill[]>;
  getDeskMarketPulse(): Promise<DeskMarketPulseItem[]>;
  getSession(): SessionState;
  clearTrace(): void;
  clearSession(): Promise<SessionState>;
  compactSessionNow(): Promise<SessionState>;
}

export function createChatAgent(config = createAppConfig()): ChatAgentLike {
  if (config.gateway.url) {
    return new RemoteBinaClawAgentClient(config);
  }
  return new BinaClawAgent(config);
}
