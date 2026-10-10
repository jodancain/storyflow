import test from "node:test";
import assert from "node:assert/strict";
import JSZip from "jszip";
import { fixture, requirements, tempStore } from "./helpers.ts";
import { imageTargetHash } from "../shared/ontology.ts";
import { exportProject, importProject } from "../server/archive.ts";
import { publicSnapshot, exportReviewSnapshot } from "../server/public-review.ts";
const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jFeYAAAAASUVORK5CYII=", "base64");
function make() {
  const t = tempStore(), o = fixture();
  o.assets.push({ id: "face", label: "AI医生派生图", kind: "image", purpose: "production", gap: true });
  o.shots[0].requiredAssetIds = ["face"];
  let p = t.store.create("资产审稿", requirements, o);
  const f = t.store.addFile(p.id, "generated.png", "image/png", png);
  const a = t.store.addArtifact({ projectId: p.id, jobId: "external-batch", assetId: "face", kind: "image", fileId: f.id, sourceHash: imageTargetHash(o, { assetId: "face" }), metadata: { origin: "ai-generated", modelRequested: "test-model", modelActual: null, reviewStatus: "pending", reviewNote: "PRIVATE HUMAN COMMENT", technicalReview: {notes:["PUBLIC TECHNICAL CHECK"]}, apiKey: "private-key-fixture", localPath: "/Users/private/doctor.png" } });
  p = t.store.selectImage(a.id, p.revision, "preview");
  t.store.addFile(p.id, "private-original.txt", "text/plain", Buffer.from("PRIVATE ORIGINAL DO NOT PUBLISH"));
  return { ...t, p, a, f };
}
test("public snapshot uses real pending candidate, excludes private files/receipts and matches file hashes", async () => {
  const t = make(); try {
    const before = t.store.project(t.p.id), view = publicSnapshot(before, id => `asset/${id}`);
    assert.equal(view.items.find(i => i.id === "face")?.image?.status, "pending");
    assert.equal(view.items.find(i => i.id === "s1")?.image, undefined);
    assert.equal(view.items.find(i => i.id === "face")?.image?.modelActual, null);
    assert.doesNotMatch(JSON.stringify(view), /private-key-fixture|\/Users\/private|PRIVATE ORIGINAL|PRIVATE HUMAN COMMENT/);
    assert.equal(view.items.find(i=>i.id === "face")?.image?.note,"PUBLIC TECHNICAL CHECK");
    const zip = await JSZip.loadAsync(await exportReviewSnapshot(t.store, t.p.id));
    const manifest = JSON.parse(await zip.file("public-manifest.json")!.async("string"));
    assert.equal(manifest.images.length, 1); assert.equal(manifest.images[0].sha256, t.f.sha256);
    assert.doesNotMatch(await zip.file("index.html")!.async("string"), /private-key-fixture|\/Users\/private|PRIVATE ORIGINAL/);
    assert.equal(Object.keys(zip.files).filter(n => n.endsWith(".txt")).length, 0);
  } finally { t.close(); }
});
test("image candidates migrate with remapped preview bindings; original approvals and first-frame use do not replay", async () => {
  const t = make(), destination = tempStore(); try {
    let p = t.store.project(t.p.id);
    const a = t.store.addArtifact({ projectId: p.id, jobId: "shot-image", shotId: "s1", kind: "image", fileId: t.f.id, sourceHash: imageTargetHash(p.ontology, { shotId: "s1" }), metadata: { modelRequested: "test", reviewStatus: "pending" } });
    t.store.reviewArtifact(a.id, true, "fixture approval");
    p = t.store.selectImage(a.id, p.revision, "production");
    const imported = await importProject(destination.store, await exportProject(t.store, p.id));
    assert.equal(imported.artifacts.filter(a => a.kind === "image").length, 2);
    assert.ok(imported.artifacts.every(a => !a.accepted));
    assert.equal(imported.ontology.shots[0].firstFrameImage, undefined);
    const preview = imported.ontology.shots[0].reviewImage!;
    assert.notEqual(preview.artifactId, a.id); assert.notEqual(preview.fileId, t.f.id);
    assert.equal(preview.sha256, t.f.sha256);
    const asset = imported.ontology.assets[0].previewImage!;
    assert.equal(imported.artifacts.find(a => a.id === asset.artifactId)?.assetId, "face");
    assert.equal(imported.jobs.length, 0);
  } finally { t.close(); destination.close(); }
});
test("a bound private original is excluded from the public page; only explicitly shareable references appear", () => {
  const t = make(); try {
    const p = t.store.project(t.p.id);
    const privatePhoto = t.store.addFile(p.id, "private-doctor-original.png", "image/png", Buffer.concat([png, Buffer.from("private")]));
    const reference = t.store.addFile(p.id, "licensed-reference.png", "image/png", png, {metadata:{publicShareApproved:true}});
    p.files = t.store.files(p.id);
    p.ontology.assets.push({id:"private-photo",label:"原始照片",kind:"image",purpose:"production",fileId:privatePhoto.id,sha256:privatePhoto.sha256,gap:false});
    p.ontology.assets.push({id:"public-ref",label:"授权参考",kind:"image",purpose:"reference",fileId:reference.id,sha256:reference.sha256,gap:false});
    p.ontology.relations.push({id:"asset-depiction",type:"depicts",from:"face",to:"hero"},{id:"reference-depiction",type:"depicts",from:"public-ref",to:"hero"});
    const resolved:string[]=[];
    const view=publicSnapshot(p,id=>{resolved.push(id);return `assets/${id}`});
    assert.equal(view.items.find(i=>i.id==="private-photo")?.image,undefined);
    assert.ok(!resolved.includes(privatePhoto.id));
    assert.ok(resolved.includes(reference.id));
    assert.equal(view.items.find(i=>i.id==="face")?.references[0]?.id,"public-ref");
    assert.equal(view.items.find(i=>i.id==="s1")?.references[0]?.id,"public-ref");
  } finally { t.close(); }
});

test("an identity source photo is never public even if generic file sharing metadata was set", () => {
  const t=make(); try {
    const p=t.store.project(t.p.id);
    const original=t.store.addFile(p.id,"identity-original.png","image/png",Buffer.concat([png,Buffer.from("original-private")] ),{metadata:{publicShareApproved:true}});
    p.files=t.store.files(p.id);
    p.ontology.assets.push({id:"identity-source",label:"原照",kind:"image",purpose:"reference",fileId:original.id,sha256:original.sha256,gap:false});
    p.ontology.imageConsistency={version:1,enforceApprovedIdentity:true,characters:[{characterId:"hero",identityAssetId:"face",referenceSourceAssetId:"identity-source",visibility:"person",appearance:"同一人",wardrobes:[{id:"base",description:"同一衣服"}]}]};
    p.ontology.assets[0].imageComposition={visibleCharacters:[{characterId:"hero",wardrobeId:"base",visibility:"face"}]};
    p.ontology.shots[0].imageComposition={visibleCharacters:[{characterId:"hero",wardrobeId:"base",visibility:"face"}]};
    const resolved:string[]=[];
    const snapshot=publicSnapshot(p,id=>{resolved.push(id);return `assets/${id}`});
    assert.ok(!resolved.includes(original.id));
    assert.ok(!JSON.stringify(snapshot).includes(original.sha256));
  } finally {t.close();}
});
