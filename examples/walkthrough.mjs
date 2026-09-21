#!/usr/bin/env node
// 端到端演示：跑通完整业务场景，打印旅客三语视图、净额构成与审计追踪。
// 运行：node examples/walkthrough.mjs
import { buildScenario } from "./scenario.mjs";
import { travelerDashboard } from "../src/view.js";
import { auditClaim } from "../src/audit.js";

const { svc, ledger, vault, ids, offline } = buildScenario();

function line(s = "") {
  console.log(s);
}
line("=== 离线终端重连结果 ===");
line(`终端 kiosk-t1-07：${JSON.stringify(offline.sync7)}`);
line(`终端 kiosk-t1-09：${JSON.stringify(offline.sync9)}`);

for (const locale of ["zh", "en", "ja"]) {
  const dash = travelerDashboard(svc, locale, [ids.claimScarf, ids.claimTeapot]);
  line(`\n=== ${dash.localeName} · ${dash.title} ===`);
  for (const v of dash.vouchers) {
    line(`· ${v.claimId}  ${v.item.names.join("/") || v.item.itemId}（${v.store.storeId}）`);
    line(`  ${dash.headers.status}: ${v.status.label}`);
    line(`  ${dash.headers.net}: ${v.net.amount}${v.net.converted ? ` ≈ ${v.net.converted}` : ""}`);
    for (const d of v.deductions) line(`  - ${d.label}: ${d.amount}`);
    if (v.missing.length) {
      line(`  ${dash.headers.missing}: ${v.missing.map((m) => m.label).join("、")}`);
    }
    line(`  ${dash.headers.next}: ${v.next}`);
  }
}

line("\n=== 审计追踪：claim-scarf-1 ===");
const audit = auditClaim(ledger, vault, ids.claimScarf);
line(`净额 ${audit.sales.gross} - 退货 ${audit.sales.returnedTotal} = ${audit.sales.netAmount} ${audit.sales.currency}`);
line(`实物：批次 ${audit.physical.batchId} / 序列号 ${audit.physical.serial} / 特征哈希 ${audit.physical.featureHash.slice(0, 16)}…`);
line(`分段数 ${audit.segments.length}，双重查验拦截 ${audit.segments[0].rejectedAttempts.length} 次，冲正 ${audit.segments[0].reversal?.reversalId ?? "无"}`);
line(`哈希链连续：${audit.chain.contiguous}；整链完整：${audit.chain.ledgerIntegrity.ok}（${audit.chain.ledgerIntegrity.count} 个事件）`);

line("\n=== 到期删除后复验 ===");
svc.purgeExpired("2026-10-21T00:00:00Z");
const after = auditClaim(ledger, vault, ids.claimScarf);
line(`隐私状态：${JSON.stringify(after.privacy.status)}；墓碑：${JSON.stringify(after.privacy.purged)}`);
line(`整链仍完整：${ledger.verify().ok}`);
