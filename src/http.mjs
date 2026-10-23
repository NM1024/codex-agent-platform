import { timingSafeEqual } from "node:crypto";
import { HttpError } from "./errors.mjs";
export function authorized(req, token) {
  const values = [];
  for (let i = 0; i < req.rawHeaders.length; i += 2)
    if (req.rawHeaders[i].toLowerCase() === "authorization")
      values.push(req.rawHeaders[i + 1]);
  const actual = Buffer.from(values[0] ?? "");
  const expected = Buffer.from(`Bearer ${token}`);
  return (
    values.length === 1 &&
    actual.length === expected.length &&
    timingSafeEqual(actual, expected)
  );
}
export function requireAuth(req, token) {
  if (!authorized(req, token))
    throw new HttpError(401, "UNAUTHORIZED", "认证失败");
}
export async function readJson(req, max = 1048576) {
  if (!/^application\/json(?:\s*;|$)/i.test(req.headers["content-type"] ?? ""))
    throw new HttpError(
      415,
      "UNSUPPORTED_MEDIA_TYPE",
      "请使用 application/json",
    );
  if (Number(req.headers["content-length"]) > max)
    throw new HttpError(413, "PAYLOAD_TOO_LARGE", "请求过大");
  let size = 0;
  const chunks = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > max) throw new HttpError(413, "PAYLOAD_TOO_LARGE", "请求过大");
    chunks.push(chunk);
  }
  try {
    return JSON.parse(
      new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks)),
    );
  } catch {
    throw new HttpError(400, "INVALID_JSON", "JSON 格式不正确");
  }
}
export function json(res, status, body) {
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
  });
  res.end(JSON.stringify(body));
}
export function errorResponse(res, error) {
  const status = error instanceof HttpError ? error.status : 503;
  json(res, status, {
    error: {
      code: error instanceof HttpError ? error.code : "SERVICE_UNAVAILABLE",
      message: error instanceof HttpError ? error.message : "服务暂不可用",
    },
  });
}
