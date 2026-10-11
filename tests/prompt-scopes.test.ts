import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { compileOntology, imageTargetHashes } from "../shared/ontology.ts";
import { Jobs } from "../server/jobs.ts";
import { sha } from "../server/util.ts";
import { fixture, mockMedia, requirements, tempStore } from "./helpers.ts";
import type { Ontology } from "../shared/types.ts";

const roomBytes = Buffer.from("synthetic empty-room");
function scopedFixture(): Ontology {
  const o = fixture();
  o.entities[0].attributes.coat = "米白衣";
  o.assets = [{
    id: "empty-room", label: "客厅场景图", kind: "image", purpose: "production",
    fileId: "room-file", sha256: sha(roomBytes), gap: false,
    mustShow: ["素材独立画面只出现空房间"],
    rejectIf: ["素材独立画面出现人物面孔"],
  }];
  o.shots[0].requiredAssetIds = ["empty-room"];
  o.shots[0].mustShow = ["虚构角色清楚可见", "手与书真实接触"];
  o.shots[0].rejectIf = ["书本漂浮"];
  return o;
}

// Recorded from the pre-fix compiler for this synthetic, credential-free fixture.
const legacyShotHash = "4a776a9c78af637bc8aa4e0cfe949b4e0d2aa95bf7c46af3e2a0dc7425ce03c9";
const legacyShotImageHash = "60e46890dfecf9c52fc17cdce289b9ba767527989f0b78a24156be703f00680d";
const legacyAssetImageHash = "88cabd2c64b5c8be235d39e127008318d01e32c2beb2f949b1e51508c818812b";

test("an empty-set asset cannot prohibit the actor in a shot using that set", () => {
  const o = scopedFixture(), before = JSON.stringify(o), c = compileOntology(o);
  assert.deepEqual(c.issues.filter(i => i.severity === "error"), []);
  assert.match(c.prompts.s1, /必须可见：虚构角色清楚可见；手与书真实接触/);
  assert.match(c.prompts.s1, /拒收条件：书本漂浮/);
  assert.match(c.prompts.s1, /hero 虚构角色；coat=米白衣/);
  assert.match(c.prompts.s1, /开始：拿着书\n动作：放下书本\n结束：书在桌上/);
  for (const rule of [...o.assets[0].mustShow!, ...o.assets[0].rejectIf!])
    assert.ok(!c.prompts.s1.includes(rule));
  assert.deepEqual(c.reviewData.assets[0], o.assets[0]);
  assert.equal(JSON.stringify(o), before);
});

test("scope follows the owning type rather than filtering particular words", () => {
  const o = scopedFixture();
  const localRule = "不得出现红色茶杯";
  o.assets[0].rejectIf = [localRule];
  assert.ok(!compileOntology(o).prompts.s1.includes(localRule));
  o.shots[0].rejectIf.push(localRule);
  assert.ok(compileOntology(o).prompts.s1.includes(localRule));
});

test("the oral teaching shot retains location, stable action and sourced medical limits", () => {
  const o = JSON.parse(readFileSync(new URL("../examples/lupus-v6.json", import.meta.url), "utf8")) as Ontology;
  const c = compileOntology(o), s = o.shots.find(s => s.id === "S05")!;
  assert.match(c.prompts.S05, /口腔上腭/);
  assert.match(c.prompts.S05, /病灶位置与大小稳定/);
  assert.match(c.prompts.S05, /无白球生长或形变/);
  assert.match(c.prompts.S05, /普通阿弗他图不可标作典型SLE/);
  assert.match(c.prompts.S05, /事实边界/);
  for (const id of s.evidenceIds) assert.ok(c.prompts.S05.includes(id));
  for (const constraint of [...s.mustShow, ...s.rejectIf])
    assert.ok(c.prompts.S05.includes(constraint));
});

test("the corrected compiled prompt changes shot/image hashes while preserving the asset brief", () => {
  const o = scopedFixture(), c = compileOntology(o), images = imageTargetHashes(o);
  assert.notEqual(c.shotHashes.s1, legacyShotHash);
  assert.notEqual(images.s1, legacyShotImageHash);
  assert.equal(images["empty-room"], legacyAssetImageHash);
});

test("a queued pre-fix compiler snapshot cannot submit under corrected current approval", async () => {
  const t = tempStore();
  try {
    const o = scopedFixture(), p = t.store.create("scope test", requirements, o);
    const f = t.store.addFile(p.id, "room.png", "image/png", roomBytes);
    o.assets[0].fileId = f.id;
    const current = t.store.edit(p.id, p.revision, { ontology: o });
    t.store.review(p.id, "empty-room", "pass", "synthetic asset approved");
    t.store.review(p.id, "s1", "pass", "corrected current shot approved");
    let submits = 0;
    const jobs = new Jobs(t.store, {
      capabilities: () => ({}),
      videoSpec: () => ({provider:"seedance",model:"fixture",baseUrl:"https://provider.example",protocol:"seedance-relay-v1",referenceMode:"first_frame",nativeAudio:true,maxSeconds:12,durationPolicy:"ceil-min4"}),
      submit: async () => { submits++; throw new Error("must not submit an old snapshot"); },
    } as any, mockMedia());
    jobs.stopped = true;
    const job = jobs.enqueueRun(p.id, current.revision, "legacy-compiler-snapshot").jobs[0];
    t.store.updateJob(job.id, {
      input: { ...job.input, generationHash: legacyShotHash },
    });
    jobs.stopped = false;
    await jobs.tick();
    jobs.stopped = true;
    assert.equal(submits, 0);
    assert.equal(t.store.job(job.id).attempts, 0);
    assert.equal(t.store.job(job.id).result?.errorCode, "stale_snapshot");
  } finally { t.close(); }
});
