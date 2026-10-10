import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { join } from "node:path";
import type { Artifact, ImageTarget, Project } from "../shared/types.ts";
import { hash } from "../shared/ontology.ts";
import { resolveImageConsistency } from "../shared/image-consistency.ts";
import { Jobs } from "./jobs.ts";
import { Store } from "./store.ts";
import { AppError, boundedText, cleanError, ensure, iso } from "./util.ts";

export interface ReviewSubmissionItem {
  targetId: string;
  targetHash: string;
  imageId: string;
  imageSha256: string;
  status: "pass" | "change";
  note: string;
}
export interface ReviewSubmission {
  id: string;
  projectId: string;
  baseRevision: number;
  createdAt: string;
  items: (ReviewSubmissionItem & {
    outcome: "approved" | "queued" | "blocked";
    jobId?: string;
    blocked?: { code: string; reason: string };
  })[];
}
const digest = (value: unknown, label: string) => {
  ensure(typeof value === "string" && /^[a-f0-9]{64}$/.test(value), `${label}无效`);
  return value;
};
function parseItems(value: unknown): ReviewSubmissionItem[] {
  ensure(Array.isArray(value) && value.length > 0 && value.length <= 52, "每次须提交1–52项审图意见");
  const ids = new Set<string>();
  return value.map(item => {
    ensure(item && typeof item === "object" && Object.keys(item).every(key => ["targetId", "targetHash", "imageId", "imageSha256", "status", "note"].includes(key)), "审图意见包含未知字段");
    const targetId = boundedText(item.targetId, 128);
    ensure(targetId && !ids.has(targetId), "审核目标不能重复"); ids.add(targetId);
    ensure(["pass", "change"].includes(item.status), "请选择通过或不通过");
    const note = boundedText(item.note || "", 10000).trim();
    ensure(item.status !== "change" || note.length > 0, "不通过需要填写具体修改意见");
    const imageId = boundedText(item.imageId, 128);
    ensure(imageId, "需要实际图片候选");
    return { targetId, targetHash: digest(item.targetHash, "目标哈希"), imageId, imageSha256: digest(item.imageSha256, "图片哈希"), status: item.status, note };
  });
}
function checkImage(store: Store, project: Project, item: ReviewSubmissionItem): Artifact {
  ensure(project.compiled.targetHashes[item.targetId] === item.targetHash, "审核内容已经更新，请刷新后重新核对", 409, "review_snapshot_conflict");
  const artifact = project.artifacts.find(a => a.id === item.imageId);
  ensure(artifact && artifact.kind === "image" && (artifact.assetId || artifact.shotId) === item.targetId, "图片不属于当前审核对象", 409, "review_image_conflict");
  ensure(store.file(artifact.fileId).sha256 === item.imageSha256, "审核图片已经变化，请刷新后重新核对", 409, "review_image_conflict");
  if (item.status === "pass") ensure(project.imageCandidateCurrent?.[artifact.id], "图片属于历史制作条件，请核对当前图片后通过", 409, "review_snapshot_conflict");
  return artifact;
}
function block(code: string, reason: string): never { throw new AppError(reason, 409, code); }
function generationTarget(project: Project, artifact: Artifact, item: ReviewSubmissionItem): ImageTarget {
  const asset = project.ontology.assets.find(a => a.id === item.targetId);
  const shot = project.ontology.shots.find(s => s.id === item.targetId);
  const attempt = asset?.imageAttempt || shot?.imageAttempt;
  if (attempt && /moderation|policy/.test(attempt.code)) block("provider_policy_blocked", "此前供应商因内容政策拒绝此目标。意见已保存，不自动改词或重新提交。");
  if (attempt?.blockingParent) {
    const parent = project.ontology.assets.find(a => a.id === attempt.blockingParent);
    if (parent?.imageAttempt && /moderation|policy/.test(parent.imageAttempt.code)) block("provider_policy_blocked", `前置素材 ${parent.id} 尚受供应商政策限制。意见已保存，此目标未提交。`);
  }
  // Reuse relevant current references, never the rejected candidate as an implicit identity source.
  const previous = Array.isArray(artifact.metadata.parentAssets) ? artifact.metadata.parentAssets.map((p: any) => p.assetId) : [];
  const consistency=resolveImageConsistency(project.ontology,item.targetId);
  const allowedActors=new Set(consistency.desiredReferences.map(r=>r.characterId));
  const refs = [...new Set<string>([...previous, ...(shot?.requiredAssetIds || [])])].filter(id => id !== item.targetId && project.ontology.assets.some(a => a.id === id && (a.fileId || a.previewImage?.fileId) && ["image", "graphic"].includes(a.kind) && (!consistency.enabled || (a.imageComposition?.visibleCharacters || []).every(actor=>allowedActors.has(actor.characterId)))));
  const original = asset ? `${asset.label}。必须可见：${(asset.mustShow || []).join("；")}。拒收：${(asset.rejectIf || []).join("；")}。` : `${project.compiled.prompts[item.targetId]}\n仅绘制镜头开始时刻的单张首帧，不添加字幕。`;
  const prompt = `${original}\n\n审核修改意见（只修改本目标，角色身份和已批准参考保持一致）：\n${item.note}\n生成一张新的候选供人工复审，不代表自动通过。`;
  return { ...(asset ? { assetId: asset.id } : { shotId: shot!.id }), prompt, referenceAssetIds: refs };
}
function guardExistingJobs(store: Store, project: Project, targetId: string) {
  for (const job of project.jobs.filter(j => j.kind === "image" && (j.input.target?.assetId || j.input.target?.shotId || j.shotId) === targetId)) {
    if (job.state === "uncertain" || (job.state === "cancelled" && job.attempts > 0 && !existsSync(join(store.workDir(job.id), "image-receipt.json")))) block("acceptance_unknown", "此目标有受理不明的原任务，须先核对；意见已保存，不重复提交。");
    if (["queued", "running", "waiting_review"].includes(job.state)) block("image_job_active", "此目标已有生成任务，意见已保存，请等待原任务完成后再审核。");
    if (job.state === "failed" && existsSync(join(store.workDir(job.id), "image-receipt.json"))) block("image_download_pending", "供应商已返回图片，需恢复原任务的下载或处理；意见已保存，不再调用生图。");
    if (/moderation|policy/.test(String(job.result?.errorCode || ""))) block("provider_policy_blocked", "此前供应商因内容政策拒绝此目标。意见已保存，不自动改词或重新提交。");
  }
}

/** Every decision and generation intent is committed together, before any provider I/O. */
export function submitReviews(store: Store, jobs: Jobs, projectId: string, baseRevision: number, key: string, value: unknown) {
  const items = parseItems(value);
  const inputHash = hash({ kind: "review-submission-v1", baseRevision, items });
  const prior = store.action(projectId, key, inputHash);
  const response = (submission: ReviewSubmission) => ({ submission, project: store.project(projectId), jobs: submission.items.flatMap(item => item.jobId ? [store.job(item.jobId)] : []) });
  if (prior) return response(store.reviewSubmission(projectId, prior.id));
  const submission = store.transaction(() => {
    const project = store.project(projectId);
    ensure(project.revision === baseRevision, "工程版本已经变化，请刷新后提交", 409, "revision_conflict");
    const artifacts = items.map(item => checkImage(store, project, item));
    const now = iso(), id = randomUUID();
    const record: ReviewSubmission = { id, projectId, baseRevision, createdAt: now, items: [] };
    // Apply every human decision first, allowing a master approval and dependent repair in one explicit submission.
    for (const [index, item] of items.entries()) {
      store.reviewArtifact(artifacts[index].id, item.status === "pass", item.note);
      store.review(projectId, item.targetId, item.status, item.note, item.targetHash);
    }
    // A master replacement may invalidate another approved item in this same batch, regardless of item order.
    for (const [index,item] of items.entries()) if(item.status === "pass") ensure(store.imageCurrent(artifacts[index]), "本批角色基准更新使另一张通过图片过期，请先提交新基准，再审核关联图片", 409, "review_identity_conflict");
    for (const [index, item] of items.entries()) {
      if (item.status === "pass") { record.items.push({ ...item, outcome: "approved" }); continue; }
      try {
        const current = store.project(projectId);
        guardExistingJobs(store, current, item.targetId);
        const target = generationTarget(current, artifacts[index], item);
        ensure(jobs.providers.capabilities().image?.available, "图片接口尚未配置。意见已保存，配置后请再次提交生成。", 409, "image_not_configured");
        const prepared = jobs.prepareImageInputs(projectId, baseRevision, [target])[0];
        const input = { ...prepared, reviewSubmissionId: id, revisionOf: item.imageId, reviewNote: item.note };
        const job = store.addJob({ projectId, runId: id, kind: "image", shotId: target.shotId, dependsOn: [], inputHash: hash(input), input });
        record.items.push({ ...item, outcome: "queued", jobId: job.id });
      } catch (error) {
        // Expected readiness blockers do not lose review feedback; programmer/storage failures abort everything.
        if (!(error instanceof AppError) || error.status >= 500) throw error;
        record.items.push({ ...item, outcome: "blocked", blocked: { code: error.code, reason: cleanError(error) } });
      }
    }
    store.recordReviewSubmission(record);
    store.recordAction(projectId, key, inputHash, { id });
    return record;
  });
  void jobs.tick();
  return response(submission);
}
