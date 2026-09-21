import test from "node:test";
import assert from "node:assert/strict";
import { buildScenario } from "../examples/scenario.mjs";

test("端到端场景可以完整构建", () => {
  const { ledger, offline } = buildScenario();
  assert.equal(ledger.verify().ok, true);
  // 第一台离线终端重连成功入账，第二台识别为双重查验冲突。
  assert.deepEqual(offline.sync7, {
    applied: ["kiosk-t1-07:inspect:claim-scarf-1:1"],
    deduped: [],
    conflicts: [],
    errors: [],
  });
  assert.equal(offline.sync9.conflicts.length, 1);
  assert.equal(offline.sync9.conflicts[0].code, "DOUBLE_INSPECTION");
});
