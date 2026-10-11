import test from "node:test";
import assert from "node:assert/strict";
import {createApp} from "../server/app.ts";
import {Jobs} from "../server/jobs.ts";
import {Providers} from "../server/providers.ts";
import {tempStore, mockMedia} from "./helpers.ts";

test("config exposes selected Volcano route without credentials and preserves the explicit legacy alias", async () => {
  const t=tempStore();
  const secret="synthetic-only-never-a-real-credential";
  const providers=new Providers({seedanceBase:"",seedanceKey:"",seedanceModel:"fixture",falBase:"https://queue.fal.run",falKey:"",opusBase:"",opusKey:"",opusModel:"fixture",lipsyncProvider:"volcano-omnihuman",volcanoAccessKeyId:"synthetic-access-id",volcanoSecretAccessKey:secret});
  const jobs=new Jobs(t.store,providers,mockMedia());
  jobs.stopped=true;
  t.store.setPassword("test-storyflow-password");
  const server=createApp(t.store,jobs,{dist:"/does-not-exist"}).listen(0,"127.0.0.1");
  await new Promise<void>(resolve=>server.once("listening",resolve));
  const origin=`http://127.0.0.1:${(server.address() as any).port}`;
  try {
    const login=await fetch(origin+"/api/auth/login",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({password:"test-storyflow-password"})});
    assert.equal(login.status,200);
    const response=await fetch(origin+"/api/config",{headers:{cookie:login.headers.get("set-cookie")!.split(";")[0]}});
    assert.equal(response.status,200);
    const raw=await response.text(), data=JSON.parse(raw);
    assert.equal(data.capabilities.lipsync.provider,"volcano-omnihuman");
    assert.equal(data.capabilities.lipsync.model,"jimeng_realman_avatar_picture_omni_v15");
    assert.equal(data.capabilities.lipsync.configured,true);
    assert.equal(data.capabilities.fal.legacyAliasFor,"lipsync");
    assert.equal(data.capabilities.fal.provider,"volcano-omnihuman");
    assert.ok(!raw.includes(secret)&&!raw.includes("synthetic-access-id"));
  } finally {
    jobs.stop();
    await new Promise<void>(resolve=>server.close(()=>resolve()));
    t.close();
  }
});
