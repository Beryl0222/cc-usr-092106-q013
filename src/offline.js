import { RefundError } from "./errors.js";

// 离线口岸终端：断网期间把操作按顺序暂存本机队列，重连后用固定的
// requestId 逐条重放。同机重发因 requestId 幂等不会重复入账；若另一台
// 终端已在同一分段完成查验，重放会收到 DOUBLE_INSPECTION 并被标记为
// 冲突，交带班查验员复核，而不是悄悄覆盖。
export class OfflineTerminal {
  constructor(service, { terminalId }) {
    this.service = service;
    this.terminalId = terminalId;
    this.online = true;
    this.queue = []; // {op, args, requestId, result}
  }

  connect() {
    this.online = true;
  }

  disconnect() {
    this.online = false;
  }

  // op：service 上的方法名；args：参数对象（不含 actor）。
  submit(actor, op, args = {}) {
    const requestId = `${this.terminalId}:${op}:${args.claimId ?? args.invoiceId ?? ""}:${this.queue.length + 1}`;
    const entry = { actor, op, args, requestId, status: "queued", result: null, errorCode: null };
    if (this.online) return this.#run(entry);
    this.queue.push(entry);
    return { offline: true, queued: requestId };
  }

  pending() {
    return this.queue
      .filter((e) => e.status === "queued")
      .map(({ actor: _a, ...rest }) => rest);
  }

  // 重连重放：按断网前顺序提交。已入账的请求返回 deduped；遇到业务冲突
  // （如双重查验）不中断整批同步，而是把该条标为 conflict 继续其余条目。
  sync() {
    this.online = true;
    const report = { applied: [], deduped: [], conflicts: [], errors: [] };
    for (const entry of this.queue) {
      if (entry.status !== "queued") continue;
      try {
        const result = this.#run(entry);
        if (result.deduped) report.deduped.push(entry.requestId);
        else report.applied.push(entry.requestId);
      } catch (err) {
        if (err instanceof RefundError) {
          entry.status = err.code === "DOUBLE_INSPECTION" ? "conflict" : "error";
          entry.errorCode = err.code;
          report[err.code === "DOUBLE_INSPECTION" ? "conflicts" : "errors"].push({
            requestId: entry.requestId,
            code: err.code,
            details: err.details,
          });
        } else {
          entry.status = "error";
          report.errors.push({ requestId: entry.requestId, code: "INTERNAL", message: err.message });
        }
      }
    }
    return report;
  }

  #run(entry) {
    const result = this.service[entry.op](entry.actor, {
      ...entry.args,
      terminalId: entry.op === "inspect" ? this.terminalId : entry.args.terminalId,
      sessionId: entry.op === "inspect" ? (entry.args.sessionId ?? entry.requestId) : entry.args.sessionId,
      requestId: entry.requestId,
    });
    entry.status = "applied";
    entry.result = result?.event ?? result;
    return result;
  }
}
