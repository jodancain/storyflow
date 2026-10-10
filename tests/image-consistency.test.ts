import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { compileOntology, imageTargetHashes, validateOntology } from "../shared/ontology.ts";
import { inspectImageConsistency, resolveImageConsistency, validateImageConsistency } from "../shared/image-consistency.ts";
import type { Artifact, Ontology, Project } from "../shared/types.ts";
import { fixture, requirements, tempStore, mockMedia } from "./helpers.ts";

function strict(): Ontology {
  const o = fixture();
  o.assets = [
    {id:"hero-master", label:"女主基准", kind:"image", purpose:"production", gap:true, imageComposition:{visibleCharacters:[{characterId:"hero",wardrobeId:"home",visibility:"face"}]}},
    {id:"room", label:"空房间", kind:"image", purpose:"production", gap:true, imageComposition:{visibleCharacters:[]}},
  ];
  o.imageConsistency={version:1,enforceApprovedIdentity:true,characters:[{characterId:"hero",identityAssetId:"hero-master",visibility:"person",appearance:"同一及肩深棕披发与五官",wardrobes:[{id:"home",description:"米白针织衣"},{id:"outdoor",description:"同一针织衣外穿防晒外套"}]}]};
  o.shots[0].imageComposition={visibleCharacters:[{characterId:"hero",wardrobeId:"home",visibility:"face"}]};
  return o;
}
function specifiedPerson(): Ontology {
  const o=strict();
  o.imageConsistency!.characters[0].referenceSourceAssetId="original-portrait";
  o.assets.push({id:"original-portrait",label:"指定人物原照",kind:"image",purpose:"reference",gap:true});
  return o;
}
function project(ontology = strict()): Project {
  return {id:"p",revision:1,name:"fixture",requirements,ontology,compiled:compileOntology(ontology),imageTargetHashes:imageTargetHashes(ontology),imageCandidateCurrent:{},files:[],artifacts:[],reviews:[],jobs:[],createdAt:"",updatedAt:""};
}
function master(p:Project, id="approved-new", accepted=true):Artifact {
  const fileId=`file-${id}`, sha256=(id === "approved-new" ? "a" : "b").repeat(64);
  p.files.push({id:fileId,projectId:p.id,name:"master.png",mime:"image/png",sha256,bytes:1,relativePath:"media/fixture",createdAt:""});
  const a:Artifact={id,projectId:p.id,jobId:"fixture",assetId:"hero-master",kind:"image",fileId,sourceHash:p.imageTargetHashes!["hero-master"],accepted,metadata:{},createdAt:""};
  p.artifacts.push(a);p.imageCandidateCurrent![id]=true;return a;
}

test("identity policy remains optional for legacy projects, but partial contracts cannot bypass validation",()=>{
  const o=fixture(); assert.deepEqual(validateImageConsistency(o),[]);
  assert.equal(inspectImageConsistency(project(o),"s1").ready,true);
  o.shots[0].imageComposition={visibleCharacters:[]};
  assert.ok(validateOntology(o).some(i=>i.code==="identity_policy_missing"));
});

test("strict contracts reject unknown characters, wardrobe states, mixed masters and visible faces on hand-only roles",()=>{
  const cases:[(o:Ontology)=>void,string][]=[
    [o=>{o.shots[0].imageComposition!.visibleCharacters[0].characterId="unknown";},"unknown_identity_character"],
    [o=>{o.shots[0].imageComposition!.visibleCharacters[0].wardrobeId="unknown";},"unknown_wardrobe"],
    [o=>{o.imageConsistency!.characters[0].visibility="hands-only";},"forbidden_character_face"],
    [o=>{o.assets[0].imageComposition!.visibleCharacters=[];},"mixed_identity_master"],
    [o=>{delete o.shots[0].imageComposition;},"missing_image_composition"],
    [o=>{o.imageConsistency!.characters.push(structuredClone(o.imageConsistency!.characters[0]));},"shared_identity_asset"],
  ];
  for(const [edit,code] of cases){const o=strict();edit(o);assert.ok(validateOntology(o).some(i=>i.code===code),code);}
  const malformed = strict() as any; malformed.imageConsistency={version:1,enforceApprovedIdentity:true,characters:[null]};
  assert.doesNotThrow(()=>compileOntology(malformed));
  assert.ok(validateOntology(malformed).some(i=>i.code==="invalid_identity_profile"));
});

test("master candidates can be created first; actor shots and symptom variants wait for human approval",()=>{
  const p=project();
  assert.equal(inspectImageConsistency(p,"hero-master").ready,true);
  const pending=inspectImageConsistency(p,"s1",[]);
  assert.equal(pending.ready,false);assert.deepEqual(pending.requiredIdentityAssetIds,["hero-master"]);
  assert.deepEqual(pending.referenceAssetIds,["hero-master"]);assert.ok(pending.issues.some(i=>i.code==="identity_not_approved"));
  master(p,"pending",false);assert.equal(inspectImageConsistency(p,"s1").ready,false);
});

test("specified-person master requires the reviewed original source, while approved derivatives work without it downstream",()=>{
  const p=project(specifiedPerson());
  let inspection=inspectImageConsistency(p,"hero-master");
  assert.equal(inspection.ready,false);assert.ok(inspection.issues.some(i=>i.code==="identity_source_missing"));
  assert.deepEqual(inspection.requiredSourceAssetIds,["original-portrait"]);
  master(p);assert.equal(inspectImageConsistency(p,"s1").ready,true);
  assert.deepEqual(inspectImageConsistency(p,"s1").referenceAssetIds,["hero-master"]);
  const file={id:"original-file",projectId:p.id,name:"original.png",mime:"image/png",sha256:"e".repeat(64),bytes:1,relativePath:"private/source",createdAt:""};
  p.files.push(file);const source=p.ontology.assets.find(a=>a.id==="original-portrait")!;
  source.fileId=file.id;source.sha256=file.sha256;source.gap=false;p.compiled=compileOntology(p.ontology);
  inspection=inspectImageConsistency(p,"hero-master");
  assert.ok(inspection.issues.some(i=>i.code==="identity_source_not_approved"));
  p.reviews.push({targetId:source.id,targetHash:p.compiled.targetHashes[source.id],status:"pass",note:"原照与本人授权已核对",updatedAt:""});
  inspection=inspectImageConsistency(p,"hero-master",["room"]);
  assert.equal(inspection.ready,true);assert.deepEqual(inspection.referenceAssetIds,["original-portrait","room"]);
  assert.equal(inspection.identityReferences[0].role,"source");assert.equal(inspection.identityReferences[0].sha256,file.sha256);
  assert.equal(inspection.identityReferences[0].fileId,file.id);assert.match(inspection.promptGuard,/不得按文字虚构替代医生/);
  assert.ok(inspectImageConsistency(p,"s1",["original-portrait"]).issues.some(i=>i.code==="identity_source_scope"));
  assert.ok(inspectImageConsistency(p,"hero-master",["hero-master"]).issues.some(i=>i.code==="identity_source_conflict"));
  p.artifacts.push({id:"generated-imposter",projectId:p.id,jobId:"old-image",assetId:"original-portrait",kind:"image",fileId:file.id,sourceHash:p.compiled.targetHashes[source.id],accepted:true,metadata:{},createdAt:""});
  assert.ok(inspectImageConsistency(p,"hero-master").issues.some(i=>i.code==="identity_source_not_original"));
});

test("original-source contracts reject unknown, self, non-image and production identity sources",()=>{
  const missing=specifiedPerson();missing.imageConsistency!.characters[0].referenceSourceAssetId="missing";
  assert.ok(validateOntology(missing).some(i=>i.code==="invalid_identity_source"));
  const self=specifiedPerson();self.imageConsistency!.characters[0].referenceSourceAssetId="hero-master";
  assert.ok(validateOntology(self).some(i=>i.code==="identity_source_self"));
  const document=specifiedPerson();document.assets[2].kind="document";
  assert.ok(validateOntology(document).some(i=>i.code==="invalid_identity_source"));
  const production=specifiedPerson();production.assets[2].purpose="production";
  assert.ok(validateOntology(production).some(i=>i.code==="invalid_identity_source"));
});

test("rejecting a specified doctor without the private original saves feedback and never falls back to text generation",async()=>{
  const {Jobs}=await import("../server/jobs.ts"),{Providers}=await import("../server/providers.ts"),{submitReviews}=await import("../server/review-submissions.ts");
  const t=tempStore();try {
    const p=t.store.create("specified-person",requirements,specifiedPerson());
    const file=t.store.addFile(p.id,"old-doctor.png","image/png",Buffer.from("fixture-only"));
    const a=t.store.addArtifact({projectId:p.id,assetId:"hero-master",kind:"image",jobId:"old-candidate",fileId:file.id,sourceHash:imageTargetHashes(p.ontology)["hero-master"],metadata:{consistencyContract:"legacy-unverified"}});
    let calls=0;
    const provider=new Providers({imageBase:"http://image.example/v1",imageKey:"test-only",imageModel:"test",seedanceBase:"",seedanceKey:"",seedanceModel:"",falKey:"",falBase:"",opusBase:"",opusKey:"",opusModel:"",allowPrivate:true},{fetchImpl:(async()=>{calls++;throw new Error("must not submit");}) as any});
    const jobs=new Jobs(t.store,provider,mockMedia());jobs.stopped=true;
    const result=submitReviews(t.store,jobs,p.id,p.revision,"fix-specified-doctor",[{targetId:"hero-master",targetHash:p.compiled.targetHashes["hero-master"],imageId:a.id,imageSha256:file.sha256,status:"change",note:"只按指定医生原照修正面孔"}]);
    assert.equal(result.submission.items[0].outcome,"blocked");assert.equal(result.submission.items[0].blocked?.code,"identity_source_missing");
    assert.equal(result.jobs.length,0);assert.equal(t.store.reviewSubmissions(p.id).length,1);
    jobs.stopped=false;await jobs.tick();jobs.stopped=true;assert.equal(calls,0);
  } finally {t.close();}
});

test("the unique currently approved master overrides older display and production bindings without losing byte identity",()=>{
  const p=project(),old=master(p,"old",false),current=master(p);
  p.ontology.assets[0].fileId=old.fileId;p.ontology.assets[0].sha256=p.files[0].sha256;
  p.ontology.assets[0].previewImage={artifactId:old.id,fileId:old.fileId,sha256:p.files[0].sha256};
  const inspection=inspectImageConsistency(p,"s1",["room"]);
  assert.equal(inspection.ready,true);assert.deepEqual(inspection.referenceAssetIds,["hero-master","room"]);
  assert.equal(inspection.identityReferences[0].artifactId,current.id);assert.equal(inspection.identityReferences[0].fileId,current.fileId);
  assert.equal(inspection.identityReferences[0].sha256,"a".repeat(64));
  assert.match(inspection.promptGuard,/其他参考图只提供场景/);
  p.imageCandidateCurrent![current.id]=false;assert.equal(inspectImageConsistency(p,"s1").ready,false);
});

test("ambiguous approved masters, unreviewed imported bytes and stale approvals cannot silently pick an identity",()=>{
  const p=project();master(p);master(p,"second");
  assert.ok(inspectImageConsistency(p,"s1").issues.some(i=>i.code==="identity_selection_ambiguous"));
  p.artifacts=[];p.ontology.assets[0].fileId=p.files[0].id;p.ontology.assets[0].sha256=p.files[0].sha256;
  assert.equal(inspectImageConsistency(p,"s1").ready,false);
  p.reviews.push({targetId:"hero-master",targetHash:p.compiled.targetHashes["hero-master"],status:"pass",note:"已核对身份",updatedAt:""});
  assert.equal(inspectImageConsistency(p,"s1").ready,true);
  p.reviews[0].targetHash="old-snapshot";assert.equal(inspectImageConsistency(p,"s1").ready,false);
});

test("optional references cannot smuggle undeclared characters or previously rejected room people into a shot",()=>{
  const p=project();master(p);
  assert.ok(inspectImageConsistency(p,"room",["hero-master"]).issues.some(i=>i.code==="reference_actor_conflict"));
  p.ontology.assets[1].previewImage={artifactId:"bad-room",fileId:"room-file",sha256:"c".repeat(64)};
  p.files.push({id:"room-file",projectId:p.id,name:"room.png",mime:"image/png",sha256:"c".repeat(64),bytes:1,relativePath:"media/room-fixture",createdAt:""});
  p.artifacts.push({id:"bad-room",projectId:"p",jobId:"x",kind:"image",assetId:"room",fileId:"room-file",sourceHash:"x",accepted:false,metadata:{technicalReview:{contentReview:"needs_revision"}},createdAt:""});
  assert.ok(inspectImageConsistency(p,"s1",["room"]).issues.some(i=>i.code==="reference_needs_revision"));
  p.artifacts.find(a=>a.id==="bad-room")!.accepted=true;p.imageCandidateCurrent!["bad-room"]=true;
  assert.equal(inspectImageConsistency(p,"s1",["room"]).ready,true,"new human approval resolves a technical recommendation without erasing its history");
  p.imageCandidateCurrent!["bad-room"]=false;
  assert.ok(inspectImageConsistency(p,"s1",["room"]).issues.some(i=>i.code==="reference_needs_revision"));
});

test("revoking a master after queueing prevents that POST and leaves unrelated room work valid",async()=>{
  const { Jobs }=await import("../server/jobs.ts"),{ Providers }=await import("../server/providers.ts");
  const t=tempStore();
  try {
    const p=t.store.create("identity-queue",requirements,strict());
    const bytes=Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jFeYAAAAASUVORK5CYII=","base64");
    const file=t.store.addFile(p.id,"master.png","image/png",bytes);
    const a=t.store.addArtifact({projectId:p.id,assetId:"hero-master",kind:"image",jobId:"manual-fixture",fileId:file.id,sourceHash:imageTargetHashes(p.ontology)["hero-master"],metadata:{}});
    t.store.reviewArtifact(a.id,true);
    let calls=0;
    const providers=new Providers({imageBase:"http://image.example/v1",imageKey:"test-only",imageModel:"test",seedanceBase:"",seedanceKey:"",seedanceModel:"",falKey:"",falBase:"",opusBase:"",opusKey:"",opusModel:"",allowPrivate:true},{fetchImpl:(async()=>{calls++;return new Response(JSON.stringify({data:[{b64_json:bytes.toString("base64")}]}));}) as any});
    const jobs=new Jobs(t.store,providers,mockMedia());jobs.stopped=true;
    const batch=jobs.enqueueImages(p.id,p.revision,"queued-before-revoke",[{shotId:"s1"},{assetId:"room"}]);
    t.store.reviewArtifact(a.id,false,"撤回身份基准");
    jobs.stopped=false;await jobs.tick();await jobs.tick();jobs.stopped=true;
    const actorJob=t.store.job(batch.jobs[0].id),roomJob=t.store.job(batch.jobs[1].id);
    assert.equal(actorJob.state,"failed");assert.equal(actorJob.attempts,0);assert.match(actorJob.error || "",/先通过角色基准/);
    assert.equal(roomJob.state,"complete");assert.equal(roomJob.attempts,1);assert.equal(calls,1);
    assert.equal(t.store.imageCurrent(t.store.artifact(roomJob.result.artifactId)),true);
  } finally {t.close();}
});

test("archive preserves identity contracts and actual hash provenance but resets transferred approvals",async()=>{
  const {exportProject,importProject}=await import("../server/archive.ts");
  const a=tempStore(),b=tempStore();
  try {
    const source=a.store.create("identity-portable",requirements,strict());
    const file=a.store.addFile(source.id,"approved-master.png","image/png",Buffer.from("synthetic-test-image"));
    const master=a.store.addArtifact({projectId:source.id,assetId:"hero-master",kind:"image",jobId:"fixture-master",fileId:file.id,sourceHash:imageTargetHashes(source.ontology)["hero-master"],metadata:{}});
    a.store.reviewArtifact(master.id,true);
    const ready=inspectImageConsistency(a.store.project(source.id),"s1");assert.equal(ready.ready,true);
    const child=a.store.addArtifact({projectId:source.id,shotId:"s1",kind:"image",jobId:"fixture-child",fileId:file.id,sourceHash:imageTargetHashes(source.ontology).s1,metadata:{consistencyContract:"approved-identity-v1",identityReferences:ready.identityReferences,parentAssets:ready.identityReferences,desiredReferences:ready.desiredReferences}});
    const imported=await importProject(b.store,await exportProject(a.store,source.id));
    assert.deepEqual(imported.ontology.imageConsistency,source.ontology.imageConsistency);
    assert.deepEqual(imported.ontology.shots[0].imageComposition,source.ontology.shots[0].imageComposition);
    assert.deepEqual(imported.ontology.assets[0].imageComposition,source.ontology.assets[0].imageComposition);
    assert.equal(imported.jobs.length,0);assert.equal(imported.artifacts.filter(x=>x.accepted).length,0);
    assert.equal(inspectImageConsistency(imported,"s1").ready,false);
    const importedMaster=imported.artifacts.find(x=>x.assetId==="hero-master")!;
    const importedChild=imported.artifacts.find(x=>x.shotId==="s1")!;
    const actual=importedChild.metadata.identityReferences as any[];
    assert.notEqual(importedChild.id,child.id);assert.equal(actual[0].artifactId,importedMaster.id);
    assert.equal(actual[0].fileId,importedMaster.fileId);assert.equal(actual[0].sha256,file.sha256);
    b.store.reviewArtifact(importedMaster.id,true,"重新核对同一角色");
    assert.equal(inspectImageConsistency(b.store.project(imported.id),"s1").ready,true);
  } finally {a.close();b.close();}
});

test("identity and wardrobe changes invalidate only affected generation briefs, while subtitle edits do not",()=>{
  const o=strict(),before=imageTargetHashes(o);
  o.imageConsistency!.characters[0].appearance="修改后的人物基准";
  const after=imageTargetHashes(o);assert.notEqual(after["hero-master"],before["hero-master"]);assert.notEqual(after.s1,before.s1);assert.equal(after.room,before.room);
  const shotBefore=compileOntology(o).shotHashes.s1;
  o.shots[0].subtitles.push({id:"caption",startFrame:0,endFrame:20,text:"准确文字"});
  assert.equal(compileOntology(o).shotHashes.s1,shotBefore);
  o.shots[0].imageComposition!.visibleCharacters[0].wardrobeId="outdoor";
  assert.notEqual(compileOntology(o).shotHashes.s1,shotBefore);
});

test("provider policy rejection stays blocked even if all character masters have been approved",()=>{
  const p=project();master(p);
  p.ontology.shots[0].imageAttempt={origin:"external-history",state:"blocked",code:"blocked_provider_policy",submitted:false,reason:"provider policy"};
  assert.ok(inspectImageConsistency(p,"s1").issues.some(i=>i.code==="provider_policy_blocked"));
});

test("V6 explicitly maps all 32 image assets and 20 shots, keeps four masters, hand-only extras and outdoor sleeves",()=>{
  const o=JSON.parse(readFileSync(new URL("../examples/lupus-v6.json",import.meta.url),"utf8")) as Ontology;
  assert.deepEqual(validateOntology(o).filter(i=>i.severity==="error"),[]);
  assert.equal(o.imageConsistency!.characters.length,4);
  assert.equal(o.assets.filter(a=>a.purpose==="production"&&["image","graphic"].includes(a.kind)&&a.imageComposition).length,32);
  for(const s of o.shots) assert.ok(s.imageComposition);
  assert.deepEqual(resolveImageConsistency(o,"S10").requiredIdentityAssetIds,["A-CHAR-LAB-HANDS"]);
  assert.deepEqual(resolveImageConsistency(o,"S11").requiredIdentityAssetIds,["A-CHAR-D00"]);
  assert.equal(resolveImageConsistency(o,"S20").desiredReferences.find(r=>r.assetId==="A-CHAR-P01")!.wardrobeId,"outdoor");
  assert.deepEqual(resolveImageConsistency(o,"A-SET-CLINIC").desiredReferences,[]);
  assert.deepEqual(resolveImageConsistency(o,"A-CHAR-D00").requiredSourceAssetIds,["A-CHAR-D00-SOURCE"]);
  const original=o.assets.find(a=>a.id==="A-CHAR-D00-SOURCE")!;
  assert.equal(original.purpose,"reference");assert.equal(original.fileId,undefined);assert.equal(original.gap,true);
});
