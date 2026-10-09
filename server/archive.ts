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
    reviews: p.reviews.map((r) =>
      pick(r, ["targetId", "targetHash", "status", "note", "updatedAt"]),
    ) as Review[],
    artifacts: p.artifacts.map((a) => ({
      ...pick(a, [
        "id",
        "projectId",
        "jobId",
        "shotId",
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
        ["video", "voice", "lipsync", "graphic", "final"].includes(a.kind) &&
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
    if (a.kind !== "final")
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
      for (const a of ontology.assets)
        if (a.fileId) a.fileId = ids.get(a.fileId)!;
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

function renderReviewHtml(
  project: Project,
  fileUrl: (file: FileRecord) => string,
): string {
  const o = project.ontology,
    c = compileOntology(o),
    esc = escapeHtml;
  const files = new Map(project.files.map((f) => [f.id, f]));
  const sec = (frame: number) =>
    (frame / o.spec.fps).toFixed(2).replace(/\.00$/, "");
  const labels = new Map([
    ...o.entities.map((e) => [e.id, e.label] as const),
    ...o.assets.map((a) => [a.id, a.label] as const),
  ]);
  const review = (id: string) => {
    const r = project.reviews.find(
      (r) => r.targetId === id && r.targetHash === c.targetHashes[id],
    );
    return r
      ? `${{ pass: "通过", change: "要修改", pending: "待审" }[r.status]}${r.note ? ` · ${r.note}` : ""}`
      : "待审";
  };
  const arrow = '<div class="arrow" aria-hidden="true">↓</div>';
  const node = (title: string, detail: string) =>
    `<div class="node"><strong>${esc(title)}</strong><p>${esc(detail)}</p></div>`;
  const link = (url: unknown, text: string) => {
    const safe = href(url);
    return safe
      ? `<a href="${esc(safe)}" target="_blank" rel="noopener noreferrer">${esc(text)}</a>`
      : esc(text);
  };
  const shotCards = o.shots
    .map(
      (s) =>
        `<article id="shot-${esc(s.id)}"><div class="meta">${esc(s.id)} · ${sec(s.startFrame)}–${sec(s.endFrame)} 秒 · ${s.endFrame - s.startFrame} 帧 · ${esc(s.route)}</div><h3>${esc(s.title)}</h3><p>${esc(s.action)}</p><dl><dt>机位／景别</dt><dd>${esc(s.camera)} · ${esc(s.scale)}</dd><dt>动作入点</dt><dd>${esc(s.startState)}</dd><dt>动作出点</dt><dd>${esc(s.endState)}</dd><dt>专属素材</dt><dd>${s.requiredAssetIds.map((id) => esc(labels.get(id) || id)).join(" / ") || "无"}</dd><dt>前镜依赖</dt><dd>${esc(s.dependencies.join(" / ") || "无")}</dd></dl>${s.dialogue.map((d) => `<blockquote>${esc(labels.get(d.speakerId) || d.speakerId)}：“${esc(d.text)}”<small>拟定台词；实际声音须逐字及口型审核</small></blockquote>`).join("")}<details><summary>提示词、字幕与验收要求</summary><pre>${esc(c.prompts[s.id])}</pre><p>必须看见：${esc(s.mustShow.join("；") || "见素材要求")}</p><p>拒收：${esc(s.rejectIf.join("；") || "按本镜内容验收")}</p><p>字幕草案：${esc(s.subtitles.map((x) => `${sec(x.startFrame)}–${sec(x.endFrame)}s ${x.text}`).join("\n") || "无")}</p></details><p class="review">${esc(review(s.id))}</p><code>审核 ${esc(c.targetHashes[s.id])}</code></article>`,
    )
    .join("");
  const assetCards = o.assets
    .map((a) => {
      const file = a.fileId ? files.get(a.fileId) : undefined;
      const image =
        file &&
        ["image/png", "image/jpeg", "image/webp", "image/gif"].includes(
          file.mime,
        );
      return `<article><span class="meta">${esc(a.id)} · ${a.purpose === "reference" ? "审稿参考" : "专属制作素材"} · ${a.gap ? "待补齐" : file ? "已绑定文件" : "未绑定"}</span><h3>${esc(a.label)}</h3>${image ? `<img src="${esc(fileUrl(file!))}" alt="${esc(a.label)}" loading="lazy">` : ""}<p>${esc(a.source?.use || "实际用途待审")}</p><p>${link(a.source?.url, "原始来源")} · ${esc(a.source?.author || "作者未登记")} · ${esc(a.source?.license || "许可待核对")}</p><p>必须可见：${esc(a.mustShow?.join("；") || "见镜头要求")}</p><p>${esc(review(a.id))}</p>${file ? `<a href="${esc(fileUrl(file))}" download="${esc(file.name)}">下载绑定文件</a><code>SHA-256 ${esc(file.sha256)}</code>` : ""}</article>`;
    })
    .join("");
  const taskCards = c.tasks
    .map(
      (t) =>
        `<li><div class="node"><span class="meta">${esc(t.id)}</span><strong>${esc(t.kind === "voice" ? "生成并听审逐句声音" : t.kind === "lipsync" ? "同一音轨＋肖像驱动口型" : t.kind === "compose" ? "字幕／图示／已验素材合成" : t.kind === "graphic" ? "声明式图形渲染" : "视频模型生成")}</strong><p>${esc(t.shotId ? o.shots.find((s) => s.id === t.shotId)?.title : "最终成片")}</p><small>前置：${esc(t.dependsOn.join(" ＋ ") || "已确认输入")}</small></div></li>`,
    )
    .join("");
  const artifactCards = project.artifacts
    .map((a) => {
      const f = files.get(a.fileId);
      return `<article><h3>${esc(a.shotId || "最终成片")} · ${esc(a.kind)}</h3><p>${a.accepted ? "已记录人工验收" : "待人工验收"} · ${a.sourceHash === (a.shotId ? c.shotHashes[a.shotId] : c.postHash) ? "当前输入版本" : "历史输入版本"}</p>${f ? `<a href="${esc(fileUrl(f))}" download="${esc(f.name)}">查看／下载产物</a>` : "<p>文件不可用</p>"}<details><summary>实际产物来源与参考条件记录</summary><pre>${esc(JSON.stringify(portableMetadata(a.metadata) || {}, null, 2))}</pre></details></article>`;
    })
    .join("");
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="referrer" content="no-referrer"><title>${esc(project.name)} · 审稿快照</title><style>*{box-sizing:border-box}body{margin:0;background:#f5f7f3;color:#20372d;font:16px/1.65 system-ui,-apple-system,sans-serif}main{max-width:1180px;margin:auto;padding:28px 20px 80px}h1,h2,h3{line-height:1.3}h2{margin-top:48px}a{color:#206f51}nav{display:flex;gap:16px;flex-wrap:wrap}article,.notice{border:1px solid #d7e0d6;border-radius:16px;background:white;padding:20px;margin:16px 0}p{white-space:pre-wrap;overflow-wrap:anywhere}.meta,small{font-size:13px;color:#5c7568}small,code{display:block}code{font-size:11px;overflow-wrap:anywhere}pre{white-space:pre-wrap;overflow-wrap:anywhere;background:#eff4ee;padding:12px;border-radius:10px}dl{display:grid;grid-template-columns:110px 1fr;gap:8px}dt{color:#5c7568}dd{margin:0;overflow-wrap:anywhere}blockquote{margin:14px 0;padding:14px;border-left:3px solid #7fae90;background:#f6faf4}.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(280px,1fr));gap:16px}.grid article{margin:0}img{max-width:100%;max-height:300px;object-fit:contain}.node{border:1px solid #7fae90;border-radius:12px;padding:16px;background:#f2f8f0;text-align:center}.node p{margin:6px 0}.arrow{text-align:center;font-size:24px;color:#43835a}.lanes{display:grid;grid-template-columns:repeat(3,1fr);gap:18px}.decision{border:2px solid #6f9471;transform:rotate(0);border-radius:30px}.repair{color:#a33e35;text-align:center}.flowtasks{list-style:none;padding:0;display:grid;grid-template-columns:repeat(auto-fit,minmax(230px,1fr));gap:12px}.review{border-top:1px solid #d7e0d6;padding-top:12px}@media(max-width:700px){main{padding:20px 12px}.lanes{grid-template-columns:1fr}.grid{grid-template-columns:1fr}dl{grid-template-columns:1fr}article{padding:16px}}@media print{details{display:block}nav{display:none}.node,article{break-inside:avoid}}</style></head><body><main><header><p class="meta">Storyflow · 只读审稿快照 · 修订 ${project.revision}</p><h1>${esc(project.name)}</h1><p>${esc(project.requirements.topic)} · ${o.spec.width}×${o.spec.height} · ${o.spec.fps}fps · ${o.spec.totalFrames}帧 / ${sec(o.spec.totalFrames)}秒</p><code>本体 SHA-256 ${esc(c.hash)}</code><nav><a href="#requirements">需求</a><a href="#flow">制作框图</a><a href="#shots">分镜</a><a href="#assets">素材</a><a href="#artifacts">产物</a></nav></header><div class="notice">这是固定版本的只读导出。按钮、意见和模型调用均不会执行。网页方案通过不等于声音、口型或成片已经验收。工程ZIP里的review.html与media目录一同解压，可离线查看已绑定素材。</div><section id="requirements"><h2>需求与故事展开</h2><p>${esc(project.requirements.brief)}</p><p>受众：${esc(project.requirements.audience)}\n风格：${esc(project.requirements.style)}\n声音：${esc(project.requirements.sound)}</p></section><section id="flow"><h2>需求 → 展开 → 审核 → 视频</h2>${node("确认需求与本体版本", "角色、场景、对象、事实依据、台词、素材与帧时间表绑定同一修订。")}${arrow}${node("校验并审核输入", "先补专属素材，审文字、形态、身份与来源。审核哈希发生变化时重新审对应内容。")}${arrow}<div class="lanes"><div>${node("视频素材分支", "模型只按真实接通的参考能力生成视频和声音。")}${arrow}${node("逐镜验收", "看身份、动作、目标事物与连续性；合格成品才解锁后镜。")}<p class="repair">不通过 ↶ 返回本镜制作</p></div><div>${node("医生声音分支", "先生成逐句原声并逐字听审。")}${arrow}${node("同一审核声音 ＋ 医生照片", "音频驱动口型；没有照片或合格音频不能执行。")}${arrow}${node("口型与听感验收", "声音错词返修声音并重新驱动；仅口型有误，保留同一句合格声音重做驱动。")}</div><div>${node("后期图形分支", "Opus产出有界声明式图形计划；由可信渲染器执行。")}${arrow}${node("图文与时序验收", "实际叠层时序依据合格底片与音轨；文字、医学关系、位置逐项核对。")}<p class="repair">不通过 ↶ 返回后期计划</p></div></div>${arrow}${node("合流：合格底片 ＋ 原音轨 ＋ 字幕／图示", "按整数帧剪辑；素材不足报缺口，不循环、冻结或加速凑时长。")}${arrow}${node("FFmpeg合成与最终验收", "技术、故事、事实、口型、听感分别验收。源素材保留，后期失败只重做后期。")}<p class="repair">素材问题 ↶ 对应源镜头；字幕／图示问题 ↶ 后期</p><div class="notice"><strong>真实控制限制</strong><p>Seedance当前适配路线只传首帧或纯文字。末态锚图、完整动作或对白准确性都是计划与验收目标，不能声称已经作为完整控制条件发送。医生路线需实际音频驱动接入；具体模型、发送参考和参数以任务/产物回执为准。框图不代替能力验证或人工验收。</p></div><details><summary>展开本工程逐镜任务依赖（${c.tasks.length}项）</summary><ol class="flowtasks">${taskCards}</ol></details>${c.issues.length ? `<details><summary>当前校验信息（${c.issues.length}项）</summary><ul>${c.issues.map((i) => `<li>${esc(i.severity)} · ${esc(i.path)} · ${esc(i.message)}</li>`).join("")}</ul></details>` : "<p>结构校验通过；这不代表实际媒体已经通过。</p>"}</section><section id="shots"><h2>逐镜审稿</h2>${shotCards}</section><section id="assets"><h2>素材与来源</h2><p>网络参考、实际生产素材和缺口分开列示。当前 ${c.gaps.length} 条登记素材尚有缺口或未绑定。</p><div class="grid">${assetCards}</div></section><section><h2>事实依据与本体对象</h2><div class="grid">${o.evidence.map((e) => `<article><h3>${link(e.url, e.title)}</h3><p>${esc(e.excerpt)}</p><small>${esc(e.locator || "")}</small></article>`).join("")}</div><details><summary>查看 ${o.entities.length} 个实体与 ${o.relations.length} 个关系</summary><pre>${esc(JSON.stringify({ entities: o.entities, relations: o.relations }, null, 2))}</pre></details></section><section id="artifacts"><h2>真实产物</h2>${artifactCards || "<p>当前没有已登记产物。分镜与示意图不能冒充已经生成的视频。</p>"}</section><footer><p class="meta">源素材、台词与审核结果以本快照记录为准；导入另一个工程会重置通过状态，不自动提交或重放任务。</p></footer></main></body></html>`;
}
