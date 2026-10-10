import type express from "express";
import type { Store } from "./store.ts";
import { publicSnapshot, publicProduction, publicReviewCsp, renderPublicReviewHtml } from "./public-review.ts";
import { boundedText, ensure } from "./util.ts";

/** Explicit project allowlist. Never makes the project API, originals or receipts public. */
export function mountPublicReviewRoutes(app: express.Express, store: Store, options: {
  projectIds?: string[]; apiBase?: string;
} = {}) {
  const published = new Set(options.projectIds || []);
  const apiBase = options.apiBase || "/api";
  ensure(/^\/(?!\/)[A-Za-z0-9_/-]*\/api$/.test(apiBase) || apiBase === "/api", "公开审图 API 必须使用同源绝对路径", 500);
  const project = (id: string) => {
    ensure(published.has(id), "审稿项目未公开", 404);
    return store.project(id);
  };
  const fileUrl = (id: string, fileId: string) => `${apiBase}/public-review/${encodeURIComponent(id)}/files/${encodeURIComponent(fileId)}`;
  app.get("/api/public-review/:id", (req, res) => {
    const p = project(String(req.params.id));
    const snapshot = publicSnapshot(p, fileId => fileUrl(p.id, fileId));
    snapshot.onlineReview = { apiBase, projectId: p.id };
    res.setHeader("Cache-Control", "no-store");
    res.json(snapshot);
  });
  app.get("/api/public-review/:id/production", (req, res) => {
    const p = project(String(req.params.id));
    res.setHeader("Cache-Control", "no-store");
    res.json(publicProduction(p, fileId => fileUrl(p.id, fileId)));
  });
  // Mounted after createApp's global Origin / Sec-Fetch-Site checks, before the generic API gate.
  app.post("/api/public-review/:id/artifacts/:artifactId/review", (req, res) => {
    const session = String(req.headers.cookie || "").split(";").map(v=>v.trim()).find(v=>v.startsWith("storyflow="))?.slice(10) || "";
    ensure(store.authenticated(session), "请先登录管理员", 401, "login_required");
    const p = project(String(req.params.id));
    const candidate = publicProduction(p, fileId=>fileUrl(p.id,fileId)).candidates.find(a=>a.id === String(req.params.artifactId));
    ensure(candidate && candidate.kind !== "final", "当前公开制作候选不存在", 404);
    ensure(typeof req.body.accepted === "boolean", "需要accepted状态");
    ensure(req.body.sourceHash === candidate.sourceHash && req.body.fileSha256 === candidate.sha256, "候选内容已变化，请刷新后重新审核", 409, "candidate_changed");
    if (req.body.accepted) ensure(candidate.current, "产物属于旧的生成版本，请保留为历史候选", 409, "candidate_stale");
    store.reviewArtifact(candidate.id, req.body.accepted, boundedText(req.body.note || "", 10000));
    res.json(publicProduction(store.project(p.id), fileId=>fileUrl(p.id,fileId)));
  });
  app.get("/api/public-review/:id/files/:fileId", (req, res) => {
    const p = project(String(req.params.id)), used = new Set<string>();
    publicSnapshot(p, fileId => { used.add(fileId); return fileUrl(p.id, fileId); });
    const media = publicProduction(p, fileId => fileUrl(p.id, fileId)).candidates;
    for (const candidate of media) used.add(candidate.fileId);
    const id = String(req.params.fileId);
    const f = p.files.find(file => file.id === id && used.has(id));
    ensure(f && (["image/png", "image/jpeg", "image/webp", "image/gif"].includes(f.mime) || media.some(a=>a.fileId === f.id)), "公开素材不存在", 404);
    res.setHeader("Content-Type", f.mime);
    res.setHeader("Cache-Control", "public, max-age=300");
    res.setHeader("ETag", `"${f.sha256}"`);
    if (media.some(a=>a.fileId === id)) {
      // sendFile implements single-range, suffix-range, HEAD and 416 without reading a whole MP4 into RAM.
      res.sendFile(store.filePath(id), { acceptRanges:true, cacheControl:false, lastModified:false });
    } else res.send(store.bytes(id));
  });
  app.get("/review/:id", (req, res) => {
    const p = project(String(req.params.id));
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("Content-Security-Policy", publicReviewCsp(true));
    res.type("html").send(renderPublicReviewHtml(p, fileId => fileUrl(p.id, fileId), true, { apiBase, projectId: p.id }));
  });
}
