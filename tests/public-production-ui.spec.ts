import { test, expect } from "@playwright/test";
import { readFileSync } from "node:fs";
import type { ReviewSnapshot } from "../src/review/projectSnapshot";
import type { PublicProduction } from "../shared/review-production";

test("公开生产区逐候选审核，保留原有图片草稿与手机布局", async({page},testInfo)=>{
  const snapshot:ReviewSnapshot={schemaVersion:1,projectId:"production-fixture",title:"明确标记的测试影片",revision:3,contentHash:"fixture-content",fps:25,totalFrames:1500,items:[],flow:[],evidence:[],onlineReview:{apiBase:"/api",projectId:"production-fixture"}};
  const data:PublicProduction={projectId:snapshot.projectId,revision:3,jobs:[{id:"video-job",shotId:"S01",kind:"video",state:"complete",stage:"complete",current:true,updatedAt:"2026-01-01",dependsOn:[]},{id:"lip-job",shotId:"S02",kind:"lipsync",state:"waiting_review",stage:"review_dependency",current:true,updatedAt:"2026-01-01",reason:"等待前置声音或镜头人工通过，审核后继续已排队任务。",dependsOn:[]}],candidates:[{id:"video-candidate",shotId:"S01",kind:"video",fileId:"video-file",url:"/fixture.mp4",mime:"video/mp4",sha256:"video-sha",sourceHash:"source-hash",current:true,accepted:false,reviewed:false,createdAt:"2026-01-01"},{id:"voice-candidate",shotId:"S02",kind:"voice",fileId:"voice-file",url:"/fixture.wav",mime:"audio/wav",sha256:"voice-sha",sourceHash:"voice-hash",current:true,accepted:false,reviewed:false,createdAt:"2026-01-01"}]};
  const storageKey=`storyflow-review:${snapshot.projectId}:${snapshot.contentHash}`, draft={baseRevision:3,drafts:{S01:{status:"pass",note:"原有审核评论",imageId:"image-1",imageSha256:"image-hash",targetHash:"target-hash"}}};
  let authenticated=false; const posts:{id:string;body:any}[]=[];
  await page.addInitScript(({storageKey,draft})=>localStorage.setItem(storageKey,JSON.stringify(draft)),{storageKey,draft});
  await page.route("**/api/**", async route=>{
    const path=new URL(route.request().url()).pathname, method=route.request().method();
    const json=(body:unknown,status=200)=>route.fulfill({status,contentType:"application/json",body:JSON.stringify(body)});
    if(path === "/api/auth") return json({authenticated});
    if(path === "/api/auth/login") {authenticated=true;return json({authenticated});}
    if(path.endsWith("/review-submissions")) return json({submissions:[]});
    if(path === `/api/public-review/${snapshot.projectId}`) return json(snapshot);
    if(path.endsWith("/production")) return json(data);
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
  await expect(page.locator("#production-video-candidate")).toContainText("人工已通过");
  expect(posts).toEqual([{id:"video-candidate",body:{accepted:true,note:"动作和原声通过",sourceHash:"source-hash",fileSha256:"video-sha"}}]);
  await page.getByRole("button",{name:"通过声音并制作口型"}).click();
  expect(posts[1].id).toBe("voice-candidate");expect(posts[1].body.fileSha256).toBe("voice-sha");
  expect(await page.evaluate(key=>JSON.parse(localStorage.getItem(key)!),storageKey)).toEqual(draft);
  await page.setViewportSize({width:390,height:850});await page.locator("#production").scrollIntoViewIfNeeded();
  await expect.poll(()=>page.evaluate(()=>document.documentElement.scrollWidth <= innerWidth+1)).toBe(true);
  await page.screenshot({path:testInfo.outputPath("production-review-mobile.png"),animations:"disabled"});
});
