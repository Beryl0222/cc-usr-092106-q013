import { Ledger } from "../src/ledger.js";
import { PrivateVault } from "../src/vault.js";
import { RefundService } from "../src/service.js";
import { OfflineTerminal } from "../src/offline.js";
import { ROLES } from "../src/identity.js";

// 可执行的业务样例：两家门店的小票、部分退货、汇率变化、航班改签、
// 多口岸流转、离线双重查验、结算、冲正与到期删除。演示脚本与测试共用。
export function buildScenario() {
  const ledger = new Ledger();
  const vault = new PrivateVault();
  const svc = new RefundService(ledger, vault);

  const system = { partyId: "platform", role: ROLES.SYSTEM };
  const merchantA = { partyId: "merchant-design-a", role: ROLES.MERCHANT };
  const merchantB = { partyId: "merchant-design-b", role: ROLES.MERCHANT };
  const brandA = { partyId: "brand-house-a", role: ROLES.BRAND };
  const brandB = { partyId: "brand-house-b", role: ROLES.BRAND };
  const inspectorT1 = { partyId: "officer-t1-07", role: ROLES.INSPECTOR };
  const supervisor = { partyId: "officer-t1-lead", role: ROLES.INSPECTOR };
  const inspectorR1 = { partyId: "officer-r1-03", role: ROLES.INSPECTOR };
  const agency = { partyId: "refund-agency-1", role: ROLES.AGENCY };

  for (const [id, role, name] of [
    ["platform", ROLES.SYSTEM, "平台留存任务"],
    ["merchant-design-a", ROLES.MERCHANT, "国产设计品牌集合店甲"],
    ["merchant-design-b", ROLES.MERCHANT, "青瓷制品商户乙"],
    ["brand-house-a", ROLES.BRAND, "苏韵品牌方"],
    ["brand-house-b", ROLES.BRAND, "龙泉青瓷品牌方"],
    ["officer-t1-07", ROLES.INSPECTOR, "航空口岸一号区查验员"],
    ["officer-t1-lead", ROLES.INSPECTOR, "航空口岸一号区带班"],
    ["officer-r1-03", ROLES.INSPECTOR, "陆路口岸一号区查验员"],
    ["refund-agency-1", ROLES.AGENCY, "离境退税机构一窗"],
  ]) {
    svc.registerParty({ id, role, name });
  }

  svc.importCatalog(system, [
    { id: "cat-silk-scarf", kind: "商品类别", name: "真丝印花围巾" },
    { id: "cat-celadon-teapot", kind: "商品类别", name: "青瓷茶壶" },
    { id: "port-air-t1", kind: "离境口岸", name: "航空口岸一号查验区" },
    { id: "port-land-r1", kind: "离境口岸", name: "陆路口岸一号查验区" },
  ]);

  svc.bindStore(merchantA, { storeId: "store-a1", merchantId: "merchant-design-a" });
  svc.bindStore(merchantB, { storeId: "store-b1", merchantId: "merchant-design-b" });

  svc.registerBatch(merchantA, {
    batchId: "batch-silk-2026-09",
    brandPartyId: "brand-house-a",
    catalogIds: ["cat-silk-scarf"],
  });
  svc.registerBatch(merchantB, {
    batchId: "batch-celadon-2026-09",
    brandPartyId: "brand-house-b",
    catalogIds: ["cat-celadon-teapot"],
  });

  const scarfFeatures = ["rfid:8A01", "防伪纹:缠枝莲", "克重:112g"];
  const teapotFeatures = ["底款:龙泉青瓷", "釉色:粉青", "编号刻印:LP-77"];
  svc.enrollItem(merchantA, {
    itemId: "item-scarf-1",
    batchId: "batch-silk-2026-09",
    serial: "SN-SILK-0001",
    features: scarfFeatures,
  });
  svc.enrollItem(merchantB, {
    itemId: "item-teapot-1",
    batchId: "batch-celadon-2026-09",
    serial: "SN-CELA-0007",
    features: teapotFeatures,
  });

  const traveler = {
    fullName: "MARIA GARCIA",
    passportNo: "P-99887766",
    nationality: "ES",
    expiresAt: "2026-10-21T00:00:00Z",
  };

  // 门店甲：1000 元围巾，折欧元；随后部分退货 300 元、汇率调整。
  svc.issueInvoice(merchantA, {
    invoiceId: "inv-a1-1001",
    storeId: "store-a1",
    itemId: "item-scarf-1",
    amount: { amount: 1000, currency: "CNY" },
    fx: { currency: "EUR", rate: 0.128 },
    traveler,
  });
  svc.recordReturn(merchantA, {
    invoiceId: "inv-a1-1001",
    returnId: "ret-01",
    amount: { amount: 300, currency: "CNY" },
    reason: "同款另色退货",
  });
  svc.adjustFx(merchantA, {
    invoiceId: "inv-a1-1001",
    fx: { currency: "EUR", rate: 0.13 },
  });

  // 门店乙：680 元茶壶，无退货。
  svc.issueInvoice(merchantB, {
    invoiceId: "inv-b1-2002",
    storeId: "store-b1",
    itemId: "item-teapot-1",
    amount: { amount: 680, currency: "CNY" },
    fx: { currency: "EUR", rate: 0.13 },
    traveler,
  });

  svc.openClaim(merchantA, {
    claimId: "claim-scarf-1",
    invoiceId: "inv-a1-1001",
    flightNo: "CA931",
    departAt: "2026-09-22T14:20:00Z",
  });
  svc.openClaim(merchantB, {
    claimId: "claim-teapot-1",
    invoiceId: "inv-b1-2002",
    flightNo: "CA931",
    departAt: "2026-09-22T14:20:00Z",
  });

  svc.brandVerify(brandA, { claimId: "claim-scarf-1", result: "genuine" });
  svc.brandVerify(brandB, { claimId: "claim-teapot-1", result: "genuine" });

  // —— 围巾：两台离线终端都做了查验，重连后第二台被识别为双重查验 ——
  const t7 = new OfflineTerminal(svc, { terminalId: "kiosk-t1-07" });
  const t9 = new OfflineTerminal(svc, { terminalId: "kiosk-t1-09" });
  t7.disconnect();
  t9.disconnect();
  t7.submit(inspectorT1, "inspect", {
    claimId: "claim-scarf-1",
    portCode: "port-air-t1",
    observedFeatures: scarfFeatures,
    sessionId: "sess-t1-a-1",
  });
  t9.submit(supervisor, "inspect", {
    claimId: "claim-scarf-1",
    portCode: "port-air-t1",
    observedFeatures: scarfFeatures,
    sessionId: "sess-t1-a-2",
  });
  const sync7 = t7.sync();
  const sync9 = t9.sync();
  // 带班复核：确认第一台查验有效。
  svc.reviewInspection(supervisor, {
    claimId: "claim-scarf-1",
    resolution: "confirmed",
  });

  // —— 茶壶：先在航空口岸查验，航班改签后转陆路口岸，旧分段保留 ——
  svc.inspect(inspectorT1, {
    claimId: "claim-teapot-1",
    portCode: "port-air-t1",
    observedFeatures: teapotFeatures,
    terminalId: "kiosk-t1-07",
    sessionId: "sess-t1-b-1",
  });
  svc.changeFlight(agency, {
    claimId: "claim-teapot-1",
    flightNo: "HX238",
    departAt: "2026-09-23T09:05:00Z",
  });
  svc.changeRoute(inspectorT1, {
    claimId: "claim-teapot-1",
    toPortCode: "port-land-r1",
  });
  svc.inspect(inspectorR1, {
    claimId: "claim-teapot-1",
    portCode: "port-land-r1",
    observedFeatures: teapotFeatures,
    terminalId: "kiosk-r1-03",
    sessionId: "sess-r1-b-1",
  });

  svc.fileClaim(agency, { claimId: "claim-scarf-1" });
  svc.settle(agency, { claimId: "claim-scarf-1" });
  svc.fileClaim(agency, { claimId: "claim-teapot-1" });
  svc.settle(agency, { claimId: "claim-teapot-1" });

  // 发现退货数据此前有误：查验员发起冲正、退税机构确认，缺一不可。
  svc.proposeReversal(inspectorT1, {
    claimId: "claim-scarf-1",
    reason: "退货金额复核需重算净额",
  });
  svc.confirmReversal(agency, {
    claimId: "claim-scarf-1",
    reversalId: "rev-01",
  });

  return {
    ledger,
    vault,
    svc,
    actors: {
      system,
      merchantA,
      merchantB,
      brandA,
      brandB,
      inspectorT1,
      supervisor,
      inspectorR1,
      agency,
    },
    features: { scarf: scarfFeatures, teapot: teapotFeatures },
    ids: {
      invoiceScarf: "inv-a1-1001",
      invoiceTeapot: "inv-b1-2002",
      claimScarf: "claim-scarf-1",
      claimTeapot: "claim-teapot-1",
      itemScarf: "item-scarf-1",
      itemTeapot: "item-teapot-1",
      privateRef: ledger.events().find((e) => e.type === "invoiceIssued").privateRef,
    },
    offline: { t7, t9, sync7, sync9 },
  };
}
