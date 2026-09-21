import {
  project,
  netSales,
  activeSegment,
  claimStatus,
  pendingMaterials,
} from "./projection.js";

// 旅客视图：旅客持有退税凭证到口岸，应能用熟悉的语言直接看到三件事——
// 哪件商品缺材料、哪笔退货已经冲减、接下来还要经过谁。视图只读，且不
// 回显证件号等隐私字段。
const LOCALES = ["zh", "en", "ja"];

const I18N = {
  zh: {
    title: "我的离境退税",
    localeName: "中文",
    headers: {
      item: "商品",
      store: "门店",
      status: "状态",
      missing: "还缺什么",
      deductions: "已冲减",
      net: "当前可退基数（净额）",
      next: "下一步经过谁",
      port: "验放口岸",
      flight: "航班",
      none: "暂无退税凭证",
    },
    status: {
      preparing: "材料准备中",
      "inspected-awaiting-file": "已查验，待退税窗口申报",
      "awaiting-settlement": "已申报，等待结算",
      settled: "已退税完成",
      "reversed-reopen": "原结算已冲正，需重新查验",
      "blocked-counterfeit": "品牌方判定假冒，已阻断",
    },
    missing: {
      "brand-verification": "品牌方真赝核实",
      inspection: "口岸实物查验",
      filing: "向退税窗口申报",
      settlement: "退税机构结算",
    },
    owner: {
      brand: "品牌方",
      inspector: "海关查验员",
      agency: "退税窗口",
      merchant: "门店",
    },
    next: {
      brand: "请等待品牌方核实真伪",
      inspector: "请携带商品到海关查验台",
      agency: "请前往退税窗口",
      merchant: "请联系开票门店补材料",
      done: "本笔已完成，无需再排队",
      blocked: "本笔无法退税，请向门店或海关咨询",
      reopen: "请重新到海关查验台验放",
    },
    deductions: {
      return: "退货冲减",
      adjustment: "价格调整",
      fx: "汇率更新",
      none: "无",
    },
  },
  en: {
    title: "My departure tax refund",
    localeName: "English",
    headers: {
      item: "Item",
      store: "Store",
      status: "Status",
      missing: "What's missing",
      deductions: "Deducted",
      net: "Current refund base (net)",
      next: "Next step with",
      port: "Inspection port",
      flight: "Flight",
      none: "No refund vouchers yet",
    },
    status: {
      preparing: "Documents being prepared",
      "inspected-awaiting-file": "Inspected; ready to file at the refund desk",
      "awaiting-settlement": "Filed; awaiting settlement",
      settled: "Refund completed",
      "reversed-reopen": "Settlement reversed; re-inspection required",
      "blocked-counterfeit": "Brand found it counterfeit; blocked",
    },
    missing: {
      "brand-verification": "Brand authenticity check",
      inspection: "Customs inspection of the goods",
      filing: "Filing at the refund desk",
      settlement: "Refund agency settlement",
    },
    owner: {
      brand: "Brand",
      inspector: "Customs inspector",
      agency: "Refund desk",
      merchant: "Store",
    },
    next: {
      brand: "Please wait for the brand authenticity result",
      inspector: "Please take the goods to the customs desk",
      agency: "Please go to the refund desk",
      merchant: "Please contact the issuing store",
      done: "This refund is complete; no further queue",
      blocked: "This item cannot be refunded; ask the store or customs",
      reopen: "Please return to the customs desk for inspection",
    },
    deductions: {
      return: "Return deducted",
      adjustment: "Price adjustment",
      fx: "FX rate updated",
      none: "None",
    },
  },
  ja: {
    title: "出国時免税還付のご案内",
    localeName: "日本語",
    headers: {
      item: "商品",
      store: "店舗",
      status: "状況",
      missing: "不足しているもの",
      deductions: "控除済み",
      net: "現在の還付対象額（純額）",
      next: "次の手続き先",
      port: "検査口岸",
      flight: "フライト",
      none: "還付書類はまだありません",
    },
    status: {
      preparing: "書類を準備中",
      "inspected-awaiting-file": "検査済み。還付窓口で申告できます",
      "awaiting-settlement": "申告済み。支払いを待っています",
      settled: "還付完了",
      "reversed-reopen": "支払いが取り消されました。再検査が必要です",
      "blocked-counterfeit": "ブランドが偽造と判定。ブロックされました",
    },
    missing: {
      "brand-verification": "ブランドによる真贋確認",
      inspection: "税関での現物検査",
      filing: "還付窓口での申告",
      settlement: "還付機関の支払い",
    },
    owner: {
      brand: "ブランド",
      inspector: "税関検査官",
      agency: "還付窓口",
      merchant: "店舗",
    },
    next: {
      brand: "ブランドの真贋結果をお待ちください",
      inspector: "商品を税関検査台までお持ちください",
      agency: "還付窓口へお進みください",
      merchant: "発行店舗にお問い合わせください",
      done: "この還付は完了しています。再び並ぶ必要はありません",
      blocked: "この商品は還付できません。店舗または税関にご相談ください",
      reopen: "税関検査台で再度検査を受けてください",
    },
    deductions: {
      return: "返品による控除",
      adjustment: "価格調整",
      fx: "為替レート更新",
      none: "なし",
    },
  },
};

export function supportedLocales() {
  return LOCALES.slice();
}

function money(amount, currency) {
  return `${amount.toFixed(2)} ${currency}`;
}

// 为一名旅客的全部凭证（可来自多家门店）生成视图。
export function travelerDashboard(service, locale = "zh", claimIds = null) {
  if (!LOCALES.includes(locale)) throw new Error(`不支持的语言: ${locale}`);
  const t = I18N[locale];
  const state = service.snapshot();
  const ids = claimIds ?? [...state.claims.keys()];

  const vouchers = ids.map((claimId) => {
    const claim = state.claims.get(claimId);
    const inv = state.invoices.get(claim.invoiceId);
    const item = state.items.get(claim.itemId);
    const batch = state.batches.get(item.batchId);
    const seg = activeSegment(claim);
    const net = netSales(inv);
    const names = (batch.catalogIds ?? [])
      .map((id) => state.catalog.get(id)?.name)
      .filter(Boolean);

    const deductions = [];
    for (const r of net.returns) {
      deductions.push({
        kind: "return",
        label: `${t.deductions.return}（${r.reason}）`,
        amount: `-${money(r.amount.amount, r.amount.currency)}`,
        at: r.at,
      });
    }
    for (const a of net.adjustments) {
      deductions.push({
        kind: "adjustment",
        label: `${t.deductions.adjustment}（${a.reason}）`,
        amount: `${a.delta.amount >= 0 ? "+" : ""}${money(a.delta.amount, a.delta.currency)}`,
        at: a.at,
      });
    }

    const missing = pendingMaterials(claim).map((m) => ({
      code: m.code,
      label: t.missing[m.code] ?? m.code,
      owner: m.owner,
      ownerLabel: t.owner[m.owner] ?? m.owner,
      blocked: Boolean(m.blocked),
    }));

    const status = claimStatus(claim);
    let nextKey;
    if (status === "settled") nextKey = "done";
    else if (status === "blocked-counterfeit") nextKey = "blocked";
    else if (status === "reversed-reopen") nextKey = "reopen";
    else nextKey = missing[0]?.owner ?? "done";

    return {
      claimId,
      item: {
        itemId: item.itemId,
        batchId: item.batchId,
        serial: item.serial,
        names,
      },
      store: { storeId: inv.storeId, merchantId: inv.merchantId },
      status: { code: status, label: t.status[status] ?? status },
      port: { code: seg.portCode ?? "—", anchored: seg.portCode !== null },
      flight: { no: claim.flightNo, departAt: claim.departAt },
      missing,
      deductions,
      net: {
        label: t.headers.net,
        amount: money(net.net, net.invoiceCurrency),
        converted:
          net.invoiceCurrency === net.refundCurrency
            ? null
            : money(net.convertedNet, net.refundCurrency),
        fxRate: net.fxRate,
        fxNote:
          net.invoiceCurrency === net.refundCurrency
            ? null
            : `${t.deductions.fx}: ${net.fxRate}`,
      },
      next: t.next[nextKey] ?? t.next.done,
    };
  });

  return {
    locale,
    localeName: t.localeName,
    title: t.title,
    headers: t.headers,
    emptyNote: t.headers.none,
    vouchers,
    generatedAt: new Date().toISOString(),
  };
}
