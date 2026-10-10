import type express from "express";
import type { Store } from "./store.ts";
import { publicSnapshot, publicReviewCsp, renderPublicReviewHtml } from "./public-review.ts";
import { ensure } from "./util.ts";

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
  app.get("/api/public-review/:id/files/:fileId", (req, res) => {
    const p = project(String(req.params.id)), used = new Set<string>();
    publicSnapshot(p, fileId => { used.add(fileId); return fileUrl(p.id, fileId); });
    const id = String(req.params.fileId);
    const f = p.files.find(file => file.id === id && used.has(id));
    ensure(f && ["image/png", "image/jpeg", "image/webp", "image/gif"].includes(f.mime), "公开图片不存在", 404);
    res.setHeader("Content-Type", f.mime);
    res.setHeader("Cache-Control", "public, max-age=300");
    res.setHeader("ETag", `"${f.sha256}"`);
    res.send(store.bytes(id));
  });
  app.get("/review/:id", (req, res) => {
    const p = project(String(req.params.id));
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("Content-Security-Policy", publicReviewCsp(true));
    res.type("html").send(renderPublicReviewHtml(p, fileId => fileUrl(p.id, fileId), true, { apiBase, projectId: p.id }));
  });
}
