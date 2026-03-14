import assert from "node:assert/strict";
import test from "node:test";
import {BraveSearchClient} from "../src/core/brave.ts";

test("BraveSearchClient web search uses subscription token header and parses results", async () => {
  let seenHeader = "";
  let seenUrl = "";
  const client = new BraveSearchClient(
    {
      apiKey: "brave-key",
      baseUrl: "https://api.search.brave.com/res/v1",
      defaultCountry: "US",
      searchLanguage: "en",
      uiLanguage: "en-US",
    },
    (async (input, init) => {
      seenUrl = String(input);
      seenHeader = String((init?.headers as Record<string, string>)["X-Subscription-Token"]);
      return new Response(
        JSON.stringify({
          web: {
            results: [
              {
                title: "Token Docs",
                url: "https://example.com/token",
                description: "docs",
                extra_snippets: ["snippet"],
              },
            ],
          },
          query: { original: "btc token", more_results_available: false },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }) as typeof fetch,
  );

  const result = (await client.searchWeb("btc token")) as { results: Array<{ title: string }> };
  assert.equal(seenHeader, "brave-key");
  assert.ok(seenUrl.includes("/web/search?"));
  assert.equal(result.results[0]?.title, "Token Docs");
});

test("BraveSearchClient news search parses news results", async () => {
  const client = new BraveSearchClient(
    {
      apiKey: "brave-key",
      baseUrl: "https://api.search.brave.com/res/v1",
      defaultCountry: "US",
      searchLanguage: "en",
      uiLanguage: "en-US",
    },
    (async () =>
      new Response(
        JSON.stringify({
          results: [
            {
              title: "BTC rallies",
              url: "https://news.example.com/btc",
              description: "market update",
            },
          ],
          query: { original: "btc news", more_results_available: true },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      )) as typeof fetch,
  );

  const result = (await client.searchNews("btc news")) as { results: Array<{ title: string }> };
  assert.equal(result.results[0]?.title, "BTC rallies");
});
