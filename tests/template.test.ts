import test from "node:test";
import assert from "node:assert/strict";
import {mkdirSync,writeFileSync,readFileSync} from "node:fs";
import {join} from "node:path";
import {renderToStaticMarkup} from "react-dom/server";
import {createElement} from "react";
import {fixture,requirements,tempStore} from "./helpers.ts";
import {loadExampleAssets,importImageAttemptHistory} from "../server/template.ts";
import {compileOntology,imageTargetHash,validateOntology} from "../shared/ontology.ts";
import {publicSnapshot} from "../server/public-review.ts";
import {ReviewPresentation} from "../src/review/ReviewPresentation.tsx";
import {sha} from "../server/util.ts";
const png=Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jFeYAAAAASUVORK5CYII=","base64");

test("template failed and blocked image evidence is display-only, never a runnable task",()=>{
 const t=tempStore();try{
  const o=fixture();o.assets=[{id:"A-SYM-FOAM",kind:"image",label:"泡沫示意",purpose:"production",gap:true}];
  let p=t.store.create("template-history",requirements,o);
  const before=p.compiled,imageBefore=imageTargetHash(o,{assetId:"A-SYM-FOAM"});
  const attempts=[{target:{assetId:"A-SYM-FOAM"},state:"failed",submitted:true,code:"moderation_blocked",reason:"供应商审核拒绝，未生成图片。",modelRequested:"gpt-image-2",modelActual:null,imagePostNumber:27},
    {target:{shotId:"s1"},state:"blocked",submitted:false,code:"blocked_provider_policy",reason:"前置泡沫资产未完成，本镜未提交。",blockingParent:"A-SYM-FOAM"}];
  loadExampleAssets(t.store,p,o,{manifest:{files:[],candidates:[],imageAttempts:attempts}});p=t.store.edit(p.id,p.revision,{ontology:o});
  assert.equal(p.jobs.length,0);assert.equal(p.artifacts.length,0);assert.equal(p.files.length,0);
  assert.equal(p.ontology.assets[0].imageAttempt?.origin,"external-history");assert.equal(p.ontology.shots[0].imageAttempt?.submitted,false);
  assert.deepEqual(p.compiled.shotHashes,before.shotHashes);assert.deepEqual(p.compiled.targetHashes,before.targetHashes);assert.equal(imageTargetHash(o,{assetId:"A-SYM-FOAM"}),imageBefore);
  assert.equal(validateOntology(o).filter(i=>i.severity==="error").length,0);
  const snapshot=publicSnapshot(p,id=>id);const html=renderToStaticMarkup(createElement(ReviewPresentation,{snapshot}));
  assert.match(html,/moderation_blocked/);assert.match(html,/未提交生成/);assert.match(html,/不会自动重投/);assert.equal(snapshot.items.find(i=>i.id==="A-SYM-FOAM")?.image,undefined);
  assert.throws(()=>importImageAttemptHistory(o,[{...attempts[1],submitted:true}]),/伪装/);
 }finally{t.close();}
});

test("template parents match content SHA across original binding and pending preview; thumbnails retain lineage",()=>{
 const t=tempStore();try{
  const o=fixture();o.assets=[{id:"parent",kind:"image",label:"parent",purpose:"production",gap:true},{id:"child",kind:"image",label:"child",purpose:"production",gap:true}];
  let p=t.store.create("template-lineage",requirements,o);mkdirSync(join(t.dir,"assets"));
  const save=(name:string,tag:string)=>{const bytes=Buffer.concat([png,Buffer.from(tag)]);writeFileSync(join(t.dir,"assets",name),bytes);return {path:`assets/${name}`,sha256:sha(bytes),mime:"image/png"};};
  const old=save("old.png","old"),parent=save("parent.png","new parent"),child=save("child.png","child"),thumb=save("thumb.png","thumbnail");
  loadExampleAssets(t.store,p,o,{directory:t.dir,manifest:{files:[{assetId:"parent",...old}],candidates:[{target:{assetId:"parent"},...parent,metadata:{origin:"ai-generated"}},{target:{assetId:"child"},...child,thumbnail:thumb,metadata:{origin:"ai-generated",parentAssets:[{assetId:"parent",sha256:parent.sha256}]}}]}});
  p=t.store.edit(p.id,p.revision,{ontology:o});
  const candidate=p.artifacts.find(a=>a.assetId==="child")!,parentCandidate=p.artifacts.find(a=>a.assetId==="parent")!;
  assert.equal((candidate.metadata.parentAssets as any[])[0].fileId,parentCandidate.fileId);assert.notEqual((candidate.metadata.parentAssets as any[])[0].fileId,p.ontology.assets[0].fileId);
  assert.equal(t.store.imageCurrent(candidate),true);assert.equal(t.store.file(candidate.metadata.thumbnailFileId as string).sha256,thumb.sha256);
  assert.equal(p.files.length,4);assert.equal(p.jobs.length,0);assert.equal(candidate.accepted,false);
  const original=p.ontology.assets[0];
  const oldDescendant=t.store.addArtifact({projectId:p.id,jobId:"old-lineage",assetId:"child",kind:"image",fileId:candidate.fileId,sourceHash:imageTargetHash(p.ontology,{assetId:"child"}),metadata:{parentAssets:[{assetId:"parent",fileId:original.fileId,sha256:original.sha256}]}});
  assert.equal(t.store.imageCurrent(oldDescendant),true,"original and pending preview lineages coexist before approval");
  const pendingFile=t.store.addFile(p.id,"another-preview.png","image/png",Buffer.concat([png,Buffer.from("another preview")]));
  const pending=t.store.addArtifact({projectId:p.id,jobId:"pending-preview",assetId:"parent",kind:"image",fileId:pendingFile.id,sourceHash:imageTargetHash(p.ontology,{assetId:"parent"}),metadata:{}});
  p=t.store.selectImage(pending.id,p.revision,"preview");
  assert.equal(t.store.imageCurrent(oldDescendant),true,"an unapproved preview never invalidates retained original lineage");
  assert.equal(t.store.imageCurrent(candidate),false,"the superseded pending preview is no longer an active binding");
  t.store.reviewArtifact(parentCandidate.id,true,"select this approved scene");
  assert.equal(t.store.imageCurrent(candidate),true,"approval selects the actual parent independently of another pending preview");
  assert.equal(t.store.imageCurrent(oldDescendant),false,"the newly approved reference supersedes the older original for image generation");
  assert.equal(t.store.project(p.id).ontology.assets[0].fileId,original.fileId,"video input binding is unchanged");
 }finally{t.close();}
});

test("packaged manifest inventory has distinct candidate targets and valid content hashes",()=>{
 const root=new URL("../examples/",import.meta.url),manifest=JSON.parse(readFileSync(new URL("lupus-v6.assets.json",root),"utf8"));
 const candidates=manifest.candidates || [],ids=candidates.map((c:any)=>c.target.assetId || c.target.shotId);
 assert.equal(new Set(ids).size,ids.length);
 for(const item of [...manifest.files,...candidates,...candidates.flatMap((c:any)=>[c.original,c.thumbnail].filter(Boolean))])
  assert.equal(sha(readFileSync(new URL(item.path,root))),item.sha256);
 assert.ok(candidates.length <= 52);
});

test("real template shot reference lineage maps source PNGs and follows changed parent choices",()=>{
 const t=tempStore();try{
  const o=JSON.parse(readFileSync(new URL("../examples/lupus-v6.json",import.meta.url),"utf8"));
  let p=t.store.create("shot-reference-lineage",requirements,o);loadExampleAssets(t.store,p,o);p=t.store.edit(p.id,p.revision,{ontology:o});
  const associations=[["S12","S11"],["S17","S02"],["S20","S19"]];
  for(const [childId,parentId] of associations) {
    const child=p.artifacts.find(a=>a.shotId===childId)!,parent=p.artifacts.find(a=>a.shotId===parentId)!;
    assert.ok(child && parent,"real template has required generated candidates");
    const lineage=(child.metadata.parentShots as any[]).find(r=>r.shotId===parentId);
    assert.ok(lineage,"real shot reference preserved");assert.equal(lineage.sha256,parent.metadata.originalSha256);
    assert.equal(lineage.fileId,parent.metadata.originalFileId || parent.fileId);
    assert.equal(t.store.file(lineage.fileId).sha256,lineage.sha256);assert.equal(t.store.imageCurrent(child),true);
    const file=t.store.addFile(p.id,`replacement-${parentId}.png`,"image/png",Buffer.concat([png,Buffer.from(parentId)]));
    const replacement=t.store.addArtifact({projectId:p.id,jobId:`replacement-${parentId}`,shotId:parentId,kind:"image",fileId:file.id,sourceHash:imageTargetHash(p.ontology,{shotId:parentId}),metadata:{origin:"test-fixture",originalSha256:file.sha256}});
    const generationBefore=p.compiled.shotHashes;p=t.store.selectImage(replacement.id,p.revision,"preview");
    assert.deepEqual(p.compiled.shotHashes,generationBefore);assert.equal(t.store.imageCurrent(child),false);
    assert.throws(()=>t.store.reviewArtifact(child.id,true),/旧的/);
  }
  assert.equal(t.store.jobs(p.id).length,0);
 }finally{t.close();}
});
