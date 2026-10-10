import { mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../server/store.ts";
import { createEmptyOntology } from "../shared/ontology.ts";
import type { Requirements, Ontology } from "../shared/types.ts";
export const requirements: Requirements = {
  topic: "虚构测试故事",
  audience: "测试观众",
  duration: 4,
  aspect: "9:16",
  fps: 25,
  doctorMode: "fictional",
  style: "合成测试",
  sound: "原声",
  brief: "",
};
export function fixture(doctor = false): Ontology {
  const o = createEmptyOntology(requirements.topic, requirements);
  o.entities = [
    {
      id: "hero",
      type: "character",
      label: "虚构角色",
      fictional: true,
      evidenceIds: [],
      attributes: {},
    },
  ];
  o.shots = [
    {
      id: "s1",
      title: "放下书本",
      startFrame: 0,
      endFrame: 100,
      entityIds: ["hero"],
      requiredAssetIds: [],
      evidenceIds: [],
      action: "放下书本",
      startState: "拿着书",
      endState: "书在桌上",
      scale: "中景",
      camera: "固定",
      dialogue: doctor
        ? [{ id: "line1", speakerId: "hero", text: "请保存这本书。" }]
        : [],
      subtitles: [],
      dependencies: [],
      route: doctor ? "doctor" : "seedance",
      prompt: "清晰自然",
      mustShow: [],
      rejectIf: [],
    },
  ];
  return o;
}
export function tempStore() {
  const dir = mkdtempSync(join(tmpdir(), "storyflow-test-"));
  const store = new Store(dir);
  return {
    store,
    dir,
    close() {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}
export function mockMedia() {
  return {
    fitImage: async (input: string, output: string, width: number, height: number) => {
      writeFileSync(output, readFileSync(input)); return {outputWidth:width,outputHeight:height,method:"test-mock"};
    },
    probe: async () => ({
      duration: 4,
      video: { frames: 100, fps: 25 },
      audio: {},
    }),
    extractAudio: async (_p: string, output: string) => {
      writeFileSync(output, Buffer.from("voice fixture"));
    },
    composeMedia: async ({ output }: any) => {
      writeFileSync(output, Buffer.from("composed fixture"));
      return { duration: 4, fps: 25, frames: 100, path: output };
    },
    renderGraphic: async ({ output }: any) => {
      writeFileSync(output, Buffer.from("graphic fixture"));
      return { duration: 4, path: output };
    },
  } as any;
}
