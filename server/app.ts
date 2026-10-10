import express from "express";
import multer from "multer";
import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { resolve, basename } from "node:path";
import { randomUUID } from "node:crypto";
import type { Ontology, Requirements } from "../shared/types.ts";
import {
  compileOntology,
  createEmptyOntology,
  validateOntology,
  hash,
} from "../shared/ontology.ts";
import { Store } from "./store.ts";
import { submitReviews } from "./review-submissions.ts";
import { mountPublicReviewRoutes } from "./public-review-router.ts";
import { validateDraft } from "./validation.ts";
import { Jobs } from "./jobs.ts";
import { ingest } from "./ingest.ts";
import { searchReferences, publicURL } from "./references.ts";
import { exportProject, importProject, readOnlyReviewHtml } from "./archive.ts";
import { loadExampleAssets } from "./template.ts";
import { probe } from "./media.ts";
import { exportReviewSnapshot, publicReviewCsp } from "./public-review.ts";
import { ensure, AppError, boundedText, cleanError, sha } from "./util.ts";

const root = fileURLToPath(new URL("../", import.meta.url));
const defaults: Requirements = {
  topic: "",
  audience: "普通公众",
  duration: 60,
  aspect: "9:16",
  fps: 25,
  style: "故事化医学科普",
  doctorMode: "fictional",
  sound: "原生声音，不默认添加旁白",
  brief: "",
};
function requirements(value: any): Requirements {
  const r = { ...defaults, ...value };
  for (const k of ["topic", "audience", "style", "sound", "brief"])
    boundedText(r[k], k === "brief" ? 30000 : 2000);
  ensure(
    Number.isInteger(r.duration) && r.duration > 0 && r.duration <= 3600,
    "时长须为1–3600整数秒",
  );
  ensure([24, 25].includes(r.fps), "帧率只支持24或25");
  ensure(["9:16", "16:9"].includes(r.aspect), "画幅无效");
  ensure(["fictional", "photo"].includes(r.doctorMode), "医生方式无效");
  return Object.fromEntries(
    Object.keys(defaults).map((k) => [k, r[k]]),
  ) as unknown as Requirements;
}
const revision = (v: any) => {
  ensure(Number.isInteger(v) && v >= 1, "需要有效的baseRevision");
  return Number(v);
};
const key = (v: any) => {
  ensure(
    typeof v === "string" && v.length >= 8 && v.length <= 200,
    "需要8–200字符幂等键",
  );
  return v;
};
const reviewStatus = (v: any) => {
  ensure(["pending", "pass", "change"].includes(v), "审核状态无效");
  return v as "pending" | "pass" | "change";
};
function token(req: express.Request) {
  return (
    String(req.headers.cookie || "")
      .split(";")
      .map((x) => x.trim())
      .find((x) => x.startsWith("storyflow="))
      ?.slice(10) || ""
  );
}

export function createApp(
  store: Store,
  jobs: Jobs,
  options: {
    publicBaseUrl?: string;
    publicReviewProjectIds?: string[];
    publicReviewApiBase?: string;
    dist?: string;
    search?: typeof searchReferences;
  } = {},
) {
  const app = express();
  app.disable("x-powered-by");
  app.set("trust proxy", "loopback");
  const canonical = new URL(options.publicBaseUrl || "http://127.0.0.1:18296");
  app.use((req, res, next) => {
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Referrer-Policy", "same-origin");
    res.setHeader("X-Frame-Options", "DENY");
    if (req.path.startsWith("/api")) res.setHeader("Cache-Control", "no-store");
    next();
  });
  app.use(express.json({ limit: "5mb" }));
  app.get("/healthz", (_req, res) =>
    res.json({ ok: true, service: "storyflow", version: "0.3.2" }),
  );
  app.use("/api", (req, _res, next) => {
    if (!["GET", "HEAD", "OPTIONS"].includes(req.method)) {
      const origin = req.get("origin");
      const localOrigin = `${req.protocol}://${req.get("host")}`;
      if (
        origin &&
        origin !== canonical.origin &&
        origin !== localOrigin &&
        !(
          canonical.protocol === "http:" &&
          /^http:\/\/(127\.0\.0\.1|localhost):18297$/.test(origin)
        )
      )
        return next(
          new AppError("不接受其他网站提交的请求", 403, "origin_forbidden"),
        );
      if (req.get("sec-fetch-site") === "cross-site")
        return next(new AppError("不接受跨站请求", 403, "origin_forbidden"));
    }
    next();
  });
  const setCookie = (res: express.Response, value: string) =>
    res.cookie("storyflow", value, {
      httpOnly: true,
      sameSite: "strict",
      secure: canonical.protocol === "https:",
      path: "/",
      maxAge: 7 * 86400000,
    });
  const attempts = new Map<string, { count: number; until: number }>();
  app.get("/api/auth", (req, res) =>
    res.json({
      setupRequired: !store.hasPassword(),
      authenticated: store.authenticated(token(req)),
    }),
  );
  app.post("/api/auth/:action", (req, res) => {
    const action = req.params.action;
    ensure(["setup", "login", "logout"].includes(action), "接口不存在", 404);
    if (action === "logout") {
      store.logout(token(req));
      res.clearCookie("storyflow", { path: "/" });
      res.json({ ok: true });
      return;
    }
    const ip = req.ip || "local",
      last = attempts.get(ip);
    ensure(
      !last || last.until < Date.now() || last.count < 10,
      "尝试过多，请15分钟后再试",
      429,
    );
    const password = boundedText(req.body.password, 256);
    if (action === "setup") store.setPassword(password);
    else if (!store.verifyPassword(password)) {
      attempts.set(ip, {
        count: last && last.until > Date.now() ? last.count + 1 : 1,
        until: Date.now() + 900000,
      });
      throw new AppError("密码错误", 401, "authentication_failed");
    }
    attempts.delete(ip);
    setCookie(res, store.session());
    res.json({ authenticated: true, setupRequired: false });
  });
  mountPublicReviewRoutes(app, store, { projectIds: options.publicReviewProjectIds, apiBase: options.publicReviewApiBase });
  app.use("/api", (req, _res, next) => {
    if (!store.authenticated(token(req)))
      return next(new AppError("请先登录管理员", 401, "login_required"));
    next();
  });
  app.get("/api/config", (_req, res) => {
    const c = jobs.providers.capabilities();
    res.json({
      version: "0.3.1",
      publicBaseUrl: canonical.href,
      capabilities: {
        image: {
          configured:c.image?.available || false,
          model:c.image?.model || "gpt-image-2",
          reason:c.image?.available ? undefined : "尚未配置图片接口与密钥",
          maxBatch:52,
        },
        seedance: {
          configured: c.seedance.available,
          model: c.seedance.model,
          reason: c.seedance.available
            ? undefined
            : "尚未配置 Seedance 接口与密钥",
          firstFrameOnly: true,
          maxSeconds: 12,
        },
        fal: {
          configured: c.lipsync.available,
          model: c.lipsync.model,
          reason: c.lipsync.reason,
        },
        opus: {
          configured: c.opus.available,
          model: c.opus.model,
          reason: c.opus.available ? undefined : "尚未配置 Opus 接口与密钥",
        },
        media: {
          configured: true,
          model: "Chromium + FFmpeg",
          reason: "需通过 npm run doctor 检查本机依赖",
        },
      },
    });
  });
  app.get("/api/projects", (_req, res) => res.json(store.list()));
  app.post("/api/projects", (req, res) => {
    const r = requirements(req.body.requirements),
      name = boundedText(req.body.name || r.topic || "未命名工程", 200);
    let ontology = createEmptyOntology(name, r);
    if (req.body.template) {
      ensure(req.body.template === "lupus-v6", "模板不存在", 404);
      ontology = JSON.parse(
        readFileSync(resolve(root, "examples/lupus-v6.json"), "utf8"),
      );
    }
    let p = store.create(name, r, ontology);
    if (req.body.template) {
      loadExampleAssets(store,p,ontology);
      p = store.edit(p.id, p.revision, {
        ontology,
        requirements: {
          ...r,
          topic: r.topic || ontology.title,
          duration: 60,
          fps: 25,
          aspect: "9:16",
          doctorMode: "photo",
        },
      });
    }
    res.status(201).json(p);
  });
  app.get("/api/projects/:id", (req, res) =>
    res.json(store.project(String(req.params.id))),
  );
  app.patch("/api/projects/:id", (req, res) => {
    const id = String(req.params.id),
      patch: any = {};
    if (req.body.name !== undefined)
      patch.name = boundedText(req.body.name, 200);
    if (req.body.requirements !== undefined)
      patch.requirements = requirements(req.body.requirements);
    if (req.body.ontology !== undefined)
      patch.ontology = validateDraft(req.body.ontology, store, id);
    ensure(Object.keys(patch).length, "没有修改内容");
    res.json(store.edit(id, revision(req.body.baseRevision), patch));
  });
  app.get("/api/projects/:id/revisions", (req, res) =>
    res.json(store.revisions(String(req.params.id))),
  );
  app.get("/api/projects/:id/revisions/:revision", (req, res) =>
    res.json(
      store.revision(
        String(req.params.id),
        revision(Number(req.params.revision)),
      ),
    ),
  );
  app.post("/api/projects/:id/compile", (req, res) =>
    res.json(store.project(String(req.params.id)).compiled),
  );
  app.post("/api/projects/:id/assets/bind", (req, res) =>
    res.json(
      store.bind(
        String(req.params.id),
        revision(req.body.baseRevision),
        boundedText(req.body.assetId, 128),
        boundedText(req.body.fileId, 128),
      ),
    ),
  );
  app.post("/api/projects/:id/production-images/adopt", (req, res) =>
    res.json(store.adoptProductionImages(String(req.params.id), revision(req.body.baseRevision), key(req.body.idempotencyKey), req.body.items)),
  );
  app.put("/api/projects/:id/reviews", (req, res) => {
    const id = String(req.params.id),
      target = boundedText(req.body.targetId, 128),
      status = reviewStatus(req.body.status),
      p = store.project(id);
    if (req.body.targetHash !== undefined)
      ensure(
        p.compiled.targetHashes[target] === req.body.targetHash,
        "审核对象已经变化，请刷新后审核",
        409,
      );
    if (status === "pass") {
      ensure(
        !p.compiled.issues.some((i) => i.severity === "error"),
        "请先修正本体错误再批准",
        422,
      );
      const a = p.ontology.assets.find((a) => a.id === target);
      if (a) ensure(!a.gap && a.fileId, "缺失素材不能批准", 409);
    }
    res.json(
      store.review(id, target, status, boundedText(req.body.note || "", 10000)),
    );
  });
  app.post("/api/projects/:id/review-submissions", (req, res) => {
    const result = submitReviews(store, jobs, String(req.params.id), revision(req.body.baseRevision), key(req.body.idempotencyKey), req.body.items);
    res.status(result.jobs.length ? 202 : 200).json(result);
  });
  app.get("/api/projects/:id/review-submissions", (req, res) => res.json({ submissions: store.reviewSubmissions(String(req.params.id)) }));
  app.post("/api/projects/:id/reviews/import", (req, res) => {
    const id = String(req.params.id),
      p = store.project(id),
      data = req.body;
    ensure(
      Array.isArray(data.items) && data.items.length <= 1000,
      "需要审核items数组",
    );
    if(data.schema === "storyflow-review-draft") {
      const digest=(v:any,label:string)=>{ensure(v === undefined || (typeof v === "string" && /^[a-f0-9]{64}$/.test(v)),`${label}须为SHA-256`);return v as string|undefined;};
      const sourceProjectId=data.projectId === undefined ? undefined : boundedText(data.projectId,128);
      const sourceRevision=data.revision === undefined ? undefined : revision(data.revision);
      const snapshotHash=digest(data.scriptSha256,"快照哈希");
      const importedItems=data.items.map((v:any)=>{
        const targetId=boundedText(v.targetId || v.id,128);
        ensure(/^[A-Za-z0-9][A-Za-z0-9_.:-]*$/.test(targetId),"意见对象ID无效");
        const targetHash=digest(v.targetHash || undefined,"对象哈希"),imageSha256=digest(v.imageSha256,"图片哈希");
        const asset=p.ontology.assets.find(a=>a.id===targetId),shot=p.ontology.shots.find(s=>s.id===targetId);
        const selected=asset?.previewImage || shot?.reviewImage || asset;
        const sameImage=imageSha256 ? selected?.sha256===imageSha256 : !selected?.sha256;
        const match=targetHash === p.compiled.targetHashes[targetId] && sameImage ? "current" : imageSha256 && p.artifacts.some(a=>a.kind === "image" && (a.assetId || a.shotId)===targetId && store.file(a.fileId).sha256===imageSha256) ? "image-only" : "historical";
        return {targetId,note:boundedText(v.note || v.comment || "",10000),imported:{sourceProjectId,sourceRevision,snapshotHash,targetHash,imageSha256,imageId:v.imageId===undefined?undefined:boundedText(v.imageId,128),originalStatus:reviewStatus(v.status),match}};
      });
      const overall=boundedText(data.overall || "",10000);
      store.transaction(()=>{
        for(const item of importedItems) store.importOpinion(id,item.targetId,item.note,item.imported);
        if(overall) store.importOpinion(id,"post",overall,{sourceProjectId,sourceRevision,snapshotHash,originalStatus:"pending",match:"historical"});
      });
      res.json(store.project(id));return;
    }
    let snapshot = p.ontology;
    if (data.revision !== undefined)
      snapshot = store.revision(id, revision(data.revision)).ontology;
    const compiled = compileOntology(snapshot);
    ensure(
      !data.scriptSha256 || data.scriptSha256 === compiled.hash,
      "意见文件的脚本哈希不匹配",
      409,
    );
    const items = data.items.map((v: any) => {
      const target = boundedText(v.targetId || v.id, 128);
      ensure(compiled.targetHashes[target], "意见对象不属于该修订");
      return {
        target,
        status: reviewStatus(v.status),
        note: boundedText(v.note || v.comment || "", 10000),
        targetHash: compiled.targetHashes[target],
      };
    });
    // Imported passes are opinions, not an alternate path around the live approval gate.
    for (const v of items)
      store.review(
        id,
        v.target,
        v.status === "pass" ? "pending" : v.status,
        `[导入意见${v.status === "pass" ? "：建议通过，待管理员确认" : ""}] ${v.note}`,
        v.targetHash,
      );
    res.json(store.project(id));
  });
  for (const kind of ["expand", "post-plan"] as const)
    app.post(`/api/projects/:id/${kind}`, (req, res) =>
      res
        .status(202)
        .json(
          jobs.enqueueText(
            String(req.params.id),
            kind,
            revision(req.body.baseRevision),
            key(req.body.idempotencyKey),
          ),
        ),
    );
  app.post("/api/projects/:id/image-generations", (req,res)=>
    res.status(202).json(jobs.enqueueImages(String(req.params.id),revision(req.body.baseRevision),key(req.body.idempotencyKey),req.body.targets)));
  app.post("/api/projects/:id/runs", (req, res) => {
    if (req.body.shotIds !== undefined)
      ensure(
        Array.isArray(req.body.shotIds) &&
          req.body.shotIds.every((x: any) => typeof x === "string"),
        "镜头列表无效",
      );
    res
      .status(202)
      .json(
        jobs.enqueueRun(
          String(req.params.id),
          revision(req.body.baseRevision),
          key(req.body.idempotencyKey),
          req.body.shotIds,
        ),
      );
  });
  app.post("/api/projects/:id/compose", (req, res) =>
    res
      .status(202)
      .json(
        jobs.enqueueCompose(
          String(req.params.id),
          revision(req.body.baseRevision),
          key(req.body.idempotencyKey),
        ),
      ),
  );
  app.get("/api/jobs/:id", (req, res) =>
    res.json(store.job(String(req.params.id))),
  );
  app.post("/api/jobs/:id/cancel", (req, res) =>
    res.json(jobs.cancel(String(req.params.id))),
  );
  app.post("/api/jobs/:id/retry", (req, res) =>
    res
      .status(202)
      .json(jobs.retry(String(req.params.id), key(req.body.idempotencyKey))),
  );
  app.post("/api/jobs/:id/reconcile", (req, res) =>
    res.json(
      jobs.reconcile(
        String(req.params.id),
        boundedText(req.body.providerTaskId, 200),
      ),
    ),
  );
  app.post("/api/jobs/:id/apply", (req, res) =>
    res.json(
      jobs.apply(String(req.params.id), revision(req.body.baseRevision)),
    ),
  );
  app.post("/api/artifacts/:id/review", (req, res) => {
    ensure(typeof req.body.accepted === "boolean", "需要accepted状态");
    const a = store.reviewArtifact(
      String(req.params.id),
      req.body.accepted,
      boundedText(req.body.note || "", 10000),
    );
    void jobs.tick();
    res.json(store.project(a.projectId));
  });
  app.post("/api/artifacts/:id/select", (req, res) => {
    const id=String(req.params.id), artifact=store.artifact(id);
    res.json(artifact.kind === "image" ? store.selectImage(id,revision(req.body.baseRevision),req.body.usage) : store.select(id,req.body.sourceInSeconds || 0));
  });
  app.post("/api/projects/:id/artifacts/import", async (req, res) => {
    const id = String(req.params.id),
      p = store.project(id),
      shot = p.ontology.shots.find((s) => s.id === req.body.shotId);
    ensure(shot, "镜头不存在", 404);
    const file = store.file(boundedText(req.body.fileId, 128));
    ensure(file.projectId === id, "素材不属于此工程", 403);
    const kind = req.body.kind;
    ensure(
      ["video", "voice", "lipsync", "graphic"].includes(kind),
      "产物类型无效",
    );
    ensure(
      file.mime.startsWith(kind === "voice" ? "audio/" : "video/"),
      "素材媒体类型不符",
    );
    let audio;
    if (kind === "lipsync") {
      audio = store.file(boundedText(req.body.audioFileId, 128));
      ensure(
        audio.projectId === id && audio.mime.startsWith("audio/"),
        "需要本工程的同一驱动音轨",
      );
      ensure(
        p.artifacts.some(
          (a) =>
            a.kind === "voice" &&
            a.shotId === shot.id &&
            a.fileId === audio!.id &&
            a.accepted &&
            a.sourceHash === p.compiled.shotHashes[shot.id],
        ),
        "请先导入并审核对应镜头的驱动声音",
        409,
      );
    }
    const info = await probe(store.filePath(file.id));
    store.addArtifact({
      projectId: id,
      jobId: `import-${randomUUID()}`,
      shotId: shot.id,
      kind,
      fileId: file.id,
      sourceHash: p.compiled.shotHashes[shot.id],
      audioFileId: audio?.id,
      audioHash: audio?.sha256,
      metadata: {
        ...info,
        origin: "manual-import",
        identityAndLipSync: "requires-human-review",
      },
    });
    res.status(201).json(store.project(id));
  });
  const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 50 * 1024 * 1024, files: 20, fields: 5 },
  });
  app.post(
    "/api/projects/:id/files",
    upload.array("files", 20),
    async (req, res) => {
      const id = String(req.params.id);
      store.raw(id);
      const result = [];
      for (const f of (req.files as Express.Multer.File[]) || [])
        result.push(
          ...(await ingest(
            store,
            id,
            Buffer.from(f.originalname, "latin1").toString("utf8"),
            f.buffer,
          )),
        );
      ensure(result.length, "请选择文件");
      res.status(201).json(result);
    },
  );
  app.get("/api/files/:id", (req, res) => {
    const f = store.file(String(req.params.id));
    res.setHeader("Content-Type", f.mime);
    res.setHeader("Content-Security-Policy", "default-src 'none'; sandbox");
    if (
      req.query.download ||
      !/^image\/(png|jpeg|gif|webp)$|^video\/mp4$|^audio\//.test(f.mime)
    )
      res.attachment(f.name);
    res.sendFile(store.filePath(f.id), {
      acceptRanges: true,
      cacheControl: false,
    });
  });
  app.get("/api/projects/:id/export", async (req, res) => {
    const zip = await exportProject(store, String(req.params.id));
    res.type("application/zip").attachment("storyflow-project.zip").send(zip);
  });
  app.get("/api/projects/:id/review.html", (req, res) => {
    res.setHeader(
      "Content-Security-Policy",
      publicReviewCsp(),
    );
    res
      .type("html")
      .send(readOnlyReviewHtml(store.project(String(req.params.id))));
  });
  app.get("/api/projects/:id/review-snapshot", async (req, res) => {
    const zip = await exportReviewSnapshot(store, String(req.params.id));
    res.type("application/zip").attachment("storyflow-review-snapshot.zip").send(zip);
  });
  const importUpload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 300 * 1024 * 1024, files: 1, fields: 1 },
  });
  app.post("/api/import", importUpload.single("file"), async (req, res) => {
    ensure(req.file, "需要工程ZIP");
    res.status(201).json(await importProject(store, req.file.buffer));
  });
  app.get("/api/references/search", async (req, res) =>
    res.json(
      await (options.search || searchReferences)(
        String(req.query.q || ""),
        String(req.query.source || "commons"),
      ),
    ),
  );
  app.post("/api/projects/:id/references", (req, res) => {
    const id = String(req.params.id),
      p = store.project(id),
      item = req.body.item;
    ensure(item && typeof item === "object", "参考条目无效");
    const url = publicURL(item.url);
    ensure(url, "缺少来源链接");
    const label = boundedText(item.title, 500),
      rid = `ref-${randomUUID()}`;
    if (item.use === "evidence" || String(item.id).startsWith("pubmed-"))
      p.ontology.evidence.push({
        id: rid,
        title: label,
        url,
        excerpt: boundedText(item.excerpt || "待人工阅读与摘录依据", 16000),
      });
    else
      p.ontology.assets.push({
        id: rid,
        label,
        kind: "image",
        purpose: "reference",
        gap: true,
        source: {
          url,
          author: boundedText(item.author || "", 1000),
          license: boundedText(item.license || "待核对许可", 1000),
          use: "检索参考，下载并绑定后仍需审核；不代表可直接用于成片",
        },
      });
    res.json(
      store.edit(id, revision(req.body.baseRevision), { ontology: p.ontology }),
    );
  });
  app.use("/api", (_req, _res, next) => next(new AppError("接口不存在", 404)));
  const dist = options.dist || resolve(root, "dist");
  if (existsSync(dist)) {
    app.use(express.static(dist, { index: false }));
    app.get("/{*path}", (_req, res) =>
      res.sendFile(resolve(dist, "index.html")),
    );
  }
  app.use(
    (
      error: any,
      _req: express.Request,
      res: express.Response,
      _next: express.NextFunction,
    ) => {
      if (res.headersSent) return;
      const status =
        error instanceof AppError
          ? error.status
          : error?.code === "LIMIT_FILE_SIZE"
            ? 413
            : Number.isInteger(error?.status) &&
                error.status >= 400 &&
                error.status < 600
              ? error.status
              : 500;
      res
        .status(status)
        .json({
          error: cleanError(error),
          code: error.code || "internal_error",
          issues: error.issues,
        });
    },
  );
  return app;
}
