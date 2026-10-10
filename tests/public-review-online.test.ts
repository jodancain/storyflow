import test from "node:test";
import assert from "node:assert/strict";
import { createApp } from "../server/app.ts";
import { Jobs } from "../server/jobs.ts";
import { Providers } from "../server/providers.ts";
import { imageTargetHash } from "../shared/ontology.ts";
import { tempStore, fixture, requirements, mockMedia } from "./helpers.ts";

test("only explicitly published review snapshots and referenced images are public; submissions stay authenticated", async () => {
  const t = tempStore(), o = fixture();
  o.assets.push({id:"face",label:"角色图",kind:"image",purpose:"production",gap:true});
  let p = t.store.create("公开审图", requirements, o);
  const hidden = t.store.create("私人项目", requirements, fixture());
  const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jFeYAAAAASUVORK5CYII=", "base64");
  const f = t.store.addFile(p.id,"candidate.png","image/png",png);
  const privateFile = t.store.addFile(p.id,"original.png","image/png",Buffer.from("PRIVATE ORIGINAL"));
  const artifact = t.store.addArtifact({projectId:p.id,jobId:"test",assetId:"face",kind:"image",fileId:f.id,sourceHash:imageTargetHash(o,{assetId:"face"}),metadata:{origin:"ai-generated",privateReceipt:"secret-receipt",localPath:"/Users/private/original.png"}});
  p = t.store.selectImage(artifact.id,p.revision,"preview");
  const providers = new Providers({imageBase:"",imageKey:"",imageModel:"fixture",opusBase:"",opusKey:"",opusModel:"fixture",seedanceBase:"",seedanceKey:"",seedanceModel:"fixture",falBase:"",falKey:""});
  const jobs = new Jobs(t.store,providers,mockMedia()); jobs.stopped=true;
  const app = createApp(t.store,jobs,{dist:"/missing",publicReviewProjectIds:[p.id],publicReviewApiBase:"/review-service/api"});
  const server = app.listen(0,"127.0.0.1"); await new Promise<void>(r=>server.once("listening",r));
  const base = `http://127.0.0.1:${(server.address() as any).port}`;
  try {
    const response = await fetch(`${base}/api/public-review/${p.id}`); assert.equal(response.status,200);
    const body = await response.json(); assert.equal(body.onlineReview.apiBase,"/review-service/api");
    assert.match(body.items[0].image.url,/^\/review-service\/api\/public-review\//);
    assert.doesNotMatch(JSON.stringify(body),/PRIVATE ORIGINAL|secret-receipt|\/Users\/private/);
    assert.equal((await fetch(`${base}/api/public-review/${hidden.id}`)).status,404);
    assert.equal((await fetch(`${base}/api/public-review/${p.id}/files/${privateFile.id}`)).status,404);
    const image = await fetch(`${base}/api/public-review/${p.id}/files/${f.id}`); assert.equal(image.status,200); assert.match(image.headers.get("content-type")!,/image\/png/);
    assert.equal((await fetch(`${base}/api/projects/${p.id}/review-submissions`,{method:"POST",headers:{"content-type":"application/json"},body:"{}"})).status,401);
    const html = await fetch(`${base}/review/${p.id}`); assert.equal(html.status,200); assert.match(html.headers.get("content-security-policy")!,/connect-src 'self'/); assert.match(await html.text(),/onlineReview/);
  } finally { await new Promise<void>(r=>server.close(()=>r())); t.close(); }
});
