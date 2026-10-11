import type { Store } from "./store.ts";
import { publicProduction, publicSnapshot } from "./public-review.ts";

/** Reuses the existing public review allowlist; never changes a file's visibility. */
export function publicReviewMediaUrl(store: Store, options: {
  publicBaseUrl: string; publicReviewProjectIds: string[]; publicReviewApiBase: string;
}, projectId: string, fileId: string): string | undefined {
  if (!options.publicReviewProjectIds.includes(projectId)) return;
  const project = store.project(projectId), used = new Set<string>();
  publicSnapshot(project, id => {used.add(id); return id;});
  const media = publicProduction(project, id => id).candidates;
  for (const candidate of media) used.add(candidate.fileId);
  const file = project.files.find(f => f.id === fileId && used.has(fileId));
  if (!file || (!["image/png", "image/jpeg", "image/webp", "image/gif"].includes(file.mime) && !media.some(a => a.fileId === fileId))) return;
  const base = new URL(options.publicBaseUrl);
  if (base.protocol !== "https:" || base.username || base.password || base.search || base.hash) return;
  const api = options.publicReviewApiBase;
  if (!(api === "/api" || /^\/(?!\/)[A-Za-z0-9_/-]*\/api$/.test(api))) return;
  return new URL(`${api}/public-review/${encodeURIComponent(projectId)}/files/${encodeURIComponent(fileId)}`, base).toString();
}
