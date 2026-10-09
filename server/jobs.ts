import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type {
  Job,
  Project,
  Artifact,
  VideoInput,
  Ontology,
} from "../shared/types.ts";
import { compileOntology, hash } from "../shared/ontology.ts";
import { Store } from "./store.ts";
import { validateDraft } from "./validation.ts";
import { ensure, cleanError } from "./util.ts";
import { Providers } from "./providers.ts";
import * as media from "./media.ts";

export class Jobs {
  busy = false;
  timer: ReturnType<typeof setInterval> | undefined;
  stopped = false;
  constructor(
    public store: Store,
    public providers: Providers,
    public mediaEngine: typeof media = media,
  ) {}
  recover() {
    for (const job of this.store.jobs()) {
      if (job.state !== "running") continue;
      if (job.stage === "submitting" && !job.handle) {
        this.store.updateJob(job.id, {
          state: "uncertain",
          stage: "acceptance_unknown",
          error: "提交受理状态不明；先核对供应商原任务，禁止自动重投。",
        });
      } else
        this.store.updateJob(job.id, {
          state: "queued",
          stage: job.handle ? "polling" : "queued",
        });
    }
  }
  start() {
    this.recover();
    this.stopped = false;
    this.timer = setInterval(() => void this.tick(), 1500);
    this.timer.unref();
    void this.tick();
  }
  stop() {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
  }
  enqueueText(
    projectId: string,
    kind: "expand" | "post-plan",
    baseRevision: number,
    key: string,
  ) {
    const p = this.store.project(projectId);
    const input = {
      baseRevision,
      requirements: p.requirements,
      ontology: p.ontology,
      documents: p.files
        .filter((f) => f.text)
        .map((f) => ({
          id: f.id,
          name: f.name,
          text: f.text!.slice(0, 30000),
        })),
    };
    const ih = hash({ kind, input });
    const prior = this.store.action(projectId, key, ih);
    if (prior) return this.store.job(prior.id);
    ensure(p.revision === baseRevision, "工程版本已经变化", 409);
    const job = this.store.transaction(() => {
      const j = this.store.addJob({
        projectId,
        runId: randomUUID(),
        kind,
        dependsOn: [],
        inputHash: ih,
        input,
      });
      this.store.recordAction(projectId, key, ih, { id: j.id });
      return j;
    });
    void this.tick();
    return job;
  }
  enqueueRun(
    projectId: string,
    baseRevision: number,
    key: string,
    shotIds?: string[],
  ) {
    const p = this.store.project(projectId),
      c = p.compiled;
    const selected = shotIds || p.ontology.shots.map((s) => s.id);
    ensure(
      selected.length > 0 && new Set(selected).size === selected.length,
      "请选择不重复的镜头",
    );
    const ih = hash({
      kind: "run",
      baseRevision,
      compiledHash: c.hash,
      selected,
    });
    const prior = this.store.action(projectId, key, ih);
    if (prior)
      return {
        runId: prior.runId,
        jobs: prior.ids.map((id: string) => this.store.job(id)),
      };
    ensure(p.revision === baseRevision, "工程版本已经变化", 409);
    ensure(
      !c.issues.some((i) => i.severity === "error"),
      "本体存在错误，请先修正",
      422,
      "ontology_invalid",
    );
    for (const id of selected) {
      const shot = p.ontology.shots.find((s) => s.id === id);
      ensure(shot, "镜头不存在", 404);
      ensure(
        this.store.approved(p, id),
        `${id} 当前版本尚未通过审稿`,
        409,
        "approval_required",
      );
      for (const aid of this.requiredInputs(p.ontology, shot.id)) {
        const a = p.ontology.assets.find((a) => a.id === aid);
        ensure(
          a && !a.gap && a.fileId,
          `${id} 缺少素材 ${aid}`,
          409,
          "asset_gap",
        );
        ensure(
          this.store.approved(p, aid),
          `素材 ${aid} 尚未通过审核`,
          409,
          "approval_required",
        );
      }
    }
    const plans = c.tasks.filter(
      (t) =>
        t.shotId &&
        selected.includes(t.shotId) &&
        !(
          t.kind === "voice" &&
          p.artifacts.some(
            (a) =>
              a.shotId === t.shotId &&
              a.kind === "voice" &&
              a.accepted &&
              a.sourceHash === c.shotHashes[t.shotId!],
          )
        ),
    );
    const planIds = new Set(plans.map((t) => t.id));
    const external: Record<string, string> = {};
    for (const t of plans)
      for (const dep of t.dependsOn) {
        if (planIds.has(dep)) continue;
        const depPlan = c.tasks.find((x) => x.id === dep);
        ensure(depPlan?.shotId, "依赖任务不存在");
        const artifact = this.store
          .artifacts(projectId)
          .find(
            (a) =>
              a.shotId === depPlan.shotId &&
              a.kind === depPlan.kind &&
              a.accepted &&
              a.sourceHash === c.shotHashes[a.shotId!],
          );
        ensure(
          artifact,
          `请先完成并审核依赖镜头 ${depPlan.shotId}`,
          409,
          "dependency_required",
        );
        external[dep] = artifact.id;
      }
    const runId = randomUUID();
    const jobs = this.store.transaction(() => {
      const added = plans.map((t) =>
        this.store.addJob({
          projectId,
          runId,
          kind: t.kind,
          shotId: t.shotId,
          dependsOn: [],
          inputHash: hash({ plan: t, shotHash: c.shotHashes[t.shotId!] }),
          input: {
            ontology: p.ontology,
            requirements: p.requirements,
            baseRevision,
            plan: t,
            generationHash: c.shotHashes[t.shotId!],
            externalArtifactIds: t.dependsOn
              .filter((d) => external[d])
              .map((d) => external[d]),
          },
        }),
      );
      const ids = Object.fromEntries(plans.map((t, i) => [t.id, added[i].id]));
      for (let i = 0; i < added.length; i++)
        added[i] = this.store.updateJob(added[i].id, {
          dependsOn: plans[i].dependsOn
            .filter((d) => ids[d])
            .map((d) => ids[d]),
        });
      this.store.recordAction(projectId, key, ih, {
        runId,
        ids: added.map((j) => j.id),
      });
      return added;
    });
    void this.tick();
    return { runId, jobs };
  }
  enqueueCompose(projectId: string, baseRevision: number, key: string) {
    const p = this.store.project(projectId);
    ensure(p.revision === baseRevision, "工程版本已经变化", 409);
    ensure(
      !p.compiled.issues.some((i) => i.severity === "error"),
      "本体校验未通过",
      422,
    );
    ensure(
      this.store.approved(p, "post"),
      "字幕、图示和后期方案尚未审核",
      409,
      "approval_required",
    );
    const clips = p.ontology.shots.map((shot) => {
      const selected = p.selections.find((s) => s.shotId === shot.id);
      ensure(selected, `${shot.id} 尚未选择入剪版本`, 409);
      const artifact = this.store.artifact(selected.artifactId);
      ensure(
        artifact.accepted &&
          artifact.sourceHash === p.compiled.shotHashes[shot.id],
        `${shot.id} 入剪素材已过期或未审核`,
        409,
      );
      return {
        shotId: shot.id,
        artifactId: artifact.id,
        fileId: artifact.fileId,
        audioFileId: artifact.audioFileId,
        audioHash: artifact.audioHash,
        startFrame: shot.startFrame,
        endFrame: shot.endFrame,
        sourceInSeconds: selected.sourceInSeconds,
      };
    });
    const input = {
      ontology: p.ontology,
      baseRevision,
      clips,
      postHash: p.compiled.postHash,
    };
    const ih = hash(input);
    const prior = this.store.action(projectId, key, ih);
    if (prior) return this.store.job(prior.id);
    const job = this.store.transaction(() => {
      const j = this.store.addJob({
        projectId,
        runId: randomUUID(),
        kind: "compose",
        dependsOn: [],
        inputHash: ih,
        input,
      });
      this.store.recordAction(projectId, key, ih, { id: j.id });
      return j;
    });
    void this.tick();
    return job;
  }
  cancel(id: string) {
    const j = this.store.job(id);
    ensure(!["complete", "cancelled"].includes(j.state), "任务已经结束", 409);
    return this.store.updateJob(id, {
      state: "cancelled",
      stage: "cancelled",
      error: j.handle
        ? "已停止本地跟进；供应商可能仍在执行，取消不表示退款。"
        : "已停止此任务；如果提交已在传输，仍需核对供应商受理状态。",
    });
  }
  retry(id: string, key: string) {
    const old = this.store.job(id);
    ensure(
      old.stage !== "provider_failed",
      "供应商原任务已明确失败；如需新候选，请从当前已审镜头显式发起新生成",
      409,
    );
    ensure(
      ["failed", "blocked"].includes(old.state),
      "只有明确失败或缺配置的任务可重试；受理不明必须核对",
      409,
    );
    const p = this.store.project(old.projectId);
    if (old.shotId && !old.handle)
      ensure(
        old.input.generationHash === p.compiled.shotHashes[old.shotId] &&
          this.store.approved(p, old.shotId),
        "任务输入已经过期，请按当前版本重新提交",
        409,
      );
    const ih = hash({ retryOf: id, inputHash: old.inputHash });
    const prior = this.store.action(old.projectId, key, ih);
    if (prior) return this.store.job(prior.id);
    const job = this.store.transaction(() => {
      const j = this.store.addJob({
        projectId: old.projectId,
        runId: old.runId,
        kind: old.kind,
        shotId: old.shotId,
        dependsOn: old.dependsOn,
        inputHash: old.inputHash,
        input: old.input,
      });
      if (old.handle)
        this.store.updateJob(j.id, { handle: old.handle, stage: "polling" });
      this.store.recordAction(old.projectId, key, ih, { id: j.id });
      return this.store.job(j.id);
    });
    void this.tick();
    return job;
  }
  apply(id: string, baseRevision: number) {
    const j = this.store.job(id);
    ensure(
      j.state === "complete" && j.result && !j.result.applied,
      "没有待应用建议",
      409,
    );
    const p = this.store.project(j.projectId);
    const ontology =
      j.kind === "expand"
        ? j.result.ontology
        : { ...p.ontology, postProgram: j.result.postProgram };
    ensure(ontology, "没有结构化建议");
    validateDraft(ontology, this.store, j.projectId, true);
    const result = this.store.edit(j.projectId, baseRevision, { ontology });
    this.store.updateJob(id, { result: { ...j.result, applied: true } });
    return result;
  }
  reconcile(id: string, providerTaskId: string) {
    const job = this.store.job(id);
    ensure(job.state === "uncertain", "只有受理不明任务需要核对", 409);
    ensure(
      job.kind !== "expand" && job.kind !== "post-plan",
      "文本请求没有可恢复的供应商任务ID，请保留不明状态并从新修订显式提交",
      409,
    );
    const handle = this.providers.recoverHandle(
      job.result?.request,
      providerTaskId,
    );
    const next = this.store.updateJob(id, {
      handle,
      state: "queued",
      stage: "polling",
      error: undefined,
    });
    void this.tick();
    return next;
  }
  private ready(j: Job) {
    if (j.handle) return true;
    const dependencies = j.dependsOn.map((id) => this.store.job(id));
    if (
      dependencies.some((d) =>
        ["failed", "uncertain", "cancelled", "blocked"].includes(d.state),
      )
    ) {
      this.store.updateJob(j.id, {
        state: "waiting_review",
        stage: "dependency_blocked",
        error: "前置任务尚未成功。修复后请重新提交本镜头，已通过素材可复用。",
      });
      return false;
    }
    if (dependencies.some((d) => d.state !== "complete")) return false;
    const artifacts = [
      ...dependencies.map((d) => d.result?.artifactId).filter(Boolean),
      ...(j.input.externalArtifactIds || []),
    ];
    if (artifacts.some((id) => !this.store.artifact(id).accepted)) {
      this.store.updateJob(j.id, {
        state: "waiting_review",
        stage: "review_dependency",
        error: "等待前置声音或镜头的人工审核",
      });
      return false;
    }
    return true;
  }
  async tick() {
    if (this.busy || this.stopped) return;
    this.busy = true;
    try {
      for (const job of this.store.jobs()) {
        if (this.stopped) break;
        if (!["queued", "waiting_review", "running"].includes(job.state))
          continue;
        if (!this.ready(job)) continue;
        await this.process(this.store.job(job.id));
        break;
      }
    } finally {
      this.busy = false;
    }
  }
  private async process(job: Job) {
    const s = this.store;
    try {
      const already = s
        .artifacts(job.projectId)
        .find((a) => a.jobId === job.id);
      if (already) {
        s.updateJob(job.id, {
          state: "complete",
          stage: "complete",
          progress: 1,
          result: { artifactId: already.id },
        });
        return;
      }
      s.updateJob(job.id, {
        state: "running",
        stage: job.handle ? "polling" : "preparing",
        error: undefined,
        progress: 0.05,
      });
      if (job.kind === "expand" || job.kind === "post-plan") {
        const prepared = async (receipt: any) => {
          s.updateJob(job.id, {
            stage: "submitting",
            attempts: job.attempts + 1,
            result: { request: receipt },
          });
        };
        const value =
          job.kind === "expand"
            ? await this.providers.expand(
                job.input.requirements,
                job.input.documents,
                job.input.ontology,
                prepared,
              )
            : await this.providers.planPost(
                job.input.ontology,
                job.input.documents,
                prepared,
              );
        if (s.job(job.id).state === "cancelled") return;
        const latest = s.project(job.projectId);
        let applied = false;
        const proposal =
          job.kind === "expand"
            ? (value as Ontology)
            : { ...latest.ontology, postProgram: value as any };
        validateDraft(proposal, s, job.projectId, true);
        if (latest.revision === job.input.baseRevision) {
          s.edit(job.projectId, latest.revision, { ontology: proposal });
          applied = true;
        }
        s.updateJob(job.id, {
          state: "complete",
          stage: "complete",
          progress: 1,
          result: {
            ...(job.kind === "expand"
              ? { ontology: value }
              : { postProgram: value }),
            applied,
            reason: applied ? undefined : "revision_changed",
          },
        });
        return;
      }
      if (job.shotId && !job.handle) {
        const p = s.project(job.projectId);
        const shot = p.ontology.shots.find((x) => x.id === job.shotId)!;
        for (const aid of this.requiredInputs(p.ontology, shot.id))
          ensure(
            s.approved(p, aid),
            `素材 ${aid} 的审核已失效`,
            409,
            "approval_required",
          );
        ensure(
          p.compiled.shotHashes[job.shotId] === job.input.generationHash &&
            s.approved(p, job.shotId),
          "相关内容或批准已变化，请按当前版本重新提交",
          409,
          "stale_snapshot",
        );
      }
      const workDir = s.workDir(job.id);
      if (job.kind === "compose") {
        const current = s.project(job.projectId);
        ensure(
          current.compiled.postHash === job.input.postHash &&
            s.approved(current, "post"),
          "字幕或后期批准已变化，请重新审核后合成",
          409,
        );
        for (const clip of job.input.clips)
          ensure(
            s.artifact(clip.artifactId).sourceHash ===
              current.compiled.shotHashes[clip.shotId],
            "入剪镜头已过期，请重新选择",
            409,
          );
        const clips = job.input.clips.map((c: any) => {
          const a = s.artifact(c.artifactId);
          ensure(a.accepted, "入剪素材审核已撤回", 409);
          if (c.audioFileId)
            ensure(
              s.file(c.audioFileId).sha256 === c.audioHash,
              "医生音轨绑定校验失败",
            );
          return {
            ...c,
            path: s.filePath(c.fileId),
            audioPath: c.audioFileId ? s.filePath(c.audioFileId) : undefined,
          };
        });
        s.updateJob(job.id, { stage: "rendering", progress: 0.2 });
        const output = join(workDir, "final.mp4");
        const info = await this.mediaEngine.composeMedia({
          clips,
          ontology: job.input.ontology,
          output,
          workDir,
        });
        if (s.job(job.id).state === "cancelled") return;
        const f = s.addFile(
          job.projectId,
          "storyflow-final.mp4",
          "video/mp4",
          readFileSync(output),
        );
        this.finish(job, f.id, "final", job.inputHash, info);
        return;
      }
      if (job.kind === "graphic") {
        s.updateJob(job.id, { stage: "rendering", progress: 0.2 });
        const output = join(workDir, "graphic.mp4");
        const info = await this.mediaEngine.renderGraphic({
          ontology: job.input.ontology,
          shotId: job.shotId!,
          output,
          workDir,
        });
        if (s.job(job.id).state === "cancelled") return;
        const f = s.addFile(
          job.projectId,
          `${job.shotId}-graphic.mp4`,
          "video/mp4",
          readFileSync(output),
        );
        this.finish(job, f.id, "graphic", job.input.generationHash, info);
        return;
      }
      let handle = job.handle;
      if (!handle) {
        const input = await this.videoInput(job);
        handle = await this.providers.submit(input, async (receipt) => {
          s.updateJob(job.id, {
            stage: "submitting",
            attempts: job.attempts + 1,
            result: { request: receipt },
          });
        });
        s.updateJob(job.id, { handle, stage: "polling", progress: 0.15 });
        if (s.job(job.id).state === "cancelled") return;
      }
      const result = await this.providers.poll(handle);
      if (s.job(job.id).state === "cancelled") return;
      if (result.state === "running") {
        s.updateJob(job.id, {
          state: "queued",
          stage: "polling",
          progress: 0.4,
        });
        return;
      }
      ensure(
        result.state !== "failed",
        result.error || "供应商任务失败",
        502,
        "provider_failed",
      );
      s.updateJob(job.id, { stage: "downloading", progress: 0.7, result });
      const download = await this.providers.download(result, handle);
      if (s.job(job.id).state === "cancelled") return;
      const source = s.addFile(
        job.projectId,
        `${job.shotId}-source.mp4`,
        download.mime || "video/mp4",
        download.bytes,
      );
      const sourcePath = s.filePath(source.id);
      const info = await this.mediaEngine.probe(sourcePath);
      let fileId = source.id,
        audio: Artifact | undefined;
      if (job.kind === "voice") {
        const output = join(workDir, "voice.wav");
        await this.mediaEngine.extractAudio(sourcePath, output);
        const f = s.addFile(
          job.projectId,
          `${job.shotId}-voice.wav`,
          "audio/wav",
          readFileSync(output),
        );
        fileId = f.id;
      }
      if (job.kind === "lipsync") {
        audio = this.voiceArtifact(job);
        ensure(audio, "缺少原始驱动声音");
      }
      this.finish(
        job,
        fileId,
        job.kind as Artifact["kind"],
        job.input.generationHash,
        {
          ...info,
          provider: handle.receipt,
          providerTaskId: handle.id,
          requestedModel: handle.model,
          actualModel: result.metadata?.actualModel || null,
          sourceFileId: source.id,
        },
        audio?.fileId,
      );
    } catch (error: any) {
      if (s.job(job.id).state === "cancelled") return;
      const uncertain = error?.uncertain === true;
      const message = cleanError(error);
      const blocked = /not configured|未配置|missing.*key|credential/i.test(
        message,
      );
      s.updateJob(job.id, {
        state: uncertain ? "uncertain" : blocked ? "blocked" : "failed",
        error: message,
        stage: uncertain
          ? "acceptance_unknown"
          : error?.code === "provider_failed"
            ? "provider_failed"
            : s.job(job.id).stage,
      });
    }
  }
  private finish(
    job: Job,
    fileId: string,
    kind: Artifact["kind"],
    sourceHash: string,
    metadata: any,
    audioFileId?: string,
  ) {
    const { path, ...portable } = metadata;
    const a = this.store.addArtifact({
      projectId: job.projectId,
      jobId: job.id,
      shotId: job.shotId,
      kind,
      fileId,
      sourceHash,
      metadata: portable,
      audioFileId,
      audioHash: audioFileId ? this.store.file(audioFileId).sha256 : undefined,
    });
    this.store.updateJob(job.id, {
      state: "complete",
      stage: "complete",
      progress: 1,
      result: { artifactId: a.id },
    });
  }
  private requiredInputs(o: Ontology, shotId: string) {
    const shot = o.shots.find((s) => s.id === shotId)!;
    return [
      ...new Set([
        ...shot.requiredAssetIds,
        ...o.anchors
          .filter(
            (a) => a.id === shot.firstAnchorId || a.id === shot.endAnchorId,
          )
          .map((a) => a.assetId),
      ]),
    ];
  }
  private voiceArtifact(job: Job) {
    const dep = job.dependsOn
      .map((id) => this.store.job(id))
      .find((j) => j.kind === "voice");
    if (dep?.result?.artifactId)
      return this.store.artifact(dep.result.artifactId);
    return (job.input.externalArtifactIds || [])
      .map((id: string) => this.store.artifact(id))
      .find((a: Artifact) => a.kind === "voice" && a.shotId === job.shotId);
  }
  private async videoInput(job: Job): Promise<VideoInput> {
    const s = this.store,
      o: Ontology = job.input.ontology,
      shot = o.shots.find((x) => x.id === job.shotId)!;
    const loadAnchor = (id?: string) => {
      if (!id) return undefined;
      const anchor = o.anchors.find((a) => a.id === id);
      ensure(anchor, "锚图不存在");
      const a = o.assets.find((a) => a.id === anchor.assetId);
      ensure(a?.fileId && !a.gap, "锚图尚未绑定");
      const f = s.file(a.fileId);
      ensure(
        f.projectId === job.projectId && f.sha256 === a.sha256,
        "锚图快照哈希不匹配",
      );
      return { bytes: s.bytes(f.id), mime: f.mime, id: a.id, sha256: f.sha256 };
    };
    let audio;
    if (job.kind === "lipsync") {
      const a = this.voiceArtifact(job);
      ensure(a, "缺少已审声音");
      ensure(a.accepted, "声音尚未审核");
      const f = s.file(a.fileId);
      const info = await this.mediaEngine.probe(s.filePath(f.id));
      ensure(
        info.duration <=
          (shot.endFrame - shot.startFrame) / o.spec.fps + 1 / o.spec.fps,
        "审核音轨超过镜头时长，请修改镜头时长或声音后重新审核",
        409,
        "audio_too_long",
      );
      audio = {
        bytes: s.bytes(f.id),
        mime: f.mime,
        id: f.id,
        sha256: f.sha256,
      };
    }
    return {
      purpose: job.kind as VideoInput["purpose"],
      prompt: (job.input.plan.input.prompt as string) || shot.prompt,
      duration: (shot.endFrame - shot.startFrame) / o.spec.fps,
      fps: o.spec.fps,
      width: o.spec.width,
      height: o.spec.height,
      firstImage:
        job.kind === "voice" ? undefined : loadAnchor(shot.firstAnchorId),
      endImage: shot.endAnchorId
        ? (() => {
            const a = loadAnchor(shot.endAnchorId)!;
            return { id: a.id, sha256: a.sha256 };
          })()
        : undefined,
      audio,
    };
  }
}
