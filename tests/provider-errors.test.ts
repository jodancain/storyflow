import test from "node:test";
import assert from "node:assert/strict";
import { Providers, ProviderError } from "../server/providers.ts";
import { Jobs } from "../server/jobs.ts";
import type { ProviderConfig, VideoInput } from "../shared/types.ts";
import { tempStore, fixture, requirements, mockMedia } from "./helpers.ts";

const config:ProviderConfig={seedanceBase:"https://relay.example/v1",seedanceKey:"fixture-secret-relay-key",seedanceModel:"fixture-video",falBase:"https://queue.example",falKey:"fixture-secret-fal-key",opusBase:"https://opus.example",opusKey:"fixture-secret-opus-key",opusModel:"fixture-opus",imageBase:"https://image.example/v1",imageKey:"fixture-secret-image-key",imageModel:"fixture-image",allowPrivate:true};
const input:VideoInput={prompt:"Reviewed private prompt must not be echoed",duration:4,fps:25,width:1080,height:1920,purpose:"video"};
function client(handler:()=>Response) {
  let calls=0;
  return {provider:new Providers(config,{fetchImpl:(async()=>{calls++;return handler();}) as typeof fetch}),get calls(){return calls;}};
}
const json=(data:unknown,status=400,headers:Record<string,string>={})=>new Response(JSON.stringify(data),{status,headers:{"content-type":"application/json",...headers}});
async function failure(p:Providers, run=()=>p.submit(input,async()=>{})):Promise<ProviderError> {
  try { await run(); throw new Error("expected provider failure"); } catch(error) { assert.ok(error instanceof ProviderError);return error; }
}

test("rejected JSON preserves only bounded code/type/request id; arbitrary text and headers are dropped",async()=>{
  const c=client(()=>json({error:{code:"model_not_found",type:"invalid_request_error",message:`secret ${config.seedanceKey}: ${input.prompt}`,param:"https://private.example/token",nested:{authorization:config.falKey}},request_id:"req_1234abcdefgh",prompt:input.prompt,headers:{Authorization:config.opusKey}},400,{"x-request-id":"req_HEADERSECRET0001"}));
  const error=await failure(c.provider);
  assert.equal(error.code,"http_400");assert.equal(error.uncertain,false);
  assert.deepEqual(error.diagnostic,{status:400,upstreamCode:"model_not_found",upstreamType:"invalid_request_error",requestId:"req_1234abcdefgh"});
  assert.match(error.message,/code=model_not_found; type=invalid_request_error; request_id=req_1234abcdefgh/);
  const saved=`${error.message} ${JSON.stringify(error)}`;
  for(const privateValue of [config.seedanceKey,config.falKey,config.opusKey,input.prompt,"private.example","HEADERSECRET"]) assert.ok(!saved.includes(privateValue));
  assert.equal(c.calls,1);
});

test("malicious identifiers, credentials, nested values, non-JSON and long error bodies are never reflected",async()=>{
  const bodies:Response[]=[
    json({error:{code:config.seedanceKey,type:"token_123456789012"},request_id:`req_${Buffer.from(config.falKey).toString("hex")}`}),
    json({error:{code:Buffer.from(config.imageKey!).toString("base64url"),type:"https://evil.example"},request_id:"https://evil.example/private"}),
    json({error:{code:"<script>alert(1)</script>",type:{secret:config.opusKey}},request_id:{secret:config.falKey}}),
    json({error:{code:"x".repeat(65),type:"x".repeat(65)},request_id:"req_"+"x".repeat(100)}),
    json({error:{code:input.prompt,type:"bad\nheaders: Authorization"},request_id:"req_sk-1234567890"}),
    json({error:{code:"AKIA1234567890123456",type:"secret_123456789"},request_id:"req_private_123456"}),
    new Response(`<html>secret ${config.seedanceKey}</html>`,{status:400,headers:{"content-type":"text/html","x-request-id":"req_not_read_from_header"}}),
    json({error:{code:"model_not_found",message:"x".repeat(16385)}}),
    json({error:{code:"model_not_found"}},400,{"content-length":"9000000"}),
    json([{error:{code:"model_not_found"}}]),
  ];
  for(const response of bodies) {
    const c=client(()=>response),error=await failure(c.provider);
    assert.equal(error.message,"Provider HTTP 400");assert.deepEqual(error.diagnostic,{status:400});assert.equal(error.uncertain,false);assert.equal(c.calls,1);
  }
});

test("a streamed error body stops at 16 KiB without replacing HTTP acceptance classification",async()=>{
  let cancelled=0;
  const stream=new ReadableStream<Uint8Array>({pull(controller){controller.enqueue(new TextEncoder().encode("x".repeat(8193)));},cancel(){cancelled++;}});
  const c=client(()=>new Response(stream,{status:503})),error=await failure(c.provider);
  assert.equal(error.code,"http_503");assert.equal(error.uncertain,true);assert.deepEqual(error.diagnostic,{status:503});assert.equal(cancelled,1);assert.equal(c.calls,1);
});

test("HTTP 400 is rejected while POST 408/429/5xx remain uncertain with or without readable diagnostics",async()=>{
  for(const status of [400,401,403,404,408,422,429,500,502,503]) {
    const c=client(()=>json({error:{code:"InvalidParameter.Image",type:"invalid_request_error"},requestId:"71e22c42-fc44-4f77-87ae-67805ba37824"},status));
    const error=await failure(c.provider);
    assert.equal(error.code,`http_${status}`);assert.equal(error.uncertain,status>=500 || [408,429].includes(status));assert.equal(c.calls,1);
    assert.equal(error.diagnostic?.upstreamCode,"InvalidParameter.Image");
    assert.equal(error.diagnostic?.requestId,"71e22c42-fc44-4f77-87ae-67805ba37824");
  }
});

test("image and planning rejection paths share bounded diagnostics and make one POST only",async()=>{
  const imageClient=client(()=>json({error:{code:"invalid_size",type:"invalid_request_error"}},400));
  let prepared=0,received=0;
  const error=await failure(imageClient.provider,()=>imageClient.provider.generateImage({prompt:"fixture image",width:1080,height:1920,references:[]},async()=>{prepared++;},async()=>{received++;}) as any);
  assert.equal(error.message,"Image provider HTTP 400 [code=invalid_size; type=invalid_request_error]");assert.equal(error.uncertain,false);assert.equal(prepared,1);assert.equal(received,0);assert.equal(imageClient.calls,1);
  const planningClient=client(()=>json({error:{type:"overloaded_error",message:config.opusKey},request_id:"req_1234abcdefgh"},503));
  const planning=await failure(planningClient.provider,()=>planningClient.provider.planPost(fixture(),{}) as any);
  assert.equal(planning.message,"Anthropic HTTP 503 [type=overloaded_error; request_id=req_1234abcdefgh]");assert.equal(planning.uncertain,true);assert.equal(planningClient.calls,1);
});

test("durable job error records safe rejection diagnosis and never retries failed or uncertain POST automatically",async()=>{
  for(const status of [400,503]) {
    const t=tempStore(),c=client(()=>json({error:{code:"model_not_found",type:"invalid_request_error",message:config.seedanceKey},request_id:"req_1234abcdefgh"},status));
    try {
      const p=t.store.create("diagnostic fixture",requirements,fixture());t.store.review(p.id,"s1","pass","");
      const jobs=new Jobs(t.store,c.provider,mockMedia());jobs.stopped=true;
      const run=jobs.enqueueRun(p.id,p.revision,`diagnostic-${status}`);jobs.stopped=false;await jobs.tick();await jobs.tick();jobs.stopped=true;
      const stored=t.store.job(run.jobs[0].id);
      assert.equal(stored.state,status === 400 ? "failed" : "uncertain");
      assert.equal(stored.result.errorCode,`http_${status}`);assert.match(stored.error!,/code=model_not_found/);assert.match(stored.error!,/request_id=req_1234abcdefgh/);
      assert.ok(!stored.error!.includes(config.seedanceKey));assert.equal(c.calls,1);
    } finally {t.close();}
  }
});
