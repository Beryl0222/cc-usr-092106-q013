import { RefundError } from "./errors.js";
import { ROLES, makeFeatureHash } from "./identity.js";
import {
  project,
  netSales,
  activeSegment,
  claimStatus,
  pendingMaterials,
  itemHeldByOtherClaim,
  effectiveInspection,
} from "./projection.js";

// 业务服务：所有写操作都经这里授权、校验后以事件形式追加进台账。
// 门店只能动本店销售；品牌方只能核实自己授权批次；查验员只对当前
// 离境口岸分段负责；结算/冲正均不能由任何一方单独完成。
export class RefundService {
  constructor(ledger, vault, { clock = () => new Date().toISOString() } = {}) {
    this.ledger = ledger;
    this.vault = vault;
    this.clock = clock;
  }

  #state() {
    return project(this.ledger.events());
  }

  #append(type, payload, actor, requestId = null) {
    return this.ledger.append(
      { type, at: this.clock(), actor: actorId(actor), ...payload },
      requestId,
    ).event;
  }

  // ---- 参与方与基础目录 -------------------------------------------------

  registerParty(party) {
    const state = this.#state();
    if (state.parties.has(party.id)) {
      throw new RefundError("PARTY_EXISTS", `参与方已存在: ${party.id}`);
    }
    if (!Object.values(ROLES).includes(party.role)) {
      throw new RefundError("BAD_ROLE", `未知角色: ${party.role}`);
    }
    return this.#append("partyRegistered", { party }, { role: ROLES.SYSTEM });
  }

  #actor(state, actor, role) {
    if (!actor || !actor.partyId) {
      throw new RefundError("UNAUTHORIZED", "缺少操作方");
    }
    const party = state.parties.get(actor.partyId);
    if (!party) throw new RefundError("UNKNOWN_PARTY", "参与方未登记");
    if (party.role !== role || actor.role !== role) {
      throw new RefundError("FORBIDDEN", `${actor.partyId} 不能以 ${role} 身份操作`);
    }
    return party;
  }

  bindStore(actor, { storeId, merchantId }) {
    const state = this.#state();
    this.#actor(state, actor, ROLES.MERCHANT);
    if (actor.partyId !== merchantId) {
      throw new RefundError("FORBIDDEN", "门店只能由所属商户绑定");
    }
    if (state.stores.has(storeId)) {
      throw new RefundError("STORE_EXISTS", `门店已绑定: ${storeId}`);
    }
    return this.#append("storeBound", { storeId, merchantId }, actor);
  }

  importCatalog(actor, entries) {
    if (!actor || actor.role !== ROLES.SYSTEM) {
      throw new RefundError("FORBIDDEN", "只有平台系统任务能导入基础目录");
    }
    const state = this.#state();
    const events = [];
    for (const entry of entries) {
      if (!entry.id || !entry.name) {
        throw new RefundError("BAD_CATALOG", "目录条目缺少标识或名称");
      }
      if (state.catalog.has(entry.id)) continue;
      events.push(this.#append("catalogEntry", { entry }, actor));
      state.catalog.set(entry.id, entry);
    }
    return events;
  }

  // ---- 商品身份 ---------------------------------------------------------

  registerBatch(actor, { batchId, brandPartyId, catalogIds = [] }) {
    const state = this.#state();
    const merchant = this.#actor(state, actor, ROLES.MERCHANT);
    const brand = state.parties.get(brandPartyId);
    if (!brand || brand.role !== ROLES.BRAND) {
      throw new RefundError("UNKNOWN_BRAND", "品牌授权方未登记或角色不对");
    }
    if (state.batches.has(batchId)) {
      throw new RefundError("BATCH_EXISTS", `批次已登记: ${batchId}`);
    }
    for (const id of catalogIds) {
      if (!state.catalog.has(id)) {
        throw new RefundError("CATALOG_MISSING", `目录条目不存在: ${id}`);
      }
    }
    return this.#append(
      "batchRegistered",
      { batchId, merchantId: merchant.id, brandPartyId, catalogIds },
      actor,
    );
  }

  enrollItem(actor, { itemId, batchId, serial, features = [] }) {
    const state = this.#state();
    this.#actor(state, actor, ROLES.MERCHANT);
    const batch = state.batches.get(batchId);
    if (!batch) throw new RefundError("BATCH_MISSING", `批次不存在: ${batchId}`);
    if (batch.merchantId !== actor.partyId) {
      throw new RefundError("FORBIDDEN", "商户只能登记自己批次的商品");
    }
    if (state.items.has(itemId)) {
      throw new RefundError("ITEM_EXISTS", `商品已登记: ${itemId}`);
    }
    const featureList = features.map(String).sort();
    const featureHash = makeFeatureHash({ batchId, serial, features: featureList });
    // 身份冲突：不同 itemId 使用同一批次+序列号。
    for (const other of state.items.values()) {
      if (other.batchId === batchId && other.serial === serial) {
        throw new RefundError("IDENTITY_COLLISION", "同一批次序列号已被登记");
      }
    }
    return this.#append(
      "itemEnrolled",
      {
        itemId,
        merchantId: actor.partyId,
        batchId,
        serial,
        features: featureList,
        featureHash,
        brandPartyId: batch.brandPartyId,
      },
      actor,
    );
  }

  // ---- 销售凭证、退货与调差 ---------------------------------------------

  #requireStoreOfActor(state, actor, storeId) {
    this.#actor(state, actor, ROLES.MERCHANT);
    const merchantId = state.stores.get(storeId);
    if (!merchantId) throw new RefundError("STORE_MISSING", `门店不存在: ${storeId}`);
    if (merchantId !== actor.partyId) {
      throw new RefundError("FORBIDDEN", "门店只能维护本店销售");
    }
    return merchantId;
  }

  #requireInvoiceOfStore(state, actor, invoiceId) {
    const inv = state.invoices.get(invoiceId);
    if (!inv) throw new RefundError("INVOICE_MISSING", `发票不存在: ${invoiceId}`);
    if (state.stores.get(inv.storeId) !== actor.partyId) {
      throw new RefundError("FORBIDDEN", "只能调整本店开具的发票");
    }
    return inv;
  }

  issueInvoice(
    actor,
    { invoiceId, storeId, itemId, amount, fx, traveler, requestId = null },
  ) {
    const state = this.#state();
    const merchantId = this.#requireStoreOfActor(state, actor, storeId);
    const item = state.items.get(itemId);
    if (!item) throw new RefundError("ITEM_MISSING", `商品不存在: ${itemId}`);
    if (item.merchantId !== merchantId) {
      throw new RefundError("FORBIDDEN", "商品不属于该商户");
    }
    if (state.invoices.has(invoiceId)) {
      throw new RefundError("INVOICE_EXISTS", `发票已存在: ${invoiceId}`);
    }
    // 同一实物身份只能有一张销售发票，拆分开票不能让一件商品占两个退税名额。
    for (const other of state.invoices.values()) {
      if (other.itemId === itemId) {
        throw new RefundError("ITEM_ALREADY_INVOICED", `商品已开票: ${other.invoiceId}`, {
          existingInvoiceId: other.invoiceId,
        });
      }
    }
    validateMoney(amount);
    validateFx(fx);
    if (!traveler.expiresAt) throw new RefundError("BAD_TRAVELER", "隐私资料必须给出保留到期时间");
    const { expiresAt, ...privateData } = traveler;
    // 旅客隐私字段入侧库，台账只留承诺哈希，平台看不到完整资料。
    const privateRef = this.vault.put(privateData, { expiresAt });
    return this.#append(
      "invoiceIssued",
      {
        invoiceId,
        storeId,
        merchantId,
        itemId,
        privateRef,
        amount: { amount: amount.amount, currency: amount.currency },
        fx: { currency: fx.currency, rate: fx.rate },
      },
      actor,
      requestId,
    );
  }

  recordReturn(actor, { invoiceId, returnId, amount, reason, requestId = null }) {
    const state = this.#state();
    this.#actor(state, actor, ROLES.MERCHANT);
    const inv = this.#requireInvoiceOfStore(state, actor, invoiceId);
    validateMoney(amount);
    if (inv.returns.some((r) => r.returnId === returnId)) {
      throw new RefundError("RETURN_EXISTS", `退货已登记: ${returnId}`);
    }
    const net = netSales(inv);
    const nextNet = net.net - amount.amount;
    if (nextNet < -0.001) {
      throw new RefundError("RETURN_EXCEEDS_SALES", "累计退货超过开票净额");
    }
    return this.#append(
      "returnRecorded",
      {
        invoiceId,
        returnId,
        amount: { amount: amount.amount, currency: amount.currency ?? inv.amount.currency },
        reason,
      },
      actor,
      requestId,
    );
  }

  adjustPrice(actor, { invoiceId, adjustmentId, delta, reason, requestId = null }) {
    const state = this.#state();
    this.#actor(state, actor, ROLES.MERCHANT);
    const inv = this.#requireInvoiceOfStore(state, actor, invoiceId);
    validateMoney(delta);
    if (inv.adjustments.some((a) => a.adjustmentId === adjustmentId)) {
      throw new RefundError("ADJUSTMENT_EXISTS", `调差已登记: ${adjustmentId}`);
    }
    if (netSales(inv).net + delta.amount < -0.001) {
      throw new RefundError("ADJUSTMENT_EXCEEDS_SALES", "调差后净额为负");
    }
    return this.#append(
      "priceAdjusted",
      {
        invoiceId,
        adjustmentId,
        delta: { amount: delta.amount, currency: delta.currency ?? inv.amount.currency },
        reason,
      },
      actor,
      requestId,
    );
  }

  // 汇率变化不修改历史：只追加一条新汇率，净销售额投影始终按最新汇率折算。
  adjustFx(actor, { invoiceId, fx, requestId = null }) {
    const state = this.#state();
    this.#actor(state, actor, ROLES.MERCHANT);
    this.#requireInvoiceOfStore(state, actor, invoiceId);
    validateFx(fx);
    return this.#append("fxAdjusted", { invoiceId, fx }, actor, requestId);
  }

  // ---- 退税凭证与行程 ---------------------------------------------------

  openClaim(actor, { claimId, invoiceId, flightNo, departAt, requestId = null }) {
    const state = this.#state();
    const inv = state.invoices.get(invoiceId);
    if (!inv) throw new RefundError("INVOICE_MISSING", `发票不存在: ${invoiceId}`);
    // 凭证由开票门店开具；旅客本人持凭证到口岸，不依赖平台保存其资料。
    this.#actor(state, actor, ROLES.MERCHANT);
    if (state.stores.get(inv.storeId) !== actor.partyId) {
      throw new RefundError("FORBIDDEN", "只有开票门店能开具退税凭证");
    }
    if (state.claims.has(claimId)) {
      throw new RefundError("CLAIM_EXISTS", `退税凭证已存在: ${claimId}`);
    }
    for (const other of state.claims.values()) {
      if (other.invoiceId === invoiceId) {
        throw new RefundError("INVOICE_ALREADY_CLAIMED", `发票已开具退税凭证: ${other.claimId}`, {
          existingClaimId: other.claimId,
        });
      }
    }
    if (netSales(inv).net <= 0) {
      throw new RefundError("NOTHING_TO_DECLARE", "净额为零，不在可申报范围");
    }
    // 已有未冲正结算占用同一商品时，连新凭证都不能开。
    const holder = itemHeldByOtherClaim(state, inv.itemId, null);
    if (holder) {
      throw new RefundError("ITEM_ALREADY_REFUNDED", `商品已被凭证 ${holder} 退税`);
    }
    return this.#append(
      "claimOpened",
      {
        claimId,
        invoiceId,
        itemId: inv.itemId,
        privateRef: inv.privateRef,
        departurePortCode: null, // 到口岸前不确定验放口岸
        flightNo,
        departAt,
      },
      actor,
      requestId,
    );
  }

  changeFlight(actor, { claimId, flightNo, departAt, requestId = null }) {
    const state = this.#state();
    const claim = state.claims.get(claimId);
    if (!claim) throw new RefundError("CLAIM_MISSING", `退税凭证不存在: ${claimId}`);
    if (actor.role === ROLES.MERCHANT) {
      this.#actor(state, actor, ROLES.MERCHANT);
      const inv = state.invoices.get(claim.invoiceId);
      if (state.stores.get(inv.storeId) !== actor.partyId) {
        throw new RefundError("FORBIDDEN", "只有开票门店能改本店凭证的航班");
      }
    } else if (actor.role === ROLES.AGENCY) {
      this.#actor(state, actor, ROLES.AGENCY);
    } else {
      throw new RefundError("FORBIDDEN", "只有门店或退税机构能变更航班");
    }
    return this.#append("flightChanged", { claimId, flightNo, departAt }, actor, requestId);
  }

  // 多口岸流转：不作废原分段，只追加新分段；投影只认当前分段为可申报范围。
  changeRoute(actor, { claimId, toPortCode, requestId = null }) {
    const state = this.#state();
    const claim = state.claims.get(claimId);
    if (!claim) throw new RefundError("CLAIM_MISSING", `退税凭证不存在: ${claimId}`);
    this.#actor(state, actor, actor.role === ROLES.AGENCY ? ROLES.AGENCY : ROLES.INSPECTOR);
    const seg = activeSegment(claim);
    if (seg.portCode === toPortCode) {
      throw new RefundError("ROUTE_SAME_PORT", "新口岸与当前口岸相同");
    }
    if (seg.settledAt && !seg.reversedAt) {
      throw new RefundError("SETTLED", "已结算凭证不能改港");
    }
    return this.#append("routeChanged", { claimId, toPortCode }, actor, requestId);
  }

  // ---- 品牌核实与口岸查验 -----------------------------------------------

  brandVerify(actor, { claimId, result, requestId = null }) {
    const state = this.#state();
    this.#actor(state, actor, ROLES.BRAND);
    const claim = state.claims.get(claimId);
    if (!claim) throw new RefundError("CLAIM_MISSING", `退税凭证不存在: ${claimId}`);
    const item = state.items.get(claim.itemId);
    if (item.brandPartyId !== actor.partyId) {
      throw new RefundError("FORBIDDEN", "只有授权品牌方能核实该商品");
    }
    if (!["genuine", "counterfeit"].includes(result)) {
      throw new RefundError("BAD_RESULT", "核实结果必须是 genuine 或 counterfeit");
    }
    return this.#append("brandVerified", { claimId, result }, actor, requestId);
  }

  #claimAtPort(state, actor, claimId, portCode) {
    this.#actor(state, actor, ROLES.INSPECTOR);
    const claim = state.claims.get(claimId);
    if (!claim) throw new RefundError("CLAIM_MISSING", `退税凭证不存在: ${claimId}`);
    const seg = activeSegment(claim);
    if (seg.portCode && seg.portCode !== portCode) {
      throw new RefundError(
        "PORT_MISMATCH",
        `凭证当前应在 ${seg.portCode} 验放，而非 ${portCode}`,
        { expectedPort: seg.portCode, actualPort: portCode, segmentId: seg.segmentId },
      );
    }
    return { claim, seg };
  }

  inspect(
    actor,
    { claimId, portCode, observedFeatures, terminalId = null, sessionId = null, requestId = null },
  ) {
    const state = this.#state();
    const { claim, seg } = this.#claimAtPort(state, actor, claimId, portCode);
    if (claim.brandResult === "counterfeit") {
      throw new RefundError("COUNTERFEIT", "品牌方已判定假冒，不予查验放行");
    }
    const item = state.items.get(claim.itemId);
    const observedHash = makeFeatureHash({
      batchId: item.batchId,
      serial: item.serial,
      features: observedFeatures,
    });
    const featureMatched = observedHash === item.featureHash;
    if (!featureMatched) {
      throw new RefundError("FEATURE_MISMATCH", "实物特征与商品身份不一致", {
        itemId: item.itemId,
        expectedHash: item.featureHash,
        observedHash,
      });
    }
    const liveInspection = effectiveInspection(seg);
    if (liveInspection) {
      // 同一会话重试是网络重传：幂等返回，不产生第二次查验。
      if (
        liveInspection.terminalId === terminalId &&
        liveInspection.sessionId === sessionId &&
        terminalId !== null
      ) {
        const firstEvent = this.ledger
          .events()
          .reverse()
          .find((ev) => ev.type === "inspectionPassed" && ev.claimId === claimId && ev.segmentId === seg.segmentId);
        return { deduped: true, event: firstEvent };
      }
      // 不同终端/会话对同一分段再次查验 = 双重查验，必须识别并拦下，
      // 同时把这次拦截追加进台账留痕，审计能看到是谁试图重复验放。
      this.ledger.append({
        type: "inspectionRejected",
        at: this.clock(),
        actor: actorId(actor),
        claimId,
        segmentId: seg.segmentId,
        portCode,
        terminalId,
        sessionId,
        reason: "double-inspection",
        firstSession: {
          terminalId: liveInspection.terminalId,
          sessionId: liveInspection.sessionId,
        },
      });
      throw new RefundError("DOUBLE_INSPECTION", "同一分段已被另一会话查验", {
        segmentId: seg.segmentId,
        first: liveInspection,
        second: { terminalId, sessionId },
      });
    }
    return this.#append(
      "inspectionPassed",
      { claimId, segmentId: seg.segmentId, portCode, terminalId, sessionId, featureMatched },
      actor,
      requestId,
    );
  }

  // 双重查验经带班查验员复核后，以复核事件为准（仍然留痕两次）。
  reviewInspection(actor, { claimId, resolution, requestId = null }) {
    const state = this.#state();
    this.#actor(state, actor, ROLES.INSPECTOR);
    const claim = state.claims.get(claimId);
    if (!effectiveInspection(activeSegment(claim))) {
      throw new RefundError("NO_INSPECTION", "当前分段没有可复核的查验");
    }
    if (!["confirmed", "rejected"].includes(resolution)) {
      throw new RefundError("BAD_RESOLUTION", "复核结论必须是 confirmed 或 rejected");
    }
    return this.#append(
      "inspectionReviewed",
      { claimId, resolution, reviewer: actor.partyId },
      actor,
      requestId,
    );
  }

  // ---- 申报与结算（共同确认） -------------------------------------------

  #requireClaimReadiness(state, claimId) {
    const claim = state.claims.get(claimId);
    if (!claim) throw new RefundError("CLAIM_MISSING", `退税凭证不存在: ${claimId}`);
    const seg = activeSegment(claim);
    const inv = state.invoices.get(claim.invoiceId);
    if (claim.brandResult !== "genuine") {
      throw new RefundError("BRAND_PENDING", "尚缺品牌方真赝核实");
    }
    if (!effectiveInspection(seg)) {
      throw new RefundError("INSPECTION_PENDING", "尚缺口岸查验");
    }
    if (netSales(inv).net <= 0) {
      throw new RefundError("NOTHING_TO_DECLARE", "当前净额为零，不在可申报范围");
    }
    return { claim, seg, inv };
  }

  fileClaim(actor, { claimId, requestId = null }) {
    const state = this.#state();
    this.#actor(state, actor, ROLES.AGENCY);
    const { claim } = this.#requireClaimReadiness(state, claimId);
    if (activeSegment(claim).filedAt) {
      throw new RefundError("ALREADY_FILED", "凭证已申报");
    }
    return this.#append("claimFiled", { claimId }, actor, requestId);
  }

  settle(actor, { claimId, requestId = null }) {
    const state = this.#state();
    this.#actor(state, actor, ROLES.AGENCY);
    const { claim, seg, inv } = this.#requireClaimReadiness(state, claimId);
    if (!seg.filedAt) throw new RefundError("NOT_FILED", "尚未向退税机构申报");
    if (seg.settledAt) throw new RefundError("ALREADY_SETTLED", "该分段已结算");
    // 同一商品不得重复退税：任何其他凭证上存在未冲正结算即拒绝。
    const holder = itemHeldByOtherClaim(state, claim.itemId, claimId);
    if (holder) {
      throw new RefundError("ITEM_ALREADY_REFUNDED", `商品已由凭证 ${holder} 退税`);
    }
    const net = netSales(inv);
    return this.#append(
      "refundSettled",
      {
        claimId,
        segmentId: seg.segmentId,
        netAmount: {
          amount: net.net,
          currency: net.invoiceCurrency,
          convertedAmount: net.convertedNet,
          convertedCurrency: net.refundCurrency,
        },
      },
      actor,
      requestId,
    );
  }

  // 冲正：一方提议、另一方确认，谁都不能单独推翻已结算状态。
  proposeReversal(actor, { claimId, reason, requestId = null }) {
    const state = this.#state();
    if (actor.role !== ROLES.INSPECTOR && actor.role !== ROLES.AGENCY) {
      throw new RefundError("FORBIDDEN", "只有查验员或退税机构能发起冲正");
    }
    this.#actor(state, actor, actor.role);
    const claim = state.claims.get(claimId);
    if (!claim) throw new RefundError("CLAIM_MISSING", `退税凭证不存在: ${claimId}`);
    const seg = activeSegment(claim);
    if (!seg.settledAt || seg.reversedAt) {
      throw new RefundError("NOT_SETTLED", "仅已结算凭证可以冲正");
    }
    if (seg.pendingReversal) {
      throw new RefundError("REVERSAL_PENDING", "已有待确认的冲正提议");
    }
    return this.#append(
      "reversalProposed",
      { claimId, proposedByRole: actor.role, reason },
      actor,
      requestId,
    );
  }

  confirmReversal(actor, { claimId, reversalId, requestId = null }) {
    const state = this.#state();
    if (actor.role !== ROLES.INSPECTOR && actor.role !== ROLES.AGENCY) {
      throw new RefundError("FORBIDDEN", "只有查验员或退税机构能确认冲正");
    }
    this.#actor(state, actor, actor.role);
    const claim = state.claims.get(claimId);
    if (!claim) throw new RefundError("CLAIM_MISSING", `退税凭证不存在: ${claimId}`);
    const seg = activeSegment(claim);
    if (!seg.pendingReversal) {
      throw new RefundError("NO_REVERSAL_PROPOSAL", "没有待确认的冲正提议");
    }
    if (seg.pendingReversal.proposedByRole === actor.role) {
      throw new RefundError("REVERSAL_NEEDS_COUNTERPARTY", "冲正必须由另一方确认");
    }
    return this.#append(
      "settlementReversed",
      { claimId, reversalId, reason: seg.pendingReversal.reason },
      actor,
      requestId,
    );
  }

  // ---- 隐私到期 ---------------------------------------------------------

  purgeExpired(now = this.clock()) {
    const purged = this.vault.purgeExpired(now);
    const events = [];
    for (const item of purged) {
      events.push(
        this.#append(
          "privacyPurged",
          { ref: item.ref, fields: item.fields, expiresAt: item.expiresAt },
          { partyId: "retention-job", role: ROLES.SYSTEM },
        ),
      );
    }
    return events;
  }

  // ---- 查询 -------------------------------------------------------------

  snapshot() {
    return this.#state();
  }

  netSalesFor(invoiceId) {
    const inv = this.#state().invoices.get(invoiceId);
    if (!inv) throw new RefundError("INVOICE_MISSING", `发票不存在: ${invoiceId}`);
    return netSales(inv);
  }

  statusOf(claimId) {
    const claim = this.#state().claims.get(claimId);
    if (!claim) throw new RefundError("CLAIM_MISSING", `退税凭证不存在: ${claimId}`);
    return {
      claimId,
      status: claimStatus(claim),
      missing: pendingMaterials(claim),
      segment: activeSegment(claim).segmentId,
    };
  }
}

function actorId(actor) {
  return actor && actor.partyId ? { partyId: actor.partyId, role: actor.role } : null;
}

function validateMoney(m) {
  if (!m || typeof m.amount !== "number" || !Number.isFinite(m.amount) || !m.currency) {
    throw new RefundError("BAD_MONEY", "金额必须是带币种的数值");
  }
}

function validateFx(fx) {
  if (!fx || !fx.currency || typeof fx.rate !== "number" || fx.rate <= 0) {
    throw new RefundError("BAD_FX", "汇率必须包含目标币种和正数汇率");
  }
}
