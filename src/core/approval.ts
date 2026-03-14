import {randomUUID} from "node:crypto";
import type {ApprovalRequest, ToolCall, ToolResult} from "./types.ts";

export const APPROVAL_CONFIRMATION = "CONFIRM";
export const APPROVAL_CANCEL = "CANCEL";
const APPROVAL_TTL_MS = 5 * 60 * 1000;

function formatPortfolioContext(accountPreview?: ToolResult[]): string {
  if (!accountPreview || accountPreview.length === 0) {
    return "未附带账户预览，执行前请再次确认余额/保证金。";
  }
  return accountPreview
    .map((item) =>
      item.ok ? `${item.toolId}: ${JSON.stringify(item.data).slice(0, 220)}` : `${item.toolId}: ${item.error}`,
    )
    .join("\n");
}

export function createApprovalRequest(toolCall: ToolCall, accountPreview?: ToolResult[]): ApprovalRequest {
  const payloadPreview = JSON.stringify(toolCall.input, null, 2);
  const riskLevel = toolCall.toolId.includes("cancel") ? "medium" : "high";
  const accountSummary = formatPortfolioContext(accountPreview);

  return {
    id: randomUUID(),
    toolId: toolCall.toolId,
    summary: [
      "当前操作需要确认。",
      `操作: ${toolCall.toolId}`,
      `风险等级: ${riskLevel === "high" ? "高" : "中"}`,
      `账户摘要: ${accountSummary}`,
      `请在 5 分钟内输入 ${APPROVAL_CONFIRMATION} 确认，或输入 ${APPROVAL_CANCEL} 取消。`,
    ].join("\n"),
    riskLevel,
    payloadPreview,
    expiresAt: new Date(Date.now() + APPROVAL_TTL_MS).toISOString(),
    toolCall,
  };
}

export function isApprovalExpired(approval: ApprovalRequest, now = new Date()): boolean {
  return new Date(approval.expiresAt).getTime() <= now.getTime();
}
