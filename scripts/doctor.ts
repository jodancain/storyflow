import { chromiumOptions } from "../server/chromium.ts";
import { execFileSync } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import {
  mkdtempSync,
  rmSync,
  mkdirSync,
  realpathSync,
  accessSync,
  constants,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { chromium } from "playwright";
import { configFromEnv, loadDotEnv } from "../server/config.ts";

loadDotEnv();
const config = configFromEnv();
type Check = { name: string; ok: boolean; required: boolean; detail: string };
const checks: Check[] = [];
async function check(
  name: string,
  fn: () => string | Promise<string>,
  required = true,
) {
  try {
    checks.push({ name, ok: true, required, detail: await fn() });
  } catch (error) {
    checks.push({
      name,
      ok: false,
      required,
      detail:
        error instanceof Error
          ? error.message.split("\n")[0].slice(0, 250)
          : "check failed",
    });
  }
}
await check("Node", () => {
  const [major, minor] = process.versions.node.split(".").map(Number);
  if (!((major === 22 && minor >= 13) || major >= 24))
    throw new Error("Requires Node 22.13+ (22.x) or 24+");
  return process.versions.node;
});
for (const [name, binary] of [
  ["FFmpeg", process.env.FFMPEG_PATH || process.env.FFMPEG || "ffmpeg"],
  ["FFprobe", process.env.FFPROBE_PATH || process.env.FFPROBE || "ffprobe"],
])
  await check(
    name,
    () =>
      execFileSync(binary, ["-version"], {
        timeout: 10000,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
      }).split("\n")[0],
  );
await check("Python / pypdf", () =>
  execFileSync(
    process.env.PYTHON || "python3",
    [
      "-c",
      'import sys,pypdf; print("Python " + sys.version.split()[0] + "; pypdf " + pypdf.__version__)',
    ],
    { timeout: 10000, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
  ).trim(),
);
await check("SQLite WAL", () => {
  const dir = mkdtempSync(join(tmpdir(), "storyflow-doctor-"));
  const db = new DatabaseSync(join(dir, "check.sqlite"));
  try {
    db.exec(
      "PRAGMA journal_mode=WAL; CREATE TABLE check_wal(value INTEGER); INSERT INTO check_wal VALUES(1)",
    );
    if ((db.prepare("SELECT value FROM check_wal").get() as any)?.value !== 1)
      throw new Error("SQLite write/read failed");
    return "WAL write/read verified";
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
await check("Data directory", () => {
  mkdirSync(config.dataDir, { recursive: true, mode: 0o700 });
  const actual = realpathSync(config.dataDir);
  accessSync(actual, constants.R_OK | constants.W_OK);
  if (
    /(?:^|[\\/])(?:SynologyDrive|Dropbox|OneDrive|Google Drive|Mobile Documents)(?:[\\/]|$)/i.test(
      actual,
    )
  )
    throw new Error(
      "Active SQLite must use local nonsynchronized storage, not this synchronized directory",
    );
  return actual;
});
await check("Chromium rendering", async () => {
  const browser = await chromium.launch(chromiumOptions());
  try {
    const page = await browser.newPage({
      viewport: { width: 128, height: 128 },
    });
    await page.setContent(
      '<style>body{font-family:"Noto Sans CJK SC",sans-serif}</style><p>映序医科</p>',
    );
    const png = await page.screenshot();
    if (png.length < 100) throw new Error("Empty render");
    return `${browser.version()}; PNG ${png.length} bytes`;
  } finally {
    await browser.close();
  }
});
await check(
  "Provider configuration",
  () => {
    const p = config.providers;
    const selected = p.lipsyncProvider || "fal";
    const lipsyncConfigured = selected === "volcano-omnihuman" ? !!(p.volcanoAccessKeyId && p.volcanoSecretAccessKey) : !!p.falKey;
    return `Opus: ${p.opusBase && p.opusKey ? "configured" : "missing"}; Seedance: ${p.seedanceBase && p.seedanceKey ? "configured" : "missing"}; lipsync (${selected}): ${lipsyncConfigured ? "configured" : "missing"} (configuration only; no paid request)`;
  },
  false,
);
const report = { ok: checks.every((c) => c.ok || !c.required), checks };
console.log(
  process.argv.includes("--json")
    ? JSON.stringify(report, null, 2)
    : checks
        .map((c) => `${c.ok ? "✓" : "✗"} ${c.name}: ${c.detail}`)
        .join("\n"),
);
if (!report.ok) process.exitCode = 1;
