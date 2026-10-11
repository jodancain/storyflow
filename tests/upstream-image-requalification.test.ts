import test from "node:test";
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { hash, imageTargetHash } from "../shared/ontology.ts";
import type { Ontology, Project } from "../shared/types.ts";
import { exportProject, importProject } from "../server/archive.ts";
import { fixture, requirements, tempStore } from "./helpers.ts";

const scope="explicit-review-of-unchanged-shot-inputs" as const;
const sid=(n:number)=>`S${String(n).padStart(2,"0")}`;

function setup() {
  const t=tempStore(),o=fixture();
  o.spec.totalFrames=1500;
  o.assets=[
    {id:"master",label:"角色基准",kind:"image",purpose:"production",gap:true,imageComposition:{visibleCharacters:[{characterId:"hero",wardrobeId:"home",visibility:"face"}]}},
    {id:"room",label:"居家场景",kind:"image",purpose:"production",gap:true,imageComposition:{visibleCharacters:[]}},
  ];
  o.imageConsistency={version:1,enforceApprovedIdentity:true,characters:[{characterId:"hero",identityAssetId:"master",visibility:"person",appearance:"同一虚构角色",wardrobes:[{id:"home",description:"蓝衣"}]}]};
  const prototype=o.shots[0];
  o.shots=Array.from({length:20},(_,i)=>({...structuredClone(prototype),id:sid(i+1),title:`镜头${i+1}`,startFrame:i*75,endFrame:(i+1)*75,
    requiredAssetIds:["room"],dependencies:i?[sid(i)]:[],imageComposition:{visibleCharacters:[{characterId:"hero",wardrobeId:"home",visibility:"face"}]}}));
  let p=t.store.create("twenty-shot synthetic requalification",{...requirements,duration:60},o);
  for(const asset of o.assets) {
    const f=t.store.addFile(p.id,`${asset.id}.png`,"image/png",Buffer.from(`synthetic asset ${asset.id}`));
    const a=t.store.addArtifact({projectId:p.id,assetId:asset.id,jobId:"fixture",kind:"image",fileId:f.id,sourceHash:imageTargetHash(o,{assetId:asset.id}),metadata:{}});
    asset.previewImage={artifactId:a.id,fileId:f.id,sha256:f.sha256};
  }
  p=t.store.edit(p.id,p.revision,{ontology:o});
  for(const a of p.artifacts)t.store.reviewArtifact(a.id,true,"original explicit asset approval");
  const master=o.assets[0].previewImage!,room=o.assets[1].previewImage!;
  for(const shot of o.shots) {
    if(shot.id==="S06")continue;
    const f=t.store.addFile(p.id,`${shot.id}.png`,"image/png",Buffer.from(`synthetic shot ${shot.id}`));
    const parentId=({S12:"S11",S17:"S02",S20:"S19"} as Record<string,string>)[shot.id];
    const parent=parentId?o.shots.find(s=>s.id===parentId)!.reviewImage:undefined;
    const a=t.store.addArtifact({projectId:p.id,shotId:shot.id,jobId:"fixture",kind:"image",fileId:f.id,sourceHash:imageTargetHash(o,{shotId:shot.id}),metadata:{
      parentAssets:[{assetId:"master",fileId:master.fileId,sha256:master.sha256},{assetId:"room",fileId:room.fileId,sha256:room.sha256}],
      ...(parent ? {parentShots:[{shotId:parentId,fileId:parent.fileId,sha256:parent.sha256}]} : {}),
      identityReferences:[{characterId:"hero",assetId:"master",...master}],consistencyContract:{version:1},
      providerReceipt:{model:"synthetic-original",requestHash:`original-${shot.id}`},
    }});
    shot.reviewImage={artifactId:a.id,fileId:f.id,sha256:f.sha256};
  }
  p=t.store.edit(p.id,p.revision,{ontology:o});
  for(const a of p.artifacts.filter(a=>a.shotId))t.store.reviewArtifact(a.id,true,"original explicit image approval");
  const adoptionKey="original-twenty-shot-adoption";
  const adopted=t.store.adoptProductionImages(p.id,p.revision,adoptionKey,p.artifacts.map(a=>({artifactId:a.id,sha256:t.store.file(a.fileId).sha256}))).adoption;
  // Simulate the older compiler's persisted brief while retaining real local
  // adoption and later requalification actions. No generation source is changed.
  for(const record of adopted.items)if(record.targetId.startsWith("S")) {
    record.adoptedBriefHash=hash({previousCompiler:record.targetId});
    const a=t.store.artifact(record.artifactId);a.metadata.productionAdoption=record;a.metadata.productionAdoptionHistory=[record];
    t.store.db.prepare("UPDATE artifacts SET json=? WHERE id=?").run(JSON.stringify(a),a.id);
  }
  t.store.db.prepare("UPDATE actions SET result=? WHERE project_id=? AND key=?").run(JSON.stringify(adopted),p.id,adoptionKey);
  p=t.store.project(p.id);
  const items=(project:Project)=>project.artifacts.filter(a=>a.shotId&&a.kind==="image"&&!project.imageCandidateCurrent?.[a.id]).map(a=>({
    artifactId:a.id,sha256:t.store.file(a.fileId).sha256,oldBriefHash:(a.metadata.productionAdoption as any).adoptedBriefHash,
    newBriefHash:project.imageTargetHashes![a.shotId!],note:"逐镜核对实际画面及全部引用未变，仅上游剧情修订"}));
  p=t.store.requalifyProductionImages(p.id,p.revision,"initial-compiler-requalification",items(p)).project;
  const first=t.store.addFile(p.id,"S01.mp4","video/mp4",Buffer.from("synthetic preexisting video"));
  t.store.addArtifact({projectId:p.id,shotId:"S01",jobId:"fixture",kind:"video",fileId:first.id,sourceHash:p.compiled.shotHashes.S01,metadata:{origin:"test-only"}});
  p=t.store.project(p.id);
  const edit=(change?:(o:Ontology)=>void)=>{
    const o=structuredClone(p.ontology);o.shots[5].route="graphic";o.shots[5].action="症状记录图示";change?.(o);
    return t.store.edit(p.id,p.revision,{ontology:o});
  };
  return {...t,project:p,items,edit};
}

test("S06-only change requires explicit review of 14 downstream images; five images and S01 video remain unchanged",()=>{
  const t=setup();try{
    const before=t.project,p=t.edit(),items=t.items(p);
    assert.equal(items.length,14);
    assert.deepEqual(items.map(x=>t.store.artifact(x.artifactId).shotId).sort(),Array.from({length:14},(_,i)=>sid(i+7)));
    assert.throws(()=>t.store.requalifyProductionImages(p.id,p.revision,"default-scope-still-strict",items),/本体内容已变化/);
    const result=t.store.requalifyProductionImages(p.id,p.revision,"review-unchanged-downstream",items,scope),current=result.project;
    assert.equal(current.revision,p.revision+1);assert.deepEqual(current.ontology,p.ontology);assert.equal(current.jobs.length,0);
    for(const a of current.artifacts.filter(a=>a.kind==="image")) {
      const original=before.artifacts.find(x=>x.id===a.id)!;
      assert.ok(current.imageCandidateCurrent?.[a.id]);assert.equal(a.sourceHash,original.sourceHash);
      assert.equal(a.fileId,original.fileId);assert.equal(a.accepted,original.accepted);
      assert.deepEqual(a.metadata.providerReceipt,original.metadata.providerReceipt);
      assert.deepEqual(a.metadata.productionAdoption,original.metadata.productionAdoption);
    }
    for(const record of result.requalification.items) {
      assert.equal(record.scope,scope);assert.deepEqual(record.inputBasis!.before,record.inputBasis!.after);
      assert.equal(record.previousQualification!.scope,"unchanged-ontology-compiler-review");
      assert.equal(t.store.approved(current,record.targetId),false,"image review does not approve script/video generation");
    }
    const video=current.artifacts.find(a=>a.kind==="video")!;
    assert.equal(video.sourceHash,current.compiled.shotHashes.S01);assert.equal(video.accepted,false);
    const replay=t.store.requalifyProductionImages(p.id,p.revision,"review-unchanged-downstream",[...items].reverse(),scope);
    assert.equal(replay.requalification.id,result.requalification.id);
    const o=structuredClone(current.ontology);o.shots[5].action="再次改变上游图示";
    const later=t.store.edit(current.id,current.revision,{ontology:o});
    assert.equal(t.items(later).length,14,"later upstream changes never automatically inherit image reuse");
    const reviewed=t.store.requalifyProductionImages(later.id,later.revision,"second-explicit-upstream-review",t.items(later),scope).project;
    assert.ok(reviewed.artifacts.filter(a=>a.kind==="image").every(a=>reviewed.imageCandidateCurrent?.[a.id]));
  }finally{t.close();}
});

test("own shot, entity, material, identity, camera, dialogue and direct dependencies cannot use upstream-only scope",()=>{
  const cases:[string,(o:Ontology)=>void][]=[
    ["own action",o=>{o.shots[6].action="完全不同的动作";}],
    ["entity",o=>{o.entities[0].attributes.appearance="changed";}],
    ["asset",o=>{o.assets[1].mustShow=["changed setting"];}],
    ["identity",o=>{o.imageConsistency!.characters[0].appearance="different face";}],
    ["wardrobe",o=>{o.imageConsistency!.characters[0].wardrobes[0].description="红衣";}],
    ["camera",o=>{o.shots[6].camera="新机位";}],
    ["dialogue",o=>{o.shots[6].dialogue=[{id:"new-line",speakerId:"hero",text:"新的台词"}];}],
    ["dependency",o=>{o.shots[6].dependencies=["S05"];}],
  ];
  for(const [name,change] of cases) {
    const t=setup();try{
      const p=t.edit(change),a=p.artifacts.find(a=>a.shotId==="S07"&&a.kind==="image")!;
      const item={artifactId:a.id,sha256:t.store.file(a.fileId).sha256,oldBriefHash:(a.metadata.productionAdoption as any).adoptedBriefHash,newBriefHash:p.imageTargetHashes!.S07,note:name};
      assert.throws(()=>t.store.requalifyProductionImages(p.id,p.revision,`reject-${name}`, [item],scope),/镜头自身、实体、素材、身份或直接依赖已变化/,name);
      assert.equal(t.store.project(p.id).revision,p.revision);
    }finally{t.close();}
  }
});

test("changed image bindings and real parent bytes fail closed and roll back the entire batch",()=>{
  const t=setup();try{
    const p=t.edit(o=>{o.shots[6].firstFrameImage=o.shots[7].firstFrameImage;});
    assert.throws(()=>t.store.requalifyProductionImages(p.id,p.revision,"reject-other-first-frame",t.items(p),scope),/绑定已变化/);
    assert.equal(t.store.project(p.id).revision,p.revision);
  }finally{t.close();}
  const corrupt=setup();try{
    const p=corrupt.edit(),room=p.ontology.assets.find(a=>a.id==="room")!;
    writeFileSync(corrupt.store.filePath(room.fileId!),"changed actual parent pixels");
    assert.throws(()=>corrupt.store.requalifyProductionImages(p.id,p.revision,"reject-corrupted-parent",corrupt.items(p),scope),/哈希/);
    assert.equal(corrupt.store.project(p.id).revision,p.revision);
  }finally{corrupt.close();}
});

test("original trusted lineage is mandatory, including exact parent file identity and prior local action",()=>{
  for(const mode of ["different-parent-id","missing-action","tampered-identity"]) {
    const t=setup();try{
      const p=t.edit(),a=t.store.artifact(t.items(p).find(i=>t.store.artifact(i.artifactId).shotId==="S07")!.artifactId);
      if(mode==="different-parent-id") {
        const parent=(a.metadata.parentAssets as any[])[1],f=t.store.addFile(p.id,"same-pixels.png","image/png",t.store.bytes(parent.fileId));
        parent.fileId=f.id;
      } else if(mode==="tampered-identity") (a.metadata.identityReferences as any[])[0].characterId="different-identity";
      else t.store.db.prepare("DELETE FROM actions WHERE project_id=? AND key=?").run(p.id,"initial-compiler-requalification");
      t.store.db.prepare("UPDATE artifacts SET json=? WHERE id=?").run(JSON.stringify(a),a.id);
      assert.throws(()=>t.store.requalifyProductionImages(p.id,p.revision,`reject-${mode}`,t.items(p),scope),/缺少原引用条件/,mode);
      assert.equal(t.store.project(p.id).revision,p.revision);
    }finally{t.close();}
  }
});

test("upstream reuse cannot precede its actual parent shot and action failures remain atomic",()=>{
  const t=setup();try{
    const p=t.edit(),items=t.items(p),child=items.find(x=>t.store.artifact(x.artifactId).shotId==="S12")!;
    assert.throws(()=>t.store.requalifyProductionImages(p.id,p.revision,"child-ahead-of-parent",[child],scope),/父图或身份/);
    const original=t.store.recordAction.bind(t.store);
    t.store.recordAction=(...args:Parameters<typeof original>)=>{original(...args);throw new Error("injected upstream action failure");};
    assert.throws(()=>t.store.requalifyProductionImages(p.id,p.revision,"atomic-upstream-proof",items,scope),/injected upstream/);
    const after=t.store.project(p.id);assert.equal(after.revision,p.revision);
    assert.ok(after.artifacts.filter(a=>a.shotId&&a.kind==="image").every(a=>(a.metadata.imageRequalification as any).scope==="unchanged-ontology-compiler-review"));
    assert.equal(t.store.db.prepare("SELECT count(*) AS n FROM actions WHERE key=?").get("atomic-upstream-proof")!.n,0);
  }finally{t.close();}
});

test("portable imports cannot grant current status from historical upstream reuse metadata",async()=>{
  const t=setup(),destination=tempStore();try{
    const p=t.edit(),current=t.store.requalifyProductionImages(p.id,p.revision,"export-upstream-reuse-proof",t.items(p),scope).project;
    const imported=await importProject(destination.store,await exportProject(t.store,current.id));
    assert.equal(destination.store.db.prepare("SELECT count(*) AS n FROM actions").get()!.n,0);
    assert.ok(imported.artifacts.filter(a=>a.kind==="image"&&Number(a.shotId?.slice(1))>=7).every(a=>!imported.imageCandidateCurrent?.[a.id]));
  }finally{t.close();destination.close();}
});
