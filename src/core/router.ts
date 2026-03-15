import type {InstalledSkill, IntentAnalysis} from "./types.ts";

export interface RetrievedSkillCandidate {
  skill: InstalledSkill;
  score: number;
}

const SPOT_TRADE_WORDS = ["买", "卖", "buy", "sell", "下单", "开仓", "平仓"];
const FUTURES_WORDS = ["合约", "永续", "futures", "perp", "做多", "做空"];
const BALANCE_WORDS = ["余额", "资产", "账户", "持仓", "balance", "position"];
const ORDER_WORDS = ["订单", "成交", "open order", "撤单", "cancel"];
const MARKET_WORDS = ["行情", "价格", "ticker", "depth", "k线", "分析", "funding", "走势", "能买吗", "能不能买", "怎么看", "怎么样", "值不值得"];
const NEWS_WORDS = ["新闻", "资讯", "热点", "signal", "广场", "动态"];
const WEB3_WORDS = ["web3", "链上", "合约地址", "token", "代币"];
const MEMORY_WORDS = ["之前", "上次", "历史", "记得", "偏好", "recent", "remember", "history", "memory"];
const SYMBOL_STOPWORDS = new Set([
  "BUY",
  "SELL",
  "SPOT",
  "FUTURES",
  "PERP",
  "LONG",
  "SHORT",
  "USDT",
  "EXIT",
  "HELP",
  "TRACE",
  "SESSION",
  "CONFIG",
  "LATEST",
  "CURRENT",
  "TODAY",
  "PRICE",
  "MARKET",
  "NEWS",
  "TOKEN",
  "QUERY",
  "CHECK",
  "ANALYSIS",
]);

function matchAny(input: string, words: string[]): boolean {
  const lowered = input.toLowerCase();
  return words.some((word) => lowered.includes(word.toLowerCase()));
}

function normalizeSymbol(raw?: string): string | undefined {
  if (!raw) {
    return undefined;
  }
  const compact = raw.toUpperCase().replace(/[^A-Z0-9]/g, "");
  if (!compact) {
    return undefined;
  }
  if (SYMBOL_STOPWORDS.has(compact)) {
    return undefined;
  }
  if (/(USDT|BUSD|FDUSD|BTC|ETH)$/.test(compact) && compact.length > 3) {
    return compact;
  }
  return `${compact}USDT`;
}

function extractSymbol(input: string): string | undefined {
  const direct = input.match(/\b([A-Za-z]{2,12}(?:USDT|BUSD|FDUSD|BTC|ETH))\b/);
  if (direct) {
    return normalizeSymbol(direct[1]);
  }

  const exact = input.trim().match(/^([A-Za-z]{2,12})$/);
  if (exact) {
    return normalizeSymbol(exact[1]);
  }

  const naturalAnalysis = input.match(
    /(?:具体)?(?:分析(?:一下|下)?|看(?:一下|下)?|查(?:一下|下)?|研究(?:一下|下)?|关注一下)\s*([A-Za-z]{2,12})/i,
  );
  if (naturalAnalysis) {
    return normalizeSymbol(naturalAnalysis[1]);
  }

  const prefixContext = input.match(/(?:买|卖|分析|看看|看下|查询|查下|查查|下单|研究|关注|看|查|做多|做空)\s*([A-Za-z]{2,12})/i);
  if (prefixContext) {
    return normalizeSymbol(prefixContext[1]);
  }

  const suffixContext = input.match(/([A-Za-z]{2,12})\s*(?:现货|合约|行情|价格|走势|新闻|资讯|代币|能买吗|能不能买|怎么样|如何|分析|1小时|4小时|日线)/i);
  if (suffixContext) {
    return normalizeSymbol(suffixContext[1]);
  }

  const timedContext = input.match(/(?:今天|现在|最新(?:的)?|latest|current)\s*([A-Za-z]{2,12})\s*(?:行情|价格|走势|新闻|资讯|能买吗|能不能买|怎么样|如何|分析)?/i);
  if (timedContext) {
    return normalizeSymbol(timedContext[1]);
  }

  return undefined;
}

function extractQuantity(input: string): number | undefined {
  const match = input.match(/(?:买|卖|buy|sell|数量|qty|quantity)\s*([0-9]+(?:\.[0-9]+)?)/i);
  return match ? Number(match[1]) : undefined;
}

function extractQuoteOrderQty(input: string): number | undefined {
  const marketBuyQuote = input.match(
    /(?:现货|spot)?\s*(?:市价)?\s*(?:买入?|buy)\s*([0-9]+(?:\.[0-9]+)?)\s*(USDT|BUSD|FDUSD)\b/i,
  );
  if (marketBuyQuote) {
    return Number(marketBuyQuote[1]);
  }

  const quoteAmount = input.match(
    /([0-9]+(?:\.[0-9]+)?)\s*(USDT|BUSD|FDUSD)\s*(?:现货|spot)?\s*(?:市价)?\s*(?:买入?|buy)\b/i,
  );
  return quoteAmount ? Number(quoteAmount[1]) : undefined;
}

function extractPrice(input: string): number | undefined {
  const match = input.match(/(?:价格|price|at)\s*([0-9]+(?:\.[0-9]+)?)/i);
  return match ? Number(match[1]) : undefined;
}

function extractOrderId(input: string): number | undefined {
  const match = input.match(/(?:order(?:\s*id)?|订单号)\s*#?\s*([0-9]+)/i);
  return match ? Number(match[1]) : undefined;
}

export function inferIntent(input: string): IntentAnalysis {
  const categories = new Set<string>();
  const symbol = extractSymbol(input);
  const quantity = extractQuantity(input);
  const quoteOrderQty = extractQuoteOrderQty(input);
  const price = extractPrice(input);
  const orderId = extractOrderId(input);

  if (matchAny(input, SPOT_TRADE_WORDS)) {
    categories.add("trade");
  }
  if (matchAny(input, FUTURES_WORDS)) {
    categories.add("futures");
  }
  if (matchAny(input, BALANCE_WORDS)) {
    categories.add("account");
  }
  if (matchAny(input, ORDER_WORDS)) {
    categories.add("orders");
  }
  if (matchAny(input, MARKET_WORDS)) {
    categories.add("market");
  }
  if (matchAny(input, NEWS_WORDS)) {
    categories.add("news");
  }
  if (matchAny(input, WEB3_WORDS)) {
    categories.add("web3");
  }
  if (symbol && categories.size === 0) {
    categories.add("market");
  }

  const lowered = input.toLowerCase();
  const side =
    lowered.includes("sell") || input.includes("卖") || input.includes("做空")
      ? "SELL"
      : lowered.includes("buy") || input.includes("买") || input.includes("做多")
        ? "BUY"
        : undefined;
  const marketType = categories.has("futures") ? "futures" : "spot";
  const orderType = price ? "LIMIT" : "MARKET";

  return {
    categories: Array.from(categories),
    symbol,
    quantity,
    quoteOrderQty,
    price,
    side,
    marketType,
    orderType,
    orderId,
  };
}

export function retrieveCandidateSkills(
  input: string,
  skills: InstalledSkill[],
  intent: IntentAnalysis = inferIntent(input),
  limit = 8,
): RetrievedSkillCandidate[] {
  const scored = skills
    .map((skill) => ({
      skill,
      score: scoreSkill(skill, input, intent),
    }))
    .filter((entry) => entry.score > 0)
    .sort((a, b) => b.score - a.score);

  if (scored.length > 0) {
    return scored.slice(0, limit);
  }

  const fallback = skills.find((skill) => looksLikeMarketSkill(skill)) ?? skills[0];
  return fallback ? [{ skill: fallback, score: 0 }] : [];
}

export function selectSkills(input: string, skills: InstalledSkill[], intent: IntentAnalysis = inferIntent(input)): InstalledSkill[] {
  return retrieveCandidateSkills(input, skills, intent, 4).map((entry) => entry.skill);
}

function scoreSkill(skill: InstalledSkill, input: string, intent: IntentAnalysis): number {
  const haystack = [
    skill.manifest.name,
    skill.manifest.description,
    ...skill.manifest.capabilities,
    ...skill.manifest.products,
    skill.knowledge.sections.whenToUse,
    skill.knowledge.sections.instructions,
    ...skill.knowledge.endpointHints.map((item) => `${item.id} ${item.description} ${item.path}`),
  ]
    .join("\n")
    .toLowerCase();

  let score = 0;

  if (intent.categories.includes("market") || input.includes("分析")) {
    score += keywordScore(haystack, ["market", "ticker", "depth", "k线", "klines", "alpha", "exchange", "price", "funding", "signal"]);
  }
  if (intent.categories.includes("news")) {
    score += keywordScore(haystack, ["news", "signal", "热点", "资讯", "square", "post"]);
  }
  if (intent.categories.includes("web3")) {
    score += keywordScore(haystack, ["web3", "token", "address", "audit", "链上", "合约"]);
  }
  if (intent.categories.includes("account")) {
    score += keywordScore(haystack, ["account", "balance", "asset", "wallet", "rank", "账户", "资产", "持仓", "margin"]);
  }
  if (intent.categories.includes("orders")) {
    score += keywordScore(haystack, ["order", "trade history", "成交", "open order", "交易"]);
  }
  if (intent.categories.includes("trade")) {
    score += keywordScore(haystack, ["trade", "order", "buy", "sell", "spot", "futures", "margin", "下单", "交易"]);
    if (intent.marketType === "futures") {
      score += keywordScore(haystack, ["futures", "perp", "永续", "合约", "usds"]);
    } else {
      score += keywordScore(haystack, ["spot", "alpha", "现货"]);
    }
  }
  if (MEMORY_WORDS.some((word) => input.toLowerCase().includes(word.toLowerCase()))) {
    score += keywordScore(haystack, ["memory", "历史", "偏好", "recent", "remember"]);
  }

  if (intent.marketType === "futures" && /(futures|perp|永续|合约|usds)/.test(haystack)) {
    score += 3;
  }
  if (intent.marketType === "spot" && /(spot|现货|alpha)/.test(haystack)) {
    score += 2;
  }
  if (intent.symbol && haystack.includes("alpha") && input.toLowerCase().includes("alpha")) {
    score += 3;
  }
  if (skill.manifest.requires_auth && (intent.categories.includes("account") || intent.categories.includes("trade") || intent.categories.includes("orders"))) {
    score += 1;
  }
  if (skill.manifest.dangerous && intent.categories.includes("trade")) {
    score += 2;
  }

  return score;
}

function keywordScore(haystack: string, keywords: string[]): number {
  return keywords.reduce((sum, keyword) => sum + (haystack.includes(keyword.toLowerCase()) ? 2 : 0), 0);
}

function looksLikeMarketSkill(skill: InstalledSkill): boolean {
  const haystack = `${skill.manifest.name} ${skill.manifest.description} ${skill.knowledge.sections.whenToUse}`.toLowerCase();
  return /(market|ticker|price|alpha|signal|spot)/.test(haystack);
}
