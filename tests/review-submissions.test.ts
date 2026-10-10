import test from "node:test";
import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { Jobs } from "../server/jobs.ts";
import { Providers } from "../server/providers.ts";
import { Store } from "../server/store.ts";
import { submitReviews } from "../server/review-submissions.ts";
import { imageTargetHash } from "../shared/ontology.ts";
import { tempStore, fixture, requirements, mockMedia } from "./helpers.ts";
const png=Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jFeYAAAAASUVORK5CYII=","base64");
function setup(configured=true) {
 const t=tempStore(), ontology=fixture();
 ontology.assets.push({id:"hero-image",kind:"image",purpose:"production",label:"Hero",gap:true});
 const project=t.store.create("review",requirements,ontology);
 let calls=0;
 const providers=new Providers({imageBase:configured?"http://image.example/v1":"",imageKey:configured?"test-only":"",imageModel:"gpt-image-2",seedanceBase:"",seedanceKey:"",seedanceModel:"",falKey:"",falBase:"",opusBase:"",opusKey:"",opusModel:"",allowPrivate:true},{fetchImpl:(async()=>{calls++;return new Response(JSON.stringify({data:[{b64_json:png.toString("base64")}]}));}) as any});
 const jobs=new Jobs(t.store,providers,mockMedia());jobs.stopped=true;
 const file=t.store.addFile(project.id,"hero.png","image/png",png);
 const artifact=t.store.addArtifact({projectId:project.id,assetId:"hero-image",kind:"image",jobId:"external-first-candidate",fileId:file.id,sourceHash:imageTargetHash(ontology,{assetId:"hero-image"}),metadata:{origin:"ai-generated"}});
 const item={targetId:"hero-image",targetHash:project.compiled.targetHashes["hero-image"],imageId:artifact.id,imageSha256:file.sha256,status:"change" as "change"|"pass",note:"发型必须和角色基准一致"};
 return {...t,project,artifact,item,jobs,get calls(){return calls;}};
}
test("inline review saves exact decision and one durable repair atomically, repeated request survives restart",async()=>{
 const t=setup();try {
  const result=submitReviews(t.store,t.jobs,t.project.id,1,"review-first",[t.item]);
  assert.equal(result.submission.items[0].outcome,"queued");assert.equal(result.jobs.length,1);assert.equal(t.calls,0);
  assert.equal(t.store.artifact(t.artifact.id).metadata.reviewStatus,"change");
  assert.equal(result.jobs[0].input.revisionOf,t.artifact.id);assert.match(result.jobs[0].input.prompt,/发型必须/);
  const duplicate=submitReviews(t.store,t.jobs,t.project.id,1,"review-first",[t.item]);assert.equal(duplicate.jobs[0].id,result.jobs[0].id);
  assert.throws(()=>submitReviews(t.store,t.jobs,t.project.id,1,"review-first",[{...t.item,note:"different"}]),/幂等键/);
  t.store.close();t.store=new Store(t.dir);
  const restarted=new Jobs(t.store,t.jobs.providers,mockMedia());restarted.stopped=true;
  assert.equal(submitReviews(t.store,restarted,t.project.id,1,"review-first",[t.item]).submission.id,result.submission.id);
  assert.equal(t.store.jobs(t.project.id).length,1);
  restarted.stopped=false;await restarted.tick();restarted.stopped=true;assert.equal(t.calls,1);
  assert.equal(t.store.job(result.jobs[0].id).state,"complete");assert.equal(t.store.reviewSubmissions(t.project.id).length,1);
 }finally{t.store.close();rmSync(t.dir,{recursive:true,force:true});}
});
test("pass never generates or binds video input; stale image and stale target abort every decision",()=>{
 const t=setup();try {
  const passed=submitReviews(t.store,t.jobs,t.project.id,1,"review-pass",[{...t.item,status:"pass"}]);
  assert.equal(passed.jobs.length,0);assert.equal(passed.submission.items[0].outcome,"approved");
  assert.equal(t.store.artifact(t.artifact.id).accepted,true);assert.equal(t.store.project(t.project.id).ontology.assets[0].fileId,undefined);
  const before=t.store.reviewSubmissions(t.project.id).length;
  assert.throws(()=>submitReviews(t.store,t.jobs,t.project.id,1,"bad-image",[{...t.item,imageSha256:"f".repeat(64)}]),/图片已经变化/);
  assert.throws(()=>submitReviews(t.store,t.jobs,t.project.id,1,"bad-target",[{...t.item,targetHash:"e".repeat(64)}]),/审核内容已经/);
  assert.throws(()=>submitReviews(t.store,t.jobs,t.project.id,2,"bad-revision",[t.item]),/版本/);
  assert.throws(()=>submitReviews(t.store,t.jobs,t.project.id,1,"empty-note",[{...t.item,note:"   "}]),/修改意见/);
  assert.equal(t.store.artifact(t.artifact.id).accepted,true);assert.equal(t.store.reviewSubmissions(t.project.id).length,before);assert.equal(t.calls,0);
 }finally{t.close();}
});
test("missing configuration and existing unknown task preserve comments without fake queues or resubmission",()=>{
 const t=setup(false);try {
  const blocked=submitReviews(t.store,t.jobs,t.project.id,1,"not-configured",[t.item]);
  assert.equal(blocked.jobs.length,0);assert.equal(blocked.submission.items[0].blocked?.code,"image_not_configured");
  assert.equal(t.store.reviews(t.project.id)[0].note,t.item.note);
  const old=t.store.addJob({projectId:t.project.id,runId:"old",kind:"image",dependsOn:[],inputHash:"old",input:{target:{assetId:"hero-image"}}});
  t.store.updateJob(old.id,{state:"uncertain",attempts:1,stage:"acceptance_unknown"});
  const unknown=submitReviews(t.store,t.jobs,t.project.id,1,"unknown-block",[t.item]);
  assert.equal(unknown.submission.items[0].blocked?.code,"acceptance_unknown");assert.equal(t.store.jobs(t.project.id).length,1);assert.equal(t.calls,0);
 }finally{t.close();}
});
test("a concurrent second submission records the comment but never creates a duplicate target job",()=>{
 const t=setup();try {
  const first=submitReviews(t.store,t.jobs,t.project.id,1,"first-click",[t.item]);
  const second=submitReviews(t.store,t.jobs,t.project.id,1,"second-click",[{...t.item,note:"更清楚的修改意见"}]);
  assert.equal(first.jobs.length,1);assert.equal(second.jobs.length,0);assert.equal(second.submission.items[0].blocked?.code,"image_job_active");
  assert.equal(t.store.reviewSubmissions(t.project.id).length,2);assert.equal(t.store.jobs(t.project.id).length,1);
 }finally{t.close();}
});
test("policy refusal cannot be silently resubmitted through review text",()=>{
 const t=setup();try {
  const ontology=structuredClone(t.project.ontology);ontology.assets[0].imageAttempt={origin:"external-history",state:"failed",code:"moderation_blocked",submitted:true,reason:"policy"};
  const current=t.store.edit(t.project.id,1,{ontology});
  const result=submitReviews(t.store,t.jobs,t.project.id,current.revision,"policy-review",[{...t.item,targetHash:current.compiled.targetHashes[t.item.targetId]}]);
  assert.equal(result.jobs.length,0);assert.equal(result.submission.items[0].blocked?.code,"provider_policy_blocked");assert.equal(t.calls,0);
 }finally{t.close();}
});
test("bad item in a review batch rolls back valid approvals and leaves no job or submission",()=>{
 const t=setup();try {
  const file=t.store.addFile(t.project.id,"shot.png","image/png",png);
  const shot=t.store.addArtifact({projectId:t.project.id,shotId:"s1",kind:"image",jobId:"external",fileId:file.id,sourceHash:imageTargetHash(t.project.ontology,{shotId:"s1"}),metadata:{}});
  assert.throws(()=>submitReviews(t.store,t.jobs,t.project.id,1,"atomic-batch",[{...t.item,status:"pass"},{targetId:"s1",targetHash:t.project.compiled.targetHashes.s1,imageId:shot.id,imageSha256:"f".repeat(64),status:"change",note:"修改动作"}]),/图片已经变化/);
  assert.equal(t.store.artifact(t.artifact.id).accepted,false);assert.equal(t.store.reviewSubmissions(t.project.id).length,0);assert.equal(t.store.jobs(t.project.id).length,0);
 }finally{t.close();}
});

test("current decisions may request repairs of an exact historical candidate but never approve it",()=>{
 const t=setup();try {
  const ontology=structuredClone(t.project.ontology);ontology.assets[0].mustShow=["锁定的同一角色脸部"];
  const current=t.store.edit(t.project.id,1,{ontology});assert.equal(current.imageCandidateCurrent?.[t.artifact.id],false);
  const item={...t.item,targetHash:current.compiled.targetHashes[t.item.targetId]};
  assert.throws(()=>submitReviews(t.store,t.jobs,t.project.id,current.revision,"historical-pass",[{...item,status:"pass"}]),/历史制作条件/);
  const requested=submitReviews(t.store,t.jobs,t.project.id,current.revision,"historical-change",[item]);
  assert.equal(requested.jobs.length,1);assert.equal(requested.jobs[0].input.targetHash,imageTargetHash(current.ontology,{assetId:"hero-image"}));
 }finally{t.close();}
});

test("review HTTP endpoints require login, exact origin, and report stored decisions with task IDs",async()=>{
 const t=setup();const {createApp}=await import("../server/app.ts");
 const server=createApp(t.store,t.jobs,{dist:"/missing"}).listen(0,"127.0.0.1");await new Promise<void>(r=>server.once("listening",r));
 const base=`http://127.0.0.1:${(server.address() as any).port}`,endpoint=`/api/projects/${t.project.id}/review-submissions`;let cookie="";
 const call=(path:string,body:any,extra:Record<string,string>={})=>fetch(base+path,{method:"POST",headers:{"content-type":"application/json",cookie,...extra},body:JSON.stringify(body)});
 try {
  const body={baseRevision:1,idempotencyKey:"http-review-1",items:[t.item]};
  assert.equal((await call(endpoint,body)).status,401);
  const auth=await call("/api/auth/setup",{password:"test-review-password"});cookie=auth.headers.get("set-cookie")!.split(";")[0];
  assert.equal((await call(endpoint,body,{origin:"https://attacker.invalid"})).status,403);
  assert.equal((await call(endpoint,body,{"sec-fetch-site":"cross-site"})).status,403);
  assert.equal((await call(endpoint,{...body,items:[{...t.item,imageId:"other-project-artifact"}]})).status,409);
  const response=await call(endpoint,body);assert.equal(response.status,202);const saved=await response.json();assert.equal(saved.jobs.length,1);
  const duplicate=await call(endpoint,body);assert.equal((await duplicate.json()).submission.id,saved.submission.id);
  const history=await fetch(base+endpoint,{headers:{cookie}});assert.equal((await history.json()).submissions.length,1);assert.equal(t.calls,0);
 }finally{await new Promise<void>(r=>server.close(()=>r()));t.close();}
});

test("one submission may approve a canonical master and queue a matching shot; replacing the master invalidates descendants and unsent jobs",async()=>{
 const t=setup();try {
  const ontology=structuredClone(t.project.ontology);
  ontology.imageConsistency={version:1,enforceApprovedIdentity:true,characters:[{characterId:"hero",identityAssetId:"hero-image",visibility:"person",appearance:"固定及肩深色披发和同一五官",wardrobes:[{id:"home",description:"米白针织衫"}]}]};
  ontology.assets[0].imageComposition={visibleCharacters:[{characterId:"hero",wardrobeId:"home",visibility:"face"}]};
  ontology.shots[0].imageComposition={visibleCharacters:[{characterId:"hero",wardrobeId:"home",visibility:"face"}]};
  let p=t.store.edit(t.project.id,1,{ontology});
  const add=(assetId:string|undefined,shotId:string|undefined,tag:string)=>{
   const f=t.store.addFile(p.id,`${tag}.png`,"image/png",Buffer.concat([png,Buffer.from(tag)]));
   return t.store.addArtifact({projectId:p.id,assetId,shotId,kind:"image",jobId:tag,fileId:f.id,sourceHash:imageTargetHash(p.ontology,{assetId,shotId}),metadata:{}});
  };
  const master=add("hero-image",undefined,"master-v2"), shot=add(undefined,"s1","shot-before-review");
  const itemFor=(a:any,status:"pass"|"change")=>({targetId:a.assetId || a.shotId,targetHash:p.compiled.targetHashes[a.assetId || a.shotId],imageId:a.id,imageSha256:t.store.file(a.fileId).sha256,status,note:status==="pass"?"这就是唯一女主基准":"按基准统一人物"});
  const blocked=submitReviews(t.store,t.jobs,p.id,p.revision,"before-master",[itemFor(shot,"change")]);
  assert.equal(blocked.submission.items[0].blocked?.code,"identity_not_approved");assert.equal(blocked.jobs.length,0);
  const both=submitReviews(t.store,t.jobs,p.id,p.revision,"approve-and-repair",[itemFor(master,"pass"),itemFor(shot,"change")]);
  assert.equal(both.jobs.length,1);assert.equal(both.jobs[0].input.parentAssets[0].fileId,master.fileId);
  assert.equal(both.jobs[0].input.identityReferences[0].artifactId,master.id);assert.match(both.jobs[0].input.prompt,/不可由补充意见覆盖/);
  t.jobs.stopped=false;await t.jobs.tick();t.jobs.stopped=true;
  const generated=t.store.artifact(t.store.job(both.jobs[0].id).result.artifactId);assert.equal(t.store.imageCurrent(generated),true);
  // A later repair is queued with master 1. Approval of master 2 happens before provider I/O.
  const queued=t.jobs.enqueueImages(p.id,p.revision,"unsent-old-identity",[{shotId:"s1"}]).jobs[0];
  const replacement=add("hero-image",undefined,"master-replacement");
  assert.throws(()=>submitReviews(t.store,t.jobs,p.id,p.revision,"conflicting-batch",[itemFor(generated,"pass"),itemFor(replacement,"pass")]),/角色基准更新/);
  assert.equal(t.store.artifact(master.id).accepted,true);assert.equal(t.store.artifact(generated.id).accepted,false);assert.equal(t.store.artifact(replacement.id).accepted,false);
  // A storage failure in the legacy single-image endpoint must not leave every master unapproved.
  t.store.db.exec(`CREATE TEMP TRIGGER reject_master_update BEFORE UPDATE ON artifacts WHEN NEW.id='${replacement.id}' AND json_extract(NEW.json,'$.accepted')=1 BEGIN SELECT RAISE(ABORT,'injected approval failure'); END`);
  assert.throws(()=>t.store.reviewArtifact(replacement.id,true,"approve"),/injected approval failure/);
  assert.equal(t.store.artifact(master.id).accepted,true);assert.equal(t.store.artifact(replacement.id).accepted,false);
  t.store.db.exec("DROP TRIGGER reject_master_update");
  submitReviews(t.store,t.jobs,p.id,p.revision,"approve-replacement",[itemFor(replacement,"pass")]);
  assert.equal(t.store.artifact(master.id).accepted,false);assert.equal(t.store.artifact(replacement.id).accepted,true);
  assert.equal(t.store.imageCurrent(generated),false);
  const latest=t.jobs.prepareImageInputs(p.id,p.revision,[{shotId:"s1"}])[0];assert.equal(latest.identityReferences?.[0].fileId,replacement.fileId);
  t.jobs.stopped=false;await t.jobs.tick();t.jobs.stopped=true;
  assert.equal(t.store.job(queued.id).state,"failed");assert.equal(t.store.job(queued.id).attempts,0);assert.equal(t.calls,1);
  assert.match(t.store.job(queued.id).error || "",/角色基准已变化/);
 }finally{t.close();}
});

test("approved ordinary scene revisions replace bad image references without changing video bindings, and invalidate stale outputs and unsent jobs",async()=>{
 const t=setup();try {
  const {inspectImageConsistency}=await import("../shared/image-consistency.ts");
  const o=structuredClone(t.project.ontology);
  o.imageConsistency={version:1,enforceApprovedIdentity:true,characters:[]};
  o.assets[0].label="空诊室";o.assets[0].imageComposition={visibleCharacters:[]};
  o.assets[0].fileId=t.artifact.fileId;o.assets[0].sha256=t.item.imageSha256;o.assets[0].gap=false;
  o.shots[0].imageComposition={visibleCharacters:[]};o.shots[0].requiredAssetIds=["hero-image"];
  let p=t.store.edit(t.project.id,1,{ontology:o});
  const bad=t.store.addArtifact({projectId:p.id,assetId:"hero-image",jobId:"bad-room",kind:"image",fileId:t.artifact.fileId,sourceHash:imageTargetHash(p.ontology,{assetId:"hero-image"}),metadata:{technicalReview:{contentReview:"needs_revision",notes:["混入陌生人"]}}});
  // Remove the older test fixture's role in file resolution; this is the current reviewed evidence.
  t.store.db.prepare("DELETE FROM artifacts WHERE id=?").run(t.artifact.id);
  assert.ok(inspectImageConsistency(t.store.project(p.id),"s1",["hero-image"]).issues.some(i=>i.code==="reference_needs_revision"));
  const add=(tag:string)=>{
    const f=t.store.addFile(p.id,`${tag}.png`,"image/png",Buffer.concat([png,Buffer.from(tag)]));
    return t.store.addArtifact({projectId:p.id,assetId:"hero-image",jobId:tag,kind:"image",fileId:f.id,sourceHash:imageTargetHash(p.ontology,{assetId:"hero-image"}),metadata:{}});
  };
  const first=add("clean-room-first");t.store.reviewArtifact(first.id,true,"诊室不应出现人物，通过");
  p=t.store.project(p.id);assert.equal(inspectImageConsistency(p,"s1",["hero-image"]).ready,true);
  const prepared=t.jobs.prepareImageInputs(p.id,p.revision,[{shotId:"s1",referenceAssetIds:["hero-image"]}])[0];
  assert.equal(prepared.parentAssets[0].fileId,first.fileId);assert.equal(prepared.parentAssets[0].approval,"approved");
  assert.equal(p.ontology.assets[0].fileId,bad.fileId);
  const descendant=t.store.addArtifact({projectId:p.id,shotId:"s1",jobId:"derived",kind:"image",fileId:first.fileId,sourceHash:imageTargetHash(p.ontology,{shotId:"s1"}),metadata:{parentAssets:prepared.parentAssets}});
  assert.equal(t.store.imageCurrent(descendant),true);
  const queued=t.jobs.enqueueImages(p.id,p.revision,"pending-room-shot",[{shotId:"s1",referenceAssetIds:["hero-image"]}]).jobs[0];
  const second=add("clean-room-second");t.store.reviewArtifact(second.id,true,"另一构图通过");
  assert.equal(t.store.imageCurrent(descendant),false);
  assert.equal(t.jobs.prepareImageInputs(p.id,p.revision,[{shotId:"s1",referenceAssetIds:["hero-image"]}])[0].parentAssets[0].fileId,second.fileId);
  t.jobs.stopped=false;await t.jobs.tick();t.jobs.stopped=true;
  assert.equal(t.store.job(queued.id).state,"failed");assert.equal(t.store.job(queued.id).attempts,0);assert.equal(t.calls,0);
  assert.match(t.store.job(queued.id).error || "",/图片参考已变化/);
  assert.equal(t.store.project(p.id).ontology.assets[0].fileId,bad.fileId);
 }finally{t.close();}
});
