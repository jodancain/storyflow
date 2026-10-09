import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, readFile, rename } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  composeMedia,
  probe,
  extractAudio,
  extractFrame,
  renderGraphic,
} from "../server/media.js";
import { overlaySvg, validateGraphics } from "../server/render-overlay.js";
import type { Ontology } from "../shared/types.js";
const exec = promisify(execFile),
  ffmpeg = process.env.FFMPEG_PATH || process.env.FFMPEG || "ffmpeg";
const project = (fps: 24 | 25 = 25, seconds = 60): Ontology => ({
  schemaVersion: 1,
  title: "Deterministic media fixture",
  spec: { fps, width: 160, height: 96, totalFrames: seconds * fps },
  entities: [],
  relations: [],
  assets: [],
  anchors: [],
  evidence: [],
  shots: [
    {
      id: "s1",
      title: "Fixture",
      startFrame: 0,
      endFrame: seconds * fps,
      entityIds: [],
      requiredAssetIds: [],
      evidenceIds: [],
      action: "",
      startState: "",
      endState: "",
      scale: "",
      camera: "",
      dialogue: [],
      subtitles: [],
      dependencies: [],
      route: "seedance",
      prompt: "",
      mustShow: [],
      rejectIf: [],
    },
  ],
});
async function fixture(dir: string, duration: number, fps = 24, solid = false) {
  const path = join(dir, "source.mp4");
  await exec(
    ffmpeg,
    [
      "-v",
      "error",
      "-y",
      "-f",
      "lavfi",
      "-i",
      `${solid ? "color=c=0x102030" : "testsrc2"}:s=160x96:r=${fps}:d=${duration}`.replace(
        "testsrc2:",
        "testsrc2=",
      ),
      "-f",
      "lavfi",
      "-i",
      `sine=frequency=440:sample_rate=48000:duration=${duration}`,
      "-c:v",
      "libx264",
      "-preset",
      "ultrafast",
      "-pix_fmt",
      "yuv420p",
      "-c:a",
      "aac",
      "-t",
      String(duration),
      path,
    ],
    { maxBuffer: 2e6 },
  );
  return path;
}

for (const fps of [24, 25] as const)
  test(
    `real exact 60 second composition at ${fps}fps with audio and durable recovery`,
    { timeout: 120000 },
    async () => {
      const dir = await mkdtemp(join(tmpdir(), "storyflow-media-"));
      try {
        const source = await fixture(dir, 61, 24),
          content = join(dir, "content-addressed-no-extension");
        await rename(source, content);
        const ontology = project(fps),
          output = join(dir, "final.mp4"),
          options = {
            clips: [
              {
                path: content,
                startFrame: 0,
                endFrame: fps * 60,
                sourceInSeconds: 0.4,
              },
            ],
            ontology,
            output,
            workDir: join(dir, "work"),
          };
        const result = await composeMedia(options),
          media = await probe(output);
        assert.equal(media.video.frames, fps * 60);
        assert.equal(media.video.fps, fps);
        assert.equal(media.video.duration, "60.000000");
        assert.ok(media.audio);
        assert.equal(result.audioBindings[0].speed, 1);
        assert.equal(result.checks.fullDecode, true);
        const recovered = await composeMedia(options);
        assert.equal(recovered.recovered, true);
        assert.equal(recovered.sha256, result.sha256);
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    },
  );

test(
  "real 1080x1920 60 second vertical composition has exactly 1500 frames, Chinese overlay and synchronized audio",
  { timeout: 600000 },
  async (t) => {
    const started = performance.now(),
      dir = await mkdtemp(join(tmpdir(), "storyflow-vertical-"));
    try {
      const source = join(dir, "source.mp4");
      await exec(
        ffmpeg,
        [
          "-v",
          "error",
          "-y",
          "-f",
          "lavfi",
          "-i",
          "color=c=0x102030:s=1080x1920:r=25:d=60",
          "-f",
          "lavfi",
          "-i",
          "sine=frequency=440:sample_rate=48000:duration=60",
          "-c:v",
          "libx264",
          "-preset",
          "ultrafast",
          "-pix_fmt",
          "yuv420p",
          "-c:a",
          "aac",
          "-t",
          "60",
          source,
        ],
        { maxBuffer: 2e6, timeout: 180000 },
      );
      const sourceReady = performance.now(),
        ontology = project(25, 60);
      ontology.spec.width = 1080;
      ontology.spec.height = 1920;
      ontology.shots[0].subtitles = [
        {
          id: "vertical-caption",
          startFrame: 0,
          endFrame: 1500,
          text: "医学科普：识别症状，及时就医",
        },
      ];
      ontology.postProgram = {
        version: 1,
        elements: [
          {
            type: "rect",
            x: 80,
            y: 160,
            w: 140,
            h: 80,
            color: "#ff4400",
            startFrame: 0,
            endFrame: 1500,
          },
          {
            type: "text",
            x: 250,
            y: 220,
            size: 44,
            color: "#ffffff",
            text: "一分钟健康故事",
            startFrame: 0,
            endFrame: 1500,
          },
        ],
      };
      const result = await composeMedia({
        clips: [
          { path: source, startFrame: 0, endFrame: 1500, sourceInSeconds: 0 },
        ],
        ontology,
        output: join(dir, "final.mp4"),
        workDir: join(dir, "work"),
      });
      const composed = performance.now(),
        media = await probe(result.path);
      assert.equal(media.video.width, 1080);
      assert.equal(media.video.height, 1920);
      assert.equal(media.video.frames, 1500);
      assert.equal(media.video.fps, 25);
      assert.equal(Number(media.video.duration), 60);
      assert.ok(media.audio);
      assert.equal(media.audio.codec_name, "aac");
      assert.ok(Math.abs(Number(media.audio.duration) - 60) <= 1 / 25);
      assert.ok(result.checks.audioVideoStartDelta <= 1 / 25);
      assert.equal(result.checks.fullDecode, true);
      assert.equal(
        result.uniqueOverlayFrames,
        1,
        "The fixed overlay must use one actual PNG render, linked for all 1500 frame positions",
      );
      assert.equal(
        result.subtitles[0].text,
        ontology.shots[0].subtitles[0].text,
      );
      assert.equal(result.audioBindings[0].silence, false);
      const graphic = await exec(
        ffmpeg,
        [
          "-v",
          "error",
          "-i",
          result.path,
          "-ss",
          "30",
          "-vf",
          "format=rgb24,crop=1:1:100:180",
          "-frames:v",
          "1",
          "-f",
          "rawvideo",
          "-",
        ],
        { encoding: "buffer", maxBuffer: 10000 },
      );
      assert.ok(
        graphic.stdout[0] > 200 &&
          graphic.stdout[1] < 100 &&
          graphic.stdout[2] < 30,
        "Full-resolution output must contain the actual graphic",
      );
      const caption = await exec(
        ffmpeg,
        [
          "-v",
          "error",
          "-i",
          result.path,
          "-vf",
          "format=rgb24,crop=1080:120:0:1640",
          "-frames:v",
          "1",
          "-f",
          "rawvideo",
          "-",
        ],
        { encoding: "buffer", maxBuffer: 500000 },
      );
      let white = 0;
      for (let i = 0; i < caption.stdout.length; i += 3)
        if (
          caption.stdout[i] > 190 &&
          caption.stdout[i + 1] > 190 &&
          caption.stdout[i + 2] > 190
        )
          white++;
      assert.ok(
        white > 500,
        "Full-resolution output must contain the visible Chinese caption",
      );
      t.diagnostic(
        JSON.stringify({
          sourceSeconds: +((sourceReady - started) / 1000).toFixed(2),
          composeSeconds: +((composed - sourceReady) / 1000).toFixed(2),
          totalSeconds: +((performance.now() - started) / 1000).toFixed(2),
          frames: media.video.frames,
          audioDuration: Number(media.audio.duration),
          audioVideoStartDelta: result.checks.audioVideoStartDelta,
          uniqueOverlayFrames: result.uniqueOverlayFrames,
        }),
      );
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  },
);

test("short source, source audio and coverage gaps fail instead of padding video", async () => {
  const dir = await mkdtemp(join(tmpdir(), "storyflow-short-"));
  try {
    const source = await fixture(dir, 1);
    const ontology = project(25, 2);
    await assert.rejects(
      () =>
        composeMedia({
          clips: [
            { path: source, startFrame: 0, endFrame: 50, sourceInSeconds: 0 },
          ],
          ontology,
          output: join(dir, "no.mp4"),
          workDir: dir,
        }),
      /too short/,
    );
    await assert.rejects(
      () =>
        composeMedia({
          clips: [
            { path: source, startFrame: 1, endFrame: 25, sourceInSeconds: 0 },
          ],
          ontology,
          output: join(dir, "no.mp4"),
          workDir: dir,
        }),
      /gap or overlap/,
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test(
  "multiple clips share one final audio/frame clock without AAC priming drift",
  { timeout: 120000 },
  async () => {
    const dir = await mkdtemp(join(tmpdir(), "storyflow-multi-"));
    try {
      const source = await fixture(dir, 3),
        ontology = project(25, 5);
      const clips = Array.from({ length: 5 }, (_, i) => ({
        path: source,
        startFrame: i * 25,
        endFrame: (i + 1) * 25,
        sourceInSeconds: 0.4,
      }));
      const result = await composeMedia({
        clips,
        ontology,
        output: join(dir, "final.mp4"),
        workDir: dir,
      });
      assert.equal(result.totalFrames, 125);
      assert.ok(result.checks.audioVideoStartDelta <= 0.04);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  },
);

test(
  "native audio extraction, explicit voice binding and real transparent subtitle/graphic render",
  { timeout: 120000 },
  async () => {
    const dir = await mkdtemp(join(tmpdir(), "storyflow-overlay-"));
    try {
      const source = await fixture(dir, 3, 24, true),
        voice = join(dir, "native.wav"),
        frame = join(dir, "frame.png"),
        evidence = await extractAudio(source, voice);
      await extractFrame(source, frame, 0.5);
      assert.ok((await readFile(frame)).length > 100);
      assert.equal(evidence.source, "native-model-audio");
      assert.equal(evidence.speed, 1);
      const ontology = project(25, 2);
      ontology.shots[0].subtitles = [
        { id: "c1", startFrame: 0, endFrame: 25, text: "审核字幕" },
        { id: "c2", startFrame: 25, endFrame: 50, text: "Native voice" },
      ];
      ontology.postProgram = {
        version: 1,
        elements: [
          {
            type: "rect",
            x: 5,
            y: 5,
            w: 30,
            h: 15,
            color: "#ff0000",
            startFrame: 0,
            endFrame: 50,
          },
          {
            type: "circle",
            x: 80,
            y: 25,
            w: 20,
            h: 20,
            color: "#00ff00",
            startFrame: 25,
            endFrame: 50,
          },
        ],
      };
      const final = await composeMedia({
        clips: [
          {
            path: source,
            startFrame: 0,
            endFrame: 50,
            sourceInSeconds: 0,
            audioPath: voice,
          },
        ],
        ontology,
        output: join(dir, "final.mp4"),
        workDir: join(dir, "work"),
      });
      assert.equal(final.totalFrames, 50);
      assert.equal(final.uniqueOverlayFrames, 2);
      assert.equal(final.subtitles[0].text, "审核字幕");
      assert.equal(final.audioBindings[0].sourceAudioHash, evidence.sha256);
      const pixel = await exec(
        ffmpeg,
        [
          "-v",
          "error",
          "-i",
          final.path,
          "-vf",
          "format=rgb24,crop=1:1:10:10",
          "-frames:v",
          "1",
          "-f",
          "rawvideo",
          "-",
        ],
        { encoding: "buffer", maxBuffer: 100000 },
      );
      assert.ok(
        pixel.stdout[0] > 200 && pixel.stdout[1] < 40 && pixel.stdout[2] < 40,
        "declarative red rectangle must be visible in actual output",
      );
      const caption = await exec(
        ffmpeg,
        [
          "-v",
          "error",
          "-i",
          final.path,
          "-vf",
          "format=rgb24,crop=160:30:0:66",
          "-frames:v",
          "1",
          "-f",
          "rawvideo",
          "-",
        ],
        { encoding: "buffer", maxBuffer: 100000 },
      );
      let white = 0;
      for (let i = 0; i < caption.stdout.length; i += 3)
        if (
          caption.stdout[i] > 190 &&
          caption.stdout[i + 1] > 190 &&
          caption.stdout[i + 2] > 190
        )
          white++;
      assert.ok(
        white > 30,
        "Actual encoded lower frame must contain the rendered white subtitle",
      );
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  },
);

test("typed graphics reject executable attributes and absolute seek is deterministic", () => {
  const ontology = project(25, 2);
  ontology.postProgram = {
    version: 1,
    elements: [
      {
        type: "text",
        x: 1,
        y: 24,
        color: "#123456",
        size: 12,
        text: "<script>never executed</script>",
        startFrame: 0,
        endFrame: 50,
        fadeFrames: 2,
      },
    ],
  };
  validateGraphics(ontology);
  const middle = overlaySvg(ontology, 24);
  overlaySvg(ontology, 49);
  overlaySvg(ontology, 0);
  assert.equal(overlaySvg(ontology, 24), middle);
  assert.ok(middle.includes("&lt;script&gt;"));
  assert.ok(!middle.includes("<script>"));
  (ontology.postProgram.elements[0] as any).onclick = "alert(1)";
  assert.throws(() => validateGraphics(ontology), /Unknown graphic/);
});

test(
  "graphic route uses real elements and global time; empty program fails",
  { timeout: 120000 },
  async () => {
    const dir = await mkdtemp(join(tmpdir(), "storyflow-graphic-"));
    try {
      const ontology = project(25, 2);
      ontology.shots[0].route = "graphic";
      ontology.shots[0].startFrame = 25;
      await assert.rejects(
        () =>
          renderGraphic({
            ontology,
            shotId: "s1",
            output: join(dir, "empty.mp4"),
            workDir: dir,
          }),
        /no declarative elements/,
      );
      ontology.postProgram = {
        version: 1,
        elements: [
          {
            type: "circle",
            x: 80,
            y: 48,
            w: 40,
            h: 40,
            color: "#005588",
            startFrame: 25,
            endFrame: 50,
          },
        ],
      };
      const result = await renderGraphic({
        ontology,
        shotId: "s1",
        output: join(dir, "graphic.mp4"),
        workDir: dir,
      });
      assert.equal(result.totalFrames, 25);
      assert.equal(result.source, "declarative-post-program");
      assert.equal(result.subtitlesBaked, false);
      assert.equal(result.probe.video.frames, 25);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  },
);
