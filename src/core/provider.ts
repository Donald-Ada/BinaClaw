import OpenAI from "openai";
import type {
  ChatMessage,
  ConversationState,
  ConversationStateRequest,
  DirectResponseRequest,
  EndpointDecision,
  ModelPlanResult,
  PlanningRequest,
  ProviderConfig,
  SkillReferenceSelectionRequest,
  SkillReferenceSelectionResult,
  SkillSelectionRequest,
  SkillSelectionResult,
  SummaryRequest,
} from "./types.ts";

export interface ChatProvider {
  isConfigured(): boolean;
  resolveConversationState?(request: ConversationStateRequest): Promise<ConversationState | null>;
  selectSkills(request: SkillSelectionRequest): Promise<SkillSelectionResult | null>;
  selectSkillReferences(request: SkillReferenceSelectionRequest): Promise<SkillReferenceSelectionResult | null>;
  plan(request: PlanningRequest): Promise<ModelPlanResult | null>;
  extractStableFacts(input: string, sessionSummary?: string): Promise<string[] | null>;
  composeDirectResponse?(request: DirectResponseRequest): Promise<string | null>;
  summarize(request: SummaryRequest): Promise<string>;
  streamSummary?(request: SummaryRequest, onDelta: (delta: string) => void): Promise<string>;
}

interface OpenAIResponsesClient {
  responses: {
    create(params: {
      model: string;
      input: Array<{
        role: ChatMessage["role"];
        content: Array<{
          type: "input_text";
          text: string;
        }>;
      }>;
      tools?: Array<{
        type: "function";
        name: string;
        description: string;
        parameters: Record<string, unknown>;
      }>;
    }): Promise<{
      output_text?: string;
      output?: Array<{
        type?: string;
        name?: string;
        arguments?: unknown;
        content?: Array<{
          type?: string;
          text?: string;
        }>;
      }>;
    }>;
    stream(params: {
      model: string;
      input: Array<{
        role: ChatMessage["role"];
        content: Array<{
          type: "input_text";
          text: string;
        }>;
      }>;
      tools?: Array<{
        type: "function";
        name: string;
        description: string;
        parameters: Record<string, unknown>;
      }>;
    }): Promise<
      AsyncIterable<{
        type?: string;
        delta?: string;
        response?: {
          output_text?: string;
          output?: Array<{
            type?: string;
            name?: string;
            arguments?: unknown;
            content?: Array<{
              type?: string;
              text?: string;
            }>;
          }>;
        };
      }>
    >;
  };
}

export class OpenAICompatibleProvider implements ChatProvider {
  private readonly config: ProviderConfig;
  private readonly client?: OpenAIResponsesClient;

  constructor(
    config: ProviderConfig,
    client?: OpenAIResponsesClient,
  ) {
    this.config = config;
    this.client =
      client ??
      (config.apiKey
        ? createOpenAIResponsesClient(config)
        : undefined);
  }

  isConfigured(): boolean {
    return Boolean(this.config.apiKey && this.config.model);
  }

  async selectSkills(request: SkillSelectionRequest): Promise<SkillSelectionResult | null> {
    if (!this.isConfigured()) {
      return null;
    }

    const response = await this.fetchResponse(buildSkillSelectionMessages(request));
    const parsed = parseJsonObject<SkillSelectionResult>(extractResponseText(response));
    if (!parsed?.skillNames || !Array.isArray(parsed.skillNames)) {
      return null;
    }

    const allowed = new Set(request.skills.map((skill) => skill.manifest.name));
    const skillNames = parsed.skillNames.filter((name) => typeof name === "string" && allowed.has(name));
    if (skillNames.length === 0) {
      return null;
    }

    return {
      skillNames,
      rationale: typeof parsed.rationale === "string" ? parsed.rationale : undefined,
    };
  }

  async resolveConversationState(request: ConversationStateRequest): Promise<ConversationState | null> {
    if (!this.isConfigured()) {
      return null;
    }

    const response = await this.fetchResponse(buildConversationStateMessages(request));
    const parsed = parseJsonObject<ConversationState>(extractResponseText(response));
    if (!parsed || typeof parsed !== "object") {
      return null;
    }

    const currentTopic =
      parsed.currentTopic && ["market", "news", "web3", "account", "trade", "orders"].includes(parsed.currentTopic)
        ? parsed.currentTopic
        : undefined;
    const currentMarketType =
      parsed.currentMarketType && ["spot", "futures"].includes(parsed.currentMarketType)
        ? parsed.currentMarketType
        : undefined;

    return {
      currentSymbol: typeof parsed.currentSymbol === "string" ? parsed.currentSymbol : undefined,
      currentTopic,
      currentMarketType,
      summary: typeof parsed.summary === "string" ? parsed.summary : undefined,
    };
  }

  async selectSkillReferences(
    request: SkillReferenceSelectionRequest,
  ): Promise<SkillReferenceSelectionResult | null> {
    if (!this.isConfigured()) {
      return null;
    }
    const response = await this.fetchResponse(buildReferenceSelectionMessages(request));
    const parsed = parseJsonObject<SkillReferenceSelectionResult>(extractResponseText(response));
    if (!parsed?.references || !Array.isArray(parsed.references)) {
      return null;
    }

    const allowed = new Set(
      request.activeSkills.flatMap((skill) =>
        skill.knowledge.referenceFiles.map((reference) => `${skill.manifest.name}:${reference.relativePath}`),
      ),
    );
    const references = parsed.references.filter(
      (item) =>
        item &&
        typeof item.skillName === "string" &&
        typeof item.relativePath === "string" &&
        allowed.has(`${item.skillName}:${item.relativePath}`),
    );
    if (references.length === 0) {
      return null;
    }
    return {
      references,
      rationale: typeof parsed.rationale === "string" ? parsed.rationale : undefined,
    };
  }

  async plan(request: PlanningRequest): Promise<ModelPlanResult | null> {
    if (!this.isConfigured()) {
      return null;
    }

    const toolPayload = request.tools.map((tool) => ({
      type: "function" as const,
      name: toFunctionName(tool.id),
      description: buildToolDescription(tool),
      parameters: normalizeFunctionParameters(tool.inputSchema),
    }));

    const response = await this.fetchResponse(buildPlanningMessages(request), toolPayload);
    return parseFunctionCallPlan(response, request);
  }

  async extractStableFacts(input: string, sessionSummary?: string): Promise<string[] | null> {
    if (!this.isConfigured()) {
      return null;
    }

    const messages: ChatMessage[] = [
      {
        role: "system",
        content: [
          "你要从用户输入中提取值得长期记住的稳定事实。",
          "只提取长期稳定、跨会话仍然有价值的用户画像信息，例如语言偏好、风险偏好、偏好市场、长期关注交易对、固定习惯。",
          "不要提取一次性任务、短期问题、临时情绪或行情判断。",
          '只返回 JSON，对象格式为 {"facts":["..."]}。',
          'facts 中每一项都应是简短中文陈述，例如 "用户偏好中文输出"、"用户长期关注交易对 BTCUSDT"。',
        ].join("\n"),
      },
      {
        role: "user",
        content: [
          `用户输入: ${input}`,
          `会话摘要: ${sessionSummary ?? ""}`,
        ].join("\n"),
      },
    ];

    const response = await this.fetchResponse(messages);
    const parsed = parseJsonObject<{ facts?: string[] }>(extractResponseText(response));
    return Array.isArray(parsed?.facts) ? parsed.facts.filter((item) => typeof item === "string") : null;
  }

  async composeDirectResponse(request: DirectResponseRequest): Promise<string | null> {
    if (!this.isConfigured()) {
      return null;
    }

    const response = await this.fetchResponse(buildDirectResponseMessages(request));
    const text = normalizeModelText(extractResponseText(response));
    return text || null;
  }

  async summarize(request: SummaryRequest): Promise<string> {
    if (!this.isConfigured()) {
      return fallbackSummary(request);
    }

    const messages: ChatMessage[] = [
      {
        role: "system",
        content:
          "你是 BinaClaw，一个偏交易助手风格的中文 CLI Agent。你会基于工具结果做谨慎、简洁、有风险提示的总结，不虚构数据。",
      },
      {
        role: "user",
        content: [
          `用户输入: ${request.input}`,
          `激活技能: ${request.activeSkills.map((skill) => skill.manifest.name).join(", ") || "none"}`,
          "workspace docs 摘要:",
          formatWorkspaceDocs(request.session.memoryContext?.workspaceDocs),
          "工具结果:",
          JSON.stringify(request.toolResults, null, 2),
          "结构化推理轨迹:",
          JSON.stringify(request.session.scratchpad.slice(-8), null, 2),
        ].join("\n"),
      },
    ];

    const response = await this.fetchResponse(messages);
    return normalizeModelText(extractResponseText(response)) || fallbackSummary(request);
  }

  async streamSummary(request: SummaryRequest, onDelta: (delta: string) => void): Promise<string> {
    if (!this.isConfigured()) {
      const text = fallbackSummary(request);
      onDelta(text);
      return text;
    }

    const messages: ChatMessage[] = [
      {
        role: "system",
        content:
          "你是 BinaClaw，一个偏交易助手风格的中文 CLI Agent。你会基于工具结果做谨慎、简洁、有风险提示的总结，不虚构数据。输出纯文本，不要使用 Markdown 标题、代码块或列表符号。",
      },
      {
        role: "user",
        content: [
          `用户输入: ${request.input}`,
          `激活技能: ${request.activeSkills.map((skill) => skill.manifest.name).join(", ") || "none"}`,
          "workspace docs 摘要:",
          formatWorkspaceDocs(request.session.memoryContext?.workspaceDocs),
          "工具结果:",
          JSON.stringify(request.toolResults, null, 2),
          "结构化推理轨迹:",
          JSON.stringify(request.session.scratchpad.slice(-8), null, 2),
        ].join("\n"),
      },
    ];

    const stream = await this.streamResponse(messages);
    let fullText = "";

    for await (const event of stream) {
      if (event.type === "response.output_text.delta" && event.delta) {
        fullText += event.delta;
        onDelta(event.delta);
        continue;
      }
      if (event.type === "response.completed" && event.response) {
        const completedText = extractResponseText(event.response);
        if (!fullText && completedText) {
          fullText = completedText;
          onDelta(completedText);
        }
      }
    }

    return normalizeModelText(fullText) || fallbackSummary(request);
  }

  private async fetchResponse(
    messages: ChatMessage[],
    tools: Array<{
      type: "function";
      name: string;
      description: string;
      parameters: Record<string, unknown>;
    }> = [],
  ) {
    if (!this.client) {
      return {};
    }
    return await this.client.responses.create({
      model: this.config.model ?? "",
      input: messages.map((message) => ({
        role: message.role,
        content: [
          {
            type: "input_text",
            text: message.content,
          },
        ],
      })),
      tools: tools.length > 0 ? tools : undefined,
    });
  }

  private async streamResponse(
    messages: ChatMessage[],
    tools: Array<{
      type: "function";
      name: string;
      description: string;
      parameters: Record<string, unknown>;
    }> = [],
  ) {
    if (!this.client) {
      return (async function* () {})();
    }
    return await this.client.responses.stream({
      model: this.config.model ?? "",
      input: messages.map((message) => ({
        role: message.role,
        content: [
          {
            type: "input_text",
            text: message.content,
          },
        ],
      })),
      tools: tools.length > 0 ? tools : undefined,
    });
  }
}

function createOpenAIResponsesClient(config: ProviderConfig): OpenAIResponsesClient {
  const client = new OpenAI({
    apiKey: config.apiKey,
    baseURL: config.baseUrl,
  });

  return {
    responses: {
      create: async (params) =>
        await client.responses.create({
          ...params,
          tools: params.tools?.map((tool) => ({
            ...tool,
            strict: false,
          })),
        }),
      stream: async (params) => {
        const stream = await client.responses.create({
          ...params,
          stream: true,
          tools: params.tools?.map((tool) => ({
            ...tool,
            strict: false,
          })),
        });

        return (async function* () {
          for await (const event of stream) {
            if (event.type === "response.output_text.delta") {
              yield {
                type: event.type,
                delta: typeof event.delta === "string" ? event.delta : "",
              };
              continue;
            }
            if (event.type === "response.completed") {
              yield {
                type: event.type,
                response: event.response
                  ? {
                      output_text: event.response.output_text,
                      output: event.response.output?.map((item) => ({
                        type: item.type,
                        name: "name" in item ? item.name : undefined,
                        arguments: "arguments" in item ? item.arguments : undefined,
                        content: "content" in item && Array.isArray(item.content)
                          ? item.content.map((part) => ({
                              type: part.type,
                              text: "text" in part ? part.text : undefined,
                            }))
                          : undefined,
                      })),
                    }
                  : undefined,
              };
            }
          }
        })();
      },
    },
  };
}

function buildPlanningMessages(request: PlanningRequest): ChatMessage[] {
  return [
    {
      role: "system",
      content: [
        "你是 BinaClaw 的主规划器。",
        "你的任务是在一次主调用里完成这些决策：基于已选中的 skills 决定是否调用工具、更新会话主题状态、以及在无需工具时直接回复用户。",
        "下面会提供已经通过第一阶段选中的 skills，它们包含完整的 SKILL.md 内容。",
        "你必须优先依据这些 skill 文档里的 When to use、Instructions、Quick Reference、Available APIs、Authentication、Security 来决定该调用哪个工具或接口能力。",
        "如果你决定调用某个接口或工具，请同时返回 endpointDecision，说明你依据的是哪个 skill、哪个接口能力。",
        "你必须结合最近会话来理解用户的跟进语句，例如“继续”“那 ETH 呢”“换成 4 小时级别”。",
        "只有当当前输入明显是跟进语句时，才允许延续最近明确提到的主交易对或主题。",
        "如果当前输入没有明确交易对，且也不是明显跟进，不要自己猜 symbol，应该直接追问用户想看哪个交易对。",
        "你只能从提供的 tools 中选择，不能发明新工具。",
        "如果用户信息不足，directResponse 应该直接自然追问缺失信息，不要伪造 tool input。",
        "危险工具也可以规划出来，但不要替用户确认，确认由本地审批流处理。",
        "如果危险交易参数已经完整，就直接返回对应的 dangerous toolCalls，不要自己发起“请回复确认下单”之类的模拟审批对话。",
        "如果已有 observations 足以回答，请优先返回 directResponse。",
        "如果还需要更多信息，可以继续返回 toolCalls。",
        "在文本输出中优先返回 JSON 对象，格式为 {\"selectedSkillNames\":[\"...\"],\"endpointDecision\":{\"skillName\":\"spot\",\"toolId\":\"spot.placeOrder\",\"endpointId\":\"spot.placeOrder\",\"operation\":\"spot new order\",\"method\":\"POST\",\"path\":\"/api/v3/order\",\"transport\":\"builtin\",\"rationale\":\"...\"},\"directResponse\":\"...\",\"conversationStateUpdate\":{\"currentSymbol\":\"...\",\"currentTopic\":\"market\",\"currentMarketType\":\"spot\",\"summary\":\"...\"}}。",
        "如果你选择了 function tools，仍然可以同时返回上述 JSON 文本；directResponse 可以为空字符串。",
      ].join("\n"),
    },
    {
      role: "user",
      content: [
        `用户输入: ${request.input}`,
        `是否具备交易认证: ${request.authAvailable ? "yes" : "no"}`,
        `当前会话主题状态: ${formatConversationState(request.session.conversationState)}`,
        "最近会话:",
        formatRecentConversation(request.session.messages),
        "workspace docs 摘要:",
        formatWorkspaceDocs(request.memoryContext?.workspaceDocs),
        "已选中 skills 的 SKILL.md 文档:",
        ...request.candidateSkills.map((skill) => formatPlanningSkillDocument(skill)),
        `可用 tools 数量: ${request.tools.length}`,
        `当前迭代: ${request.iteration}`,
        "workspace memory 摘要:",
        request.memoryContext
          ? JSON.stringify(
              {
                longTermMemory: request.memoryContext.longTermMemory.slice(0, 260),
                recentEntries: request.memoryContext.recentEntries.map((entry) => ({
                  date: entry.date,
                  content: entry.content.slice(0, 140),
                })),
              },
              null,
              2,
            )
          : "null",
        "结构化 scratchpad:",
        request.session.scratchpad.length > 0 ? JSON.stringify(request.session.scratchpad.slice(-5), null, 2) : "[]",
        "已加载 references:",
        request.referenceContext && request.referenceContext.length > 0
          ? JSON.stringify(
              request.referenceContext.map((item) => ({
                skillName: item.skillName,
                relativePath: item.relativePath,
                content: item.content.slice(0, 260),
              })),
              null,
              2,
            )
          : "[]",
        "已有 observations:",
        request.observations.length > 0 ? JSON.stringify(request.observations.slice(-6), null, 2) : "[]",
      ].join("\n"),
    },
  ];
}

function buildReferenceSelectionMessages(request: SkillReferenceSelectionRequest): ChatMessage[] {
  return [
    {
      role: "system",
      content: [
        "你是 BinaClaw 的 skill reference selector。",
        "你的任务是从当前已激活 skill 的 references 中挑选当前问题真正需要读取的文件。",
        "如果用户是在延续上一轮问题，你必须结合最近会话理解当前主语和目标，不要只看这一句的字面含义。",
        "只有在参数细节、签名认证、安全规则、脚本用法等需要更细上下文时才选择 references。",
        "最多选择 3 个文件，不要全选。",
        "只返回 JSON，对象格式为 {\"references\":[{\"skillName\":\"...\",\"relativePath\":\"...\"}],\"rationale\":\"...\"}。",
      ].join("\n"),
    },
    {
      role: "user",
      content: [
        `用户输入: ${request.input}`,
        `是否具备交易认证: ${request.authAvailable ? "yes" : "no"}`,
        `当前会话主题状态: ${formatConversationState(request.session.conversationState)}`,
        "最近会话:",
        formatRecentConversation(request.session.messages),
        "workspace docs 摘要:",
        formatWorkspaceDocs(request.memoryContext?.workspaceDocs),
        "已激活 skills 及其可用 references:",
        ...request.activeSkills.map((skill) =>
          [
            `- ${skill.manifest.name}: ${skill.manifest.description}`,
            `  endpoint_count=${skill.knowledge.endpointHints.length}`,
            `  auth=${summarizeList(skill.knowledge.authHints.signatureAlgorithms, 3)}`,
            `  references=${summarizeList(skill.knowledge.referenceFiles.map((item) => item.relativePath), 6)}`,
          ].join("\n"),
        ),
        "workspace memory 摘要:",
        request.memoryContext
          ? JSON.stringify(
              {
                longTermMemory: request.memoryContext.longTermMemory.slice(0, 180),
                recentEntries: request.memoryContext.recentEntries.map((entry) => ({
                  date: entry.date,
                  content: entry.content.slice(0, 100),
                })),
              },
              null,
              2,
            )
          : "null",
      ].join("\n"),
    },
  ];
}

function buildSkillSelectionMessages(request: SkillSelectionRequest): ChatMessage[] {
  return [
    {
      role: "system",
      content: [
        "你是 BinaClaw 的 skill selector。",
        "你的任务是从可用 skills 中选出最适合当前请求的 1 到 4 个技能。",
        "优先根据 skill 的 description、capabilities、When to use、Instructions 来判断，不要机械按关键词硬匹配。",
        "如果用户这轮是在延续上一轮话题，例如“继续”“那 ETH 呢”，你必须结合最近会话理解主语和上下文。",
        "如果用户没有明确切换主题，就延续最近清晰的交易对或分析对象。",
        "不要发明不存在的 skill 名称。",
        "如果用户要交易，应该同时考虑交易 skill 和对应账户/风险相关 skill。",
        "只返回 JSON，对象格式为 {\"skillNames\":[\"...\"],\"rationale\":\"...\"}。",
      ].join("\n"),
    },
    {
      role: "user",
      content: [
        `用户输入: ${request.input}`,
        `是否具备交易认证: ${request.authAvailable ? "yes" : "no"}`,
        `当前会话主题状态: ${formatConversationState(request.session.conversationState)}`,
        "最近会话:",
        formatRecentConversation(request.session.messages),
        "workspace docs 摘要:",
        formatWorkspaceDocs(request.memoryContext?.workspaceDocs),
        "workspace memory 摘要:",
        request.memoryContext
          ? JSON.stringify(
              {
                longTermMemory: request.memoryContext.longTermMemory.slice(0, 400),
                recentEntries: request.memoryContext.recentEntries.map((entry) => ({
                  date: entry.date,
                  content: entry.content.slice(0, 180),
                })),
              },
              null,
              2,
            )
          : "null",
        "可用 skills:",
        ...request.skills.map((skill) =>
          [
            `- ${skill.manifest.name}`,
            `  description=${skill.manifest.description}`,
            `  capabilities=${summarizeList(skill.manifest.capabilities, 5)}`,
            `  products=${summarizeList(skill.manifest.products, 4)}`,
            `  requires_auth=${skill.manifest.requires_auth}`,
            `  dangerous=${skill.manifest.dangerous}`,
            `  endpoint_count=${skill.knowledge.endpointHints.length}`,
            `  reference_count=${skill.knowledge.referenceFiles.length}`,
            `  when_to_use=${truncateInline(skill.knowledge.sections.whenToUse, 120)}`,
            `  instructions=${truncateInline(skill.knowledge.sections.instructions, 140)}`,
          ].join("\n"),
        ),
      ].join("\n"),
    },
  ];
}

function truncateInline(value: string, maxLength: number): string {
  return value.replace(/\s+/g, " ").slice(0, maxLength) || "none";
}

function summarizeList(values: string[], limit: number): string {
  if (values.length === 0) {
    return "none";
  }
  const sliced = values.slice(0, limit).join(", ");
  return values.length > limit ? `${sliced}, ...` : sliced;
}

function formatPlanningSkillDocument(skill: SkillSelectionRequest["skills"][number]): string {
  return [
    `--- SKILL: ${skill.manifest.name} ---`,
    `description=${skill.manifest.description}`,
    `capabilities=${summarizeList(skill.manifest.capabilities, 8)}`,
    `products=${summarizeList(skill.manifest.products, 6)}`,
    `requires_auth=${skill.manifest.requires_auth}`,
    `dangerous=${skill.manifest.dangerous}`,
    `compiled_endpoint_count=${skill.knowledge.endpointHints.length}`,
    `reference_count=${skill.knowledge.referenceFiles.length}`,
    skill.instructions,
  ].join("\n");
}

function buildConversationStateMessages(request: ConversationStateRequest): ChatMessage[] {
  return [
    {
      role: "system",
      content: [
        "你是 BinaClaw 的 conversation state resolver。",
        "你的任务是根据最近会话与当前输入，判断当前这一轮的主交易对、主题和市场类型。",
        "只有在当前输入明显是在延续上一轮话题时才继承之前的主语；如果用户明确切换了币种或主题，就以当前输入为准。",
        '只返回 JSON，对象格式为 {"currentSymbol":"BNBUSDT","currentTopic":"market","currentMarketType":"spot","summary":"..."}。',
      ].join("\n"),
    },
    {
      role: "user",
      content: [
        `当前输入: ${request.input}`,
        `已有会话主题状态: ${formatConversationState(request.session.conversationState)}`,
        "最近会话:",
        formatRecentConversation(request.session.messages),
        "workspace docs 摘要:",
        formatWorkspaceDocs(request.memoryContext?.workspaceDocs),
        "workspace memory 摘要:",
        request.memoryContext
          ? JSON.stringify(
              {
                longTermMemory: request.memoryContext.longTermMemory.slice(0, 180),
                recentEntries: request.memoryContext.recentEntries.map((entry) => ({
                  date: entry.date,
                  content: entry.content.slice(0, 100),
                })),
              },
              null,
              2,
            )
          : "null",
      ].join("\n"),
    },
  ];
}

function buildDirectResponseMessages(request: DirectResponseRequest): ChatMessage[] {
  const modeGuidance = {
    clarify: "如果是在澄清信息，优先用自然追问，一句话到两句话即可。",
    fallback: "如果是在 fallback 说明里，直接说明现在缺什么信息或为什么暂时无法继续。",
    guidance: "如果是在 guidance 模式里，用自然的引导语气给出下一步建议，不要列过多示例。",
    approval: "如果是在 approval 模式里，要清楚说明当前动作需要确认、已取消或已过期，但不要暴露敏感参数。",
    result: "如果是在 result 模式里，简洁说明执行结果、成功或失败原因，不要像日志或模板回执。",
  } satisfies Record<DirectResponseRequest["mode"], string>;

  return [
    {
      role: "system",
      content: [
        "你是 BinaClaw 的中文终端助手。",
        "你的任务是把一段规划器草稿改写成自然、简洁、智能的回复。",
        "不要机械复述草稿，不要像模板客服，不要列太多示例。",
        "如果当前会话有上下文，结合上下文说话，但不要臆造不存在的交易对或数据。",
        "如果提供了语义简报，优先根据语义简报组织回复，再把规划器草稿当作补充参考。",
        modeGuidance[request.mode],
        "输出纯文本，不要使用 Markdown 标题、代码块或项目符号，除非草稿明确需要。",
      ].join("\n"),
    },
    {
      role: "user",
      content: [
        `当前输入: ${request.input}`,
        `回复模式: ${request.mode}`,
        `推断意图: ${request.intent ? JSON.stringify(request.intent) : "null"}`,
        `当前会话主题状态: ${formatConversationState(request.session.conversationState)}`,
        "最近会话:",
        formatRecentConversation(request.session.messages),
        "workspace docs 摘要:",
        formatWorkspaceDocs(request.memoryContext?.workspaceDocs),
        "workspace memory 摘要:",
        request.memoryContext
          ? JSON.stringify(
              {
                longTermMemory: request.memoryContext.longTermMemory.slice(0, 180),
                recentEntries: request.memoryContext.recentEntries.map((entry) => ({
                  date: entry.date,
                  content: entry.content.slice(0, 100),
                })),
              },
              null,
              2,
            )
          : "null",
        `语义简报: ${request.brief ? JSON.stringify(request.brief, null, 2) : "null"}`,
        `规划器草稿: ${request.draft}`,
      ].join("\n"),
    },
  ];
}

function formatRecentConversation(messages: ChatMessage[], limit = 6): string {
  const recent = messages.slice(-limit);
  if (recent.length === 0) {
    return "[]";
  }
  return recent
    .map((message) => `${message.role}: ${truncateInline(message.content, 160)}`)
    .join("\n");
}

function formatConversationState(state: ConversationState | undefined): string {
  if (!state) {
    return "null";
  }
  return JSON.stringify(state, null, 2);
}

function formatWorkspaceDocs(
  docs:
    | {
        agents: string;
        soul: string;
        user: string;
        identity: string;
        heartbeat: string;
        bootstrap: string;
        tools: string;
      }
    | undefined,
): string {
  if (!docs) {
    return "none";
  }
  return JSON.stringify(
    {
      AGENTS: truncateInline(docs.agents, 500),
      SOUL: truncateInline(docs.soul, 260),
      USER: truncateInline(docs.user, 260),
      IDENTITY: truncateInline(docs.identity, 220),
      HEARTBEAT: truncateInline(docs.heartbeat, 220),
      BOOTSTRAP: truncateInline(docs.bootstrap, 220),
      TOOLS: truncateInline(docs.tools, 360),
    },
    null,
    2,
  );
}


function normalizeFunctionParameters(schema: unknown): Record<string, unknown> {
  if (!schema || typeof schema !== "object") {
    return {
      type: "object",
      properties: {},
    };
  }
  return schema as Record<string, unknown>;
}

function buildToolDescription(tool: PlanningRequest["tools"][number]): string {
  const meta = [
    `dangerous=${tool.dangerous}`,
    `authScope=${tool.authScope}`,
    tool.sourceSkill ? `sourceSkill=${tool.sourceSkill}` : undefined,
    tool.transport ? `transport=${tool.transport}` : undefined,
    tool.operation ? `operation=${tool.operation}` : undefined,
    tool.method ? `method=${tool.method}` : undefined,
    tool.path ? `path=${tool.path}` : undefined,
  ].filter(Boolean);
  return [tool.description, ...meta].join("; ");
}

function parseFunctionCallPlan(
  payload: {
    output_text?: string;
    output?: Array<{
      type?: string;
      name?: string;
      arguments?: unknown;
      content?: Array<{
        type?: string;
        text?: string;
      }>;
    }>;
  },
  request: PlanningRequest,
): ModelPlanResult | null {
  const metadata = parsePlanMetadata(extractResponseText(payload), request);
  const toolCalls = (payload.output ?? [])
    .filter((item) => item.type === "function_call")
    .map((call) => {
      const toolId = fromFunctionName(call.name, request);
      if (!toolId) {
        return null;
      }
      return {
        toolId,
        input: parseJsonObject<Record<string, unknown>>(coerceToString(call.arguments)) ?? {},
      };
    })
    .filter((item): item is { toolId: string; input: Record<string, unknown> } => Boolean(item));

  const directResponse = metadata?.directResponse ?? extractPlainDirectResponse(extractResponseText(payload));
  if (toolCalls.length === 0 && !directResponse) {
    return null;
  }

  return {
    selectedSkillNames: metadata?.selectedSkillNames,
    endpointDecision: metadata?.endpointDecision ?? deriveEndpointDecision(toolCalls, request),
    directResponse,
    conversationStateUpdate: metadata?.conversationStateUpdate,
    toolCalls,
    rationale: directResponse,
  };
}

function parsePlanMetadata(content: string, request: PlanningRequest): {
  selectedSkillNames?: string[];
  endpointDecision?: EndpointDecision;
  directResponse?: string;
  conversationStateUpdate?: ConversationState;
} | null {
  const parsed = parseJsonObject<{
    selectedSkillNames?: unknown;
    endpointDecision?: unknown;
    directResponse?: unknown;
    conversationStateUpdate?: unknown;
  }>(content);
  if (!parsed || typeof parsed !== "object") {
    return null;
  }

  const allowedSkillNames = new Set(request.candidateSkills.map((skill) => skill.manifest.name));
  const selectedSkillNames = Array.isArray(parsed.selectedSkillNames)
    ? parsed.selectedSkillNames.filter((name): name is string => typeof name === "string" && allowedSkillNames.has(name))
    : undefined;

  const rawState = parsed.conversationStateUpdate;
  const conversationStateUpdate = rawState && typeof rawState === "object"
    ? {
        currentSymbol: typeof (rawState as { currentSymbol?: unknown }).currentSymbol === "string"
          ? (rawState as { currentSymbol: string }).currentSymbol
          : undefined,
        currentTopic: isConversationTopic((rawState as { currentTopic?: unknown }).currentTopic)
          ? (rawState as { currentTopic: ConversationState["currentTopic"] }).currentTopic
          : undefined,
        currentMarketType: isConversationMarketType((rawState as { currentMarketType?: unknown }).currentMarketType)
          ? (rawState as { currentMarketType: ConversationState["currentMarketType"] }).currentMarketType
          : undefined,
        summary: typeof (rawState as { summary?: unknown }).summary === "string"
          ? (rawState as { summary: string }).summary
          : undefined,
      }
    : undefined;

  const endpointDecision = parseEndpointDecision(parsed.endpointDecision, request);

  return {
    selectedSkillNames,
    endpointDecision,
    directResponse: typeof parsed.directResponse === "string" ? normalizeModelText(parsed.directResponse) : undefined,
    conversationStateUpdate,
  };
}

function parseEndpointDecision(value: unknown, request: PlanningRequest): EndpointDecision | undefined {
  if (!value || typeof value !== "object") {
    return undefined;
  }

  const allowedSkillNames = new Set(request.candidateSkills.map((skill) => skill.manifest.name));
  const toolById = new Map(request.tools.map((tool) => [tool.id, tool]));
  const raw = value as Record<string, unknown>;

  const toolId = typeof raw.toolId === "string" && toolById.has(raw.toolId) ? raw.toolId : undefined;
  const tool = toolId ? toolById.get(toolId) : undefined;
  const skillName = typeof raw.skillName === "string" && allowedSkillNames.has(raw.skillName)
    ? raw.skillName
    : tool?.sourceSkill;
  const endpointId = typeof raw.endpointId === "string" ? raw.endpointId : toolId;
  const operation = typeof raw.operation === "string" ? raw.operation : tool?.operation;
  const method = typeof raw.method === "string" ? raw.method : tool?.method;
  const path = typeof raw.path === "string" ? raw.path : tool?.path;
  const transport = isSkillTransportKind(raw.transport) ? raw.transport : tool?.transport;
  const rationale = typeof raw.rationale === "string" ? normalizeModelText(raw.rationale) : undefined;

  if (!toolId && !endpointId && !path) {
    return undefined;
  }

  return {
    skillName,
    toolId,
    endpointId,
    operation,
    method,
    path,
    transport,
    rationale,
  };
}

function deriveEndpointDecision(
  toolCalls: Array<{ toolId: string; input: Record<string, unknown> }>,
  request: PlanningRequest,
): EndpointDecision | undefined {
  if (toolCalls.length !== 1) {
    return undefined;
  }
  const tool = request.tools.find((item) => item.id === toolCalls[0]?.toolId);
  if (!tool) {
    return undefined;
  }
  return {
    skillName: tool.sourceSkill,
    toolId: tool.id,
    endpointId: tool.id,
    operation: tool.operation,
    method: tool.method,
    path: tool.path,
    transport: tool.transport,
  };
}

function extractPlainDirectResponse(content: string): string | undefined {
  if (!content) {
    return undefined;
  }
  const parsed = parseJsonObject<Record<string, unknown>>(content);
  if (
    parsed &&
    typeof parsed === "object" &&
    ("directResponse" in parsed || "selectedSkillNames" in parsed || "endpointDecision" in parsed)
  ) {
    return typeof parsed.directResponse === "string" ? normalizeModelText(parsed.directResponse) : undefined;
  }
  return normalizeModelText(content) || undefined;
}

function isConversationTopic(value: unknown): value is ConversationState["currentTopic"] {
  return typeof value === "string" && ["market", "news", "web3", "account", "trade", "orders"].includes(value);
}

function isConversationMarketType(value: unknown): value is ConversationState["currentMarketType"] {
  return typeof value === "string" && ["spot", "futures"].includes(value);
}

function isSkillTransportKind(value: unknown): value is EndpointDecision["transport"] {
  return typeof value === "string" && [
    "builtin",
    "binance-public-http",
    "binance-signed-http",
    "http",
    "exec",
    "memory",
  ].includes(value);
}

function extractResponseText(payload: {
  output_text?: string;
  output?: Array<{
    content?: Array<{
      type?: string;
      text?: string;
    }>;
  }>;
}): string {
  if (payload.output_text?.trim()) {
    return payload.output_text.trim();
  }

  const content = (payload.output ?? [])
    .flatMap((item) => item.content ?? [])
    .filter((item) => item.type === "output_text" && typeof item.text === "string")
    .map((item) => item.text?.trim() ?? "")
    .filter(Boolean)
    .join("\n");
  return content;
}

function coerceToString(value: unknown): string | undefined {
  if (typeof value === "string") {
    return value;
  }
  if (value === undefined) {
    return undefined;
  }
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function toFunctionName(toolId: string): string {
  return toolId.replace(/\./g, "__");
}

function fromFunctionName(functionName: string | undefined, request: PlanningRequest): string | null {
  if (!functionName) {
    return null;
  }
  const normalized = functionName.replace(/__/g, ".");
  if (request.tools.some((tool) => tool.id === normalized)) {
    return normalized;
  }
  if (request.tools.some((tool) => tool.id === functionName)) {
    return functionName;
  }
  return null;
}

export function fallbackSummary(request: SummaryRequest): string {
  const lines = request.toolResults.map((result) => {
    if (!result.ok) {
      return `- ${result.toolId}: ${result.error}`;
    }
    const data =
      typeof result.data === "string" ? result.data : JSON.stringify(result.data, null, 2).slice(0, 480);
    return `- ${result.toolId}: ${data}`;
  });

  return [
    `我已根据当前请求激活技能：${request.activeSkills.map((skill) => skill.manifest.name).join("、") || "默认行情技能"}。`,
    lines.length > 0 ? "工具结果摘要：" : "这轮没有调用工具。",
    ...lines,
    request.session.scratchpad.length > 0
      ? `推理轨迹摘要：${request.session.scratchpad.slice(-2).map((item) => item.summary).join("；")}`
      : "",
    "如需继续下单，请明确给出交易对、方向、数量，危险操作会先走确认。",
  ]
    .filter(Boolean)
    .join("\n");
}

function parseJsonObject<T>(content?: string): T | null {
  if (!content) {
    return null;
  }

  try {
    return JSON.parse(content) as T;
  } catch {
    const match = content.match(/\{[\s\S]*\}/);
    if (!match) {
      return null;
    }
    try {
      return JSON.parse(match[0]) as T;
    } catch {
      return null;
    }
  }
}

function normalizeModelText(content: string): string {
  let normalized = content.replace(/\r\n/g, "\n").trim();
  if (!normalized) {
    return "";
  }

  const parsedString = tryParseStringLiteral(normalized);
  if (parsedString !== null) {
    normalized = parsedString.trim();
  } else if (looksEscaped(normalized)) {
    const decoded = decodeEscapedSequences(normalized);
    if (decoded !== null) {
      normalized = decoded.trim();
    }
  }

  return normalized;
}

function tryParseStringLiteral(value: string): string | null {
  if (!(value.startsWith("\"") && value.endsWith("\""))) {
    return null;
  }
  try {
    const parsed = JSON.parse(value);
    return typeof parsed === "string" ? parsed : null;
  } catch {
    return null;
  }
}

function looksEscaped(value: string): boolean {
  return value.includes("\\n") || value.includes("\\r") || value.includes("\\t") || value.includes("\\\"");
}

function decodeEscapedSequences(value: string): string | null {
  try {
    const reparsed = JSON.parse(
      JSON.stringify(value)
        .replace(/\\\\n/g, "\\n")
        .replace(/\\\\r/g, "\\r")
        .replace(/\\\\t/g, "\\t")
        .replace(/\\\\\"/g, '\\"'),
    );
    return typeof reparsed === "string" ? reparsed : null;
  } catch {
    return null;
  }
}
