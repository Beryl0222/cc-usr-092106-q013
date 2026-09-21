import { canonical, sha256 } from "./hash.js";

// 隐私信封：完整证件号、姓名等敏感字段只保存在本侧库中，台账事件里
// 只有承诺哈希 privateRef。到期后物理删除（不可恢复），并由台账中的
// privacyPurge 墓碑事件保留“何时、何字段、因何到期被清除”的审计事实。
export class PrivateVault {
  #items = new Map();

  put(data, { expiresAt }) {
    if (!expiresAt) throw new Error("隐私记录必须给出到期时间");
    const ref = sha256(canonical({ purpose: "tax-refund-private", data }));
    this.#items.set(ref, {
      data: structuredClone(data),
      expiresAt,
      fields: Object.keys(data).sort(),
      purgedAt: null,
    });
    return ref;
  }

  // 提交即遗忘：正常业务路径不应再取回明文，仅保留测试/本人核验用途。
  get(ref) {
    const item = this.#items.get(ref);
    if (!item || item.purgedAt) return null;
    return structuredClone(item.data);
  }

  status(ref) {
    const item = this.#items.get(ref);
    if (!item) return null;
    return {
      fields: item.fields.slice(),
      expiresAt: item.expiresAt,
      purgedAt: item.purgedAt,
    };
  }

  // 删除一切已到期记录，返回可供登记墓碑事件的清单。
  purgeExpired(now) {
    const purged = [];
    for (const [ref, item] of this.#items) {
      if (!item.purgedAt && item.expiresAt <= now) {
        item.purgedAt = now;
        purged.push({ ref, fields: item.fields.slice(), expiresAt: item.expiresAt });
      }
    }
    for (const { ref } of purged) this.#items.delete(ref);
    return purged;
  }
}
