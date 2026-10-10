/** Offline, no provider calls. Export the bundled reviewable example and its public snapshot. */
import { mkdirSync, readFileSync, writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { resolve, join } from "node:path";
import { tmpdir } from "node:os";
import assert from "node:assert/strict";
import JSZip from "jszip";
import { Store } from "../server/store.ts";
import { loadExampleAssets } from "../server/template.ts";
import { exportProject, importProject } from "../server/archive.ts";
import { exportReviewSnapshot } from "../server/public-review.ts";
import { sha } from "../server/util.ts";
import type { Ontology, Requirements } from "../shared/types.ts";

const output = resolve(process.argv[2] || "artifacts/example");
mkdirSync(output, {recursive:true});
const directory = mkdtempSync(join(tmpdir(), "storyflow-example-"));
const migratedDirectory = mkdtempSync(join(tmpdir(), "storyflow-migration-"));
const store = new Store(directory), migrated = new Store(migratedDirectory);
try {
  const ontology:Ontology=JSON.parse(readFileSync("examples/lupus-v6.json","utf8"));
  const manifest=JSON.parse(readFileSync("examples/lupus-v6.assets.json","utf8"));
  const requirements:Requirements={topic:ontology.title,audience:"普通公众",duration:60,aspect:"9:16",fps:25,doctorMode:"photo",style:"明亮、故事化医学科普",sound:"后续按逐句审核的同一音轨制作，本轮不生成声音",brief:"V6故事与专属图片首次候选，全部待人工审稿。"};
  let project=store.create(ontology.title,requirements,ontology);
  loadExampleAssets(store,project,ontology);
  project=store.edit(project.id,project.revision,{ontology});
  assert.equal(project.artifacts.length,manifest.candidates.length);
  assert.equal(project.artifacts.filter(a=>a.accepted).length,0);
  assert.equal(project.jobs.length,0);
  assert.equal(project.ontology.shots.length,20);
  assert.equal(project.ontology.spec.totalFrames,1500);
  const stale=project.artifacts.filter(a=>!project.imageCandidateCurrent?.[a.id]);
  assert.deepEqual(stale.map(a=>a.assetId||a.shotId),[],"Packaged candidate lineage must match actual parent hashes");
  const archive=await exportProject(store,project.id);
  writeFileSync(join(output,"StoryFlow-lupus-v6-images.storyflow.zip"),archive);
  const restored=await importProject(migrated,archive);
  assert.equal(restored.artifacts.length,project.artifacts.length);
  assert.equal(restored.files.length,project.files.length);
  assert.equal(restored.jobs.length,0);
  assert.equal(restored.artifacts.filter(a=>a.accepted).length,0);
  const publicZip=await exportReviewSnapshot(store,project.id);
  writeFileSync(join(output,"StoryFlow-public-review.zip"),publicZip);
  const zip=await JSZip.loadAsync(publicZip), publicDir=join(output,"public");
  for(const [name,file] of Object.entries(zip.files)) if(!file.dir) {
    const path=join(publicDir,name); mkdirSync(resolve(path,".."),{recursive:true});writeFileSync(path,await file.async("nodebuffer"));
  }
  const result={projectId:project.id,revision:project.revision,contentHash:project.compiled.hash,
    images:project.artifacts.length,assets:project.artifacts.filter(a=>a.assetId).length,shots:project.artifacts.filter(a=>a.shotId).length,
    files:project.files.length,approved:0,jobs:0,lineageCurrent:project.artifacts.length,
    sourceArchiveSha256:sha(archive),publicArchiveSha256:sha(publicZip),migrationPassed:true,
    migratedCurrent:restored.artifacts.filter(a=>restored.imageCandidateCurrent?.[a.id]).length};
  writeFileSync(join(output,"example-verification.json"),JSON.stringify(result,null,2));
  console.log(JSON.stringify(result,null,2));
} finally {store.close();migrated.close();rmSync(directory,{recursive:true,force:true});rmSync(migratedDirectory,{recursive:true,force:true});}
