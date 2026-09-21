import { createHash } from "node:crypto";

// 规范化 JSON：对象键排序，保证同一内容永远得到同一哈希。
export function canonical(value) {
  return JSON.stringify(sortDeep(value));
}

function sortDeep(value) {
  if (Array.isArray(value)) return value.map(sortDeep);
  if (value && typeof value === "object") {
    const out = {};
    for (const key of Object.keys(value).sort()) out[key] = sortDeep(value[key]);
    return out;
  }
  return value;
}

export function sha256(text) {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

// 事件链：hash_n = sha256(hash_{n-1} || canonical(事件正文))。
// 任一事件被事后改写，从该事件起的整条链都无法复验。
export function hashEvent(prevHash, eventBody) {
  return sha256(`${prevHash}\n${canonical(eventBody)}`);
}

export const GENESIS_HASH = "0".repeat(64);
