import { chromiumOptions } from "./chromium.ts";
import { createHash } from "node:crypto";
import { mkdir, writeFile, link, copyFile } from "node:fs/promises";
import { join } from "node:path";
import type { Ontology, GraphicElement } from "../shared/types.js";

const hash = (v: string) => createHash("sha256").update(v).digest("hex");
const escape = (v: string) =>
  v.replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ]!,
  );
function requireValue(value: unknown, message: string): asserts value {
  if (!value) throw new Error(message);
}
export function validateGraphics(ontology: Ontology) {
  const { width, height, totalFrames } = ontology.spec;
  const elements = ontology.postProgram?.elements || [];
  requireValue(
    !ontology.postProgram || ontology.postProgram.version === 1,
    "Unsupported PostProgram version",
  );
  requireValue(
    Array.isArray(elements) && elements.length <= 300,
    "PostProgram exceeds 300 elements",
  );
  for (const e of elements) {
    requireValue(
      e && ["text", "rect", "circle", "arrow"].includes(e.type),
      "Unsupported graphic type",
    );
    requireValue(
      Object.keys(e).every((k) =>
        [
          "type",
          "text",
          "x",
          "y",
          "w",
          "h",
          "color",
          "size",
          "startFrame",
          "endFrame",
          "fadeFrames",
        ].includes(k),
      ),
      "Unknown graphic property",
    );
    requireValue(
      [e.x, e.y].every((n) => Number.isFinite(n)) &&
        e.x >= 0 &&
        e.x <= width &&
        e.y >= 0 &&
        e.y <= height,
      "Graphic position is out of bounds",
    );
    requireValue(
      [e.w ?? 1, e.h ?? 1].every(
        (n) =>
          Number.isFinite(n) &&
          Math.abs(n) <= Math.max(width, height) * 2 &&
          (e.type === "arrow" || n > 0),
      ),
      "Invalid graphic dimensions",
    );
    requireValue(
      /^#[0-9a-f]{6}(?:[0-9a-f]{2})?$/i.test(e.color),
      "Only hexadecimal graphic colors are supported",
    );
    requireValue(
      Number.isFinite(e.size ?? 24) &&
        (e.size ?? 24) >= 6 &&
        (e.size ?? 24) <= 300,
      "Invalid graphic size",
    );
    requireValue(
      [e.startFrame, e.endFrame, e.fadeFrames ?? 0].every(
        Number.isSafeInteger,
      ) &&
        e.startFrame >= 0 &&
        e.endFrame > e.startFrame &&
        e.endFrame <= totalFrames &&
        (e.fadeFrames ?? 0) >= 0 &&
        (e.fadeFrames ?? 0) <= (e.endFrame - e.startFrame) / 2,
      "Invalid graphic frame interval",
    );
    requireValue(
      e.type !== "text" ||
        (typeof e.text === "string" &&
          e.text.length > 0 &&
          e.text.length <= 1000),
      "Graphic text is required and bounded",
    );
  }
  const captions = ontology.shots.flatMap((s) => s.subtitles || []);
  requireValue(captions.length <= 1000, "Too many subtitles");
  for (const c of captions)
    requireValue(
      typeof c.text === "string" &&
        c.text.length > 0 &&
        c.text.length <= 1000 &&
        Number.isSafeInteger(c.startFrame) &&
        Number.isSafeInteger(c.endFrame) &&
        c.startFrame >= 0 &&
        c.endFrame > c.startFrame &&
        c.endFrame <= totalFrames,
      "Invalid subtitle",
    );
}
function opacity(e: GraphicElement, frame: number) {
  const fade = e.fadeFrames || 0;
  if (!fade) return 1;
  return Math.min(
    1,
    (frame - e.startFrame + 1) / fade,
    (e.endFrame - frame) / fade,
  );
}
function graphic(e: GraphicElement, frame: number) {
  const common = `fill="${e.color}" opacity="${opacity(e, frame).toFixed(5)}"`;
  if (e.type === "rect")
    return `<rect x="${e.x}" y="${e.y}" width="${e.w ?? 100}" height="${e.h ?? 100}" ${common}/>`;
  if (e.type === "circle")
    return `<ellipse cx="${e.x}" cy="${e.y}" rx="${(e.w ?? 100) / 2}" ry="${(e.h ?? e.w ?? 100) / 2}" ${common}/>`;
  if (e.type === "arrow") {
    const dx = e.w ?? 100,
      dy = e.h ?? 0,
      x = e.x + dx,
      y = e.y + dy,
      angle = Math.atan2(dy, dx),
      size = e.size ?? 12,
      a = angle + Math.PI * 0.85,
      b = angle - Math.PI * 0.85;
    return `<g opacity="${opacity(e, frame).toFixed(5)}" stroke="${e.color}" stroke-width="${Math.max(2, size / 4)}" fill="${e.color}"><path fill="none" d="M${e.x} ${e.y} L${x} ${y}"/><path d="M${x} ${y} L${x + Math.cos(a) * size} ${y + Math.sin(a) * size} L${x + Math.cos(b) * size} ${y + Math.sin(b) * size} Z"/></g>`;
  }
  return `<text x="${e.x}" y="${e.y}" font-size="${e.size ?? 32}" ${common}>${escape(e.text || "")}</text>`;
}
export function overlaySvg(ontology: Ontology, frame: number) {
  const { width, height } = ontology.spec,
    elements = (ontology.postProgram?.elements || []).filter(
      (e) => e.startFrame <= frame && frame < e.endFrame,
    ),
    captions = ontology.shots
      .flatMap((s) => s.subtitles || [])
      .filter((c) => c.startFrame <= frame && frame < c.endFrame);
  const size = Math.max(12, Math.round(width * 0.046)),
    lineHeight = size * 1.4,
    chars = Math.max(6, Math.floor((width * 0.86) / size));
  const lines = captions.flatMap((c) =>
    c.text.split("\n").flatMap((s) => {
      const letters = [...s],
        result: string[] = [];
      for (let i = 0; i < letters.length; i += chars)
        result.push(letters.slice(i, i + chars).join(""));
      return result;
    }),
  );
  requireValue(
    lines.length <= 5,
    "Subtitle exceeds five lines; shorten or split the cue",
  );
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}"><g font-family="Noto Sans CJK SC,Noto Sans SC,Arial,sans-serif">${elements.map((e) => graphic(e, frame)).join("")}${lines.map((line, i) => `<text x="${width / 2}" y="${height * 0.9 - (lines.length - 1 - i) * lineHeight}" text-anchor="middle" font-size="${size}" fill="#ffffff" stroke="#101722" stroke-width="${Math.max(2, size * 0.1)}" stroke-linejoin="round" paint-order="stroke">${escape(line)}</text>`).join("")}</g></svg>`;
}

/** Only our bounded SVG serializer reaches Chromium. Model HTML or scripts are never loaded. */
export async function renderOverlay(
  ontology: Ontology,
  directory: string,
  range = { startFrame: 0, endFrame: ontology.spec.totalFrames },
): Promise<{ directory: string; uniqueFrames: number }> {
  validateGraphics(ontology);
  await mkdir(directory, { recursive: true });
  requireValue(
    Number.isInteger(range.startFrame) &&
      Number.isInteger(range.endFrame) &&
      range.startFrame >= 0 &&
      range.endFrame > range.startFrame &&
      range.endFrame <= ontology.spec.totalFrames,
    "Invalid overlay render interval",
  );
  const { chromium } = await import("playwright");
  const browser = await chromium.launch(chromiumOptions());
  const cache = new Map<string, string>();
  try {
    const page = await browser.newPage({
      viewport: { width: ontology.spec.width, height: ontology.spec.height },
      deviceScaleFactor: 1,
    });
    await page.route("**/*", (route) => route.abort());
    await page.setContent(
      "<!doctype html><html><head><meta http-equiv=\"Content-Security-Policy\" content=\"default-src 'none'; style-src 'unsafe-inline'\"><style>html,body{margin:0;padding:0;background:transparent;overflow:hidden}svg{display:block}</style></head><body></body></html>",
    );
    for (let frame = range.startFrame; frame < range.endFrame; frame++) {
      const svg = overlaySvg(ontology, frame),
        key = hash(svg),
        target = join(directory, `${String(frame).padStart(6, "0")}.png`),
        cached = cache.get(key);
      if (cached) {
        try {
          await link(cached, target);
        } catch (error: any) {
          if (error.code !== "EEXIST") await copyFile(cached, target);
        }
        continue;
      }
      await page.evaluate((markup: string) => {
        document.body.innerHTML = markup;
      }, svg);
      await page.evaluate(() => document.fonts.ready);
      const bytes = await page.screenshot({
        type: "png",
        omitBackground: true,
      });
      await writeFile(target, bytes);
      cache.set(key, target);
    }
  } finally {
    await browser.close();
  }
  return { directory, uniqueFrames: cache.size };
}
