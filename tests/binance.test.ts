import assert from "node:assert/strict";
import test from "node:test";
import {BinanceClient} from "../src/core/binance.ts";

test("buildSignedQuery appends signature", () => {
  const client = new BinanceClient(
    {
      apiKey: "k",
      apiSecret: "secret",
      useTestnet: false,
      recvWindow: 5000,
      spotBaseUrl: "https://api.binance.com",
      futuresBaseUrl: "https://fapi.binance.com",
      sapiBaseUrl: "https://api.binance.com",
      webBaseUrl: "https://www.binance.com",
    },
    fetch,
  );

  const signed = client.buildSignedQuery({ symbol: "BTCUSDT", side: "BUY" }, 1234567890);
  assert.ok(signed.includes("signature="));
  assert.ok(signed.includes("timestamp=1234567890"));
  assert.ok(signed.includes("symbol=BTCUSDT"));
});
