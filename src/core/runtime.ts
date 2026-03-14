import {execFile as execFileCallback} from "node:child_process";
import {promisify} from "node:util";
import {resolve} from "node:path";
import {BinanceClient, asToolError, asToolResult} from "./binance.ts";
import type {
  AppConfig,
  CompiledSkillRuntime,
  CompiledToolCandidate,
  InstalledSkill,
  JsonSchema,
  PolicyRule,
  SkillEndpointHint,
  SkillExecutionHint,
  ToolDefinition,
  ToolResult,
} from "./types.ts";

const execFile = promisify(execFileCallback);

export async function compileSkillRuntime(
  skills: InstalledSkill[],
  baseRegistry: Map<string, ToolDefinition>,
  config: AppConfig,
  client = new BinanceClient(config.binance),
): Promise<CompiledSkillRuntime> {
  const registry = new Map<string, ToolDefinition>();

  for (const skill of skills) {
    for (const toolId of skill.manifest.tools) {
      const builtin = baseRegistry.get(toolId);
      if (builtin) {
        registry.set(toolId, {
          ...builtin,
          transport: builtin.transport ?? "builtin",
          sourceSkill: skill.manifest.name,
        });
      }
    }

    for (const endpoint of skill.knowledge.endpointHints) {
      registry.set(endpoint.id, createEndpointToolDefinition(skill, endpoint, config, client));
    }

    for (const executionHint of skill.knowledge.executionHints) {
      registry.set(
        `${deriveNamespace(skill.manifest.name)}.exec.${executionHint.name}`,
        createExecToolDefinition(skill, executionHint),
      );
    }
  }

  const tools: CompiledToolCandidate[] = Array.from(registry.values()).map((tool) => ({
    id: tool.id,
    description: tool.description,
    dangerous: tool.dangerous,
    authScope: tool.authScope,
    inputSchema: tool.inputSchema,
    transport: tool.transport,
    sourceSkill: tool.sourceSkill,
    runtimeDefinition: tool,
  }));

  return {
    skills,
    toolRegistry: registry,
    tools,
  };
}

function deriveNamespace(skillName: string): string {
  const parts = skillName.split(/[\/:_-]+/).filter(Boolean);
  return parts[parts.length - 1] ?? skillName;
}

function createEndpointToolDefinition(
  skill: InstalledSkill,
  endpoint: SkillEndpointHint,
  config: AppConfig,
  client: BinanceClient,
): ToolDefinition {
  const inputSchema = buildEndpointInputSchema(endpoint);
  const dangerous = endpoint.dangerLevel === "mutating" || requiresApproval(skill.knowledge.policyRules, endpoint.id);
  const authScope = endpoint.authRequired ? "spot" : "none";

  return {
    id: endpoint.id,
    description: endpoint.description,
    inputSchema,
    outputSchema: { type: "object" },
    dangerous,
    authScope,
    transport: endpoint.transport,
    sourceSkill: skill.manifest.name,
    handler: async (input) => {
      try {
        const data = await executeEndpointTransport(skill, endpoint, input, config, client);
        return asToolResult(endpoint.id, data);
      } catch (error) {
        return asToolError(endpoint.id, error);
      }
    },
  };
}

function createExecToolDefinition(skill: InstalledSkill, executionHint: SkillExecutionHint): ToolDefinition {
  return {
    id: `${deriveNamespace(skill.manifest.name)}.exec.${executionHint.name}`,
    description: `执行 skill 脚本 ${executionHint.relativePath}`,
    inputSchema: {
      type: "object",
      properties: {
        args: {
          type: "array",
          items: { type: "string" },
        },
      },
    },
    outputSchema: { type: "object" },
    dangerous: executionHint.dangerous,
    authScope: "none",
    transport: "exec",
    sourceSkill: skill.manifest.name,
    handler: async (input) => {
      try {
        const args = Array.isArray(input.args)
          ? input.args.filter((item): item is string => typeof item === "string")
          : [];
        const commandPath = ensurePathWithinRoot(skill.rootDir, executionHint.absolutePath);
        const invocation = executionHint.interpreter
          ? {
              file: executionHint.interpreter,
              args: [commandPath, ...args],
            }
          : {
              file: commandPath,
              args,
            };
        const result = await execFile(invocation.file, invocation.args, {
          cwd: skill.rootDir,
        });
        return asToolResult(`${deriveNamespace(skill.manifest.name)}.exec.${executionHint.name}`, {
          stdout: result.stdout.trim(),
          stderr: result.stderr.trim(),
          script: executionHint.relativePath,
        });
      } catch (error) {
        return asToolError(`${deriveNamespace(skill.manifest.name)}.exec.${executionHint.name}`, error);
      }
    },
  };
}

function buildEndpointInputSchema(endpoint: SkillEndpointHint): JsonSchema {
  const properties = Object.fromEntries(
    [...endpoint.requiredParams, ...endpoint.optionalParams].map((param) => [param, { type: "string" }]),
  );
  return {
    type: "object",
    required: endpoint.requiredParams,
    properties,
  };
}

function requiresApproval(policyRules: PolicyRule[], toolId: string): boolean {
  return policyRules.some(
    (rule) => rule.kind === "approval" && (!rule.appliesTo || rule.appliesTo.includes(toolId)),
  );
}

async function executeEndpointTransport(
  skill: InstalledSkill,
  endpoint: SkillEndpointHint,
  input: Record<string, unknown>,
  config: AppConfig,
  client: BinanceClient,
): Promise<unknown> {
  const params = normalizeParams(input);
  const baseUrl = skill.knowledge.authHints.baseUrls[0] ?? config.binance.webBaseUrl;
  const headers = buildHeaders(skill);

  switch (endpoint.transport) {
    case "binance-signed-http":
      return client.requestSignedAbsolute(baseUrl, endpoint.method, endpoint.path, params, headers);
    case "binance-public-http":
      return client.requestPublicAbsolute(baseUrl, endpoint.path, params, headers, endpoint.method);
    case "http":
      return executeGenericHttp(baseUrl, endpoint, params, headers);
    default:
      throw new Error(`未支持的 transport: ${endpoint.transport}`);
  }
}

function buildHeaders(skill: InstalledSkill): Record<string, string> {
  const headers: Record<string, string> = {};
  const userAgentRule = skill.knowledge.policyRules.find((rule) => rule.kind === "user-agent" && rule.value);
  if (userAgentRule?.value) {
    headers["User-Agent"] = userAgentRule.value;
  } else if (skill.knowledge.authHints.userAgent) {
    headers["User-Agent"] = skill.knowledge.authHints.userAgent;
  }
  return headers;
}

async function executeGenericHttp(
  baseUrl: string,
  endpoint: SkillEndpointHint,
  params: Record<string, string | number | undefined>,
  headers: Record<string, string>,
): Promise<unknown> {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null && value !== "") {
      search.set(key, String(value));
    }
  }
  const query = search.toString();
  const url = `${baseUrl}${endpoint.path}${query ? `?${query}` : ""}`;
  const response = await fetch(url, {
    method: endpoint.method,
    headers,
  });
  if (!response.ok) {
    throw new Error(`${response.status} ${response.statusText}`);
  }
  return await response.json().catch(() => response.text());
}

function normalizeParams(input: Record<string, unknown>): Record<string, string | number | undefined> {
  return Object.fromEntries(
    Object.entries(input)
      .map(([key, value]) => {
        if (typeof value === "string" || typeof value === "number") {
          return [key, value];
        }
        if (typeof value === "boolean") {
          return [key, value ? "true" : "false"];
        }
        return [key, undefined];
      })
      .filter(([, value]) => value !== undefined),
  );
}

function ensurePathWithinRoot(rootDir: string, absolutePath: string): string {
  const resolvedRoot = resolve(rootDir);
  const resolvedPath = resolve(absolutePath);
  if (!resolvedPath.startsWith(resolvedRoot)) {
    throw new Error("脚本路径超出 skill 根目录，已拒绝执行。");
  }
  return resolvedPath;
}

export async function executeCompiledToolCall(
  registry: Map<string, ToolDefinition>,
  toolId: string,
  input: Record<string, unknown>,
): Promise<ToolResult> {
  const tool = registry.get(toolId);
  if (!tool) {
    return asToolError(toolId, `未找到工具 ${toolId}`);
  }
  return await tool.handler(input, {
    config: {} as AppConfig,
    now: () => new Date(),
  });
}
