import type { Artifact, CharacterIdentity, CharacterVisibility, ImageComposition, Issue, Ontology, Project } from "./types.js";

const object = (v: unknown): v is Record<string, any> => Boolean(v) && typeof v === "object" && !Array.isArray(v);
const array = (v: unknown): any[] => Array.isArray(v) ? v : [];
const idPattern = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/;
const error = (path: string, code: string, message: string): Issue => ({ path, code, message, severity: "error" });

/** Optional for old projects; once enabled, missing or ambiguous identity contracts fail closed. */
export function validateImageConsistency(value: unknown): Issue[] {
  if (!object(value)) return [];
  const policy = value.imageConsistency;
  const compositions = [...array(value.assets), ...array(value.shots)].filter(object);
  if (policy === undefined) {
    return compositions.some(x => x.imageComposition !== undefined)
      ? [error("imageConsistency", "identity_policy_missing", "已填写人物构图，需要同时定义统一角色基准。")]
      : [];
  }
  const issues: Issue[] = [];
  const add = (path: string, code: string, message: string) => issues.push(error(path, code, message));
  if (!object(policy) || policy.version !== 1 || policy.enforceApprovedIdentity !== true || !Array.isArray(policy.characters))
    return [error("imageConsistency", "invalid_identity_policy", "人物一致性必须为 version 1、启用已审身份图门禁并提供 characters 数组。")];
  if (Object.keys(policy).some(k => !["version", "enforceApprovedIdentity", "characters"].includes(k)))
    add("imageConsistency", "unknown_identity_field", "人物一致性包含未知字段。");
  const entities = new Map(array(value.entities).filter(object).map(e => [e.id, e]));
  const assets = new Map(array(value.assets).filter(object).map(a => [a.id, a]));
  const profiles = new Map<string, CharacterIdentity>();
  const identityOwners = new Map<string, string>();
  const text = (v: unknown, path: string, max = 4000) => {
    if (typeof v !== "string" || !v.trim() || v.length > max) add(path, "invalid_identity_text", `需要1–${max}字符的文本。`);
  };
  policy.characters.forEach((profile: any, i: number) => {
    const path = `imageConsistency.characters[${i}]`;
    if (!object(profile)) return add(path, "invalid_identity_profile", "角色锁必须为对象。");
    if (Object.keys(profile).some(k => !["characterId", "identityAssetId", "referenceSourceAssetId", "visibility", "appearance", "wardrobes"].includes(k)))
      add(path, "unknown_identity_field", "角色锁包含未知字段。");
    if (entities.get(profile.characterId)?.type !== "character") add(`${path}.characterId`, "unknown_identity_character", `未知角色：${String(profile.characterId)}。`);
    if (profiles.has(profile.characterId)) add(`${path}.characterId`, "duplicate_identity_character", "同一角色只能有一个统一身份基准。");
    profiles.set(profile.characterId, profile as unknown as CharacterIdentity);
    const asset = assets.get(profile.identityAssetId);
    if (!asset || asset.kind !== "image" || asset.purpose !== "production") add(`${path}.identityAssetId`, "invalid_identity_asset", "身份基准必须引用专属制作图片资产。");
    if (identityOwners.has(profile.identityAssetId)) add(`${path}.identityAssetId`, "shared_identity_asset", "不同角色不能共用一张身份基准资产。");
    identityOwners.set(profile.identityAssetId, profile.characterId);
    if (profile.referenceSourceAssetId !== undefined) {
      const source = assets.get(profile.referenceSourceAssetId);
      if (!source || source.kind !== "image" || source.purpose !== "reference")
        add(`${path}.referenceSourceAssetId`, "invalid_identity_source", "指定人物原照必须引用单独的图片参考资产槽。");
      if (profile.referenceSourceAssetId === profile.identityAssetId)
        add(`${path}.referenceSourceAssetId`, "identity_source_self", "身份基准不能以自身作为指定人物原照。");
    }
    if (!["person", "hands-only"].includes(profile.visibility)) add(`${path}.visibility`, "invalid_identity_visibility", "角色必须是 person 或 hands-only。");
    text(profile.appearance, `${path}.appearance`);
    if (!Array.isArray(profile.wardrobes) || !profile.wardrobes.length) add(`${path}.wardrobes`, "missing_wardrobe", "角色必须至少定义一个服装状态。");
    const wardrobeIds = new Set();
    array(profile.wardrobes).forEach((wardrobe, n) => {
      const wp = `${path}.wardrobes[${n}]`;
      if (!object(wardrobe)) return add(wp, "invalid_wardrobe", "服装状态必须为对象。");
      if (Object.keys(wardrobe).some(k => !["id", "description"].includes(k))) add(wp, "unknown_identity_field", "服装状态包含未知字段。");
      if (typeof wardrobe.id !== "string" || !idPattern.test(wardrobe.id)) add(`${wp}.id`, "invalid_wardrobe_id", "服装状态ID无效。");
      if (wardrobeIds.has(wardrobe.id)) add(`${wp}.id`, "duplicate_wardrobe", "角色的服装状态ID不得重复。");
      wardrobeIds.add(wardrobe.id); text(wardrobe.description, `${wp}.description`);
    });
  });
  for (const collection of ["assets", "shots"] as const) {
    array(value[collection]).forEach((target, i) => {
      if (!object(target)) return;
      const path = `${collection}[${i}].imageComposition`;
      const required = collection === "shots" || (target.purpose === "production" && ["image", "graphic"].includes(target.kind));
      const composition = target.imageComposition;
      if (!required && composition === undefined) return;
      if (!object(composition) || !Array.isArray(composition.visibleCharacters)) return add(path, "missing_image_composition", "需明确本画面可见角色；无人物画面填写空数组。");
      if (Object.keys(composition).some(k => k !== "visibleCharacters")) add(path, "unknown_identity_field", "人物构图包含未知字段。");
      const visible = new Set();
      composition.visibleCharacters.forEach((actor: any, n: number) => {
        const ap = `${path}.visibleCharacters[${n}]`;
        if (!object(actor)) return add(ap, "invalid_visible_actor", "可见角色必须为对象。");
        if (Object.keys(actor).some(k => !["characterId", "wardrobeId", "visibility"].includes(k))) add(ap, "unknown_identity_field", "可见角色包含未知字段。");
        const profile = profiles.get(actor.characterId);
        if (!profile) add(`${ap}.characterId`, "unknown_identity_character", `角色 ${String(actor.characterId)} 未定义统一基准。`);
        if (visible.has(actor.characterId)) add(`${ap}.characterId`, "duplicate_visible_actor", "同一画面角色不得重复。");
        visible.add(actor.characterId);
        if (!["face", "body", "hands", "shoulder"].includes(actor.visibility)) add(`${ap}.visibility`, "invalid_actor_visibility", "可见范围必须为 face/body/hands/shoulder。");
        if (profile?.visibility === "hands-only" && actor.visibility !== "hands") add(`${ap}.visibility`, "forbidden_character_face", "仅手部角色不能显示脸或完整身体。");
        if (profile && !array(profile.wardrobes).some(w => w?.id === actor.wardrobeId)) add(`${ap}.wardrobeId`, "unknown_wardrobe", `角色服装状态不存在：${String(actor.wardrobeId)}。`);
        if (collection === "shots" && !array(target.entityIds).includes(actor.characterId)) add(`${ap}.characterId`, "visible_actor_missing_entity", "可见角色必须同时在镜头 entityIds 中声明。");
      });
      const owner = identityOwners.get(target.id);
      if (owner && (composition.visibleCharacters.length !== 1 || !visible.has(owner))) add(path, "mixed_identity_master", "身份基准只能包含对应的单一角色。");
    });
  }
  return issues;
}

export interface DesiredIdentityReference {
  characterId: string;
  assetId: string;
  wardrobeId: string;
  visibility: CharacterVisibility;
  appearance: string;
  wardrobe: string;
  referenceSourceAssetId?: string;
}
export interface ImageConsistencyPlan {
  enabled: boolean;
  isIdentityMaster: boolean;
  requiredIdentityAssetIds: string[];
  requiredSourceAssetIds: string[];
  desiredReferences: DesiredIdentityReference[];
  promptGuard: string;
  issues: Issue[];
}
export interface IdentityReference {
  characterId: string;
  assetId: string;
  fileId: string;
  sha256: string;
  mime: string;
  artifactId?: string;
  approval: "approved";
  role?: "identity" | "source";
}
export interface ImageConsistencyInspection extends ImageConsistencyPlan {
  identityReferences: IdentityReference[];
  referenceAssetIds: string[];
  ready: boolean;
}
const visibilityLabel: Record<CharacterVisibility, string> = {face: "脸部可见", body: "身体与脸部可见", hands: "仅手与衣袖，脸在画外", shoulder: "仅肩背与衣袖，脸在画外"};

export function resolveImageConsistency(ontology: Ontology, targetId: string): ImageConsistencyPlan {
  const policy = ontology.imageConsistency;
  if (!policy) return {enabled: false, isIdentityMaster: false, requiredIdentityAssetIds: [], requiredSourceAssetIds: [], desiredReferences: [], promptGuard: "", issues: []};
  const issues = validateImageConsistency(ontology);
  const profiles = new Map(array(policy.characters).filter(object).map(p => [p.characterId, p as unknown as CharacterIdentity]));
  const target = [...array(ontology.assets), ...array(ontology.shots)].find(t => t?.id === targetId);
  if (!target) issues.push(error("target", "unknown_image_target", `图片目标不存在：${targetId}。`));
  const isIdentityMaster = array(policy.characters).some(p => p?.identityAssetId === targetId);
  const desiredReferences = array(target?.imageComposition?.visibleCharacters).flatMap(actor => {
    const profile = profiles.get(actor.characterId);
    if (!profile) return [];
    return [{characterId: profile.characterId, assetId: profile.identityAssetId, wardrobeId: actor.wardrobeId, visibility: actor.visibility as CharacterVisibility,
      appearance: profile.appearance, wardrobe: array(profile.wardrobes).find(w => w?.id === actor.wardrobeId)?.description || "",
      ...(profile.referenceSourceAssetId && profile.identityAssetId === targetId ? {referenceSourceAssetId:profile.referenceSourceAssetId} : {})}];
  });
  const requiredIdentityAssetIds = [...new Set(desiredReferences.map(r => r.assetId).filter(id => id !== targetId))];
  const requiredSourceAssetIds = [...new Set(desiredReferences.flatMap(r => r.referenceSourceAssetId ? [r.referenceSourceAssetId] : []))];
  const promptGuard = [
    "【不可由补充意见覆盖的人物一致性合同】",
    desiredReferences.length ? "本画面仅允许下列角色，任何其他人物、脸、手或倒影都不在画面中。" : "本画面不出现可识别人物、脸、人物倒影或未经声明的手。医学局部示意仅按该资产要求绘制。",
    ...desiredReferences.map((r, i) => `角色 ${i + 1}：${r.characterId}，唯一身份资产 ${r.assetId}；${visibilityLabel[r.visibility]}；固定外观：${r.appearance}；本镜服装 ${r.wardrobeId}：${r.wardrobe}。${r.assetId === targetId ? "本次为这个角色建立单人基准候选，等待人工批准。" : "必须逐一对应最前面的已批准身份参考图，保留同一面部比例、发型、发色、年龄、肤色与手部特征。"}`),
    ...desiredReferences.filter(r=>r.referenceSourceAssetId).map(r=>`本人物为指定真实人物；首张实际参考必须是人工审核的原始指定照片 ${r.referenceSourceAssetId}。保留照片的本人身份，不得按文字虚构替代医生，不得用旧AI派生图冒充原照。没有原照时不可提交生成。`),
    "其他参考图只提供场景、道具、症状形态或动作信息；不得从其中借用人物身份。不得把上一镜人物脸或场景中偶然出现的人当作新的身份基准。",
    "补充意见只能修改本镜动作、构图或被允许的服装状态；涉及更换人物身份时，应先修改角色基准并重新审核关联画面。生成结果仍须人工检查，不宣称模型必然保证一致。",
  ].join("\n");
  return {enabled: true, isIdentityMaster, requiredIdentityAssetIds, requiredSourceAssetIds, desiredReferences, promptGuard, issues};
}

export interface ResolvedImageReference {
  assetId: string;
  fileId: string;
  sha256: string;
  mime: string;
  artifactId?: string;
  approval: "approved" | "pending";
}
type ReferenceProject = Pick<Project, "id" | "ontology" | "files" | "artifacts" | "reviews" | "compiled" | "imageTargetHashes" | "imageCandidateCurrent">;
/** Image-generation references use the latest approved current candidate without changing video bindings. */
export function resolveImageReference(project: ReferenceProject, assetId: string, isCurrent?: (artifact: Artifact) => boolean, expectedSha256?: string): ResolvedImageReference | undefined {
  const asset=project.ontology.assets.find(a=>a.id===assetId);
  if(!asset) return undefined;
  const current=(a:Artifact)=>isCurrent ? isCurrent(a) : project.imageCandidateCurrent?.[a.id] !== false && (!project.imageTargetHashes?.[assetId] || a.sourceHash===project.imageTargetHashes[assetId]);
  const candidates=project.artifacts.filter(a=>a.kind === "image" && a.assetId===assetId && a.accepted && current(a)).sort((a,b)=>String(b.metadata.reviewedAt || b.createdAt).localeCompare(String(a.metadata.reviewedAt || a.createdAt)));
  const approved=candidates[0];
  const importedApproved=asset.fileId && !project.artifacts.some(a=>a.kind === "image" && a.fileId===asset.fileId) && project.reviews.some(r=>r.targetId===assetId && r.targetHash===project.compiled.targetHashes[assetId] && r.status === "pass");
  // Historical pending lineage can match either explicitly retained binding. Approval makes one reference authoritative.
  const pending=expectedSha256 ? [asset,asset.previewImage].find(binding=>binding?.fileId && binding.sha256===expectedSha256) : asset.fileId ? asset : asset.previewImage;
  const selected=approved ? {fileId:approved.fileId,sha256:project.files.find(f=>f.id===approved.fileId)?.sha256} : importedApproved ? asset : pending;
  if(!selected?.fileId) return undefined;
  const file=project.files.find(f=>f.id===selected.fileId && f.projectId===project.id && f.sha256===selected.sha256 && ["image/png","image/jpeg","image/webp"].includes(f.mime));
  if(!file) return undefined;
  const candidate=approved || project.artifacts.find(a=>a.kind === "image" && a.assetId===assetId && a.fileId===file.id);
  const reviewed=approved || (!candidate && project.reviews.some(r=>r.targetId===assetId && r.targetHash===project.compiled.targetHashes[assetId] && r.status === "pass"));
  return {assetId,fileId:file.id,sha256:file.sha256,mime:file.mime,artifactId:candidate?.id,approval:reviewed ? "approved" : "pending"};
}

/** No model calls: resolves exactly which approved bytes must precede optional visual references. */
export function inspectImageConsistency(project: Project, targetId: string, requestedReferenceAssetIds: string[] = []): ImageConsistencyInspection {
  const plan = resolveImageConsistency(project.ontology, targetId);
  const issues = [...plan.issues];
  const identityReferences: IdentityReference[] = [];
  const target = [...project.ontology.assets, ...project.ontology.shots].find(t => t.id === targetId);
  if (target?.imageAttempt?.code === "moderation_blocked" || target?.imageAttempt?.code === "blocked_provider_policy")
    issues.push(error(`target.${targetId}`, "provider_policy_blocked", "此前目标受到供应商政策拒绝或其依赖阻塞；保存意见不会自动改词、换模型或重新提交。"));
  if (plan.enabled) {
    for (const assetId of plan.requiredSourceAssetIds) {
      const source = project.ontology.assets.find(a=>a.id===assetId);
      const file = project.files.find(f=>f.id===source?.fileId && f.projectId===project.id && f.sha256===source?.sha256 && ["image/png","image/jpeg","image/webp"].includes(f.mime));
      const characterId = plan.desiredReferences.find(r=>r.referenceSourceAssetId===assetId)!.characterId;
      if (!file) issues.push(error(`assets.${assetId}`, "identity_source_missing", `指定人物原照「${source?.label || assetId}」尚未导入。已保存的AI派生图不能替代原照重新生成人物。`));
      else if (project.artifacts.some(a=>a.kind==="image" && (a.fileId===file.id || project.files.some(candidate=>candidate.id===a.fileId && candidate.sha256===file.sha256))))
        issues.push(error(`assets.${assetId}`, "identity_source_not_original", "指定人物原照不能绑定到AI图片候选；请导入获授权的原始照片。"));
      else if (!project.reviews.some(r=>r.targetId===assetId && r.targetHash===project.compiled.targetHashes[assetId] && r.status==="pass"))
        issues.push(error(`assets.${assetId}`, "identity_source_not_approved", `先核对并通过指定人物原照「${source?.label || assetId}」，再生成这个角色基准。`));
      else identityReferences.push({characterId,assetId,fileId:file.id,sha256:file.sha256,mime:file.mime,approval:"approved",role:"source"});
    }
    for (const assetId of plan.requiredIdentityAssetIds) {
      const asset = project.ontology.assets.find(a => a.id === assetId)!;
      let reference: IdentityReference | undefined;
      const approvedCandidates = project.artifacts.filter(a => a.kind === "image" && a.assetId === assetId && a.accepted &&
        project.imageCandidateCurrent?.[a.id] !== false && (!project.imageTargetHashes?.[assetId] || a.sourceHash === project.imageTargetHashes[assetId]));
      if (approvedCandidates.length > 1) {
        issues.push(error(`assets.${assetId}`, "identity_selection_ambiguous", `角色基准「${asset?.label || assetId}」同时有多个通过候选，请明确唯一基准。`));
      } else if (approvedCandidates.length === 1) {
        const artifact = approvedCandidates[0];
        const file = project.files.find(f => f.id === artifact.fileId && f.projectId === project.id && ["image/png", "image/jpeg", "image/webp"].includes(f.mime));
        if (file) reference = {characterId: plan.desiredReferences.find(r => r.assetId === assetId)!.characterId, assetId, fileId: file.id, sha256: file.sha256, mime: file.mime, artifactId: artifact.id, approval: "approved"};
      } else {
        const file = project.files.find(f => f.id === asset?.fileId && f.sha256 === asset?.sha256 && f.projectId === project.id && ["image/png", "image/jpeg", "image/webp"].includes(f.mime));
        const generated = file && project.artifacts.some(a => a.kind === "image" && a.fileId === file.id);
        const approvedImportedFile = !generated && project.reviews.some(r => r.targetId === assetId && r.targetHash === project.compiled.targetHashes[assetId] && r.status === "pass");
        if (file && approvedImportedFile) reference = {characterId: plan.desiredReferences.find(r => r.assetId === assetId)!.characterId, assetId, fileId: file.id, sha256: file.sha256, mime: file.mime, approval: "approved"};
      }
      if (reference) identityReferences.push(reference);
      else issues.push(error(`assets.${assetId}`, "identity_not_approved", `先通过角色基准「${asset?.label || assetId}」；其余含这个角色的资产与镜头共用该批准图片。`));
    }
    const allowedActors = new Set(plan.desiredReferences.map(r => r.characterId));
    for (const assetId of requestedReferenceAssetIds) {
      if (plan.requiredIdentityAssetIds.includes(assetId) || plan.requiredSourceAssetIds.includes(assetId)) continue;
      const asset = project.ontology.assets.find(a => a.id === assetId);
      const visible = asset?.imageComposition?.visibleCharacters || [];
      if (project.ontology.imageConsistency?.characters.some(profile=>profile.referenceSourceAssetId===assetId))
        issues.push(error(`references.${assetId}`, "identity_source_scope", "私人指定原照只用于对应角色基准的制作；后续镜头使用已审基准派生图。"));
      if (plan.requiredSourceAssetIds.length && visible.some(actor=>allowedActors.has(actor.characterId)))
        issues.push(error(`references.${assetId}`, "identity_source_conflict", "指定人物基准只能以原始授权照片锁定身份，不能追加旧派生人物图作为第二套身份来源。"));
      if (visible.some(actor => !allowedActors.has(actor.characterId)))
        issues.push(error(`references.${assetId}`, "reference_actor_conflict", `参考资产「${asset?.label || assetId}」含本画面未允许的角色，不能把其他人物带入当前镜头。`));
      const selected = resolveImageReference(project,assetId);
      const candidate = project.artifacts.find(a => a.id === selected?.artifactId);
      const technicalReview = candidate?.metadata?.technicalReview;
      if (object(technicalReview) && technicalReview.contentReview === "needs_revision" &&
          !(candidate?.accepted && project.imageCandidateCurrent?.[candidate.id] !== false))
        issues.push(error(`references.${assetId}`, "reference_needs_revision", `参考资产「${asset?.label || assetId}」有未解决的内容返修，不可作为人物一致性制作参考。`));
    }
  }
  const referenceAssetIds = [...new Set([...plan.requiredSourceAssetIds, ...plan.requiredIdentityAssetIds, ...requestedReferenceAssetIds])];
  if (referenceAssetIds.length > 16) issues.push(error("references", "identity_reference_limit", "包含不可取消的角色基准后超过16张参考图，请减少其他参考。"));
  return {...plan, issues, identityReferences, referenceAssetIds, ready: !issues.some(i => i.severity === "error")};
}
