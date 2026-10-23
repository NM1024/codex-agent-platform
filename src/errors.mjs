export class HttpError extends Error {
  constructor(status, code, message = code) {
    super(message);
    this.status = status;
    this.code = code;
  }
}
export function invalid() {
  return new HttpError(400, "INVALID_INPUT", "请求字段不正确");
}
