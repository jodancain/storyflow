import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { rmSync } from "node:fs";
import { trimVoice } from "../server/voice-trims.ts";
import { Store } from "../server/store.ts";
import { createApp } from "../server/app.ts";
import { Providers } from "../server/providers.ts";
import { Jobs } from "../server/jobs.ts";
import { publicProduction } from "../server/public-review.ts";
import { probe } from "../server/media.ts";
import { tempStore, fixture, requirements, mockMedia } from "./helpers.ts";
const exec=promisify(execFile), ffmpeg=process.env.FFMPEG_PATH || process.env.FFMPEG || "ffmpeg";
function wave(seconds:number) {
  const rate=48000,pcm=Buffer.alloc(seconds*rate*2);
  for(let frame=0;frame<seconds*rate;frame++) pcm.writeInt16LE(Math.round(20000*Math.sin(frame*2*Math.PI*440/rate)),frame*2);
  const header=Buffer.alloc(44);header.write("RIFF",0);header.writeUInt32LE(pcm.length+36,4);header.write("WAVEfmt ",8);header.writeUInt32LE(16,16);header.writeUInt16LE(1,20);header.writeUInt16LE(1,22);header.writeUInt32LE(rate,24);header.writeUInt32LE(rate*2,28);header.writeUInt16LE(2,32);header.writeUInt16LE(16,34);header.write("data",36);header.writeUInt32LE(pcm.length,40);
  return {bytes:Buffer.concat([header,pcm]),pcm};
}
function setup() {
  const t=tempStore(),o=fixture(true);o.spec.totalFrames=125;o.shots[0].endFrame=125;
  const p=t.store.create("固定测试声音",{...requirements,duration:5},o),source=wave(8);
  const file=t.store.addFile(p.id,"native-voice.wav","audio/wav",source.bytes);
  const job=t.store.addJob({projectId:p.id,runId:"fixture-run",kind:"voice",shotId:"s1",dependsOn:[],inputHash:"fixture-input",input:{generationHash:p.compiled.shotHashes.s1}});
  const voice=t.store.addArtifact({projectId:p.id,jobId:job.id,shotId:"s1",kind:"voice",fileId:file.id,sourceHash:p.compiled.shotHashes.s1,metadata:{duration:8}});
  t.store.updateJob(job.id,{state:"complete",stage:"complete",result:{artifactId:voice.id}});
  return {...t,p,source,file,voice,input:{baseRevision:p.revision,fileId:file.id,fileSha256:file.sha256,sourceHash:voice.sourceHash,startMs:1500,endMs:6500,idempotencyKey:"explicit-trim-0001"}};
}

test("explicit voice cut preserves PCM, original media and pending review; idempotence survives restart",async()=>{
  const t=setup();let active=t.store;
  try {
    const before=t.store.artifacts(t.p.id).length;
    const [result,duplicate]=await Promise.all([trimVoice(t.store,t.voice.id,t.input),trimVoice(t.store,t.voice.id,t.input)]);
    assert.deepEqual(result,duplicate);assert.equal(result.durationMs,5000);assert.equal(result.accepted,false);
    assert.equal(t.store.artifacts(t.p.id).length,before+1);assert.equal(t.store.artifact(t.voice.id).accepted,false);
    assert.deepEqual(t.store.bytes(t.file.id),t.source.bytes);assert.notEqual(result.sha256,t.file.sha256);
    const check=await probe(t.store.filePath(result.fileId));assert.equal(check.duration,5);assert.equal(Number(check.audio.sample_rate),48000);
    const decoded=await exec(ffmpeg,["-v","error","-i",t.store.filePath(result.fileId),"-f","s16le","-c:a","pcm_s16le","pipe:1"],{encoding:"buffer",maxBuffer:2*1024*1024});
    assert.deepEqual(decoded.stdout,t.source.pcm.subarray(1500*48*2,6500*48*2));
    const candidate=t.store.artifact(result.artifactId), job=t.store.job(result.jobId);
    assert.equal(job.state,"complete");assert.equal(job.input.operation,"voice-trim");assert.equal(job.attempts,0);assert.equal(candidate.metadata.requiresListeningReview,true);
    assert.equal((candidate.metadata.voiceTrim as any).parentSha256,t.file.sha256);assert.equal((candidate.metadata.voiceTrim as any).startSample,72000);
    const visible=publicProduction(t.store.project(t.p.id),id=>`/files/${id}`).candidates.find(c=>c.id===candidate.id)!;
    assert.deepEqual(visible.voiceTrim,{parentArtifactId:t.voice.id,startMs:1500,endMs:6500});assert.equal(visible.accepted,false);
    t.store.close();active=new Store(t.dir);
    assert.deepEqual(await trimVoice(active,t.voice.id,t.input),result);assert.equal(active.artifacts(t.p.id).length,before+1);
  } finally {active.close();rmSync(t.dir,{recursive:true,force:true});}
});

test("voice trim rejects stale revisions, changed hashes, fractional, long and out-of-source ranges",async()=>{
  const t=setup();
  try {
    const bad=[{baseRevision:2},{fileSha256:"0".repeat(64)},{sourceHash:"0".repeat(64)},{startMs:1.2},{startMs:-1},{endMs:1000},{startMs:0,endMs:5001},{startMs:7500,endMs:8500}];
    for(const patch of bad) await assert.rejects(()=>trimVoice(t.store,t.voice.id,{...t.input,...patch}));
    assert.equal(t.store.artifacts(t.p.id).length,1);assert.equal(t.store.jobs(t.p.id).length,1);
    await trimVoice(t.store,t.voice.id,t.input);
    await assert.rejects(()=>trimVoice(t.store,t.voice.id,{...t.input,startMs:1000}),/幂等键/);
  } finally {t.close();}
});

test("only listening approval of the new cut invalidates old voice and lip-sync; cut alone does not",async()=>{
  const t=setup();
  try {
    t.store.reviewArtifact(t.voice.id,true);
    const lipFile=t.store.addFile(t.p.id,"old-lip.mp4","video/mp4",Buffer.from("synthetic lip video"));
    const lip=t.store.addArtifact({projectId:t.p.id,jobId:"fixture-old-lip",shotId:"s1",kind:"lipsync",fileId:lipFile.id,sourceHash:t.voice.sourceHash,audioFileId:t.file.id,audioHash:t.file.sha256,metadata:{}});
    t.store.reviewArtifact(lip.id,true);
    const result=await trimVoice(t.store,t.voice.id,t.input);
    assert.equal(t.store.artifact(t.voice.id).accepted,true);assert.equal(t.store.artifact(lip.id).accepted,true);assert.equal(t.store.artifact(result.artifactId).accepted,false);
    t.store.reviewArtifact(result.artifactId,true,"人工听审通过完整台词");
    assert.equal(t.store.artifact(t.voice.id).accepted,false);assert.equal(t.store.artifact(lip.id).accepted,false);assert.equal(t.store.artifact(result.artifactId).accepted,true);
    await assert.rejects(async()=>t.store.reviewArtifact(lip.id,true),/绑定声音/);
    assert.equal(t.store.jobs(t.p.id).length,2);
  } finally {t.close();}
});

test("voice-trim API requires administrator and same-origin, creates no provider calls",async()=>{
  const t=setup();let calls=0;
  const providers=new Providers({seedanceBase:"https://example.invalid",seedanceKey:"fixture",seedanceModel:"fixture",falKey:"",falBase:"",opusBase:"",opusKey:"",opusModel:"",allowPrivate:true},{fetchImpl:(async()=>{calls++;throw new Error("never call a provider");}) as typeof fetch});
  const jobs=new Jobs(t.store,providers,mockMedia());jobs.stopped=true;
  const app=createApp(t.store,jobs,{dist:"/missing",publicReviewProjectIds:[t.p.id]});const server=app.listen(0,"127.0.0.1");await new Promise<void>(r=>server.once("listening",r));
  const base=`http://127.0.0.1:${(server.address() as any).port}`,url=`${base}/api/artifacts/${t.voice.id}/voice-trims`;
  t.store.setPassword("voice-trim-test-password");const cookie=`storyflow=${t.store.session()}`;
  const post=(headers:Record<string,string>)=>fetch(url,{method:"POST",headers:{"content-type":"application/json",...headers},body:JSON.stringify(t.input)});
  try {
    assert.equal((await post({})).status,401);assert.equal((await post({cookie,origin:"https://evil.example"})).status,403);
    const response=await post({cookie});assert.equal(response.status,200);const result=await response.json();assert.equal(result.accepted,false);
    assert.deepEqual(await (await post({cookie})).json(),result);assert.equal(calls,0);
    const pub=await (await fetch(`${base}/api/public-review/${t.p.id}/production`)).json();assert.equal(pub.candidates.length,2);
  } finally {await new Promise<void>(r=>server.close(()=>r()));t.close();}
});
