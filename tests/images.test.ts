import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { Jobs } from "../server/jobs.ts";
import { Providers, ProviderError } from "../server/providers.ts";
import { Store } from "../server/store.ts";
import { compileOntology, imageTargetHash } from "../shared/ontology.ts";
import { tempStore, fixture, requirements, mockMedia } from "./helpers.ts";
import { validateDraft } from "../server/validation.ts";
const png=Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jFeYAAAAASUVORK5CYII=","base64");
const config={imageBase:"http://image.example/v1",imageKey:"not-a-real-key",imageModel:"gpt-image-2",seedanceBase:"",seedanceKey:"",seedanceModel:"",falKey:"",falBase:"",opusBase:"",opusKey:"",opusModel:"",allowPrivate:true};
function fake(handler?:(u:any,o:any)=>Response|Promise<Response>) {
 let calls=0;
 const p=new Providers(config,{fetchImpl:(async(u:any,o:any)=>{calls++;return handler ? handler(u,o) : new Response(JSON.stringify({data:[{b64_json:png.toString("base64")}]}));}) as any});
 return {p,get calls(){return calls;}};
}
function setup(){ const t=tempStore(),o=fixture();o.assets.push({id:"hero-image",kind:"image",purpose:"production",label:"Hero reference",gap:true});return {...t,project:t.store.create("images",requirements,o)};}
async function tick(j:Jobs){j.stopped=false;await j.tick();j.stopped=true;}

test("image protocol persists intent and full receipt before decoding; one POST, actual model stays unknown",async()=>{
 let prepared:any,raw:Buffer|undefined,calls=0;
 const p=new Providers(config,{fetchImpl:(async(url:any,opts:any)=>{calls++;assert.ok(prepared);assert.equal(url,"http://image.example/v1/images/generations");assert.deepEqual(JSON.parse(opts.body),{model:"gpt-image-2",prompt:"reference",size:"1024x1536",n:1});return new Response(JSON.stringify({data:[{b64_json:png.toString("base64")}]}));}) as any});
 const receipt=await p.generateImage({prompt:"reference",width:1080,height:1920,references:[]},async r=>{prepared=r;},async r=>{raw=r;});
 assert.ok(raw);assert.equal(receipt.metadata.modelActual,null);assert.equal(prepared.modelRequested,"gpt-image-2");assert.equal(calls,1);
 assert.ok(!(JSON.stringify(prepared).includes(config.imageKey)));
 assert.equal((await p.downloadImage(receipt)).mime,"image/png");
});

test("reference edits send every reference once with hashes, no silent single-reference fallback",async()=>{
 const t=setup();try{
 const f=t.store.addFile(t.project.id,"ref.png","image/png",png);
 let calls=0;
 const p=new Providers(config,{fetchImpl:(async(url:any,o:any)=>{calls++;assert.match(url,/\/images\/edits$/);assert.equal(o.body.getAll("image[]").length,2);return new Response(JSON.stringify({model:"actual-provider-model",data:[{b64_json:png.toString("base64")}]}));}) as any});
 const ref={assetId:"hero-image",fileId:f.id,mime:f.mime,sha256:f.sha256,bytes:png};
 const r=await p.generateImage({prompt:"same hero",width:1080,height:1920,references:[ref,{...ref,assetId:"scene"}]},async()=>{},async()=>{});
 assert.equal(r.metadata.modelActual,"actual-provider-model");assert.equal(calls,1);
 }finally{try{t.store.close();}catch{}rmSync(t.dir,{recursive:true,force:true});}
});

test("image batch idempotency, cap, durable candidate and explicit preview/production gates",async()=>{
 const t=setup();try{
 const f=fake(),j=new Jobs(t.store,f.p,mockMedia());j.stopped=true;
 assert.throws(()=>j.enqueueImages(t.project.id,1,"cap-key",Array(53).fill({assetId:"hero-image"})),/52/);
 const run=j.enqueueImages(t.project.id,1,"image-batch",[{assetId:"hero-image"}]);
 assert.equal(j.enqueueImages(t.project.id,1,"image-batch",[{assetId:"hero-image"}]).jobs[0].id,run.jobs[0].id);
 await tick(j);assert.equal(f.calls,1);
 const job=t.store.job(run.jobs[0].id),a=t.store.artifact(job.result.artifactId);
 assert.equal(a.kind,"image");assert.equal(a.accepted,false);assert.equal(a.metadata.reviewStatus,"pending");assert.equal(job.attempts,1);
 assert.ok(readFileSync(join(t.store.workDir(job.id),"image-receipt.json")).length);
 assert.throws(()=>t.store.selectImage(a.id,1,"production"),/批准/);
 const before=t.store.project(t.project.id),preview=t.store.selectImage(a.id,1,"preview");
 assert.deepEqual(before.compiled.shotHashes,preview.compiled.shotHashes);
 assert.notEqual(before.compiled.targetHashes["hero-image"],preview.compiled.targetHashes["hero-image"]);
 assert.equal(preview.ontology.assets[0].gap,true);
 t.store.reviewArtifact(a.id,true);
 const selected=t.store.selectImage(a.id,preview.revision,"production");
 assert.equal(selected.ontology.assets[0].gap,false);assert.equal(t.store.imageCurrent(t.store.artifact(a.id)),true);
 assert.equal(j.enqueueImages(t.project.id,1,"image-batch",[{assetId:"hero-image"}]).jobs[0].id,job.id);
 assert.throws(()=>t.store.selectImage(a.id,1,"preview"),/更新/);
 }finally{try{t.store.close();}catch{}rmSync(t.dir,{recursive:true,force:true});}
});

test("shot preview changes review only; approved first frame changes generation and withdrawal blocks video",async()=>{
 const t=setup();try{
 const f=fake(),j=new Jobs(t.store,f.p,mockMedia());j.stopped=true;
 const run=j.enqueueImages(t.project.id,1,"shot-image",[{shotId:"s1"}]);await tick(j);
 const a=t.store.artifact(t.store.job(run.jobs[0].id).result.artifactId),before=t.store.project(t.project.id);
 const preview=t.store.selectImage(a.id,1,"preview");
 assert.equal(before.compiled.shotHashes.s1,preview.compiled.shotHashes.s1);assert.notEqual(before.compiled.targetHashes.s1,preview.compiled.targetHashes.s1);
 t.store.reviewArtifact(a.id,true);const production=t.store.selectImage(a.id,preview.revision,"production");
 assert.notEqual(before.compiled.shotHashes.s1,production.compiled.shotHashes.s1);assert.equal(t.store.imageCurrent(t.store.artifact(a.id)),true);
 t.store.review(t.project.id,"s1","pass","");t.store.reviewArtifact(a.id,false,"revoked");
 assert.throws(()=>j.enqueueRun(t.project.id,production.revision,"video-key"),/首帧/);
 }finally{try{t.store.close();}catch{}rmSync(t.dir,{recursive:true,force:true});}
});

test("unknown image acceptance never retries; persisted URL receipt retries only the download after restart",async()=>{
 const t=setup();try{
 const failing=fake(()=>{throw new Error("socket closed");}),j=new Jobs(t.store,failing.p,mockMedia());j.stopped=true;
 const unknown=j.enqueueImages(t.project.id,1,"unknown-image",[{assetId:"hero-image"}]).jobs[0];await tick(j);
 assert.equal(t.store.job(unknown.id).state,"uncertain");assert.throws(()=>j.retry(unknown.id,"retry-image"),/受理不明/);
 assert.throws(()=>j.reconcile(unknown.id,"fake-task-id"),/文本请求/);
 let post=0,get=0,offline=true;
 const provider=fake((u,o)=>{if(o?.method==="POST"){post++;return new Response(JSON.stringify({data:[{url:"http://image.example/result.png"}]}));}get++;if(offline)throw new Error("download offline");return new Response(png);});
 const download=new Jobs(t.store,provider.p,mockMedia());download.stopped=true;
 const image=download.enqueueImages(t.project.id,1,"receipt-image",[{assetId:"hero-image"}]).jobs[0];await tick(download);
 assert.equal(t.store.job(image.id).state,"failed");assert.equal(post,1);offline=false;
 t.store.close();t.store=new Store(t.dir);
 const restored=new Jobs(t.store,provider.p,mockMedia());restored.stopped=true;
 restored.retry(image.id,"download-retry");await tick(restored);
 assert.equal(t.store.job(image.id).state,"complete");assert.equal(post,1);assert.equal(get,2);
 }finally{try{t.store.close();}catch{}rmSync(t.dir,{recursive:true,force:true});}
});

test("saved receipt survives crash before stage update and resumes without POST",async()=>{
 const t=setup();try{
 const p=fake(),j=new Jobs(t.store,p.p,mockMedia());j.stopped=true;
 const job=j.enqueueImages(t.project.id,1,"crash-receipt",[{assetId:"hero-image"}]).jobs[0];
 t.store.updateJob(job.id,{state:"running",stage:"submitting",attempts:1});
 writeFileSync(join(t.store.workDir(job.id),"image-receipt.json"),JSON.stringify({data:[{b64_json:png.toString("base64")}]}));
 j.recover();await tick(j);assert.equal(t.store.job(job.id).state,"complete");assert.equal(p.calls,0);
 }finally{try{t.store.close();}catch{}rmSync(t.dir,{recursive:true,force:true});}
});

test("changed target/reference blocks image approval and edits cannot bypass candidate approval",async()=>{
 const t=setup();try{
 const p=fake(),j=new Jobs(t.store,p.p,mockMedia());j.stopped=true;
 const job=j.enqueueImages(t.project.id,1,"stale-image",[{assetId:"hero-image"}]).jobs[0];await tick(j);
 const a=t.store.artifact(t.store.job(job.id).result.artifactId);
 assert.throws(()=>t.store.bind(t.project.id,1,"hero-image",a.fileId),/批准/);
 const o=structuredClone(t.project.ontology);o.assets[0].fileId=a.fileId;o.assets[0].sha256=t.store.file(a.fileId).sha256;o.assets[0].gap=false;
 assert.throws(()=>validateDraft(o,t.store,t.project.id),/未批准/);
 o.assets[0].label="Changed identity";delete o.assets[0].fileId;delete o.assets[0].sha256;o.assets[0].gap=true;t.store.edit(t.project.id,1,{ontology:o});
 assert.throws(()=>t.store.reviewArtifact(a.id,true),/旧的/);
 }finally{try{t.store.close();}catch{}rmSync(t.dir,{recursive:true,force:true});}
});

test("real FFmpeg creates exact 9:16 frame and retains source crop coordinates without stretching",async()=>{
 const t=setup();try{
  const {fitImage,probe}=await import("../server/media.ts");
  const input=join(t.dir,"fixture.ppm"), output=join(t.dir,"portrait.png");
  writeFileSync(input,Buffer.concat([Buffer.from("P6\n320 240\n255\n"),Buffer.alloc(320*240*3,120)]));
  const crop=await fitImage(input,output,108,192),info=await probe(output);
  assert.equal(info.video.width,108);assert.equal(info.video.height,192);
  assert.deepEqual(crop.crop,{x:92,y:0,width:135,height:240});
  assert.equal(crop.sourceWidth,320);assert.equal(crop.sourceHeight,240);
  assert.equal(crop.crop.width/crop.crop.height,108/192);
 }finally{try{t.store.close();}catch{}rmSync(t.dir,{recursive:true,force:true});}
});

test("image API applies authentication, revision checks, review notes and explicit selection semantics",async()=>{
 const t=setup();const {createApp}=await import("../server/app.ts");const f=fake(),j=new Jobs(t.store,f.p,mockMedia());j.stopped=true;
 const server=createApp(t.store,j,{dist:"/missing"}).listen(0,"127.0.0.1");await new Promise<void>(r=>server.once("listening",r));
 const base=`http://127.0.0.1:${(server.address() as any).port}`;let cookie="";
 const call=(path:string,body:any)=>fetch(base+path,{method:"POST",headers:{"content-type":"application/json",cookie},body:JSON.stringify(body)});
 try {
  const endpoint=`/api/projects/${t.project.id}/image-generations`, request={baseRevision:1,idempotencyKey:"api-images-1",targets:[{assetId:"hero-image"}]};
  assert.equal((await call(endpoint,request)).status,401);
  const auth=await call("/api/auth/setup",{password:"image-test-password"});cookie=auth.headers.get("set-cookie")!.split(";")[0];
  assert.equal((await call(endpoint,{...request,baseRevision:2})).status,409);
  const queued=await call(endpoint,request);assert.equal(queued.status,202);const run=await queued.json();await tick(j);
  const artifact=t.store.artifact(t.store.job(run.jobs[0].id).result.artifactId);
  assert.equal((await call(`/api/artifacts/${artifact.id}/select`,{baseRevision:1,usage:"production"})).status,409);
  let selected=await call(`/api/artifacts/${artifact.id}/select`,{baseRevision:1,usage:"preview"});assert.equal(selected.status,200);
  const preview=await selected.json();assert.equal(preview.ontology.assets[0].gap,true);
  assert.equal((await call(`/api/artifacts/${artifact.id}/review`,{accepted:true,note:"检查通过"})).status,200);
  selected=await call(`/api/artifacts/${artifact.id}/select`,{baseRevision:preview.revision,usage:"production"});assert.equal(selected.status,200);
  assert.equal((await selected.json()).ontology.assets[0].gap,false);assert.equal(f.calls,1);
  const current=t.store.project(t.project.id);t.store.review(t.project.id,"hero-image","pass","real current approval");
  const imported=await call(`/api/projects/${t.project.id}/reviews/import`,{schema:"storyflow-review-draft",projectId:"other-mac",revision:999,scriptSha256:"b".repeat(64),overall:"整体建议",items:[{targetId:"hero-image",targetHash:"c".repeat(64),imageSha256:t.store.file(artifact.fileId).sha256,imageId:"old-machine-image-id",status:"pass",note:"很好"}]});
  assert.equal(imported.status,200);
  let received=await imported.json(),opinion=received.reviews.find((r:any)=>r.imported);
  assert.equal(opinion.status,"pending");assert.equal(opinion.imported.sourceRevision,999);assert.equal(opinion.imported.match,"image-only");assert.equal(opinion.imported.targetHash,"c".repeat(64));
  assert.equal(t.store.approved(t.store.project(t.project.id),"hero-image"),true);
  const mismatch=await call(`/api/projects/${t.project.id}/reviews/import`,{schema:"storyflow-review-draft",scriptSha256:current.compiled.hash,items:[{targetId:"hero-image",targetHash:current.compiled.targetHashes["hero-image"],imageSha256:"d".repeat(64),status:"pass",note:"different pixels"}]});
  assert.equal(mismatch.status,200);received=await mismatch.json();assert.equal(received.reviews.find((r:any)=>r.note==="different pixels").imported.match,"historical");
  assert.equal((await call(`/api/projects/${t.project.id}/reviews/import`,{schema:"storyflow-review-draft",items:[{targetId:"hero-image",targetHash:"invalid",status:"pass"}]})).status,400);

 } finally {await new Promise<void>(r=>server.close(()=>r()));try{t.store.close();}catch{}rmSync(t.dir,{recursive:true,force:true});}
});


test("parent preview changes invalidate descendants transitively; self-reference retains its frozen parent",async()=>{
 const t=setup();try {
  const o=structuredClone(t.project.ontology);o.assets.push({id:"child",kind:"image",purpose:"production",label:"child",gap:true},{id:"grandchild",kind:"image",purpose:"production",label:"grandchild",gap:true});
  let p=t.store.edit(t.project.id,1,{ontology:o});
  const add=(assetId:string,tag:string,parents:any[]=[])=>{
    const f=t.store.addFile(p.id,tag+".png","image/png",Buffer.concat([png,Buffer.from(tag)]));
    return t.store.addArtifact({projectId:p.id,jobId:tag,assetId,kind:"image",fileId:f.id,sourceHash:imageTargetHash(p.ontology,{assetId}),metadata:{parentAssets:parents}});
  };
  const a=add("hero-image","first");p=t.store.selectImage(a.id,p.revision,"preview");
  const parent=(a:any)=>({assetId:a.assetId,fileId:a.fileId,sha256:t.store.file(a.fileId).sha256});
  const b=add("child","child-image",[parent(a)]);p=t.store.selectImage(b.id,p.revision,"preview");
  const c=add("grandchild","grandchild-image",[parent(b)]);p=t.store.selectImage(c.id,p.revision,"preview");
  assert.equal(t.store.imageCurrent(c),true);
  t.store.reviewArtifact(b.id,true);p=t.store.selectImage(b.id,p.revision,"production");
  const replacement=add("hero-image","new-parent");p=t.store.selectImage(replacement.id,p.revision,"preview");
  assert.equal(t.store.imageCurrent(b),false);assert.equal(t.store.imageCurrent(c),false);assert.throws(()=>t.store.reviewArtifact(c.id,true),/旧的/);
  const variant=add("hero-image","variant",[parent(replacement)]);p=t.store.selectImage(variant.id,p.revision,"preview");
  assert.equal(t.store.imageCurrent(variant),true);t.store.reviewArtifact(variant.id,true);
  p=t.store.selectImage(variant.id,p.revision,"production");assert.equal(t.store.imageCurrent(variant),true);
 }finally{try{t.store.close();}catch{}rmSync(t.dir,{recursive:true,force:true});}
});


test("image URL redirects remain bounded and never forward provider credentials",async()=>{
 let calls=0;
 const p=new Providers(config,{fetchImpl:(async(url:any,options:any)=>{
  calls++;assert.equal(options.headers,undefined);assert.equal(options.redirect,"manual");
  return calls === 1 ? new Response(null,{status:302,headers:{location:"/cdn/image.png"}}) : new Response(png);
 }) as any});
 const image=await p.downloadImage({url:"http://image.example/temp",metadata:{}});
 assert.equal(calls,2);assert.equal(image.mime,"image/png");
 const loop=new Providers(config,{fetchImpl:(async()=>new Response(null,{status:302,headers:{location:"/again"}})) as any});
 await assert.rejects(()=>loop.downloadImage({url:"http://image.example/again",metadata:{}}),/redirect limit/);
});
