import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { Providers, ProviderError } from "../server/providers.ts";
import { signVolcanoVisual, VOLCANO_OMNI, VOLCANO_VISUAL_BASE } from "../server/volcano-visual.ts";
import { publicReviewMediaUrl } from "../server/provider-media.ts";
import { imageTargetHash } from "../shared/ontology.ts";
import { tempStore, requirements, fixture } from "./helpers.ts";
import type { ProviderConfig, VideoInput } from "../shared/types.ts";

const config: ProviderConfig = {
  lipsyncProvider:"volcano-omnihuman", volcanoAccessKeyId:"fixture-volcano-access", volcanoSecretAccessKey:"fixture-volcano-secret",
  seedanceBase:"https://relay.example/v1", seedanceKey:"fixture-relay-secret", seedanceModel:"fixture",
  falBase:"https://queue.fal.run", falKey:"fixture-fal-secret", opusBase:"", opusKey:"", opusModel:"", allowPrivate:true,
};
const hash = (value: Buffer | string) => createHash("sha256").update(value).digest("hex");
const media = (kind:"image"|"audio") => {
  const bytes = Buffer.from(`fixture ${kind}`);
  return {bytes, mime:kind === "image" ? "image/png" : "audio/wav", id:kind, sha256:hash(bytes), publicUrl:`https://media.example/${kind}`};
};
const input = (): VideoInput => ({purpose:"lipsync", prompt:"医生自然说话，口型与审核音轨一致。", duration:5.8, fps:25, width:1080, height:1920, firstImage:media("image"), audio:media("audio")});
const json = (body:unknown, status=200) => new Response(JSON.stringify(body), {status, headers:{"content-type":"application/json"}});
const taskId = "7392616336519610409";
function client(handler:(url:string, options:RequestInit)=>Response|Promise<Response>, overrides:Partial<ProviderConfig>={}) {
  return new Providers({...config, ...overrides}, {fetchImpl:(async(url, options={}) => {
    const path=String(url);
    if (path.startsWith("https://media.example/")) {
      assert.equal(options.method, undefined); assert.equal(new Headers(options.headers).get("authorization"), null);
      return new Response(media(path.endsWith("image") ? "image" : "audio").bytes);
    }
    return handler(path, options);
  }) as typeof fetch});
}

test("visual signing fixes service, region, action and body hash without persisting credentials", () => {
  const body=JSON.stringify({req_key:VOLCANO_OMNI, task_id:taskId});
  const signed=signVolcanoVisual("CVGetResult", body, {accessKeyId:config.volcanoAccessKeyId!, secretAccessKey:config.volcanoSecretAccessKey!}, new Date("2026-10-11T01:02:03Z"));
  assert.equal(signed.url, `${VOLCANO_VISUAL_BASE}/?Action=CVGetResult&Version=2022-08-31`);
  assert.equal(signed.headers["x-date"], "20261011T010203Z");
  assert.equal(signed.headers["x-content-sha256"], hash(body));
  // Synthetic fixture, independently computed with Python hashlib/hmac from the official canonical request format.
  assert.ok(signed.headers.authorization.endsWith("Signature=404f4f8ba4585e53b611f562fd3c40b006b7c19259735454ca79bfb1a5098568"));
  assert.match(signed.headers.authorization, /^HMAC-SHA256 Credential=fixture-volcano-access\/20261011\/cn-north-1\/cv\/request, SignedHeaders=content-type;host;x-content-sha256;x-date, Signature=[a-f0-9]{64}$/);
  assert.notEqual(signVolcanoVisual("CVSubmitTask", body, {accessKeyId:config.volcanoAccessKeyId!,secretAccessKey:config.volcanoSecretAccessKey!}, new Date("2026-10-11T01:02:03Z")).headers.authorization, signed.headers.authorization);
  assert.notEqual(signVolcanoVisual("CVGetResult", "{}", {accessKeyId:config.volcanoAccessKeyId!,secretAccessKey:config.volcanoSecretAccessKey!}, new Date("2026-10-11T01:02:03Z")).headers.authorization, signed.headers.authorization);
  assert.ok(!signed.headers.authorization.includes(config.volcanoSecretAccessKey!));
});

test("Volcano verifies public bytes then durably freezes exact image/audio request before one signed POST", async () => {
  let prepared:any, posts=0;
  const p=client((url, options)=>{
    posts++; assert.ok(prepared); assert.equal(options.method,"POST");
    assert.equal(url,`${VOLCANO_VISUAL_BASE}/?Action=CVSubmitTask&Version=2022-08-31`);
    const body=JSON.parse(String(options.body));
    assert.deepEqual(body,{req_key:VOLCANO_OMNI,image_url:media("image").publicUrl,audio_url:media("audio").publicUrl,prompt:input().prompt,seed:-1,output_resolution:1080,pe_fast_mode:false});
    assert.equal(hash(String(options.body)),prepared.requestHash);
    assert.match(new Headers(options.headers).get("authorization")!,/cn-north-1\/cv\/request/);
    return json({code:10000,data:{task_id:taskId},request_id:"2026101112345678ABCD1234ABCD1234AB"});
  });
  const handle=await p.submit(input(),async receipt=>{prepared=receipt;});
  assert.equal(posts,1); assert.equal(handle.provider,"volcano-omnihuman"); assert.equal(handle.id,taskId);
  assert.equal(handle.receipt.modelActual,null);
  assert.equal((handle.receipt.audio as any).sha256,media("audio").sha256);
  assert.equal((handle.receipt.image as any).sha256,media("image").sha256);
  assert.deepEqual(handle.receipt.ignoredConditions,["requested_fps_not_supported","requested_width_height_not_sent"]);
  const saved=JSON.stringify(handle);
  for (const secret of [config.volcanoAccessKeyId!,config.volcanoSecretAccessKey!,config.falKey,config.seedanceKey]) assert.ok(!saved.includes(secret));
  assert.equal(p.capabilities().lipsync.provider,"volcano-omnihuman");
});

test("private, changed or oversized input URLs never reach generation POST or prepared intent", async () => {
  for (const variant of ["no-url","changed-local-hash","changed-public-hash","oversized","private-url"] as const) {
    let posts=0, prepared=0, fetches=0;
    const value=input();
    if(variant === "no-url") delete value.firstImage!.publicUrl;
    if(variant === "changed-local-hash") value.audio!.sha256="changed";
    if(variant === "private-url") value.firstImage!.publicUrl="http://127.0.0.1/private";
    const p=new Providers({...config,allowPrivate:variant !== "private-url"},{fetchImpl:(async(_url, options)=>{
      fetches++; if(options?.method === "POST") posts++;
      return variant === "oversized" ? new Response("bytes",{headers:{"content-length":String(21*1024*1024)}}) : new Response(Buffer.from("changed bytes"));
    }) as typeof fetch});
    await assert.rejects(()=>p.submit(value,async()=>{prepared++;}));
    assert.equal(posts,0); assert.equal(prepared,0);
    if(["no-url","changed-local-hash","private-url"].includes(variant)) assert.equal(fetches,0);
  }
});

test("Volcano acceptance ambiguity remains uncertain; explicit business rejection is bounded and never retried", async () => {
  const cases:[()=>Response,boolean,string][]=[
    [()=>json({code:10000,data:{}}),true,"missing_provider_id"],
    [()=>json({data:{task_id:taskId}}),true,"invalid_response"],
    [()=>json({code:50215,data:null,message:config.volcanoSecretAccessKey}),false,"volcano_rejected"],
    [()=>json({code:50215,data:{task_id:taskId}}),true,"invalid_response"],
    [()=>json({error:{code:"InternalError",message:config.volcanoSecretAccessKey}},503),true,"http_503"],
    [()=>{throw new Error(config.volcanoSecretAccessKey);},true,"connection_error"],
  ];
  for(const [response,uncertain,code] of cases) {
    let posts=0,prepared=0;
    const p=client(()=>{posts++;return response();});
    await assert.rejects(()=>p.submit(input(),async()=>{prepared++;}),(error:any)=>{
      assert.ok(error instanceof ProviderError);assert.equal(error.uncertain,uncertain);assert.equal(error.code,code);
      assert.ok(!JSON.stringify(error).includes(config.volcanoSecretAccessKey!));return true;
    });
    assert.equal(posts,1);assert.equal(prepared,1);
  }
});

test("Volcano recovers exact accepted identity and only polls even after default switches back to fal", async () => {
  let prepared:any;
  await client(()=>json({code:10000,data:{task_id:taskId}})).submit(input(),async value=>{prepared=value;});
  let polls=0;
  const p=client((url,options)=>{
    polls++; assert.equal(url,`${VOLCANO_VISUAL_BASE}/?Action=CVGetResult&Version=2022-08-31`);
    assert.deepEqual(JSON.parse(String(options.body)),{req_key:VOLCANO_OMNI,task_id:taskId});
    return json({code:10000,data:polls === 1 ? {status:"generating"} : {status:"done",video_url:"https://cdn.example/output.mp4",aigc_meta_tagged:true}});
  },{lipsyncProvider:"fal"});
  const handle=p.recoverHandle(prepared,taskId);
  assert.equal((await p.poll(handle)).state,"running");
  const complete=await p.poll(handle);
  assert.equal(complete.state,"complete");assert.equal(complete.metadata.modelReported,false);assert.equal(complete.metadata.actualModel,null);
  assert.equal(complete.metadata.audioBinding.sha256,media("audio").sha256);assert.equal(polls,2);
  for(const forged of [{...prepared,baseUrl:"https://attacker.example"},{...prepared,model:"other_model"}]) assert.throws(()=>p.recoverHandle(forged,taskId));
  assert.throws(()=>p.recoverHandle(prepared,"https://attacker.example/task"));
});

test("expired, missing, failed and mismatched Volcano tasks never trigger replacement submissions", async () => {
  const original=await client(()=>json({code:10000,data:{task_id:taskId}})).submit(input(),async()=>{});
  for(const status of ["expired","not_found","alien","mismatched","business-failed"]) {
    let polls=0;
    const p=client((url)=>{
      polls++;assert.match(url,/Action=CVGetResult/);
      return status === "business-failed" ? json({code:50413,message:"private provider text"}) : json({code:10000,data:{status:status === "mismatched" ? "done" : status, ...(status === "mismatched" ? {task_id:"other-task",video_url:"https://cdn.example/other.mp4"} : {})}});
    });
    if(["expired","not_found"].includes(status)) assert.equal((await p.poll(original)).state,"failed");
    else await assert.rejects(()=>p.poll(original));
    assert.equal(polls,1);
  }
});

test("frozen fal task continues on fal after switching default; no accidental Volcano submission", async () => {
  let calls=0;
  const p=client((url,options)=>{calls++;assert.equal(url,`${config.falBase}/fal-ai/bytedance/omnihuman/v1.5`);assert.match(new Headers(options.headers).get("authorization")!,/^Key /);return json({request_id:"fal-existing"});});
  const value=input();value.lipsyncSpec=p.lipsyncSpec("fal");
  assert.equal((await p.submit(value,async()=>{})).provider,"fal");assert.equal(calls,1);
  value.lipsyncSpec={...p.lipsyncSpec(),model:"changed"};
  await assert.rejects(()=>p.submit(value,async()=>{}),/configuration changed/);assert.equal(calls,1);
});

test("Volcano result download never forwards AK/SK or relay credentials, including redirect to visual origin", async () => {
  const handle=await client(()=>json({code:10000,data:{task_id:taskId}})).submit(input(),async()=>{});
  const mp4=Buffer.concat([Buffer.from([0,0,0,24]),Buffer.from("ftypisom"),Buffer.alloc(20)]);
  let calls=0;
  const p=client((_url,options)=>{
    calls++;const headers=new Headers(options.headers);
    assert.equal(headers.get("authorization"),null);assert.equal(headers.get("x-date"),null);
    return calls===1 ? new Response(null,{status:302,headers:{location:`${VOLCANO_VISUAL_BASE}/media.mp4`}}) : new Response(mp4,{headers:{"content-type":"video/mp4"}});
  });
  assert.deepEqual((await p.download({state:"complete",url:"https://cdn.example/output.mp4"},handle)).bytes,mp4);assert.equal(calls,2);
});

test("Volcano HTTP errors redact AK/SK and read only bounded official response metadata", async () => {
  for(const code of ["AccessDenied", config.volcanoAccessKeyId!, config.volcanoSecretAccessKey!]) {
    const p=client(()=>json({ResponseMetadata:{RequestId:"2026101112345678ABCD1234ABCD1234AB",Error:{Code:code,Message:`secret ${config.volcanoSecretAccessKey}`}}},403));
    await assert.rejects(()=>p.submit(input(),async()=>{}),(error:any)=>{
      assert.equal(error.uncertain,false);assert.ok(!error.message.includes(config.volcanoSecretAccessKey!));assert.ok(!error.message.includes(config.volcanoAccessKeyId!));
      assert.equal(error.diagnostic.upstreamCode,code === "AccessDenied" ? code : undefined);return true;
    });
  }
});

test("public provider media helper only reuses allowlisted review files, never original/upload-only files", () => {
  const t=tempStore(),o=fixture();o.assets.push({id:"face",label:"角色图",kind:"image",purpose:"production",gap:true});
  let project=t.store.create("公开图",requirements,o);
  try {
    const image=t.store.addFile(project.id,"candidate.png","image/png",Buffer.from("image"));
    const privateFile=t.store.addFile(project.id,"original.png","image/png",Buffer.from("private"));
    const voice=t.store.addFile(project.id,"voice.wav","audio/wav",Buffer.from("voice"));
    const options={publicBaseUrl:"https://public.example/review/",publicReviewApiBase:"/review-service/api",publicReviewProjectIds:[project.id]};
    const imageArtifact=t.store.addArtifact({projectId:project.id,jobId:"fixture",assetId:"face",kind:"image",fileId:image.id,sourceHash:imageTargetHash(o,{assetId:"face"}),metadata:{origin:"ai-generated"}});
    project=t.store.selectImage(imageArtifact.id,project.revision,"preview");
    const url=publicReviewMediaUrl(t.store,options,project.id,image.id);
    assert.equal(url,`https://public.example/review-service/api/public-review/${project.id}/files/${image.id}`);
    assert.equal(publicReviewMediaUrl(t.store,options,project.id,privateFile.id),undefined);
    assert.equal(publicReviewMediaUrl(t.store,options,project.id,voice.id),undefined);
    assert.equal(publicReviewMediaUrl(t.store,{...options,publicReviewProjectIds:[]},project.id,image.id),undefined);
    assert.equal(publicReviewMediaUrl(t.store,{...options,publicBaseUrl:"http://localhost:1234"},project.id,image.id),undefined);
    const sourceHash=project.compiled.shotHashes.s1;
    const job=t.store.addJob({projectId:project.id,runId:"voice-run",kind:"voice",shotId:"s1",dependsOn:[],inputHash:"voice",input:{generationHash:sourceHash}});
    const artifact=t.store.addArtifact({projectId:project.id,jobId:job.id,shotId:"s1",kind:"voice",fileId:voice.id,sourceHash,metadata:{}});
    t.store.updateJob(job.id,{state:"complete",stage:"complete",result:{artifactId:artifact.id}});
    assert.match(publicReviewMediaUrl(t.store,options,project.id,voice.id)!,/\/files\//);
  } finally {t.close();}
});
