import { useEffect, useMemo, useRef, useState } from "react";
import type { Project } from "../../shared/types";
import { inspectImageConsistency } from "../../shared/image-consistency";
import { api, fileUrl, idempotencyKey } from "../api";
import { ReviewDetail, ReviewPresentation, ReviewSubmitBar, InlineImageReview, type ReviewImage, type ReviewItem, type ReviewDraft } from "./ReviewPresentation";
import { projectSnapshot } from "./projectSnapshot";
import "./review.css";
import { queueOpinion, reconfirmQueue, submissionItems, submissionNotice, type ImageReviewSubmission, type ReviewQueue } from "./reviewSubmission";

type Props = { project: Project; busy: boolean; configured: boolean; reason?: string; model?: string;
  act: <T>(operation: () => Promise<T>, message?: string) => Promise<T | undefined>;
  update: (project: Project) => void; submit: (path: string, body?: Record<string, unknown>) => Promise<void>;
};
export function ImageWorkspace(props: Props) {
  const { project, busy, configured, reason, model, act, update, submit } = props;
  const storageKey = `storyflow-image-review:${project.id}`;
  const [queue, setQueue] = useState<ReviewQueue | null>(() => { try { return JSON.parse(localStorage.getItem(storageKey) || "null"); } catch { return null; } });
  useEffect(() => { try { if (queue) localStorage.setItem(storageKey, JSON.stringify(queue)); else localStorage.removeItem(storageKey); } catch { /* Submission remains available when browser storage is full. */ } }, [queue, storageKey]);
  const [submitting, setSubmitting] = useState(false), [reviewNotice, setReviewNotice] = useState("");
  const request = useRef<{ key: string; payload: string } | null>(queue?.request || null);
  const review = (item: ReviewItem, status: ReviewDraft["status"], note: string, image?: ReviewImage) => {
    setQueue(previous => queueOpinion(previous, project.revision, item, status, note, image)); setReviewNotice("");
  };
  async function submitReviews() {
    if (!queue || submitting) return;
    const body = { baseRevision: queue.baseRevision, items: submissionItems(queue) }, payload = JSON.stringify(body);
    if (request.current?.payload !== payload) request.current = { key: idempotencyKey(), payload };
    setSubmitting(true); setReviewNotice("");
    try {
      const persistedQueue = { ...queue, request: request.current };
      try { localStorage.setItem(storageKey, JSON.stringify(persistedQueue)); } catch { throw new Error("无法保存本次提交标识，尚未发送生成；请允许浏览器本地存储后重试。"); }
      setQueue(persistedQueue);
      const result = await api<{ submission: ImageReviewSubmission; project: Project }>(`/api/projects/${project.id}/review-submissions`, "POST", { ...body, idempotencyKey: request.current.key });
      update(result.project); localStorage.removeItem(storageKey); setQueue(null); request.current = null; setReviewNotice(submissionNotice(result.submission));
    } catch (error) { setReviewNotice(error instanceof Error ? error.message : "提交未确认，请重试。相同意见不会重复生成。"); }
    finally { setSubmitting(false); }
  }
  const [selected, setSelected] = useState<string | null>(null);
  const [actionError, setActionError] = useState("");
  const inspect = (id: string) => { setSelected(id); setActionError(""); };
  const [kind, setKind] = useState<"assets" | "shots">("assets");
  const snapshot = useMemo(() => projectSnapshot(project, fileUrl), [project]);
  const item = snapshot.items.find(i => i.id === selected);
  async function candidateAction(id: string, action: "review" | "select", body: Record<string, unknown>, message: string) {
    setActionError("");
    const result = await act(async () => { try { return await api<Project>(`/api/artifacts/${encodeURIComponent(id)}/${action}`, "POST", body); } catch (error) { setActionError(error instanceof Error ? error.message : "图片操作未完成"); throw error; } }, message);
    if (result) update(result);
  }
  return <section className="image-workspace">
    <div className={`image-service-note ${configured ? "ready" : ""}`}><span className="status-dot" /><div><b>{configured ? `图片服务已配置 · ${model || "按服务端配置"}` : "图片生成待配置"}</b><p>{configured ? "每次明确提交一个候选；不会自动追加或重投受理不明的任务。" : reason || "请在服务端配置 IMAGE_BASE_URL、IMAGE_API_KEY 与 IMAGE_MODEL。已有图片仍可查看和审核。"}</p></div></div>
    <div className="subnav" aria-label="图片资产视图"><button className={kind === "assets" ? "active" : ""} onClick={() => setKind("assets")}>专属资产图</button><button className={kind === "shots" ? "active" : ""} onClick={() => setKind("shots")}>逐镜首帧</button></div>
    {queue && queue.baseRevision !== snapshot.revision && <div className="sf-review-conflict" role="status"><p>工程已从 V{queue.baseRevision} 更新到 V{snapshot.revision}。原意见已保留，请对照当前图片重新选择审核结论。</p><button onClick={() => setQueue(reconfirmQueue(queue, snapshot))}>保留评论，重新核对当前图片</button></div>}
    <ReviewSubmitBar disabled={!!queue && queue.baseRevision !== snapshot.revision} drafts={queue?.drafts || {}} busy={busy || submitting} notice={reviewNotice} onSubmit={() => void submitReviews()} />
    <ReviewPresentation snapshot={snapshot} section={kind} onInspect={inspect} onReview={review} reviewDrafts={queue?.drafts} reviewDisabled={busy || submitting} />
    {item && <ReviewDetail key={item.id} item={item} snapshot={snapshot} onClose={() => setSelected(null)} onInspect={inspect} actions={image => <>{actionError && <p className="notice warn" role="alert">{actionError}</p>}<InlineImageReview item={item} image={image} draft={queue?.drafts[item.id]} onReview={review} disabled={busy || submitting}/><ReviewSubmitBar drafts={queue?.drafts || {}} busy={busy || submitting} disabled={!!queue && queue.baseRevision !== snapshot.revision} notice={reviewNotice} onSubmit={() => void submitReviews()} /><ImageActions key={`${item.id}-${image?.id || "none"}`} item={item} image={image} project={project} busy={busy} configured={configured} onGenerate={async (prompt, referenceAssetIds) => { setActionError(""); await act(async () => { try { await api(`/api/projects/${project.id}/image-generations`, "POST", { baseRevision: project.revision, idempotencyKey: idempotencyKey(), targets: [{ ...(item.type === "asset" ? { assetId: item.id } : { shotId: item.id }), ...(prompt ? { prompt } : {}), referenceAssetIds }]  }); update(await api<Project>(`/api/projects/${project.id}`)); return true; } catch (error) { setActionError(error instanceof Error ? error.message : "图片提交未完成"); throw error; } }, "图片任务已提交，可继续审阅其他资产"); }} onAction={candidateAction} /></>} />}
  </section>;
}
function ImageActions({ item, image, project, busy, configured, onGenerate, onAction }: { item: ReviewItem; image?: ReviewImage; project: Project; busy: boolean; configured: boolean; onGenerate: (prompt: string, referenceAssetIds: string[]) => Promise<void>; onAction: (id: string, action: "review" | "select", body: Record<string, unknown>, message: string) => Promise<void> }) {
  const [prompt, setPrompt] = useState(""), [generating, setGenerating] = useState(false);
  const identity = inspectImageConsistency(project, item.id);
  const requiredIdentity = [...identity.requiredSourceAssetIds, ...identity.requiredIdentityAssetIds];
  const referenceOptions = project.ontology.assets.filter(a => a.id !== item.id).flatMap(asset => {
    const mandatory = requiredIdentity.includes(asset.id);
    const identityReference = identity.identityReferences.find(r => r.assetId === asset.id);
    const fileId = identityReference?.fileId || asset.fileId || asset.previewImage?.fileId;
    const file = project.files.find(f => f.id === fileId);
    if (!file || !["image/png", "image/jpeg", "image/webp"].includes(file.mime)) return [];
    const candidate = project.artifacts.find(a => a.kind === "image" && a.fileId === file.id);
    const thumbnailId = typeof candidate?.metadata.thumbnailFileId === "string" && project.files.some(f => f.id === candidate.metadata.thumbnailFileId) ? candidate.metadata.thumbnailFileId : file.id;
    const approved = !!identityReference || !!candidate?.accepted || project.reviews.some(r => r.targetId === asset.id && r.targetHash === project.compiled.targetHashes[asset.id] && r.status === "pass");
    return [{ asset, file, mandatory, previewUrl:fileUrl(thumbnailId), approved, stale: !!candidate && project.imageCandidateCurrent?.[candidate.id] === false }];
  });
  const [referenceIds, setReferenceIds] = useState<string[]>(() => [...new Set([...requiredIdentity, ...referenceOptions.filter(r => !r.stale && (item.type === "shot" ? item.relatedIds : image?.parentIds || []).includes(r.asset.id)).map(r => r.asset.id)])].slice(0, 16));
  const generationConsistency = inspectImageConsistency(project, item.id, referenceIds);
  const missingReference = referenceIds.some(id => !referenceOptions.some(r => r.asset.id === id && !r.stale));
  const composedPrompt = () => {
    if (!prompt.trim()) return "";
    const baseline = item.type === "shot" ? `${project.compiled.prompts[item.id] || item.description}\n仅绘制本镜头开始时刻的单张首帧。不要画分镜拼图或添加字幕。` : `${item.title}。必须可见：${item.mustShow.join("；")}。拒收：${item.rejectIf.join("；")}。制作独立图片资产，不添加水印。`;
    return `${baseline}\n补充图片要求：${prompt.trim()}`;
  };
  const realCandidate = image && project.artifacts.some(a => a.id === image.id && a.kind === "image");
  const running = project.jobs.some(j => j.kind === "image" && (j.input?.target?.assetId === item.id || j.input?.target?.shotId === item.id) && ["queued", "running"].includes(j.state));
  return <div className="sf-review-actions">
    {realCandidate && image && <><div>
      <button disabled={busy} onClick={() => void onAction(image.id, "select", { baseRevision: project.revision, usage: "preview" }, "已切换审稿展示；视频输入保持原绑定")}>作为审稿展示图</button>
      <button disabled={busy || !image || image.stale || image.status !== "approved"} title={image?.status !== "approved" ? "先人工审核此候选" : undefined} onClick={() => void onAction(image.id, "select", { baseRevision: project.revision, usage: "production" }, item.type === "shot" ? "已采用为视频首帧，关联镜头需要重新审核" : "已采用为制作资产，关联镜头需要重新审核")}>{item.type === "shot" ? "采用为视频首帧" : "采用为制作资产"}</button>
    </div></>}
    {image?.stale && <p role="status">此图基于旧修订，保留供对比，不能作为当前制作输入。</p>}
    {image && !realCandidate && <p>这是已导入图片。其来源保持原样，可在“专属素材”中绑定并审核。</p>}
    <details className="image-generate-options"><summary>生成新的候选图</summary><p>为当前{item.type === "shot" ? "分镜" : "资产"}提交一次生图。旧候选会保留，不自动替换已批准输入。</p><label>补充图片要求<textarea aria-label="补充图片要求" value={prompt} onChange={e => setPrompt(e.target.value)} placeholder="留空时使用当前本体、素材和镜头约束" /></label><fieldset className="image-reference-picker"><legend>实际发送的参考图 · {referenceIds.length}/16</legend><p>指定原始参考与已批准角色基准固定勾选、不可取消，优先发送。其余场景和道具参考可选；实际文件和哈希由后台再校验。</p>{referenceOptions.length ? referenceOptions.map(ref => <label key={ref.asset.id}><input type="checkbox" aria-label={`参考图 ${ref.asset.label}`} checked={referenceIds.includes(ref.asset.id)} disabled={ref.mandatory || ref.stale || (referenceIds.length >= 16 && !referenceIds.includes(ref.asset.id))} onChange={e => setReferenceIds(ids => e.target.checked ? [...ids, ref.asset.id] : ids.filter(id => id !== ref.asset.id))} /><img src={ref.previewUrl} alt="" loading="lazy" /><span><b>{ref.asset.label}{ref.mandatory ? identity.requiredSourceAssetIds.includes(ref.asset.id) ? " · 原始参考锁定" : " · 身份锁定" : ""}</b><small>{ref.stale ? "旧父图 · 不能使用" : ref.approved ? "已审核素材" : "待审素材 · 下游仍待审"} · {ref.file.sha256.slice(0, 10)}</small></span></label>) : <p>暂无可发送的图片。当前将以文字生成，不会把网络来源地址当成已使用图片。</p>}{missingReference && <p role="alert">所选父图已经变化或缺失，请重新选择。</p>}</fieldset><button className="sf-primary" disabled={busy || !configured || generating || running || missingReference || !generationConsistency.ready} onClick={async () => { setGenerating(true); try { await onGenerate(composedPrompt(), referenceIds); } finally { setGenerating(false); } }}>{running ? "已有图片任务进行中" : "提交生成一个候选"}</button>{!configured && <p role="status">图片服务待配置，未提交生成。</p>}{!generationConsistency.ready && <p role="status">{generationConsistency.issues.map(issue => issue.message).join("；")}</p>}</details>
  </div>;
}

export function ProjectProgress({ project, onAction }: { project: Project; onAction: (stage: "requirements" | "expand" | "review" | "video", imageReview?: boolean) => void }) {
  const snapshot = useMemo(() => projectSnapshot(project, fileUrl), [project]);
  const total = snapshot.items.length, ready = snapshot.items.filter(i => i.image).length;
  const approved = snapshot.items.filter(i => i.image?.status === "approved" && !i.image.stale).length;
  const revisions = snapshot.items.filter(i => i.image?.needsRevision).length;
  const active = project.jobs.filter(j => ["queued", "running"].includes(j.state));
  const blocked = project.jobs.filter(j => ["blocked", "failed", "uncertain"].includes(j.state));
  const next = !project.ontology.shots.length ? { label: "展开故事与分镜", reason: "已有目标，接下来把它变成具体镜头。", stage: "expand" as const } : ready < total ? { label: "补齐专属资产图", reason: `${total - ready} 处图片尚未到位，先让每一个事物有对应素材。`, stage: "review" as const, images: true } : approved < total ? { label: "审核已生成图片", reason: `${ready - approved} 张图片等待判断${revisions ? `，其中${revisions}张有技术返修建议` : ""}。生成成功还需要内容确认。`, stage: "review" as const, images: true } : { label: "继续逐镜审核", reason: "图片已定稿，继续核对台词、医学依据和制作条件。", stage: "review" as const };
  return <section className="project-momentum" aria-label="当前影片进度"><div className="momentum-story"><span className="eyebrow">接着完成这部片子</span><h2>{active.length ? `${active.length} 项工作正在进行` : next.label}</h2><p>{active.length ? "后台任务会继续执行。你可以先审阅已经到位的内容。" : next.reason}</p><button className="primary" onClick={() => onAction(next.stage, next.images)}>{next.label} ↗</button></div><div className="momentum-assets">{snapshot.items.filter(i => i.image).slice(0,3).map(i => <button key={i.id} onClick={() => onAction("review", true)} aria-label={`查看${i.title}`}><img src={i.image!.thumbnailUrl || i.image!.url} alt={i.title} /><span>{i.title}</span></button>)}{!ready && <div className="momentum-gap">◇<span>真实资产将在这里延续故事</span></div>}</div><div className="momentum-counts"><span><b>{ready}/{total}</b>图片已到位</span><span><b>{approved}</b>人工已定稿</span><button onClick={() => onAction("video")}><b>{blocked.length}</b>待处理任务</button></div></section>;
}
