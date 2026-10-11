import test from "node:test";
import assert from "node:assert/strict";
import { Jobs } from "../server/jobs.ts";
import { Store } from "../server/store.ts";
import { Providers, ProviderError } from "../server/providers.ts";
import { tempStore, requirements, fixture, mockMedia } from "./helpers.ts";
import { sha } from "../server/util.ts";

function provider() {
  let submits = 0,
    polls = 0;
  return {
    get submits() {
      return submits;
    },
    get polls() {
      return polls;
    },
    capabilities: () => ({}),
    videoSpec: () => ({provider:"seedance",model:"fixture",baseUrl:"https://provider.example",protocol:"seedance-relay-v1",referenceMode:"first_frame",nativeAudio:true,maxSeconds:12,durationPolicy:"ceil-min4"}),
    submit: async (input: any, prepared: any) => {
      await prepared({
        provider: "seedance",
        requestHash: "a".repeat(64),
        model: "fixture",
        baseUrl: "https://provider.example",
      });
      submits++;
      return {
        provider: input.purpose === "lipsync" ? "fal" : "seedance",
        id: `task-${submits}`,
        baseUrl: "https://provider.example",
        model: "fixture",
        receipt: { audioHash: input.audio?.sha256 },
      };
    },
    poll: async () => {
      polls++;
      return { state: "complete", url: "https://media.example/movie.mp4" };
    },
    download: async () => ({
      mime: "video/mp4",
      bytes: Buffer.from("test synthetic video"),
    }),
  };
}

test("queued video freezes model selection and rejects changed configuration without POST", async () => {
  const t=setup();let posts=0;
  const config={seedanceBase:"https://relay.example/v1",seedanceKey:"fixture-key",seedanceModel:"dreamina-seedance-2-0",videoModel:"",falKey:"",falBase:"",opusBase:"",opusKey:"",opusModel:"",allowPrivate:true};
  const p=new Providers(config,{fetchImpl:(async()=>{posts++;throw new Error("must not submit changed profile");}) as typeof fetch});
  const jobs=new Jobs(t.store,p,mockMedia());jobs.stop();
  try {
    const before=t.store.project(t.project.id), job=jobs.enqueueRun(before.id,before.revision,"frozen-model-test").jobs[0];
    assert.equal(job.input.providerSpec.model,"dreamina-seedance-2-0");
    const storyHash=before.compiled.shotHashes.s1;
    config.videoModel="veo-3.1-generate-001";
    await tick(jobs);
    const after=t.store.job(job.id);
    assert.equal(after.attempts,0);assert.match(after.error!,/configuration changed/);assert.equal(posts,0);
    assert.equal(t.store.project(before.id).compiled.shotHashes.s1,storyHash);
    const newer=jobs.enqueueRun(before.id,before.revision,"frozen-model-test-veo").jobs[0];
    assert.equal(newer.input.providerSpec.model,"veo-3.1-generate-001");assert.notEqual(newer.inputHash,job.inputHash);
  } finally {jobs.stop();t.close();}
});
async function tick(jobs: Jobs) {
  jobs.stopped = false;
  await jobs.tick();
  jobs.stopped = true;
}
function setup(doctor = false) {
  const t = tempStore(),
    o = fixture(doctor);
  if (doctor) {
    const p = t.store.create("doctor", requirements, o),
      f = t.store.addFile(
        p.id,
        "portrait.png",
        "image/png",
        Buffer.from("synthetic portrait"),
      );
    o.assets = [
      {
        id: "portrait",
        label: "测试身份",
        kind: "image",
        purpose: "production",
        fileId: f.id,
        sha256: f.sha256,
        gap: false,
      },
    ];
    o.anchors = [
      {
        id: "identity",
        entityId: "hero",
        assetId: "portrait",
        role: "identity",
        state: "正面",
      },
    ];
    o.shots[0].firstAnchorId = "identity";
    o.shots[0].requiredAssetIds = ["portrait"];
    const edited = t.store.edit(p.id, 1, { ontology: o });
    t.store.review(p.id, "portrait", "pass", "");
    t.store.review(p.id, "s1", "pass", "");
    return { ...t, project: t.store.project(edited.id) };
  }
  const p = t.store.create("test", requirements, o);
  t.store.review(p.id, "s1", "pass", "");
  return { ...t, project: t.store.project(p.id) };
}

test("review gate, durable idempotency and cancel prevent unintended submission", async () => {
  const t = tempStore();
  try {
    const p = t.store.create("test", requirements, fixture()),
      fake = provider(),
      j = new Jobs(t.store, fake as any, mockMedia());
    j.stopped = true;
    assert.throws(() => j.enqueueRun(p.id, 1, "key-000001"), /审稿/);
    t.store.review(p.id, "s1", "pass", "");
    const first = j.enqueueRun(p.id, 1, "key-000001"),
      again = j.enqueueRun(p.id, 1, "key-000001");
    assert.equal(first.jobs[0].id, again.jobs[0].id);
    j.cancel(first.jobs[0].id);
    await tick(j);
    assert.equal(fake.submits, 0);
  } finally {
    t.close();
  }
});

test("accepted task resumes polling after restart and does not POST again", async () => {
  const t = setup();
  try {
    const fake = provider();
    let first = true;
    fake.poll = async () => {
      if (first) {
        first = false;
        return { state: "running" } as any;
      }
      return { state: "complete", url: "https://media.example/movie.mp4" };
    };
    const j = new Jobs(t.store, fake as any, mockMedia());
    j.stopped = true;
    const job = j.enqueueRun(t.project.id, t.project.revision, "restart-0001")
      .jobs[0];
    await tick(j);
    assert.ok(t.store.job(job.id).handle);
    assert.equal(fake.submits, 1);
    t.store.close();
    const reopened = new Store(t.dir);
    t.store = reopened;
    const recovered = new Jobs(reopened, fake as any, mockMedia());
    recovered.recover();
    await tick(recovered);
    assert.equal(reopened.job(job.id).state, "complete");
    assert.equal(fake.submits, 1);
    reopened.close();
  } finally {
    try {
      t.close();
    } catch {}
  }
});

test("transport failure after prepared intent is uncertain and cannot automatically retry", async () => {
  const t = setup();
  try {
    const fake = provider();
    fake.submit = async (_i: any, prepared: any) => {
      await prepared({
        provider: "seedance",
        requestHash: "a".repeat(64),
        model: "fixture",
        baseUrl: "https://provider.example",
      });
      throw new ProviderError("connection lost after POST", true);
    };
    const j = new Jobs(t.store, fake as any, mockMedia());
    j.stopped = true;
    const job = j.enqueueRun(t.project.id, t.project.revision, "uncertain-1")
      .jobs[0];
    await tick(j);
    assert.equal(t.store.job(job.id).state, "uncertain");
    assert.throws(() => j.retry(job.id, "retry-0001"), /受理不明/);
    await tick(j);
    assert.equal(t.store.job(job.id).attempts, 1);
    assert.ok(t.store.job(job.id).result.request);
  } finally {
    t.close();
  }
});

test("polling failure retry retains original handle and never repeats POST", async () => {
  const t = setup();
  try {
    const fake = provider();
    let throws = true;
    fake.poll = async () => {
      if (throws) {
        throws = false;
        throw new Error("poll network outage");
      }
      return { state: "complete", url: "https://media.example/movie.mp4" };
    };
    const j = new Jobs(t.store, fake as any, mockMedia());
    j.stopped = true;
    const job = j.enqueueRun(t.project.id, t.project.revision, "poll-retry-1")
      .jobs[0];
    await tick(j);
    assert.equal(t.store.job(job.id).state, "failed");
    const retry = j.retry(job.id, "poll-retry-2");
    assert.equal(retry.handle?.id, "task-1");
    await tick(j);
    assert.equal(t.store.job(retry.id).state, "complete");
    assert.equal(fake.submits, 1);
  } finally {
    t.close();
  }
});

test("voice review gates lipsync and preserves exact audio hash through composition", async () => {
  const t = setup(true);
  try {
    const fake = provider(),
      j = new Jobs(t.store, fake as any, mockMedia());
    j.stopped = true;
    const run = j.enqueueRun(t.project.id, t.project.revision, "doctor-run-1");
    const voice = run.jobs.find((x: any) => x.kind === "voice")!,
      lip = run.jobs.find((x: any) => x.kind === "lipsync")!;
    await tick(j);
    const v = t.store.artifact(t.store.job(voice.id).result.artifactId);
    await tick(j);
    assert.equal(t.store.job(lip.id).state, "waiting_review");
    assert.equal(fake.submits, 1);
    t.store.reviewArtifact(v.id, true);
    await tick(j);
    assert.equal(fake.submits, 2);
    const a = t.store.artifact(t.store.job(lip.id).result.artifactId);
    assert.equal(a.audioFileId, v.fileId);
    assert.equal(a.audioHash, sha(t.store.bytes(v.fileId)));
    t.store.reviewArtifact(a.id, true);
    t.store.select(a.id);
    t.store.review(t.project.id, "post", "pass", "");
    const compose = j.enqueueCompose(
      t.project.id,
      t.project.revision,
      "doctor-compose-1",
    );
    await tick(j);
    assert.equal(t.store.job(compose.id).state, "complete");
    assert.equal(fake.submits, 2);
  } finally {
    t.close();
  }
});

test("subtitle correction reuses video; generation content change invalidates its selection", async () => {
  const t = setup();
  try {
    const j = new Jobs(t.store, provider() as any, mockMedia());
    j.stopped = true;
    const job = j.enqueueRun(t.project.id, t.project.revision, "subtitle-run-1")
      .jobs[0];
    await tick(j);
    const a = t.store.artifact(t.store.job(job.id).result.artifactId);
    t.store.reviewArtifact(a.id, true);
    t.store.select(a.id);
    let p = t.store.project(t.project.id);
    p.ontology.shots[0].subtitles = [
      { id: "subtitle", text: "桌上有一本书", startFrame: 0, endFrame: 100 },
    ];
    p = t.store.edit(p.id, p.revision, { ontology: p.ontology });
    assert.equal(p.compiled.shotHashes.s1, a.sourceHash);
    t.store.review(p.id, "post", "pass", "");
    assert.doesNotThrow(() =>
      j.enqueueCompose(p.id, p.revision, "subtitle-compose-1"),
    );
    p.ontology.shots[0].action = "把书拿起来";
    p = t.store.edit(p.id, p.revision, { ontology: p.ontology });
    t.store.review(p.id, "post", "pass", "");
    assert.throws(
      () => j.enqueueCompose(p.id, p.revision, "subtitle-compose-2"),
      /过期/,
    );
  } finally {
    t.close();
  }
});

test("pending AI plan never overwrites concurrent user revision", async () => {
  const t = setup();
  try {
    const fake: any = provider();
    fake.expand = async (_r: any, _c: any, o: any, prepared: any) => {
      await prepared({ provider: "opus" });
      const p = t.store.project(t.project.id);
      t.store.edit(p.id, p.revision, { name: "user edit" });
      return { ...o, title: "AI proposal" };
    };
    const j = new Jobs(t.store, fake, mockMedia());
    j.stopped = true;
    const job = j.enqueueText(
      t.project.id,
      "expand",
      t.project.revision,
      "expand-0001",
    );
    await tick(j);
    assert.equal(t.store.project(t.project.id).name, "user edit");
    assert.equal(t.store.job(job.id).result.applied, false);
    const p = j.apply(job.id, t.store.project(t.project.id).revision);
    assert.equal(p.ontology.title, "AI proposal");
  } finally {
    t.close();
  }
});

test("missing provider config yields blocked and no fabricated output", async () => {
  const t = setup();
  try {
    const p = new Providers({
      seedanceBase: "",
      seedanceKey: "",
      seedanceModel: "test",
      falKey: "",
      falBase: "https://queue.fal.run",
      opusBase: "",
      opusKey: "",
      opusModel: "test",
    });
    const j = new Jobs(t.store, p, mockMedia());
    j.stopped = true;
    const job = j.enqueueRun(t.project.id, t.project.revision, "config-0001")
      .jobs[0];
    await tick(j);
    assert.equal(t.store.job(job.id).state, "blocked");
    assert.equal(t.store.artifacts(t.project.id).length, 0);
    assert.equal(t.store.job(job.id).attempts, 0);
  } finally {
    t.close();
  }
});

test("model suggestion cannot bypass file ownership or structural validation", async () => {
  const t = setup();
  try {
    const other = t.store.create("other", requirements, fixture()),
      foreign = t.store.addFile(
        other.id,
        "foreign.png",
        "image/png",
        Buffer.from("foreign"),
      );
    const fake: any = provider();
    fake.expand = async (_r: any, _d: any, o: any, prepared: any) => {
      await prepared({ provider: "opus" });
      return {
        ...o,
        assets: [
          {
            id: "foreign",
            label: "foreign",
            kind: "image",
            purpose: "reference",
            gap: false,
            fileId: foreign.id,
            sha256: foreign.sha256,
          },
        ],
      };
    };
    const j = new Jobs(t.store, fake, mockMedia());
    j.stopped = true;
    const job = j.enqueueText(
      t.project.id,
      "expand",
      t.project.revision,
      "model-guard-1",
    );
    await tick(j);
    assert.equal(t.store.job(job.id).state, "failed");
    assert.equal(t.store.project(t.project.id).revision, t.project.revision);
    assert.equal(t.store.project(t.project.id).ontology.assets.length, 0);
  } finally {
    t.close();
  }
});

test("accepting a different voice invalidates old lipsync and reuses new voice without another voice POST", async () => {
  const t = setup(true);
  try {
    const s = t.store,
      sourceHash = t.project.compiled.shotHashes.s1;
    const addVoice = (text: string) => {
      const f = s.addFile(
        t.project.id,
        "voice.wav",
        "audio/wav",
        Buffer.from(text),
      );
      return s.addArtifact({
        projectId: t.project.id,
        jobId: "import-voice",
        shotId: "s1",
        kind: "voice",
        fileId: f.id,
        sourceHash,
        metadata: {},
      });
    };
    const v1 = addVoice("old voice");
    s.reviewArtifact(v1.id, true);
    const video = s.addFile(
      t.project.id,
      "lip.mp4",
      "video/mp4",
      Buffer.from("old lip"),
    );
    const lip = s.addArtifact({
      projectId: t.project.id,
      jobId: "import-lip",
      shotId: "s1",
      kind: "lipsync",
      fileId: video.id,
      sourceHash,
      audioFileId: v1.fileId,
      audioHash: s.file(v1.fileId).sha256,
      metadata: {},
    });
    s.reviewArtifact(lip.id, true);
    s.select(lip.id);
    const v2 = addVoice("new voice");
    s.reviewArtifact(v2.id, true);
    assert.equal(s.artifact(lip.id).accepted, false);
    assert.throws(() => s.reviewArtifact(lip.id, true), /声音已更换/);
    const fake = provider(),
      j = new Jobs(s, fake as any, mockMedia());
    j.stopped = true;
    const run = j.enqueueRun(
      t.project.id,
      t.project.revision,
      "voice-replace-1",
    );
    assert.equal(run.jobs.length, 1);
    assert.equal(run.jobs[0].kind, "lipsync");
    await tick(j);
    assert.equal(fake.submits, 1);
    const next = s.artifact(s.job(run.jobs[0].id).result.artifactId);
    assert.equal(next.audioFileId, v2.fileId);
  } finally {
    t.close();
  }
});

test("accepted old revision is still collected as history after edits; it cannot be selected as current", async () => {
  const t = setup();
  try {
    const fake = provider();
    let first = true;
    fake.poll = async () => {
      if (first) {
        first = false;
        return { state: "running" } as any;
      }
      return { state: "complete", url: "https://media.example/movie.mp4" };
    };
    const j = new Jobs(t.store, fake as any, mockMedia());
    j.stopped = true;
    const job = j.enqueueRun(t.project.id, t.project.revision, "history-0001")
      .jobs[0];
    await tick(j);
    const p = t.store.project(t.project.id);
    p.ontology.shots[0].action = "不同动作";
    t.store.edit(p.id, p.revision, { ontology: p.ontology });
    await tick(j);
    assert.equal(fake.submits, 1);
    assert.equal(t.store.job(job.id).state, "complete");
    const a = t.store.artifact(t.store.job(job.id).result.artifactId);
    assert.throws(() => t.store.reviewArtifact(a.id, true), /旧的生成版本/);
  } finally {
    t.close();
  }
});

test("queued composition rechecks approval and voice revocation invalidates lipsync", async () => {
  const t = setup();
  try {
    const j = new Jobs(t.store, provider() as any, mockMedia());
    j.stopped = true;
    const job = j.enqueueRun(t.project.id, t.project.revision, "compose-gate-1")
      .jobs[0];
    await tick(j);
    const a = t.store.artifact(t.store.job(job.id).result.artifactId);
    t.store.reviewArtifact(a.id, true);
    t.store.select(a.id);
    t.store.review(t.project.id, "post", "pass", "");
    const compose = j.enqueueCompose(
      t.project.id,
      t.project.revision,
      "compose-gate-2",
    );
    t.store.review(t.project.id, "post", "change", "wrong caption");
    await tick(j);
    assert.equal(t.store.job(compose.id).state, "failed");
    assert.equal(
      t.store.artifacts(t.project.id).filter((a) => a.kind === "final").length,
      0,
    );
  } finally {
    t.close();
  }
});

test("changing selected take or trim invalidates post review without changing generation hash", async () => {
  const t = setup();
  try {
    const s = t.store,
      j = new Jobs(s, provider() as any, mockMedia());
    j.stopped = true;
    const job = j.enqueueRun(t.project.id, t.project.revision, "take-gate-1")
      .jobs[0];
    await tick(j);
    const a = s.artifact(s.job(job.id).result.artifactId);
    s.reviewArtifact(a.id, true);
    s.select(a.id);
    s.review(t.project.id, "post", "pass", "");
    const before = s.project(t.project.id);
    s.select(a.id, 1);
    const after = s.project(t.project.id);
    assert.equal(after.compiled.shotHashes.s1, before.compiled.shotHashes.s1);
    assert.notEqual(after.compiled.postHash, before.compiled.postHash);
    assert.equal(s.approved(after, "post"), false);
    assert.throws(
      () => j.enqueueCompose(after.id, after.revision, "take-gate-2"),
      /尚未审核/,
    );
  } finally {
    t.close();
  }
});
