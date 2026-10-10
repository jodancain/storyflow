import test from "node:test";
import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createApp } from "../server/app.ts";
import { Jobs } from "../server/jobs.ts";
import { Providers } from "../server/providers.ts";
import { publicProduction, publicReviewCsp } from "../server/public-review.ts";
import { ProductionReview } from "../src/review/ProductionReview.tsx";
import { tempStore, fixture, requirements, mockMedia } from "./helpers.ts";

test("published production outputs are scoped, redacted, range-streamed and protected by current-candidate review", async()=>{
  const t=tempStore(); let p=t.store.create("生产审核",requirements,fixture());
  const other=t.store.create("私有工程",requirements,fixture());
  const sourceHash=p.compiled.shotHashes.s1;
  const video=t.store.addFile(p.id,"candidate.mp4","video/mp4",Buffer.from("0123456789abcdef"));
  const privateFile=t.store.addFile(p.id,"source.mp4","video/mp4",Buffer.from("PRIVATE SOURCE"));
  const job=t.store.addJob({projectId:p.id,runId:"test-run",kind:"video",shotId:"s1",dependsOn:[],inputHash:"input",input:{generationHash:sourceHash,secret:"HIDDEN PROMPT"}});
  const artifact=t.store.addArtifact({projectId:p.id,jobId:job.id,shotId:"s1",kind:"video",fileId:video.id,sourceHash,metadata:{providerUrl:"https://private.example/key",reviewNote:"PRIVATE NOTE"}});
  t.store.updateJob(job.id,{state:"complete",stage:"complete",result:{artifactId:artifact.id,providerReceipt:"PRIVATE RECEIPT"},error:"/Users/private/SECRET"});
  const imported=t.store.addArtifact({projectId:p.id,jobId:"not-a-real-task",shotId:"s1",kind:"video",fileId:privateFile.id,sourceHash,metadata:{}});
  const providers=new Providers({imageBase:"",imageKey:"",imageModel:"fixture",opusBase:"",opusKey:"",opusModel:"fixture",seedanceBase:"",seedanceKey:"",seedanceModel:"fixture",falBase:"",falKey:""});
  const jobs=new Jobs(t.store,providers,mockMedia()); jobs.stopped=true;
  const app=createApp(t.store,jobs,{dist:"/missing",publicReviewProjectIds:[p.id],publicReviewApiBase:"/review-service/api"});
  const server=app.listen(0,"127.0.0.1"); await new Promise<void>(r=>server.once("listening",r));
  const base=`http://127.0.0.1:${(server.address() as any).port}`, path=`${base}/api/public-review/${p.id}`;
  t.store.setPassword("test-password-123"); const cookie=`storyflow=${t.store.session()}`;
  const review=(id:string,body:unknown,extra:Record<string,string>={})=>fetch(`${path}/artifacts/${id}/review`,{method:"POST",headers:{"content-type":"application/json",cookie,...extra},body:JSON.stringify(body)});
  const body={accepted:true,sourceHash,fileSha256:video.sha256,note:"human review"};
  try {
    const data=await (await fetch(`${path}/production`)).json();
    assert.equal(data.candidates.length,1); assert.equal(data.jobs.length,1); assert.equal(data.candidates[0].current,true);
    assert.match(data.candidates[0].url,/^\/review-service\/api\/public-review\//);
    assert.doesNotMatch(JSON.stringify(data),/PRIVATE|HIDDEN|SECRET|private\.example|providerReceipt/);
    assert.equal((await fetch(`${base}/api/public-review/${other.id}/production`)).status,404);
    assert.equal((await fetch(`${path}/files/${privateFile.id}`)).status,404);
    const media=await fetch(`${path}/files/${video.id}`,{headers:{Range:"bytes=2-5"}});
    assert.equal(media.status,206); assert.equal(media.headers.get("content-range"),"bytes 2-5/16"); assert.equal(await media.text(),"2345");
    assert.equal(media.headers.get("etag"),`"${video.sha256}"`);
    const suffix=await fetch(`${path}/files/${video.id}`,{headers:{Range:"bytes=-3"}}); assert.equal(suffix.status,206); assert.equal(await suffix.text(),"def");
    assert.equal((await fetch(`${path}/files/${video.id}`,{headers:{Range:"bytes=99-100"}})).status,416);
    assert.equal((await fetch(`${path}/artifacts/${artifact.id}/review`,{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify(body)})).status,401);
    assert.equal((await review(artifact.id,body,{origin:"https://evil.example"})).status,403);
    assert.equal((await review(artifact.id,body,{"sec-fetch-site":"cross-site"})).status,403);
    assert.equal((await review(imported.id,{...body,fileSha256:privateFile.sha256})).status,404);
    assert.equal((await review(artifact.id,{...body,fileSha256:"changed"})).status,409);
    assert.equal(t.store.artifact(artifact.id).accepted,false);
    assert.equal((await review(artifact.id,body)).status,200); assert.equal(t.store.artifact(artifact.id).accepted,true);
    assert.equal((await review(artifact.id,body)).status,200); assert.equal(t.store.jobs(p.id).length,1);
    assert.equal((await review(artifact.id,{...body,accepted:false})).status,200); assert.equal(t.store.artifact(artifact.id).accepted,false);
    p=t.store.project(p.id); p.ontology.shots[0].action="另一个动作"; t.store.edit(p.id,p.revision,{ontology:p.ontology});
    assert.equal((await review(artifact.id,body)).status,409);
    assert.equal((await (await fetch(`${path}/production`)).json()).candidates[0].current,false);
    assert.match(publicReviewCsp(true),/media-src 'self'/);
  } finally { await new Promise<void>(r=>server.close(()=>r())); t.close(); }
});

test("production view separates voice review, candidate review and visitor playback without private metadata",()=>{
  const t=tempStore(); const p=t.store.create("声音审核",requirements,fixture(true));
  const sourceHash=p.compiled.shotHashes.s1;
  const file=t.store.addFile(p.id,"voice.wav","audio/wav",Buffer.from("fixture"));
  const job=t.store.addJob({projectId:p.id,runId:"voice-run",kind:"voice",shotId:"s1",dependsOn:[],inputHash:"voice",input:{generationHash:sourceHash}});
  const artifact=t.store.addArtifact({projectId:p.id,jobId:job.id,shotId:"s1",kind:"voice",fileId:file.id,sourceHash,metadata:{reviewNote:"private comment"}});
  t.store.updateJob(job.id,{state:"complete",stage:"complete",result:{artifactId:artifact.id}});
  const data=publicProduction(t.store.project(p.id),id=>`/public/${id}`);
  const render=(authenticated:boolean)=>renderToStaticMarkup(createElement(ProductionReview,{data,authenticated,connected:true,onLogin:()=>{},onReview:async()=>{}}));
  try {
    assert.match(render(true),/通过声音并制作口型/); assert.match(render(true),/<audio/); assert.match(render(true),/preload="none"/);
    assert.doesNotMatch(render(false),/通过声音并制作口型|private comment|审核意见/); assert.match(render(false),/登录审核视频与声音/);
    assert.equal(data.candidates[0].accepted,false); assert.equal(data.candidates[0].reviewed,false);
  } finally { t.close(); }
});
