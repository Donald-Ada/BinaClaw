import {access} from "node:fs/promises";
import {constants} from "node:fs";
import {readFile, writeFile} from "node:fs/promises";
import type {AppConfig, WorkspaceBootstrapDocs, WorkspaceDocumentPaths} from "./types.ts";

export async function ensureWorkspaceBootstrapFiles(config: AppConfig): Promise<void> {
  const templates = getWorkspaceTemplates(config);
  for (const [path, content] of templates) {
    if (await exists(path)) {
      continue;
    }
    await writeFile(path, content, "utf8");
  }
}

export async function readWorkspaceBootstrapDocs(config: AppConfig): Promise<WorkspaceBootstrapDocs> {
  const paths = getWorkspaceDocumentPaths(config);
  return {
    agents: await safeRead(paths.agentsFile),
    soul: await safeRead(paths.soulFile),
    user: await safeRead(paths.userFile),
    identity: await safeRead(paths.identityFile),
    heartbeat: await safeRead(paths.heartbeatFile),
    bootstrap: await safeRead(paths.bootstrapFile),
    tools: await safeRead(paths.toolsFile),
  };
}

export function getWorkspaceDocumentPaths(config: AppConfig): WorkspaceDocumentPaths {
  return {
    agentsFile: config.workspaceAgentsFile,
    soulFile: config.workspaceSoulFile,
    userFile: config.workspaceUserFile,
    identityFile: config.workspaceIdentityFile,
    heartbeatFile: config.workspaceHeartbeatFile,
    bootstrapFile: config.workspaceBootstrapFile,
    toolsFile: config.workspaceToolsFile,
  };
}

function getWorkspaceTemplates(config: AppConfig): Array<[string, string]> {
  return [
    [config.workspaceAgentsFile, buildAgentsTemplate()],
    [config.workspaceSoulFile, buildSoulTemplate()],
    [config.workspaceUserFile, buildUserTemplate()],
    [config.workspaceIdentityFile, buildIdentityTemplate()],
    [config.workspaceHeartbeatFile, buildHeartbeatTemplate()],
    [config.workspaceBootstrapFile, buildBootstrapTemplate(config)],
    [config.workspaceLongTermMemoryFile, buildMemoryTemplate()],
  ];
}

function buildAgentsTemplate(): string {
  return [
    "# AGENTS.md",
    "",
    "## Purpose",
    "BinaClaw 是一个以 Binance skills 为核心的中文交易助手型 agent。",
    "",
    "## Operating Rules",
    "- 优先使用已安装 skill 的说明、reference 和 runtime tools。",
    "- 对交易、划转、仓位变化等危险动作必须走确认流。",
    "- 不虚构价格、仓位、订单或链上信息。",
    "- 当会话过长时，允许压缩历史，但要保留当前主题和长期事实。",
    "",
    "## Memory",
    "- 长期稳定事实写入 MEMORY.md。",
    "- 对话日志写入 memory/YYYY-MM-DD.md。",
    "- 需要时使用 workspace memory 和 skill references 来恢复上下文。",
    "",
    "## Output Style",
    "- 默认使用中文。",
    "- 回答偏交易助手风格，简洁、谨慎、可执行。",
    "",
  ].join("\n");
}

function buildSoulTemplate(): string {
  return [
    "# SOUL.md",
    "",
    "## Tone",
    "- 冷静、专业、克制。",
    "- 不贩卖焦虑，不夸大收益。",
    "- 解释风险时直接，但不制造恐慌。",
    "",
    "## Personality",
    "- 像一个懂市场结构和执行纪律的交易搭档。",
    "- 面对模糊请求时先澄清目标，再给出建议。",
    "",
  ].join("\n");
}

function buildUserTemplate(): string {
  return [
    "# USER.md",
    "",
    "## Profile",
    "- 默认语言: 中文",
    "- 时区: Asia/Shanghai",
    "- 风险偏好: balanced",
    "- 默认市场: spot",
    "",
    "## Notes",
    "- 这里记录用户长期偏好、称呼和协作习惯。",
    "- agent 会把识别到的用户画像写入本文件的 Learned Profile 区段。",
    "- 非用户画像的长期事实应写入 MEMORY.md。",
    "",
  ].join("\n");
}

function buildIdentityTemplate(): string {
  return [
    "# IDENTITY.md",
    "",
    "name: BinaClaw",
    "role: Binance AI Agent",
    "style: terminal-first, skill-first, cautious",
    "",
    "BinaClaw 是一个以技能路由、实时工具调用和会话记忆为核心的交易助手。",
    "",
  ].join("\n");
}

function buildHeartbeatTemplate(): string {
  return [
    "# HEARTBEAT.md",
    "",
    "## Routine Checks",
    "- 确认 workspace docs 是否存在且可读。",
    "- 确认 TOOLS.md 与 skills 索引同步。",
    "- 确认 session compaction 没有丢失当前主题状态。",
    "",
  ].join("\n");
}

function buildBootstrapTemplate(config: AppConfig): string {
  return [
    "# BOOTSTRAP.md",
    "",
    "## First Run Checklist",
    `- Workspace root: ${config.workspaceDir}`,
    "- 检查 AGENTS.md / SOUL.md / USER.md / IDENTITY.md / TOOLS.md / MEMORY.md 是否存在。",
    "- 检查 session file 和 memory logs 是否可写。",
    "- 如果用户尚未配置 API keys，引导使用 /config。",
    "",
  ].join("\n");
}

function buildMemoryTemplate(): string {
  return [
    "# BinaClaw Memory",
    "",
    "## Durable Facts",
    "",
    "这里记录跨会话仍然有价值的长期事实、长期目标和稳定背景。",
    "",
  ].join("\n");
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

async function safeRead(path: string): Promise<string> {
  try {
    return await readFile(path, "utf8");
  } catch {
    return "";
  }
}
