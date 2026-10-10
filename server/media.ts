import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import {
  mkdir,
  readFile,
  writeFile,
  rename,
  stat,
  access,
  rm,
} from "node:fs/promises";
import { join, dirname, resolve } from "node:path";
import type { MediaClip, Ontology } from "../shared/types.js";
import { renderOverlay, validateGraphics } from "./render-overlay.js";

function requireValue(value: unknown, message: string): asserts value {
  if (!value) throw new Error(message);
}
const ffmpeg = () => process.env.FFMPEG_PATH || process.env.FFMPEG || "ffmpeg";
const ffprobe = () =>
  process.env.FFPROBE_PATH || process.env.FFPROBE || "ffprobe";
const digest = (v: string) => createHash("sha256").update(v).digest("hex");
async function fileHash(path: string) {
  const hash = createHash("sha256");
  for await (const bytes of createReadStream(path)) hash.update(bytes);
  return hash.digest("hex");
}
async function exists(path: string) {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}
async function run(
  bin: string,
  args: string[],
  timeout = 30 * 60 * 1000,
): Promise<string> {
  return new Promise((accept, reject) => {
    const child = spawn(bin, args, {
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    let stdout = "",
      stderr = "",
      timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, timeout);
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
      if (stdout.length > 16 * 1024 * 1024) {
        child.kill("SIGKILL");
        reject(new Error("Media command output exceeded limit"));
      }
    });
    child.stderr.on("data", (chunk) => {
      stderr = (stderr + chunk).slice(-12000);
    });
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(new Error(`Media executable unavailable: ${error.message}`));
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code !== 0)
        reject(
          new Error(
            timedOut
              ? "Media command timed out"
              : `Media command failed (${code}): ${stderr.slice(-3000)}`,
          ),
        );
      else accept(stdout);
    });
  });
}
const rate = (text: any) => {
  const [n, d = 1] = String(text).split("/").map(Number);
  return n / d;
};
export async function probe(path: string) {
  const raw = JSON.parse(
    await run(
      ffprobe(),
      [
        "-v",
        "error",
        "-count_frames",
        "-show_streams",
        "-show_format",
        "-of",
        "json",
        path,
      ],
      120000,
    ),
  );
  if (raw.format) delete raw.format.filename;
  const video = raw.streams?.find((s: any) => s.codec_type === "video"),
    audio = raw.streams?.find((s: any) => s.codec_type === "audio");
  return {
    ...raw,
    duration: Number(
      raw.format?.duration || video?.duration || audio?.duration || 0,
    ),
    video: video
      ? {
          ...video,
          fps: rate(video.avg_frame_rate || video.r_frame_rate),
          frames: Number(video.nb_read_frames || video.nb_frames || 0),
        }
      : undefined,
    audio,
  };
}
export async function extractAudio(input: string, output: string) {
  const source = await probe(input);
  requireValue(source.audio, "Source has no native audio track");
  await mkdir(dirname(output), { recursive: true });
  const temp = join(dirname(output), `.${randomUUID()}.wav`);
  try {
    await run(ffmpeg(), [
      "-v",
      "error",
      "-nostdin",
      "-y",
      "-i",
      input,
      "-map",
      "0:a:0",
      "-vn",
      "-ac",
      "1",
      "-ar",
      "48000",
      "-c:a",
      "pcm_s16le",
      temp,
    ]);
    await rename(temp, output);
  } catch (e) {
    await rm(temp, { force: true });
    throw e;
  }
  return {
    path: output,
    sha256: await fileHash(output),
    duration: (await probe(output)).duration,
    sourceHash: await fileHash(input),
    source: "native-model-audio",
    speed: 1,
  };
}
export async function extractFrame(
  input: string,
  output: string,
  seconds: number,
) {
  requireValue(Number.isFinite(seconds) && seconds >= 0, "Invalid frame time");
  const media = await probe(input);
  requireValue(
    media.video && seconds < media.duration,
    "Requested frame is outside video",
  );
  await mkdir(dirname(output), { recursive: true });
  const temp = join(dirname(output), `.${randomUUID()}.png`);
  try {
    await run(ffmpeg(), [
      "-v",
      "error",
      "-nostdin",
      "-y",
      "-i",
      input,
      "-ss",
      String(seconds),
      "-frames:v",
      "1",
      temp,
    ]);
    await rename(temp, output);
  } catch (e) {
    await rm(temp, { force: true });
    throw e;
  }
  return {
    path: output,
    sha256: await fileHash(output),
    seconds,
    sourceHash: await fileHash(input),
  };
}
/** Graphics are actual local renders, never labelled as model-generated footage. */
export async function renderGraphic({
  ontology,
  shotId,
  output,
  workDir,
}: {
  ontology: Ontology;
  shotId: string;
  output: string;
  workDir: string;
}) {
  const shot = ontology.shots.find((s) => s.id === shotId);
  requireValue(shot && shot.route === "graphic", "Graphic shot does not exist");
  const visible = (ontology.postProgram?.elements || []).filter(
    (e) => e.startFrame < shot.endFrame && e.endFrame > shot.startFrame,
  );
  requireValue(
    visible.length > 0,
    "Graphic shot has no declarative elements; a blank clip is not a successful render",
  );
  const frames = shot.endFrame - shot.startFrame,
    { fps, width, height } = ontology.spec;
  const source: Ontology = {
    ...ontology,
    shots: ontology.shots.map((s) => ({ ...s, subtitles: [] })),
  };
  const sourceHash = digest(
    JSON.stringify({
      spec: ontology.spec,
      shotId,
      startFrame: shot.startFrame,
      endFrame: shot.endFrame,
      elements: visible,
    }),
  );
  const directory = join(resolve(workDir), "graphics", sourceHash);
  await mkdir(directory, { recursive: true });
  await mkdir(dirname(output), { recursive: true });
  const overlays = await renderOverlay(source, join(directory, "overlays"), {
    startFrame: shot.startFrame,
    endFrame: shot.endFrame,
  });
  const staged = join(dirname(output), `.graphic-${randomUUID()}.mp4`),
    duration = frames / fps;
  try {
    await run(ffmpeg(), [
      "-v",
      "error",
      "-nostdin",
      "-y",
      "-f",
      "lavfi",
      "-i",
      `color=c=0xf1f5f9:s=${width}x${height}:r=${fps}:d=${duration}`,
      "-framerate",
      String(fps),
      "-start_number",
      String(shot.startFrame),
      "-i",
      join(overlays.directory, "%06d.png"),
      "-f",
      "lavfi",
      "-i",
      "anullsrc=r=48000:cl=stereo",
      "-filter_complex",
      "[0:v][1:v]overlay=0:0:shortest=1:format=auto,format=yuv420p[v]",
      "-map",
      "[v]",
      "-map",
      "2:a:0",
      "-t",
      String(duration),
      "-frames:v",
      String(frames),
      "-c:v",
      "libx264",
      "-preset",
      "veryfast",
      "-crf",
      "18",
      "-c:a",
      "aac",
      "-b:a",
      "192k",
      "-movflags",
      "+faststart",
      staged,
    ]);
    const media = await finalCheck(staged, {
      ...ontology,
      spec: { ...ontology.spec, totalFrames: frames },
    });
    await rename(staged, output);
    return {
      path: output,
      source: "declarative-post-program",
      sourceHash,
      sha256: await fileHash(output),
      duration,
      totalFrames: frames,
      fps,
      width,
      height,
      uniqueOverlayFrames: overlays.uniqueFrames,
      subtitlesBaked: false,
      probe: media,
    };
  } catch (error) {
    await rm(staged, { force: true });
    throw error;
  }
}
async function finalCheck(path: string, ontology: Ontology) {
  const p = await probe(path),
    s = ontology.spec;
  requireValue(
    p.video &&
      p.video.width === s.width &&
      p.video.height === s.height &&
      p.video.fps === s.fps &&
      p.video.frames === s.totalFrames,
    `Encoded video does not match requested spec: ${JSON.stringify({ expected: s, actual: p.video ? { width: p.video.width, height: p.video.height, fps: p.video.fps, frames: p.video.frames, start: p.video.start_time, duration: p.video.duration } : null })}`,
  );
  requireValue(p.audio, "Final video has no audio track");
  requireValue(
    Math.abs(Number(p.video.duration) - s.totalFrames / s.fps) <= 1 / s.fps,
    "Encoded video duration is incorrect",
  );
  const audioStart = Number(p.audio.start_time || 0),
    videoStart = Number(p.video.start_time || 0);
  requireValue(
    Math.abs(audioStart - videoStart) <= 1 / s.fps,
    "Encoded audio/video start differs by more than one frame",
  );
  requireValue(
    Number(p.audio.duration) >= s.totalFrames / s.fps - 1 / s.fps &&
      Number(p.audio.duration) <= s.totalFrames / s.fps + 1 / s.fps,
    "Encoded audio duration differs by more than one frame",
  );
  await run(ffmpeg(), [
    "-v",
    "error",
    "-nostdin",
    "-i",
    path,
    "-map",
    "0:v:0",
    "-map",
    "0:a:0",
    "-f",
    "null",
    "-",
  ]);
  return p;
}

export async function composeMedia({
  clips,
  ontology,
  output,
  workDir,
}: {
  clips: MediaClip[];
  ontology: Ontology;
  output: string;
  workDir: string;
}): Promise<any> {
  const { fps, width, height, totalFrames } = ontology.spec;
  requireValue(
    [24, 25].includes(fps) &&
      Number.isSafeInteger(totalFrames) &&
      totalFrames > 0 &&
      totalFrames <= fps * 60 * 30,
    "Invalid composition frame clock",
  );
  requireValue(
    [width, height].every(
      (v) => Number.isInteger(v) && v >= 64 && v <= 4096 && v % 2 === 0,
    ),
    "Composition dimensions must be even and within 64–4096",
  );
  requireValue(
    Array.isArray(clips) && clips.length > 0 && clips.length <= 300,
    "Composition needs 1–300 clips",
  );
  validateGraphics(ontology);
  const ordered = [...clips].sort((a, b) => a.startFrame - b.startFrame),
    descriptors: any[] = [];
  let cursor = 0;
  for (const [index, clip] of ordered.entries()) {
    requireValue(
      resolve(clip.path) !== resolve(output) &&
        (!clip.audioPath || resolve(clip.audioPath) !== resolve(output)),
      "Output must not overwrite a source asset",
    );
    requireValue(
      [clip.startFrame, clip.endFrame].every(Number.isSafeInteger) &&
        clip.startFrame === cursor &&
        clip.endFrame > clip.startFrame &&
        clip.endFrame <= totalFrames,
      "Video clips must cover the frame clock with no gap or overlap",
    );
    requireValue(
      Number.isFinite(clip.sourceInSeconds) && clip.sourceInSeconds >= 0,
      "Invalid source trim",
    );
    requireValue(
      typeof clip.path === "string" && !/^[a-z]+:\/\//i.test(clip.path),
      "Media path must be local",
    );
    const media = await probe(clip.path),
      duration = (clip.endFrame - clip.startFrame) / fps,
      needed = clip.sourceInSeconds + duration;
    requireValue(media.video, "Clip contains no video");
    const sourceDuration = Number(media.video.duration || media.duration);
    requireValue(
      sourceDuration + 0.001 >= needed,
      `Clip ${index + 1} is too short; missing ${(needed - sourceDuration).toFixed(3)} seconds. No loop, freeze or speed change is allowed.`,
    );
    const audioPath =
      clip.audioPath || (!clip.muted && media.audio ? clip.path : undefined);
    let audio: any;
    if (audioPath) {
      requireValue(
        !/^[a-z]+:\/\//i.test(audioPath),
        "Audio path must be local",
      );
      audio = audioPath === clip.path ? media : await probe(audioPath);
      requireValue(audio.audio, "Bound voice has no audio stream");
      requireValue(
        Number(audio.audio.duration || audio.duration) + 0.025 >= needed,
        `Bound audio for clip ${index + 1} is too short`,
      );
    }
    descriptors.push({
      clip,
      media,
      audioPath,
      videoHash: await fileHash(clip.path),
      audioHash: audioPath ? await fileHash(audioPath) : null,
    });
    cursor = clip.endFrame;
  }
  requireValue(
    cursor === totalFrames,
    "Video sequence does not cover its total frame count",
  );
  const plan = {
    renderer: "storyflow-media-v1",
    spec: ontology.spec,
    clips: descriptors.map(({ clip, videoHash, audioHash }) => ({
      startFrame: clip.startFrame,
      endFrame: clip.endFrame,
      sourceInSeconds: clip.sourceInSeconds,
      muted: !!clip.muted,
      videoHash,
      audioHash,
    })),
    postProgram: ontology.postProgram || null,
    subtitles: ontology.shots.flatMap((s) => s.subtitles || []),
  };
  const inputHash = digest(JSON.stringify(plan)),
    directory = join(resolve(workDir), inputHash),
    receiptPath = join(directory, "receipt.json");
  await mkdir(directory, { recursive: true });
  await mkdir(dirname(output), { recursive: true });
  if (await exists(receiptPath)) {
    const prior = JSON.parse(await readFile(receiptPath, "utf8"));
    if (
      prior.inputHash === inputHash &&
      (await exists(output)) &&
      (await fileHash(output)) === prior.sha256
    ) {
      await finalCheck(output, ontology);
      return { ...prior, path: output, recovered: true };
    }
  }
  await writeFile(
    join(directory, "manifest.json"),
    JSON.stringify(plan, null, 2),
  );
  const segments: string[] = [];
  for (const [i, { clip, audioPath }] of descriptors.entries()) {
    const frames = clip.endFrame - clip.startFrame,
      duration = frames / fps,
      segment = join(directory, `segment-${String(i).padStart(4, "0")}.mp4`);
    segments.push(segment);
    const args = ["-v", "error", "-nostdin", "-y", "-i", clip.path];
    let audioIndex = 0;
    if (audioPath && audioPath !== clip.path) {
      args.push("-i", audioPath);
      audioIndex = 1;
    } else if (!audioPath) {
      args.push("-f", "lavfi", "-i", "anullsrc=r=48000:cl=stereo");
      audioIndex = 1;
    }
    // Sample using the original source timebase first; resetting a trimmed 24 fps clock
    // before conversion to 25 fps can lose a frame at the end of the selected window.
    const sourceStart = Math.round(clip.sourceInSeconds * fps),
      sourceEnd = sourceStart + frames;
    const video = `[0:v:0]fps=${fps},trim=start_frame=${sourceStart}:end_frame=${sourceEnd},setpts=PTS-STARTPTS,scale=${width}:${height}:force_original_aspect_ratio=decrease,pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2:color=black,setsar=1,format=yuv420p[v]`;
    const audioStart = audioPath ? clip.sourceInSeconds : 0;
    const audio = `[${audioIndex}:a:0]atrim=start=${audioStart}:duration=${duration},asetpts=PTS-STARTPTS,aresample=48000,aformat=channel_layouts=stereo,apad=whole_dur=${duration},atrim=duration=${duration}[a]`;
    args.push(
      "-filter_complex",
      video + ";" + audio,
      "-map",
      "[v]",
      "-map",
      "[a]",
      "-frames:v",
      String(frames),
      "-t",
      String(duration),
      "-c:v",
      "libx264",
      "-preset",
      "veryfast",
      "-crf",
      "18",
      "-pix_fmt",
      "yuv420p",
      "-c:a",
      "aac",
      "-b:a",
      "192k",
      "-ar",
      "48000",
      "-ac",
      "2",
      "-video_track_timescale",
      String(fps * 1000),
      "-movflags",
      "+faststart",
      segment,
    );
    await run(ffmpeg(), args);
    const check = await probe(segment);
    requireValue(
      check.video.frames === frames,
      `Clip ${i + 1} produced fewer frames than required`,
    );
  }
  const concat = join(directory, "concat.txt");
  await writeFile(
    concat,
    segments.map((p) => `file '${p.replace(/'/g, "'\\''")}'`).join("\n"),
  );
  const cleanVideo = join(directory, "clean.mp4");
  // Re-encode AAC once after concatenation to align packet priming on one final clock.
  await run(ffmpeg(), [
    "-v",
    "error",
    "-nostdin",
    "-y",
    "-f",
    "concat",
    "-safe",
    "0",
    "-i",
    concat,
    "-map",
    "0:v:0",
    "-map",
    "0:a:0",
    "-c:v",
    "copy",
    "-af",
    `aresample=48000:async=1:first_pts=0,apad=whole_dur=${totalFrames / fps},atrim=duration=${totalFrames / fps}`,
    "-c:a",
    "aac",
    "-b:a",
    "192k",
    "-frames:v",
    String(totalFrames),
    "-t",
    String(totalFrames / fps),
    "-movflags",
    "+faststart",
    cleanVideo,
  ]);
  const hasOverlay =
    (ontology.postProgram?.elements.length || 0) > 0 ||
    plan.subtitles.length > 0;
  const staged = join(dirname(output), `.storyflow-${randomUUID()}.mp4`);
  let uniqueOverlayFrames = 0;
  try {
    if (hasOverlay) {
      const overlays = await renderOverlay(
        ontology,
        join(directory, "overlays"),
      );
      uniqueOverlayFrames = overlays.uniqueFrames;
      await run(ffmpeg(), [
        "-v",
        "error",
        "-nostdin",
        "-y",
        "-i",
        cleanVideo,
        "-framerate",
        String(fps),
        "-start_number",
        "0",
        "-i",
        join(overlays.directory, "%06d.png"),
        "-filter_complex",
        "[0:v]setpts=PTS-STARTPTS[base];[1:v]setpts=PTS-STARTPTS[layer];[base][layer]overlay=0:0:shortest=1:format=auto,format=yuv420p[v]",
        "-map",
        "[v]",
        "-map",
        "0:a:0",
        "-frames:v",
        String(totalFrames),
        "-r",
        String(fps),
        "-c:v",
        "libx264",
        "-preset",
        "veryfast",
        "-crf",
        "18",
        "-c:a",
        "copy",
        "-movflags",
        "+faststart",
        staged,
      ]);
    } else await rename(cleanVideo, staged);
    const checked = await finalCheck(staged, ontology),
      sha256 = await fileHash(staged);
    const result = {
      inputHash,
      sha256,
      fps,
      width,
      height,
      totalFrames,
      duration: totalFrames / fps,
      videoCodec: checked.video.codec_name,
      audioCodec: checked.audio.codec_name,
      bytes: (await stat(staged)).size,
      uniqueOverlayFrames,
      audioBindings: descriptors.map((d, i) => ({
        clipIndex: i,
        startFrame: d.clip.startFrame,
        endFrame: d.clip.endFrame,
        sourceInSeconds: d.clip.sourceInSeconds,
        sourceAudioHash: d.audioHash,
        silence: !d.audioPath,
        speed: 1,
      })),
      subtitles: plan.subtitles,
      checks: {
        fullDecode: true,
        exactFrames: true,
        audioVideoStartDelta: Math.abs(
          Number(checked.audio.start_time || 0) -
            Number(checked.video.start_time || 0),
        ),
      },
    };
    await rename(staged, output);
    await writeFile(receiptPath, JSON.stringify(result, null, 2));
    return { path: output, ...result };
  } catch (error) {
    await rm(staged, { force: true });
    throw error;
  }
}

/** Produce a true portrait/landscape frame without distorting the source image. */
export async function fitImage(input: string, output: string, width: number, height: number) {
  requireValue(Number.isInteger(width) && Number.isInteger(height) && width > 0 && height > 0 && width <= 4096 && height <= 4096,"Invalid image canvas");
  const info=await probe(input), sw=info.video?.width, sh=info.video?.height;
  requireValue(Number.isInteger(sw) && Number.isInteger(sh) && sw > 0 && sh > 0,"Image could not be decoded");
  const ratio=width/height;
  const cropWidth=Math.min(sw,Math.floor(sh*ratio)), cropHeight=Math.min(sh,Math.floor(sw/ratio));
  const x=Math.floor((sw-cropWidth)/2), y=Math.floor((sh-cropHeight)/2);
  await run(ffmpeg(),["-v","error","-y","-i",input,"-vf",`crop=${cropWidth}:${cropHeight}:${x}:${y},scale=${width}:${height}:flags=lanczos,setsar=1`,"-frames:v","1",output],120000);
  const outputInfo=await probe(output);
  requireValue(outputInfo.video?.width === width && outputInfo.video?.height === height,"Image canvas verification failed");
  return {sourceWidth:sw,sourceHeight:sh,crop:{x,y,width:cropWidth,height:cropHeight},outputWidth:width,outputHeight:height,method:"center-crop-aspect-preserving-resize"};
}
