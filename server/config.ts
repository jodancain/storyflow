import { readFileSync, existsSync } from "node:fs";
import { resolve, join } from "node:path";
import { homedir } from "node:os";
import type { ProviderConfig } from "../shared/types.ts";
export function loadDotEnv() {
  if (!existsSync(".env")) return;
  for (const row of readFileSync(".env", "utf8").split(/\r?\n/)) {
    const m = row.match(/^([A-Z][A-Z0-9_]*)=(.*)$/);
    if (m && process.env[m[1]] === undefined)
      process.env[m[1]] = m[2].trim().replace(/^(['"])(.*)\1$/, "$2");
  }
}
export function configFromEnv() {
  const e = process.env;
  return {
    host: e.HOST || "127.0.0.1",
    port: Number(e.PORT || 18296),
    dataDir: resolve(
      e.STORYFLOW_DATA_DIR || join(homedir(), ".local/share/storyflow"),
    ),
    publicBaseUrl: e.PUBLIC_BASE_URL || `http://127.0.0.1:${e.PORT || 18296}`,
    adminPassword: e.STORYFLOW_ADMIN_PASSWORD || "",
    publicReviewProjectIds: (e.STORYFLOW_PUBLIC_REVIEW_PROJECTS || "").split(",").map(id => id.trim()).filter(Boolean),
    publicReviewApiBase: e.STORYFLOW_PUBLIC_REVIEW_API_BASE || "/api",
    providers: {
      imageBase: e.IMAGE_BASE_URL || "",
      imageKey: e.IMAGE_API_KEY || "",
      imageModel: e.IMAGE_MODEL || "gpt-image-2",
      seedanceBase: e.SEEDANCE_BASE_URL || "",
      seedanceKey: e.SEEDANCE_API_KEY || "",
      seedanceModel: e.SEEDANCE_MODEL || "seedance-2-0",
      falKey: e.FAL_KEY || "",
      falBase: "https://queue.fal.run",
      opusBase: e.OPUS_BASE_URL || "",
      opusKey: e.OPUS_API_KEY || "",
      opusModel: e.OPUS_MODEL || "claude-opus-5-5",
    } satisfies ProviderConfig,
  };
}
