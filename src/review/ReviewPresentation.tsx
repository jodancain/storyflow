import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type { Project } from "../../shared/types";
import { projectSnapshot, type ReviewImage, type ReviewItem, type ReviewSnapshot } from "./projectSnapshot";
export type { ReviewImage, ReviewItem, ReviewSnapshot } from "./projectSnapshot";

const labels: Record<string, string> = { pending: "生成成功 · 待审", approved: "人工已定稿", change: "需要返修", historical: "导入图片 · 待审", draft: "尚未提交", queued: "排队中", running: "正在制作", blocked: "等待条件", waiting_review: "等待审核", uncertain: "受理待核对", failed: "未完成", cancelled: "已取消", complete: "任务完成" };
const route: Record<string, string> = { video: "人物视频与原声", voice: "逐句声音", lipsync: "同音轨口型", graphic: "医学图示", compose: "后期与成片" };
export function ImageState({ image }: { image?: ReviewImage }) { return <span className="sf-image-state"><span className={`sf-state ${image?.status || "missing"}`}>{image ? image.stale ? "旧修订 · 仅供对照" : image.origin === "imported" ? image.status === "approved" ? "导入图片 · 已审核" : image.status === "change" ? "导入图片 · 需要返修" : "导入图片 · 待审" : labels[image.status] : "资产尚未生成"}</span>{image?.needsRevision && <span className="sf-tech-state">技术建议返修</span>}{image?.consistencyEvidence === "legacy-unverified" && <span className="sf-tech-state">旧版候选 · 一致性需重新核对</span>}</span>; }
export type ReviewDraft = { status: "pending" | "pass" | "change"; note: string; imageId?: string; imageSha256?: string; targetHash?: string };
export type ReviewHandler = (item: ReviewItem, status: ReviewDraft["status"], note: string, image?: ReviewImage) => void;

export function InlineImageReview({ item, image = item.image, draft, onReview, disabled = false }: { item: ReviewItem; image?: ReviewImage; draft?: ReviewDraft; onReview: ReviewHandler; disabled?: boolean }) {
  const matches = !draft?.imageId || draft.imageId === image?.id;
  const status = matches ? draft?.status || "pending" : "pending";
  const note = matches ? draft?.note || "" : "";
  return <div className="sf-inline-review" aria-label={`${item.title}图片审核`}>
    <div className="sf-inline-decisions" role="group" aria-label={`${item.id}审核结论`}>
      <button aria-pressed={status === "pass"} disabled={disabled || !image || image.stale} onClick={() => onReview(item, status === "pass" ? "pending" : "pass", note, image)}><span aria-hidden="true">✓</span> 通过</button>
      <button aria-pressed={status === "change"} disabled={disabled || !image} onClick={() => onReview(item, status === "change" ? "pending" : "change", note, image)}><span aria-hidden="true">↺</span> 不通过</button>
    </div>
    <label><span>修改意见{status === "change" ? " · 必填" : " · 可选"}</span><textarea aria-label={`${item.id}图片修改意见`} value={note} disabled={disabled || !image} onChange={e => onReview(item, status, e.target.value, image)} placeholder="请说明需要调整的部位、动作或构图。" rows={2} /></label>
    {draft && matches && <small className="sf-unsent-note">{status === "pending" ? "请选择通过或不通过后提交" : status === "change" && !note.trim() ? "写下修改要求后，再提交返修" : "意见未提交 · 提交后由后台接着办"}</small>}
    {image?.stale && <small>此候选来自旧修订，可提交返修意见；不能直接通过。</small>}
    {!image && <small>图片尚未到位，不能标记通过。</small>}
  </div>;
}

export function ReviewSubmitBar({ drafts, busy, disabled, reason, notice, onSubmit }: { drafts: Record<string, ReviewDraft>; busy: boolean; disabled?: boolean; reason?: string; notice?: string; onSubmit: () => void }) {
  const entries = Object.values(drafts), pass = entries.filter(d => d.status === "pass").length, change = entries.filter(d => d.status === "change").length;
  const invalid = entries.some(d => d.status === "pending" || (d.status === "change" && !d.note.trim()) || !d.imageId);
  return <div className="sf-submit-bar" aria-label="提交图片审核"><div><b>{entries.length ? `${entries.length} 项意见待提交` : "在图片下直接审核"}</b><p>{entries.length ? `通过 ${pass} 项 · 返修 ${change} 项${invalid ? " · 请补齐结论和修改要求" : ""}` : "通过的图片留下，不通过的按你的意见重新制作。"}</p><small>{reason || (change ? `本次最多生成 ${change} 张返修图；前置角色待审会先等待，旧图保留。` : "通过只保存审核，不调用生图。")}</small>{notice && <p role="status" className="sf-submit-notice">{notice}</p>}</div><button className="sf-primary" disabled={busy || disabled || !entries.length || invalid} onClick={onSubmit}>{busy ? "正在提交意见…" : change ? "提交意见并生成返修图" : "提交审核意见"}</button></div>;
}

function ImageAttemptNote({item}:{item:ReviewItem}) {
  return item.imageAttempt ? <div className="sf-check sf-attempt-note" role="note"><b>{item.imageAttempt.state === "failed" ? "生成未完成" : "前置条件阻塞"} · 外部批次记录</b><p>{item.imageAttempt.reason}</p><small>{item.imageAttempt.submitted ? `已提交${item.imageAttempt.imagePostNumber ? ` · 第${item.imageAttempt.imagePostNumber}次` : ""}` : "未提交生成"} · {item.imageAttempt.code}{item.imageAttempt.blockingParent ? ` · 前置资产 ${item.imageAttempt.blockingParent}` : ""}</small><p>此记录仅说明已有批次情况，不会自动重投。</p></div> : null;
}
export function ConsistencyNotice({ item, availableIds = [] }: { item: ReviewItem; availableIds?: string[] }) {
  const consistency = item.consistency;
  if (!consistency) return null;
  return <div className={`sf-consistency-note ${consistency.isIdentityMaster ? "is-master" : ""}`}>
    <b>{consistency.isIdentityMaster ? "人物一致性 · 角色基准" : !consistency.requiredAssetIds.length ? consistency.ready ? "本画面不出现人物" : "制作条件待处理" : consistency.ready ? "人物一致性 · 基准已就绪" : "人物一致性 · 等待角色基准"}</b>
    {consistency.isIdentityMaster && <p>先确认这份身份基准。后续保留相同身份特征，可见部位、服装与动作按每镜要求锁定。</p>}
    {!!consistency.requiredAssetIds.length && <p>统一引用 {consistency.requiredAssetIds.map((id, index) => <span key={id}>{index > 0 && "、"}{availableIds.includes(id) ? <a href={`#${id}`}>{id}</a> : <span>{id} · {consistency.ready ? "原始参考已在工作台审核" : "原始参考需在工作台上传审核"}</span>}</span>)}</p>}
    {!!consistency.issues.length && <details><summary>{consistency.issues.length} 项制作条件待处理</summary>{consistency.issues.map((issue, i) => <p key={i}>{issue}</p>)}</details>}
  </div>;
}
export function ReviewImageCard({ item, onInspect, onReview, reviewDraft, reviewDisabled, availableIds }: { availableIds?: string[]; item: ReviewItem; onInspect: (id: string) => void; onReview?: ReviewHandler; reviewDraft?: ReviewDraft; reviewDisabled?: boolean }) {
  return <article className={`sf-image-card sf-${item.type}`} id={`item-${item.id}`}>
    <span id={item.id} className="sf-anchor" /><button className="sf-image-button" onClick={() => onInspect(item.id)} aria-label={`审图：${item.title}`}>
      {item.image ? <img src={item.image.thumbnailUrl || item.image.url} alt={item.title} loading="lazy" /> : <div className="sf-image-gap"><span>◇</span><b>等待这张专属图片</b><small>参考图不会代替制作资产</small></div>}
      <ImageState image={item.image} />
    </button>
    <div className="sf-card-body"><small className="sf-kicker">{item.id}{item.type === "shot" ? " · 分镜首帧" : " · 专属资产"}</small><h3>{item.title}</h3><p>{item.description}</p><ImageAttemptNote item={item}/><ConsistencyNotice item={item} availableIds={availableIds}/>{onReview && <InlineImageReview item={item} draft={reviewDraft} onReview={onReview} disabled={reviewDisabled} />}<div className="sf-card-meta"><span>{item.candidates.length} 个候选 · {item.relatedIds.length} 个关联</span><button onClick={() => onInspect(item.id)}>查看与审图 ↗</button></div></div>
  </article>;
}
export function ReviewDetail({ item, snapshot, onClose, onInspect, actions, onReview, reviewDraft }: { item: ReviewItem; snapshot: ReviewSnapshot; reviewDraft?: ReviewDraft; onClose: () => void; onInspect?: (id: string) => void; actions?: (image?: ReviewImage) => ReactNode; onReview?: (item: ReviewItem, status: "pending" | "pass" | "change", note: string, image?: ReviewImage) => void }) {
  const [selectedId, setSelectedId] = useState(reviewDraft?.imageId || item.image?.id || "");
  const [compareId, setCompareId] = useState("");
  const [note, setNote] = useState(reviewDraft?.note || "");
  const [reviewFeedback, setReviewFeedback] = useState("");
  const [zoom, setZoom] = useState(false);
  const dialog = useRef<HTMLElement>(null);
  const closeRef = useRef(onClose); closeRef.current = onClose;
  const current = item.candidates.find(i => i.id === selectedId) || item.image;
  const compare = item.candidates.find(i => i.id === compareId);
  useEffect(() => { setSelectedId(reviewDraft?.imageId || item.image?.id || ""); setCompareId(""); setNote(reviewDraft?.note || ""); setReviewFeedback(""); }, [item.id]);
  const selectCandidate = (id: string) => { setSelectedId(id); setNote(reviewDraft?.imageId === id ? reviewDraft.note : ""); setReviewFeedback(""); };
  async function saveOpinion(status: ReviewDraft["status"]) {
    if (!onReview) return;
    try { await onReview(item, status, note, current); setReviewFeedback("意见已加入待提交清单，提交后保存到后台。"); }
    catch (error) { setReviewFeedback(error instanceof Error ? error.message : "意见暂未保存，请保留内容后重试。"); }
  }
  useEffect(() => {
    const before = document.body.style.overflow; const focusBefore = document.activeElement as HTMLElement | null;
    document.body.style.overflow = "hidden"; dialog.current?.focus();
    const key = (e: KeyboardEvent) => {
      if (e.key === "Escape") { e.preventDefault(); closeRef.current(); }
      if (e.key === "Tab") {
        const controls = [...(dialog.current?.querySelectorAll<HTMLElement>('button:not(:disabled),a[href],select,textarea,input,[tabindex="0"]') || [])].filter(n => n.getClientRects().length);
        if (!controls.length) return; const first = controls[0], last = controls.at(-1)!;
        if (e.shiftKey && (document.activeElement === first || document.activeElement === dialog.current)) { e.preventDefault(); last.focus(); }
        else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
      }
    };
    document.addEventListener("keydown", key);
    return () => { document.body.style.overflow = before; document.removeEventListener("keydown", key); focusBefore?.focus({ preventScroll: true }); };
  }, []);
  return <div className="sf-dialog-backdrop" onClick={e => { if (e.target === e.currentTarget) onClose(); }}><section ref={dialog} tabIndex={-1} className="sf-dialog" role="dialog" aria-modal="true" aria-label={`审图：${item.title}`}>
    <header className="sf-dialog-head"><div><small>{item.id} · {item.type === "shot" ? "分镜首帧" : "专属资产"}</small><h2>{item.title}</h2></div><button className="sf-close" onClick={onClose} aria-label="关闭审图">×</button></header>
    <div className="sf-detail-grid"><div><div className={`sf-detail-images ${compare ? "comparing" : ""} ${zoom ? "zoomed" : ""}`}>
      {current ? <figure><button onClick={() => setZoom(!zoom)} aria-label={zoom ? "适应画面" : "放大原图"}><img src={current.url} alt={`${item.title}当前候选`} /></button><figcaption><ImageState image={current} /><a href={current.url} target="_blank" rel="noreferrer">打开原图 ↗</a></figcaption></figure> : <div className="sf-image-gap"><span>◇</span>等待专属资产</div>}
      {compare && <figure><img src={compare.url} alt={`${item.title}对比候选`} /><figcaption><ImageState image={compare} />对比候选</figcaption></figure>}
    </div>
    {!!item.candidates.length && <div className="sf-candidates" aria-label="图片候选">{item.candidates.map((candidate, i) => <button key={candidate.id} aria-pressed={current?.id === candidate.id} onClick={() => selectCandidate(candidate.id)}><img src={candidate.thumbnailUrl || candidate.url} alt={`候选 ${i + 1}`} /><span>候选 {i + 1}</span></button>)}</div>}
    {item.candidates.length > 1 && <label className="sf-compare-label">并排比较<select value={compareId} onChange={e => setCompareId(e.target.value)}><option value="">不比较</option>{item.candidates.filter(c => c.id !== current?.id).map((c, i) => <option key={c.id} value={c.id}>候选 {item.candidates.indexOf(c) + 1} · {labels[c.status]}</option>)}</select></label>}
    </div><div className="sf-detail-copy"><p>{item.description}</p>{current?.note && <div className="sf-check sf-candidate-note" role="note"><b>候选检查记录</b><p>{current.note}</p><small>检查意见供本次审图参考，不代表此图已经人工定稿。</small></div>}<ImageAttemptNote item={item}/>{item.type === "shot" && <div className="sf-shot-spec"><span>{((item.startFrame || 0) / snapshot.fps).toFixed(1)}–{((item.endFrame || 0) / snapshot.fps).toFixed(1)}秒</span><span>{item.scale}</span><span>{item.camera}</span></div>}
      {!!item.mustShow.length && <div className="sf-check"><b>必须看见</b><p>{item.mustShow.join("；")}</p></div>}{!!item.rejectIf.length && <div className="sf-check"><b>不能替代 / 拒收条件</b><p>{item.rejectIf.join("；")}</p></div>}
      {item.dialogue?.map((d, i) => <blockquote key={i}>{d}</blockquote>)}{!!item.subtitles?.length && <p className="sf-caption">字幕：{item.subtitles.join(" / ")}</p>}
      {item.type === "shot" && <p className="sf-binding-note">审稿展示与生成首帧独立保存。{item.firstFrameId ? item.firstFrameId === current?.fileId ? "当前候选已绑定为视频首帧。" : "视频首帧已绑定其他图片。" : "尚未采用图片作为视频首帧。"}</p>}
      {!!item.relatedIds.length && <div className="sf-related"><b>关联{item.type === "shot" ? "资产" : "镜头"}</b>{item.relatedIds.map(id => { const related = snapshot.items.find(i => i.id === id); return <button key={id} onClick={() => onInspect?.(id)}>{related?.image && <img src={related.image.thumbnailUrl || related.image.url} alt="" />}<span>{id} · {related?.title || id}</span></button>; })}</div>}
      {actions?.(current)}
      {onReview && <div className="sf-review-actions">{reviewFeedback && <p role="status" className="sf-review-feedback">{reviewFeedback}</p>}<label>审图意见<textarea aria-label="图片审稿意见" value={note} onChange={e => setNote(e.target.value)} placeholder="身份、症状、构图，哪里需要调整？" /></label><div><button onClick={() => void saveOpinion("pending")}>保存意见</button><button onClick={() => void saveOpinion("change")}>需要修改</button><button className="sf-primary" disabled={!current} onClick={() => void saveOpinion("pass")}>确认通过</button></div></div>}
      <details className="sf-source"><summary>来源、实际模型与图像版本</summary><p>{current?.origin === "generated" ? "AI 生成候选，等待内容审核。" : "导入素材，保留原始来源。"}</p>{current && <><p>请求模型：{current.modelRequested || "未记录"}<br />供应商回传模型：{current.modelActual || "未回传，不推断"}</p><p className="sf-hash">SHA-256：{current.sha256 || "未记录"}</p><p>实际父图：{current.parentIds.join("、") || "无 / 未记录"}</p></>}{item.source && <p>{item.source.author} · {item.source.license}<br />{item.source.use}{item.source.url && <a href={item.source.url} target="_blank" rel="noreferrer">原始来源 ↗</a>}</p>}</details>
      {!!item.references.length && <details className="sf-source"><summary>网络来源与形态依据（不作为制作图）</summary>{item.references.map(r => <div key={r.id}>{r.imageUrl && <img src={r.imageUrl} alt={r.title} loading="lazy" />}<b>{r.title}</b><p>{r.note}</p>{r.url && <a href={r.url} target="_blank" rel="noreferrer">查看依据 ↗</a>}</div>)}</details>}
    </div></div>
  </section></div>;
}


export function ReviewFlowDiagram({ snapshot, onInspect }: { snapshot: ReviewSnapshot; onInspect: (id: string) => void }) {
  const depths = new Map<string, number>();
  function depth(id: string, seen = new Set<string>()): number {
    if (depths.has(id)) return depths.get(id)!;
    if (seen.has(id)) return 0;
    const node = snapshot.flow.find(n => n.id === id); if (!node) return 0;
    const next = new Set([...seen, id]);
    const value = node.dependsOn.length ? Math.max(...node.dependsOn.map(p => depth(p, next))) + 1 : 0;
    depths.set(id, value); return value;
  }
  snapshot.flow.forEach(n => depth(n.id));
  const levels = [...new Set(depths.values())].sort((a, b) => a - b);
  const width = Math.max(330, ...levels.map(level => snapshot.flow.filter(n => depths.get(n.id) === level).length * 300 + 20));
  const height = Math.max(300, levels.length * 305 + 30);
  const positions = new Map<string, { x: number; y: number }>();
  levels.forEach(level => { const nodes = snapshot.flow.filter(n => depths.get(n.id) === level); nodes.forEach((node, index) => positions.set(node.id, { x: (width - nodes.length * 300) / 2 + index * 300 + 10, y: level * 305 + 15 })); });
  return <div className="sf-graph-scroll" tabIndex={0} aria-label="真实制作依赖框图，可滚动"><div className="sf-production-flow" style={{ width, minHeight: height }}>
    <svg className="sf-flow-edges" width={width} height={height} aria-label="制作依赖连线"><defs><marker id="sf-dependency-arrow" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="6" markerHeight="6" orient="auto"><path d="M0 0 L10 5 L0 10Z" fill="#b1a4c6" /></marker></defs>{snapshot.flow.flatMap(node => node.dependsOn.map(parent => { const from = positions.get(parent), to = positions.get(node.id); if (!from || !to) return null; const x = from.x + 140, y = from.y + 257, tx = to.x + 140, ty = to.y - 6; return <path key={`${parent}-${node.id}`} d={`M${x} ${y} V${y + 22} H${tx} V${ty}`} stroke="#b1a4c6" strokeWidth="1.5" fill="none" markerEnd="url(#sf-dependency-arrow)"><title>{`${parent} → ${node.id}`}</title></path>; }))}</svg>
    {snapshot.flow.map(node => { const position = positions.get(node.id)!; return <article key={node.id} id={`flow-${node.id}`} className="sf-flow-node" style={{ left: position.x, top: position.y }}><div className="sf-flow-title"><small>{route[node.kind] || node.kind}</small><span className={`sf-state ${node.state}`}>{labels[node.state] || node.state}</span></div><h3>{node.outputId ? <button onClick={() => onInspect(node.outputId!)}>{node.title} ↗</button> : node.title}</h3><div className="sf-flow-images">{[...new Set([...node.inputIds, ...(node.outputId ? [node.outputId] : [])])].map(id => { const input = snapshot.items.find(i => i.id === id); return input && <button key={id} onClick={() => onInspect(id)} title={input.title}>{input.image ? <img src={input.image.thumbnailUrl || input.image.url} alt={input.title} loading="lazy" /> : <span>◇</span>}<small>{id === node.outputId ? "审稿首帧" : "输入资产"} · {id}</small></button>; })}</div><div className="sf-flow-dependency">{node.dependsOn.length ? <>前置节点 {node.dependsOn.map(id => <a key={id} href={`#flow-${id}`}>{id} ↗</a>)}</> : "起始节点 · 审核通过后可提交"}</div>{node.reason && <p className="sf-flow-reason" title={node.reason}>{node.reason}</p>}</article>; })}
  </div></div>;
}

export function ReviewPresentation({ snapshot: given, project, fileUrl = id => `/api/files/${encodeURIComponent(id)}`, section = "all", onInspect, onReview, reviewDrafts, reviewDisabled }: { reviewDisabled?: boolean; snapshot?: ReviewSnapshot; project?: Project; reviewDrafts?: Record<string, ReviewDraft>; fileUrl?: (id: string) => string; section?: "all" | "assets" | "shots" | "production"; onInspect?: (id: string) => void; onReview?: (item: ReviewItem, status: "pending" | "pass" | "change", note: string, image?: ReviewImage) => void }) {
  const snapshot = useMemo(() => given || (project ? projectSnapshot(project, fileUrl) : undefined), [given, project, fileUrl]);
  const [filter, setFilter] = useState("all"), [query, setQuery] = useState(""), [selected, setSelected] = useState<string | null>(null);
  if (!snapshot) return null;
  const inspect = (id: string) => onInspect ? onInspect(id) : setSelected(id);
  const item = snapshot.items.find(i => i.id === selected);
  const ready = snapshot.items.filter(i => i.image).length, approved = snapshot.items.filter(i => i.image?.status === "approved" && !i.image.stale).length;
  const cards = (type: ReviewItem["type"]) => snapshot.items.filter(i => i.type === type && (!query || `${i.title} ${i.id} ${i.description}`.includes(query)) && (filter === "all" || (filter === "missing" ? !i.image : filter === "change" ? i.image?.status === "change" || i.image?.needsRevision : i.image?.status === filter))).sort((a, b) => Number(!!b.consistency?.isIdentityMaster) - Number(!!a.consistency?.isIdentityMaster));
  return <div className="sf-presentation">
    {section === "all" && <section id="story" className="sf-story-overview"><div><span className="sf-kicker">我们正在完成的影片 · V{snapshot.revision}</span><h2>{snapshot.title}</h2><p>{snapshot.totalFrames / snapshot.fps} 秒 · {snapshot.fps}fps · {snapshot.items.filter(i => i.type === "shot").length} 镜。先确认每张真实资产，再进入视频制作。</p></div><div className="sf-overview-stats"><span><b>{ready}/{snapshot.items.length}</b>图片已到位</span><span><b>{approved}</b>人工已定稿</span><span><b>{snapshot.items.length - ready}</b>资产缺口</span></div></section>}
    {section !== "production" && <div className="sf-filterbar"><label><span className="sf-sr-only">搜索资产与分镜</span><input aria-label="搜索资产与分镜" value={query} onChange={e => setQuery(e.target.value)} placeholder="搜索资产、镜头或内容…" /></label><select aria-label="筛选图片状态" value={filter} onChange={e => setFilter(e.target.value)}><option value="all">全部图片</option><option value="pending">生成成功 · 待审</option><option value="approved">人工已定稿</option><option value="change">需要返修</option><option value="missing">尚未生成</option></select></div>}
    {(section === "all" || section === "assets") && <section id="assets" className="sf-section"><header><span className="sf-kicker">先认清每一个事物</span><h2>专属资产图</h2><p>角色、场景、道具和症状各有自己的制作图。网络参考在详情中单独查看。</p></header><div className="sf-image-grid">{cards("asset").map(i => <ReviewImageCard key={i.id} item={i} availableIds={snapshot.items.map(item => item.id)} onInspect={inspect} onReview={onReview} reviewDraft={reviewDrafts?.[i.id]} reviewDisabled={reviewDisabled} />)}</div>{!cards("asset").length && <p className="sf-empty">当前筛选没有图片资产。</p>}</section>}
    {(section === "all" || section === "shots") && <section id="shots" className="sf-section"><header><span className="sf-kicker">让图片进入故事</span><h2>逐镜首帧与故事</h2><p>点击核对人物、动作、医学对应和台词。审稿图不会自动成为模型输入。</p></header><div className="sf-image-grid sf-shot-grid">{cards("shot").map(i => <ReviewImageCard key={i.id} item={i} availableIds={snapshot.items.map(item => item.id)} onInspect={inspect} onReview={onReview} reviewDraft={reviewDrafts?.[i.id]} reviewDisabled={reviewDisabled} />)}</div>{!cards("shot").length && <p className="sf-empty">当前筛选没有分镜。</p>}</section>}
    {(section === "all" || section === "production") && <section id="production" className="sf-section"><header><span className="sf-kicker">素材 → 视频与声音 → 审核 → 后期</span><h2>制作依赖与当前状态</h2><p>图片到位不代表视频已经制作。每个节点按实际任务显示状态。</p></header><ReviewFlowDiagram snapshot={snapshot} onInspect={inspect} /></section>}
    {item && <ReviewDetail key={item.id} item={item} snapshot={snapshot} onClose={() => setSelected(null)} onInspect={setSelected} onReview={onReview} reviewDraft={reviewDrafts?.[item.id]} />}
  </div>;
}
