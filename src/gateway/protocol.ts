import type {AgentTurnResult} from "../core/agent.ts";
import type {DeskMarketPulseItem, InstalledSkill, SessionState} from "../core/types.ts";

export type GatewayRequestType =
  | "health"
  | "desk.pulse"
  | "skills.list"
  | "session.get"
  | "session.clear"
  | "trace.clear"
  | "chat.send";

export type GatewayEventType =
  | "chat.status"
  | "chat.text_start"
  | "chat.text_delta"
  | "chat.text_done"
  | "chat.result";

export interface GatewayHealthResponse {
  ok: true;
  name: "BinaClaw Gateway";
}

export interface GatewaySkillSummary {
  name: string;
  description: string;
  version: string;
  capabilities: string[];
  requiresAuth: boolean;
  dangerous: boolean;
  endpointCount: number;
  warningCount: number;
}

export interface GatewayDeskPulseResponse {
  pulse: DeskMarketPulseItem[];
}

export interface GatewayChatSendRequest {
  input: string;
  sessionKey?: string;
}

export interface GatewaySessionRequest {
  sessionKey?: string;
}

export interface GatewaySkillsResponse {
  skills: GatewaySkillSummary[];
}

export interface GatewayChatSendResponse {
  result: AgentTurnResult;
  session: SessionState;
}

export interface GatewaySessionResponse {
  session: SessionState;
}

export interface GatewayRequestEnvelope<T = unknown> {
  kind: "request";
  requestId: string;
  type: GatewayRequestType;
  payload?: T;
}

export interface GatewayResponseEnvelope<T = unknown> {
  kind: "response";
  requestId: string;
  type: GatewayRequestType;
  ok: boolean;
  payload?: T;
  error?: string;
}

export interface GatewayEventEnvelope<T = unknown> {
  kind: "event";
  requestId: string;
  type: GatewayEventType;
  payload?: T;
}
