export type EntityType =
  | "character"
  | "scene"
  | "prop"
  | "action"
  | "medical-fact";
export interface Entity {
  id: string;
  type: EntityType;
  label: string;
  attributes: Record<string, string | number | boolean>;
  evidenceIds: string[];
  fictional?: boolean;
}
export interface Evidence {
  id: string;
  title: string;
  url?: string;
  excerpt: string;
  locator?: string;
}
export interface ImageAttemptHistory {
  origin: "external-history";
  state: "failed" | "blocked";
  code: string;
  submitted: boolean;
  reason: string;
  modelRequested?: string;
  modelActual?: string | null;
  blockingParent?: string;
  sourceStoryHash?: string;
  imagePostNumber?: number;
}
export interface ImageBinding {
  artifactId: string;
  fileId: string;
  sha256: string;
}
export interface ImageRequalificationInput {
  artifactId: string;
  sha256: string;
  oldBriefHash: string;
  newBriefHash: string;
  note: string;
}
export interface ImageRequalificationRecord extends ImageRequalificationInput {
  schema: "storyflow-image-requalification-v1";
  scope: "unchanged-ontology-compiler-review";
  id: string;
  at: string;
  baseRevision: number;
  revision: number;
  actionKey: string;
  actionInputHash: string;
  targetId: string;
  sourceHash: string;
  ontologyHash: string;
  originalAdoption: Record<string, unknown>;
  originalApproval: { accepted: true; reviewedAt: unknown; reviewNote: unknown };
  lineage: Record<string, unknown>;
  lineageHash: string;
}
export interface ImageTarget {
  assetId?: string;
  shotId?: string;
  prompt?: string;
  referenceAssetIds?: string[];
}
export type CharacterVisibility = "face" | "body" | "hands" | "shoulder";
export interface CharacterIdentity {
  characterId: string;
  identityAssetId: string;
  /** Original human-authorized photo required only when creating this identity master. */
  referenceSourceAssetId?: string;
  visibility: "person" | "hands-only";
  appearance: string;
  wardrobes: { id: string; description: string }[];
}
export interface ImageComposition {
  /** This is an allowlist; an empty array means no identifiable person in frame. */
  visibleCharacters: {
    characterId: string;
    wardrobeId: string;
    visibility: CharacterVisibility;
  }[];
}
export interface ImageConsistency {
  version: 1;
  enforceApprovedIdentity: true;
  characters: CharacterIdentity[];
}
export interface Asset {
  imageComposition?: ImageComposition;
  imageAttempt?: ImageAttemptHistory;
  previewImage?: ImageBinding;
  id: string;
  label: string;
  kind: "image" | "video" | "audio" | "document" | "graphic";
  purpose: "reference" | "production";
  fileId?: string;
  sha256?: string;
  gap: boolean;
  source?: { url?: string; author?: string; license?: string; use?: string };
  mustShow?: string[];
  rejectIf?: string[];
}
export interface Anchor {
  id: string;
  entityId: string;
  assetId: string;
  state: string;
  role: "identity" | "start" | "end";
}
export interface Relation {
  id: string;
  type:
    | "part_of"
    | "located_in"
    | "holds"
    | "depicts"
    | "supported_by"
    | "depends_on";
  from: string;
  to: string;
  projection?: "together" | "sequence" | "footnote";
}
export interface Dialogue {
  id: string;
  speakerId: string;
  text: string;
  startFrame?: number;
  endFrame?: number;
}
export interface Caption {
  id: string;
  startFrame: number;
  endFrame: number;
  text: string;
}
export interface Shot {
  imageComposition?: ImageComposition;
  imageAttempt?: ImageAttemptHistory;
  reviewImage?: ImageBinding;
  firstFrameImage?: ImageBinding;
  id: string;
  title: string;
  startFrame: number;
  endFrame: number;
  entityIds: string[];
  requiredAssetIds: string[];
  evidenceIds: string[];
  action: string;
  startState: string;
  endState: string;
  scale: string;
  camera: string;
  dialogue: Dialogue[];
  subtitles: Caption[];
  dependencies: string[];
  route: "seedance" | "doctor" | "graphic";
  prompt: string;
  firstAnchorId?: string;
  endAnchorId?: string;
  mustShow: string[];
  rejectIf: string[];
}
export interface GraphicElement {
  type: "text" | "rect" | "circle" | "arrow";
  text?: string;
  x: number;
  y: number;
  w?: number;
  h?: number;
  color: string;
  size?: number;
  startFrame: number;
  endFrame: number;
  fadeFrames?: number;
}
export interface PostProgram {
  version: 1;
  elements: GraphicElement[];
}
export interface Ontology {
  schemaVersion: 1;
  title: string;
  spec: { fps: 24 | 25; width: number; height: number; totalFrames: number };
  entities: Entity[];
  relations: Relation[];
  assets: Asset[];
  anchors: Anchor[];
  evidence: Evidence[];
  shots: Shot[];
  imageConsistency?: ImageConsistency;
  postProgram?: PostProgram;
}
export interface Requirements {
  topic: string;
  audience: string;
  duration: number;
  aspect: "9:16" | "16:9";
  fps: 24 | 25;
  style: string;
  doctorMode: "fictional" | "photo";
  sound: string;
  brief: string;
}
export interface Issue {
  path: string;
  code: string;
  message: string;
  severity: "error" | "warning";
}
export interface TaskPlan {
  id: string;
  kind: "video" | "voice" | "lipsync" | "graphic" | "compose";
  shotId?: string;
  dependsOn: string[];
  input: Record<string, unknown>;
}
export interface Compiled {
  hash: string;
  shotHashes: Record<string, string>;
  postHash: string;
  targetHashes: Record<string, string>;
  issues: Issue[];
  gaps: { assetId: string; shotIds: string[]; reason: string }[];
  tasks: TaskPlan[];
  graph: {
    nodes: { id: string; label: string; kind: string }[];
    edges: { from: string; to: string }[];
  };
  reviewData: Ontology;
  prompts: Record<string, string>;
  subtitles: Caption[];
}
export interface ImportedOpinion {
  sourceProjectId?: string;
  sourceRevision?: number;
  snapshotHash?: string;
  targetHash?: string;
  imageSha256?: string;
  imageId?: string;
  originalStatus: "pending" | "pass" | "change";
  match: "current" | "image-only" | "historical";
}
export interface Review {
  imported?: ImportedOpinion;
  targetId: string;
  targetHash: string;
  status: "pending" | "pass" | "change";
  note: string;
  updatedAt: string;
}
export interface FileRecord {
  id: string;
  projectId: string;
  name: string;
  mime: string;
  sha256: string;
  bytes: number;
  relativePath: string;
  text?: string;
  metadata?: Record<string, unknown>;
  createdAt: string;
}
export interface Artifact {
  id: string;
  projectId: string;
  jobId: string;
  shotId?: string;
  kind: "image" | "video" | "voice" | "lipsync" | "graphic" | "final";
  assetId?: string;
  fileId: string;
  sourceHash: string;
  audioFileId?: string;
  audioHash?: string;
  accepted: boolean;
  metadata: Record<string, unknown>;
  createdAt: string;
}
export interface Project {
  id: string;
  revision: number;
  name: string;
  requirements: Requirements;
  ontology: Ontology;
  reviews: Review[];
  files: FileRecord[];
  artifacts: Artifact[];
  jobs: Job[];
  compiled: Compiled;
  imageTargetHashes?: Record<string,string>;
  imageCandidateCurrent?: Record<string,boolean>;
  createdAt: string;
  updatedAt: string;
}
export type JobState =
  | "queued"
  | "running"
  | "waiting_review"
  | "blocked"
  | "uncertain"
  | "failed"
  | "complete"
  | "cancelled";
export interface Job {
  id: string;
  projectId: string;
  runId: string;
  kind:
    | "image"
    | "expand"
    | "post-plan"
    | "video"
    | "voice"
    | "lipsync"
    | "graphic"
    | "compose";
  shotId?: string;
  state: JobState;
  stage: string;
  progress: number;
  error?: string;
  dependsOn: string[];
  inputHash: string;
  input: any;
  handle?: ProviderHandle;
  result?: any;
  attempts: number;
  createdAt: string;
  updatedAt: string;
}
export interface ProviderHandle {
  provider: "seedance" | "veo" | "fal";
  id: string;
  baseUrl: string;
  model: string;
  requestHash: string;
  receipt: Record<string, unknown>;
}
export interface VideoInput {
  providerSpec?: VideoProviderSpec;
  prompt: string;
  duration: number;
  fps: number;
  width: number;
  height: number;
  firstImage?: { bytes: Buffer; mime: string; id: string; sha256: string };
  endImage?: { id: string; sha256: string };
  audio?: { bytes: Buffer; mime: string; id: string; sha256: string };
  purpose: "video" | "voice" | "lipsync";
}
export interface ImageInput {
  prompt: string;
  width: number;
  height: number;
  references: {assetId: string; fileId: string; sha256: string; mime: string; bytes: Buffer}[];
}
export interface ImageReceipt {
  url?: string;
  bytes?: Buffer;
  mime?: string;
  metadata: Record<string, unknown>;
}
export interface ProviderConfig {
  videoModel?: string;
  imageBase?: string;
  imageKey?: string;
  imageModel?: string;
  seedanceBase: string;
  seedanceKey: string;
  seedanceModel: string;
  falKey: string;
  falBase: string;
  opusBase: string;
  opusKey: string;
  opusModel: string;
  allowPrivate?: boolean;
}
export interface VideoProviderSpec {
  provider: "seedance" | "veo";
  model: string;
  baseUrl: string;
  protocol: "seedance-relay-v1" | "veo31-relay-v1";
  referenceMode: "first_frame";
  nativeAudio: true;
  maxSeconds: number;
  durationPolicy: "ceil-min4" | "fixed8-1080p";
}
export interface MediaClip {
  path: string;
  startFrame: number;
  endFrame: number;
  sourceInSeconds: number;
  audioPath?: string;
  muted?: boolean;
}
