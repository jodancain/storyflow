import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createApp } from "../server/app.ts";
import { Jobs } from "../server/jobs.ts";
import { tempStore, fixture, requirements } from "./helpers.ts";

async function setup(doctor=false) {
  const t=tempStore(),p=t.store.create("synthetic manual media",requirements,fixture(doctor));
  const videoPath=join(t.dir,"source.mp4"),audioPath=join(t.dir,"source.wav");
  const ffmpeg=process.env.FFMPEG_PATH || process.env.FFMPEG || "ffmpeg";
  execFileSync(ffmpeg,["-v","error","-y","-f","lavfi","-i","color=c=blue:s=32x32:r=25:d=0.4","-an","-c:v","libx264","-pix_fmt","yuv420p",videoPath]);
  execFileSync(ffmpeg,["-v","error","-y","-f","lavfi","-i","sine=frequency=440:sample_rate=16000:duration=0.4",audioPath]);
  const video=t.store.addFile(p.id,"source.mp4","video/mp4",readFileSync(videoPath));
  const audio=t.store.addFile(p.id,"source.wav","audio/wav",readFileSync(audioPath));
  const jobs=new Jobs(t.store,new Proxy({},{get:()=>{throw new Error("No provider access during manual imports");}}) as any);jobs.stop();
  const server=createApp(t.store,jobs,{dist:"/missing",publicReviewProjectIds:[p.id]}).listen(0,"127.0.0.1");
  await new Promise<void>(r=>server.once("listening",r));
  const base=`http://127.0.0.1:${(server.address() as any).port}`;
  t.store.setPassword("manual-import-test-password");const cookie=`storyflow=${t.store.session()}`;
  const request=(body:unknown,headers:Record<string,string>={cookie})=>fetch(`${base}/api/projects/${p.id}/artifacts/import`,{
    method:"POST",headers:{"content-type":"application/json",...headers},body:JSON.stringify(body),
  });
  return {...t,p,video,audio,base,cookie,request,body:{shotId:"s1",kind:"video",fileId:video.id},
    async shutdown(){await new Promise<void>(r=>server.close(()=>r()));t.close();}};
}

test("manual video import creates a durable completed local job and a publicly playable unapproved candidate",async()=>{
  const t=await setup();try{
    assert.equal((await t.request(t.body,{})).status,401);
    assert.equal((await t.request(t.body,{cookie:t.cookie,origin:"https://foreign.invalid"})).status,403);
    const r=await t.request({...t.body,baseRevision:t.p.revision,idempotencyKey:"manual-import-first"});assert.equal(r.status,201);
    const p=await r.json(),a=p.artifacts[0],j=p.jobs[0];
    assert.equal(p.artifacts.length,1);assert.equal(p.jobs.length,1);assert.equal(p.revision,t.p.revision);
    assert.equal(a.jobId,j.id);assert.equal(a.accepted,false);assert.equal(a.metadata.origin,"manual-import");
    assert.equal(j.state,"complete");assert.equal(j.stage,"complete");assert.equal(j.progress,1);assert.equal(j.attempts,0);
    assert.equal(j.handle,undefined);assert.equal(j.input.operation,"manual-media-import");assert.equal(j.input.origin,"manual-import");
    assert.equal(j.input.fileId,t.video.id);assert.equal(j.input.fileSha256,t.video.sha256);
    assert.equal(j.input.generationHash,t.p.compiled.shotHashes.s1);assert.equal(j.input.sourceHash,a.sourceHash);
    assert.equal(j.result.artifactId,a.id);assert.equal(j.result.origin,"manual-import");
    const published=await (await fetch(`${t.base}/api/public-review/${p.id}/production`)).json();
    assert.equal(published.candidates.length,1);assert.equal(published.candidates[0].id,a.id);assert.equal(published.candidates[0].accepted,false);
    const media=await fetch(t.base+published.candidates[0].url,{headers:{range:"bytes=0-15"}});
    assert.equal(media.status,206);assert.equal((await media.arrayBuffer()).byteLength,16);
    assert.equal(t.store.approved(t.store.project(p.id),"s1"),false,"import does not approve scripts");
  }finally{await t.shutdown();}
});

test("same source bytes deduplicate parallel requests, repeated uploads and independent explicit keys",async()=>{
  const t=await setup();try{
    const results=await Promise.all([t.request(t.body),t.request(t.body)]);assert.deepEqual(results.map(r=>r.status).sort(),[200,201]);
    const duplicate=t.store.addFile(t.p.id,"same-bytes.mp4","video/mp4",t.store.bytes(t.video.id));
    assert.equal((await t.request({...t.body,fileId:duplicate.id,idempotencyKey:"manual-alias-key"})).status,200);
    assert.equal((await t.request({...t.body,idempotencyKey:"manual-alias-key"})).status,200);
    assert.equal(t.store.artifacts(t.p.id).length,1);assert.equal(t.store.jobs(t.p.id).length,1);
    const conflicting={...t.body,kind:"graphic",idempotencyKey:"manual-alias-key"};
    assert.equal((await t.request(conflicting)).status,409);assert.equal(t.store.jobs(t.p.id).length,1);
  }finally{await t.shutdown();}
});

test("legacy manual artifact gains a real job without duplicating its candidate or approval",async()=>{
  const t=await setup();try{
    const a=t.store.addArtifact({projectId:t.p.id,jobId:"import-old-orphan",shotId:"s1",kind:"video",fileId:t.video.id,
      sourceHash:t.p.compiled.shotHashes.s1,metadata:{origin:"manual-import",originalNote:"preserve evidence"}});
    t.store.reviewArtifact(a.id,true,"previous human review");
    assert.equal((await t.request(t.body)).status,201);
    const p=t.store.project(t.p.id);assert.equal(p.artifacts.length,1);assert.equal(p.artifacts[0].id,a.id);
    assert.equal(p.artifacts[0].accepted,true);assert.equal(p.artifacts[0].metadata.originalNote,"preserve evidence");
    assert.equal(p.jobs.length,1);assert.equal(p.jobs[0].result.artifactId,a.id);assert.equal(p.jobs[0].attempts,0);
  }finally{await t.shutdown();}
});

test("lipsync imports retain the exact reviewed driving voice and voice imports remain unapproved",async()=>{
  const t=await setup(true);try{
    const lipsync={...t.body,kind:"lipsync",audioFileId:t.audio.id};
    assert.equal((await t.request(lipsync)).status,409);assert.equal(t.store.jobs(t.p.id).length,0);
    assert.equal((await t.request({...t.body,kind:"voice",fileId:t.audio.id})).status,201);
    const voice=t.store.artifacts(t.p.id)[0];assert.equal(voice.accepted,false);assert.equal(voice.kind,"voice");
    assert.equal((await t.request(lipsync)).status,409);
    t.store.reviewArtifact(voice.id,true,"exact voice approved");
    assert.equal((await t.request(lipsync)).status,201);
    const candidate=t.store.artifacts(t.p.id).find(a=>a.kind==="lipsync")!;
    assert.equal(candidate.audioFileId,t.audio.id);assert.equal(candidate.audioHash,t.audio.sha256);assert.equal(candidate.accepted,false);
    const job=t.store.job(candidate.jobId);assert.equal(job.kind,"lipsync");assert.equal(job.input.audioHash,t.audio.sha256);assert.equal(job.attempts,0);
    t.store.reviewArtifact(voice.id,false,"withdrawn");
    assert.equal((await t.request(lipsync)).status,409,"deduplication cannot bypass a withdrawn voice");
  }finally{await t.shutdown();}
});

test("late completion failures roll back the artifact, job and idempotency records together",async()=>{
  const t=await setup();try{
    const original=t.store.updateJob.bind(t.store);
    t.store.updateJob=(...args:Parameters<typeof original>)=>{original(...args);throw new Error("injected completion failure");};
    assert.equal((await t.request({...t.body,idempotencyKey:"rollback-manual-import"})).status,500);
    assert.equal(t.store.artifacts(t.p.id).length,0);assert.equal(t.store.jobs(t.p.id).length,0);
    assert.equal(t.store.db.prepare("SELECT count(*) AS n FROM actions").get()!.n,0);
  }finally{await t.shutdown();}
});

test("concurrent edits, corrupt bytes, wrong streams and foreign files cannot be imported as current outputs",async()=>{
  const t=await setup();try{
    assert.equal((await t.request({...t.body,baseRevision:99})).status,409);
    const wrong=t.store.addFile(t.p.id,"audio-disguised.mp4","video/mp4",t.store.bytes(t.audio.id));
    assert.equal((await t.request({...t.body,fileId:wrong.id})).status,400);
    const foreign=t.store.create("foreign",requirements,fixture());
    const f=t.store.addFile(foreign.id,"foreign.mp4","video/mp4",t.store.bytes(t.video.id));
    assert.equal((await t.request({...t.body,fileId:f.id})).status,403);
    const filePath=t.store.filePath.bind(t.store);let edited=false;
    t.store.filePath=(id:string)=>{
      if(!edited){edited=true;const o=structuredClone(t.p.ontology);o.shots[0].action="concurrent new action";t.store.edit(t.p.id,t.p.revision,{ontology:o});}
      return filePath(id);
    };
    assert.equal((await t.request(t.body)).status,409);assert.equal(t.store.jobs(t.p.id).length,0);
    t.store.filePath=filePath;writeFileSync(t.store.filePath(t.video.id),"corrupted bytes");
    assert.equal((await t.request(t.body)).status,500);assert.equal(t.store.artifacts(t.p.id).length,0);
  }finally{await t.shutdown();}
});
