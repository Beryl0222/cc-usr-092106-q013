import test from "node:test";
import assert from "node:assert/strict";
import { buildScenario } from "../examples/scenario.mjs";
import { verifyEvents } from "../src/ledger.js";
import { OfflineTerminal } from "../src/offline.js";
import { auditClaim } from "../src/audit.js";
import { RefundError } from "../src/errors.js";
import { effectiveInspection } from "../src/projection.js";

const expectError = (code, fn) => {
  assert.throws(fn, (err) => err instanceof RefundError && err.code === code);
};

test("净销售额只随追加事件重算：退货冲减与汇率折算", () => {
  const { svc, ids } = buildScenario();
  const net = svc.netSalesFor(ids.invoiceScarf);
  assert.equal(net.gross, 1000);
  assert.equal(net.returned, 300);
  assert.equal(net.net, 700);
  assert.equal(net.convertedNet, 91); // 700 × 0.13
  assert.equal(net.fxRate, 0.13);
});

test("累计退货不得超过开票净额", () => {
  const { svc, actors, ids } = buildScenario();
  expectError("RETURN_EXCEEDS_SALES", () =>
    svc.recordReturn(actors.merchantA, {
      invoiceId: ids.invoiceScarf,
      returnId: "ret-too-much",
      amount: { amount: 701, currency: "CNY" },
      reason: "超额退货",
    }),
  );
});

test("门店只能维护本店销售，不能调整别家发票", () => {
  const { svc, actors, ids } = buildScenario();
  expectError("FORBIDDEN", () =>
    svc.recordReturn(actors.merchantA, {
      invoiceId: ids.invoiceTeapot,
      returnId: "ret-x",
      amount: { amount: 10, currency: "CNY" },
      reason: "越权",
    }),
  );
  expectError("FORBIDDEN", () =>
    svc.bindStore(actors.merchantA, { storeId: "store-a2", merchantId: "merchant-design-b" }),
  );
});

test("只有授权品牌方能核实对应商品", () => {
  const { svc, actors, ids } = buildScenario();
  expectError("FORBIDDEN", () =>
    svc.brandVerify(actors.brandB, { claimId: ids.claimScarf, result: "genuine" }),
  );
});

test("冲正后的凭证缺查验时不能重新申报", () => {
  const { svc, actors, ids } = buildScenario();
  assert.equal(svc.statusOf(ids.claimScarf).status, "reversed-reopen");
  expectError("INSPECTION_PENDING", () =>
    svc.fileClaim(actors.agency, { claimId: ids.claimScarf }),
  );
});

test("查验员无法替退税机构结算", () => {
  const { svc, actors, ids } = buildScenario();
  assert.equal(svc.statusOf(ids.claimTeapot).status, "settled");
  expectError("FORBIDDEN", () =>
    svc.settle(actors.inspectorR1, { claimId: ids.claimTeapot }),
  );
});

test("冲正必须由对方角色确认：同角色自批被拒", () => {
  const { svc, actors, ids } = buildScenario();
  svc.proposeReversal(actors.inspectorR1, {
    claimId: ids.claimTeapot,
    reason: "测试发起",
  });
  // 提议方是查验员，另一名查验员不能确认，必须由退税机构确认。
  expectError("REVERSAL_NEEDS_COUNTERPARTY", () =>
    svc.confirmReversal(actors.inspectorT1, {
      claimId: ids.claimTeapot,
      reversalId: "rev-bad",
    }),
  );
  svc.confirmReversal(actors.agency, {
    claimId: ids.claimTeapot,
    reversalId: "rev-ok",
  });
  assert.equal(svc.statusOf(ids.claimTeapot).status, "reversed-reopen");
});

test("一张发票只能开一张退税凭证：重复开具在源头拒绝", () => {
  const { svc, actors, ids } = buildScenario();
  expectError("INVOICE_ALREADY_CLAIMED", () =>
    svc.openClaim(actors.merchantB, {
      claimId: "claim-teapot-dup",
      invoiceId: ids.invoiceTeapot,
      flightNo: "HX238",
      departAt: "2026-09-23T09:05:00Z",
    }),
  );
});

test("同一实物身份不能重复开票（拆分开票防线）", () => {
  const { svc, actors, ids } = buildScenario();
  expectError("ITEM_ALREADY_INVOICED", () =>
    svc.issueInvoice(actors.merchantA, {
      invoiceId: "inv-split",
      storeId: "store-a1",
      itemId: ids.itemScarf,
      amount: { amount: 100, currency: "CNY" },
      fx: { currency: "EUR", rate: 0.13 },
      traveler: { fullName: "X", passportNo: "P1", expiresAt: "2026-12-31T00:00:00Z" },
    }),
  );
});

test("商品特征不符时查验拒绝", () => {  const { svc, actors, ids } = buildScenario();
  // 围巾已冲正需重新查验；携带商品特征与登记身份不一致即拒绝。
  expectError("FEATURE_MISMATCH", () =>
    svc.inspect(actors.inspectorT1, {
      claimId: ids.claimScarf,
      portCode: "port-air-t1",
      observedFeatures: ["rfid:8A01", "防伪纹:错版", "克重:112g"],
      terminalId: "kiosk-t1-11",
      sessionId: "sess-bad-1",
    }),
  );
});

test("多口岸流转：旧分段保留、当前只认新分段", () => {
  const { svc, ids } = buildScenario();
  const claim = svc.snapshot().claims.get(ids.claimTeapot);
  assert.equal(claim.segments.length, 2);
  assert.notEqual(claim.segments[0].supersededAt, null);
  assert.equal(claim.segments[1].portCode, "port-land-r1");
  assert.equal(claim.segments[1].inspection.portCode, "port-land-r1");
  // 已结算分段不能再改港。
  const { svc: svc2, actors: a2, ids: ids2 } = buildScenario();
  expectError("SETTLED", () =>
    svc2.changeRoute(a2.inspectorR1, { claimId: ids2.claimTeapot, toPortCode: "port-air-t2" }),
  );
});

test("离线终端同会话重放幂等，不产生第二次查验", () => {
  const { svc, actors, ids, features } = buildScenario();
  const t = new OfflineTerminal(svc, { terminalId: "kiosk-retry" });
  t.disconnect();
  t.submit(actors.inspectorT1, "inspect", {
    claimId: ids.claimScarf, // 已冲正，旧查验已作废，需重新查验
    portCode: "port-air-t1",
    observedFeatures: features.scarf,
    sessionId: "sess-retry-1",
  });
  const seg = svc.snapshot().claims.get(ids.claimScarf).segments.at(-1);
  assert.equal(effectiveInspection(seg), null);
  const report = t.sync();
  assert.equal(report.applied.length, 1);
  const count = svc.ledger.size;
  // 队列已空，再次同步不产生任何事件。
  const again = t.sync();
  assert.deepEqual(again, { applied: [], deduped: [], conflicts: [], errors: [] });
  assert.equal(svc.ledger.size, count);
});

test("同机断线重发由 requestId 幂等去重", () => {
  const { svc, actors, ids, features } = buildScenario();
  // 冲正后重新查验：同终端同会话提交两次（模拟断线重发）。
  const args = {
    claimId: ids.claimScarf,
    portCode: "port-air-t1",
    observedFeatures: features.scarf,
    terminalId: "kiosk-t1-07",
    sessionId: "sess-redeliver-1",
  };
  svc.inspect(actors.inspectorT1, args);
  // 用同一 requestId 再发一次：直接返回原事件。
  const second = svc.inspect(actors.inspectorT1, { ...args, requestId: "redeliver-1" });
  assert.equal(second.deduped, true);
});

test("平台不保存完整支付资料：台账只见引用与哈希", () => {
  const { ledger, vault, ids } = buildScenario();
  const issued = ledger.events().find((e) => e.type === "invoiceIssued");
  assert.equal("passportNo" in issued, false);
  assert.equal("fullName" in issued, false);
  assert.equal(typeof issued.privateRef, "string");
  assert.equal(vault.get(ids.privateRef).passportNo, "P-99887766");
});

test("隐私字段到期删除，审计只见墓碑不见明文", () => {
  const { svc, vault, ids } = buildScenario();
  assert.notEqual(vault.get(ids.privateRef), null);
  const purgedEvents = svc.purgeExpired("2026-10-21T00:00:00Z");
  assert.ok(purgedEvents.length >= 1);
  assert.equal(vault.get(ids.privateRef), null);
  const tomb = svc
    .ledger.events()
    .filter((e) => e.type === "privacyPurged" && e.ref === ids.privateRef);
  assert.equal(tomb.length, 1);
  assert.deepEqual([...tomb[0].fields].sort(), ["fullName", "nationality", "passportNo"]);
  assert.equal("passportNo" in tomb[0], false);
});

test("未到期资料不会被清理", () => {
  const { svc, vault, ids } = buildScenario();
  svc.purgeExpired("2026-10-20T23:59:59Z");
  assert.notEqual(vault.get(ids.privateRef), null);
});

test("审计可从一笔退税追到净额、批次、查验、冲正且哈希链完整", () => {
  const { svc, ledger, vault, ids } = buildScenario();
  const audit = auditClaim(ledger, vault, ids.claimScarf);
  assert.equal(audit.sales.netAmount, 700);
  assert.equal(audit.sales.returnedTotal, 300);
  assert.equal(audit.physical.batchId, "batch-silk-2026-09");
  assert.equal(audit.physical.serial, "SN-SILK-0001");
  assert.equal(audit.brand.result, "genuine");
  // 第一次查验成功 + 第二次被识别为双重查验的拦截。
  assert.equal(audit.segments[0].inspection.featureMatched, true);
  assert.equal(audit.segments[0].rejectedAttempts[0].reason, "double-inspection");
  assert.equal(audit.segments[0].reversal.reversalId, "rev-01");
  assert.equal(audit.chain.contiguous, true);
  assert.equal(audit.chain.ledgerIntegrity.ok, true);
});

test("审计在台账事件被改写后报告断链", () => {
  const { ledger } = buildScenario();
  const events = ledger.events();
  const idx = events.findIndex((e) => e.type === "returnRecorded");
  const tampered = events.map((e, i) =>
    i === idx ? { ...e, reason: "被篡改的退货原因" } : e,
  );
  const result = verifyEvents(tampered);
  assert.equal(result.ok, false);
  assert.equal(result.brokenAt, idx);
});
