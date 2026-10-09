# Implementation contract

Independent application. No production deployment or paid provider generation during implementation.
Canonical types: shared/types.ts. All persistence belongs to server/store.ts. Assets are content-addressed files; API paths never expose local paths.

## Module contracts
- shared/ontology.ts exports validateOntology(value): Issue[], compileOntology(ontology): Compiled, hash(value): string, createEmptyOntology(title, requirements): Ontology. compile returns issues/gaps even on invalid editable drafts; execution rejects errors. Target hashes use shot ID/asset ID/entity ID and `post`; shot generation hashes exclude subtitles/post but include transitive generation dependencies, referenced entities/evidence/anchor/media hashes. Full shot review hash includes all shot text. Imported template in examples/lupus-v6.json; no private paths or physician photo. Template references relative files under examples/assets.
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
- GET `/api/projects/:id/export` -> project ZIP; GET `/api/projects/:id/review.html` -> portable read-only HTML. POST `/api/import` multipart `file` -> Project. POST `/api/projects/:id/reviews/import` `{revision?,scriptSha256?,items,overall?}` -> Project; mismatches historical only.
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
