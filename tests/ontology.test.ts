import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  compileOntology,
  createEmptyOntology,
  hash,
  validateOntology,
} from "../shared/ontology.js";
import type { Ontology, Requirements, Shot } from "../shared/types.js";

const requirements: Requirements = {
  topic: "一份礼物",
  audience: "普通观众",
  duration: 6,
  aspect: "9:16",
  fps: 25,
  style: "生活化",
  doctorMode: "fictional",
  sound: "原生对白",
  brief: "三个镜头",
};
function fixture(): Ontology {
  const base = createEmptyOntology("测试故事", requirements);
  const shot = (
    id: string,
    start: number,
    actor: string,
    dependencies: string[] = [],
  ): Shot => ({
    id,
    title: id,
    startFrame: start,
    endFrame: start + 50,
    entityIds: [actor],
    requiredAssetIds: [],
    evidenceIds: [],
    action: "放下书本",
    startState: "拿着书",
    endState: "书在桌上",
    scale: "中景",
    camera: "固定50mm",
    dialogue: [],
    subtitles: [],
    dependencies,
    route: "seedance",
    prompt: "自然窗光",
    mustShow: ["手与书真实接触"],
    rejectIf: ["书本漂浮"],
  });
  base.entities = [
    {
      id: "actor-one",
      type: "character",
      label: "小一",
      fictional: true,
      attributes: { coat: "blue" },
      evidenceIds: [],
    },
    {
      id: "actor-two",
      type: "character",
      label: "小二",
      fictional: true,
      attributes: { coat: "white" },
      evidenceIds: [],
    },
  ];
  base.shots = [
    shot("S1", 0, "actor-one"),
    shot("S2", 50, "actor-two", ["S1"]),
    shot("S3", 100, "actor-two"),
  ];
  return base;
}
const errorCodes = (o: unknown) =>
  validateOntology(o)
    .filter((i) => i.severity === "error")
    .map((i) => i.code);

test("canonical hash ignores object key insertion order, preserves value and array order", () => {
  assert.equal(
    hash({ b: 2, a: { y: 3, x: 4 } }),
    hash({ a: { x: 4, y: 3 }, b: 2 }),
  );
  assert.notEqual(hash([1, 2]), hash([2, 1]));
  assert.notEqual(hash({ a: 2 }), hash({ a: "2" }));
});

test("empty ontology is editable and uses requirements rather than a hardcoded 24fps duration", () => {
  const empty = createEmptyOntology("空项目", requirements);
  assert.equal(empty.spec.totalFrames, 150);
  assert.deepEqual(errorCodes(empty), []);
  assert.ok(
    compileOntology(empty).issues.some((i) => i.code === "empty_story"),
  );
  assert.equal(compileOntology(empty).tasks.length, 0);
});

test("bad references and duplicate IDs fail validation without silent dropped-shot repairs", () => {
  const o = fixture();
  o.shots[0].requiredAssetIds = ["missing-asset"];
  o.shots[1].dialogue = [
    { id: "L1", speakerId: "unknown-speaker", text: "你好" },
  ];
  o.entities.push({ ...o.entities[0] });
  assert.ok(errorCodes(o).includes("unknown_reference"));
  assert.ok(errorCodes(o).includes("duplicate_id"));
  const c = compileOntology(o);
  assert.equal(c.reviewData.shots.length, 3);
  assert.ok(c.issues.some((i) => i.severity === "error"));
});

test("dependency cycle is reported even when it mixes relation and shot dependencies", () => {
  const o = fixture();
  o.relations.push({
    id: "reverse-dependency",
    type: "depends_on",
    from: "S1",
    to: "S2",
    projection: "sequence",
  });
  assert.ok(errorCodes(o).includes("dependency_cycle"));
  assert.ok(errorCodes(o).includes("dependency_not_before_shot"));
  assert.doesNotThrow(() => compileOntology(o));
});

test("overlaps, uncovered frames and out-of-shot dialogue are errors", () => {
  const o = fixture();
  o.shots[1].startFrame = 49;
  o.shots[2].startFrame = 110;
  o.shots[0].dialogue = [
    {
      id: "L1",
      speakerId: "actor-one",
      text: "你好",
      startFrame: 40,
      endFrame: 60,
    },
  ];
  assert.ok(errorCodes(o).includes("shot_overlap"));
  assert.ok(errorCodes(o).includes("timeline_gap"));
  assert.ok(errorCodes(o).includes("invalid_integer"));
});

test("doctor compiles voice before lipsync; children depend on accepted lipsync output", () => {
  const o = fixture();
  o.shots[0].route = "doctor";
  o.shots[0].dialogue = [
    { id: "D1", speakerId: "actor-one", text: "请先检查。" },
  ];
  o.assets.push({
    id: "portrait",
    label: "医生照",
    kind: "image",
    purpose: "production",
    fileId: "file-portrait",
    sha256: "a".repeat(64),
    gap: false,
  });
  o.anchors.push({
    id: "doctor-identity",
    assetId: "portrait",
    entityId: "actor-one",
    role: "identity",
    state: "白袍正面",
  });
  o.shots[0].firstAnchorId = "doctor-identity";
  const c = compileOntology(o);
  assert.deepEqual(errorCodes(o), []);
  const lip = c.tasks.find((t) => t.id === "lipsync:S1")!;
  assert.deepEqual(lip.dependsOn, ["voice:S1"]);
  assert.equal(lip.input.audioTaskId, "voice:S1");
  assert.equal(lip.input.portraitAssetId, "portrait");
  assert.deepEqual(c.tasks.find((t) => t.id === "video:S2")!.dependsOn, [
    "lipsync:S1",
  ]);
  assert.equal(
    (c.tasks.find((t) => t.id === "video:S2")!.input.continuity as any[])[0]
      .acceptanceRequired,
    true,
  );
  assert.ok(
    c.tasks.find((t) => t.id === "compose")!.dependsOn.includes("lipsync:S1"),
  );
  assert.ok(
    !c.tasks.find((t) => t.id === "compose")!.dependsOn.includes("voice:S1"),
  );
});

test("subtitle-only correction changes review and post hashes but no generation hash", () => {
  const o = fixture();
  o.shots[0].subtitles = [
    { id: "C1", text: "桌上是一本书", startFrame: 0, endFrame: 50 },
  ];
  const before = compileOntology(o);
  o.shots[0].subtitles[0].text = "桌上有一本书";
  const after = compileOntology(o);
  assert.deepEqual(after.shotHashes, before.shotHashes);
  assert.notEqual(after.targetHashes.S1, before.targetHashes.S1);
  assert.equal(after.targetHashes.S2, before.targetHashes.S2);
  assert.notEqual(after.postHash, before.postHash);
});

test("changed action invalidates only that shot and its transitive generation dependants", () => {
  const o = fixture();
  const before = compileOntology(o);
  o.shots[0].action = "打开书本";
  const after = compileOntology(o);
  assert.notEqual(after.shotHashes.S1, before.shotHashes.S1);
  assert.notEqual(after.shotHashes.S2, before.shotHashes.S2);
  assert.equal(after.shotHashes.S3, before.shotHashes.S3);
  assert.notEqual(after.targetHashes.S2, before.targetHashes.S2);
});

test("referenced identity and source image bytes affect generation; storage file ID does not", () => {
  const o = fixture();
  o.assets.push({
    id: "identity-image",
    label: "身份",
    purpose: "production",
    kind: "image",
    fileId: "file-one",
    sha256: "a".repeat(64),
    gap: false,
  });
  o.anchors.push({
    id: "identity-anchor",
    entityId: "actor-one",
    assetId: "identity-image",
    role: "identity",
    state: "标准身份",
  });
  const before = compileOntology(o);
  o.assets[0].fileId = "new-file-id";
  const moved = compileOntology(o);
  assert.equal(before.shotHashes.S1, moved.shotHashes.S1);
  o.assets[0].sha256 = "b".repeat(64);
  const changed = compileOntology(o);
  assert.notEqual(before.shotHashes.S1, changed.shotHashes.S1);
  assert.notEqual(before.shotHashes.S2, changed.shotHashes.S2);
  assert.equal(before.shotHashes.S3, changed.shotHashes.S3);
  o.entities[0].attributes.coat = "red";
  assert.notEqual(compileOntology(o).shotHashes.S1, changed.shotHashes.S1);
});

test("fact evidence and declarative graph programs are validated before compilation", () => {
  const o = fixture();
  o.entities.push({
    id: "fact",
    type: "medical-fact",
    label: "医学陈述",
    attributes: {},
    evidenceIds: [],
  });
  o.postProgram = {
    version: 1,
    elements: [
      {
        type: "text",
        text: "hello",
        x: 0,
        y: 20,
        color: "#ffffff",
        startFrame: 0,
        endFrame: 50,
        ...{ code: "process.exit()" },
      },
    ],
  } as any;
  assert.ok(errorCodes(o).includes("fact_without_evidence"));
  assert.ok(errorCodes(o).includes("unknown_graphic_field"));
});

test("compile tolerates incomplete editable JSON and does not mutate valid input", () => {
  assert.doesNotThrow(() =>
    compileOntology({
      schemaVersion: 1,
      title: "",
      spec: null,
      entities: [null],
      shots: [{ id: "broken" }],
    } as any),
  );
  const o = fixture(),
    snapshot = JSON.stringify(o);
  compileOntology(o);
  compileOntology(o);
  assert.equal(JSON.stringify(o), snapshot);
  assert.equal(compileOntology(o).hash, compileOntology(o).hash);
});

test("portable V6 has 20 continuous shots, four doctor routes and no packaged private source paths", () => {
  const source = readFileSync(
    new URL("../examples/lupus-v6.json", import.meta.url),
    "utf8",
  );
  const o = JSON.parse(source) as Ontology,
    c = compileOntology(o);
  assert.deepEqual(
    c.issues.filter((i) => i.severity === "error"),
    [],
  );
  assert.equal(o.shots.length, 20);
  assert.equal(o.spec.totalFrames, 1500);
  assert.equal(o.spec.fps, 25);
  assert.equal(o.shots.filter((s) => s.route === "doctor").length, 4);
  assert.equal(c.tasks.filter((t) => t.kind === "voice").length, 4);
  assert.equal(c.tasks.filter((t) => t.kind === "lipsync").length, 4);
  assert.equal(c.tasks.filter((t) => t.kind === "video").length, 16);
  assert.equal(c.tasks.length, 25);
  assert.doesNotMatch(
    source,
    /\/Users\/|\/opt\/|sourcePath|providerJobId|Bearer /,
  );
  for (const s of o.shots)
    assert.ok(
      !s.requiredAssetIds.includes(`A-PLATE-${s.id}`),
      "a generated plate must not require its own output",
    );
  assert.equal(o.assets.find((a) => a.id === "A-CHAR-D00")!.fileId, undefined);
  const manifest = JSON.parse(
    readFileSync(
      new URL("../examples/lupus-v6.assets.json", import.meta.url),
      "utf8",
    ),
  );
  assert.equal(manifest.files.length, 12);
  for (const f of manifest.files) {
    assert.ok(f.path.startsWith("assets/") && !f.path.includes(".."));
    assert.ok(f.source.license && f.source.author && f.source.url);
  }
});
