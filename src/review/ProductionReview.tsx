import { useState } from "react";
import type { PublicProduction, PublicProductionCandidate } from "../../shared/review-production";

const states: Record<string,string> = { queued:"已排队", running:"正在制作", waiting_review:"等待人工审核", blocked:"等待制作条件", uncertain:"受理待核对", failed:"制作未完成", complete:"已生成", cancelled:"已取消" };
const kinds: Record<string,string> = { video:"视频与原声", voice:"医生声音", lipsync:"医生口型", graphic:"医学动画", compose:"完整影片", final:"完整影片" };
const stages: Record<string,string> = { queued:"等待执行", preparing:"准备输入", submitting:"正在提交", polling:"等待供应商结果", downloading:"保存生成结果", rendering:"渲染与合成", complete:"生成结束", cancelled:"任务已取消", acceptance_unknown:"核对受理状态", provider_failed:"供应商未完成", dependency_blocked:"等待前置任务", review_dependency:"等待前置审核" };
export function ProductionReview({ data, authenticated, connected, error, onLogin, onReview, onTrim }: {
  data: PublicProduction | null; authenticated: boolean; connected: boolean; error?: string;
  onLogin: () => void;
  onReview: (candidate: PublicProductionCandidate, accepted: boolean, note: string) => Promise<void>;
  onTrim?: (candidate: PublicProductionCandidate, startMs: number, endMs: number) => Promise<void>;
}) {
  const [notes,setNotes] = useState<Record<string,string>>({}), [busy,setBusy] = useState<string|null>(null), [notice,setNotice] = useState("");
  const [ranges,setRanges] = useState<Record<string,{start:string;end:string}>>({});
  async function review(candidate: PublicProductionCandidate, accepted: boolean) {
    if (busy) return;
    setBusy(candidate.id); setNotice("");
    try { await onReview(candidate,accepted,notes[candidate.id] || ""); setNotice(accepted ? candidate.voiceTrim ? "裁剪声音已通过。请重新创建本镜头口型任务；已有口型任务不会静默换声。" : "审核已保存，后台会继续符合条件的已排队任务。" : "已保存不通过，本次操作不会自动追加生成。"); }
    catch(error) { setNotice(error instanceof Error ? error.message : "审核未保存，请稍后重试。"); }
    finally { setBusy(null); }
  }
  async function trim(candidate: PublicProductionCandidate) {
    if(!onTrim || busy) return;
    const range=ranges[candidate.id];
    const milliseconds=(value:string)=>/^\d+(?:\.\d{1,3})?$/.test(value) ? Math.round(Number(value)*1000) : NaN;
    const startMs=milliseconds(range?.start || ""),endMs=milliseconds(range?.end || "");
    if(!Number.isSafeInteger(startMs) || !Number.isSafeInteger(endMs) || endMs<=startMs) {setNotice("请明确填写起止秒数，最多三位小数，结束须晚于开始。");return;}
    if(candidate.shotDurationMs && endMs-startMs>candidate.shotDurationMs) {setNotice("所选音轨区间长于镜头，请重新选择；不会自动截断。");return;}
    setBusy(candidate.id);setNotice("");
    try {await onTrim(candidate,startMs,endMs);setNotice("裁剪声音已保存为新候选，原声保留。请重新听审，通过后重新创建本镜头口型任务。");}
    catch(error) {setNotice(error instanceof Error ? error.message : "裁剪未保存，请重试同一区间。");}
    finally {setBusy(null);}
  }
  return <div className="public-production" aria-label="视频制作与产物审核">
    <h3>视频制作与产物审核</h3>
    <p>下面是后台真实任务与已返回候选。按镜头核对人物、动作和原声后通过；医生声音需先听审，随后以同一音轨制作口型。通过仅继续已排队任务，缺素材或配置时保留等待原因。</p>
    {!connected ? <p className="sf-empty">此快照未连接制作后台。</p> : !data ? <p role="status">{error || "正在读取制作进度…"}</p> : <>
      {error && <p role="status">{error} · 以下为最近成功读取的状态。</p>}
      {!data.jobs.length && <p className="sf-empty">尚未创建视频制作任务。图片生成成功不代表视频已经开始。</p>}
      <div className="public-production-jobs">{data.jobs.map(job=><article key={job.id}><a href={job.shotId ? `#${job.shotId}` : "#production"}>{job.shotId || "成片"}</a><b>{kinds[job.kind] || "制作任务"}</b><span className={`sf-state ${job.state}`}>{states[job.state] || "待核对"}</span><small>{stages[job.stage] || "核对阶段"}{!job.current && " · 旧修订"}</small>{job.reason && <p>{job.reason}</p>}</article>)}</div>
      {!!data.candidates.length && !authenticated && <p><button onClick={onLogin}>登录审核视频与声音</button> · 访客可以观看、听审和下载。</p>}
      <div className="public-production-candidates">{data.candidates.map(candidate=><article key={candidate.id} id={`production-${candidate.id}`}>
        <header><h4>{candidate.shotId || "成片"} · {kinds[candidate.kind]}</h4><span className={`sf-state ${candidate.accepted ? "approved" : candidate.reviewed ? "change" : "pending"}`}>{!candidate.current ? "旧修订 · 仅供对照" : candidate.accepted ? "已通过制作审核" : candidate.reviewed ? "未通过" : "已生成 · 待审核"}</span></header>
        {candidate.kind === "voice" ? <audio aria-label={`${candidate.shotId}医生声音候选`} controls preload="none" src={candidate.url} /> : <video aria-label={`${candidate.shotId || "成片"}视频候选`} controls playsInline preload="none" src={candidate.url} />}
        {candidate.kind === "voice" && <p className="public-voice-timing">{candidate.durationMs ? `音轨 ${(candidate.durationMs/1000).toFixed(3)} 秒` : "音轨时长见播放器"}{candidate.shotDurationMs && ` · 镜头最多 ${(candidate.shotDurationMs/1000).toFixed(3)} 秒`}{candidate.voiceTrim && ` · 原声截取 ${candidate.voiceTrim.startMs/1000}–${candidate.voiceTrim.endMs/1000} 秒`}</p>}
        <a href={candidate.url} download={`${candidate.shotId || "film"}-${candidate.id}.${candidate.mime === "video/webm" ? "webm" : candidate.mime.startsWith("audio/") ? candidate.mime === "audio/mpeg" ? "mp3" : candidate.mime === "audio/mp4" ? "m4a" : candidate.mime === "audio/ogg" ? "ogg" : "wav" : "mp4"}`}>下载此候选</a>
        {authenticated && candidate.kind === "voice" && candidate.current && onTrim && <details className="public-voice-trim"><summary>明确选择声音区间</summary><p>只裁音轨，不变速、不自动选择区间。请保留完整台词；新候选需重新听审，再重新创建口型任务。</p><div>{(["start","end"] as const).map(field=><label key={field}>{field === "start" ? "开始" : "结束"}（秒）<input aria-label={`${candidate.id}${field === "start" ? "开始秒数" : "结束秒数"}`} type="number" min="0" step="0.001" placeholder="手动填写" value={ranges[candidate.id]?.[field] || ""} onChange={event=>setRanges({...ranges,[candidate.id]:{start:ranges[candidate.id]?.start || "",end:ranges[candidate.id]?.end || "",[field]:event.target.value}})} disabled={!!busy} /></label>)}</div><button disabled={!!busy || !ranges[candidate.id]?.start || !ranges[candidate.id]?.end} onClick={()=>void trim(candidate)}>裁剪为新声音候选</button></details>}
        {authenticated && candidate.kind !== "final" && <div className="public-production-review"><label>审核意见<textarea aria-label={`${candidate.shotId} ${kinds[candidate.kind]}审核意见`} value={notes[candidate.id] || ""} onChange={event=>setNotes({...notes,[candidate.id]:event.target.value})} rows={2} disabled={!!busy} placeholder="核对动作、原声、口型与医学内容，记录具体问题。" /></label><div><button disabled={!!busy || !candidate.current || candidate.accepted} onClick={()=>void review(candidate,true)}>{busy === candidate.id ? "正在保存…" : candidate.kind === "voice" ? candidate.voiceTrim ? "通过裁剪声音" : "通过声音并制作口型" : "通过并继续下一镜"}</button><button disabled={!!busy || !candidate.current} onClick={()=>void review(candidate,false)}>不通过</button></div></div>}
      </article>)}</div>
    </>}
    {notice && <p role="status">{notice}</p>}
  </div>;
}
