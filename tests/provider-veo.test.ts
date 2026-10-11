import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { Providers, ProviderError } from "../server/providers.ts";
import type { ProviderConfig, VideoInput } from "../shared/types.ts";
const config:ProviderConfig={seedanceBase:"https://relay.example/v1",seedanceKey:"fixture-relay-secret",seedanceModel:"dreamina-seedance-2-0",videoModel:"veo-3.1-generate-001",falKey:"",falBase:"",opusBase:"",opusKey:"",opusModel:"",allowPrivate:true};
const input:VideoInput={prompt:"Reviewed speech and action",duration:3,fps:25,width:1080,height:1920,purpose:"video"};
const sha=(data:Buffer|string)=>createHash("sha256").update(data).digest("hex");
const json=(body:unknown)=>new Response(JSON.stringify(body),{headers:{"content-type":"application/json"}});

test("Veo download uses the documented accepted-task content route on the configured origin", async()=>{
 let calls=0;const bytes=Buffer.alloc(32);bytes.write("ftyp",4);
 const p=new Providers(config,{fetchImpl:(async(url,options)=>{
  calls++;assert.equal(String(url),"https://relay.example/v1/videos/accepted-veo-download/content");
  assert.equal(new Headers(options?.headers).get("authorization"),"Bearer fixture-relay-secret");
  return new Response(bytes,{headers:{"content-type":"video/mp4"}});
 }) as typeof fetch});
 const h=p.recoverHandle({provider:"veo",model:config.videoModel,baseUrl:config.seedanceBase,requestHash:"c".repeat(64)},"accepted-veo-download");
 const media=await p.download({state:"complete",url:"https://untrusted-alias.example/v1/videos/accepted-veo-download/content"},h);
 assert.deepEqual(media.bytes,bytes);assert.equal(calls,1);
});

test("Veo adapter submits one exact 1080p/8s first-frame payload after durable preparation",async()=>{
  let calls=0,prepared:any;
  const bytes=Buffer.from("synthetic approved first frame");
  const p=new Providers(config,{fetchImpl:(async(url,options)=>{
    calls++;assert.ok(prepared);assert.equal(String(url),"https://relay.example/v1/video/generations");assert.equal(options?.method,"POST");
    assert.equal(new Headers(options?.headers).get("authorization"),"Bearer fixture-relay-secret");
    assert.deepEqual(JSON.parse(String(options?.body)),{model:"veo-3.1-generate-001",prompt:input.prompt,duration:8,resolution:"1080p",aspect_ratio:"9:16",generate_audio:true,metadata:{personGeneration:"allow_adult",resizeMode:"pad"},image:`data:image/png;base64,${bytes.toString("base64")}`});
    assert.equal(prepared.requestHash,sha(String(options?.body)));
    return json({task_id:"veo-fixture-1",model:"upstream-reported-veo"});
  }) as typeof fetch});
  const spec=p.videoSpec(),cap=p.capabilities().seedance;
  assert.equal(cap.provider,"veo");assert.equal(cap.model,"veo-3.1-generate-001");assert.equal(cap.maxSeconds,8);
  const handle=await p.submit({...input,providerSpec:spec,firstImage:{id:"shot-start",sha256:sha(bytes),mime:"image/png",bytes},endImage:{id:"goal-only",sha256:"f".repeat(64)}},async receipt=>{prepared=receipt;});
  assert.equal(calls,1);assert.equal(handle.provider,"veo");assert.equal(handle.model,spec.model);assert.equal(handle.receipt.actualModel,"upstream-reported-veo");
  assert.deepEqual(prepared.providerSpec,spec);assert.equal(prepared.parameters.requestedDuration,3);assert.equal(prepared.parameters.providerDuration,8);assert.equal(prepared.parameters.resizeMode,"pad");
  assert.equal(prepared.referenceMode,"first_frame");assert.equal(prepared.ignoredReferences[0].reason,"relay_first_frame_only");
  assert.ok(!JSON.stringify(handle).includes(config.seedanceKey));
});

test("a changed frozen video model is rejected before durable preparation or HTTP submission",async()=>{
  let calls=0,prepared=0;
  const old=new Providers({...config,videoModel:""}).videoSpec();
  const p=new Providers(config,{fetchImpl:(async()=>{calls++;return json({task_id:"should-not-run"});}) as typeof fetch});
  await assert.rejects(()=>p.submit({...input,providerSpec:old},async()=>{prepared++;}),error=>error instanceof ProviderError && !error.uncertain && /configuration changed/.test(error.message));
  await assert.rejects(()=>p.submit({...input,duration:9},async()=>{prepared++;}),/8 seconds/);
  assert.equal(calls,0);assert.equal(prepared,0);
});

test("accepted Veo and Seedance identities survive later model switches without another POST",async()=>{
  const prepared={provider:"veo",baseUrl:config.seedanceBase,model:"veo-3.1-generate-001",requestHash:"a".repeat(64),referenceMode:"first_frame"};
  let calls=0;
  const p=new Providers({...config,videoModel:""},{fetchImpl:(async(url,options)=>{
    calls++;assert.equal(options?.method,undefined);assert.match(String(url),/video\/generations\/accepted-/);
    return json({status:"COMPLETED",result_url:"https://media.example/video.mp4"});
  }) as typeof fetch});
  const handle=p.recoverHandle(prepared,"accepted-veo-1");
  assert.equal(handle.provider,"veo");assert.equal(handle.model,"veo-3.1-generate-001");
  const result=await p.poll(handle);assert.equal(result.state,"complete");assert.equal(result.metadata.provider,"veo");assert.equal(result.metadata.actualModel,null);
  const switched=new Providers(config,{fetchImpl:(async(_url,options)=>{calls++;assert.equal(options?.method,undefined);return json({status:"FAILED"});}) as typeof fetch});
  const oldHandle=switched.recoverHandle({...prepared,provider:"seedance",model:config.seedanceModel},"accepted-seedance-1");
  assert.equal(oldHandle.provider,"seedance");assert.equal(oldHandle.model,config.seedanceModel);
  assert.match((await switched.poll(oldHandle)).error!,/^Seedance/);
  assert.match((await switched.poll(handle)).error!,/^Veo/);assert.equal(calls,3);
});
