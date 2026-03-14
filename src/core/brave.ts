import type {BraveSearchConfig} from "./types.ts";

interface BraveWebResult {
  title?: string;
  url?: string;
  description?: string;
  age?: string;
  language?: string;
  profile?: {
    name?: string;
    url?: string;
    long_name?: string;
  };
  extra_snippets?: string[];
}

interface BraveWebPayload {
  web?: {
    results?: BraveWebResult[];
  };
  query?: {
    original?: string;
    more_results_available?: boolean;
  };
}

interface BraveNewsPayload {
  results?: BraveWebResult[];
  query?: {
    original?: string;
    more_results_available?: boolean;
  };
}

export class BraveSearchClient {
  private readonly config: BraveSearchConfig;
  private readonly fetchImpl: typeof fetch;

  constructor(
    config: BraveSearchConfig,
    fetchImpl: typeof fetch = fetch,
  ) {
    this.config = config;
    this.fetchImpl = fetchImpl;
  }

  hasApiKey(): boolean {
    return Boolean(this.config.apiKey);
  }

  async searchWeb(query: string, options: { count?: number; freshness?: string } = {}): Promise<unknown> {
    const payload = (await this.request("/web/search", {
      q: query,
      count: String(options.count ?? 5),
      freshness: options.freshness ?? "pw",
      country: this.config.defaultCountry,
      search_lang: this.config.searchLanguage,
      ui_lang: this.config.uiLanguage,
      extra_snippets: "true",
    })) as BraveWebPayload;

    return {
      query: payload.query?.original ?? query,
      source: "brave-web-search",
      results: (payload.web?.results ?? []).slice(0, options.count ?? 5).map(toSearchResult),
      moreResultsAvailable: payload.query?.more_results_available ?? false,
    };
  }

  async searchNews(query: string, options: { count?: number; freshness?: string } = {}): Promise<unknown> {
    const payload = (await this.request("/news/search", {
      q: query,
      count: String(options.count ?? 5),
      freshness: options.freshness ?? "pd",
      country: this.config.defaultCountry,
      search_lang: this.config.searchLanguage,
      ui_lang: this.config.uiLanguage,
      extra_snippets: "true",
      safesearch: "moderate",
    })) as BraveNewsPayload;

    return {
      query: payload.query?.original ?? query,
      source: "brave-news-search",
      results: (payload.results ?? []).slice(0, options.count ?? 5).map(toSearchResult),
      moreResultsAvailable: payload.query?.more_results_available ?? false,
    };
  }

  private async request(path: string, params: Record<string, string>): Promise<unknown> {
    if (!this.hasApiKey()) {
      throw new Error("缺少 BRAVE_SEARCH_API_KEY，无法调用 Brave Search API。");
    }

    const searchParams = new URLSearchParams(params);
    const response = await this.fetchImpl(`${this.config.baseUrl}${path}?${searchParams.toString()}`, {
      headers: {
        Accept: "application/json",
        "Accept-Encoding": "gzip",
        "X-Subscription-Token": this.config.apiKey ?? "",
      },
    });

    const payload = await response.json().catch(() => undefined);
    if (!response.ok) {
      const message =
        typeof payload === "object" && payload !== null && "message" in payload
          ? String((payload as { message?: string }).message)
          : `${response.status} ${response.statusText}`;
      throw new Error(message);
    }
    return payload;
  }
}

function toSearchResult(result: BraveWebResult): Record<string, unknown> {
  return {
    title: result.title ?? "",
    url: result.url ?? "",
    description: result.description ?? "",
    age: result.age,
    language: result.language,
    profile: result.profile?.long_name ?? result.profile?.name,
    extraSnippets: result.extra_snippets ?? [],
  };
}
