import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import JSZip from "jszip";
import { Store } from "../server/store.ts";
import {
  exportProject,
  importProject,
  readOnlyReviewHtml,
} from "../server/archive.ts";
import { createEmptyOntology } from "../shared/ontology.ts";
import { sha } from "../server/util.ts";
import type { Requirements } from "../shared/types.ts";

const requirements: Requirements = {
  topic: "测试迁移",
  audience: "编辑",
  duration: 4,
  aspect: "9:16",
  fps: 25,
  style: "自然",
  doctorMode: "photo",
  sound: "原生对白",
  brief: "完整迁移工程，但不迁移生成授权。",
};
const png = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a9RkAAAAASUVORK5CYII=",
  "base64",
);
function stores(t: any) {
  const directory = mkdtempSync(join(tmpdir(), "storyflow-archive-"));
  const a = new Store(join(directory, "source")),
    b = new Store(join(directory, "destination"));
  t.after(() => {
    a.close();
    b.close();
    rmSync(directory, { recursive: true, force: true });
  });
  return { a, b };
}
function fixture(store: Store) {
  const o = createEmptyOntology("移植测试", requirements);
  o.entities.push({
    id: "doctor",
    type: "character",
    label: "示例医生",
    attributes: { coat: "white" },
    evidenceIds: [],
  });
  o.assets.push({
    id: "portrait",
    label: "身份图",
    kind: "image",
    purpose: "production",
    gap: true,
  });
  o.anchors.push({
    id: "identity",
    entityId: "doctor",
    assetId: "portrait",
    role: "identity",
    state: "正面",
  });
  o.shots.push({
    id: "S1",
    title: "一句对白",
    startFrame: 0,
    endFrame: 100,
    entityIds: ["doctor"],
    requiredAssetIds: ["portrait"],
    evidenceIds: [],
    action: "医生解释",
    startState: "看向镜头",
    endState: "说完收口",
    scale: "近景",
    camera: "眼平",
    dialogue: [
      {
        id: "L1",
        speakerId: "doctor",
        text: "请先检查。",
        startFrame: 10,
        endFrame: 80,
      },
    ],
    subtitles: [{ id: "C1", startFrame: 10, endFrame: 80, text: "请先检查。" }],
    dependencies: [],
    route: "doctor",
    prompt: "医生说话，嘴部完整可见",
    firstAnchorId: "identity",
    mustShow: [],
    rejectIf: [],
  });
  let p = store.create("移植测试", requirements, o);
  const image = store.addFile(p.id, "portrait.png", "image/png", png, {
    metadata: {
      path: "/Users/private/source.png",
      apiKey: "should-not-export",
      caption: "身份图",
      publicShareApproved: true,
    },
  });
  p = store.bind(p.id, p.revision, "portrait", image.id);
  store.review(p.id, "portrait", "pass", "身份已审");
  store.review(p.id, "S1", "pass", "文字已审");
  const audio = store.addFile(
    p.id,
    "line.wav",
    "audio/wav",
    Buffer.from("RIFF-test-audio"),
  );
  const video = store.addFile(
    p.id,
    "doctor.mp4",
    "video/mp4",
    Buffer.from("test-video"),
  );
  const voiceJob = store.addJob({
    projectId: p.id,
    runId: randomUUID(),
    kind: "voice",
    shotId: "S1",
    dependsOn: [],
    inputHash: p.compiled.shotHashes.S1,
    input: { shouldNotBeReplayed: true },
  });
  const voice = store.addArtifact({
    projectId: p.id,
    jobId: voiceJob.id,
    shotId: "S1",
    kind: "voice",
    fileId: audio.id,
    sourceHash: p.compiled.shotHashes.S1,
    metadata: { origin: "synthetic-test" },
  });
  store.updateJob(voiceJob.id, {
    state: "complete",
    result: { artifactId: voice.id },
  });
  store.reviewArtifact(voice.id, true, "声音逐字审核通过");
  const job = store.addJob({
    projectId: p.id,
    runId: voiceJob.runId,
    kind: "lipsync",
    shotId: "S1",
    dependsOn: [voiceJob.id],
    inputHash: p.compiled.shotHashes.S1,
    input: { shouldNotBeReplayed: true },
  });
  store.updateJob(job.id, {
    state: "complete",
    handle: {
      provider: "fal",
      id: "upstream-id",
      baseUrl: "https://example.com",
      model: "omnihuman",
      requestHash: "a".repeat(64),
      receipt: { secret: "no-export" },
    },
  });
  const artifact = store.addArtifact({
    projectId: p.id,
    jobId: job.id,
    shotId: "S1",
    kind: "lipsync",
    fileId: video.id,
    audioFileId: audio.id,
    audioHash: audio.sha256,
    sourceHash: p.compiled.shotHashes.S1,
    metadata: {
      model: "omnihuman",
      referenceMode: "image-audio",
      authorization: "Bearer private",
      sourceFileId: image.id,
    },
  });
  store.reviewArtifact(artifact.id, true, "短样通过");
  store.select(artifact.id, 0.1);
  return store.project(p.id);
}

async function editArchive(
  bytes: Buffer,
  change: (zip: JSZip, manifest: any, project: any) => void | Promise<void>,
  updateProjectHash = true,
) {
  const zip = await JSZip.loadAsync(bytes),
    manifest = JSON.parse(await zip.file("manifest.json")!.async("string")),
    project = JSON.parse(await zip.file("project.json")!.async("string"));
  await change(zip, manifest, project);
  if (updateProjectHash) {
    const body = Buffer.from(JSON.stringify(project));
    zip.file("project.json", body);
    manifest.project.sha256 = sha(body);
    manifest.project.bytes = body.length;
  }
  zip.file("manifest.json", JSON.stringify(manifest));
  return zip.generateAsync({ type: "nodebuffer" });
}
function emptyDestination(store: Store) {
  assert.equal(store.list().length, 0);
  assert.deepEqual(readdirSync(join(store.directory, "files")), []);
  assert.equal(store.jobs().length, 0);
}

test("project ZIP roundtrips content to a new project with remapped IDs and no replayed approvals/jobs", async (t) => {
  const { a, b } = stores(t),
    original = fixture(a),
    bytes = await exportProject(a, original.id);
  const zip = await JSZip.loadAsync(bytes),
    json = await zip.file("project.json")!.async("string");
  assert.doesNotMatch(
    json,
    /shouldNotBeReplayed|Bearer private|no-export|should-not-export|\/Users\/private/,
  );
  const imported = await importProject(b, bytes);
  assert.notEqual(imported.id, original.id);
  assert.equal(imported.revision, 1);
  assert.equal(imported.files.length, original.files.length);
  assert.equal(imported.jobs.length, 0);
  assert.ok(imported.reviews.every((r) => r.status === "pending"));
  assert.ok(imported.reviews.some((r) => r.note.includes("原结论=pass")));
  assert.equal(imported.artifacts.length, 2);
  assert.ok(imported.artifacts.every((a) => !a.accepted));
  const lip = imported.artifacts.find((a) => a.kind === "lipsync")!,
    voice = imported.artifacts.find((a) => a.kind === "voice")!;
  assert.ok(lip);
  assert.ok(voice);
  assert.notEqual(
    lip.id,
    original.artifacts.find((a) => a.kind === "lipsync")!.id,
  );
  assert.notEqual(
    voice.id,
    original.artifacts.find((a) => a.kind === "voice")!.id,
  );
  assert.notEqual(
    imported.ontology.assets[0].fileId,
    original.ontology.assets[0].fileId,
  );
  assert.equal(lip.metadata.sourceFileId, imported.ontology.assets[0].fileId);
  assert.ok(
    imported.artifacts.every(
      (a) =>
        (a.metadata.archive as Record<string, unknown>).reviewRequired === true,
    ),
  );
  assert.deepEqual(b.selections(imported.id), []);
  assert.equal(lip.audioFileId, voice.fileId);
  assert.equal(b.file(lip.audioFileId!).sha256, lip.audioHash);
  assert.throws(() => b.reviewArtifact(lip.id, true), /绑定声音已更换或撤回/);
  b.reviewArtifact(voice.id, true, "迁移后重新审核声音");
  assert.doesNotThrow(() =>
    b.reviewArtifact(lip.id, true, "迁移后重新审核口型"),
  );
  for (const f of imported.files) assert.equal(sha(b.bytes(f.id)), f.sha256);
  assert.equal(
    imported.compiled.shotHashes.S1,
    original.compiled.shotHashes.S1,
  );
  const offlineHtml = await zip.file("review.html")!.async("string");
  assert.match(offlineHtml, /src="media\/[a-f0-9]{64}"/);
  assert.doesNotMatch(offlineHtml, /src="\.\.\/\.\.\/files/);
});

test("corrupt media hash is rejected before creating a project or file", async (t) => {
  const { a, b } = stores(t),
    p = fixture(a),
    bytes = await exportProject(a, p.id);
  const changed = await editArchive(bytes, (zip, manifest) => {
    zip.file(manifest.files[0].path, "tampered");
  });
  await assert.rejects(importProject(b, changed), /完整性校验失败/);
  emptyDestination(b);
});

test("undeclared ZIP entries and normalized traversal names are rejected without writes", async (t) => {
  const { a, b } = stores(t),
    p = fixture(a),
    bytes = await exportProject(a, p.id);
  for (const name of ["extra.txt", "../escape.txt"]) {
    const changed = await editArchive(bytes, (zip) => {
      zip.file(name, "not allowed");
    });
    await assert.rejects(importProject(b, changed), /未声明文件|非法.*路径/);
    emptyDestination(b);
  }
});

test("manifest path, missing file and project SHA mismatches are rejected before writes", async (t) => {
  const { a, b } = stores(t),
    p = fixture(a),
    bytes = await exportProject(a, p.id);
  const badPath = await editArchive(bytes, (_zip, manifest) => {
    manifest.files[0].path = "/tmp/data";
  });
  await assert.rejects(importProject(b, badPath), /媒体路径/);
  emptyDestination(b);
  const missing = await editArchive(bytes, (zip, manifest) => {
    zip.remove(manifest.files[0].path);
  });
  await assert.rejects(importProject(b, missing), /缺少文件/);
  emptyDestination(b);
  const badProject = await editArchive(
    bytes,
    (zip) => {
      zip.file("project.json", "{}");
    },
    false,
  );
  await assert.rejects(importProject(b, badProject), /完整性校验失败/);
  emptyDestination(b);
});

test("unknown bound files, wrong audio hashes and embedded jobs cannot be imported", async (t) => {
  const { a, b } = stores(t),
    p = fixture(a),
    bytes = await exportProject(a, p.id);
  const cases = [
    {
      change: (data: any) => {
        data.ontology.assets[0].fileId = "missing";
      },
      error: /引用缺失/,
    },
    {
      change: (data: any) => {
        data.artifacts.find((a: any) => a.kind === "lipsync").audioHash =
          "b".repeat(64);
      },
      error: /音轨缺失或哈希不符/,
    },
    {
      change: (data: any) => {
        data.jobs = [{ id: "run-again" }];
      },
      error: /可执行jobs/,
    },
    {
      change: (data: any) => {
        delete data.sourceProjectId;
      },
      error: /记录格式/,
    },
  ];
  for (const c of cases) {
    const changed = await editArchive(bytes, (_zip, _manifest, data) =>
      c.change(data),
    );
    await assert.rejects(importProject(b, changed), c.error);
    emptyDestination(b);
  }
});

test("late database/file registration failure rolls back the complete project and new CAS files", async (t) => {
  const { a, b } = stores(t),
    p = fixture(a),
    bytes = await exportProject(a, p.id),
    original = b.addFile.bind(b);
  let writes = 0;
  b.addFile = (...args: Parameters<Store["addFile"]>) => {
    const f = original(...args);
    writes++;
    if (writes === 2) throw new Error("simulated disk failure");
    return f;
  };
  await assert.rejects(importProject(b, bytes), /simulated disk failure/);
  assert.equal(writes, 2);
  emptyDestination(b);
});

test("read-only review escapes untrusted HTML and links while describing real control boundaries", (t) => {
  const { a } = stores(t),
    p = fixture(a);
  p.name = "<script>alert(1)</script>";
  p.ontology.shots[0].action = '"><img src=x onerror=alert(2)>';
  p.ontology.assets[0].source = {
    url: "javascript:alert(3)",
    author: "<b>unsafe</b>",
  };
  const html = readOnlyReviewHtml(p);
  assert.match(html, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
  assert.doesNotMatch(
    html,
    /<script>alert\(1\)<\/script>|<img src=x|href="javascript:|Bearer private/,
  );
  assert.match(html, /需求 → 展开 → 审核 → 视频/);
  assert.match(html, /末态锚图/);
  assert.match(html, /首帧或纯文字/);
  assert.match(html, /同一审核声音/);
  assert.match(html, /逐镜任务依赖/);
  assert.match(html, /\.\.\/\.\.\/files\//);
});
