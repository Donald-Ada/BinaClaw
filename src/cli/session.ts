import type {SessionState} from "../core/types.ts";

export function formatSessionView(session: SessionState): string {
  return [
    "Session identity",
    `- id: ${session.id ?? "main"}`,
    `- key: ${session.key ?? "cli:main"}`,
    `- type: ${session.type ?? "main"}`,
    `- transcript: ${session.transcriptFile ?? "unknown"}`,
    `- created: ${session.createdAt ?? "unknown"}`,
    `- updated: ${session.updatedAt ?? "unknown"}`,
    "",
    "Session load",
    `- messages: ${session.messages.length}`,
    `- scratchpad: ${session.scratchpad.length}`,
    `- active skills: ${session.activeSkills.join(", ") || "none"}`,
    `- pending approval: ${session.pendingApproval ? session.pendingApproval.toolId : "none"}`,
    "",
    "Conversation state",
    formatTopicState(session),
  ].join("\n");
}

export function formatSessionJson(session: SessionState): string {
  return JSON.stringify(session, null, 2);
}

function formatTopicState(session: SessionState): string {
  if (!session.conversationState) {
    return "- state: none";
  }
  return JSON.stringify(session.conversationState, null, 2);
}
