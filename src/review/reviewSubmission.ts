import type { ReviewDraft, ReviewImage, ReviewItem, ReviewSnapshot } from "./ReviewPresentation";

export interface ImageReviewSubmission {
  id: string;
  projectId: string;
  baseRevision: number;
  createdAt: string;
  items: { targetId: string; note?: string; status: "pass" | "change"; outcome: "approved" | "queued" | "blocked"; jobId?: string; blocked?: { code: string; reason: string } }[];
}
export type ReviewQueue = { baseRevision: number; drafts: Record<string, ReviewDraft>; request?: { key: string; payload: string } };
export function queueOpinion(queue: ReviewQueue | null, revision: number, item: ReviewItem, status: ReviewDraft["status"], note: string, image?: ReviewImage): ReviewQueue {
  const current = image || item.image;
  return { baseRevision: queue?.baseRevision ?? revision, request: queue?.request, drafts: { ...queue?.drafts, [item.id]: { status, note, imageId: current?.id, imageSha256: current?.sha256, targetHash: item.targetHash || "" } } };
}
export function submissionItems(queue: ReviewQueue) {
  return Object.entries(queue.drafts).map(([targetId, draft]) => ({ targetId, targetHash: draft.targetHash || "", imageId: draft.imageId, imageSha256: draft.imageSha256, status: draft.status, note: draft.note.trim() }));
}
export function submissionNotice(submission: ImageReviewSubmission) {
  const approved = submission.items.filter(i => i.outcome === "approved").length;
  const queued = submission.items.filter(i => i.outcome === "queued").length;
  const blocked = submission.items.filter(i => i.outcome === "blocked");
  return `意见已保存：${approved} 项通过，${queued} 项返修已排队${blocked.length ? `，${blocked.length} 项等待条件。${blocked.map(i => `${i.targetId}：${i.blocked?.reason || "请检查制作条件"}`).join("；")}` : "。后台继续处理，新候选仍需你审核。"}`;
}

/** Keeps wording but requires every verdict to be made again against the current image. */
export function reconfirmQueue(queue: ReviewQueue, snapshot: ReviewSnapshot): ReviewQueue {
  return { baseRevision: snapshot.revision, drafts: Object.fromEntries(Object.entries(queue.drafts).flatMap(([id, previous]) => {
    const item = snapshot.items.find(i => i.id === id);
    return item ? [[id, { status: "pending", note: previous.note, imageId: item.image?.id, imageSha256: item.image?.sha256, targetHash: item.targetHash || "" }]] : [];
  })) };
}
