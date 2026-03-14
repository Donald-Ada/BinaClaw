import {mkdir, readdir, readFile, rm, stat, writeFile} from "node:fs/promises";
import {basename, dirname, extname, join, relative, resolve} from "node:path";
import type {
  AppConfig,
  InstalledSkill,
  JsonSchema,
  PolicyRule,
  SkillAuthHints,
  SkillEndpointHint,
  SkillExecutionHint,
  SkillKnowledge,
  SkillManifest,
  SkillParameterHint,
  SkillReferenceFile,
  SkillReferenceSnippet,
  SkillSectionMap,
  SkillToolDefinition,
} from "./types.ts";

const REQUIRED_SECTIONS = [
  "When to use",
  "Instructions",
  "Available APIs",
  "Output contract",
  "Examples",
];

const REQUIRED_MANIFEST_KEYS: Array<keyof SkillManifest> = [
  "name",
  "description",
];

const SECTION_ALIASES: Record<keyof SkillSectionMap, string[]> = {
  whenToUse: ["When to use"],
  instructions: ["Instructions"],
  availableApis: ["Available APIs"],
  outputContract: ["Output contract"],
  examples: ["Examples"],
  quickReference: ["Quick Reference"],
  parameters: ["Parameters"],
  authentication: ["Authentication", "Signing Requests"],
  security: ["Security"],
  agentBehavior: ["Agent Behavior"],
};

interface GitHubRepoSource {
  owner: string;
  repo: string;
  ref?: string;
  path: string;
}

interface ParsedToolDefinitionInput {
  id?: unknown;
  description?: unknown;
  dangerous?: unknown;
  authScope?: unknown;
  transport?: unknown;
  inputSchema?: unknown;
  outputSchema?: unknown;
  binance?: {
    scope?: unknown;
    method?: unknown;
    path?: unknown;
    signed?: unknown;
    defaultParams?: unknown;
  };
}

interface SkillPackageFile {
  relativePath: string;
  content: string;
}

interface SkillPackage {
  sourcePath: string;
  mainRelativePath: string;
  files: SkillPackageFile[];
}

interface RemoteTreeEntry {
  path?: string;
  type?: string;
}

export interface ParseResult {
  skill: InstalledSkill;
}

function slugify(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
}

function parseScalar(value: string): string | boolean | string[] {
  const trimmed = value.trim();
  if (trimmed === "true") {
    return true;
  }
  if (trimmed === "false") {
    return false;
  }
  if (trimmed.startsWith("[") && trimmed.endsWith("]")) {
    return trimmed
      .slice(1, -1)
      .split(",")
      .map((item) => item.trim().replace(/^['"]|['"]$/g, ""))
      .filter(Boolean);
  }
  return trimmed.replace(/^['"]|['"]$/g, "");
}

function parseFrontmatter(block: string): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const line of block.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) {
      continue;
    }
    const separator = trimmed.indexOf(":");
    if (separator === -1) {
      continue;
    }
    const key = trimmed.slice(0, separator).trim();
    const value = trimmed.slice(separator + 1);
    result[key] = parseScalar(value);
  }
  return result;
}

function validateManifest(manifest: Record<string, unknown>, sourcePath: string): SkillManifest {
  const missing = REQUIRED_MANIFEST_KEYS.filter((key) => manifest[key] === undefined);
  if (missing.length > 0) {
    throw new Error(`Skill ${sourcePath} 缺少 frontmatter 字段: ${missing.join(", ")}`);
  }

  return {
    name: String(manifest.name),
    version: String(manifest.version ?? "1.0.0"),
    description: String(manifest.description),
    capabilities: Array.isArray(manifest.capabilities) ? (manifest.capabilities as string[]) : [],
    requires_auth: Boolean(manifest.requires_auth),
    dangerous: Boolean(manifest.dangerous),
    products: Array.isArray(manifest.products) ? (manifest.products as string[]) : [],
    tools: Array.isArray(manifest.tools) ? (manifest.tools as string[]) : [],
  };
}

function collectWarnings(body: string): string[] {
  if (/^##\s+Quick Reference$/m.test(body) || /^##\s+Authentication$/m.test(body)) {
    return [];
  }
  return REQUIRED_SECTIONS.filter((section) => !new RegExp(`^##\\s+${section}$`, "m").test(body)).map(
    (section) => `缺少段落: ${section}`,
  );
}

function extractSection(body: string, sectionName: string): string {
  const escaped = sectionName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = body.match(new RegExp(`^##\\s+${escaped}\\s*$\\r?\\n([\\s\\S]*?)(?=^##\\s+|\\Z)`, "m"));
  return match?.[1]?.trim() ?? "";
}

function collectSections(body: string): SkillSectionMap {
  return {
    whenToUse: SECTION_ALIASES.whenToUse.map((alias) => extractSection(body, alias)).find(Boolean) ?? "",
    instructions: SECTION_ALIASES.instructions.map((alias) => extractSection(body, alias)).find(Boolean) ?? "",
    availableApis: SECTION_ALIASES.availableApis.map((alias) => extractSection(body, alias)).find(Boolean) ?? "",
    outputContract: SECTION_ALIASES.outputContract.map((alias) => extractSection(body, alias)).find(Boolean) ?? "",
    examples: SECTION_ALIASES.examples.map((alias) => extractSection(body, alias)).find(Boolean) ?? "",
    quickReference: SECTION_ALIASES.quickReference.map((alias) => extractSection(body, alias)).find(Boolean) ?? "",
    parameters: SECTION_ALIASES.parameters.map((alias) => extractSection(body, alias)).find(Boolean) ?? "",
    authentication: SECTION_ALIASES.authentication.map((alias) => extractSection(body, alias)).find(Boolean) ?? "",
    security: SECTION_ALIASES.security.map((alias) => extractSection(body, alias)).find(Boolean) ?? "",
    agentBehavior: SECTION_ALIASES.agentBehavior.map((alias) => extractSection(body, alias)).find(Boolean) ?? "",
  };
}

function normalizeSchema(input: unknown): JsonSchema {
  if (!input || typeof input !== "object") {
    return { type: "object" };
  }
  return input as JsonSchema;
}

function normalizeDefaultParams(
  input: unknown,
): Record<string, string | number | boolean> | undefined {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    return undefined;
  }
  const normalized = Object.fromEntries(
    Object.entries(input).filter(([, value]) =>
      typeof value === "string" || typeof value === "number" || typeof value === "boolean",
    ),
  );
  return Object.keys(normalized).length > 0 ? normalized : undefined;
}

function normalizeToolDefinition(input: ParsedToolDefinitionInput, sourcePath: string): SkillToolDefinition {
  if (input.transport !== "binance-rest") {
    throw new Error(`Skill ${sourcePath} 的 tool definition 仅支持 transport=binance-rest`);
  }
  if (
    typeof input.id !== "string" ||
    typeof input.description !== "string" ||
    typeof input.authScope !== "string" ||
    typeof input.binance?.scope !== "string" ||
    typeof input.binance?.method !== "string" ||
    typeof input.binance?.path !== "string"
  ) {
    throw new Error(`Skill ${sourcePath} 的 tool definition 字段不完整`);
  }

  return {
    id: input.id,
    description: input.description,
    dangerous: Boolean(input.dangerous),
    authScope: input.authScope as SkillToolDefinition["authScope"],
    transport: "binance-rest",
    inputSchema: normalizeSchema(input.inputSchema),
    outputSchema: normalizeSchema(input.outputSchema),
    binance: {
      scope: input.binance.scope as SkillToolDefinition["binance"]["scope"],
      method: input.binance.method as SkillToolDefinition["binance"]["method"],
      path: input.binance.path,
      signed: input.binance.signed === undefined ? input.authScope !== "none" : Boolean(input.binance.signed),
      defaultParams: normalizeDefaultParams(input.binance.defaultParams),
    },
  };
}

function parseJsonToolDefinitions(section: string, sourcePath: string): SkillToolDefinition[] {
  const matches = Array.from(section.matchAll(/```(?:json|jsonc)?[^\n]*\n([\s\S]*?)```/g));
  const definitions: SkillToolDefinition[] = [];

  for (const match of matches) {
    const raw = match[1]?.trim();
    if (!raw) {
      continue;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      continue;
    }
    const entries = Array.isArray(parsed)
      ? parsed
      : parsed && typeof parsed === "object" && Array.isArray((parsed as { tools?: unknown }).tools)
        ? (parsed as { tools: unknown[] }).tools
        : [];
    for (const entry of entries) {
      definitions.push(normalizeToolDefinition((entry ?? {}) as ParsedToolDefinitionInput, sourcePath));
    }
  }

  return definitions;
}

function parseKeyValueAnnotations(raw: string): Record<string, string> {
  return Object.fromEntries(
    raw
      .split("|")
      .map((item) => item.trim())
      .filter(Boolean)
      .map((item) => {
        const separator = item.indexOf("=");
        if (separator === -1) {
          return [item, "true"];
        }
        return [item.slice(0, separator).trim(), item.slice(separator + 1).trim()];
      }),
  );
}

function parseLineToolDefinitions(section: string): SkillToolDefinition[] {
  const definitions: SkillToolDefinition[] = [];

  for (const line of section.split(/\r?\n/)) {
    const match = line.match(/^\s*-\s+`([^`]+)`(?:\s*\|\s*(.+))?$/);
    if (!match) {
      continue;
    }
    const id = match[1];
    const annotations = parseKeyValueAnnotations(match[2] ?? "");
    if (annotations.provider !== "binance-rest") {
      continue;
    }
    const authScope = (annotations.auth ?? annotations.authScope ?? "none") as SkillToolDefinition["authScope"];
    definitions.push({
      id,
      description: annotations.description ?? `${id} declared by skill`,
      dangerous: annotations.dangerous === "true",
      authScope,
      transport: "binance-rest",
      inputSchema: { type: "object" },
      outputSchema: { type: "object" },
      binance: {
        scope: (annotations.scope ?? "spot") as SkillToolDefinition["binance"]["scope"],
        method: (annotations.method ?? "GET") as SkillToolDefinition["binance"]["method"],
        path: annotations.path ?? "/",
        signed: annotations.signed ? annotations.signed === "true" : authScope !== "none",
      },
    });
  }

  return definitions;
}

function collectToolDefinitions(body: string, sourcePath: string): SkillToolDefinition[] {
  const section = extractSection(body, "Available APIs");
  if (!section) {
    return [];
  }

  const fromJson = parseJsonToolDefinitions(section, sourcePath);
  if (fromJson.length > 0) {
    return dedupeToolDefinitions(fromJson);
  }

  return dedupeToolDefinitions(parseLineToolDefinitions(section));
}

function dedupeToolDefinitions(definitions: SkillToolDefinition[]): SkillToolDefinition[] {
  return Array.from(new Map(definitions.map((definition) => [definition.id, definition])).values());
}

function deriveSkillNamespace(manifest: SkillManifest, rootDir: string): string {
  const manifestParts = manifest.name.split(/[\/:_-]+/).filter(Boolean);
  if (manifestParts.length > 0) {
    return slugify(manifestParts[manifestParts.length - 1] as string);
  }
  const parts = [basename(rootDir)]
    .flatMap((item) => item.split(/[\/:_-]+/))
    .filter(Boolean);
  return slugify(parts[parts.length - 1] ?? manifest.name);
}

function camelCase(value: string): string {
  const parts = value
    .replace(/[`*]/g, "")
    .split(/[^A-Za-z0-9]+/)
    .filter(Boolean);
  if (parts.length === 0) {
    return "call";
  }
  return parts
    .map((part, index) =>
      index === 0 ? part.charAt(0).toLowerCase() + part.slice(1) : part.charAt(0).toUpperCase() + part.slice(1),
    )
    .join("");
}

function deriveOperationName(description: string, path: string): string {
  const cleaned = (description.match(/`([^`]+)`/)?.[1] ?? description)
    .replace(/\([^)]*\)/g, "")
    .replace(/^get\s+/i, "")
    .trim();
  const normalized = cleaned.toLowerCase();
  if (/ticker/.test(normalized)) {
    return "ticker";
  }
  if (/aggregated trades|agg trades|aggtrades/.test(normalized)) {
    return "aggTrades";
  }
  if (/exchange info/.test(normalized)) {
    return "exchangeInfo";
  }
  if (/klines|candlestick/.test(normalized)) {
    return "klines";
  }
  if (/token list/.test(normalized)) {
    return "tokenList";
  }
  if (/token search/.test(normalized)) {
    return "tokenSearch";
  }
  if (cleaned && cleaned.length <= 40) {
    return camelCase(cleaned);
  }
  const lastPathPart = path.split("/").filter(Boolean).pop() ?? "call";
  return camelCase(lastPathPart);
}

function splitParamNames(raw: string): string[] {
  return raw
    .split(/[,/]| and |、/)
    .map((item) => item.trim().replace(/[`*]/g, ""))
    .filter(Boolean);
}

function normalizeColumnName(value: string): string {
  return value.trim().toLowerCase().replace(/[^a-z0-9]+/g, "");
}

function parseMarkdownTables(section: string): Array<Array<Record<string, string>>> {
  const lines = section.split(/\r?\n/);
  const tables: Array<Array<Record<string, string>>> = [];
  let current: string[] = [];

  const flush = () => {
    if (current.length < 2) {
      current = [];
      return;
    }
    const headerCells = current[0].split("|").slice(1, -1).map((cell) => cell.trim());
    if (headerCells.length === 0) {
      current = [];
      return;
    }
    const rows = current
      .slice(2)
      .map((line) => line.split("|").slice(1, -1).map((cell) => cell.trim()))
      .filter((cells) => cells.length === headerCells.length)
      .map((cells) =>
        Object.fromEntries(
          headerCells.map((header, index) => [normalizeColumnName(header), cells[index] ?? ""]),
        ),
      );
    if (rows.length > 0) {
      tables.push(rows);
    }
    current = [];
  };

  for (const line of lines) {
    if (/^\s*\|.+\|\s*$/.test(line)) {
      current.push(line);
      continue;
    }
    flush();
  }
  flush();

  return tables;
}

function parseParameterHints(section: string): SkillParameterHint[] {
  const results: SkillParameterHint[] = [];
  for (const table of parseMarkdownTables(section)) {
    for (const row of table) {
      const name = row.name ?? row.parameter ?? row.param ?? "";
      if (!name) {
        continue;
      }
      const requiredValue = (row.required ?? row.mandatory ?? "").toLowerCase();
      results.push({
        name: name.replace(/[`*]/g, ""),
        required: /(yes|true|required|必填|是)/.test(requiredValue),
        description: row.description ?? row.notes ?? "",
        enumValues: splitParamNames(row.options ?? row.enum ?? ""),
      });
    }
  }

  for (const line of section.split(/\r?\n/)) {
    const match = line.match(/^\s*[-*]\s+`?([A-Za-z0-9_]+)`?\s*(?:\((required|optional)\))?\s*[:：-]\s*(.+)$/i);
    if (!match) {
      continue;
    }
    results.push({
      name: match[1],
      required: (match[2] ?? "").toLowerCase() === "required",
      description: match[3],
      enumValues: [],
    });
  }

  return Array.from(new Map(results.map((item) => [item.name, item])).values());
}

function collectAuthHints(sections: SkillSectionMap): SkillAuthHints {
  const text = [
    sections.authentication,
    sections.security,
    sections.instructions,
    sections.agentBehavior,
  ]
    .filter(Boolean)
    .join("\n");
  const signatureAlgorithms = ["HMAC", "RSA", "Ed25519"].filter((item) =>
    text.toLowerCase().includes(item.toLowerCase()),
  );
  const headerNames = ["X-MBX-APIKEY", "User-Agent"].filter((item) =>
    text.toLowerCase().includes(item.toLowerCase()),
  );
  const baseUrls = Array.from(new Set(text.match(/https?:\/\/[^\s)]+/g) ?? []));

  return {
    requiresApiKey: /apikey/i.test(text),
    requiresSecretKey: /secret(key)?/i.test(text),
    signatureAlgorithms,
    headerNames,
    userAgent: text.match(/User-Agent[^`A-Za-z0-9-]*[`"]?([^`\n"]+)[`"]?/i)?.[1]?.trim(),
    baseUrls,
    confirmOnTransactions: /mainnet/i.test(text) && /(confirm|确认)/i.test(text),
  };
}

function parseQuickReferenceEndpoints(
  manifest: SkillManifest,
  sections: SkillSectionMap,
  authHints: SkillAuthHints,
  parameterHints: SkillParameterHint[],
  rootDir: string,
): SkillEndpointHint[] {
  const rawTables = [
    ...parseMarkdownTables(sections.quickReference ?? ""),
    ...parseMarkdownTables(sections.availableApis),
  ];
  const namespace = deriveSkillNamespace(manifest, rootDir);
  const baseUrl = authHints.baseUrls[0];

  const endpoints: SkillEndpointHint[] = [];
  for (const table of rawTables) {
    for (const row of table) {
      const endpointCell = row.endpoint ?? row.path ?? row.url ?? "";
      const methodAndPath = parseMethodAndPath(endpointCell, row.method ?? row.httpmethod ?? "");
      const path = methodAndPath.path;
      const method = methodAndPath.method;
      if (!path || !/^(GET|POST|DELETE)$/.test(method)) {
        continue;
      }
      const description = row.description ?? row.notes ?? row.summary ?? row.api ?? path;
      const operation = row.name ?? row.operation ?? row.api ?? deriveOperationName(description, path);
      const authValue = (row.auth ?? row.authentication ?? row.requiresauth ?? "").toLowerCase();
      const authRequired = /(yes|true|required|signed|auth|private|是)/.test(authValue);
      const requiredParams = splitParamNames(row.requiredparams ?? row.required ?? "");
      const optionalParams = splitParamNames(row.optionalparams ?? row.optional ?? "");
      const transport =
        baseUrl?.includes("binance.com") || path.startsWith("/bapi/")
          ? authRequired
            ? "binance-signed-http"
            : "binance-public-http"
          : authRequired
            ? "http"
            : "http";
      const mergedRequired = requiredParams.length > 0 ? requiredParams : parameterHints.filter((item) => item.required).map((item) => item.name);
      const mergedOptional = optionalParams.length > 0 ? optionalParams : parameterHints.filter((item) => !item.required).map((item) => item.name);

      endpoints.push({
        id: `${namespace}.${deriveOperationName(operation, path)}`,
        operation,
        description,
        method: method as SkillEndpointHint["method"],
        path,
        authRequired,
        requiredParams: Array.from(new Set(mergedRequired)),
        optionalParams: Array.from(new Set(mergedOptional)),
        transport,
        userAgent: authHints.userAgent,
        dangerLevel: determineDangerLevel(description, operation, path, method),
      });
    }
  }

  return Array.from(new Map(endpoints.map((item) => [item.id, item])).values());
}

function parseMethodAndPath(
  endpointCell: string,
  fallbackMethod: string,
): { path: string; method: string } {
  const method = String(fallbackMethod ?? "").toUpperCase().trim();
  const path = endpointCell.trim();
  const embedded = path.match(/(`?)(\/[^`\s]+)\1\s*\((GET|POST|DELETE|PUT)\)/i);
  if (embedded) {
    return {
      path: embedded[2] ?? "",
      method: String(embedded[3] ?? "").toUpperCase(),
    };
  }
  return {
    path: path.replace(/[`]/g, "").trim(),
    method,
  };
}

function parseApiBlocks(
  manifest: SkillManifest,
  body: string,
  authHints: SkillAuthHints,
  parameterHints: SkillParameterHint[],
  rootDir: string,
): SkillEndpointHint[] {
  const namespace = deriveSkillNamespace(manifest, rootDir);
  const blocks = Array.from(
    body.matchAll(
      /^#{2,4}\s+(.+?)\n[\s\S]*?(?:\*\*Method\*\*:\s*(GET|POST|DELETE|PUT)|###\s*Method:\s*(GET|POST|DELETE|PUT)|Method:\s*(GET|POST|DELETE|PUT))[\s\S]*?(?:\*\*URL\*\*:\s*|###\s*URL:\s*|URL:\s*)(?:\s*\n```[\s\S]*?\n)?\s*(https?:\/\/[^\s`]+|\/[^\s`]+)(?:\s*\n```)?[\s\S]*?(?=^#{2,4}\s+|\Z)/gim,
    ),
  );

  const endpoints: SkillEndpointHint[] = [];
  for (const block of blocks) {
    const description = (block[1] ?? "").trim();
    const method = String(block[2] ?? block[3] ?? block[4] ?? "").toUpperCase();
    const rawUrl = String(block[5] ?? "").trim();
    if (!description || !rawUrl || !/^(GET|POST|DELETE)$/.test(method)) {
      continue;
    }
    const url = rawUrl.replace(/[`]/g, "");
    const path = url.startsWith("http") ? new URL(url).pathname : url;
    const authRequired =
      /apikey|secret|x-mbx-apikey|authentication requires/i.test(block[0] ?? "") ||
      authHints.requiresApiKey;
    const transport = url.includes("binance.com")
      ? authRequired
        ? "binance-signed-http"
        : "binance-public-http"
      : authRequired
        ? "http"
        : "http";
    endpoints.push({
      id: `${namespace}.${deriveOperationName(description, path)}`,
      operation: description,
      description,
      method: method as SkillEndpointHint["method"],
      path,
      authRequired,
      requiredParams: parameterHints.filter((item) => item.required).map((item) => item.name),
      optionalParams: parameterHints.filter((item) => !item.required).map((item) => item.name),
      transport,
      userAgent: authHints.userAgent,
      dangerLevel: determineDangerLevel(description, description, path, method),
    });
  }

  return endpoints;
}

function determineDangerLevel(
  description: string,
  operation: string,
  path: string,
  method: string,
): "readonly" | "mutating" {
  const normalized = `${description} ${operation} ${path}`.toLowerCase();
  if (method === "GET") {
    return "readonly";
  }
  if (method === "DELETE") {
    return "mutating";
  }

  const readonlyHints = [
    /\bget\b/,
    /\bquery\b/,
    /\blist\b/,
    /\bstatus\b/,
    /\binfo\b/,
    /\bhistory\b/,
    /\brecord\b/,
    /\blog\b/,
    /\bpermission\b/,
    /\bbalance\b/,
    /\bwallet\b/,
    /\basset detail\b/,
    /\buser asset\b/,
    /\bfunding wallet\b/,
    /\btrade fee\b/,
    /\bsnapshot\b/,
    /\bopen symbol\b/,
    /\bcan be converted\b/,
    /\bconvertible\b/,
    /\bsearch\b/,
    /\brank\b/,
    /\bsignal\b/,
    /\bticker\b/,
    /\bdepth\b/,
    /\bkline\b/,
    /\baudit\b/,
    /\btoken info\b/,
  ];

  return readonlyHints.some((pattern) => pattern.test(normalized)) ? "readonly" : "mutating";
}

async function collectReferenceFiles(rootDir: string): Promise<SkillReferenceFile[]> {
  const referencesDir = join(rootDir, "references");
  try {
    const files = await enumerateFiles(referencesDir);
    return files
      .filter((path) => extname(path).toLowerCase() === ".md")
      .map((absolutePath) => ({
        relativePath: relative(rootDir, absolutePath),
        absolutePath,
      }));
  } catch {
    return [];
  }
}

async function collectExecutionHints(rootDir: string, sections: SkillSectionMap): Promise<SkillExecutionHint[]> {
  const scriptDir = join(rootDir, "scripts");
  const hints: SkillExecutionHint[] = [];

  try {
    const files = await enumerateFiles(scriptDir);
    for (const absolutePath of files) {
      const relativePath = relative(rootDir, absolutePath);
      const extension = extname(absolutePath).toLowerCase();
      hints.push({
        kind: "script",
        name: camelCase(basename(absolutePath, extension)),
        relativePath,
        absolutePath,
        interpreter: extension === ".py" ? "python3" : extension === ".sh" ? "bash" : extension === ".ts" || extension === ".js" ? "node" : undefined,
        dangerous: /(trade|order|withdraw|transfer|mainnet)/i.test(`${sections.instructions}\n${relativePath}`),
      });
    }
  } catch {
    return [];
  }

  return hints;
}

function collectPolicyRules(
  manifest: SkillManifest,
  authHints: SkillAuthHints,
  endpointHints: SkillEndpointHint[],
): PolicyRule[] {
  const rules: PolicyRule[] = [];
  if (authHints.confirmOnTransactions || manifest.dangerous || endpointHints.some((item) => item.dangerLevel === "mutating")) {
    rules.push({
      kind: "approval",
      summary: "资金或仓位变化相关操作必须经过确认",
      appliesTo: endpointHints.filter((item) => item.dangerLevel === "mutating").map((item) => item.id),
    });
  }
  if (authHints.headerNames.some((item) => item.toLowerCase() === "user-agent") && authHints.userAgent) {
    rules.push({
      kind: "user-agent",
      summary: "请求需附带 skill 指定的 User-Agent",
      value: authHints.userAgent,
    });
  }
  if (authHints.requiresApiKey || authHints.requiresSecretKey) {
    rules.push({
      kind: "mask-secrets",
      summary: "结果与 trace 中隐藏敏感密钥信息",
    });
    rules.push({
      kind: "account-alias",
      summary: "默认使用 main 账户别名映射环境变量中的 Binance 凭证",
      value: "main",
    });
  }
  return rules;
}

async function buildSkillKnowledge(
  body: string,
  manifest: SkillManifest,
  rootDir: string,
  sourcePath: string,
): Promise<SkillKnowledge> {
  const sections = collectSections(body);
  const parameterHints = parseParameterHints(sections.parameters ?? "");
  const authHints = collectAuthHints(sections);
  const endpointHints = Array.from(
    new Map(
      [
        ...parseQuickReferenceEndpoints(manifest, sections, authHints, parameterHints, rootDir),
        ...parseApiBlocks(manifest, body, authHints, parameterHints, rootDir),
      ].map((item) => [item.id, item]),
    ).values(),
  );
  const referenceFiles = await collectReferenceFiles(rootDir);
  const executionHints = await collectExecutionHints(rootDir, sections);
  const policyRules = collectPolicyRules(manifest, authHints, endpointHints);

  return {
    sections,
    endpointHints,
    authHints,
    referenceFiles,
    executionHints,
    policyRules,
  };
}

function serializeSkill(skill: InstalledSkill): string {
  return `---\nname: "${skill.manifest.name}"\nversion: "${skill.manifest.version}"\ndescription: "${skill.manifest.description}"\ncapabilities: [${skill.manifest.capabilities.map((item) => `"${item}"`).join(", ")}]\nrequires_auth: ${skill.manifest.requires_auth}\ndangerous: ${skill.manifest.dangerous}\nproducts: [${skill.manifest.products.map((item) => `"${item}"`).join(", ")}]\ntools: [${skill.manifest.tools.map((item) => `"${item}"`).join(", ")}]\n---\n\n${skill.instructions}\n`;
}

export async function parseSkillDocument(
  content: string,
  sourcePath: string,
  rootDir = dirname(resolve(sourcePath)),
): Promise<ParseResult> {
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/);
  if (!match) {
    throw new Error(`Skill ${sourcePath} 缺少 frontmatter`);
  }

  const baseManifest = validateManifest(parseFrontmatter(match[1]), sourcePath);
  const body = match[2].trim();
  const toolDefinitions = collectToolDefinitions(body, sourcePath);
  const knowledge = await buildSkillKnowledge(body, baseManifest, rootDir, sourcePath);
  const manifest: SkillManifest = {
    ...baseManifest,
    requires_auth:
      baseManifest.requires_auth ||
      knowledge.authHints.requiresApiKey ||
      knowledge.endpointHints.some((item) => item.authRequired),
    dangerous:
      baseManifest.dangerous ||
      knowledge.policyRules.some((rule) => rule.kind === "approval") ||
      knowledge.endpointHints.some((item) => item.dangerLevel === "mutating"),
  };

  return {
    skill: {
      manifest,
      toolDefinitions,
      knowledge,
      instructions: body,
      sourcePath,
      rootDir,
      warnings: collectWarnings(body),
    },
  };
}

async function readSkillFile(pathname: string): Promise<InstalledSkill> {
  const raw = await readFile(pathname, "utf8");
  return (await parseSkillDocument(raw, pathname, dirname(pathname))).skill;
}

async function enumerateFiles(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const entryPath = join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await enumerateFiles(entryPath)));
    } else if (entry.isFile()) {
      files.push(entryPath);
    }
  }
  return files;
}

async function enumerateMarkdownFiles(directory: string): Promise<string[]> {
  try {
    return (await enumerateFiles(directory)).filter((path) => extname(path).toLowerCase() === ".md");
  } catch {
    return [];
  }
}

function isSkillMarkdownPath(path: string): boolean {
  return /(^|\/)SKILL\.md$/i.test(path) || /^skills\/.+\.md$/i.test(path) || /^.+\/skills\/.+\.md$/i.test(path);
}

export async function loadInstalledSkills(config: AppConfig): Promise<InstalledSkill[]> {
  const skillFiles = [
    ...(await enumerateMarkdownFiles(config.globalSkillsDir)),
    ...(await enumerateMarkdownFiles(config.localSkillsDir)),
  ].filter((path) => {
    if (basename(path).toLowerCase() === "skill.md") {
      return true;
    }
    return dirname(path) === config.globalSkillsDir || dirname(path) === config.localSkillsDir;
  });
  const uniqueByName = new Map<string, InstalledSkill>();

  for (const skillFile of skillFiles) {
    const skill = await readSkillFile(skillFile);
    uniqueByName.set(skill.manifest.name, skill);
  }

  return Array.from(uniqueByName.values()).sort((a, b) => a.manifest.name.localeCompare(b.manifest.name));
}

function normalizeRemoteSkillUrl(source: string): string {
  if (source.includes("raw.githubusercontent.com")) {
    return source;
  }
  if (source.includes("github.com") && source.includes("/blob/")) {
    return source
      .replace("https://github.com/", "https://raw.githubusercontent.com/")
      .replace("/blob/", "/");
  }
  return source;
}

function parseGitHubRepoSource(source: string): GitHubRepoSource | null {
  try {
    const url = new URL(source);
    if (url.hostname !== "github.com") {
      return null;
    }
    const parts = url.pathname.split("/").filter(Boolean);
    if (parts.length < 2) {
      return null;
    }
    const [owner, repo, mode, ref, ...rest] = parts;
    if (mode === "blob") {
      return null;
    }
    if (mode === "tree" && ref) {
      return {
        owner,
        repo,
        ref,
        path: rest.join("/"),
      };
    }
    return {
      owner,
      repo,
      path: "",
    };
  } catch {
    return null;
  }
}

async function fetchJson(url: string, fetchImpl: typeof fetch): Promise<unknown> {
  const response = await fetchImpl(url, {
    headers: {
      Accept: "application/vnd.github+json, application/json",
      "User-Agent": "BinaClaw",
    },
  });
  if (!response.ok) {
    throw new Error(`请求失败: ${response.status} ${response.statusText}`);
  }
  return await response.json();
}

async function fetchText(url: string, fetchImpl: typeof fetch): Promise<string> {
  const response = await fetchImpl(url, {
    headers: {
      Accept: "text/plain, text/markdown;q=0.9, */*;q=0.1",
      "User-Agent": "BinaClaw",
    },
  });
  if (!response.ok) {
    throw new Error(`下载 skill 失败: ${response.status} ${response.statusText}`);
  }
  return await response.text();
}

function normalizePackageMainFile(path: string): string {
  return basename(path).toLowerCase() === "skill.md" ? "SKILL.md" : basename(path);
}

async function resolveRemoteSkillPackages(
  source: string,
  fetchImpl: typeof fetch,
): Promise<SkillPackage[]> {
  const repoSource = parseGitHubRepoSource(source);
  if (!repoSource) {
    return [
      {
        sourcePath: source,
        mainRelativePath: "SKILL.md",
        files: [
          {
            relativePath: "SKILL.md",
            content: await fetchText(normalizeRemoteSkillUrl(source), fetchImpl),
          },
        ],
      },
    ];
  }

  const repoInfo = (await fetchJson(
    `https://api.github.com/repos/${repoSource.owner}/${repoSource.repo}`,
    fetchImpl,
  )) as { default_branch?: string };
  const ref = repoSource.ref ?? repoInfo.default_branch ?? "main";
  const tree = (await fetchJson(
    `https://api.github.com/repos/${repoSource.owner}/${repoSource.repo}/git/trees/${encodeURIComponent(ref)}?recursive=1`,
    fetchImpl,
  )) as { tree?: RemoteTreeEntry[] };

  const prefix = repoSource.path ? `${repoSource.path.replace(/\/+$/, "")}/` : "";
  const candidates = (tree.tree ?? [])
    .filter((entry) => entry.type === "blob" && typeof entry.path === "string")
    .map((entry) => entry.path as string)
    .filter((path) => {
      if (prefix && !path.startsWith(prefix)) {
        return false;
      }
      return isSkillMarkdownPath(path);
    });

  const packages: SkillPackage[] = [];
  for (const skillPath of candidates) {
    const rootPath = basename(skillPath).toLowerCase() === "skill.md" ? dirname(skillPath) : dirname(skillPath);
    const skillRootPrefix = basename(skillPath).toLowerCase() === "skill.md" ? `${rootPath}/` : "";
    const filePaths = basename(skillPath).toLowerCase() === "skill.md"
      ? (tree.tree ?? [])
          .filter((entry) => entry.type === "blob" && typeof entry.path === "string")
          .map((entry) => entry.path as string)
          .filter((path) => path === skillPath || path.startsWith(skillRootPrefix))
      : [skillPath];

    const files: SkillPackageFile[] = [];
    for (const filePath of filePaths) {
      const rawUrl = `https://raw.githubusercontent.com/${repoSource.owner}/${repoSource.repo}/${ref}/${filePath}`;
      try {
        files.push({
          relativePath: basename(skillPath).toLowerCase() === "skill.md"
            ? relative(rootPath, filePath)
            : normalizePackageMainFile(filePath),
          content: await fetchText(rawUrl, fetchImpl),
        });
      } catch {
        continue;
      }
    }
    const mainRelativePath = basename(skillPath).toLowerCase() === "skill.md"
      ? "SKILL.md"
      : normalizePackageMainFile(skillPath);
    const mainFile = files.find((file) => file.relativePath === mainRelativePath);
    if (!mainFile) {
      continue;
    }
    await parseSkillDocument(mainFile.content, join("/virtual", mainRelativePath), "/virtual");
    packages.push({
      sourcePath: `https://github.com/${repoSource.owner}/${repoSource.repo}/${ref}/${skillPath}`,
      mainRelativePath,
      files,
    });
  }

  if (packages.length === 0) {
    throw new Error(`在仓库 ${source} 中没有找到可安装的 skill 文档。`);
  }

  return packages;
}

async function resolveLocalSkillPackages(source: string): Promise<SkillPackage[]> {
  const absoluteSource = resolve(source);
  const details = await stat(absoluteSource);
  if (details.isFile()) {
    return [
      {
        sourcePath: absoluteSource,
        mainRelativePath: normalizePackageMainFile(absoluteSource),
        files: [
          {
            relativePath: normalizePackageMainFile(absoluteSource),
            content: await readFile(absoluteSource, "utf8"),
          },
        ],
      },
    ];
  }

  const markdownFiles = await enumerateMarkdownFiles(absoluteSource);
  const skillFiles = markdownFiles.filter(isSkillMarkdownPath);
  if (skillFiles.length === 0) {
    throw new Error(`目录 ${source} 中没有找到可安装的 skill 文档。`);
  }

  const packages: SkillPackage[] = [];
  for (const skillFile of skillFiles) {
    const isDirectorySkill = basename(skillFile).toLowerCase() === "skill.md";
    const rootDir = isDirectorySkill ? dirname(skillFile) : dirname(skillFile);
    const files = isDirectorySkill
      ? (await enumerateFiles(rootDir)).map(async (filePath) => ({
          relativePath: relative(rootDir, filePath),
          content: await readFile(filePath, "utf8"),
        }))
      : [
          Promise.resolve({
            relativePath: basename(skillFile),
            content: await readFile(skillFile, "utf8"),
          }),
        ];
    packages.push({
      sourcePath: skillFile,
      mainRelativePath: isDirectorySkill ? "SKILL.md" : basename(skillFile),
      files: await Promise.all(files),
    });
  }

  return packages;
}

async function writeInstalledPackage(
  skillPackage: SkillPackage,
  config: AppConfig,
): Promise<InstalledSkill> {
  await mkdir(config.globalSkillsDir, { recursive: true });
  const parsed = await parseSkillDocument(
    skillPackage.files.find((file) => file.relativePath === skillPackage.mainRelativePath)?.content ?? "",
    join("/virtual", skillPackage.mainRelativePath),
    "/virtual",
  );
  const targetDir = join(config.globalSkillsDir, slugify(parsed.skill.manifest.name));
  await rm(targetDir, { recursive: true, force: true });
  await mkdir(targetDir, { recursive: true });

  for (const file of skillPackage.files) {
    const targetPath = join(targetDir, file.relativePath);
    await mkdir(dirname(targetPath), { recursive: true });
    await writeFile(targetPath, file.content, "utf8");
  }

  const mainPath = join(targetDir, skillPackage.mainRelativePath);
  return await readSkillFile(mainPath);
}

export async function installSkillsFromSource(
  source: string,
  config: AppConfig,
  fetchImpl: typeof fetch = fetch,
): Promise<InstalledSkill[]> {
  const packages = /^https?:\/\//.test(source)
    ? await resolveRemoteSkillPackages(source, fetchImpl)
    : await resolveLocalSkillPackages(source);

  const installed: InstalledSkill[] = [];
  for (const skillPackage of packages) {
    installed.push(await writeInstalledPackage(skillPackage, config));
  }
  return installed.sort((a, b) => a.manifest.name.localeCompare(b.manifest.name));
}

export async function installSkillFromSource(
  source: string,
  config: AppConfig,
  fetchImpl: typeof fetch = fetch,
): Promise<InstalledSkill> {
  const installed = await installSkillsFromSource(source, config, fetchImpl);
  if (installed.length === 0) {
    throw new Error(`未能从 ${source} 安装任何 skill。`);
  }
  return installed[0];
}

export async function syncWorkspaceToolsIndex(
  config: AppConfig,
  skills: InstalledSkill[],
): Promise<void> {
  await mkdir(config.workspaceDir, { recursive: true });
  const content = [
    "# TOOLS",
    "",
    "## Accounts",
    `- main: ${config.binance.apiKey && config.binance.apiSecret ? "configured via environment" : "not configured"}`,
    "",
    "## Installed Skills",
    ...skills.map((skill) => `- ${skill.manifest.name}: ${skill.manifest.description}`),
    "",
    "## Notes",
    "- Secrets are not stored here.",
    "- Runtime may compile HTTP, Binance-signed HTTP, exec, and memory transports from installed skills.",
    "",
  ].join("\n");
  await writeFile(config.workspaceToolsFile, content, "utf8");
}

export async function loadSkillReferenceSnippets(
  skills: InstalledSkill[],
  selections: Array<{ skillName: string; relativePath: string }>,
  maxCharsPerFile = 2400,
): Promise<SkillReferenceSnippet[]> {
  const skillMap = new Map(skills.map((skill) => [skill.manifest.name, skill]));
  const snippets: SkillReferenceSnippet[] = [];

  for (const selection of selections) {
    const skill = skillMap.get(selection.skillName);
    if (!skill) {
      continue;
    }
    const reference = skill.knowledge.referenceFiles.find((item) => item.relativePath === selection.relativePath);
    if (!reference) {
      continue;
    }
    const content = await readFile(reference.absolutePath, "utf8").catch(() => "");
    if (!content.trim()) {
      continue;
    }
    snippets.push({
      skillName: skill.manifest.name,
      relativePath: reference.relativePath,
      content: content.slice(0, maxCharsPerFile),
    });
  }

  return snippets;
}

export function selectFallbackReferenceSnippets(
  input: string,
  skills: InstalledSkill[],
): Array<{ skillName: string; relativePath: string }> {
  const lowered = input.toLowerCase();
  const results: Array<{ skillName: string; relativePath: string }> = [];

  for (const skill of skills) {
    const references = skill.knowledge.referenceFiles;
    if (references.length === 0) {
      continue;
    }
    const authLike =
      /(auth|sign|signature|apikey|secret|权限|签名|认证|主网|mainnet|下单|trade|order)/.test(lowered) ||
      skill.knowledge.endpointHints.some((item) => item.authRequired || item.dangerLevel === "mutating");
    if (authLike) {
      const authRef = references.find((item) => /auth/i.test(item.relativePath));
      if (authRef) {
        results.push({
          skillName: skill.manifest.name,
          relativePath: authRef.relativePath,
        });
      }
    }
  }

  return Array.from(new Map(results.map((item) => [`${item.skillName}:${item.relativePath}`, item])).values()).slice(0, 3);
}
