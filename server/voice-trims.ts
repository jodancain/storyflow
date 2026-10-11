import type express from "express";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "./store.ts";
import { probe } from "./media.ts";
import { hash } from "../shared/ontology.ts";
import { AppError, ensure, sha } from "./util.ts";

interface VoiceTrimInput {
  baseRevision: number; fileId: string; fileSha256: string; sourceHash: string;
  startMs: number; endMs: number; idempotencyKey: string;
}
interface VoiceTrimResult { artifactId: string; jobId: string; fileId: string; sha256: string; durationMs: number; accepted: false }
const exec = promisify(execFile);
const inFlight = new WeakMap<Store, Map<string, { hash: string; promise: Promise<VoiceTrimResult> }>>();
function trimInput(value: unknown): VoiceTrimInput {
  ensure(value && typeof value === "object" && !Array.isArray(value), "需要明确的声音裁剪参数");
  const v=value as VoiceTrimInput;
  ensure(Number.isInteger(v.baseRevision) && v.baseRevision>0, "需要有效的baseRevision");
  ensure(typeof v.fileId === "string" && v.fileId.length>0 && v.fileId.length<=200, "需要原声音文件ID");
  ensure(typeof v.fileSha256 === "string" && /^[a-f0-9]{64}$/.test(v.fileSha256) && typeof v.sourceHash === "string" && /^[a-f0-9]{64}$/.test(v.sourceHash), "需要原音轨与生成内容哈希");
  ensure(Number.isSafeInteger(v.startMs) && Number.isSafeInteger(v.endMs) && v.startMs>=0 && v.endMs>v.startMs && v.endMs<=3600000, "起止时间必须为明确的整数毫秒，且结束晚于开始");
  ensure(typeof v.idempotencyKey === "string" && /^[A-Za-z0-9_-]{8,128}$/.test(v.idempotencyKey), "需要8–128位幂等键");
  return {baseRevision:v.baseRevision,fileId:v.fileId,fileSha256:v.fileSha256,sourceHash:v.sourceHash,startMs:v.startMs,endMs:v.endMs,idempotencyKey:v.idempotencyKey};
}
function currentVoice(store: Store, artifactId: string, input: VoiceTrimInput) {
  const voice=store.artifact(artifactId), project=store.project(voice.projectId), file=store.file(voice.fileId);
  ensure(voice.kind === "voice" && voice.shotId, "只能裁剪已登记的声音候选", 400, "voice_required");
  ensure(project.revision === input.baseRevision, "工程已更新，请重新核对声音裁剪区间", 409, "revision_conflict");
  ensure(voice.sourceHash === input.sourceHash && voice.sourceHash === project.compiled.shotHashes[voice.shotId], "声音属于旧的生成版本", 409, "stale_voice");
  ensure(file.projectId === project.id && file.id === input.fileId && file.sha256 === input.fileSha256, "原音轨绑定已变化", 409, "voice_hash_conflict");
  ensure(["audio/wav","audio/x-wav","audio/mpeg","audio/mp4","audio/ogg"].includes(file.mime) && file.bytes<=128*1024*1024, "声音格式或大小不支持裁剪");
  const shot=project.ontology.shots.find(s=>s.id === voice.shotId);
  ensure(shot, "声音所属镜头不存在", 404);
  ensure((input.endMs-input.startMs)*project.ontology.spec.fps <= (shot.endFrame-shot.startFrame)*1000, "裁剪后声音不能长于本镜头；请明确选择更短区间", 400, "audio_too_long");
  return {voice,project,file};
}
/** Local-only deterministic audio cut. Does not change speed, approve, select, or submit any model. */
export async function trimVoice(store: Store, artifactId: string, value: unknown): Promise<VoiceTrimResult> {
  const input=trimInput(value), original=store.artifact(artifactId), key=`voice-trim:${input.idempotencyKey}`;
  const inputHash=hash({operation:"voice-trim",artifactId,...input});
  const prior=store.action(original.projectId,key,inputHash) as VoiceTrimResult|null;
  if(prior) return prior;
  currentVoice(store,artifactId,input);
  let pending=inFlight.get(store); if(!pending) {pending=new Map();inFlight.set(store,pending);}
  const pendingKey=`${original.projectId}:${key}`, active=pending.get(pendingKey);
  if(active) {ensure(active.hash === inputHash,"幂等键已用于不同输入",409,"idempotency_conflict");return active.promise;}
  const execute=async():Promise<VoiceTrimResult>=>{
    // bytes() verifies the original content hash; media files are immutable content-addressed inputs.
    store.bytes(input.fileId);
    const source=await probe(store.filePath(input.fileId));
    const sampleRate=Number(source.audio?.sample_rate), channels=Number(source.audio?.channels);
    ensure(source.audio && Number.isInteger(sampleRate) && sampleRate>=8000 && sampleRate<=192000 && Number.isInteger(channels) && channels>=1 && channels<=8, "原声音缺少有效采样信息");
    const sourceSeconds=Number(source.audio.duration || source.duration);
    ensure(Number.isFinite(sourceSeconds) && sourceSeconds>0 && input.endMs/1000 <= sourceSeconds, "裁剪区间超出原音轨",400,"audio_trim_out_of_bounds");
    const startSample=Math.round(input.startMs*sampleRate/1000), endSample=Math.round(input.endMs*sampleRate/1000);
    const directory=await mkdtemp(join(tmpdir(),"storyflow-voice-trim-")), output=join(directory,"trimmed.wav");
    try {
      try {
        await exec(process.env.FFMPEG_PATH || process.env.FFMPEG || "ffmpeg",["-v","error","-nostdin","-y","-i",store.filePath(input.fileId),"-map","0:a:0","-vn","-af",`atrim=start_sample=${startSample}:end_sample=${endSample},asetpts=PTS-STARTPTS`,"-ar",String(sampleRate),"-ac",String(channels),"-c:a","pcm_s16le",output],{timeout:120000,maxBuffer:1024*1024});
      } catch {throw new AppError("本地声音裁剪未完成，请检查FFmpeg配置；未创建新候选",500,"voice_trim_failed");}
      const info=await probe(output), expected=(endSample-startSample)/sampleRate;
      ensure(info.audio && Math.abs(info.duration-expected)<=1/sampleRate+0.000001 && Number(info.audio.sample_rate) === sampleRate, "裁剪音轨时长校验失败，未保存候选",500,"voice_trim_mismatch");
      const bytes=await readFile(output);
      return store.transaction(()=>{
        const existing=store.action(original.projectId,key,inputHash) as VoiceTrimResult|null; if(existing) return existing;
        const {voice,project}=currentVoice(store,artifactId,input);store.bytes(input.fileId);
        const trim={version:1,parentArtifactId:voice.id,parentFileId:input.fileId,parentSha256:input.fileSha256,parentSourceHash:input.sourceHash,startMs:input.startMs,endMs:input.endMs,startSample,endSample,sampleRate,sourceDurationMs:Math.round(sourceSeconds*1000)};
        const file=store.addFile(project.id,`${voice.shotId}-voice-trim.wav`,"audio/wav",bytes);
        // Created complete in this transaction: the model worker never sees a queued local trim.
        const job=store.addJob({projectId:project.id,runId:`local-${input.idempotencyKey}`,kind:"voice",shotId:voice.shotId,dependsOn:[],inputHash,input:{operation:"voice-trim",generationHash:voice.sourceHash,voiceTrim:trim}});
        const candidate=store.addArtifact({projectId:project.id,jobId:job.id,shotId:voice.shotId,kind:"voice",fileId:file.id,sourceHash:voice.sourceHash,metadata:{operation:"voice-trim",voiceTrim:trim,duration:info.duration,audio:{sample_rate:sampleRate,channels},requiresListeningReview:true}});
        store.updateJob(job.id,{state:"complete",stage:"complete",progress:1,result:{artifactId:candidate.id,operation:"voice-trim"}});
        const result:VoiceTrimResult={artifactId:candidate.id,jobId:job.id,fileId:file.id,sha256:sha(bytes),durationMs:Math.round(info.duration*1000),accepted:false};
        store.recordAction(project.id,key,inputHash,result);return result;
      });
    } finally {await rm(directory,{recursive:true,force:true});}
  };
  const promise=execute();pending.set(pendingKey,{hash:inputHash,promise});
  try {return await promise;} finally {pending.delete(pendingKey);}
}
/** Must be mounted after the shared administrator and Origin guards. */
export function mountVoiceTrimRoutes(app: express.Express, store: Store) {
  app.post("/api/artifacts/:id/voice-trims",async(req,res)=>res.json(await trimVoice(store,String(req.params.id),req.body)));
}
