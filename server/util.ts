import { createHash } from "node:crypto";
export class AppError extends Error {
  constructor(
    message: string,
    public status = 400,
    public code = "invalid_request",
    public issues?: unknown,
  ) {
    super(message);
  }
}
export function ensure(
  value: unknown,
  message: string,
  status = 400,
  code = "invalid_request",
): asserts value {
  if (!value) throw new AppError(message, status, code);
}
export const sha = (data: Buffer | string) =>
  createHash("sha256").update(data).digest("hex");
export const iso = () => new Date().toISOString();
export function boundedText(value: unknown, max = 20000) {
  ensure(typeof value === "string" && value.length <= max, "文字长度无效");
  return value;
}
export function escapeHtml(s: unknown) {
  return String(s ?? "").replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ]!,
  );
}
export function cleanError(error: any) {
  const raw = String(error?.message || "操作失败");
  return raw
    .replace(/(?:Bearer|Key)\s+[^\s"']+/gi, "[redacted]")
    .replace(/(?:sk|key|token)-[A-Za-z0-9_-]{10,}/g, "[redacted]")
    .replace(/\/Users\/[^\s]+/g, "[local path]")
    .slice(0, 600);
}
