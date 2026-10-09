import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { Providers, ProviderError } from "../server/providers.js";
import type {
  ProviderConfig,
  VideoInput,
  Ontology,
  Requirements,
} from "../shared/types.js";

const config: ProviderConfig = {
  seedanceBase: "https://relay.example/v1",
  seedanceKey: "fixture-relay-key",
  seedanceModel: "dreamina-seedance-2-0",
  falBase: "https://queue.fal.run",
  falKey: "fixture-fal-key",
  opusBase: "https://opus.example",
  opusKey: "fixture-opus-key",
  opusModel: "claude-opus-5-5",
  allowPrivate: true,
};
const sha = (b: Buffer) => createHash("sha256").update(b).digest("hex");
const image = () => {
  const bytes = Buffer.from("fixture image bytes");
  return { bytes, mime: "image/png", id: "portrait", sha256: sha(bytes) };
};
const audio = () => {
  const bytes = Buffer.from("fixture audio bytes");
  return { bytes, mime: "audio/wav", id: "voice", sha256: sha(bytes) };
};
const input: VideoInput = {
  prompt: "One person gives a short clear explanation, exact reviewed speech.",
  duration: 5,
  fps: 25,
  width: 1080,
  height: 1920,
  purpose: "video",
};
const response = (data: any, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json" },
  });
function client(
  handler: (url: string, options: RequestInit) => Promise<Response> | Response,
) {
  return new Providers(config, {
    fetchImpl: (async (url: any, options: any) =>
      handler(String(url), options || {})) as typeof fetch,
  });
}

test("oversized accepted submission response is uncertain, never safe to repost", async () => {
  const p = client(
    () =>
      new Response("{}", {
        headers: { "content-length": String(9 * 1024 * 1024) },
      }),
  );
  await assert.rejects(
    () => p.submit(input, async () => {}),
    (error: any) => error instanceof ProviderError && error.uncertain === true,
  );
});

test("Seedance snapshots actual first-frame request before one POST; end frame is explicitly ignored", async () => {
  let prepared: any,
    calls = 0;
  const provider = client((url, options) => {
    calls++;
    assert.ok(prepared);
    assert.equal(url, config.seedanceBase + "/video/generations");
    assert.equal(options.method, "POST");
    const body = JSON.parse(String(options.body));
    assert.equal(body.metadata.generate_audio, true);
    assert.ok(body.image.startsWith("data:image/png;base64,"));
    assert.ok(!("last_frame" in body));
    assert.equal(sha(Buffer.from(String(options.body))), prepared.requestHash);
    return response({ task_id: "task-1" });
  });
  const handle = await provider.submit(
    { ...input, firstImage: image(), endImage: { id: "end", sha256: "hash" } },
    async (value) => {
      prepared = value;
    },
  );
  assert.equal(calls, 1);
  assert.equal(handle.id, "task-1");
  assert.equal(prepared.ignoredReferences[0].reason, "relay_first_frame_only");
  assert.equal(prepared.references[0].id, "portrait");
  assert.ok(!JSON.stringify(handle).includes(config.seedanceKey));
});

test("text-only requests omit image, honor 4s minimum, and never post after persistence failure", async () => {
  let calls = 0;
  const p = client((_url, options) => {
    calls++;
    const body = JSON.parse(String(options.body));
    assert.equal(body.image, undefined);
    assert.match(body.prompt, /--duration 4$/);
    return response({ task_id: "task-2" });
  });
  await assert.rejects(
    () =>
      p.submit(input, async () => {
        throw new Error("disk full");
      }),
    /disk full/,
  );
  assert.equal(calls, 0);
  await p.submit({ ...input, duration: 2 }, async () => {});
  assert.equal(calls, 1);
  await assert.rejects(
    () => p.submit({ ...input, duration: 13 }, async () => {}),
    /12 seconds/,
  );
  assert.equal(calls, 1);
});

test("unknown acceptance never retries and does not leak provider response or keys", async () => {
  let calls = 0;
  const p = client(() => {
    calls++;
    throw new Error("connection secret " + config.seedanceKey);
  });
  await assert.rejects(
    () => p.submit(input, async () => {}),
    (e: any) =>
      e instanceof ProviderError &&
      e.uncertain &&
      !e.message.includes(config.seedanceKey),
  );
  assert.equal(calls, 1);
  const denied = client(() =>
    response({ error: { message: "secret " + config.seedanceKey } }, 400),
  );
  await assert.rejects(
    () => denied.submit(input, async () => {}),
    (e: any) => !e.uncertain && e.message === "Provider HTTP 400",
  );
  const malformed = client(() => response({ accepted: true }));
  await assert.rejects(
    () => malformed.submit(input, async () => {}),
    (e: any) => e.uncertain && e.code === "missing_provider_id",
  );
});

test("fal binds approved audio and image; submit, status and result use one accepted ID", async () => {
  const urls: string[] = [],
    id = "fal-1";
  const p = client((url, options) => {
    urls.push(url);
    if (options.method === "POST") {
      const body = JSON.parse(String(options.body));
      assert.equal(body.resolution, "1080p");
      assert.ok(body.audio_url.startsWith("data:audio/wav;"));
      assert.equal(new Headers(options.headers).get("x-fal-no-retry"), "1");
      return response({
        request_id: id,
        status_url: `${config.falBase}/fal-ai/bytedance/omnihuman/requests/${id}/status`,
        response_url: `${config.falBase}/fal-ai/bytedance/omnihuman/requests/${id}`,
      });
    }
    if (url.endsWith("/status"))
      return response({ request_id: id, status: "COMPLETED" });
    return response({
      video: { url: "https://cdn.example/result.mp4" },
      duration: 5,
    });
  });
  const handle = await p.submit(
    { ...input, purpose: "lipsync", firstImage: image(), audio: audio() },
    async () => {},
  );
  const result = await p.poll(handle);
  assert.equal(result.state, "complete");
  assert.equal(result.metadata.audioBinding.sha256, audio().sha256);
  assert.equal(urls.length, 3);
  assert.equal(handle.receipt.model, "fal-ai/bytedance/omnihuman/v1.5");
});

test("fal refuses changed media hashes, other-task URLs and actual failed jobs", async () => {
  let calls = 0;
  const p = client(() => {
    calls++;
    return response({
      request_id: "fal-2",
      status_url: `${config.falBase}/fal-ai/bytedance/omnihuman/requests/not-this-task/status`,
    });
  });
  await assert.rejects(
    () =>
      p.submit(
        {
          ...input,
          purpose: "lipsync",
          firstImage: image(),
          audio: { ...audio(), sha256: "changed" },
        },
        async () => {},
      ),
    /hash changed/,
  );
  assert.equal(calls, 0);
  const accepted = await p.submit(
    { ...input, purpose: "lipsync", firstImage: image(), audio: audio() },
    async () => {},
  );
  assert.equal(accepted.id, "fal-2");
  assert.equal(accepted.receipt.statusUrl, undefined);
  assert.equal(accepted.receipt.ignoredResponseUrl, true);
  assert.equal(calls, 1);
  const failed = client(() =>
    response({
      status: "COMPLETED",
      error: "Provider text may include secrets",
    }),
  );
  assert.equal(
    (
      await failed.poll({
        provider: "fal",
        id: "fal-2",
        baseUrl: config.falBase,
        model: "fal-ai/bytedance/omnihuman/v1.5",
        requestHash: "x",
        receipt: {},
      })
    ).state,
    "failed",
  );
});

test("download follows redirect without leaking auth, requires MP4 and rejects changed provider", async () => {
  const seen: any[] = [],
    mp4 = Buffer.concat([
      Buffer.from([0, 0, 0, 24]),
      Buffer.from("ftypisom"),
      Buffer.alloc(20),
    ]);
  const p = client((url, opts) => {
    seen.push({
      url,
      authorization: new Headers(opts.headers).get("authorization"),
    });
    if (seen.length === 1)
      return new Response(null, {
        status: 302,
        headers: { location: "https://cdn.example/file.mp4" },
      });
    return new Response(mp4, { headers: { "content-type": "video/mp4" } });
  });
  const handle = {
    provider: "seedance" as const,
    id: "task-3",
    baseUrl: config.seedanceBase,
    model: config.seedanceModel,
    requestHash: "x",
    receipt: {},
  };
  const downloaded = await p.download(
    { state: "complete", url: "https://relay.example/media/file.mp4" },
    handle,
  );
  assert.equal(downloaded.bytes.toString("hex"), mp4.toString("hex"));
  assert.equal(seen[0].authorization, "Bearer " + config.seedanceKey);
  assert.equal(seen[1].authorization, null);
  await assert.rejects(
    () =>
      p.download(
        { state: "complete", url: "https://cdn.example/file.mp4" },
        { ...handle, baseUrl: "https://another.example" },
      ),
    /Restore/,
  );
});

test("production URL guard blocks loopback even before invoking injected fetch", async () => {
  let called = false;
  const p = new Providers(
    { ...config, seedanceBase: "http://127.0.0.1:9999", allowPrivate: false },
    {
      fetchImpl: async () => {
        called = true;
        return response({});
      },
    },
  );
  await assert.rejects(() => p.submit(input, async () => {}), /Unsafe/);
  assert.equal(called, false);
});

test("operator reconciliation restores frozen identity but cannot supply a URL or new origin", () => {
  const p = client(() => {
    throw new Error("reconciliation must not call network");
  });
  const receipt = {
    provider: "fal",
    baseUrl: config.falBase,
    model: "fal-ai/bytedance/omnihuman/v1.5",
    requestHash: "a".repeat(64),
    audio: { sha256: "approved" },
  };
  const handle = p.recoverHandle(receipt, "confirmed-task-1");
  assert.equal(handle.receipt.audio, receipt.audio);
  assert.equal(handle.id, "confirmed-task-1");
  assert.throws(
    () => p.recoverHandle(receipt, "https://attacker.test"),
    /Invalid provider task/,
  );
  assert.throws(
    () =>
      p.recoverHandle({ ...receipt, baseUrl: "https://attacker.test" }, "task"),
    /Restore/,
  );
});

const requirements: Requirements = {
  topic: "Educational story",
  audience: "general",
  duration: 60,
  aspect: "9:16",
  fps: 25,
  style: "bright",
  doctorMode: "fictional",
  sound: "native",
  brief: "",
};
const ontology = {
  schemaVersion: 1,
  title: "Story",
  spec: { fps: 25, width: 1080, height: 1920, totalFrames: 1500 },
  entities: [],
  relations: [],
  assets: [],
  anchors: [],
  evidence: [],
  shots: [],
} as Ontology;
function sse(text: string, complete = true) {
  return new Response(
    `event: message_start\ndata: ${JSON.stringify({ type: "message_start", message: { model: config.opusModel } })}\n\nevent: content_block_delta\ndata: ${JSON.stringify({ type: "content_block_delta", delta: { type: "text_delta", text } })}\n\nevent: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn"}}\n\n${complete ? 'event: message_stop\ndata: {"type":"message_stop"}\n\n' : ""}`,
    { headers: { "content-type": "text/event-stream" } },
  );
}

test("Opus uses native Anthropic adaptive streaming with prepared callback and structured output", async () => {
  let durable = false;
  const p = client((url, opts) => {
    assert.equal(durable, true);
    assert.equal(url, "https://opus.example/v1/messages");
    const headers = new Headers(opts.headers);
    assert.equal(headers.get("x-api-key"), config.opusKey);
    assert.equal(headers.get("authorization"), null);
    const body = JSON.parse(String(opts.body));
    assert.deepEqual(body.thinking, { type: "adaptive" });
    assert.equal(body.stream, true);
    assert.equal(body.messages[0].role, "user");
    return sse(JSON.stringify(ontology));
  });
  assert.deepEqual(
    await p.expand(requirements, { documents: [] }, ontology, async () => {
      durable = true;
    }),
    ontology,
  );
});

test("Opus incomplete stream is uncertain; invalid or truncated program is not auto-repaired", async () => {
  let calls = 0;
  const interrupted = client(() => {
    calls++;
    return sse("{}", false);
  });
  await assert.rejects(
    () => interrupted.planPost(ontology, {}),
    (e: any) => e.uncertain,
  );
  assert.equal(calls, 1);
  const bad = client(() => sse("not json"));
  await assert.rejects(
    () => bad.planPost(ontology, {}),
    (e: any) => !e.uncertain && e.code === "invalid_model_output",
  );
  const changed = client(() =>
    sse(JSON.stringify({ ...ontology, spec: { ...ontology.spec, fps: 24 } })),
  );
  await assert.rejects(
    () => changed.expand(requirements, {}, ontology),
    /frame rate/,
  );
});
