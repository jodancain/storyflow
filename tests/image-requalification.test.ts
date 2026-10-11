import test from "node:test";
import assert from "node:assert/strict";
import { writeFileSync, rmSync, mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Store } from "../server/store.ts";
import { Jobs } from "../server/jobs.ts";
import { hash, imageTargetHash } from "../shared/ontology.ts";
import { exportProject, importProject } from "../server/archive.ts";
import { backup } from "../scripts/backup.ts";
import { restore } from "../scripts/restore.ts";
import { fixture, requirements, tempStore } from "./helpers.ts";

function setup() {
  const t=tempStore(),o=fixture();
  o.assets=[{id:"room",label:"独立空场景",kind:"image",purpose:"production",gap:true,mustShow:["素材空场景"],rejectIf:["素材有脸"]}];
  o.shots[0].endFrame=50;o.shots[0].requiredAssetIds=["room"];
  o.shots.push({...structuredClone(o.shots[0]),id:"s2",startFrame:50,endFrame:100,dependencies:["s1"]});
  let p=t.store.create("legacy compiler fixture",requirements,o);
  const parent=t.store.addFile(p.id,"room.png","image/png",Buffer.from("synthetic parent"));
  const asset=t.store.addArtifact({projectId:p.id,assetId:"room",jobId:"fixture",kind:"image",fileId:parent.id,sourceHash:imageTargetHash(o,{assetId:"room"}),metadata:{}});
  o.assets[0].previewImage={artifactId:asset.id,fileId:parent.id,sha256:parent.sha256};
  p=t.store.edit(p.id,p.revision,{ontology:o});
  for(const shot of o.shots) {
    const file=t.store.addFile(p.id,`${shot.id}.png`,"image/png",Buffer.from(`synthetic ${shot.id}`));
    const previous=o.shots.find(s=>s.id==="s1")?.reviewImage;
    const a=t.store.addArtifact({projectId:p.id,shotId:shot.id,jobId:"fixture",kind:"image",fileId:file.id,sourceHash:imageTargetHash(o,{shotId:shot.id}),metadata:{
      parentAssets:[{assetId:"room",fileId:parent.id,sha256:parent.sha256}],
      ...(shot.id==="s2" ? {parentShots:[{shotId:"s1",fileId:previous!.fileId,sha256:previous!.sha256}]} : {}),
      providerReceipt:{model:"synthetic-original",requestHash:"original-request"},
    }});
    shot.reviewImage={artifactId:a.id,fileId:file.id,sha256:file.sha256};
  }
  p=t.store.edit(p.id,p.revision,{ontology:o});
  for(const a of p.artifacts)t.store.reviewArtifact(a.id,true,"original explicit image approval");
  const key="synthetic-original-adoption";
  const adoption=t.store.adoptProductionImages(p.id,p.revision,key,p.artifacts.map(a=>({artifactId:a.id,sha256:t.store.file(a.fileId).sha256}))).adoption;
  // Seed a prior compiler's persisted local adoption evidence. Only its compiled
  // shot briefs differ; actual ontology, image bytes, parents and approvals do not.
  for(const record of adoption.items) if(record.targetId.startsWith("s")) {
    record.adoptedBriefHash=hash({syntheticLegacyCompiler:record.targetId});
    const a=t.store.artifact(record.artifactId);
    a.metadata.productionAdoption=record;a.metadata.productionAdoptionHistory=[record];
    t.store.db.prepare("UPDATE artifacts SET json=? WHERE id=?").run(JSON.stringify(a),a.id);
  }
  t.store.db.prepare("UPDATE actions SET result=? WHERE project_id=? AND key=?").run(JSON.stringify(adoption),p.id,key);
  p=t.store.project(p.id);
  assert.ok(p.artifacts.filter(a=>a.shotId).every(a=>!p.imageCandidateCurrent?.[a.id]));
  const items=p.artifacts.filter(a=>a.shotId).map(a=>({artifactId:a.id,sha256:t.store.file(a.fileId).sha256,
    oldBriefHash:(a.metadata.productionAdoption as any).adoptedBriefHash,newBriefHash:p.imageTargetHashes![a.shotId!],note:"核对同一实际画面，明确复用于更正后的编译条件"}));
  return {...t,project:p,items,parent};
}
const dormant=(s:Store)=>{const j=new Jobs(s,new Proxy({},{get:()=>{throw new Error("No provider access in requalification tests");}}) as any);j.stop();return j;};

test("explicit same-ontology requalification preserves source evidence, bindings and original approval",()=>{
  const t=setup();try{
    const before=t.project,r=t.store.requalifyProductionImages(before.id,before.revision,"requalify-exact-1",t.items),p=r.project;
    assert.equal(p.revision,before.revision+1);assert.deepEqual(p.ontology,before.ontology);assert.equal(p.jobs.length,0);
    for(const a of p.artifacts) {
      const old=before.artifacts.find(x=>x.id===a.id)!;
      assert.equal(a.sourceHash,old.sourceHash);assert.equal(a.fileId,old.fileId);assert.equal(a.accepted,old.accepted);
      assert.deepEqual(a.metadata.providerReceipt,old.metadata.providerReceipt);assert.deepEqual(a.metadata.productionAdoption,old.metadata.productionAdoption);
      assert.equal(p.imageCandidateCurrent?.[a.id],true);
      if(a.shotId) {
        const evidence=a.metadata.imageRequalification as any;
        assert.equal(evidence.originalApproval.reviewNote,"original explicit image approval");
        assert.equal(evidence.lineageHash,hash(evidence.lineage));
        assert.equal(t.store.approved(p,a.shotId),false);
      }
    }
  }finally{t.close();}
});

test("dependent images cannot be requalified ahead of their current parent; failure rolls back",()=>{
  const t=setup();try{
    const child=t.items.find(x=>t.store.artifact(x.artifactId).shotId==="s2")!,parent=t.items.find(x=>x!==child)!;
    assert.throws(()=>t.store.requalifyProductionImages(t.project.id,t.project.revision,"child-before-parent",[child]),/父图或身份/);
    assert.equal(t.store.project(t.project.id).revision,t.project.revision);
    assert.equal(t.store.artifact(child.artifactId).metadata.imageRequalification,undefined);
    const first=t.store.requalifyProductionImages(t.project.id,t.project.revision,"parent-review-first",[parent]);
    assert.equal(first.project.imageCandidateCurrent?.[child.artifactId],false);
    const second=t.store.requalifyProductionImages(t.project.id,first.project.revision,"child-review-after",[child]);
    assert.equal(second.project.imageCandidateCurrent?.[child.artifactId],true);
  }finally{t.close();}
});

test("changed ontology, withdrawal, wrong hashes and actual corrupt parent bytes fail closed",()=>{
  const t=setup();try{
    const id=t.project.id,rev=t.project.revision;
    assert.throws(()=>t.store.requalifyProductionImages(id,rev-1,"wrong-review-revision",t.items),/已更新/);
    assert.throws(()=>t.store.requalifyProductionImages(id,rev,"wrong-image-hash",t.items.map((x,i)=>i?x:{...x,sha256:"0".repeat(64)})),/条件不匹配/);
    assert.throws(()=>t.store.requalifyProductionImages(id,rev,"wrong-new-brief",t.items.map((x,i)=>i?x:{...x,newBriefHash:"0".repeat(64)})),/制作条件/);
    t.store.reviewArtifact(t.items[0].artifactId,false,"withdrawn");
    assert.throws(()=>t.store.requalifyProductionImages(id,rev,"withdrawn-image-review",t.items),/撤回/);
  }finally{t.close();}
  const changed=setup();try{
    const o=structuredClone(changed.project.ontology);o.shots[0].action="different action";
    const p=changed.store.edit(changed.project.id,changed.project.revision,{ontology:o});
    const items=changed.items.map(x=>({...x,newBriefHash:p.imageTargetHashes![changed.store.artifact(x.artifactId).shotId!]}));
    assert.throws(()=>changed.store.requalifyProductionImages(p.id,p.revision,"changed-ontology-review",items),/本体内容已变化/);
  }finally{changed.close();}
  const corrupt=setup();try{
    writeFileSync(corrupt.store.filePath(corrupt.parent.id),"corrupted bytes");
    assert.throws(()=>corrupt.store.requalifyProductionImages(corrupt.project.id,corrupt.project.revision,"corrupt-parent-review",corrupt.items),/哈希/);
  }finally{corrupt.close();}
});

test("local actions are required; forged metadata and portable imports cannot authorize reuse",async()=>{
  const t=setup(),destination=tempStore();try{
    const p=t.store.requalifyProductionImages(t.project.id,t.project.revision,"trusted-requalify-proof",t.items).project;
    const exported=await exportProject(t.store,p.id),imported=await importProject(destination.store,exported);
    assert.equal(destination.store.db.prepare("SELECT count(*) AS n FROM actions").get()!.n,0);
    assert.ok(imported.artifacts.filter(a=>a.shotId).every(a=>a.metadata.imageRequalification&&!imported.imageCandidateCurrent?.[a.id]));
    const artifact=t.store.artifact(t.items[0].artifactId);
    const evidence=artifact.metadata.imageRequalification as any;
    artifact.metadata.imageRequalification={...evidence,note:"forged review"};
    t.store.db.prepare("UPDATE artifacts SET json=? WHERE id=?").run(JSON.stringify(artifact),artifact.id);
    assert.equal(t.store.imageCurrent(artifact),false);
    t.store.db.prepare("DELETE FROM actions WHERE project_id=?").run(p.id);
    assert.ok(t.store.project(p.id).artifacts.filter(a=>a.shotId).every(a=>!t.store.imageCurrent(a)));
    assert.throws(()=>t.store.requalifyProductionImages(p.id,p.revision,"metadata-only-reuse",t.items),/原始批准采用/);
  }finally{t.close();destination.close();}
});

test("requalification is idempotent across restart and full private backup restore",async()=>{
  const t=setup(),root=mkdtempSync(join(tmpdir(),"storyflow-requalify-backup-"));let restored:Store|undefined;
  try{
    const result=t.store.requalifyProductionImages(t.project.id,t.project.revision,"durable-requalification",t.items);
    t.store.close();t.store=new Store(t.dir);
    const replay=t.store.requalifyProductionImages(t.project.id,t.project.revision,"durable-requalification",[...t.items].reverse());
    assert.equal(replay.requalification.id,result.requalification.id);assert.equal(replay.project.revision,result.project.revision);
    t.store.close();const file=join(root,"backup.tar"),dir=join(root,"restored");
    await backup(t.dir,file);await restore(dir,file);restored=new Store(dir);
    const p=restored.project(t.project.id);assert.ok(p.artifacts.every(a=>p.imageCandidateCurrent?.[a.id]));
    const o=structuredClone(p.ontology);o.shots[0].subtitles=[{id:"new-subtitle",text:"new caption",startFrame:0,endFrame:50}];
    const edited=restored.edit(p.id,p.revision,{ontology:o});
    assert.ok(edited.artifacts.every(a=>edited.imageCandidateCurrent?.[a.id]),"later caption-only changes retain source pictures");
    o.shots[0].action="new visible action after requalification";
    const changed=restored.edit(p.id,edited.revision,{ontology:o});
    assert.ok(changed.artifacts.filter(a=>a.shotId).every(a=>!changed.imageCandidateCurrent?.[a.id]),"later content changes invalidate requalified images and their dependants");
    const staleReplay=restored.requalifyProductionImages(t.project.id,t.project.revision,"durable-requalification",t.items);
    assert.equal(staleReplay.project.revision,changed.revision);
    assert.ok(staleReplay.project.artifacts.filter(a=>a.shotId).every(a=>!staleReplay.project.imageCandidateCurrent?.[a.id]),"idempotency replay cannot restore old current status");
  }finally{try{t.store.close();}catch{}restored?.close();rmSync(t.dir,{recursive:true,force:true});rmSync(root,{recursive:true,force:true});}
});

test("failure saving the local action rolls back revision and every requalification record",()=>{
  const t=setup();try{
    const original=t.store.recordAction.bind(t.store);
    t.store.recordAction=(...args:Parameters<Store["recordAction"]>)=>{original(...args);throw new Error("injected action save failure");};
    assert.throws(()=>t.store.requalifyProductionImages(t.project.id,t.project.revision,"atomic-requalify-failure",t.items),/injected action/);
    const p=t.store.project(t.project.id);assert.equal(p.revision,t.project.revision);
    assert.ok(p.artifacts.every(a=>!a.metadata.imageRequalification));
    assert.equal(t.store.db.prepare("SELECT count(*) AS n FROM actions WHERE key=?").get("atomic-requalify-failure")!.n,0);
  }finally{t.close();}
});

test("requalification HTTP endpoint requires admin and same-origin; creates no jobs",async()=>{
  const t=setup();const {createApp}=await import("../server/app.ts");
  const server=createApp(t.store,dormant(t.store),{dist:"/missing"}).listen(0,"127.0.0.1");
  await new Promise<void>(resolve=>server.once("listening",resolve));
  const base=`http://127.0.0.1:${(server.address() as any).port}`,route=`/api/projects/${t.project.id}/production-images/requalify`;
  const body={baseRevision:t.project.revision,idempotencyKey:"http-requalify-test",items:t.items};let cookie="";
  const call=(path:string,value:any,headers:Record<string,string>={})=>fetch(base+path,{method:"POST",headers:{"content-type":"application/json",cookie,...headers},body:JSON.stringify(value)});
  try{
    assert.equal((await call(route,body)).status,401);
    const auth=await call("/api/auth/setup",{password:"requalification-test-password"});cookie=auth.headers.get("set-cookie")!.split(";")[0];
    assert.equal((await call(route,body,{origin:"https://unrelated.invalid"})).status,403);
    const response=await call(route,body);assert.equal(response.status,200);
    const saved=await response.json();assert.equal(saved.requalification.items.length,2);assert.equal(t.store.jobs().length,0);
  }finally{await new Promise<void>(resolve=>server.close(()=>resolve()));t.close();}
});
