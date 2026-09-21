import test from "node:test";
import assert from "node:assert/strict";
import { Ledger } from "../src/ledger.js";
import { PrivateVault } from "../src/vault.js";
import { RefundService } from "../src/service.js";
import { ROLES } from "../src/identity.js";
import { RefundError } from "../src/errors.js";

// 最小可申报夹具：一家店、一件商品、一张发票，品牌真、已查验。
function readyClaim({ brandResult = "genuine", inspect = true } = {}) {
  const svc = new RefundService(new Ledger(), new PrivateVault());
  const system = { partyId: "sys", role: ROLES.SYSTEM };
  const m = { partyId: "m1", role: ROLES.MERCHANT };
  const b = { partyId: "b1", role: ROLES.BRAND };
  const i = { partyId: "i1", role: ROLES.INSPECTOR };
  const a = { partyId: "a1", role: ROLES.AGENCY };
  svc.registerParty({ id: "sys", role: ROLES.SYSTEM, name: "系统" });
  svc.registerParty({ id: "m1", role: ROLES.MERCHANT, name: "商户" });
  svc.registerParty({ id: "b1", role: ROLES.BRAND, name: "品牌" });
  svc.registerParty({ id: "i1", role: ROLES.INSPECTOR, name: "查验员" });
  svc.registerParty({ id: "a1", role: ROLES.AGENCY, name: "机构" });
  svc.importCatalog(system, [{ id: "c1", kind: "类别", name: "茶具" }]);
  svc.bindStore(m, { storeId: "s1", merchantId: "m1" });
  svc.registerBatch(m, { batchId: "lot1", brandPartyId: "b1", catalogIds: ["c1"] });
  svc.enrollItem(m, { itemId: "it1", batchId: "lot1", serial: "SN1", features: ["f1", "f2"] });
  svc.issueInvoice(m, {
    invoiceId: "iv1",
    storeId: "s1",
    itemId: "it1",
    amount: { amount: 500, currency: "CNY" },
    fx: { currency: "CNY", rate: 1 },
    traveler: { fullName: "T", passportNo: "P", expiresAt: "2027-01-01T00:00:00Z" },
  });
  svc.openClaim(m, { claimId: "cl1", invoiceId: "iv1", flightNo: "F1", departAt: "2026-10-01T00:00:00Z" });
  svc.brandVerify(b, { claimId: "cl1", result: brandResult });
  if (inspect && brandResult === "genuine") {
    svc.inspect(i, {
      claimId: "cl1",
      portCode: "p1",
      observedFeatures: ["f2", "f1"],
      terminalId: "k1",
      sessionId: "ss1",
    });
  }
  return { svc, actors: { system, m, b, i, a } };
}

const expectError = (code, fn) => {
  assert.throws(fn, (err) => err instanceof RefundError && err.code === code);
};

test("品牌方判定假冒后查验与申报均被阻断", () => {
  const { svc, actors } = readyClaim({ brandResult: "counterfeit", inspect: false });
  expectError("COUNTERFEIT", () =>
    svc.inspect(actors.i, {
      claimId: "cl1",
      portCode: "p1",
      observedFeatures: ["f1", "f2"],
      terminalId: "k1",
      sessionId: "ss1",
    }),
  );
  expectError("BRAND_PENDING", () => svc.fileClaim(actors.a, { claimId: "cl1" }));
  assert.equal(svc.statusOf("cl1").status, "blocked-counterfeit");
});

test("在错误口岸查验会被拒绝", () => {
  const { svc, actors } = readyClaim();
  // 首次查验已把当前分段锚定在 p1；改去 p9 验放必须先走改港。
  expectError("PORT_MISMATCH", () =>
    svc.inspect(actors.i, {
      claimId: "cl1",
      portCode: "p9",
      observedFeatures: ["f1", "f2"],
      terminalId: "k9",
      sessionId: "ss9",
    }),
  );
});

test("首次查验可在任意口岸锚定；锚定后改港只追加新分段", () => {
  const { svc, actors } = readyClaim({ inspect: false });
  svc.inspect(actors.i, {
    claimId: "cl1",
    portCode: "p-land",
    observedFeatures: ["f1", "f2"],
    terminalId: "k1",
    sessionId: "ss1",
  });
  const seg = svc.snapshot().claims.get("cl1").segments[0];
  assert.equal(seg.portCode, "p-land");
});

test("已结算凭证不能改港", () => {
  const { svc, actors } = readyClaim();
  svc.fileClaim(actors.a, { claimId: "cl1" });
  svc.settle(actors.a, { claimId: "cl1" });
  expectError("SETTLED", () =>
    svc.changeRoute(actors.i, { claimId: "cl1", toPortCode: "p2" }),
  );
});

test("未申报不能结算、重复申报被拒", () => {
  const { svc, actors } = readyClaim();
  expectError("NOT_FILED", () => svc.settle(actors.a, { claimId: "cl1" }));
  svc.fileClaim(actors.a, { claimId: "cl1" });
  expectError("ALREADY_FILED", () => svc.fileClaim(actors.a, { claimId: "cl1" }));
});

test("结算后重复结算被拒", () => {
  const { svc, actors } = readyClaim();
  svc.fileClaim(actors.a, { claimId: "cl1" });
  svc.settle(actors.a, { claimId: "cl1" });
  expectError("ALREADY_SETTLED", () => svc.settle(actors.a, { claimId: "cl1" }));
});

test("查验员不能发起品牌核实，机构不能查验", () => {
  const { svc, actors } = readyClaim();
  expectError("FORBIDDEN", () =>
    svc.brandVerify(actors.i, { claimId: "cl1", result: "genuine" }),
  );
  expectError("FORBIDDEN", () =>
    svc.inspect(actors.a, {
      claimId: "cl1",
      portCode: "p1",
      observedFeatures: ["f1"],
      terminalId: "k",
      sessionId: "s",
    }),
  );
});

test("同批次同序列号重复登记被拒（身份冲突）", () => {
  const { svc, actors } = readyClaim();
  expectError("IDENTITY_COLLISION", () =>
    svc.enrollItem(actors.m, { itemId: "it2", batchId: "lot1", serial: "SN1", features: ["x"] }),
  );
});

test("改港后新分段需重新查验，旧分段已结算仍占用名额", () => {
  const { svc, actors } = readyClaim();
  svc.fileClaim(actors.a, { claimId: "cl1" });
  svc.settle(actors.a, { claimId: "cl1" });
  // 冲正后才能改港；冲正需要两方。
  svc.proposeReversal(actors.i, { claimId: "cl1", reason: "r" });
  svc.confirmReversal(actors.a, { claimId: "cl1", reversalId: "rv1" });
  svc.changeRoute(actors.i, { claimId: "cl1", toPortCode: "p2" });
  const claim = svc.snapshot().claims.get("cl1");
  assert.equal(claim.segments.length, 2);
  assert.equal(claim.segments[1].inspection, null);
  expectError("INSPECTION_PENDING", () => svc.fileClaim(actors.a, { claimId: "cl1" }));
});
