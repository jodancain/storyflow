import { DatabaseSync } from "node:sqlite";
import {
  randomUUID,
  scryptSync,
  timingSafeEqual,
  randomBytes,
} from "node:crypto";
import {
  mkdirSync,
  writeFileSync,
  readFileSync,
  existsSync,
  renameSync,
} from "node:fs";
import { join, resolve, basename, extname } from "node:path";
import type {
  Ontology,
  Requirements,
  Review,
  FileRecord,
  Artifact,
  Job,
  Project,
  ImportedOpinion,
  ImageRequalificationInput,
  ImageRequalificationRecord,
} from "../shared/types.ts";
import { compileOntology, hash, imageTargetHash, imageTargetHashes, shotImageInputBasis } from "../shared/ontology.ts";
import { ensure, iso, sha } from "./util.ts";
import { resolveImageReference } from "../shared/image-consistency.ts";
import { assertNoInterruptedRestore } from "./restore-journal.ts";
const parse = (value: any) => JSON.parse(value);
export interface ProductionImageInput {
  artifactId: string;
  sha256: string;
}
export class Store {
  db: DatabaseSync;
  constructor(public directory: string) {
    this.directory = resolve(directory);
    assertNoInterruptedRestore(this.directory);
    mkdirSync(this.directory, { recursive: true });
    mkdirSync(join(this.directory, "files"), { recursive: true });
    mkdirSync(join(this.directory, "work"), { recursive: true });
    this.db = new DatabaseSync(join(this.directory, "storyflow.sqlite"));
    this.db
      .exec(`PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;
`);
    const version = (this.db.prepare("PRAGMA user_version").get() as any)
      .user_version;
    ensure(version <= 2, "数据库版本高于本程序，请使用兼容版本", 500);
    if (version === 0) {
      this.db.exec("BEGIN IMMEDIATE");
      try {
        this.db.exec(
          readFileSync(
            new URL("./migrations/001-init.sql", import.meta.url),
            "utf8",
          ),
        );
        this.db.exec("COMMIT");
      } catch (e) {
        this.db.exec("ROLLBACK");
        throw e;
      }
    }
    if (version < 2) {
      this.transaction(() => this.db.exec(readFileSync(new URL("./migrations/002-review-submissions.sql", import.meta.url), "utf8")));
    }
  }
  close() {
    this.db.close();
  }
  transaction<T>(fn: () => T): T {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const result = fn();
      this.db.exec("COMMIT");
      return result;
    } catch (e) {
      this.db.exec("ROLLBACK");
      throw e;
    }
  }
  setting(key: string) {
    return (
      this.db.prepare("SELECT value FROM settings WHERE key=?").get(key) as any
    )?.value;
  }
  setSetting(key: string, value: string) {
    this.db
      .prepare("INSERT OR REPLACE INTO settings VALUES(?,?)")
      .run(key, value);
  }
  hasPassword() {
    return !!this.setting("admin");
  }
  setPassword(password: string) {
    ensure(
      password.length >= 12 && password.length <= 256,
      "密码需为12–256个字符",
    );
    ensure(!this.hasPassword(), "管理员已经设置", 409);
    const salt = randomBytes(16).toString("hex");
    this.setSetting(
      "admin",
      `${salt}:${scryptSync(password, salt, 32).toString("hex")}`,
    );
  }
  verifyPassword(password: string) {
    const value = this.setting("admin");
    if (!value || password.length > 256) return false;
    const [salt, expected] = value.split(":");
    return timingSafeEqual(
      scryptSync(password, salt, 32),
      Buffer.from(expected, "hex"),
    );
  }
  session() {
    const token = randomBytes(32).toString("hex");
    this.db.prepare("DELETE FROM sessions WHERE expires<?").run(Date.now());
    this.db
      .prepare("INSERT INTO sessions VALUES(?,?)")
      .run(sha(token), Date.now() + 7 * 86400000);
    return token;
  }
  authenticated(token: string) {
    const row = this.db
      .prepare("SELECT expires FROM sessions WHERE token_hash=?")
      .get(sha(token)) as any;
    return Boolean(row && row.expires > Date.now());
  }
  logout(token: string) {
    this.db.prepare("DELETE FROM sessions WHERE token_hash=?").run(sha(token));
  }
  create(name: string, requirements: Requirements, ontology: Ontology) {
    const now = iso(),
      id = randomUUID(),
      p = {
        id,
        revision: 1,
        name,
        requirements,
        ontology,
        createdAt: now,
        updatedAt: now,
      };
    this.transaction(() => {
      this.db
        .prepare("INSERT INTO projects VALUES(?,?,?)")
        .run(id, 1, JSON.stringify(p));
      this.db
        .prepare("INSERT INTO revisions VALUES(?,?,?)")
        .run(id, 1, JSON.stringify(p));
    });
    return this.project(id);
  }
  raw(id: string): any {
    const row = this.db
      .prepare("SELECT json FROM projects WHERE id=?")
      .get(id) as any;
    ensure(row, "工程不存在", 404);
    return parse(row.json);
  }
  project(id: string): Project & { selections: any[] } {
    const p = this.raw(id),
      compiled = compileOntology(p.ontology),
      selections = this.selections(id),
      artifacts = this.artifacts(id);
    compiled.postHash = hash({
      ontologyPostHash: compiled.postHash,
      selections: [...selections]
        .sort((a, b) => a.shotId.localeCompare(b.shotId))
        .map((selection) => {
          const a = artifacts.find((a) => a.id === selection.artifactId);
          return {
            ...selection,
            fileHash: a ? this.file(a.fileId).sha256 : null,
            audioHash: a?.audioHash,
          };
        }),
    });
    compiled.targetHashes.post = compiled.postHash;
    const targetHashes=imageTargetHashes(p.ontology);
    const current:Record<string,boolean>={}, visiting=new Set<string>();
    const imageCurrent=(a:Artifact):boolean=>{
      if(current[a.id] !== undefined) return current[a.id];
      if(visiting.has(a.id)) return false;
      visiting.add(a.id);
      const adoption=a.metadata.productionAdoption as {schema?:unknown; sourceHash?:unknown; adoptedBriefHash?:unknown; imageSha256?:unknown} | undefined;
      const requalified=a.metadata.imageRequalification as ImageRequalificationRecord | undefined;
      // Adoption is a separate record of using approved bytes under a binding-only
      // revision. Imported metadata is history, not authority: only the matching
      // local action can enable it. Full SQLite backup/restore retains that action.
      const briefMatches=a.sourceHash===targetHashes[a.assetId || a.shotId || ""] ||
        (adoption?.schema === "storyflow-production-adoption-v1" &&
          adoption.sourceHash === a.sourceHash &&
          adoption.adoptedBriefHash === targetHashes[a.assetId || a.shotId || ""] &&
          adoption.imageSha256 === this.file(a.fileId).sha256 && this.trustedImageAction(id,a,adoption,"storyflow-production-adoption-v1")) ||
        ((requalified?.scope === "unchanged-ontology-compiler-review" || requalified?.scope === "explicit-review-of-unchanged-shot-inputs") &&
          requalified.sourceHash === a.sourceHash && requalified.newBriefHash === targetHashes[a.shotId || ""] &&
          requalified.sha256 === this.file(a.fileId).sha256 && requalified.lineageHash === hash(this.imageLineage(a)) &&
          this.trustedImageAction(id,a,requalified,"storyflow-image-requalification-v1") &&
          (requalified.scope === "unchanged-ontology-compiler-review" ||
            this.trustedImageAction(id,a,requalified.previousQualification,"storyflow-image-requalification-v1")) &&
          this.trustedImageAction(id,a,requalified.originalAdoption,"storyflow-production-adoption-v1"));
      const matches=briefMatches &&
        ((a.metadata.parentAssets || []) as any[]).every(parent=>{
          const asset=p.ontology.assets.find((x:any)=>x.id===parent.assetId);
          const identity=Array.isArray(a.metadata.identityReferences) && a.metadata.identityReferences.find((r:any)=>r.assetId===parent.assetId);
          if(identity && identity.artifactId) {
            const canonical=artifacts.filter(candidate=>candidate.kind === "image" && candidate.assetId===parent.assetId && candidate.accepted && candidate.sourceHash===targetHashes[parent.assetId]);
            return canonical.length === 1 && canonical[0].id===identity.artifactId && canonical[0].fileId===parent.fileId && this.file(parent.fileId).sha256===parent.sha256 && imageCurrent(canonical[0]);
          }
          if(identity) {
            const approved=this.reviews(id).some(review=>review.targetId===parent.assetId && review.targetHash===compiled.targetHashes[parent.assetId] && review.status === "pass");
            return approved && asset?.fileId===parent.fileId && asset?.sha256===parent.sha256;
          }
          const selected=parent.assetId === a.assetId && parent.fileId
            ? this.files(id).find(f=>f.id===parent.fileId)
            : resolveImageReference({id,ontology:p.ontology,files:this.files(id),artifacts,reviews:this.reviews(id),compiled,imageTargetHashes:targetHashes,imageCandidateCurrent:current},parent.assetId,candidate=>imageCurrent(candidate),parent.sha256);
          if(!selected || selected.sha256 !== parent.sha256) return false;
          const upstream=artifacts.find(x=>x.kind === "image" && x.id!==a.id && x.fileId===(("fileId" in selected && selected.fileId) || ("id" in selected && selected.id)));
          return !upstream || imageCurrent(upstream);
        }) && ((a.metadata.parentShots || []) as any[]).every(parent=>{
          const shot=p.ontology.shots.find((s:any)=>s.id===parent.shotId);
          const bindings=[shot?.reviewImage,shot?.firstFrameImage].filter(Boolean);
          const upstream=artifacts.find(candidate=>candidate.kind === "image" && candidate.id!==a.id && candidate.shotId===parent.shotId &&
            (parent.shotId === a.shotId && parent.fileId ? candidate.fileId===parent.fileId || candidate.metadata.originalFileId===parent.fileId : bindings.some(binding=>binding.artifactId===candidate.id)) &&
            (candidate.metadata.originalSha256===parent.sha256 || this.file(candidate.fileId).sha256===parent.sha256));
          return Boolean(upstream && imageCurrent(upstream));
        });
      visiting.delete(a.id);return current[a.id]=matches;
    };
    for(const a of artifacts) if(a.kind === "image") imageCurrent(a);
    return {
      ...p,
      compiled,
      imageTargetHashes: targetHashes,
      imageCandidateCurrent:current,
      reviews: this.reviews(id),
      files: this.files(id),
      artifacts,
      jobs: this.jobs(id),
      selections,
    };
  }
  list() {
    return this.db
      .prepare("SELECT json FROM projects ORDER BY rowid DESC")
      .all()
      .map((r: any) => {
        const p = parse(r.json);
        return {
          id: p.id,
          name: p.name,
          revision: p.revision,
          requirements: p.requirements,
          updatedAt: p.updatedAt,
          createdAt: p.createdAt,
        };
      });
  }
  edit(
    id: string,
    baseRevision: number,
    patch: { name?: string; requirements?: Requirements; ontology?: Ontology },
  ) {
    this.transaction(() => {
      const p = this.raw(id);
      ensure(
        p.revision === baseRevision,
        "内容已更新，请刷新后再保存",
        409,
        "revision_conflict",
      );
      const next = {
        ...p,
        ...patch,
        revision: p.revision + 1,
        updatedAt: iso(),
      };
      this.db
        .prepare("UPDATE projects SET revision=?,json=? WHERE id=?")
        .run(next.revision, JSON.stringify(next), id);
      this.db
        .prepare("INSERT INTO revisions VALUES(?,?,?)")
        .run(id, next.revision, JSON.stringify(next));
    });
    return this.project(id);
  }
  revisions(id: string) {
    this.raw(id);
    return this.db
      .prepare(
        "SELECT revision,json FROM revisions WHERE project_id=? ORDER BY revision DESC",
      )
      .all(id)
      .map((r: any) => {
        const p = parse(r.json);
        return {
          revision: r.revision,
          name: p.name,
          updatedAt: p.updatedAt,
          hash: hash(p.ontology),
        };
      });
  }
  revision(id: string, revision: number) {
    const r = this.db
      .prepare("SELECT json FROM revisions WHERE project_id=? AND revision=?")
      .get(id, revision) as any;
    ensure(r, "修订不存在", 404);
    return parse(r.json);
  }
  reviews(id: string): Review[] {
    return this.db
      .prepare("SELECT json FROM reviews WHERE project_id=? ORDER BY rowid")
      .all(id)
      .map((r: any) => parse(r.json));
  }
  review(
    id: string,
    targetId: string,
    status: Review["status"],
    note: string,
    targetHash?: string,
  ) {
    const p = this.project(id);
    const current = p.compiled.targetHashes[targetId];
    ensure(current || targetHash, "审核对象不存在", 404);
    const review: Review = {
      targetId,
      targetHash: targetHash || current,
      status,
      note,
      updatedAt: iso(),
    };
    this.db
      .prepare("INSERT OR REPLACE INTO reviews VALUES(?,?,?,?)")
      .run(id, targetId, review.targetHash, JSON.stringify(review));
    return this.project(id);
  }
  reviewSubmissions(projectId: string): import("./review-submissions.ts").ReviewSubmission[] {
    this.raw(projectId);
    return this.db.prepare("SELECT json FROM review_submissions WHERE project_id=? ORDER BY rowid DESC").all(projectId).map((row: any) => parse(row.json));
  }
  reviewSubmission(projectId: string, id: string): import("./review-submissions.ts").ReviewSubmission {
    const row = this.db.prepare("SELECT json FROM review_submissions WHERE project_id=? AND id=?").get(projectId, id) as any;
    ensure(row, "意见提交记录不存在", 404);
    return parse(row.json);
  }
  recordReviewSubmission(submission: import("./review-submissions.ts").ReviewSubmission) {
    this.db.prepare("INSERT INTO review_submissions VALUES(?,?,?)").run(submission.id, submission.projectId, JSON.stringify(submission));
  }
  importOpinion(projectId:string,targetId:string,note:string,imported:ImportedOpinion) {
    this.raw(projectId);
    const review:Review={targetId,targetHash:hash({schema:"storyflow-imported-opinion-v1",targetId,note,imported}),status:"pending",note,imported,updatedAt:iso()};
    this.db.prepare("INSERT OR REPLACE INTO reviews VALUES(?,?,?,?)").run(projectId,targetId,review.targetHash,JSON.stringify(review));
    return review;
  }
  approved(p: Project, targetId: string) {
    const asset=p.ontology.assets.find(a=>a.id===targetId);
    const candidate=asset?.fileId && p.artifacts.find(a=>a.kind === "image" && a.fileId===asset.fileId);
    if(candidate && (!candidate.accepted || !this.imageCurrent(candidate))) return false;
    return p.reviews.some(
      (r) =>
        r.targetId === targetId &&
        r.targetHash === p.compiled.targetHashes[targetId] &&
        r.status === "pass",
    );
  }
  addFile(
    projectId: string,
    name: string,
    mime: string,
    bytes: Buffer,
    extra: { text?: string; metadata?: Record<string, unknown> } = {},
  ): FileRecord {
    this.raw(projectId);
    const digest = sha(bytes),
      relativePath = `files/${digest}`,
      path = join(this.directory, relativePath);
    if (!existsSync(path)) {
      const temp = `${path}.${randomUUID()}.tmp`;
      writeFileSync(temp, bytes, { mode: 0o600 });
      renameSync(temp, path);
    }
    const file: FileRecord = {
      id: randomUUID(),
      projectId,
      name: basename(name).slice(0, 180),
      mime,
      sha256: digest,
      bytes: bytes.length,
      relativePath,
      ...extra,
      createdAt: iso(),
    };
    this.db
      .prepare("INSERT INTO files VALUES(?,?,?)")
      .run(file.id, projectId, JSON.stringify(file));
    return file;
  }
  file(id: string): FileRecord {
    const row = this.db
      .prepare("SELECT json FROM files WHERE id=?")
      .get(id) as any;
    ensure(row, "文件不存在", 404);
    return parse(row.json);
  }
  filePath(id: string) {
    const file = this.file(id);
    ensure(
      /^files\/[a-f0-9]{64}$/.test(file.relativePath),
      "文件记录不合法",
      500,
    );
    return join(this.directory, file.relativePath);
  }
  bytes(id: string) {
    const bytes = readFileSync(this.filePath(id));
    ensure(sha(bytes) === this.file(id).sha256, "文件哈希校验失败", 500);
    return bytes;
  }
  files(id: string): FileRecord[] {
    return this.db
      .prepare("SELECT json FROM files WHERE project_id=?")
      .all(id)
      .map((r: any) => parse(r.json));
  }
  bind(id: string, baseRevision: number, assetId: string, fileId: string) {
    const p = this.project(id),
      file = this.file(fileId);
    ensure(file.projectId === id, "文件不属于此工程", 403);
    const asset = p.ontology.assets.find((a) => a.id === assetId);
    ensure(asset, "素材槽不存在", 404);
    const kind = file.mime.split("/")[0];
    ensure(
      asset.kind === "document" ||
        asset.kind === "graphic" ||
        kind === asset.kind,
      "文件类型与素材槽不匹配",
    );
    const candidate=p.artifacts.find(a=>a.kind === "image" && a.fileId===file.id);
    ensure(!candidate || (candidate.accepted && this.imageCurrent(candidate)),"请先批准当前图片候选，再用作制作素材",409,"approval_required");
    asset.fileId = file.id;
    asset.sha256 = file.sha256;
    asset.gap = false;
    return this.edit(id, baseRevision, { ontology: p.ontology });
  }
  action(id: string, key: string, inputHash: string) {
    const row = this.db
      .prepare(
        "SELECT input_hash,result FROM actions WHERE project_id=? AND key=?",
      )
      .get(id, key) as any;
    if (row) {
      ensure(
        row.input_hash === inputHash,
        "幂等键已用于不同输入",
        409,
        "idempotency_conflict",
      );
      return parse(row.result);
    }
    return null;
  }
  recordAction(id: string, key: string, inputHash: string, result: any) {
    this.db
      .prepare("INSERT INTO actions VALUES(?,?,?,?)")
      .run(id, key, inputHash, JSON.stringify(result));
  }
  addJob(
    input: Omit<
      Job,
      | "id"
      | "state"
      | "stage"
      | "progress"
      | "attempts"
      | "createdAt"
      | "updatedAt"
    >,
  ): Job {
    const now = iso();
    const job: Job = {
      ...input,
      id: randomUUID(),
      state: "queued",
      stage: "queued",
      progress: 0,
      attempts: 0,
      createdAt: now,
      updatedAt: now,
    };
    this.db
      .prepare("INSERT INTO jobs VALUES(?,?,?,?)")
      .run(job.id, job.projectId, job.state, JSON.stringify(job));
    return job;
  }
  job(id: string): Job {
    const row = this.db
      .prepare("SELECT json FROM jobs WHERE id=?")
      .get(id) as any;
    ensure(row, "任务不存在", 404);
    return parse(row.json);
  }
  updateJob(id: string, patch: Partial<Job>) {
    const job = { ...this.job(id), ...patch, updatedAt: iso() };
    this.db
      .prepare("UPDATE jobs SET state=?,json=? WHERE id=?")
      .run(job.state, JSON.stringify(job), id);
    return job;
  }
  jobs(id?: string): Job[] {
    return (
      id
        ? this.db
            .prepare(
              "SELECT json FROM jobs WHERE project_id=? ORDER BY rowid DESC",
            )
            .all(id)
        : this.db.prepare("SELECT json FROM jobs ORDER BY rowid").all()
    ).map((r: any) => parse(r.json));
  }
  workDir(jobId: string) {
    ensure(/^[a-f0-9-]{36}$/.test(jobId), "任务ID无效");
    const p = join(this.directory, "work", jobId);
    mkdirSync(p, { recursive: true });
    return p;
  }
  artifact(id: string): Artifact {
    const r = this.db
      .prepare("SELECT json FROM artifacts WHERE id=?")
      .get(id) as any;
    ensure(r, "产物不存在", 404);
    return parse(r.json);
  }
  artifacts(id: string): Artifact[] {
    return this.db
      .prepare(
        "SELECT json FROM artifacts WHERE project_id=? ORDER BY rowid DESC",
      )
      .all(id)
      .map((r: any) => parse(r.json));
  }
  addArtifact(value: Omit<Artifact, "id" | "accepted" | "createdAt">) {
    const artifact: Artifact = {
      ...value,
      id: randomUUID(),
      accepted: false,
      createdAt: iso(),
    };
    this.db
      .prepare("INSERT INTO artifacts VALUES(?,?,?)")
      .run(artifact.id, artifact.projectId, JSON.stringify(artifact));
    return artifact;
  }
  private imageLineage(a: Artifact): Record<string, unknown> {
    return {parentAssets:a.metadata.parentAssets || [],parentShots:a.metadata.parentShots || [],
      identityReferences:a.metadata.identityReferences || [],consistencyContract:a.metadata.consistencyContract || null};
  }
  private trustedImageAction(projectId: string, artifact: Artifact, evidence: any, schema: string): boolean {
    if(evidence?.schema !== schema || typeof evidence.actionKey !== "string" || evidence.actionKey.length < 8 || evidence.actionKey.length > 128 ||
      typeof evidence.actionInputHash !== "string" || !/^[a-f0-9]{64}$/.test(evidence.actionInputHash)) return false;
    const row=this.db.prepare("SELECT input_hash,result FROM actions WHERE project_id=? AND key=?").get(projectId,evidence.actionKey) as any;
    if(!row || row.input_hash !== evidence.actionInputHash) return false;
    const proof=parse(row.result);
    if(proof?.schema !== schema || proof.id !== evidence.id || !Array.isArray(proof.items)) return false;
    const record=proof.items.find((item:any)=>item.artifactId === artifact.id && item.targetId === (artifact.assetId || artifact.shotId));
    return Boolean(record && hash(record) === hash(evidence));
  }
  imageCurrent(a: Artifact) {
    return a.kind === "image" && this.project(a.projectId).imageCandidateCurrent?.[a.id] === true;
  }
  selectImage(id: string, baseRevision: number, usage: "preview"|"production") {
    const a=this.artifact(id), p=this.project(a.projectId);
    ensure(a.kind === "image", "需要图片候选");
    ensure(["preview","production"].includes(usage),"图片使用方式无效");
    ensure(p.revision === baseRevision,"内容已更新，请刷新后再保存",409,"revision_conflict");
    ensure(this.imageCurrent(a),"图片属于旧的制作条件，请保留为历史候选",409);
    ensure(usage === "preview" || a.accepted,"只有已批准图片可以作为制作输入",409,"approval_required");
    const file=this.file(a.fileId), binding={artifactId:a.id,fileId:file.id,sha256:file.sha256};
    if (a.assetId) {
      const asset=p.ontology.assets.find(x=>x.id===a.assetId);
      ensure(asset,"图片素材槽不存在",404);
      if (usage === "preview") asset.previewImage=binding;
      else { asset.fileId=file.id; asset.sha256=file.sha256; asset.gap=false; asset.previewImage=binding; }
    } else {
      const shot=p.ontology.shots.find(x=>x.id===a.shotId);
      ensure(shot,"图片所属镜头不存在",404);
      if (usage === "preview") shot.reviewImage=binding;
      else shot.firstFrameImage=binding;
    }
    return this.edit(a.projectId,baseRevision,{ontology:p.ontology});
  }
  /** Adopt an explicitly reviewed display batch without pretending it was regenerated.
   * Only bindings change. Script, asset and post approvals remain bound to their old
   * hashes; the caller must review the resulting production snapshot separately.
   */
  adoptProductionImages(projectId: string, baseRevision: number, key: string, value: unknown) {
    ensure(Array.isArray(value) && value.length > 0 && value.length <= 52, "每次须采用1–52张图片");
    const seen = new Set<string>();
    const items: ProductionImageInput[] = value.map(item => {
      ensure(item && typeof item === "object" && Object.keys(item).every(k => ["artifactId", "sha256"].includes(k)), "制作图片包含未知字段");
      ensure(typeof item.artifactId === "string" && /^[a-f0-9-]{36}$/.test(item.artifactId) && !seen.has(item.artifactId), "图片候选ID无效或重复");
      ensure(typeof item.sha256 === "string" && /^[a-f0-9]{64}$/.test(item.sha256), "图片内容哈希无效");
      seen.add(item.artifactId);
      return {artifactId:item.artifactId,sha256:item.sha256};
    }).sort((a,b)=>a.artifactId.localeCompare(b.artifactId));
    ensure(Number.isInteger(baseRevision) && baseRevision >= 1, "需要有效的baseRevision");
    ensure(typeof key === "string" && key.length >= 8 && key.length <= 128, "需要有效的幂等键");
    const inputHash=hash({kind:"production-image-adoption-v1",baseRevision,items});
    const existing=this.action(projectId,key,inputHash);
    if(existing) return {adoption:existing,project:this.project(projectId)};
    const adoption=this.transaction(()=>{
      const p=this.project(projectId);
      ensure(p.revision === baseRevision,"内容已更新，请刷新后再采用",409,"revision_conflict");
      const ontology=structuredClone(p.ontology), targets=new Set<string>();
      const selected=items.map(item=>{
        const artifact=this.artifact(item.artifactId), file=this.file(artifact.fileId);
        ensure(artifact.projectId === projectId && file.projectId === projectId && artifact.kind === "image","图片不属于此工程",403);
        const targetId=artifact.assetId || artifact.shotId;
        ensure(targetId && !targets.has(targetId),"同一对象只能采用一个候选"); targets.add(targetId);
        ensure(artifact.accepted && p.imageCandidateCurrent?.[artifact.id],"只可采用已通过且当前有效的图片",409,"approval_required");
        ensure(file.sha256 === item.sha256 && sha(this.bytes(file.id)) === item.sha256,"制作图片实际内容哈希不符",409,"image_hash_conflict");
        const binding={artifactId:artifact.id,fileId:file.id,sha256:file.sha256};
        if(artifact.assetId) {
          const asset=ontology.assets.find(a=>a.id===artifact.assetId);
          ensure(asset && ["image","graphic"].includes(asset.kind),"制作资产槽不存在",404);
          ensure(asset.previewImage?.artifactId === artifact.id && asset.previewImage.fileId === file.id && asset.previewImage.sha256 === file.sha256,"请先明确选择当前展示的资产候选",409,"display_image_conflict");
          asset.fileId=file.id; asset.sha256=file.sha256; asset.gap=false;
        } else {
          const shot=ontology.shots.find(s=>s.id===artifact.shotId);
          ensure(shot,"镜头不存在",404);
          ensure(shot.reviewImage?.artifactId === artifact.id && shot.reviewImage.fileId === file.id && shot.reviewImage.sha256 === file.sha256,"请先明确选择当前展示的分镜候选",409,"display_image_conflict");
          shot.firstFrameImage=binding;
        }
        return {artifact,file,targetId};
      });
      ensure(!compileOntology(ontology).issues.some(i=>i.severity === "error"),"本体存在错误，请先修正",422,"ontology_invalid");
      const id=randomUUID(), at=iso(), nextRevision=baseRevision+1, nextHashes=imageTargetHashes(ontology);
      const next={...this.raw(projectId),ontology,revision:nextRevision,updatedAt:at};
      this.db.prepare("UPDATE projects SET revision=?,json=? WHERE id=?").run(nextRevision,JSON.stringify(next),projectId);
      this.db.prepare("INSERT INTO revisions VALUES(?,?,?)").run(projectId,nextRevision,JSON.stringify(next));
      const records=selected.map(({artifact,file,targetId})=>{
        const record={schema:"storyflow-production-adoption-v1",id,at,baseRevision,revision:nextRevision,actionKey:key,actionInputHash:inputHash,
          artifactId:artifact.id,targetId,imageSha256:file.sha256,sourceHash:artifact.sourceHash,
          previousBriefHash:p.imageTargetHashes![targetId],adoptedBriefHash:nextHashes[targetId]};
        artifact.metadata={...artifact.metadata,productionAdoption:record,
          productionAdoptionHistory:[...(Array.isArray(artifact.metadata.productionAdoptionHistory) ? artifact.metadata.productionAdoptionHistory : []),record]};
        this.db.prepare("UPDATE artifacts SET json=? WHERE id=?").run(JSON.stringify(artifact),artifact.id);
        return record;
      });
      const result={schema:"storyflow-production-adoption-v1",id,baseRevision,revision:nextRevision,createdAt:at,items:records};
      this.recordAction(projectId,key,inputHash,result);
      const current=this.project(projectId);
      ensure(selected.every(({artifact})=>current.imageCandidateCurrent?.[artifact.id]),"父图或角色基准不匹配，整批未采用",409,"adoption_lineage_conflict");
      return result;
    });
    return {adoption,project:this.project(projectId)};
  }
  /** Explicit review of the same already-adopted bytes. The default scope requires
   * unchanged ontology. The opt-in upstream-edit scope additionally proves the
   * target's own inputs and previously recorded lineage remain unchanged. Neither
   * scope accepts imported historical authority or replaces the generation hash.
   */
  requalifyProductionImages(projectId: string, baseRevision: number, key: string, value: unknown,
    scope: ImageRequalificationRecord["scope"] = "unchanged-ontology-compiler-review") {
    ensure(["unchanged-ontology-compiler-review","explicit-review-of-unchanged-shot-inputs"].includes(scope),"图片复核作用域无效");
    ensure(Array.isArray(value) && value.length > 0 && value.length <= 52,"每次须复核1–52张已采用分镜图");
    const seen=new Set<string>();
    const items:ImageRequalificationInput[]=value.map(item=>{
      ensure(item && typeof item === "object" && Object.keys(item).every(k=>["artifactId","sha256","oldBriefHash","newBriefHash","note"].includes(k)),"图片复核包含未知字段");
      ensure(typeof item.artifactId === "string" && /^[a-f0-9-]{36}$/.test(item.artifactId) && !seen.has(item.artifactId),"图片候选ID无效或重复");seen.add(item.artifactId);
      for(const field of ["sha256","oldBriefHash","newBriefHash"]) ensure(typeof item[field] === "string" && /^[a-f0-9]{64}$/.test(item[field]),"图片或制作条件哈希无效");
      ensure(typeof item.note === "string" && item.note.trim().length > 0 && item.note.length <= 10000,"需要明确的图片复用核对意见");
      return {artifactId:item.artifactId,sha256:item.sha256,oldBriefHash:item.oldBriefHash,newBriefHash:item.newBriefHash,note:item.note.trim()};
    }).sort((a,b)=>a.artifactId.localeCompare(b.artifactId));
    ensure(Number.isInteger(baseRevision) && baseRevision >= 1,"需要有效的baseRevision");
    ensure(typeof key === "string" && key.length >= 8 && key.length <= 128,"需要有效的幂等键");
    const inputHash=hash({kind:"image-requalification-v1",baseRevision,items,
      ...(scope === "unchanged-ontology-compiler-review" ? {} : {scope})});
    const prior=this.action(projectId,key,inputHash);
    if(prior) return {requalification:prior,project:this.project(projectId)};
    const requalification=this.transaction(()=>{
      const p=this.project(projectId), ontologyHash=hash(p.ontology);
      ensure(p.revision === baseRevision,"内容已更新，请刷新后复核",409,"revision_conflict");
      if(scope === "explicit-review-of-unchanged-shot-inputs")
        ensure(!p.compiled.issues.some(issue=>issue.severity === "error"),"本体存在错误，请先修正",422,"ontology_invalid");
      const selected=items.map(item=>{
        const a=this.artifact(item.artifactId),f=this.file(a.fileId),adoption=a.metadata.productionAdoption as any;
        ensure(a.projectId === projectId && f.projectId === projectId && a.kind === "image" && a.shotId && !a.assetId,"只可复核本工程已采用的分镜图",403);
        ensure(a.accepted,"已撤回的图片不能复用",409,"approval_required");
        ensure(!p.imageCandidateCurrent?.[a.id],"当前有效图片无需重新认定",409,"already_current");
        ensure(this.trustedImageAction(projectId,a,adoption,"storyflow-production-adoption-v1"),"缺少本工程的原始批准采用记录，导入的历史记录不能授权复用",409,"requalification_proof_required");
        ensure(adoption.sourceHash === a.sourceHash && adoption.imageSha256 === item.sha256 && adoption.adoptedBriefHash === item.oldBriefHash,"原始采用条件不匹配",409,"requalification_snapshot_conflict");
        ensure(p.imageTargetHashes?.[a.shotId!] === item.newBriefHash && item.oldBriefHash !== item.newBriefHash,"当前制作条件已变化，请重新核对",409,"requalification_snapshot_conflict");
        const approvedRevision=this.revision(projectId,adoption.revision);
        let inputBasis: ImageRequalificationRecord["inputBasis"], previousQualification: ImageRequalificationRecord | undefined;
        if(scope === "unchanged-ontology-compiler-review") {
          ensure(hash(approvedRevision.ontology) === ontologyHash,"本体内容已变化；本接口只允许同一本体在编译修复后的明确复核",409,"requalification_content_changed");
        } else {
          previousQualification=a.metadata.imageRequalification as ImageRequalificationRecord | undefined;
          ensure(this.trustedImageAction(projectId,a,previousQualification,"storyflow-image-requalification-v1") &&
            previousQualification?.sourceHash === a.sourceHash && previousQualification.sha256 === item.sha256 &&
            previousQualification.lineageHash === hash(this.imageLineage(a)) &&
            hash(previousQualification.originalAdoption) === hash(adoption),
            "缺少原引用条件的本地复核证明，或真实父图条件已变化",409,"requalification_lineage_conflict");
          const before=shotImageInputBasis(approvedRevision.ontology,a.shotId!),after=shotImageInputBasis(p.ontology,a.shotId!);
          ensure(hash(before) === hash(after),"当前镜头自身、实体、素材、身份或直接依赖已变化，不能沿用上游变更复核",409,"requalification_content_changed");
          inputBasis={sourceRevision:adoption.revision,before,after};
        }
        const shot=p.ontology.shots.find(s=>s.id===a.shotId);
        ensure([shot?.reviewImage,shot?.firstFrameImage].every(b=>b?.artifactId===a.id && b.fileId===f.id && b.sha256===item.sha256),"展示图或首帧绑定已变化",409,"requalification_binding_changed");
        ensure(f.sha256===item.sha256 && sha(this.bytes(f.id))===item.sha256,"图片实际内容哈希不符",409,"image_hash_conflict");
        const lineage=this.imageLineage(a);
        for(const parent of [...(lineage.parentAssets as any[]),...(lineage.parentShots as any[])]) {
          ensure(typeof parent.fileId === "string" && typeof parent.sha256 === "string","父图缺少可核验文件记录",409,"requalification_lineage_conflict");
          const file=this.file(parent.fileId);
          ensure(file.projectId===projectId && file.sha256===parent.sha256 && sha(this.bytes(file.id))===parent.sha256,"父图实际内容哈希不符",409,"requalification_lineage_conflict");
        }
        return {item,a,adoption,lineage,inputBasis,previousQualification};
      });
      const id=randomUUID(),at=iso(),nextRevision=baseRevision+1;
      const records:ImageRequalificationRecord[]=selected.map(({item,a,adoption,lineage,inputBasis,previousQualification})=>({
        ...item,schema:"storyflow-image-requalification-v1",scope,id,at,
        baseRevision,revision:nextRevision,actionKey:key,actionInputHash:inputHash,targetId:a.shotId!,sourceHash:a.sourceHash,ontologyHash,
        originalAdoption:structuredClone(adoption),originalApproval:{accepted:true,reviewedAt:a.metadata.reviewedAt ?? null,reviewNote:a.metadata.reviewNote ?? null},
        lineage:structuredClone(lineage),lineageHash:hash(lineage),
        ...(inputBasis ? {inputBasis,previousQualification:structuredClone(previousQualification!)} : {}),
      }));
      for(const [index,{a}] of selected.entries()) {
        a.metadata={...a.metadata,imageRequalification:records[index],imageRequalificationHistory:[...(Array.isArray(a.metadata.imageRequalificationHistory)?a.metadata.imageRequalificationHistory:[]),records[index]]};
        this.db.prepare("UPDATE artifacts SET json=? WHERE id=?").run(JSON.stringify(a),a.id);
      }
      const next={...this.raw(projectId),revision:nextRevision,updatedAt:at};
      this.db.prepare("UPDATE projects SET revision=?,json=? WHERE id=?").run(nextRevision,JSON.stringify(next),projectId);
      this.db.prepare("INSERT INTO revisions VALUES(?,?,?)").run(projectId,nextRevision,JSON.stringify(next));
      const result={schema:"storyflow-image-requalification-v1",id,baseRevision,revision:nextRevision,createdAt:at,items:records};
      this.recordAction(projectId,key,inputHash,result);
      const current=this.project(projectId);
      ensure(selected.every(({a})=>current.imageCandidateCurrent?.[a.id]),"父图或身份批准已变化，整批未复用",409,"requalification_lineage_conflict");
      return result;
    });
    return {requalification,project:this.project(projectId)};
  }
  reviewArtifact(id: string, accepted: boolean, note = "") {
    const a = this.artifact(id);
    if (accepted && a.kind === "image")
      ensure(this.imageCurrent(a),"图片属于旧的制作条件，请保留为历史候选",409);
    if (accepted && a.shotId && !["final", "image"].includes(a.kind))
      ensure(
        a.sourceHash ===
          this.project(a.projectId).compiled.shotHashes[a.shotId],
        "产物属于旧的生成版本，请保留为历史候选",
        409,
      );
    if (accepted && a.kind === "lipsync") {
      ensure(
        this.artifacts(a.projectId).some(
          (v) =>
            v.kind === "voice" &&
            v.shotId === a.shotId &&
            v.fileId === a.audioFileId &&
            v.accepted &&
            v.sourceHash === a.sourceHash &&
            this.file(v.fileId).sha256 === a.audioHash,
        ),
        "绑定声音已更换或撤回，请使用当前已审音轨重做口型",
        409,
      );
    }
    if (a.kind === "voice") {
      this.transaction(() => {
        for (const other of this.artifacts(a.projectId)) {
          if (other.shotId !== a.shotId || other.id === a.id) continue;
          if (
            (accepted && other.kind === "voice") ||
            (other.kind === "lipsync" &&
              (accepted
                ? other.audioHash !== this.file(a.fileId).sha256
                : other.audioFileId === a.fileId))
          ) {
            other.accepted = false;
            other.metadata = {
              ...other.metadata,
              invalidationReason: "voice_replaced",
            };
            this.db
              .prepare("UPDATE artifacts SET json=? WHERE id=?")
              .run(JSON.stringify(other), other.id);
          }
        }
      });
    }
    const writeReview=() => {
    if(a.kind === "image" && accepted && a.assetId && this.raw(a.projectId).ontology.imageConsistency?.characters?.some((profile:any)=>profile.identityAssetId===a.assetId)) {
      for(const other of this.artifacts(a.projectId)) if(other.id!==a.id && other.kind === "image" && other.assetId===a.assetId && other.accepted) {
        other.accepted=false;
        other.metadata={...other.metadata,reviewStatus:"historical",invalidationReason:"identity_replaced",replacedBy:a.id};
        this.db.prepare("UPDATE artifacts SET json=? WHERE id=?").run(JSON.stringify(other),other.id);
      }
    }
    a.accepted = accepted;
    a.metadata = { ...a.metadata, reviewNote: note, reviewedAt: iso(), ...(a.kind === "image" ? {reviewStatus:accepted ? "pass" : "change"} : {}) };
    this.db
      .prepare("UPDATE artifacts SET json=? WHERE id=?")
      .run(JSON.stringify(a), id);
    return a;
    };
    if(a.kind !== "image") return writeReview();
    // SAVEPOINT is atomic both for the legacy single-artifact API and inside a batch submission.
    this.db.exec("SAVEPOINT image_artifact_review");
    try {
      const result=writeReview();
      this.db.exec("RELEASE SAVEPOINT image_artifact_review");
      return result;
    } catch(error) {
      this.db.exec("ROLLBACK TO SAVEPOINT image_artifact_review");
      this.db.exec("RELEASE SAVEPOINT image_artifact_review");
      throw error;
    }
  }
  select(id: string, sourceInSeconds = 0) {
    const a = this.artifact(id),
      p = this.project(a.projectId);
    ensure(
      a.accepted && !["voice", "final", "image"].includes(a.kind) && a.shotId,
      "请先审核当前镜头产物",
    );
    ensure(
      a.sourceHash === p.compiled.shotHashes[a.shotId!],
      "产物属于旧的生成版本，请重新审核制作",
      409,
    );
    ensure(
      Number.isFinite(sourceInSeconds) && sourceInSeconds >= 0,
      "入点无效",
    );
    const selection = {
      shotId: a.shotId,
      artifactId: id,
      sourceInSeconds,
      sourceHash: a.sourceHash,
    };
    this.db
      .prepare("INSERT OR REPLACE INTO selections VALUES(?,?,?)")
      .run(a.projectId, a.shotId!, JSON.stringify(selection));
    return this.project(a.projectId);
  }
  selections(id: string): any[] {
    return this.db
      .prepare("SELECT json FROM selections WHERE project_id=?")
      .all(id)
      .map((r: any) => parse(r.json));
  }
  checkpoint() {
    this.db.exec("PRAGMA wal_checkpoint(FULL)");
  }
}
