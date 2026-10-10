import { readFileSync } from "node:fs";
import { resolve, basename } from "node:path";
import { fileURLToPath } from "node:url";
import type { Ontology, Project, ImageAttemptHistory } from "../shared/types.ts";
import { imageTargetHash } from "../shared/ontology.ts";
import { Store } from "./store.ts";
import { ensure, sha } from "./util.ts";
const examples=fileURLToPath(new URL("../examples/",import.meta.url));
/** Package-owned references and pending generated candidates are deliberately separate. */
export function loadExampleAssets(store:Store,p:Project,ontology:Ontology, options: {manifest?:any;directory?:string}={}) {
  const directory=options.directory || examples;
  const manifest=options.manifest || JSON.parse(readFileSync(resolve(directory,"lupus-v6.assets.json"),"utf8"));
  const load=(item:any)=>{
    ensure(/^assets\/(?:[\w.-]+\/)*[\w.-]+$/.test(item.path) && !item.path.split("/").includes(".."),"模板素材路径错误",500);
    const bytes=readFileSync(resolve(directory,item.path));
    ensure(sha(bytes)===item.sha256,"模板素材哈希错误",500);
    return store.addFile(p.id,basename(item.path),item.mime,bytes,{metadata:{source:item.source,licenseUrl:item.licenseUrl,publicShareApproved:item.publicShareApproved===true}});
  };
  for(const item of manifest.files || []) {
    const f=load(item),a=ontology.assets.find(a=>a.id===item.assetId);
    ensure(a,"模板素材槽不存在",500);
    a.fileId=f.id; a.sha256=f.sha256; a.gap=false;
  }
  const pending:any[]=[];
  for(const item of manifest.candidates || []) {
    const f=load(item),target=item.target;
    ensure(target && Boolean(target.assetId)!==Boolean(target.shotId),"模板图片目标无效",500);
    const a=store.addArtifact({projectId:p.id,jobId:`example-image-${target.assetId || target.shotId}`,kind:"image",...target,
      fileId:f.id,sourceHash:imageTargetHash(ontology,target),metadata:{...item.metadata,
        ...(item.original ? {originalFileId:load(item.original).id,originalSha256:item.original.sha256}:{}),
        ...(item.thumbnail ? {thumbnailFileId:load(item.thumbnail).id,thumbnailSha256:item.thumbnail.sha256}:{}),
        origin:item.metadata?.origin || "ai-generated",reviewStatus:"pending",generationSnapshotHash:item.sourceHash || item.metadata?.generationSnapshotHash}});
    const binding={artifactId:a.id,fileId:f.id,sha256:f.sha256};
    if(target.assetId) {
      const asset=ontology.assets.find(x=>x.id===target.assetId); ensure(asset,"模板素材槽不存在",500); asset.previewImage=binding;
    } else {
      const shot=ontology.shots.find(x=>x.id===target.shotId); ensure(shot,"模板镜头不存在",500); shot.reviewImage=binding;
    }
    pending.push(a);
  }
  // Template candidates were all frozen together; file IDs are local, content hashes retain lineage.
  for(const a of pending) {
    a.sourceHash=imageTargetHash(ontology,a);
    a.metadata.parentAssets=(a.metadata.parentAssets || []).map((r:any)=>{
      const asset=ontology.assets.find(x=>x.id===r.assetId);
      const binding=[asset?.previewImage,asset].find(candidate=>candidate?.fileId && candidate.sha256===r.sha256);
      return {...r,...(binding && binding.sha256===r.sha256 ? {fileId:binding.fileId}: {})};
    });
    a.metadata.parentShots=(a.metadata.parentShots || []).map((r:any)=>{
      const shot=ontology.shots.find(s=>s.id===r.shotId);
      const bindings=[shot?.reviewImage,shot?.firstFrameImage].filter(Boolean);
      const parent=pending.find(candidate=>candidate.shotId===r.shotId && bindings.some(binding=>binding!.artifactId===candidate.id) && (candidate.metadata.originalSha256===r.sha256 || store.file(candidate.fileId).sha256===r.sha256));
      const fileId=parent && parent.metadata.originalSha256===r.sha256 ? parent.metadata.originalFileId || parent.fileId : parent?.fileId;
      return {...r,...(fileId ? {fileId}: {})};
    });
    store.db.prepare("UPDATE artifacts SET json=? WHERE id=?").run(JSON.stringify(a),a.id);
  }
  importImageAttemptHistory(ontology,manifest.imageAttempts || []);
}
/** External production evidence is display-only metadata. Never turn it into queued Jobs. */
export function importImageAttemptHistory(ontology:Ontology, records:any[]) {
  ensure(Array.isArray(records) && records.length<=52,"模板图片历史数量无效",500);
  for(const record of records) {
    const target=record.target;
    ensure(target && Boolean(target.assetId)!==Boolean(target.shotId),"图片历史目标无效",500);
    const item=target.assetId ? ontology.assets.find(a=>a.id===target.assetId) : ontology.shots.find(s=>s.id===target.shotId);
    ensure(item && ["failed","blocked"].includes(record.state) && typeof record.submitted === "boolean","图片历史状态无效",500);
    ensure(typeof record.code === "string" && /^[a-z0-9_:-]{1,100}$/.test(record.code),"图片历史错误码无效",500);
    ensure(typeof record.reason === "string" && record.reason.length>0 && record.reason.length<=1000,"图片历史原因无效",500);
    const history:ImageAttemptHistory={origin:"external-history",state:record.state,code:record.code,submitted:record.submitted,reason:record.reason};
    for(const key of ["modelRequested","modelActual","blockingParent"] as const) if(record[key] !== undefined && record[key] !== null) {
      ensure(typeof record[key] === "string" && record[key].length<=200,"图片历史元数据无效",500);history[key]=record[key];
    }
    if(record.modelActual === null) history.modelActual=null;
    if(record.sourceStoryHash !== undefined) {ensure(/^[a-f0-9]{64}$/.test(record.sourceStoryHash),"图片历史来源哈希无效",500);history.sourceStoryHash=record.sourceStoryHash;}
    if(record.imagePostNumber !== undefined) {ensure(Number.isInteger(record.imagePostNumber) && record.imagePostNumber>0 && record.imagePostNumber<=52,"图片历史提交序号无效",500);history.imagePostNumber=record.imagePostNumber;}
    ensure(history.state !== "blocked" || !history.submitted,"阻塞历史不能伪装为已提交",500);
    item.imageAttempt=history;
  }
}
