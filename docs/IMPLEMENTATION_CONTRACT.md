# Implementation contract

Independent application. v0.2 authorizes the bounded V6 still-image batch and publication of the existing static review page; no independent-app production deployment, video/audio generation, or automatic repeat submissions. The v0.1 no-paid-generation validation remains historical evidence.
Canonical types: shared/types.ts. All persistence belongs to server/store.ts. Assets are content-addressed files; API paths never expose local paths.

## Module contracts
- shared/ontology.ts exports validateOntology(value): Issue[], compileOntology(ontology): Compiled, hash(value): string, createEmptyOntology(title, requirements): Ontology. compile returns issues/gaps even on invalid editable drafts; execution rejects errors. Target hashes use shot ID/asset ID/entity ID and `post`; shot generation hashes exclude subtitles/post but include transitive generation dependencies, referenced entities/evidence/anchor/media hashes. Full shot review hash includes all shot text. Imported template in examples/lupus-v6.json; no private paths or original physician photo. Explicitly authorized v0.2 AI-derived physician candidates may be included, unapproved. Template references relative files under examples/assets.
- server/providers.ts exports Providers class constructor(config, {fetchImpl?}?). capabilities(), submit(input:VideoInput,onPrepared:(receipt)=>Promise<void>):Promise<ProviderHandle>, poll(handle):Promise<{state:'running'|'complete'|'failed';url?:string;error?:string;metadata?:any}>, download(result,handle):Promise<{bytes:Buffer;mime:string}>, expand(requirements,context,currentOntology):Promise<Ontology>, planPost(ontology,context):Promise<PostProgram>. ProviderError has uncertain:boolean. No SDK POST retries. No automatic model fallback. Native Anthropic Opus; relay Seedance first-frame + native audio; fal queue OmniHuman 1.5. No credentials in receipts/errors.
- server/media.ts exports probe(path), extractAudio(input,output), extractFrame(input,output,seconds), composeMedia({clips:MediaClip[],ontology:Ontology,output:string,workDir:string}):Promise<any>. Validate source duration, exact integer fps/frame coverage; graphics are bounded declarative data only. Renderer supports PostProgram and subtitles. Never eval model scripts. Paths provided by trusted store. Multimedia subprocesses asynchronous; scheduler serializes.

## HTTP contract for UI
Responses JSON errors `{error,code?,issues?}`. Auth cookies HttpOnly, same-origin writes. `/api/auth` GET -> `{setupRequired,authenticated}`; POST `/api/auth/setup` or `/api/auth/login` `{password}`; POST logout. GET `/api/config` -> capabilities/version, never keys.
- GET/POST `/api/projects`; POST `{name,requirements,template?:'lupus-v6'}` -> Project.
- GET `/api/projects/:id` -> Project. PATCH `{baseRevision,name?,requirements?,ontology?}` -> Project; conflict409.
- GET `/api/projects/:id/revisions` -> array snapshots metadata. GET `/revisions/:revision` -> snapshot.
- POST `/api/projects/:id/compile` -> Compiled. POST `/expand` `{baseRevision,idempotencyKey}` -> Job. POST `/post-plan` same.
- POST `/api/projects/:id/files` multipart `files` -> FileRecord[]. GET `/api/files/:id` authenticated download/Range; `?download=1` attachment.
- POST `/api/projects/:id/assets/bind` `{baseRevision,assetId,fileId}` -> Project. Bind updates ontology asset hash.
- PUT `/api/projects/:id/reviews` `{targetId,targetHash,status,note}` -> Project. targets are entities/assets/shots and `post`; all use current compiled.targetHashes.
- POST `/api/projects/:id/runs` `{baseRevision,idempotencyKey,shotIds?:string[]}` -> `{runId,jobs}`. Explicit submission gate checks current shot/asset approval. POST `/compose` `{baseRevision,idempotencyKey}` -> Job.
- POST `/api/jobs/:id/cancel` -> Job; POST `/api/jobs/:id/retry` `{idempotencyKey}` -> Job (uncertain cannot retry). GET `/api/jobs/:id` -> Job.
- POST `/api/artifacts/:id/review` `{accepted:boolean,note?:string}` -> Project. POST `/api/artifacts/:id/select` `{sourceInSeconds?:number}` -> Project; only accepted current-hash media selectable.
- GET `/api/projects/:id/export` -> project ZIP; GET `/api/projects/:id/review.html` -> fixed read-only HTML with local opinion drafts; GET `/api/projects/:id/review-snapshot` -> shareable static ZIP with safe view model and referenced images only. POST `/api/import` multipart `file` -> Project. POST `/api/projects/:id/reviews/import` `{revision?,scriptSha256?,items,overall?}` -> Project; mismatches historical only.
- GET `/api/references/search?q=...&source=commons|pubmed` -> `{items:[{id,title,url,image?,author?,license?,excerpt?}],source}`. POST `/api/projects/:id/references` `{baseRevision,item}` -> Project.

UI polls project only when jobs active, preserves dirty editors on refresh. Four tabs requirements/expand/review/video; ontology JSON editing and object cards; inspectable real graph, source/receipt views, errors, local demo template; no fake progress. Default25fps1500frames portrait. Single admin.

## Additional operation contracts
- POST `/api/jobs/:id/reconcile` `{providerTaskId}` resumes an uncertain original task using its persisted provider/model/origin; cannot provide an arbitrary URL.
- POST `/api/jobs/:id/apply` `{baseRevision}` explicitly applies a completed model suggestion after concurrent edits. Same validation/ownership gate as automatic model output.
- POST `/api/projects/:id/artifacts/import` `{shotId,fileId,kind,audioFileId?}` registers existing media for review; `kind` is video, voice, lipsync or graphic. Graphic imports are rendered videos. Lipsync requires a same-shot/current-hash accepted voice artifact.
- `Store.project().compiled.postHash` and targetHashes.post additionally bind selected take IDs, source hashes, audio hashes and trim points. The standalone ontology compiler stays deterministic from ontology alone.
- Selecting a different take or in-point invalidates post approval. Replacing or withdrawing approved voice invalidates dependent lipsync.
- Accepted external tasks continue downloading their frozen historical results after a user edit; they cannot be approved/selected as current when generation hash differs.
- Terminal provider failures require an explicit new generation from the reviewed shot. Recovery retries always reuse accepted IDs.


## v0.2 image interfaces

- `ImageBinding = {artifactId,fileId,sha256}`. `Asset.previewImage` and `Shot.reviewImage` are display bindings. `Shot.firstFrameImage` and asset production `fileId/sha256` are input bindings. Optional fields keep v0.1 projects loadable; no inferred AI provenance for pre-existing imported files.
- `ImageTarget = {assetId?:string,shotId?:string,prompt?:string,referenceAssetIds?:string[]}`. Exactly one target ID; reference assets must belong to the same project, exist as images and pass hash checks. Maximum16 references and52 unique targets per API batch.
- POST `/api/projects/:id/image-generations` `{baseRevision,idempotencyKey,targets:ImageTarget[]}` -> `{runId,jobs}`. Persist intent before external POST. New jobs/artifacts use kind `image`; each artifact belongs to an asset or shot.
- POST `/api/artifacts/:id/review` `{accepted,note}` -> Project. Current image candidates only for acceptance; rejecting/storing history does not turn a pending image into an approved production asset.
- POST `/api/artifacts/:id/select` for images `{baseRevision,usage:'preview'|'production'}` -> Project. Preview allows current pending candidates but never changes video generation hashes. Production requires current accepted candidates and invalidates the affected dependent review/generation conditions.
- GET `/api/config` includes `capabilities.image` configured/model/reason/maxBatch; no secret values. Configuration: `IMAGE_BASE_URL`, `IMAGE_API_KEY`, `IMAGE_MODEL` (requested default `gpt-image-2`).
- `Project.imageTargetHashes` and `imageCandidateCurrent` are server-computed read models. The latter checks transitive parent freshness. UI checks are advisory; the store enforces currentness and ownership again.
- Image metadata includes `modelRequested`, `modelActual:null|string`, `parentAssets`, `requestHash`, `targetHash`, `reviewStatus`, `reviewNote`, original file/hash and optional crop data. Do not infer the actual model when the response omits it.
- `Providers.generateImage(input,onPrepared,onReceived)` makes one OpenAI-compatible `images/generations` or multipart `images/edits` POST with `n=1`. The raw response is durably saved before parsing/downloading. Recovery uses the stored receipt; acceptance unknown never automatically reposts.
- `imageAttempt` is explicitly `origin:'external-history'`, `state:'failed'|'blocked'`, `submitted:boolean` with code/reason and optional parent/model/provenance. It is not an executable Job and cannot show synthetic completion or retry progress.

## Public review and portable opinions

`server/public-review.ts` builds a safe allowlisted snapshot, using `src/review/projectSnapshot.ts` and `ReviewPresentation.tsx` shared with the app. `npm run build` emits app and review bundles. The static ZIP contains `index.html`, content-addressed image files and `public-manifest.json`; original private images and raw provider receipts are not exposed. A full project ZIP is a private migration package, not the public package.

Public draft JSON has `{schema:'storyflow-review-draft',projectId,revision,scriptSha256,items:[{targetId,targetHash,status,note,imageId?,imageSha256?}],overall}`. Opinions stay local until the reviewer downloads them. POST `/api/projects/:id/reviews/import` preserves provenance in `Review.imported`, including original status and `match:'current'|'image-only'|'historical'`. It never automatically approves the current server content; cross-Mac IDs may differ while image hashes still match. The administrator explicitly adopts text as pending review, then performs current approval.

Static local draft “pass” does not mutate the frozen snapshot's official approved count. Preview and production selection remain separate in both UI and API. No public page controls call provider services.


## v0.3 inline review contract (supersedes static-only interaction above)

- `POST /api/projects/:id/review-submissions` authenticated, `{baseRevision,idempotencyKey,items:[{targetId,targetHash,imageId,imageSha256,status:'pass'|'change',note}]}`. Validates every submitted snapshot before writes. Saves opinions and generation intents atomically. A pass does not create an image job; rejection needs a nonempty note. Returns `{submission,project,jobs}`; each submission item is `approved`, `queued` or `blocked` with an explicit reason.
- `GET /api/projects/:id/review-submissions` preserves administrator audit history. Client retries reuse an idempotency key; unknown provider acceptance is never automatically resubmitted.
- `STORYFLOW_PUBLIC_REVIEW_PROJECTS` explicitly allowlists published project IDs. Default is empty. `GET /api/public-review/:id`, image-only `/files/:fileId` and `/review/:id` expose the safe presentation only. Unlisted projects, original photos, API receipts, configuration and all writes remain authenticated.
- `STORYFLOW_PUBLIC_REVIEW_API_BASE` supports same-origin path proxies (default `/api`). Online HTML permits same-origin fetch in CSP; offline exports keep `connect-src 'none'` and never claim submission succeeded.
- `imageConsistency` and each target's `imageComposition` are typed ontology fields. Required approved identity images are placed first in the actual request and cannot be removed by the optional reference picker. Runtime gate and task submission snapshot are the source of truth, not a prompt promise.
- Source examples have `consistencyContract:'legacy-unverified'`: existing model outputs are retained without claiming generation under the new contract. A newly returned revision appears for review; production bindings remain explicit.
- SQLite migration002 stores review submissions. Project archives preserve sanitized submission history as non-executable evidence; full backups retain active jobs. Import never replays approvals, tasks or sessions.
