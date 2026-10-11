import test from "node:test";
import assert from "node:assert/strict";
import { videoProfile, relayVideoBody, sameVideoProfile } from "../server/video-profile.ts";
import type { ProviderConfig, VideoInput } from "../shared/types.ts";
const config: ProviderConfig = {seedanceBase:"https://relay.example/v1",seedanceKey:"fixture",seedanceModel:"dreamina-seedance-2-0",falKey:"",falBase:"",opusBase:"",opusKey:"",opusModel:""};
const input: VideoInput = {prompt:"Reviewed speech and action",duration:3,fps:25,width:1080,height:1920,purpose:"video"};
test("Veo profile is explicit, credential-free and separate from content",()=>{
 const spec=videoProfile({...config,videoModel:"veo-3.1-generate-001"});
 assert.equal(spec.provider,"veo");assert.equal(spec.maxSeconds,8);
 assert.equal(JSON.stringify(spec).includes("fixture"),false);
 assert.equal(sameVideoProfile(spec,videoProfile({...config,videoModel:"veo-3.1-fast-generate-001"})),false);
 assert.equal(sameVideoProfile(spec,{...spec,baseUrl:"https://other.example/v1"}),false);
 assert.equal(sameVideoProfile(spec,{...spec}),true);
 assert.throws(()=>videoProfile({...config,videoModel:"veo-unknown"}),/Unsupported/);
});
test("Veo uses actual relay fields with native audio, full image and separate edit duration",()=>{
 const spec=videoProfile({...config,videoModel:"veo-3.1-generate-001"});
 const result=relayVideoBody(spec,input,"data:image/jpeg;base64,Zml4dHVyZQ==");
 assert.deepEqual(result.body,{model:spec.model,prompt:input.prompt,duration:8,resolution:"1080p",aspect_ratio:"9:16",generate_audio:true,metadata:{personGeneration:"allow_adult",resizeMode:"pad"},image:"data:image/jpeg;base64,Zml4dHVyZQ=="});
 assert.equal(input.duration,3);assert.throws(()=>relayVideoBody(spec,{...input,duration:9}),/duration/);
 assert.equal("image" in relayVideoBody(spec,{...input,purpose:"voice"}).body,false);
});
test("existing Seedance payload is unchanged and model switch is detectable",()=>{
 const spec=videoProfile(config),result=relayVideoBody(spec,input,"data:image/png;base64,Zml4dHVyZQ==");
 assert.deepEqual(result.body,{model:config.seedanceModel,prompt:input.prompt+"\n--ratio 9:16 --duration 4",metadata:{generate_audio:true,return_last_frame:true},image:"data:image/png;base64,Zml4dHVyZQ=="});
 assert.equal(sameVideoProfile(spec,videoProfile({...config,videoModel:"veo-3.1-generate-001"})),false);
});
