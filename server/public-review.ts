import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { createHash } from "node:crypto";
import JSZip from "jszip";
import type { Project } from "../shared/types.ts";
import { inspectImageConsistency } from "../shared/image-consistency.ts";
import { projectSnapshot, type ReviewSnapshot } from "../src/review/projectSnapshot.ts";
import { PublicReview } from "../src/review/PublicReview.tsx";
import { Store } from "./store.ts";
import { ensure, escapeHtml, sha } from "./util.ts";

const json = (value: unknown) => JSON.stringify(value).replace(/</g, "\\u003c").replace(/>/g, "\\u003e").replace(/&/g, "\\u0026");
function safeLink(value?: string) {
  if (!value) return undefined;
  try { const url = new URL(value); if (!["https:", "http:"].includes(url.protocol) || url.username || url.password) return undefined; url.search = ""; url.hash = ""; return url.toString(); } catch { return undefined; }
}
/** Explicit view-model allowlist: no job receipts, model prompts, files, credentials or local paths. */
export function publicSnapshot(project: Project, fileUrl: (id: string) => string): ReviewSnapshot {
  const visible = new Set(project.artifacts.filter(a => a.kind === "image" && a.metadata.origin === "ai-generated").map(a => a.fileId));
  for (const artifact of project.artifacts) if (artifact.kind === "image" && artifact.metadata.origin === "ai-generated" && typeof artifact.metadata.thumbnailFileId === "string") visible.add(artifact.metadata.thumbnailFileId);
  for (const file of project.files) if (file.metadata?.publicShareApproved === true) visible.add(file.id);
  const privateSourceIds = new Set(project.ontology.imageConsistency?.characters.flatMap(profile => profile.referenceSourceAssetId ? [profile.referenceSourceAssetId] : []) || []);
  const privateSourceFiles = new Set(project.ontology.assets.filter(asset => privateSourceIds.has(asset.id)).flatMap(asset => [asset.fileId, asset.previewImage?.fileId].filter((id):id is string => !!id)));
  const privateSourceHashes = new Set(project.files.filter(file => privateSourceFiles.has(file.id)).map(file => file.sha256));
  for (const file of project.files) if (privateSourceHashes.has(file.sha256)) visible.delete(file.id);
  const publicProject = structuredClone(project);
  publicProject.files = publicProject.files.filter(f => visible.has(f.id));
  publicProject.artifacts = publicProject.artifacts.filter(a => visible.has(a.fileId));
  for (const asset of publicProject.ontology.assets) {
    if (asset.fileId && !visible.has(asset.fileId)) { delete asset.fileId; delete asset.sha256; asset.gap = true; }
    if (asset.previewImage && !visible.has(asset.previewImage.fileId)) delete asset.previewImage;
  }
  for (const shot of publicProject.ontology.shots) {
    if (shot.reviewImage && !visible.has(shot.reviewImage.fileId)) delete shot.reviewImage;
    if (shot.firstFrameImage && !visible.has(shot.firstFrameImage.fileId)) delete shot.firstFrameImage;
  }
  const snapshot = structuredClone(projectSnapshot(publicProject, fileUrl));
  for (const item of snapshot.items) {
    // Report readiness from the real private project without serializing the private reference bytes.
    const consistency = inspectImageConsistency(project, item.id);
    if (consistency.enabled) item.consistency = { isIdentityMaster:consistency.isIdentityMaster, ready:consistency.ready, requiredAssetIds:[...consistency.requiredSourceAssetIds, ...consistency.requiredIdentityAssetIds], issues:consistency.issues.map(issue=>issue.message) };
    // Technical publication notes are shared; private human review comments stay behind login.
    for (const candidate of [...item.candidates, ...(item.image ? [item.image] : [])]) {
      const artifact = project.artifacts.find(a => a.id === candidate.id);
      const technical = artifact?.metadata.technicalReview as {notes?:unknown} | undefined;
      candidate.note = Array.isArray(technical?.notes) ? technical.notes.filter((note:unknown):note is string=>typeof note === "string").join("；") : undefined;
    }
    if (item.source) item.source.url = safeLink(item.source.url);
    for (const reference of item.references) reference.url = safeLink(reference.url);
  }
  snapshot.evidence = snapshot.evidence.map(({ id, title, excerpt, url }) => ({ id, title, excerpt, url: safeLink(url) }));
  // Internal task errors may contain upstream URLs/paths. The editor retains the full error.
  snapshot.flow = snapshot.flow.map(node => ({ ...node, reason: node.reason ? "此任务需要在工作台查看原因并处理。" : undefined }));
  return snapshot;
}
export function publicReviewCsp(online = false): string {
  const path = resolve("dist-review/review.js");
  const script = existsSync(path) ? readFileSync(path, "utf8").replace(/<\/script/gi, "<\\/script") : "";
  const digest = createHash("sha256").update(script).digest("base64");
  return `default-src 'none'; script-src 'sha256-${digest}'; style-src 'unsafe-inline'; img-src 'self' data:; connect-src ${online ? "'self'" : "'none'"}; frame-ancestors 'none'; base-uri 'none'; form-action 'none'`;
}
export function renderPublicReviewHtml(project: Project, fileUrl: (id: string) => string, requireInteractive = false, onlineReview?: { apiBase: string; projectId: string }): string {
  const snapshot = publicSnapshot(project, fileUrl);
  if (onlineReview) snapshot.onlineReview = onlineReview;
  const scriptPath = resolve("dist-review/review.js"), stylePath = resolve("dist-review/review.css");
  if (requireInteractive) ensure(existsSync(scriptPath) && existsSync(stylePath), "审稿组件尚未构建，请先运行 npm run build", 503, "review_build_missing");
  const styles = existsSync(stylePath) ? readFileSync(stylePath, "utf8") : ["src/review/review.css", "src/review/public.css"].filter(existsSync).map(p => readFileSync(p, "utf8")).join("\n");
  const script = existsSync(scriptPath) ? readFileSync(scriptPath, "utf8").replace(/<\/script/gi, "<\\/script") : "";
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="referrer" content="no-referrer"><title>${escapeHtml(project.name)} · 真实资产审稿</title><style>${styles.replace(/<\/style/gi, "<\\/style")}</style></head><body><div id="root">${renderToStaticMarkup(createElement(PublicReview, { snapshot }))}</div><script id="storyflow-snapshot" type="application/json">${json(snapshot)}</script>${script ? `<script>${script}</script>` : '<p>当前为只读审稿快照；完整交互请先构建应用。</p>'}<noscript>已显示固定审稿内容；放大、筛选及本地意见需要启用JavaScript。</noscript></body></html>`;
}

/** Export only the images actually used by the public view model; never the whole project directory. */
export async function exportReviewSnapshot(store: Store, projectId: string): Promise<Buffer> {
  const project = store.project(projectId);
  const zip = new JSZip();
  const used = new Map<string, { path: string; sha256: string; bytes: number; mime: string }>();
  const resolveFile = (id: string) => {
    const file = project.files.find(f => f.id === id);
    ensure(file && ["image/png", "image/jpeg", "image/webp", "image/gif"].includes(file.mime), "审稿图片不存在或类型不支持", 400, "review_image");
    const extension = ({ "image/png": "png", "image/jpeg": "jpg", "image/webp": "webp", "image/gif": "gif" } as Record<string, string>)[file.mime];
    const path = `assets/${file.sha256}.${extension}`;
    if (!used.has(file.id)) {
      const bytes = store.bytes(file.id);
      ensure(sha(bytes) === file.sha256, "审稿图片内容哈希不符", 409, "review_image_hash");
      zip.file(path, bytes, { compression: "STORE" });
      used.set(file.id, { path, sha256: file.sha256, bytes: bytes.length, mime: file.mime });
    }
    return path;
  };
  const html = renderPublicReviewHtml(project, resolveFile, true);
  zip.file("index.html", html);
  zip.file("public-manifest.json", JSON.stringify({ schema: "storyflow-public-review", version: 1, revision: project.revision, contentHash: project.compiled.hash, html: { path: "index.html", sha256: sha(Buffer.from(html)) }, images: [...used.values()] }, null, 2));
  return zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE", compressionOptions: { level: 6 } });
}
