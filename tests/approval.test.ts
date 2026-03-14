import assert from "node:assert/strict";
import test from "node:test";
import {createApprovalRequest, isApprovalExpired} from "../src/core/approval.ts";

test("createApprovalRequest includes confirmation instructions", () => {
  const approval = createApprovalRequest({
    toolId: "spot.placeOrder",
    input: { symbol: "BTCUSDT", side: "BUY", type: "MARKET", quantity: 0.01 },
    dangerous: true,
  });
  assert.ok(approval.summary.includes("CONFIRM"));
  assert.equal(approval.toolId, "spot.placeOrder");
  assert.ok(!approval.summary.includes("\"symbol\""));
  assert.ok(!approval.summary.includes("参数:"));
  assert.ok(approval.summary.includes("当前操作需要确认。"));
});

test("isApprovalExpired detects expired approvals", () => {
  const approval = createApprovalRequest({
    toolId: "spot.placeOrder",
    input: { symbol: "BTCUSDT", side: "BUY", type: "MARKET", quantity: 0.01 },
    dangerous: true,
  });
  approval.expiresAt = new Date(Date.now() - 1000).toISOString();
  assert.equal(isApprovalExpired(approval), true);
});
