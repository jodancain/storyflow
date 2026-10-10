import JSZip from "jszip";
import { randomUUID } from "node:crypto";
import { existsSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import type {
  Artifact,
  FileRecord,
  Ontology,
  Project,
  Requirements,
  Review,
} from "../shared/types.ts";
import { compileOntology, validateOntology } from "../shared/ontology.ts";
import { Store } from "./store.ts";
import { zipEntries } from "./ingest.ts";
import { renderPublicReviewHtml } from "./public-review.ts";
import { AppError, ensure, escapeHtml, iso, sha } from "./util.ts";

const SCHEMA = "storyflow-project-archive";
const MAX_BYTES = 512 * 1024 * 1024;
const DIGEST = /^[a-f0-9]{64}$/;
const ID = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,199}$/;
const validId = (value: unknown): value is string =>
  typeof value === "string" && ID.test(value);
const object = (v: unknown): v is Record<string, any> =>
  Boolean(v) && typeof v === "object" && !Array.isArray(v);
const pick = (v: any, keys: string[]) =>
  Object.fromEntries(
    keys.filter((k) => v?.[k] !== undefined).map((k) => [k, v[k]]),
  );
const jsonBytes = (v: unknown) =>
  Buffer.from(JSON.stringify(v, null, 2) + "\n", "utf8");
const href = (value: unknown) => {
  if (typeof value !== "string") return undefined;
  try {
    const u = new URL(value);
    if (u.protocol === "http:" || u.protocol === "https:") {
      u.username = "";
      u.password = "";
      return u.toString();
    }
  } catch {
    /* not a link */
  }
  return undefined;
};

/** Metadata is provenance, never a credential/configuration backup. */
function portableMetadata(value: unknown, depth = 0): any {
  if (depth > 10) return undefined;
  if (typeof value === "string") {
    if (
      /(?:\/Users\/|\/Volumes\/|\/private\/|\/tmp\/|\/opt\/|[A-Z]:\\)/.test(
        value,
      )
    )
      return "[local path omitted]";
    if (
      /^(?:Bearer|Key)\s+/i.test(value) ||
      /\b(?:sk|key|token)-[A-Za-z0-9_-]{10,}/.test(value)
    )
      return "[credential omitted]";
    if (/^https?:\/\//i.test(value)) {
      try {
        const u = new URL(value);
        u.username = "";
        u.password = "";
        u.search = "";
        u.hash = "";
        return u.toString();
      } catch {
        return undefined;
      }
    }
    return value.slice(0, 30000);
  }
  if (
    value === null ||
    typeof value === "boolean" ||
    (typeof value === "number" && Number.isFinite(value))
  )
    return value;
  if (Array.isArray(value))
    return value
      .slice(0, 1000)
      .map((v) => portableMetadata(v, depth + 1))
      .filter((v) => v !== undefined);
  if (!object(value)) return undefined;
  const denied =
    /^(?:__proto__|prototype|constructor|api[-_]?key|authorization|cookie|set-cookie|token|access[-_]?token|refresh[-_]?token|secret|password|credentials?|headers|env|path|workDir|relativePath|downloadUrl|resultUrl|uploadUrl|baseUrl)$/i;
  return Object.fromEntries(
    Object.entries(value)
      .filter(([key]) => !denied.test(key))
      .map(([key, v]) => [key, portableMetadata(v, depth + 1)])
      .filter(([, v]) => v !== undefined),
  );
}

function portableOntology(o: Ontology): Ontology {
  return {
    schemaVersion: 1,
    title: o.title,
    ...(o.imageConsistency ? { imageConsistency: structuredClone(o.imageConsistency) } : {}),
    spec: pick(o.spec, [
      "fps",
      "width",
      "height",
      "totalFrames",
    ]) as Ontology["spec"],
    entities: o.entities.map((e) =>
      pick(e, [
        "id",
        "type",
        "label",
        "attributes",
        "evidenceIds",
        "fictional",
      ]),
    ) as Ontology["entities"],
    relations: o.relations.map((r) =>
      pick(r, ["id", "type", "from", "to", "projection"]),
    ) as Ontology["relations"],
    assets: o.assets.map((a) => ({
      ...pick(a, [
        "id",
        "label",
        "kind",
        "purpose",
        "fileId",
        "sha256",
        "gap",
        "mustShow",
        "rejectIf",
        "previewImage",
        "imageAttempt",
        "imageComposition",
      ]),
      ...(a.source
        ? { source: pick(a.source, ["url", "author", "license", "use"]) }
        : {}),
    })) as Ontology["assets"],
    anchors: o.anchors.map((a) =>
      pick(a, ["id", "entityId", "assetId", "state", "role"]),
    ) as Ontology["anchors"],
    evidence: o.evidence.map((e) =>
      pick(e, ["id", "title", "url", "excerpt", "locator"]),
    ) as Ontology["evidence"],
    shots: o.shots.map((s) => ({
      ...pick(s, [
        "id",
        "title",
        "startFrame",
        "endFrame",
        "entityIds",
        "requiredAssetIds",
        "evidenceIds",
        "action",
        "startState",
        "endState",
        "scale",
        "camera",
        "dependencies",
        "route",
        "prompt",
        "firstAnchorId",
        "endAnchorId",
        "reviewImage",
        "firstFrameImage",
        "imageAttempt",
        "imageComposition",
        "mustShow",
        "rejectIf",
      ]),
      dialogue: s.dialogue.map((d) =>
        pick(d, ["id", "speakerId", "text", "startFrame", "endFrame"]),
      ),
      subtitles: s.subtitles.map((c) =>
        pick(c, ["id", "startFrame", "endFrame", "text"]),
      ),
    })) as Ontology["shots"],
    ...(o.postProgram
      ? {
          postProgram: {
            version: 1,
            elements: o.postProgram.elements.map((el) =>
              pick(el, [
                "type",
                "text",
                "x",
                "y",
                "w",
                "h",
                "color",
                "size",
                "startFrame",
                "endFrame",
                "fadeFrames",
              ]),
            ) as Ontology["postProgram"] extends { elements: infer E }
              ? E
              : any,
          },
        }
      : {}),
  };
}

type ArchiveFile = Pick<
  FileRecord,
  | "id"
  | "name"
  | "mime"
  | "sha256"
  | "bytes"
  | "createdAt"
  | "text"
  | "metadata"
> & { path: string };
type ChecksumEntry = { path: string; sha256: string; bytes: number };
type Manifest = {
  schema: typeof SCHEMA;
  version: 1;
  createdAt: string;
  project: ChecksumEntry;
  review: ChecksumEntry;
  files: ArchiveFile[];
};
type ArchiveProject = {
  schemaVersion: 1;
  sourceProjectId: string;
  sourceRevision: number;
  name: string;
  requirements: Requirements;
  ontology: Ontology;
  reviews: Review[];
  artifacts: Artifact[];
  selections: any[];
  reviewSubmissionHistory?: unknown[];
  createdAt: string;
  updatedAt: string;
};

export async function exportProject(store: Store, id: string): Promise<Buffer> {
  const p = store.project(id);
  const zip = new JSZip();
  const files: ArchiveFile[] = [];
  let total = 0;
  for (const f of p.files) {
    ensure(
      f.projectId === id,
      "工程内存在不属于该工程的文件",
      500,
      "archive_file_owner",
    );
    const bytes = store.bytes(f.id);
    ensure(
      bytes.length === f.bytes,
      "文件大小与记录不一致",
      500,
      "archive_file_size",
    );
    total += bytes.length;
    ensure(
      total <= MAX_BYTES,
      "项目导出文件总量超过512MB，请先移除不需要的候选素材",
      413,
      "archive_too_large",
    );
    const path = `media/${f.sha256}`;
    if (!zip.file(path))
      zip.file(path, bytes, { binary: true, compression: "STORE" });
    files.push({
      id: f.id,
      name: f.name,
      mime: f.mime,
      sha256: f.sha256,
      bytes: f.bytes,
      createdAt: f.createdAt,
      path,
      ...(f.text ? { text: f.text } : {}),
      ...(f.metadata ? { metadata: portableMetadata(f.metadata) } : {}),
    });
  }
  const ontology = portableOntology(p.ontology);
  const data: ArchiveProject = {
    schemaVersion: 1,
    sourceProjectId: p.id,
    sourceRevision: p.revision,
    name: p.name,
    requirements: pick(p.requirements, [
      "topic",
      "audience",
      "duration",
      "aspect",
      "fps",
      "style",
      "doctorMode",
      "sound",
      "brief",
    ]) as Requirements,
    ontology,
    reviewSubmissionHistory: portableMetadata([...(store.raw(id).reviewSubmissionHistory || []), ...store.reviewSubmissions(id)]),
    reviews: p.reviews.map((r) =>
      ({...pick(r, ["targetId", "targetHash", "status", "note", "updatedAt"]), ...(r.imported ? {imported: portableMetadata(r.imported)} : {})}),
    ) as Review[],
    artifacts: p.artifacts.map((a) => ({
      ...pick(a, [
        "id",
        "projectId",
        "jobId",
        "shotId",
        "assetId",
        "kind",
        "fileId",
        "sourceHash",
        "audioFileId",
        "audioHash",
        "accepted",
        "createdAt",
      ]),
      metadata: portableMetadata(a.metadata) || {},
    })) as Artifact[],
    selections: p.selections.map((s) =>
      pick(s, ["shotId", "artifactId", "sourceInSeconds", "sourceHash"]),
    ),
    createdAt: p.createdAt,
    updatedAt: p.updatedAt,
  };
  const projectBytes = jsonBytes(data);
  const reviewBytes = Buffer.from(
    renderReviewHtml({ ...p, ontology }, (file) => `media/${file.sha256}`),
    "utf8",
  );
  ensure(
    projectBytes.length <= 20 * 1024 * 1024,
    "项目结构与历史记录超过20MB，请减少不需要的历史内容",
    413,
    "archive_project",
  );
  zip.file("project.json", projectBytes);
  zip.file("review.html", reviewBytes);
  const entry = (path: string, bytes: Buffer): ChecksumEntry => ({
    path,
    sha256: sha(bytes),
    bytes: bytes.length,
  });
  const manifest: Manifest = {
    schema: SCHEMA,
    version: 1,
    createdAt: iso(),
    project: entry("project.json", projectBytes),
    review: entry("review.html", reviewBytes),
    files,
  };
  ensure(
    files.length <= 490,
    "项目文件数过多，导出上限490项",
    413,
    "archive_file_limit",
  );
  const manifestBytes = jsonBytes(manifest);
  ensure(
    manifestBytes.length <= 2 * 1024 * 1024,
    "文件清单与提取文本超过2MB，请减少不需要的资料文件",
    413,
    "archive_manifest",
  );
  ensure(
    total + projectBytes.length + reviewBytes.length + manifestBytes.length <=
      MAX_BYTES,
    "工程与素材总量超过512MB",
    413,
    "archive_too_large",
  );
  zip.file("manifest.json", manifestBytes);
  return zip.generateAsync({
    type: "nodebuffer",
    compression: "DEFLATE",
    compressionOptions: { level: 5 },
    platform: "UNIX",
  });
}

function validRelativePath(path: unknown): path is string {
  return (
    typeof path === "string" &&
    path.length > 0 &&
    path.length < 260 &&
    !path.startsWith("/") &&
    !path.includes("\\") &&
    !path.includes("\0") &&
    !path.includes(":") &&
    path.split("/").every((part) => part && part !== "." && part !== "..")
  );
}
function checkRequirements(r: any) {
  ensure(object(r), "项目需求格式无效");
  for (const key of ["topic", "audience", "style", "sound", "brief"])
    ensure(
      typeof r[key] === "string" && r[key].length <= 200000,
      `需求 ${key} 格式无效`,
    );
  ensure(
    Number.isFinite(r.duration) &&
      r.duration > 0 &&
      r.duration <= 3600 &&
      [24, 25].includes(r.fps),
    "项目时长或帧率无效",
  );
  ensure(
    ["9:16", "16:9"].includes(r.aspect) &&
      ["fictional", "photo"].includes(r.doctorMode),
    "项目画幅或医生模式无效",
  );
}
function remap(value: any, ids: Map<string, string>): any {
  if (typeof value === "string") return ids.get(value) || value;
  if (Array.isArray(value)) return value.map((v) => remap(v, ids));
  if (!object(value)) return value;
  return Object.fromEntries(
    Object.entries(value)
      .filter(([k]) => !["__proto__", "prototype", "constructor"].includes(k))
      .map(([k, v]) => [k, remap(v, ids)]),
  );
}

/** Validate the entire untrusted bundle before the first DB or filesystem mutation. */
export async function importProject(
  store: Store,
  bytes: Buffer,
): Promise<Project> {
  ensure(
    Buffer.isBuffer(bytes) && bytes.length > 0 && bytes.length <= MAX_BYTES,
    "ZIP为空或超过512MB",
    413,
    "archive_too_large",
  );
  const entries = await zipEntries(bytes, MAX_BYTES);
  const paths = new Map<string, (typeof entries)[number]>();
  for (const e of entries) {
    const original = (e as any).unsafeOriginalName || e.name;
    ensure(
      validRelativePath(e.name) &&
        validRelativePath(original) &&
        original === e.name,
      "ZIP含非法或被归一化的路径",
      400,
      "archive_path",
    );
    ensure(!paths.has(e.name), "ZIP含重复路径", 400, "archive_duplicate_path");
    paths.set(e.name, e);
  }
  ensure(
    paths.has("manifest.json"),
    "缺少manifest.json",
    400,
    "archive_manifest",
  );
  const manifestBytes = await paths.get("manifest.json")!.async("nodebuffer");
  ensure(
    manifestBytes.length <= 2 * 1024 * 1024,
    "manifest过大",
    413,
    "archive_manifest",
  );
  let manifest: Manifest;
  try {
    manifest = JSON.parse(manifestBytes.toString("utf8"));
  } catch {
    throw new AppError("manifest不是有效JSON", 400, "archive_manifest");
  }
  ensure(
    object(manifest) &&
      manifest.schema === SCHEMA &&
      manifest.version === 1 &&
      Array.isArray(manifest.files),
    "不是受支持的Storyflow工程包",
    400,
    "archive_schema",
  );
  ensure(
    manifest.files.length <= 490,
    "工程包文件数超过490项",
    413,
    "archive_file_limit",
  );
  const validatedBytes = new Map<string, Buffer>();
  let expanded = manifestBytes.length;
  const verified = async (e: ChecksumEntry, expectedPath?: string) => {
    ensure(
      object(e) &&
        validRelativePath(e.path) &&
        (!expectedPath || e.path === expectedPath) &&
        DIGEST.test(e.sha256) &&
        Number.isSafeInteger(e.bytes) &&
        e.bytes >= 0,
      "文件manifest条目无效",
      400,
      "archive_manifest",
    );
    ensure(
      paths.has(e.path),
      `ZIP缺少文件 ${e.path}`,
      400,
      "archive_missing_file",
    );
    const cached = validatedBytes.get(e.path);
    const data = cached || (await paths.get(e.path)!.async("nodebuffer"));
    if (!cached) {
      expanded += data.length;
      ensure(
        expanded <= MAX_BYTES,
        "ZIP解压总量超过512MB",
        413,
        "archive_too_large",
      );
    }
    ensure(
      data.length === e.bytes && sha(data) === e.sha256,
      `文件完整性校验失败：${e.path}`,
      400,
      "archive_integrity",
    );
    validatedBytes.set(e.path, data);
    return data;
  };
  const projectBytes = await verified(manifest.project, "project.json");
  ensure(
    projectBytes.length <= 20 * 1024 * 1024,
    "项目JSON过大",
    413,
    "archive_project",
  );
  await verified(manifest.review, "review.html");
  const fileMap = new Map<string, ArchiveFile>();
  for (const f of manifest.files) {
    ensure(
      object(f) && validId(f.id) && !fileMap.has(f.id),
      "文件ID无效或重复",
      400,
      "archive_file_id",
    );
    ensure(
      typeof f.name === "string" &&
        f.name.length > 0 &&
        f.name.length <= 180 &&
        !/[\\/\0]/.test(f.name),
      "文件显示名无效",
      400,
      "archive_file_name",
    );
    ensure(
      typeof f.mime === "string" &&
        /^[a-z][a-z0-9.+-]*\/[a-z0-9.+-]+$/i.test(f.mime),
      "文件MIME无效",
      400,
      "archive_file_mime",
    );
    ensure(
      f.path === `media/${f.sha256}`,
      "媒体路径必须与内容哈希一致",
      400,
      "archive_path",
    );
    if (f.text !== undefined)
      ensure(
        typeof f.text === "string" && f.text.length <= 500000,
        "文件提取文本无效",
        400,
        "archive_file_text",
      );
    await verified(f);
    fileMap.set(f.id, f);
  }
  const allowed = new Set(["manifest.json", ...validatedBytes.keys()]);
  ensure(
    [...paths.keys()].every((path) => allowed.has(path)),
    "ZIP含manifest未声明文件",
    400,
    "archive_undeclared_file",
  );
  let data: ArchiveProject;
  try {
    data = JSON.parse(projectBytes.toString("utf8"));
  } catch {
    throw new AppError("project.json不是有效JSON", 400, "archive_project");
  }
  ensure(
    object(data) &&
      data.schemaVersion === 1 &&
      validId(data.sourceProjectId) &&
      Number.isSafeInteger(data.sourceRevision) &&
      data.sourceRevision > 0,
    "项目记录格式无效",
    400,
    "archive_project",
  );
  ensure(
    typeof data.name === "string" &&
      data.name.length > 0 &&
      data.name.length <= 500,
    "项目名称无效",
  );
  ensure(
    !("jobs" in data),
    "迁移包不得包含可执行jobs；只迁移产物与历史说明",
    400,
    "archive_jobs",
  );
  if (data.reviewSubmissionHistory !== undefined) {
    ensure(Array.isArray(data.reviewSubmissionHistory) && data.reviewSubmissionHistory.length <= 10000 && data.reviewSubmissionHistory.every(record => object(record)), "审图提交历史格式无效", 400, "archive_review_history");
  }
  checkRequirements(data.requirements);
  const errors = validateOntology(data.ontology).filter(
    (i) => i.severity === "error",
  );
  ensure(errors.length === 0, "导入本体结构校验失败", 400, "archive_ontology");
  for (const a of data.ontology.assets)
    if (a.fileId) {
      const f = fileMap.get(a.fileId);
      ensure(
        f && f.sha256 === a.sha256,
        `素材 ${a.id} 引用缺失或哈希不符`,
        400,
        "archive_asset_reference",
      );
      ensure(
        a.kind === "document" ||
          a.kind === "graphic" ||
          f.mime.startsWith(`${a.kind}/`),
        `素材 ${a.id} 文件类型不匹配`,
        400,
        "archive_asset_mime",
      );
    }
  ensure(
    Array.isArray(data.artifacts) &&
      data.artifacts.length <= 1000 &&
      Array.isArray(data.reviews) &&
      data.reviews.length <= 20000 &&
      Array.isArray(data.selections),
    "审稿/产物记录格式无效",
  );
  const artifacts = new Map<string, Artifact>();
  ensure(
    !fileMap.has(data.sourceProjectId),
    "工程与文件ID不能冲突",
    400,
    "archive_id_collision",
  );
  for (const a of data.artifacts) {
    ensure(
      object(a) &&
        validId(a.id) &&
        !artifacts.has(a.id) &&
        validId(a.jobId) &&
        a.projectId === data.sourceProjectId &&
        ["video", "voice", "lipsync", "graphic", "final", "image"].includes(a.kind) &&
        DIGEST.test(a.sourceHash),
      "产物记录无效",
      400,
      "archive_artifact",
    );
    ensure(
      a.id !== data.sourceProjectId && !fileMap.has(a.id),
      "产物ID与工程/文件ID冲突",
      400,
      "archive_id_collision",
    );
    ensure(fileMap.has(a.fileId), "产物文件缺失", 400, "archive_artifact_file");
    if (a.shotId)
      ensure(
        data.ontology.shots.some((s) => s.id === a.shotId),
        "产物镜头引用不存在",
        400,
        "archive_artifact_shot",
      );
    if (a.kind === "image") {
      ensure(Boolean(a.assetId) !== Boolean(a.shotId), "图片产物必须有且只有一个目标", 400, "archive_image_target");
      ensure(fileMap.get(a.fileId)?.mime.startsWith("image/"), "图片产物文件类型不匹配", 400, "archive_image_mime");
      if (a.assetId) ensure(data.ontology.assets.some((asset) => asset.id === a.assetId && ["image", "graphic"].includes(asset.kind)), "图片产物素材引用不存在", 400, "archive_image_target");
    } else if (a.kind !== "final")
      ensure(
        Boolean(a.shotId),
        "镜头产物缺少镜头ID",
        400,
        "archive_artifact_shot",
      );
    if (a.audioFileId || a.audioHash)
      ensure(
        Boolean(
          a.audioFileId &&
            a.audioHash &&
            fileMap.get(a.audioFileId)?.sha256 === a.audioHash,
        ),
        "产物绑定音轨缺失或哈希不符",
        400,
        "archive_audio_reference",
      );
    artifacts.set(a.id, a);
  }
  const checkImageBinding = (binding: any, targetId: string, targetKind: "asset" | "shot") => {
    if (!binding) return;
    const image = artifacts.get(binding.artifactId);
    ensure(image?.kind === "image" && image.fileId === binding.fileId && fileMap.get(binding.fileId)?.sha256 === binding.sha256 && (targetKind === "asset" ? image.assetId : image.shotId) === targetId,
      `图片绑定 ${targetId} 的目标、文件或哈希不符`, 400, "archive_image_binding");
  };
  for (const asset of data.ontology.assets) checkImageBinding(asset.previewImage, asset.id, "asset");
  for (const shot of data.ontology.shots) {
    checkImageBinding(shot.reviewImage, shot.id, "shot");
    checkImageBinding(shot.firstFrameImage, shot.id, "shot");
  }
  for (const r of data.reviews)
    ensure(
      object(r) &&
        validId(r.targetId) &&
        DIGEST.test(r.targetHash) &&
        ["pass", "change", "pending"].includes(r.status) &&
        typeof r.note === "string" &&
        r.note.length <= 100000,
      "历史审核记录格式无效",
      400,
      "archive_review",
    );
  for (const s of data.selections)
    ensure(
      object(s) &&
        artifacts.has(s.artifactId) &&
        artifacts.get(s.artifactId)?.shotId === s.shotId &&
        Number.isFinite(s.sourceInSeconds) &&
        s.sourceInSeconds >= 0 &&
        s.sourceHash === artifacts.get(s.artifactId)?.sourceHash,
      "历史选片引用无效",
      400,
      "archive_selection",
    );

  // Nothing above this line writes to Store or disk. The mutation below is one DB transaction.
  const projectId = randomUUID(),
    now = iso(),
    ids = new Map<string, string>();
  ids.set(data.sourceProjectId, projectId);
  for (const a of data.artifacts) ids.set(a.id, randomUUID());
  const newlyCreatedCAS = new Set<string>();
  try {
    store.transaction(() => {
      const placeholder = {
        id: projectId,
        revision: 1,
        name: data.name,
        requirements: data.requirements,
        ontology: data.ontology,
        ...(data.reviewSubmissionHistory ? { reviewSubmissionHistory: portableMetadata(data.reviewSubmissionHistory).map((record:any)=>({...record, importedHistory:true, jobsReplayed:false, sourceProjectId:data.sourceProjectId})) } : {}),
        createdAt: now,
        updatedAt: now,
      };
      store.db
        .prepare("INSERT INTO projects VALUES(?,?,?)")
        .run(projectId, 1, JSON.stringify(placeholder));
      for (const f of manifest.files) {
        const casPath = join(store.directory, "files", f.sha256);
        if (!existsSync(casPath)) newlyCreatedCAS.add(casPath);
        const imported = store.addFile(
          projectId,
          f.name,
          f.mime,
          validatedBytes.get(f.path)!,
          {
            ...(f.text ? { text: f.text } : {}),
            metadata: {
              ...(portableMetadata(f.metadata) || {}),
              archive: {
                sourceProjectId: data.sourceProjectId,
                sourceFileId: f.id,
                originalCreatedAt: f.createdAt,
              },
            },
          },
        );
        ids.set(f.id, imported.id);
      }
      const ontology = portableOntology(data.ontology);
      for (const a of ontology.assets) {
        if (a.fileId) a.fileId = ids.get(a.fileId)!;
        if (a.previewImage) a.previewImage = remap(a.previewImage, ids);
      }
      for (const shot of ontology.shots) {
        if (shot.reviewImage) shot.reviewImage = remap(shot.reviewImage, ids);
        if (shot.firstFrameImage) {
          // Import preserves the image for review, never silently approves a video input.
          shot.reviewImage ||= remap(shot.firstFrameImage, ids);
          delete shot.firstFrameImage;
        }
      }
      const saved = { ...placeholder, ontology };
      store.db
        .prepare("UPDATE projects SET json=? WHERE id=?")
        .run(JSON.stringify(saved), projectId);
      store.db
        .prepare("INSERT INTO revisions VALUES(?,?,?)")
        .run(projectId, 1, JSON.stringify(saved));
      for (const a of data.artifacts) {
        const historicalSelection = data.selections.find(
          (s) => s.artifactId === a.id,
        );
        const imported: Artifact = {
          id: ids.get(a.id)!,
          projectId,
          jobId: `imported:${a.id}`,
          ...(a.shotId ? { shotId: a.shotId } : {}),
          ...(a.assetId ? { assetId: a.assetId } : {}),
          kind: a.kind,
          fileId: ids.get(a.fileId)!,
          sourceHash: a.sourceHash,
          ...(a.audioFileId
            ? { audioFileId: ids.get(a.audioFileId)!, audioHash: a.audioHash }
            : {}),
          accepted: false,
          createdAt: now,
          metadata: {
            ...(remap(portableMetadata(a.metadata), ids) || {}),
            archive: {
              sourceProjectId: data.sourceProjectId,
              sourceRevision: data.sourceRevision,
              originalArtifactId: a.id,
              originalJobId: a.jobId,
              previouslyAccepted: Boolean(a.accepted),
              ...(a.shotId && data.ontology.shots.find(s => s.id === a.shotId)?.firstFrameImage?.artifactId === a.id ? { previousFirstFrame: true } : {}),
              originalCreatedAt: a.createdAt,
              ...(historicalSelection
                ? { previousSelection: remap(historicalSelection, ids) }
                : {}),
              reviewRequired: true,
              jobsReplayed: false,
            },
          },
        };
        store.db
          .prepare("INSERT INTO artifacts VALUES(?,?,?)")
          .run(imported.id, projectId, JSON.stringify(imported));
      }
      for (const r of data.reviews) {
        const review: Review = {
          targetId: r.targetId,
          targetHash: r.targetHash,
          status: "pending",
          note: `[导入历史；原结论=${r.status}；原修订=${data.sourceRevision}；新工程须重新审核]\n${r.note}`,
          updatedAt: now,
          ...(r.imported ? {imported: portableMetadata(r.imported)} : {}),
        };
        store.db
          .prepare("INSERT OR REPLACE INTO reviews VALUES(?,?,?,?)")
          .run(
            projectId,
            review.targetId,
            review.targetHash,
            JSON.stringify(review),
          );
      }
      // No jobs, idempotency actions, sessions or active selections are imported.
    });
  } catch (error) {
    for (const path of newlyCreatedCAS) {
      try {
        if (existsSync(path)) unlinkSync(path);
      } catch {
        /* an unreferenced immutable CAS file is safe; do not mask import failure */
      }
    }
    throw error;
  }
  return store.project(projectId);
}

export function readOnlyReviewHtml(project: Project): string {
  // Relative to /api/projects/:id/review.html, also works below a reverse-proxy prefix.
  return renderReviewHtml(
    project,
    (file) => `../../files/${encodeURIComponent(file.id)}`,
  );
}

function renderReviewHtml(project: Project, fileUrl: (file: FileRecord) => string): string {
  return renderPublicReviewHtml(project, id => {
    const file = project.files.find(f => f.id === id);
    ensure(file, "审稿引用文件不存在", 400, "review_file");
    return fileUrl(file);
  });
}
