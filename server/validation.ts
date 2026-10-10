import type { Ontology } from "../shared/types.ts";
import { validateOntology } from "../shared/ontology.ts";
import { Store } from "./store.ts";
import { AppError, ensure } from "./util.ts";

/** Both human and model edits pass the same ownership gate. Model output must also be semantically valid. */
export function validateDraft(
  value: unknown,
  store: Store,
  projectId: string,
  fromModel = false,
): Ontology {
  const issues = validateOntology(value);
  const errors = issues.filter(
    (i) =>
      i.severity === "error" &&
      (fromModel ||
        /^(invalid_|unsupported_schema|collection_limit)/.test(i.code)),
  );
  if (errors.length)
    throw new AppError(
      "本体校验未通过；请修正列出的问题",
      422,
      "ontology_invalid",
      errors,
    );
  const ontology = value as Ontology;
  const previous=store.raw(projectId).ontology as Ontology;
  for (const a of ontology.assets || [])
    if (a.fileId) {
      const f = store.file(a.fileId);
      ensure(
        f.projectId === projectId && f.sha256 === a.sha256,
        "绑定素材不属于此项目或内容哈希不符",
        422,
      );
      const candidate=store.artifacts(projectId).find(c=>c.kind === "image" && c.fileId === a.fileId);
      if(candidate && previous.assets.find(x=>x.id===a.id)?.fileId !== a.fileId) ensure(candidate.accepted && store.imageCurrent(candidate),"未批准或过期候选不能作为制作素材",409,"approval_required");
    }
  const bindings = [
    ...(ontology.assets || []).map(a=>({binding:a.previewImage, production:false, assetId:a.id, shotId:undefined as string|undefined})),
    ...(ontology.shots || []).flatMap(s=>[{binding:s.reviewImage,production:false,shotId:s.id,assetId:undefined as string|undefined},{binding:s.firstFrameImage,production:true,shotId:s.id,assetId:undefined as string|undefined}]),
  ];
  for (const {binding,production,assetId,shotId} of bindings) if (binding) {
    const file=store.file(binding.fileId), a=store.artifact(binding.artifactId);
    ensure(file.projectId === projectId && file.sha256 === binding.sha256 && a.projectId === projectId && a.fileId === file.id && a.kind === "image" && a.assetId === assetId && a.shotId === shotId,"图片候选不属于此工程或哈希不符",422);
    if(production && previous.shots.find(x=>x.id===shotId)?.firstFrameImage?.artifactId !== a.id) ensure(a.accepted && store.imageCurrent(a),"未批准图片不能成为首帧输入",409,"approval_required");
  }
  return ontology;
}
