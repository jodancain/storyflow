import JSZip from "jszip";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { extname, basename, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Store } from "./store.ts";
import { ensure, cleanError } from "./util.ts";
const execute = promisify(execFile);
const extractor = fileURLToPath(
  new URL("../scripts/extract_document.py", import.meta.url),
);
export function detectMime(name: string, bytes: Buffer) {
  const ext = extname(name).toLowerCase();
  if (bytes.subarray(0, 4).toString() === "%PDF") return "application/pdf";
  if (
    bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
  )
    return "image/png";
  if (bytes[0] === 255 && bytes[1] === 216) return "image/jpeg";
  if (bytes.subarray(0, 3).toString() === "GIF") return "image/gif";
  if (
    bytes.subarray(0, 4).toString() === "RIFF" &&
    bytes.subarray(8, 12).toString() === "WEBP"
  )
    return "image/webp";
  if (bytes.subarray(4, 8).toString() === "ftyp")
    return ext === ".m4a" ? "audio/mp4" : "video/mp4";
  if (
    bytes.subarray(0, 4).toString() === "RIFF" &&
    bytes.subarray(8, 12).toString() === "WAVE"
  )
    return "audio/wav";
  if (
    bytes.subarray(0, 3).toString() === "ID3" ||
    (bytes[0] === 255 && (bytes[1] & 224) === 224)
  )
    return "audio/mpeg";
  if (ext === ".docx" && bytes[0] === 80 && bytes[1] === 75)
    return "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
  if (ext === ".zip" && bytes[0] === 80 && bytes[1] === 75)
    return "application/zip";
  if ([".txt", ".md", ".json", ".csv", ".srt", ".vtt"].includes(ext)) {
    ensure(!bytes.includes(0), "文字文件含二进制内容");
    return ext === ".json" ? "application/json" : "text/plain";
  }
  throw new Error(`不支持或无法识别文件 ${basename(name)}`);
}
export async function zipEntries(bytes: Buffer, maxBytes = 200 * 1024 * 1024) {
  const zip = await JSZip.loadAsync(bytes, { checkCRC32: false });
  const items = Object.values(zip.files).filter((f) => !f.dir);
  ensure(items.length <= 500, "ZIP文件数超过500");
  let total = 0;
  for (const f of items) {
    const original = (f as any).unsafeOriginalName || f.name;
    ensure(
      !original.startsWith("/") &&
        !/^[A-Za-z]:/.test(original) &&
        !original.includes("\\") &&
        !original.split("/").includes("..") &&
        !original.includes("\0"),
      "ZIP含非法原始路径",
    );
    ensure(
      !f.name.startsWith("/") &&
        !f.name.includes("\\") &&
        !f.name.split("/").includes("..") &&
        !f.name.includes("\0"),
      "ZIP含非法路径",
    );
    const mode =
      typeof f.unixPermissions === "number"
        ? f.unixPermissions
        : parseInt(f.unixPermissions || "0", 8);
    ensure((mode & 0xf000) !== 0xa000, "ZIP不允许符号链接");
    total += (f as any)._data?.uncompressedSize || 0;
    ensure(total <= maxBytes, "ZIP解压总量超限");
  }
  return items;
}
export async function ingest(
  store: Store,
  projectId: string,
  name: string,
  bytes: Buffer,
  depth = 0,
): Promise<any[]> {
  ensure(bytes.length <= 50 * 1024 * 1024, "单文件限制50MB");
  const mime = detectMime(name, bytes);
  if (mime === "application/zip") {
    ensure(depth === 0, "不支持嵌套ZIP");
    const files = await zipEntries(bytes);
    const results = [];
    for (const f of files) {
      if (f.name.startsWith("__MACOSX/") || basename(f.name).startsWith("."))
        continue;
      try {
        const data = await f.async("nodebuffer");
        results.push(
          ...(await ingest(store, projectId, f.name, data, depth + 1)),
        );
      } catch (e) {
        results.push({ name: f.name, error: cleanError(e), imported: false });
      }
    }
    return results;
  }
  const file = store.addFile(projectId, name, mime, bytes);
  let text = "",
    metadata: Record<string, unknown> = {};
  try {
    if (mime === "text/plain" || mime === "application/json") {
      text = bytes.toString("utf8");
      ensure(text.length <= 500000, "文字内容超限");
    } else if (
      mime === "application/pdf" ||
      mime.includes("wordprocessingml")
    ) {
      const r = await execute(
        process.env.PYTHON || "python3",
        [
          extractor,
          store.filePath(file.id),
          mime === "application/pdf" ? "pdf" : "docx",
        ],
        { maxBuffer: 4 * 1024 * 1024, timeout: 60000 },
      );
      const parsed = JSON.parse(r.stdout);
      text = parsed.text;
      metadata = parsed;
    } else
      metadata = {
        warnings: ["此文件已保留；图片与媒体不自动转写为医学证据。"],
      };
  } catch (error) {
    metadata = {
      extractionError: cleanError(error),
      warnings: ["原文件已保留，提取未成功，请补充可读文字。"],
    };
  }
  const updated = { ...file, text, metadata };
  store.db
    .prepare("UPDATE files SET json=? WHERE id=?")
    .run(JSON.stringify(updated), file.id);
  return [updated];
}
