import React, { useEffect, useRef, useState } from "react";
import { ReviewPresentation, ReviewSubmitBar, type ReviewDraft, type ReviewItem, type ReviewImage, type ReviewSnapshot } from "./ReviewPresentation";
import { queueOpinion, reconfirmQueue, submissionItems, submissionNotice, type ImageReviewSubmission, type ReviewQueue } from "./reviewSubmission";

type OnlineSnapshot = ReviewSnapshot & {
  onlineReview?: { apiBase: string; projectId: string };
  imageJobs?: { id: string; targetId: string; state: string; reason?: string }[];
};
const jobLabels: Record<string, string> = { queued: "排队中", running: "正在生成", blocked: "等待条件", uncertain: "受理待核对", failed: "生成未完成", complete: "新候选已生成", cancelled: "已取消" };
function safeBase(value?: string) {
  return value && /^\/[a-zA-Z0-9/_-]+$/.test(value) && !value.includes("//") ? value.replace(/\/$/, "") : undefined;
}
export function PublicReview({ snapshot: initial }: { snapshot: ReviewSnapshot }) {
  const [snapshot, setSnapshot] = useState(initial as OnlineSnapshot);
  const online = (initial as OnlineSnapshot).onlineReview;
  const base = safeBase(online?.apiBase);
  const projectId = online?.projectId || initial.projectId;
  const key = `storyflow-review:${initial.projectId}:${initial.contentHash}`;
  const [queue, setQueue] = useState<ReviewQueue | null>(() => {
    try {
      if (typeof localStorage === "undefined") return null;
      const saved = JSON.parse(localStorage.getItem(key) || "null");
      if (saved?.drafts && Number.isInteger(saved.baseRevision)) return saved;
      if (saved?.scriptSha256 === initial.contentHash && Array.isArray(saved.items)) return { baseRevision: saved.revision, drafts: Object.fromEntries(saved.items.map((item: any) => [item.targetId, item])) };
    } catch { /* A browser draft never changes the server state. */ }
    return null;
  });
  const [authenticated, setAuthenticated] = useState(false), [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false), [notice, setNotice] = useState("");
  const [connection, setConnection] = useState(base ? "正在连接审稿后台…" : "本页尚未连接审稿后台，意见暂存本机；部署后台后才能提交并生成。");
  const [loginOpen, setLoginOpen] = useState(false);
  const [submission, setSubmission] = useState<ImageReviewSubmission | null>(null);
  const request = useRef<{ key: string; payload: string } | null>(queue?.request || null);
  const mounted = useRef(true);
  async function call<T>(path: string, method = "GET", body?: unknown): Promise<T> {
    if (!base) throw new Error("尚未连接审稿后台，未提交任何生成。");
    const response = await fetch(`${base}${path}`, { method, credentials: "same-origin", headers: body ? { "Content-Type": "application/json" } : undefined, body: body ? JSON.stringify(body) : undefined });
    const value = await response.json().catch(() => null);
    if (!response.ok || !value) {
      if (response.status === 401) { setAuthenticated(false); setLoginOpen(true); }
      throw new Error(value?.error || `审稿后台暂不可用（${response.status}），草稿仍在本页。`);
    }
    return value;
  }
  async function refresh() {
    const next = await call<OnlineSnapshot>(`/public-review/${encodeURIComponent(projectId)}`);
    if (next.projectId !== projectId || !Array.isArray(next.items)) throw new Error("后台工程与当前审稿页不一致，未更新图片。");
    if (mounted.current) { setSnapshot(next); setConnection("已连接审稿后台 · 图片与制作状态实时更新"); }
  }
  useEffect(() => {
    mounted.current = true;
    if (!base) return;
    void call<{ authenticated: boolean; setupRequired?: boolean }>("/auth").then(value => { if (mounted.current) setAuthenticated(value.authenticated); }).catch(error => { if (mounted.current) setConnection(error.message); });
    void refresh().catch(error => { if (mounted.current) setConnection(error.message); });
    const timer = setInterval(() => { void refresh().catch(error => { if (mounted.current) setConnection(error.message); }); }, 5000);
    return () => { mounted.current = false; clearInterval(timer); };
  }, [base, projectId]);
  useEffect(() => {
    if (!base || !authenticated) { setSubmission(null); return; }
    let cancelled = false;
    void call<{ submissions: ImageReviewSubmission[] }>(`/projects/${encodeURIComponent(projectId)}/review-submissions`).then(result => {
      if (cancelled || !Array.isArray(result.submissions)) return;
      const latest = result.submissions.filter(record => record.projectId === projectId).sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
      if (latest) setSubmission(current => current && current.createdAt >= latest.createdAt ? current : latest);
    }).catch(error => { if (!cancelled) setNotice(error instanceof Error ? `已保存意见暂未读回：${error.message}` : "已保存意见暂未读回，请稍后刷新。"); });
    return () => { cancelled = true; };
  }, [base, projectId, authenticated]);
  function save(next: ReviewQueue | null) {
    setQueue(next);
    try { if (next) localStorage.setItem(key, JSON.stringify(next)); else localStorage.removeItem(key); }
    catch { setNotice("浏览器无法暂存草稿，请保持页面打开并提交意见。"); }
  }
  const review = (item: ReviewItem, status: ReviewDraft["status"], note: string, selected?: ReviewImage) => {
    save(queueOpinion(queue, snapshot.revision, item, status, note, selected)); setNotice("");
  };
  async function login(event: React.FormEvent) {
    event.preventDefault(); setBusy(true); setNotice("");
    try { await call("/auth/login", "POST", { password }); setPassword(""); setAuthenticated(true); setLoginOpen(false); await refresh(); }
    catch (error) { setNotice(error instanceof Error ? error.message : "登录未完成"); }
    finally { setBusy(false); }
  }
  async function submitReviews() {
    if (!queue || busy || !authenticated) return;
    const body = { baseRevision: queue.baseRevision, items: submissionItems(queue) }, payload = JSON.stringify(body);
    if (request.current?.payload !== payload) request.current = { key: crypto.randomUUID(), payload };
    setBusy(true); setNotice("");
    try {
      const persistedQueue = { ...queue, request: request.current };
      try { localStorage.setItem(key, JSON.stringify(persistedQueue)); } catch { throw new Error("无法保存本次提交标识，尚未发送生成；请允许浏览器本地存储后重试。"); }
      setQueue(persistedQueue);
      const result = await call<{ submission: ImageReviewSubmission }>(`/projects/${encodeURIComponent(projectId)}/review-submissions`, "POST", { ...body, idempotencyKey: request.current.key });
      setSubmission(result.submission); save(null); request.current = null; setNotice(submissionNotice(result.submission));
      await refresh().catch(() => setConnection("意见已保存，图片状态刷新暂不可用；后台任务会继续。"));
    } catch (error) { setNotice(error instanceof Error ? error.message : "提交结果待核对，再次提交相同意见不会重复生成。"); }
    finally { setBusy(false); }
  }
  const reviewBar = <ReviewSubmitBar drafts={queue?.drafts || {}} busy={busy} disabled={!base || !authenticated || (!!queue && queue.baseRevision !== snapshot.revision)} reason={!base ? "尚未连接后台，不会伪装成已提交。" : !authenticated ? "登录审核后可提交；公开访客只能查看图片。" : undefined} notice={notice} onSubmit={() => void submitReviews()} />;
  return <><header className="public-top"><a href="#story" className="public-brand">映序 <span>StoryFlow</span></a><span>云动 · 真实资产审稿</span><span>{base ? "当前修订" : "固定快照"} V{snapshot.revision}</span></header>
    <nav className="public-nav" aria-label="审稿导航">{[["story", "故事"], ["assets", "资产图"], ["shots", "逐镜审稿"], ["production", "生成逻辑"], ["voice", "医生台词"], ["feedback", "意见与进度"]].map(([id, label]) => <a key={id} href={`#${id}`}>{label}</a>)}</nav>
    <main className="public-main"><div className="public-notice"><strong>看这张图，决定下一步。</strong><p>在图片下选择通过或不通过，写下具体修改意见后统一提交。通过只保存审核；返修按已批准的角色基准创建一次生成任务，新图回来后继续审。</p><div className="public-connection"><span role="status">{connection}</span>{base && !authenticated && <button onClick={() => setLoginOpen(!loginOpen)}>{loginOpen ? "收起登录" : "登录审核"}</button>}{authenticated && <span className="sf-state approved">已登录审核</span>}</div>{loginOpen && base && <form className="public-login" onSubmit={login}><label>审核密码<input aria-label="审核密码" type="password" autoComplete="current-password" value={password} onChange={event => setPassword(event.target.value)} required /></label><button disabled={busy || !password.trim()}>{busy ? "正在登录…" : "登录并继续审图"}</button><small>登录仅用于保存审核和触发返修，密码不会写入分享链接。</small></form>}</div>
    {queue && queue.baseRevision !== snapshot.revision && <div className="sf-review-conflict" role="status"><p>工程已更新到 V{snapshot.revision}，请重新核对当前图片。评论会保留，旧结论不会套用。</p><button onClick={() => save(reconfirmQueue(queue, snapshot))}>保留评论，重新核对当前图片</button></div>}
    {reviewBar}<ReviewPresentation snapshot={snapshot} onReview={review} reviewDrafts={queue?.drafts} reviewDisabled={busy} />
    <aside className="public-notice"><strong>需求 → 展开 → 审核 → 视频</strong><p>逐镜任务依赖由同一本体快照编译，按已保存的任务状态展示。先批准角色基准，再按同一人物身份、发型、服装和道具状态制作镜头。生成成功仍需人工核对。当前 Seedance 适配器仅发送首帧或纯文字；末态锚图是审稿目标，不能称为已传入控制。</p></aside>
    <section id="voice" className="sf-section"><header><span className="sf-kicker">逐句原声 → 听审 → 同音轨口型</span><h2>医生台词与声音计划</h2></header><div className="public-voices">{snapshot.items.filter(i => i.type === "shot" && i.dialogue?.some(d => d.startsWith("医生") || d.includes("指定医生"))).map(i => <article key={i.id}><small>{i.id} · 拟定台词，尚无本轮音频</small>{i.dialogue?.map((d, n) => <blockquote key={n}>{d}</blockquote>)}<p>声音逐句审过后，以同一审核声音的音轨驱动医生口型；图片通过不代表嘴型或声音通过。</p></article>)}</div></section>
    <section id="feedback" className="sf-section public-feedback"><header><span className="sf-kicker">意见交给后台，工作接着往前</span><h2>意见与返修进度</h2></header><p>未提交意见保留在当前浏览器。提交成功后由后台保存，关闭页面不影响已经排队的任务。</p>{reviewBar}<ul className="public-draft-list">{Object.entries(queue?.drafts || {}).map(([id, item]) => <li key={id}><a href={`#${id}`}>{id}</a> · {{ pass: "拟通过", change: "拟返修", pending: "未选结论" }[item.status]} · {item.note || "未填写意见"}</li>)}</ul>{authenticated && submission && <div className="public-submission"><b>最近提交已保存</b><small>仅登录审核可见 · {submission.createdAt}</small>{submission.items.map(item => <p key={item.targetId}><a href={`#${item.targetId}`}>{item.targetId}</a> · {{ approved: "图片已通过", queued: "返修任务已排队", blocked: "意见已保存，等待条件" }[item.outcome]}{item.blocked && `：${item.blocked.reason}`}{item.note && <span className="public-saved-opinion">审核意见：{item.note}</span>}</p>)}</div>}{!!snapshot.imageJobs?.length && <div className="public-image-jobs">{snapshot.imageJobs.map(job => <article key={job.id}><a href={`#${job.targetId}`}>{job.targetId}</a><span className={`sf-state ${job.state}`}>{jobLabels[job.state] || job.state}</span>{job.reason && <p>{job.reason}</p>}</article>)}</div>}<details><summary>修订与图片绑定</summary><p>当前内容哈希：<code>{snapshot.contentHash}</code></p><p>每条意见绑定当时的图片和内容版本。提交期间出现新修订时，后台会拒绝覆盖，草稿保留供核对；不会悄悄把旧图的通过套给新图。</p></details></section>
    <section className="sf-section"><h2>医学依据</h2><div className="public-evidence">{snapshot.evidence.map(e => <article key={e.id}><h3>{e.url ? <a href={e.url} target="_blank" rel="noreferrer">{e.title} ↗</a> : e.title}</h3><p>{e.excerpt}</p></article>)}</div></section><footer className="public-footer">映序 StoryFlow · {snapshot.totalFrames / snapshot.fps}秒 / {snapshot.fps}fps / {snapshot.totalFrames}帧 · 图片为 AI 演绎或教学示意，仍需内容与医学审核。</footer></main></>;
}
