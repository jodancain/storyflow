/** Public production view: no provider handles, request bodies, private notes or original files. */
export interface PublicProductionCandidate {
  id: string; shotId?: string; kind: "video" | "voice" | "lipsync" | "graphic" | "final";
  fileId: string; url: string; mime: string; sha256: string; sourceHash: string;
  current: boolean; accepted: boolean; reviewed: boolean; createdAt: string;
  durationMs?: number; shotDurationMs?: number;
  voiceTrim?: { parentArtifactId: string; startMs: number; endMs: number };
}
export interface PublicProductionJob {
  id: string; shotId?: string; kind: string; state: string; stage: string;
  current: boolean; updatedAt: string; reason?: string; dependsOn: string[];
}
export interface PublicProduction {
  projectId: string; revision: number; jobs: PublicProductionJob[];
  candidates: PublicProductionCandidate[];
}
