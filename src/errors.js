// 业务规则错误：code 供程序判断，message 供日志，details 携带现场信息。
export class RefundError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = "RefundError";
    this.code = code;
    this.details = details;
  }
}
