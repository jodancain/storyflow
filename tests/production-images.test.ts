import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, writeFileSync, rmSync, mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Store } from "../server/store.ts";
import { Jobs } from "../server/jobs.ts";
import { imageTargetHash } from "../shared/ontology.ts";
import { loadExampleAssets } from "../server/template.ts";
import { exportProject, importProject } from "../server/archive.ts";
import { backup } from "../scripts/backup.ts";
import { restore } from "../scripts/restore.ts";
import { fixture, requirements, tempStore } from "./helpers.ts";

function setup() {
  const t=tempStore(), ontology=fixture();
  ontology.assets=[{id:"hero-image",label:"Hero",kind:"image",purpose:"production",gap:true},{id:"room-image",label:"Room",kind:"image",purpose:"production",gap:true}];
  ontology.shots[0].endFrame=50; ontology.shots[0].requiredAssetIds=["hero-image","room-image"];
  ontology.shots.push({...structuredClone(ontology.shots[0]),id:"s2",startFrame:50,endFrame:100,dependencies:["s1"]});
  let p=t.store.create("adoption fixture",requirements,ontology);
  for(const asset of ontology.assets) {
    const file=t.store.addFile(p.id,`${asset.id}.png`,"image/png",Buffer.from(`synthetic ${asset.id}`));
    const a=t.store.addArtifact({projectId:p.id,kind:"image",assetId:asset.id,fileId:file.id,jobId:"synthetic",sourceHash:imageTargetHash(ontology,{assetId:asset.id}),metadata:{providerReceipt:{model:"fixture",inputHash:"original"}}});
    asset.previewImage={artifactId:a.id,fileId:file.id,sha256:file.sha256};
  }
  p=t.store.edit(p.id,p.revision,{ontology});
  for(const shot of ontology.shots) {
    const file=t.store.addFile(p.id,`${shot.id}.png`,"image/png",Buffer.from(`synthetic ${shot.id}`));
    const a=t.store.addArtifact({projectId:p.id,kind:"image",shotId:shot.id,fileId:file.id,jobId:"synthetic",sourceHash:imageTargetHash(ontology,{shotId:shot.id}),metadata:{parentAssets:ontology.assets.map(a=>({assetId:a.id,...a.previewImage})),providerReceipt:{model:"fixture",inputHash:"original"}}});
    shot.reviewImage={artifactId:a.id,fileId:file.id,sha256:file.sha256};
  }
  p=t.store.edit(p.id,p.revision,{ontology});
  for(const a of p.artifacts) {t.store.reviewArtifact(a.id,true,"explicit test approval");t.store.review(p.id,a.assetId||a.shotId!,"pass","explicit test approval");}
  p=t.store.project(p.id);
  return {...t,project:p,items:p.artifacts.map(a=>({artifactId:a.id,sha256:t.store.file(a.fileId).sha256}))};
}
const dormant=(store:Store)=>{const jobs=new Jobs(store,new Proxy({},{get:()=>{throw new Error("No provider access allowed in adoption test");}}) as any);jobs.stop();return jobs;};

test("atomic display adoption preserves original image evidence and makes exact approved first frames usable",()=>{
  const t=setup();try{
    const before=t.project, adopted=t.store.adoptProductionImages(before.id,before.revision,"adopt-exact-1",t.items), p=adopted.project;
    assert.equal(p.revision,before.revision+1);assert.equal(p.jobs.length,0);
    assert.ok(p.ontology.assets.every(a=>!a.gap&&a.fileId===a.previewImage!.fileId));
    assert.ok(p.ontology.shots.every(s=>s.firstFrameImage?.artifactId===s.reviewImage?.artifactId));
    for(const a of p.artifacts) {
      const old=before.artifacts.find(x=>x.id===a.id)!;
      assert.equal(a.sourceHash,old.sourceHash);assert.deepEqual(a.metadata.providerReceipt,old.metadata.providerReceipt);
      assert.equal(p.imageCandidateCurrent?.[a.id],true);assert.equal((a.metadata.productionAdoption as any).imageSha256,t.store.file(a.fileId).sha256);
    }
    // Binding choices are not a silent script or post approval.
    assert.ok(p.ontology.shots.every(s=>!t.store.approved(p,s.id)));assert.equal(t.store.approved(p,"post"),false);
    for(const a of p.ontology.assets)t.store.review(p.id,a.id,"pass","explicit production snapshot approval");
    for(const s of p.ontology.shots)t.store.review(p.id,s.id,"pass","explicit production snapshot approval");
    const jobs=dormant(t.store).enqueueRun(p.id,p.revision,"approved-run-1");
    assert.equal(jobs.jobs.length,2);assert.deepEqual(jobs.jobs[1].dependsOn,[jobs.jobs[0].id]);
  }finally{t.close();}
});

test("adoption is durable and idempotent; replay cannot undo a later story edit",()=>{
  const t=setup();try{
    const result=t.store.adoptProductionImages(t.project.id,t.project.revision,"durable-adopt-1",t.items);
    t.store.close();t.store=new Store(t.dir);
    const again=t.store.adoptProductionImages(t.project.id,t.project.revision,"durable-adopt-1",[...t.items].reverse());
    assert.equal(again.adoption.id,result.adoption.id);assert.equal(again.project.revision,result.project.revision);
    assert.ok(again.project.artifacts.every(a=>again.project.imageCandidateCurrent?.[a.id]));
    const o=structuredClone(again.project.ontology);o.shots[0].action="A different action";
    const edited=t.store.edit(t.project.id,again.project.revision,{ontology:o});
    const repeat=t.store.adoptProductionImages(t.project.id,t.project.revision,"durable-adopt-1",t.items);
    assert.equal(repeat.project.revision,edited.revision);assert.equal(repeat.project.ontology.shots[0].action,"A different action");
    assert.ok(repeat.project.artifacts.filter(a=>a.shotId).every(a=>repeat.project.imageCandidateCurrent?.[a.id]===false));
    assert.throws(()=>t.store.adoptProductionImages(t.project.id,edited.revision,"new-stale-adopt",t.items),/当前有效/);
  }finally{t.store.close();rmSync(t.dir,{recursive:true,force:true});}
});

test("artifact metadata cannot forge adoption or change the brief authorized by a local action",()=>{
  const t=setup();try{
    const adopted=t.store.adoptProductionImages(t.project.id,t.project.revision,"trusted-adopt-1",t.items).project;
    const ontology=structuredClone(adopted.ontology);ontology.shots[0].action="A different, unreviewed action";
    const changed=t.store.edit(adopted.id,adopted.revision,{ontology});
    const shot=changed.artifacts.find(a=>a.shotId==="s1")!;
    const valid=shot.metadata.productionAdoption as any;
    for(const forged of [
      {schema:valid.schema,sourceHash:shot.sourceHash,imageSha256:t.store.file(shot.fileId).sha256,adoptedBriefHash:changed.imageTargetHashes!.s1},
      {...valid,adoptedBriefHash:changed.imageTargetHashes!.s1},
      {...valid,adoptedBriefHash:changed.imageTargetHashes!.s1,actionKey:"nonexistent-action"},
    ]) {
      shot.metadata={...shot.metadata,productionAdoption:forged};
      t.store.db.prepare("UPDATE artifacts SET json=? WHERE id=?").run(JSON.stringify(shot),shot.id);
      assert.equal(t.store.imageCurrent(shot),false);
      assert.throws(()=>t.store.reviewArtifact(shot.id,true),/旧的制作条件/);
    }
  }finally{t.close();}
});

test("project ZIP metadata retains adoption history but cannot import local adoption authority",async()=>{
  const source=setup(),destination=tempStore();try{
    const p=source.store.adoptProductionImages(source.project.id,source.project.revision,"zip-adopt-proof",source.items).project;
    const imported=await importProject(destination.store,await exportProject(source.store,p.id));
    assert.equal(destination.store.db.prepare("SELECT count(*) AS n FROM actions WHERE project_id=?").get(imported.id)!.n,0);
    for(const a of imported.artifacts.filter(a=>a.shotId)) {
      assert.ok(a.metadata.productionAdoption,"Historical adoption evidence survives transfer");
      assert.equal(imported.imageCandidateCurrent?.[a.id],false);
      assert.throws(()=>destination.store.reviewArtifact(a.id,true),/旧的制作条件/);
    }
    assert.equal(destination.store.jobs(imported.id).length,0);
  }finally{source.close();destination.close();}
});

test("complete private backup restore preserves the local action authorizing adoption",async()=>{
  const t=setup(),root=mkdtempSync(join(tmpdir(),"storyflow-adopt-backup-"));let restored:Store|undefined;
  try{
    const result=t.store.adoptProductionImages(t.project.id,t.project.revision,"backup-adopt-proof",t.items);
    t.store.close();const archive=join(root,"backup.tar"),destination=join(root,"restored");
    await backup(t.dir,archive);await restore(destination,archive);restored=new Store(destination);
    const p=restored.project(t.project.id);
    assert.ok(p.artifacts.every(a=>p.imageCandidateCurrent?.[a.id]));
    assert.equal(restored.adoptProductionImages(t.project.id,t.project.revision,"backup-adopt-proof",t.items).adoption.id,result.adoption.id);
  }finally{try{t.store.close();}catch{}restored?.close();rmSync(t.dir,{recursive:true,force:true});rmSync(root,{recursive:true,force:true});}
});

test("failed action persistence rolls back image adoption and its project revision",()=>{
  const t=setup();try{
    const original=t.store.recordAction.bind(t.store);
    t.store.recordAction=(...args:Parameters<Store["recordAction"]>)=>{original(...args);throw new Error("Simulated storage failure");};
    assert.throws(()=>t.store.adoptProductionImages(t.project.id,t.project.revision,"rollback-adopt-1",t.items),/storage failure/);
    const p=t.store.project(t.project.id);
    assert.equal(p.revision,t.project.revision);assert.ok(p.artifacts.every(a=>!a.metadata.productionAdoption));
    assert.ok(p.ontology.shots.every(s=>!s.firstFrameImage));
    assert.equal(t.store.db.prepare("SELECT count(*) AS n FROM actions").get()!.n,0);
  }finally{t.close();}
});

test("stale revisions, hash mismatch, unapproved candidates and corrupted bytes cannot partially bind",()=>{
  const t=setup();try{
    const {id,revision}=t.project;
    assert.throws(()=>t.store.adoptProductionImages(id,revision-1,"stale-adopt-1",t.items),/已更新/);
    assert.throws(()=>t.store.adoptProductionImages(id,revision,"hash-adopt-1",t.items.map((x,i)=>i?x:{...x,sha256:"0".repeat(64)})),/哈希/);
    t.store.reviewArtifact(t.items[0].artifactId,false,"withdrawn");
    assert.throws(()=>t.store.adoptProductionImages(id,revision,"review-adopt-1",t.items),/已通过/);
    t.store.reviewArtifact(t.items[0].artifactId,true,"approved again");
    writeFileSync(t.store.filePath(t.store.artifact(t.items[0].artifactId).fileId),"corrupted bytes");
    assert.throws(()=>t.store.adoptProductionImages(id,revision,"bytes-adopt-1",t.items),/哈希/);
    assert.equal(t.store.project(id).revision,revision);assert.ok(t.store.project(id).ontology.shots.every(s=>!s.firstFrameImage));
    assert.equal(t.store.db.prepare("SELECT count(*) AS n FROM actions").get()!.n,0);
  }finally{t.close();}
});

test("a partial selection never approves or adopts the other displayed pictures",()=>{
  const t=setup();try{
    const selected=t.project.artifacts.find(a=>a.assetId==="room-image")!;
    for(const a of t.project.artifacts.filter(a=>a.id!==selected.id))t.store.reviewArtifact(a.id,false,"still requires review");
    const p=t.store.adoptProductionImages(t.project.id,t.project.revision,"partial-adopt-1",t.items.filter(i=>i.artifactId===selected.id)).project;
    assert.equal(p.ontology.assets.find(a=>a.id==="room-image")?.gap,false);
    assert.equal(p.ontology.assets.find(a=>a.id==="hero-image")?.gap,true);
    assert.ok(p.ontology.shots.every(s=>!s.firstFrameImage));
    assert.ok(p.artifacts.filter(a=>a.id!==selected.id).every(a=>!a.accepted&&!a.metadata.productionAdoption));
    assert.equal(p.jobs.length,0);
  }finally{t.close();}
});

test("a changed parent or a withdrawn image remains blocked after adoption",()=>{
  const t=setup();try{
    let p=t.store.adoptProductionImages(t.project.id,t.project.revision,"parent-adopt-1",t.items).project;
    const asset=p.ontology.assets[0], old=p.artifacts.find(a=>a.assetId===asset.id)!;
    const file=t.store.addFile(p.id,"replacement.png","image/png",Buffer.from("different parent bytes"));
    const replacement=t.store.addArtifact({projectId:p.id,assetId:asset.id,kind:"image",fileId:file.id,jobId:"replacement",sourceHash:imageTargetHash(p.ontology,{assetId:asset.id}),metadata:{}});
    t.store.reviewArtifact(replacement.id,true,"new parent");
    p=t.store.project(p.id);
    assert.ok(p.artifacts.filter(a=>a.shotId).every(a=>p.imageCandidateCurrent?.[a.id]===false));
    assert.throws(()=>t.store.adoptProductionImages(p.id,p.revision,"changed-parent-1",t.items),/当前有效/);
    t.store.reviewArtifact(old.id,false,"withdrawn");assert.equal(t.store.approved(t.store.project(p.id),asset.id),false);
  }finally{t.close();}
});

test("real V6 package adopts 31 assets and 19 first frames but preserves the S06 missing-asset block",()=>{
  const t=tempStore();try{
    const ontology=JSON.parse(readFileSync(new URL("../examples/lupus-v6.json",import.meta.url),"utf8"));
    let p=t.store.create("V6 adoption dry run",{...requirements,duration:60},ontology);
    loadExampleAssets(t.store,p,ontology);p=t.store.edit(p.id,p.revision,{ontology});
    for(const a of p.artifacts)t.store.reviewArtifact(a.id,true,"explicit fixture approval");
    const items=p.artifacts.map(a=>({artifactId:a.id,sha256:t.store.file(a.fileId).sha256}));
    p=t.store.adoptProductionImages(p.id,p.revision,"v6-adopt-batch",items).project;
    assert.equal(p.artifacts.filter(a=>a.assetId&&p.imageCandidateCurrent?.[a.id]).length,31);
    assert.equal(p.artifacts.filter(a=>a.shotId&&p.imageCandidateCurrent?.[a.id]).length,19);
    assert.equal(p.ontology.assets.find(a=>a.id==="A-SYM-FOAM")?.gap,true);
    assert.equal(p.ontology.shots.find(s=>s.id==="S06")?.firstFrameImage,undefined);
    for(const a of p.ontology.assets.filter(a=>a.fileId&&!a.gap))t.store.review(p.id,a.id,"pass","fixture production review");
    for(const s of p.ontology.shots)t.store.review(p.id,s.id,"pass","fixture production review");
    const jobs=dormant(t.store);
    const partial=jobs.enqueueRun(p.id,p.revision,"v6-first-five",["S01","S02","S03","S04","S05"]);
    assert.equal(partial.jobs.length,5);
    assert.throws(()=>jobs.enqueueRun(p.id,p.revision,"v6-full-run"),/S06 缺少素材 A-SYM-FOAM/);
  }finally{t.close();}
});

test("production adoption HTTP endpoint requires authentication and the same origin",async()=>{
  const t=setup();const {createApp}=await import("../server/app.ts");
  const server=createApp(t.store,dormant(t.store),{dist:"/missing"}).listen(0,"127.0.0.1");
  await new Promise<void>(resolve=>server.once("listening",resolve));
  const base=`http://127.0.0.1:${(server.address() as any).port}`, endpoint=`/api/projects/${t.project.id}/production-images/adopt`;
  let cookie="";const body={baseRevision:t.project.revision,idempotencyKey:"http-adopt-1",items:t.items};
  const call=(route:string,value:any,headers:Record<string,string>={})=>fetch(base+route,{method:"POST",headers:{"content-type":"application/json",cookie,...headers},body:JSON.stringify(value)});
  try{
    assert.equal((await call(endpoint,body)).status,401);
    const setup=await call("/api/auth/setup",{password:"adoption-test-password"});cookie=setup.headers.get("set-cookie")!.split(";")[0];
    assert.equal((await call(endpoint,body,{origin:"https://unrelated.invalid"})).status,403);
    const first=await call(endpoint,body);assert.equal(first.status,200);
    const saved=await first.json(),again=await (await call(endpoint,body)).json();
    assert.equal(again.adoption.id,saved.adoption.id);assert.equal(t.store.jobs().length,0);
  }finally{await new Promise<void>(resolve=>server.close(()=>resolve()));t.close();}
});
