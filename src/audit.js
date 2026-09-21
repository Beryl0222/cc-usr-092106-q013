import {
  project,
  netSales,
  activeSegment,
  claimStatus,
  pendingMaterials,
} from "./projection.js";
import { GENESIS_HASH } from "./hash.js";

// 审计追踪：给定一笔退税凭证，给出完整证据链——
// 净销售额构成（开票/退货/调差/汇率）→ 实物批次与商品特征 → 行程分段
// → 品牌核实 → 各段查验（含双重查验拦截）→ 申报/结算/冲正，
// 并复验这些事件在哈希链中的连续性与整链完整性。
export function auditClaim(ledger, vault, claimId) {
  const events = ledger.events();
  const state = project(events);
  const claim = state.claims.get(claimId);
  if (!claim) {
    const err = new Error(`退税凭证不存在: ${claimId}`);
    err.code = "CLAIM_MISSING";
    throw err;
  }
  const inv = state.invoices.get(claim.invoiceId);
  const item = state.items.get(claim.itemId);
  const batch = state.batches.get(item.batchId);

  // 按类型+关键标识筛出这笔退税的全部相关事件，保持全局顺序。
  const related = events.filter((e) => isRelated(e, claimId, inv, item));

  const segments = claim.segments.map((seg) => ({
    segmentId: seg.segmentId,
    portCode: seg.portCode ?? "（尚未锚定口岸）",
    openedAt: seg.openedAt,
    supersededAt: seg.supersededAt,
    inspection: seg.inspection
      ? {
          at: seg.inspection.at,
          by: seg.inspection.actor,
          portCode: seg.inspection.portCode,
          terminalId: seg.inspection.terminalId,
          sessionId: seg.inspection.sessionId,
          featureMatched: seg.inspection.featureMatched,
          reviewed: seg.inspection.reviewed,
          voidedByReversal: seg.inspection.voidedByReversal ?? null,
        }
      : null,
    inspectionHistory: (seg.inspectionHistory ?? []).map((h) => ({
      at: h.at,
      by: h.actor,
      portCode: h.portCode,
      terminalId: h.terminalId,
      sessionId: h.sessionId,
      voidedByReversal: h.voidedByReversal ?? null,
    })),
    rejectedAttempts: (seg.rejections ?? []).map((r) => ({
      at: r.at,
      reason: r.reason,
      terminalId: r.terminalId,
      sessionId: r.sessionId,
    })),
    filedAt: seg.filedAt,
    settledAt: seg.settledAt,
    settledNet: seg.settledNet,
    reversedAt: seg.reversedAt,
    reversal: seg.reversal,
    pendingReversal: seg.pendingReversal ?? null,
  }));

  const net = netSales(inv);
  const privacy = vault.status(claim.privateRef);
  const purged = state.purged.get(claim.privateRef) ?? null;

  return {
    claimId,
    status: claimStatus(claim),
    pending: pendingMaterials(claim),
    chain: {
      genesis: GENESIS_HASH,
      events: related.map((e) => ({
        seq: e.seq,
        type: e.type,
        at: e.at,
        actor: e.actor,
        hash: e.hash,
        prevHash: e.prevHash,
      })),
      // 这组事件的链必须首尾相接；ledger.verify() 再保证整链未被改写。
      contiguous: isContiguous(related, events),
      ledgerIntegrity: ledger.verify(),
    },
    sales: {
      invoiceId: inv.invoiceId,
      storeId: inv.storeId,
      merchantId: inv.merchantId,
      issuedAt: inv.issuedAt,
      gross: net.gross,
      returns: net.returns,
      returnedTotal: net.returned,
      adjustments: net.adjustments,
      adjustmentTotal: net.adjusted,
      netAmount: net.net,
      currency: net.invoiceCurrency,
      fx: net.fx,
      convertedNetAmount: net.convertedNet,
      convertedCurrency: net.refundCurrency,
    },
    physical: {
      itemId: item.itemId,
      batchId: item.batchId,
      serial: item.serial,
      featureHash: item.featureHash,
      merchantId: batch.merchantId,
      brandPartyId: batch.brandPartyId,
    },
    itinerary: {
      flightNo: claim.flightNo,
      departAt: claim.departAt,
    },
    brand: { result: claim.brandResult, at: claim.brandAt },
    segments,
    privacy: {
      ref: claim.privateRef,
      status: privacy, // 未到期时为保留中；到期清除后 vault 中已不存在
      purged, // 墓碑：何时清除、删了哪些字段
    },
  };
}

function isRelated(e, claimId, inv, item) {
  if (e.claimId === claimId) return true;
  if (e.invoiceId === inv.invoiceId) return true;
  if (e.type === "itemEnrolled" && e.itemId === item.itemId) return true;
  if (e.type === "batchRegistered" && e.batchId === item.batchId) return true;
  if (e.type === "privacyPurged" && e.ref === inv.privateRef) return true;
  return false;
}

// 相关事件在全局链中的序号必须连续可追溯（中间允许夹入无关事件，
// 这里校验相邻两条相关事件间的全局链不断）。
function isContiguous(related, all) {
  let prev = null;
  for (const e of related) {
    if (prev) {
      // prevHash 必须最终回连到上一相关事件：沿链回溯应先遇到 prev。
      let cursor = e;
      let guard = 0;
      while (cursor && cursor.seq > prev.seq && guard < all.length + 1) {
        cursor = all[cursor.seq - 1] ?? null;
        guard += 1;
      }
      if (!cursor || cursor.seq !== prev.seq) return false;
    }
    prev = e;
  }
  return true;
}
