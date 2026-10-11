import type { ProviderConfig, VideoInput, VideoProviderSpec } from "../shared/types.ts";

const VEO_MODELS = new Set([
  "veo-3.1-generate-001", "veo-3.1-fast-generate-001", "veo-3.1-lite-generate-001",
]);

// This is a non-secret execution snapshot, separate from the story/image hash.
export function videoProfile(config: ProviderConfig): VideoProviderSpec {
  const model = config.videoModel || config.seedanceModel;
  const veo = VEO_MODELS.has(model);
  if (/^veo/i.test(model) && !veo) throw new Error("Unsupported Veo relay model");
  return {
    provider: veo ? "veo" : "seedance", model,
    baseUrl: config.seedanceBase.replace(/\/+$/, ""),
    protocol: veo ? "veo31-relay-v1" : "seedance-relay-v1",
    referenceMode: "first_frame", nativeAudio: true,
    maxSeconds: veo ? 8 : 12,
    durationPolicy: veo ? "fixed8-1080p" : "ceil-min4",
  };
}

export function sameVideoProfile(a: VideoProviderSpec, b: VideoProviderSpec): boolean {
  return ["provider", "model", "baseUrl", "protocol", "referenceMode", "nativeAudio", "maxSeconds", "durationPolicy"]
    .every(key => a[key as keyof VideoProviderSpec] === b[key as keyof VideoProviderSpec]);
}

export function relayVideoBody(spec: VideoProviderSpec, input: VideoInput, image?: string) {
  if (!Number.isFinite(input.duration) || input.duration <= 0 || input.duration > spec.maxSeconds)
    throw new Error("Requested shot exceeds selected video model duration");
  const aspect = input.width > input.height ? "16:9" : "9:16";
  const duration = spec.provider === "veo" ? 8 : Math.max(4, Math.ceil(input.duration));
  const prompt = spec.provider === "veo" ? input.prompt : `${input.prompt}\n--ratio ${aspect} --duration ${duration}`;
  const body = spec.provider === "veo" ? {
    model: spec.model, prompt, duration, resolution: "1080p", aspect_ratio: aspect,
    generate_audio: true,
    // pad is the upstream enum verified by this relay's successful prior receipts.
    metadata: { personGeneration: "allow_adult", resizeMode: "pad" },
    ...(image ? { image } : {}),
  } : {
    model: spec.model, prompt, metadata: { generate_audio: true, return_last_frame: true },
    ...(image ? { image } : {}),
  };
  return { body, prompt, duration, aspect };
}
