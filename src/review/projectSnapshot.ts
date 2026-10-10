import type { Project, Artifact, ImageAttemptHistory } from "../../shared/types";

export type ImageStatus = "pending" | "approved" | "change" | "historical";
export interface ReviewImage {
  id: string; url: string; thumbnailUrl?: string; sha256: string; status: ImageStatus;
  fileId: string; modelRequested?: string; modelActual?: string | null;
  parentIds: string[]; note?: string; needsRevision?: boolean; origin: "generated" | "imported"; stale?: boolean;
}
export interface ReviewItem {
  imageAttempt?: ImageAttemptHistory;
  id: string; type: "asset" | "shot"; title: string; description: string;
  image?: ReviewImage; candidates: ReviewImage[]; relatedIds: string[];
  mustShow: string[]; rejectIf: string[]; startFrame?: number; endFrame?: number;
  scale?: string; camera?: string; dialogue?: string[]; subtitles?: string[];
  startState?: string; endState?: string; dependencies: string[];
  firstFrameId?: string; approvedFileId?: string; targetHash?: string;
  source?: { url?: string; author?: string; license?: string; use?: string };
  references: { id: string; title: string; url?: string; imageUrl?: string; note?: string }[];
}
export interface ReviewFlow {
  id: string; title: string; kind: string; state: string; inputIds: string[];
  outputId?: string; dependsOn: string[]; reason?: string;
}
export interface ReviewSnapshot {
  schemaVersion: 1; projectId: string; title: string; revision: number;
  contentHash: string; fps: number; totalFrames: number; items: ReviewItem[];
  flow: ReviewFlow[]; evidence: { id: string; title: string; excerpt: string; url?: string }[];
}

/** Uses saved provenance only. An imported picture is never relabelled as generated. */
export function projectSnapshot(project: Project, fileUrl: (id: string) => string): ReviewSnapshot {
  type Binding = { artifactId: string; fileId: string; sha256: string };
  const file = (id?: string) => project.files.find(f => f.id === id);
  const images = project.artifacts.filter(a => String(a.kind) === "image").sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  const image = (a: Artifact): ReviewImage => ({
    id: a.id, fileId: a.fileId, url: fileUrl(a.fileId), sha256: file(a.fileId)?.sha256 || "",
    thumbnailUrl: typeof a.metadata.thumbnailFileId === "string" && file(a.metadata.thumbnailFileId)?.mime.startsWith("image/") ? fileUrl(a.metadata.thumbnailFileId) : undefined,
    status: a.accepted ? "approved" : a.metadata?.reviewStatus === "change" ? "change" : a.metadata.origin === "ai-generated" ? "pending" : "historical",
    stale: project.imageCandidateCurrent?.[a.id] === false || (!!project.imageTargetHashes?.[(a as Artifact & {assetId?:string}).assetId || a.shotId || ""] && a.sourceHash !== project.imageTargetHashes[(a as Artifact & {assetId?:string}).assetId || a.shotId || ""]),
    modelRequested: typeof a.metadata?.modelRequested === "string" ? a.metadata.modelRequested : undefined,
    modelActual: typeof a.metadata?.modelActual === "string" ? a.metadata.modelActual : null,
    parentIds: [...(Array.isArray(a.metadata?.parentAssets) ? a.metadata.parentAssets.flatMap((p: any) => typeof p?.assetId === "string" ? [p.assetId] : []) : []), ...(Array.isArray(a.metadata?.parentShots) ? a.metadata.parentShots.flatMap((p: any) => typeof p?.shotId === "string" ? [p.shotId] : []) : [])],
    note: typeof a.metadata?.reviewNote === "string" ? a.metadata.reviewNote : undefined,
    needsRevision: !!a.metadata?.technicalReview && typeof a.metadata.technicalReview === "object" && (a.metadata.technicalReview as {contentReview?:string}).contentReview === "needs_revision",
    origin: a.metadata.origin === "ai-generated" ? "generated" : "imported",
  });
  const imported = (fileId?: string, approved = false): ReviewImage | undefined => {
    const f = file(fileId); if (!f || !f.mime.startsWith("image/")) return;
    const a = images.find(a => a.fileId === fileId); if (a) return image(a);
    return { id: f.id, fileId: f.id, url: fileUrl(f.id), sha256: f.sha256, status: approved ? "approved" : "historical", parentIds: [], origin: "imported" };
  };
  const resolve = (binding?: Binding, fallback?: string, approved = false) => binding ? imageFromBinding(binding) : imported(fallback, approved);
  const imageFromBinding = (binding: Binding): ReviewImage | undefined => {
    const a = images.find(a => a.id === binding.artifactId);
    return a ? image(a) : imported(binding.fileId);
  };
  const currentPass = (id: string) => project.reviews.some(r => r.targetId === id && r.targetHash === project.compiled.targetHashes[id] && r.status === "pass");
  const refs = project.ontology.assets.filter(a => a.purpose === "reference");
  const reference = (ids: string[]) => refs.filter(a => ids.includes(a.id)).map(a => ({ id: a.id, title: a.label, url: a.source?.url, imageUrl: a.fileId && file(a.fileId)?.mime.startsWith("image/") ? fileUrl(a.fileId) : undefined, note: a.source?.use || a.source?.license }));
  const items: ReviewItem[] = project.ontology.assets.filter(a => a.purpose === "production" && ["image", "graphic"].includes(a.kind)).map(asset => {
    const a = asset as typeof asset & { previewImage?: Binding };
    const candidates = images.filter(i => (i as Artifact & { assetId?: string }).assetId === a.id).map(image);
    const selected = resolve(a.previewImage, a.fileId, currentPass(a.id)) || candidates[0];
    const related = project.ontology.shots.filter(s => s.requiredAssetIds.includes(a.id) || project.ontology.anchors.some(n => n.assetId === a.id && [s.firstAnchorId, s.endAnchorId].includes(n.id)));
    return { id: a.id, imageAttempt:a.imageAttempt, type: "asset", title: a.label, description: a.mustShow?.join("；") || "核对专属资产的身份、状态与用途。", image: selected, candidates: candidates.length ? candidates : selected ? [selected] : [], relatedIds: related.map(s => s.id), mustShow: a.mustShow || [], rejectIf: a.rejectIf || [], dependencies: selected?.parentIds || [], approvedFileId: a.fileId, source: a.source, targetHash: project.compiled.targetHashes[a.id], references: reference(related.flatMap(s => s.requiredAssetIds)) };
  });
  for (const shot of project.ontology.shots) {
    const s = shot as typeof shot & { reviewImage?: Binding; firstFrameImage?: Binding };
    const candidates = images.filter(a => a.shotId === s.id).map(image);
    const firstAsset = project.ontology.assets.find(a => a.id === project.ontology.anchors.find(n => n.id === s.firstAnchorId)?.assetId);
    const selected = resolve(s.reviewImage) || candidates[0];
    items.push({ id: s.id, imageAttempt:s.imageAttempt, type: "shot", title: s.title, description: s.action, image: selected, candidates, relatedIds: s.requiredAssetIds.filter(id => items.some(i => i.id === id)), mustShow: s.mustShow, rejectIf: s.rejectIf, startFrame: s.startFrame, endFrame: s.endFrame, scale: s.scale, camera: s.camera, dialogue: s.dialogue.map(d => `${project.ontology.entities.find(e => e.id === d.speakerId)?.label || d.speakerId}：${d.text}`), subtitles: s.subtitles.map(c => c.text), startState: s.startState, endState: s.endState, dependencies: s.dependencies, firstFrameId: s.firstFrameImage?.fileId || firstAsset?.fileId, targetHash: project.compiled.targetHashes[s.id], references: reference(s.requiredAssetIds) });
  }
  const flow: ReviewFlow[] = project.compiled.tasks.map(t => {
    const shot = project.ontology.shots.find(s => s.id === t.shotId);
    const jobs = project.jobs.filter(j => j.kind === t.kind && j.shotId === t.shotId && (j.shotId ? j.input?.generationHash === project.compiled.shotHashes[j.shotId] : j.input?.postHash === project.compiled.postHash));
    const job = [...jobs].sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
    return { id: t.id, title: shot ? `${shot.id} · ${shot.title}` : "完整影片合成", kind: t.kind, state: job?.state || "draft", inputIds: shot?.requiredAssetIds.filter(id => items.some(i => i.id === id)) || [], outputId: shot?.id, dependsOn: t.dependsOn, reason: job?.error };
  });
  return { schemaVersion: 1, projectId: project.id, title: project.ontology.title || project.name, revision: project.revision, contentHash: project.compiled.hash, fps: project.ontology.spec.fps, totalFrames: project.ontology.spec.totalFrames, items, flow, evidence: project.ontology.evidence };
}
