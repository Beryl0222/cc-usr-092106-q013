import { EventEmitter } from "node:events";
import { hashEvent, GENESIS_HASH } from "./hash.js";

// 只追加事件台账：事件一旦写入不可修改、不可删除；隐私数据不进台账
// （见 vault.js），台账内只保留其承诺哈希。append 可选幂等键 requestId，
// 同一键重放直接返回原事件，不产生第二条记录。
export class Ledger extends EventEmitter {
  #events = [];
  #byRequest = new Map();

  constructor() {
    super();
  }

  get size() {
    return this.#events.length;
  }

  events() {
    return this.#events.slice();
  }

  at(seq) {
    return this.#events[seq] ?? null;
  }

  hasRequest(requestId) {
    return this.#byRequest.has(requestId);
  }

  eventByRequest(requestId) {
    return this.#byRequest.get(requestId) ?? null;
  }

  append(body, requestId = null) {
    if (requestId !== null && requestId !== undefined) {
      const existing = this.#byRequest.get(requestId);
      if (existing) return { deduped: true, event: existing };
    }
    const seq = this.#events.length;
    const prevHash = this.#events.at(-1)?.hash ?? GENESIS_HASH;
    const full = { seq, prevHash, ...structuredClone(body) };
    const hash = hashEvent(prevHash, { seq, ...body });
    const event = Object.freeze({ ...full, hash });
    this.#events.push(event);
    if (requestId !== null && requestId !== undefined) {
      this.#byRequest.set(requestId, event);
    }
    this.emit("append", event);
    return { deduped: false, event };
  }

  // 复验整条哈希链，返回第一个断链位置；审计据此判断台账是否被篡改。
  verify() {
    return verifyEvents(this.#events);
  }
}

// 可对任意事件集合复验（事件含 seq/prevHash/hash 与正文）。
export function verifyEvents(events) {
  let prevHash = GENESIS_HASH;
  for (const event of events) {
    const { seq, prevHash: claimedPrev, hash, ...body } = event;
    const expected = hashEvent(prevHash, { seq, ...body });
    if (hash !== expected || claimedPrev !== prevHash) {
      return { ok: false, brokenAt: event.seq };
    }
    prevHash = hash;
  }
  return { ok: true, count: events.length };
}
