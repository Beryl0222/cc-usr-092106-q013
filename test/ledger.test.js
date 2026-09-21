import test from "node:test";
import assert from "node:assert/strict";
import { Ledger, verifyEvents } from "../src/ledger.js";
import { GENESIS_HASH } from "../src/hash.js";

test("事件按哈希链首尾相接", () => {
  const ledger = new Ledger();
  ledger.append({ type: "a", v: 1 });
  ledger.append({ type: "b", v: 2 });
  const [e1, e2] = ledger.events();
  assert.equal(e1.prevHash, GENESIS_HASH);
  assert.equal(e2.prevHash, e1.hash);
  assert.equal(ledger.verify().ok, true);
});

test("requestId 重放只返回原事件，不产生第二条", () => {
  const ledger = new Ledger();
  const first = ledger.append({ type: "x" }, "req-1");
  const second = ledger.append({ type: "x" }, "req-1");
  assert.equal(second.deduped, true);
  assert.equal(second.event, first.event);
  assert.equal(ledger.size, 1);
});

test("改写历史事件会被复验发现", () => {
  const ledger = new Ledger();
  ledger.append({ type: "a", amount: 100 });
  ledger.append({ type: "b", amount: 200 });
  const events = ledger.events();
  const tampered = events.map((e) =>
    e.seq === 0 ? { ...e, amount: 1 } : e,
  );
  const result = verifyEvents(tampered);
  assert.equal(result.ok, false);
  assert.equal(result.brokenAt, 0);
});

test("删除中间事件同样断链", () => {
  const ledger = new Ledger();
  ledger.append({ type: "a" });
  ledger.append({ type: "b" });
  ledger.append({ type: "c" });
  const [a, , c] = ledger.events();
  const result = verifyEvents([a, c]);
  assert.equal(result.ok, false);
  // c 声称的前链是被删掉的 b，断链报告指向 c 的全局序号 2。
  assert.equal(result.brokenAt, 2);
});
