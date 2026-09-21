import { makeFeatureHash } from "./identity.js";

// 事件流折叠为只读当前状态。所有"现在还能申报多少、缺什么、到谁了"的
// 答案都从本投影得出；事件本身永不修改，退货/调差/汇率只追加后重算。

function round2(x) {
  return Math.round((x + Number.EPSILON) * 100) / 100;
}

export function project(events) {
  const state = {
    parties: new Map(),
    stores: new Map(), // storeId -> merchantId
    catalog: new Map(),
    batches: new Map(), // batchId -> {merchantId, brandPartyId}
    items: new Map(), // itemId -> 商品身份
    invoices: new Map(), // invoiceId -> 发票与调整流水
    claims: new Map(), // claimId -> 索赔状态
    claimsByItem: new Map(), // itemId -> [claimId]
    purged: new Map(), // privateRef -> {at, fields}
  };

  for (const e of events) fold(state, e);
  return state;
}

function activeSegment(claim) {
  return claim.segments.find((s) => s.supersededAt === null) ?? null;
}

// 索赔是否仍占用"同一商品不得重复退税"的名额：当前分段有未冲正结算。
function claimHoldsItem(claim) {
  const seg = activeSegment(claim);
  return Boolean(seg && seg.settledAt && !seg.reversedAt);
}

function fold(state, e) {
  switch (e.type) {
    case "partyRegistered": {
      state.parties.set(e.party.id, { ...e.party });
      break;
    }
    case "storeBound": {
      state.stores.set(e.storeId, e.merchantId);
      break;
    }
    case "catalogEntry": {
      state.catalog.set(e.entry.id, { ...e.entry });
      break;
    }
    case "batchRegistered": {
      state.batches.set(e.batchId, {
        merchantId: e.merchantId,
        brandPartyId: e.brandPartyId,
        catalogIds: (e.catalogIds ?? []).slice(),
      });
      break;
    }
    case "itemEnrolled": {
      state.items.set(e.itemId, {
        itemId: e.itemId,
        merchantId: e.merchantId,
        batchId: e.batchId,
        serial: e.serial,
        featureHash: e.featureHash,
        brandPartyId: e.brandPartyId,
        enrolledAt: e.at,
      });
      break;
    }
    case "invoiceIssued": {
      state.invoices.set(e.invoiceId, {
        invoiceId: e.invoiceId,
        storeId: e.storeId,
        merchantId: e.merchantId,
        itemId: e.itemId,
        privateRef: e.privateRef,
        amount: { ...e.amount },
        fx: { ...e.fx },
        returns: [],
        adjustments: [],
        issuedAt: e.at,
      });
      break;
    }
    case "returnRecorded": {
      const inv = state.invoices.get(e.invoiceId);
      inv.returns.push({
        returnId: e.returnId,
        amount: { ...e.amount },
        reason: e.reason,
        at: e.at,
      });
      break;
    }
    case "priceAdjusted": {
      const inv = state.invoices.get(e.invoiceId);
      inv.adjustments.push({
        adjustmentId: e.adjustmentId,
        delta: { ...e.delta },
        reason: e.reason,
        at: e.at,
      });
      break;
    }
    case "fxAdjusted": {
      state.invoices.get(e.invoiceId).fx = { ...e.fx };
      break;
    }
    case "claimOpened": {
      const seg = {
        segmentId: `${e.claimId}:1`,
        seq: 1,
        portCode: e.departurePortCode,
        openedAt: e.at,
        supersededAt: null,
        inspection: null,
        filedAt: null,
        settledAt: null,
        settledNet: null,
        reversedAt: null,
        reversal: null,
      };
      state.claims.set(e.claimId, {
        claimId: e.claimId,
        invoiceId: e.invoiceId,
        itemId: e.itemId,
        privateRef: e.privateRef,
        flightNo: e.flightNo,
        departAt: e.departAt,
        segments: [seg],
        brandResult: null,
        brandAt: null,
      });
      const list = state.claimsByItem.get(e.itemId) ?? [];
      list.push(e.claimId);
      state.claimsByItem.set(e.itemId, list);
      break;
    }
    case "flightChanged": {
      const claim = state.claims.get(e.claimId);
      claim.flightNo = e.flightNo;
      claim.departAt = e.departAt;
      break;
    }
    case "routeChanged": {
      const claim = state.claims.get(e.claimId);
      const old = activeSegment(claim);
      old.supersededAt = e.at;
      const seg = {
        segmentId: `${claim.claimId}:${claim.segments.length + 1}`,
        seq: claim.segments.length + 1,
        portCode: e.toPortCode,
        openedAt: e.at,
        supersededAt: null,
        inspection: null,
        filedAt: null,
        settledAt: null,
        settledNet: null,
        reversedAt: null,
        reversal: null,
      };
      claim.segments.push(seg);
      break;
    }
    case "brandVerified": {
      const claim = state.claims.get(e.claimId);
      claim.brandResult = e.result;
      claim.brandAt = e.at;
      break;
    }
    case "inspectionPassed": {
      const seg = activeSegment(state.claims.get(e.claimId));
      // 首次查验把当前分段锚定到实际验放口岸；之后改港事件才会换分段。
      if (seg.portCode === null) seg.portCode = e.portCode;
      const record = {
        at: e.at,
        actor: e.actor,
        portCode: e.portCode,
        terminalId: e.terminalId ?? null,
        sessionId: e.sessionId ?? null,
        featureMatched: e.featureMatched,
        reviewed: null,
      };
      // 冲正后重新查验：旧记录（含作废标记）进入历史，不被覆盖丢失。
      seg.inspectionHistory = seg.inspectionHistory ?? [];
      if (seg.inspection) seg.inspectionHistory.push(seg.inspection);
      seg.inspection = record;
      break;
    }
    case "inspectionRejected": {
      // 拦截事件只用于审计，不改变分段状态。
      const claim = state.claims.get(e.claimId);
      if (claim) {
        const seg = activeSegment(claim);
        seg.rejections = seg.rejections ?? [];
        seg.rejections.push({
          at: e.at,
          reason: e.reason,
          terminalId: e.terminalId ?? null,
          sessionId: e.sessionId ?? null,
        });
      }
      break;
    }
    case "inspectionReviewed": {
      const seg = activeSegment(state.claims.get(e.claimId));
      if (e.resolution === "rejected") {
        // 复核认定查验无效：回到未查验状态，允许重新验放。
        seg.inspection = null;
      } else if (seg.inspection) {
        seg.inspection.reviewed = { by: e.reviewer, at: e.at };
      }
      break;
    }
    case "claimFiled": {
      const seg = activeSegment(state.claims.get(e.claimId));
      seg.filedAt = e.at;
      break;
    }
    case "refundSettled": {
      const seg = activeSegment(state.claims.get(e.claimId));
      seg.settledAt = e.at;
      seg.settledNet = { ...e.netAmount };
      break;
    }
    case "reversalProposed": {
      const seg = activeSegment(state.claims.get(e.claimId));
      seg.pendingReversal = {
        proposedByRole: e.proposedByRole,
        reason: e.reason,
        at: e.at,
      };
      break;
    }
    case "settlementReversed": {
      const seg = activeSegment(state.claims.get(e.claimId));
      seg.reversedAt = e.at;
      seg.reversal = {
        reversalId: e.reversalId,
        reason: e.reason,
        at: e.at,
        proposedByRole: seg.pendingReversal?.proposedByRole ?? null,
      };
      seg.pendingReversal = null;
      // 冲正后该分段回到待查验/待申报，允许重新走流程；不构成重复退税。
      // 历史查验不擦除（审计需要），只标记为已被冲正作废。
      if (seg.inspection) seg.inspection.voidedByReversal = e.at;
      seg.filedAt = null;
      seg.settledAt = null;
      seg.settledNet = null;
      break;
    }
    case "privacyPurged": {
      state.purged.set(e.ref, { at: e.at, fields: e.fields.slice() });
      break;
    }
    default:
      // 未知事件类型不使台账失效；投影仅忽略。
      break;
  }
}

// 净销售额（开票币种）= 开票金额 + 调差 - 退货；并按最新汇率折算。
export function netSales(inv) {
  const gross = inv.amount.amount;
  const returned = inv.returns.reduce((s, r) => s + r.amount.amount, 0);
  const adjusted = inv.adjustments.reduce((s, a) => s + a.delta.amount, 0);
  const net = round2(gross + adjusted - returned);
  const refundCurrency = inv.fx.currency;
  const converted =
    inv.amount.currency === refundCurrency
      ? net
      : round2(net * inv.fx.rate);
  return {
    invoiceCurrency: inv.amount.currency,
    refundCurrency,
    gross: round2(gross),
    returned: round2(returned),
    adjusted: round2(adjusted),
    net,
    fxRate: inv.fx.rate,
    convertedNet: converted,
    returns: inv.returns.map((r) => ({ ...r, amount: { ...r.amount } })),
    adjustments: inv.adjustments.map((a) => ({
      adjustmentId: a.adjustmentId,
      delta: { ...a.delta },
      reason: a.reason,
      at: a.at,
    })),
    fx: { ...inv.fx },
  };
}

export function effectiveInspection(seg) {
  return seg.inspection && !seg.inspection.voidedByReversal ? seg.inspection : null;
}

// 当前分段还缺什么材料、卡在谁手里。已冲正结算的分段重新变为未完成。
export function pendingMaterials(claim) {
  const seg = activeSegment(claim);
  const missing = [];
  if (claim.brandResult !== "genuine") {
    missing.push({
      code: "brand-verification",
      owner: "brand",
      blocked: claim.brandResult === "counterfeit",
    });
  }
  if (!effectiveInspection(seg)) missing.push({ code: "inspection", owner: "inspector" });
  if (!seg.filedAt) missing.push({ code: "filing", owner: "agency" });
  else if (!seg.settledAt)
    missing.push({ code: "settlement", owner: "agency" });
  return missing;
}

export function claimStatus(claim) {
  const seg = activeSegment(claim);
  if (claim.brandResult === "counterfeit") return "blocked-counterfeit";
  if (seg.reversedAt) return "reversed-reopen";
  if (seg.settledAt) return "settled";
  if (seg.filedAt) return "awaiting-settlement";
  if (seg.inspection) return "inspected-awaiting-file";
  return "preparing";
}

export function itemHeldByOtherClaim(state, itemId, exceptClaimId = null) {
  for (const id of state.claimsByItem.get(itemId) ?? []) {
    if (id === exceptClaimId) continue;
    if (claimHoldsItem(state.claims.get(id))) return id;
  }
  return null;
}

export function recomputeFeatureHash({ batchId, serial, features }) {
  return makeFeatureHash({ batchId, serial, features });
}

export { activeSegment, claimHoldsItem, round2 };
