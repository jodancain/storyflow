/** Real production composeMedia acceptance with synthetic, credential-free media. */
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { composeMedia, probe } from "../../server/media.ts";
import type { Ontology } from "../../shared/types.ts";

const exec = promisify(execFile);
const root = await mkdtemp(join(tmpdir(), "storyflow-qa-media-"));
const ffmpeg = process.env.FFMPEG || "ffmpeg";
try {
  const source = join(root, "synthetic-source.mp4"), output = join(root, "final.mp4");
  await exec(ffmpeg, ["-v", "error", "-nostdin", "-y", "-f", "lavfi", "-i",
    "color=c=0x24405c:s=160x288:r=25:d=61", "-f", "lavfi", "-i",
    "sine=frequency=440:sample_rate=48000:duration=61", "-c:v", "libx264", "-preset", "ultrafast",
    "-pix_fmt", "yuv420p", "-c:a", "aac", "-t", "61", "-movflags", "+faststart", source],
  { timeout: 120000, maxBuffer: 1024 * 1024 });
  const ontology: Ontology = {
    schemaVersion: 1, title: "Synthetic Docker production-media fixture",
    spec: { fps: 25, width: 1080, height: 1920, totalFrames: 1500 },
    entities: [], relations: [], assets: [], anchors: [], evidence: [], shots: [],
  };
  const clips = Array.from({ length: 5 }, (_, index) => ({
    path: source, startFrame: index * 300, endFrame: (index + 1) * 300,
    sourceInSeconds: index * 12, muted: false,
  }));
  const options = { clips, ontology, output, workDir: root };
  const started = performance.now();
  const rendered = await composeMedia(options);
  const info = await probe(output);
  assert.equal(info.video.codec_name, "h264");
  assert.equal(info.audio.codec_name, "aac");
  assert.equal(info.duration, 60);
  assert.equal(info.video.frames, 1500);
  assert.equal(info.video.fps, 25);
  assert.equal(info.video.width, 1080);
  assert.equal(info.video.height, 1920);
  assert(Math.abs(Number(info.video.start_time) - Number(info.audio.start_time)) <= 1 / 25);
  assert(Math.abs(Number(info.audio.duration) - 60) <= 1 / 25);
  // Independent full decode, in addition to composeMedia's own final check.
  await exec(ffmpeg, ["-v", "error", "-nostdin", "-i", output,
    "-map", "0:v:0", "-map", "0:a:0", "-f", "null", "-"], { timeout: 180000, maxBuffer: 1024 * 1024 });
  const bytes = await readFile(output);
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  const recovered = await composeMedia(options);
  assert.equal(recovered.recovered, true);
  assert.equal(recovered.sha256, sha256);
  // This is deliberately too short for a 60-second sequence: no loop/freeze or
  // retime may silently fill the missing second.
  await assert.rejects(composeMedia({ ...options, output: join(root, "invalid.mp4"),
    clips: [{ path: source, startFrame: 0, endFrame: 1500, sourceInSeconds: 2, muted: false }] }), /too short/);
  console.log(JSON.stringify({ status: "passed", synthetic: true, pipeline: "composeMedia",
    width: info.video.width, height: info.video.height, fps: info.video.fps, frames: info.video.frames,
    seconds: info.duration, videoCodec: info.video.codec_name, audioCodec: info.audio.codec_name,
    sampleRate: info.audio.sample_rate, independentFullDecode: true, recoveredWithoutRerender: true,
    insufficientSourceRejected: true, inputHash: rendered.inputHash, sha256, bytes: bytes.length,
    elapsedSeconds: (performance.now() - started) / 1000 }));
} finally {
  await rm(root, { recursive: true, force: true });
}
