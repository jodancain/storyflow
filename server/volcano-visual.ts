import { createHash, createHmac } from "node:crypto";
import type { LipsyncProviderSpec, ProviderConfig } from "../shared/types.ts";

export const VOLCANO_VISUAL_BASE = "https://visual.volcengineapi.com";
export const VOLCANO_OMNI = "jimeng_realman_avatar_picture_omni_v15";
export const FAL_OMNI = "fal-ai/bytedance/omnihuman/v1.5";

export function lipsyncProfile(config: ProviderConfig, provider = config.lipsyncProvider || "fal"): LipsyncProviderSpec {
  if (provider === "volcano-omnihuman") return {
    provider, model: VOLCANO_OMNI, baseUrl: VOLCANO_VISUAL_BASE,
    protocol: "volcano-cv-2022-08-31", outputResolution: 1080, fastMode: false,
  };
  if (provider !== "fal") throw new Error("Unsupported LIPSYNC_PROVIDER configuration");
  return {provider:"fal", model:FAL_OMNI, baseUrl:(config.falBase || "https://queue.fal.run").replace(/\/+$/, ""), protocol:"fal-queue-v1", outputResolution:1080, fastMode:false};
}

/** Fixed visual service signing. Never persist or log the returned auth headers. */
export function signVolcanoVisual(
  action: "CVSubmitTask" | "CVGetResult",
  body: string,
  credentials: { accessKeyId: string; secretAccessKey: string },
  now = new Date(),
) {
  if (!["CVSubmitTask", "CVGetResult"].includes(action) || !credentials.accessKeyId || !credentials.secretAccessKey)
    throw new Error("Volcano visual credentials or action are invalid");
  const hash = (value: string) => createHash("sha256").update(value).digest("hex");
  const hmac = (key: string | Buffer, value: string) => createHmac("sha256", key).update(value).digest();
  const host = "visual.volcengineapi.com", date = now.toISOString().replace(/[:-]|\.\d{3}/g, ""), day = date.slice(0, 8);
  const query = `Action=${action}&Version=2022-08-31`, contentHash = hash(body);
  const signedHeaders = "content-type;host;x-content-sha256;x-date";
  const canonicalHeaders = `content-type:application/json\nhost:${host}\nx-content-sha256:${contentHash}\nx-date:${date}\n`;
  const scope = `${day}/cn-north-1/cv/request`;
  const canonical = ["POST", "/", query, canonicalHeaders, signedHeaders, contentHash].join("\n");
  const signingKey = hmac(hmac(hmac(hmac(credentials.secretAccessKey, day), "cn-north-1"), "cv"), "request");
  const signature = hmac(signingKey, ["HMAC-SHA256", date, scope, hash(canonical)].join("\n")).toString("hex");
  return {url:`${VOLCANO_VISUAL_BASE}/?${query}`, headers:{
    "content-type":"application/json", "x-date":date, "x-content-sha256":contentHash,
    authorization:`HMAC-SHA256 Credential=${credentials.accessKeyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`,
  }};
}
