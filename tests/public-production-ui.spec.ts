import { test, expect } from "@playwright/test";
import { readFileSync } from "node:fs";
import type { ReviewSnapshot } from "../src/review/projectSnapshot";
import type { PublicProduction } from "../shared/review-production";

test("公开生产区逐候选审核，保留原有图片草稿与手机布局", async({page},testInfo)=>{
  const snapshot:ReviewSnapshot={schemaVersion:1,projectId:"production-fixture",title:"明确标记的测试影片",revision:3,contentHash:"fixture-content",fps:25,totalFrames:1500,items:[],flow:[],evidence:[],onlineReview:{apiBase:"/api",projectId:"production-fixture"}};
  const data:PublicProduction={projectId:snapshot.projectId,revision:3,jobs:[{id:"video-job",shotId:"S01",kind:"video",state:"complete",stage:"complete",current:true,updatedAt:"2026-01-01",dependsOn:[]},{id:"lip-job",shotId:"S02",kind:"lipsync",state:"waiting_review",stage:"review_dependency",current:true,updatedAt:"2026-01-01",reason:"等待前置声音或镜头人工通过，审核后继续已排队任务。",dependsOn:[]}],candidates:[{id:"video-candidate",shotId:"S01",kind:"video",fileId:"video-file",url:"/fixture.mp4",mime:"video/mp4",sha256:"video-sha",sourceHash:"source-hash",current:true,accepted:false,reviewed:false,createdAt:"2026-01-01"},{id:"voice-candidate",shotId:"S02",kind:"voice",fileId:"voice-file",url:"/fixture.wav",mime:"audio/wav",sha256:"voice-sha",sourceHash:"voice-hash",current:true,accepted:false,reviewed:false,createdAt:"2026-01-01"}]};
  const storageKey=`storyflow-review:${snapshot.projectId}:${snapshot.contentHash}`, draft={baseRevision:3,drafts:{S01:{status:"pass",note:"原有审核评论",imageId:"image-1",imageSha256:"image-hash",targetHash:"target-hash"}}};
  data.candidates[1].durationMs=8000;data.candidates[1].shotDurationMs=5000;
  let authenticated=false; const posts:{id:string;body:any}[]=[],trims:any[]=[];
  await page.addInitScript(({storageKey,draft})=>localStorage.setItem(storageKey,JSON.stringify(draft)),{storageKey,draft});
  await page.route("**/api/**", async route=>{
    const path=new URL(route.request().url()).pathname, method=route.request().method();
    const json=(body:unknown,status=200)=>route.fulfill({status,contentType:"application/json",body:JSON.stringify(body)});
    if(path === "/api/auth") return json({authenticated});
    if(path === "/api/auth/login") {authenticated=true;return json({authenticated});}
    if(path.endsWith("/review-submissions")) return json({submissions:[]});
    if(path === `/api/public-review/${snapshot.projectId}`) return json(snapshot);
    if(path.endsWith("/production")) return json(data);
    if(method === "POST" && path.endsWith("/voice-trims")) {
      const body=route.request().postDataJSON();trims.push(body);
      if(!data.candidates.some(candidate=>candidate.id === "voice-cut")) data.candidates.push({...data.candidates[1],id:"voice-cut",fileId:"trimmed-file",sha256:"trimmed-sha",durationMs:5000,accepted:false,reviewed:false,voiceTrim:{parentArtifactId:"voice-candidate",startMs:body.startMs,endMs:body.endMs}});
      if(trims.length === 1) return json({error:"裁剪回执未收到，请重试同一区间。"},503);
      return json({artifactId:"voice-cut",accepted:false});
    }
    if(method === "POST" && path.endsWith("/review")) {
      const id=path.split("/").at(-2)!, body=route.request().postDataJSON(); posts.push({id,body});
      const candidate=data.candidates.find(c=>c.id===id)!;candidate.accepted=body.accepted;candidate.reviewed=true;
      return json(data);
    }
    return json({error:"fixture route absent"},404);
  });
  const script=readFileSync("dist-review/review.js","utf8"),styles=readFileSync("dist-review/review.css","utf8");
  await page.route(url=>url.pathname === "/production-fixture",route=>route.fulfill({contentType:"text/html",body:`<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>${styles}</style><div id="root"></div><script id="storyflow-snapshot" type="application/json">${JSON.stringify(snapshot)}</script><script>${script}</script></html>`}));
  await page.goto("/production-fixture#production");
  await expect(page.getByRole("heading",{name:"视频制作与产物审核"})).toBeVisible();
  await expect(page.locator("#production video")).toHaveAttribute("preload","none");
  await expect(page.locator("#production audio")).toHaveCount(1);
  await expect(page.getByRole("button",{name:"通过并继续下一镜"})).toHaveCount(0);
  await page.getByRole("button",{name:"登录审核视频与声音"}).click();
  await page.getByLabel("审核密码").fill("fixture-only-password");await page.getByRole("button",{name:"登录并继续审图",exact:true}).click();
  await page.getByLabel("S01 视频与原声审核意见").fill("动作和原声通过");
  await page.getByRole("button",{name:"通过并继续下一镜",exact:true}).click();
  await expect(page.locator("#production-video-candidate")).toContainText("已通过制作审核");
  expect(posts).toEqual([{id:"video-candidate",body:{accepted:true,note:"动作和原声通过",sourceHash:"source-hash",fileSha256:"video-sha"}}]);
  await page.getByRole("button",{name:"通过声音并制作口型"}).click();
  expect(posts[1].id).toBe("voice-candidate");expect(posts[1].body.fileSha256).toBe("voice-sha");
  const voiceCard=page.locator("#production-voice-candidate");
  await expect(voiceCard).toContainText("已通过制作审核");
  await voiceCard.getByText("明确选择声音区间",{exact:true}).click();
  await expect(voiceCard.getByLabel("voice-candidate开始秒数")).toHaveValue("");await expect(voiceCard.getByLabel("voice-candidate结束秒数")).toHaveValue("");
  await expect(voiceCard.getByRole("button",{name:"裁剪为新声音候选"})).toBeDisabled();
  await voiceCard.getByLabel("voice-candidate开始秒数").fill("0");await voiceCard.getByLabel("voice-candidate结束秒数").fill("6");
  await voiceCard.getByRole("button",{name:"裁剪为新声音候选"}).click();
  await expect(page.getByText("所选音轨区间长于镜头，请重新选择；不会自动截断。")).toBeVisible();expect(trims).toHaveLength(0);
  await voiceCard.getByLabel("voice-candidate开始秒数").fill("1.5");await voiceCard.getByLabel("voice-candidate结束秒数").fill("6.5");
  await voiceCard.getByRole("button",{name:"裁剪为新声音候选"}).click();
  await expect(page.getByText("裁剪回执未收到，请重试同一区间。")).toBeVisible();
  await voiceCard.getByRole("button",{name:"裁剪为新声音候选"}).click();
  await expect(page.locator("#production-voice-cut")).toContainText("已生成 · 待审核");
  expect(trims).toHaveLength(2);expect(trims[0]).toEqual(trims[1]);expect(trims[0]).toMatchObject({baseRevision:3,fileId:"voice-file",fileSha256:"voice-sha",sourceHash:"voice-hash",startMs:1500,endMs:6500});
  expect(posts).toHaveLength(2);await expect(page.getByRole("button",{name:"通过裁剪声音"})).toBeEnabled();
  expect(await page.evaluate(key=>JSON.parse(localStorage.getItem(key)!),storageKey)).toEqual(draft);
  await page.setViewportSize({width:390,height:850});await page.locator("#production").scrollIntoViewIfNeeded();
  await expect.poll(()=>page.evaluate(()=>document.documentElement.scrollWidth <= innerWidth+1)).toBe(true);
  await page.screenshot({path:testInfo.outputPath("production-review-mobile.png"),animations:"disabled"});
});
