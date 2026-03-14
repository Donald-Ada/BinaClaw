import type {ReasoningStep, SessionState} from "../core/types.ts";

export function formatTraceView(
  session: SessionState,
  limit = 12,
  filterKind?: ReasoningStep["kind"],
): string {
  const filtered = filterKind
    ? session.scratchpad.filter((step) => step.kind === filterKind)
    : session.scratchpad;
  const steps = filtered.slice(-limit);
  if (steps.length === 0) {
    return filterKind
      ? `当前还没有可显示的 ${filterKind} 轨迹。`
      : "当前还没有可显示的推理轨迹。";
  }

  const lines = [
    "Desk status",
    `- active skills: ${session.activeSkills.join(", ") || "none"}`,
    `- pending approval: ${session.pendingApproval?.toolId ?? "none"}`,
    "",
    filterKind ? `Recent reasoning (${filterKind})` : "Recent reasoning",
  ];

  for (const step of steps) {
    lines.push(
      `- iter ${step.iteration} · ${step.kind}: ${step.summary}`,
    );
    if (step.detail) {
      lines.push(`  ${truncate(step.detail, 240)}`);
    }
  }

  return lines.join("\n");
}

export function formatTraceJson(session: SessionState, limit = 40): string {
  return JSON.stringify(
    {
      activeSkills: session.activeSkills,
      pendingApproval: session.pendingApproval
        ? {
            toolId: session.pendingApproval.toolId,
            riskLevel: session.pendingApproval.riskLevel,
            expiresAt: session.pendingApproval.expiresAt,
          }
        : null,
      scratchpad: session.scratchpad.slice(-limit),
    },
    null,
    2,
  );
}

function truncate(value: string, maxLength: number): string {
  if (value.length <= maxLength) {
    return value;
  }
  return `${value.slice(0, maxLength)}...`;
}

export function isTraceFilterKind(value: string): value is ReasoningStep["kind"] {
  return ["intent", "plan", "observation", "approval", "response", "fallback"].includes(value);
}
