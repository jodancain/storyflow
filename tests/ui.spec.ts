import { test, expect, type Page } from "@playwright/test";
import { compileOntology } from "../shared/ontology.ts";
import type { Project, Requirements, Ontology } from "../shared/types.ts";

test.use({
  baseURL: process.env.STORYFLOW_UI_BASE_URL || "http://127.0.0.1:18297",
});

// Synthetic, explicitly mocked browser fixture. Production UI has no demo API fallback.
const requirements: Requirements = {
  topic: "医学科普示例",
  audience: "公众",
  duration: 60,
  aspect: "9:16",
  fps: 25,
  style: "明亮温暖",
  doctorMode: "photo",
  sound: "原声对白",
  brief: "从发现线索，到咨询医生。",
};
const ontology: Ontology = {
  schemaVersion: 1,
  title: "把线索连成答案",
  spec: { fps: 25, totalFrames: 1500, width: 1080, height: 1920 },
  entities: [
    {
      id: "person",
      type: "character",
      label: "故事人物",
      attributes: { role: "虚构示例" },
      evidenceIds: [],
      fictional: true,
    },
    {
      id: "doctor",
      type: "character",
      label: "指定医生",
      attributes: { role: "医生" },
      evidenceIds: [],
    },
  ],
  relations: [{ id: "r1", type: "depends_on", from: "S02", to: "S01" }],
  assets: [
    {
      id: "portrait",
      label: "指定医生参考照",
      kind: "image",
      purpose: "production",
      gap: true,
      source: { license: "待用户提供" },
    },
  ],
  anchors: [],
  evidence: [],
  shots: [
    {
      id: "S01",
      title: "发现生活中的线索",
      startFrame: 0,
      endFrame: 750,
      entityIds: ["person"],
      requiredAssetIds: [],
      evidenceIds: [],
      action: "人物打开记事本，记录这一天的身体变化。",
      startState: "记事本合上",
      endState: "记事本打开",
      scale: "中景",
      camera: "固定机位",
      dialogue: [
        { id: "D01", speakerId: "person", text: "这些线索，我想认真记下来。" },
      ],
      subtitles: [
        {
          id: "C01",
          startFrame: 0,
          endFrame: 120,
          text: "每一条线索都值得被看见",
        },
      ],
      dependencies: [],
      route: "seedance",
      prompt: "温暖日光，人物记录日记。",
      mustShow: ["记事本"],
      rejectIf: ["错误文字"],
    },
    {
      id: "S02",
      title: "向医生寻求帮助",
      startFrame: 750,
      endFrame: 1500,
      entityIds: ["doctor"],
      requiredAssetIds: ["portrait"],
      evidenceIds: [],
      action: "医生面对镜头讲解。",
      startState: "医生倾听",
      endState: "医生完成解释",
      scale: "近景",
      camera: "固定",
      dialogue: [
        { id: "D02", speakerId: "doctor", text: "请及时向专业医生咨询。" },
      ],
      subtitles: [],
      dependencies: ["S01"],
      route: "doctor",
      prompt: "医生面对镜头，清晰原声。",
      mustShow: ["医生口型"],
      rejectIf: ["音画不符"],
    },
  ],
  postProgram: { version: 1, elements: [] },
};
function fixture(): Project {
  return {
    id: "test-project",
    name: "把线索连成答案",
    revision: 1,
    requirements: structuredClone(requirements),
    ontology: structuredClone(ontology),
    compiled: compileOntology(ontology),
    reviews: [],
    files: [],
    artifacts: [],
    jobs: [],
    createdAt: "2026-10-10T01:00:00Z",
    updatedAt: "2026-10-10T01:00:00Z",
  };
}
async function mockApi(page: Page, setup = false, imageConfigured = false) {
  let project = fixture(),
    authenticated = !setup,
    created = false;
  const requests: { path: string; method: string; body: any }[] = [];
  await page.route("**/api/**", async (route) => {
    const request = route.request(),
      url = new URL(request.url()),
      path = url.pathname,
      method = request.method();
    let body: any = {};
    try {
      body = request.postDataJSON() || {};
    } catch {}
    requests.push({ path, method, body });
    const ok = (data: any, status = 200) =>
      route.fulfill({
        status,
        contentType: "application/json",
        body: JSON.stringify(data),
      });
    if (path.startsWith("/api/files/")) return route.fulfill({status:200,contentType:"image/svg+xml",body:`<svg xmlns="http://www.w3.org/2000/svg" width="360" height="640"><rect width="360" height="640" fill="${path.includes("second") ? "#d7c3a8" : "#c4bfdc"}"/><circle cx="180" cy="180" r="90" fill="#f6e4d7"/><rect x="75" y="280" width="210" height="310" rx="70" fill="#fff"/></svg>`});
    if (path.startsWith("/api/artifacts/") && method === "POST") {
      const artifact = project.artifacts.find(a => path.includes(a.id));
      if (!artifact) return ok({error:"候选不存在"},404);
      if (path.endsWith("/review")) { artifact.accepted=body.accepted; artifact.metadata={...artifact.metadata,reviewNote:body.note,reviewStatus:body.accepted ? "pass" : "change"}; }
      if (path.endsWith("/select")) {
        const binding={artifactId:artifact.id,fileId:artifact.fileId,sha256:project.files.find(f=>f.id===artifact.fileId)!.sha256};
        if (artifact.assetId) { const asset=project.ontology.assets.find(a=>a.id===artifact.assetId)!; if(body.usage==="preview")asset.previewImage=binding; else { if(!artifact.accepted)return ok({error:"先审核"},422);asset.fileId=artifact.fileId;asset.sha256=binding.sha256;asset.gap=false; } }
        project.revision+=1;
      }
      return ok(project);
    }
    if (path.endsWith("/image-generations")) return ok({runId:"fixture-run",jobs:[]});
    if (path === "/api/auth")
      return ok({ setupRequired: setup && !authenticated, authenticated });
    if (path === "/api/auth/setup" || path === "/api/auth/login") {
      authenticated = true;
      return ok({ ok: true });
    }
    if (path === "/api/config")
      return ok({
        version: "test",
        capabilities: {
          seedance: { configured: false, reason: "尚未配置视频服务" },
          fal: { configured: false, reason: "尚未配置医生口型服务" },
          opus: { configured: false, reason: "尚未配置策划服务" },
          media: { configured: true, model: "FFmpeg" },
          image: { configured: imageConfigured, model: "fixture-image", reason: "图片服务尚未配置" },
        },
      });
    if (path === "/api/projects" && method === "GET")
      return ok(setup && !created ? [] : [project]);
    if (path === "/api/projects" && method === "POST") {
      created = true;
      project = { ...project, name: body.name };
      return ok(project);
    }
    if (path === "/api/projects/test-project" && method === "GET")
      return ok(project);
    if (path === "/api/projects/test-project" && method === "PATCH") {
      project = {
        ...project,
        ...body,
        revision: project.revision + 1,
        updatedAt: "2026-10-10T01:01:00Z",
      };
      delete (project as any).baseRevision;
      project.compiled = compileOntology(project.ontology);
      return ok(project);
    }
    if (path === "/api/projects/test-project/compile")
      return ok(project.compiled);
    if (path === "/api/projects/test-project/reviews") {
      project.reviews = project.reviews.filter(
        (r) => r.targetId !== body.targetId,
      );
      project.reviews.push({
        ...body,
        targetHash: project.compiled.targetHashes[body.targetId],
        updatedAt: "2026-10-10T01:02:00Z",
      });
      return ok(project);
    }
    if (path === "/api/projects/test-project/revisions")
      return ok([{ revision: 1, updatedAt: project.createdAt }]);
    if (path === "/api/projects/test-project/revisions/1")
      return ok({ ...fixture(), ontology });
    if (path === "/api/references/search")
      return ok({
        source: "pubmed",
        items: [
          {
            id: "ref1",
            title: "示例医学文献",
            url: "https://pubmed.ncbi.nlm.nih.gov/1/",
            excerpt: "用于浏览器测试的合成检索记录。",
          },
        ],
      });
    if (path.endsWith("/references")) return ok(project);
    if (
      path.endsWith("/runs") ||
      path.endsWith("/expand") ||
      path.endsWith("/post-plan")
    )
      return ok({ error: "尚未配置生成服务，未提交任何模型请求。" }, 422);
    if (path.endsWith("/reviews/import")) return ok(project);
    return ok({ error: "未模拟接口 " + path }, 404);
  });
  return { requests, getProject: () => project };
}
async function openProject(page: Page) {
  await page.goto("/?project=test-project");
  await expect(
    page.getByRole("heading", { name: "把线索连成答案", exact: true }),
  ).toBeVisible();
}

test("管理员建立工作区和创建模板项目", async ({ page }) => {
  const mock = await mockApi(page, true);
  const duplicateKeyWarnings: string[] = [];
  page.on("console", (m) => {
    if (m.text().includes("same key")) duplicateKeyWarnings.push(m.text());
  });
  await page.goto("/");
  await page.getByLabel("管理员密码").fill("test-password-1234");
  await page.getByRole("button", { name: "建立工作区 →" }).click();
  await expect(
    page.getByRole("heading", { name: "让好故事，从这里开始。" }),
  ).toBeVisible();
  await page.getByRole("button", { name: "＋ 新建项目" }).click();
  await page.getByRole("button", { name: /狼疮科普模板/ }).click();
  await page.getByLabel("项目名称", { exact: true }).fill("新的科普故事");
  await page.getByRole("button", { name: "创建项目 →" }).click();
  await expect(
    page.getByRole("heading", { name: "新的科普故事", exact: true }),
  ).toBeVisible();
  expect(
    mock.requests.find((r) => r.path === "/api/projects" && r.method === "POST")
      ?.body.template,
  ).toBe("lupus-v6");
  expect(duplicateKeyWarnings).toEqual([]);
});

test("需求保存、镜头编辑、服务端审核与清晰错误", async ({ page }) => {
  const mock = await mockApi(page);
  await openProject(page);
  await page
    .getByRole("textbox", { name: "创作需求", exact: true })
    .fill("需要明亮的人物、准确的素材和清楚的医生口型。");
  await page.getByRole("button", { name: "保存需求", exact: true }).click();
  await expect(page.getByRole("status")).toContainText("需求已保存");
  await page.getByRole("button", { name: "02 展开 把故事讲清楚 →" }).click();
  await page.getByRole("button", { name: "编辑镜头" }).first().click();
  await page.getByLabel("镜头标题", { exact: true }).fill("第一条线索");
  await page.getByRole("button", { name: "保存镜头修订" }).click();
  await expect(
    page.getByRole("heading", { name: "第一条线索", exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "03 审核 确认每一处细节 →" }).click();
  await page.getByLabel("审核意见").first().fill("故事与台词已核对。");
  await page
    .getByRole("button", { name: "✓ 通过", exact: true })
    .first()
    .click();
  expect(mock.getProject().reviews[0].note).toBe("故事与台词已核对。");
  await page.getByRole("button", { name: "04 视频 让故事发生" }).click();
  await expect(page.getByText("尚未配置视频服务")).toBeVisible();
  await page.getByRole("button", { name: "提交镜头制作 →" }).click();
  await page.getByRole("button", { name: "提交 2 个镜头" }).click();
  await expect(page.getByRole("alert")).toContainText("尚未配置生成服务");
});

test("本体错误、编译缺口、检索与真实计划图可见", async ({ page }) => {
  await mockApi(page);
  await openProject(page);
  await page.getByRole("button", { name: "02 展开 把故事讲清楚 →" }).click();
  await page.getByRole("button", { name: /项需要修正|结构可展开/ }).click();
  await expect(
    page.getByText("指定医生参考照", { exact: false }).first(),
  ).toBeVisible();
  await page.getByRole("tab", { name: "本体与关系" }).click();
  await expect(
    page.getByText("故事人物", { exact: true }).first(),
  ).toBeVisible();
  await page.getByRole("textbox", { name: "本体 JSON" }).fill("{wrong");
  await page.getByRole("button", { name: "保存并校验" }).click();
  await expect(page.getByRole("alert")).toContainText("本体格式无法读取");
  await page.getByRole("button", { name: "恢复已保存内容" }).click();
  await page.getByRole("tab", { name: "参考与依据" }).click();
  await page.getByLabel("寻找医学依据与素材").fill("lupus");
  await page.getByRole("button", { name: "检索 ↗" }).click();
  await expect(
    page.getByRole("heading", { name: "示例医学文献" }),
  ).toBeVisible();
  await page.getByRole("button", { name: "04 视频 让故事发生" }).click();
  await page.locator(".graph-node").first().click();
  await expect(page.getByRole("dialog")).toBeVisible();
  await expect(page.getByText("暂无供应商回执与实际使用条件。")).toBeVisible();
});

for (const width of [1440, 390, 320])
  test(`四阶段无页面横向溢出 ${width}px`, async ({ page }, testInfo) => {
    await page.setViewportSize({ width, height: 900 });
    await mockApi(page);
    const errors: string[] = [];
    page.on("pageerror", (e) => errors.push(e.message));
    await openProject(page);
    for (const stage of [
      "01 需求 确定方向 →",
      "02 展开 把故事讲清楚 →",
      "03 审核 确认每一处细节 →",
      "04 视频 让故事发生",
    ]) {
      await page.getByRole("button", { name: stage.slice(0, 5) }).click();
      await expect
        .poll(() =>
          page.evaluate(
            () => document.documentElement.scrollWidth <= window.innerWidth + 1,
          ),
        )
        .toBe(true);
    }
    expect(errors).toEqual([]);
    await page.screenshot({
      path: testInfo.outputPath("workflow.png"),
      fullPage: true,
      animations: "disabled",
    });
  });

// Real HTTP + SQLite integration, opt-in to keep isolated fixture tests fast.
// Run after `npm run build`: STORYFLOW_UI_REAL=1 npm run test:ui.
test("真实服务：创建、编辑、持久审核、工程迁移与缺凭据任务", async ({
  page,
}, testInfo) => {
  test.skip(
    process.env.STORYFLOW_UI_REAL === "0",
    "已设置 STORYFLOW_UI_REAL=0，跳过真实服务验收",
  );
  test.setTimeout(120000);
  const { mkdtemp, rm } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { spawn } = await import("node:child_process");
  const temp = await mkdtemp(join(tmpdir(), "storyflow-ui-real-"));
  const port = Number(process.env.STORYFLOW_UI_REAL_PORT || 19309),
    base = `http://127.0.0.1:${port}`;
  const child = spawn(process.execPath, ["--import", "tsx", "server/main.ts"], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      PORT: String(port),
      HOST: "127.0.0.1",
      PUBLIC_BASE_URL: base,
      STORYFLOW_DATA_DIR: join(temp, "data"),
      STORYFLOW_ADMIN_PASSWORD: "",
      OPUS_API_KEY: "",
      SEEDANCE_API_KEY: "",
      FAL_KEY: "",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let logs = "";
  child.stdout?.on("data", (d) => (logs += d.toString()));
  child.stderr?.on("data", (d) => (logs += d.toString()));
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  try {
    await expect
      .poll(
        async () => {
          try {
            return (await fetch(`${base}/healthz`)).status;
          } catch {
            return 0;
          }
        },
        { timeout: 20000 },
      )
      .toBe(200);
    await page.goto(base);
    await page.getByLabel("管理员密码").fill("isolated-ui-password-123");
    await page.getByRole("button", { name: "建立工作区 →" }).click();
    await page.getByRole("button", { name: "＋ 新建项目" }).click();
    await page.getByRole("button", { name: /狼疮科普模板/ }).click();
    await page.getByLabel("项目名称", { exact: true }).fill("真实服务验收工程");
    await page.getByRole("button", { name: "创建项目 →" }).click();
    await expect(
      page.getByRole("heading", { name: "真实服务验收工程", exact: true }),
    ).toBeVisible();
    await page
      .getByRole("textbox", { name: "创作需求", exact: true })
      .fill("真实 API 浏览器验收：资料、审核和迁移。");
    await page.getByRole("button", { name: "保存需求", exact: true }).click();
    await expect(page.getByRole("status")).toContainText("需求已保存");
    const id = new URL(page.url()).searchParams.get("project");
    expect(id).toBeTruthy();
    await page.getByRole("button", { name: "03 审核" }).click();
    await page
      .getByLabel("审核意见")
      .first()
      .fill("请核对这一镜的症状专属素材。");
    await page
      .getByRole("button", { name: "需要修改", exact: true })
      .first()
      .click();
    await expect(page.getByRole("status")).toContainText("审核意见已保存");
    await page.reload();
    await expect(
      page.getByRole("heading", { name: "真实服务验收工程", exact: true }),
    ).toBeVisible();
    await page.getByRole("button", { name: "03 审核" }).click();
    await expect(page.getByLabel("审核意见").first()).toHaveValue(
      "请核对这一镜的症状专属素材。",
    );
    const state = await (
      await page.request.get(`${base}/api/projects/${id}`)
    ).json();
    expect(state.requirements.brief).toContain("真实 API");
    expect(state.reviews.some((r: any) => r.status === "change")).toBe(true);
    await page.getByRole("button", { name: "02 展开" }).click();
    await page.getByRole("button", { name: "AI 展开故事 ↗" }).click();
    await page.getByRole("button", { name: "04 视频" }).click();
    await page.getByRole("button", { name: /任务记录/ }).click();
    await expect(
      page.getByText("等待条件", { exact: true }).first(),
    ).toBeVisible({ timeout: 20000 });
    expect(
      (await (await page.request.get(`${base}/api/projects/${id}`)).json())
        .jobs[0].state,
    ).toBe("blocked");
    const downloadPromise = page.waitForEvent("download");
    await page.getByRole("link", { name: "导出工程 ↓" }).click();
    const download = await downloadPromise;
    const zip = join(temp, "project.zip");
    await download.saveAs(zip);
    await page.getByRole("button", { name: "返回项目列表" }).click();
    await page.locator(".library-heading input[type=file]").setInputFiles(zip);
    await expect(page.getByRole("status")).toContainText("工程已导入");
    await expect
      .poll(() => new URL(page.url()).searchParams.get("project"))
      .not.toBe(id);
    const copiedId = new URL(page.url()).searchParams.get("project");
    const copied = await (
      await page.request.get(`${base}/api/projects/${copiedId}`)
    ).json();
    expect(copied.requirements.brief).toContain("真实 API");
    expect(copied.ontology.shots.length).toBe(20);
    expect(copied.files.length).toBeGreaterThan(0);
    expect(errors).toEqual([]);
    await page.screenshot({
      path: testInfo.outputPath("real-workspace.png"),
      fullPage: true,
      animations: "disabled",
    });
  } finally {
    await testInfo.attach("isolated-server-log", {
      body: logs,
      contentType: "text/plain",
    });
    child.kill("SIGTERM");
    await new Promise<void>((resolve) => {
      child.once("exit", () => resolve());
      setTimeout(() => {
        child.kill("SIGKILL");
        resolve();
      }, 3000).unref();
    });
    await rm(temp, { recursive: true, force: true });
  }
});

test("后台进度刷新保留未保存需求", async ({ page }) => {
  const mock = await mockApi(page);
  const p = mock.getProject();
  p.jobs.push({
    id: "running-test",
    projectId: p.id,
    runId: "test-run",
    kind: "video",
    shotId: "S01",
    state: "running",
    stage: "等待供应商处理",
    progress: 0,
    dependsOn: [],
    inputHash: "fixture-only",
    input: {},
    attempts: 1,
    createdAt: p.createdAt,
    updatedAt: p.updatedAt,
  });
  await openProject(page);
  const field = page.getByRole("textbox", { name: "创作需求", exact: true });
  await field.fill("这段未保存内容不应被后台轮询覆盖。");
  const before = mock.requests.filter(
    (r) => r.path === "/api/projects/test-project" && r.method === "GET",
  ).length;
  await expect
    .poll(
      () =>
        mock.requests.filter(
          (r) => r.path === "/api/projects/test-project" && r.method === "GET",
        ).length,
      { timeout: 7000 },
    )
    .toBeGreaterThan(before);
  await expect(field).toHaveValue("这段未保存内容不应被后台轮询覆盖。");
  await expect(page.getByText("尚未保存", { exact: true })).toBeVisible();
});

test("制作框图不把旧修订任务冒充当前完成", async ({ page }) => {
  const mock = await mockApi(page),
    p = mock.getProject();
  p.jobs.push({
    id: "old-complete",
    projectId: p.id,
    runId: "old-run",
    kind: "video",
    shotId: "S01",
    state: "complete",
    stage: "complete",
    progress: 1,
    dependsOn: [],
    inputHash: "old",
    input: { generationHash: "old-revision" },
    attempts: 1,
    createdAt: p.createdAt,
    updatedAt: p.updatedAt,
  });
  await openProject(page);
  await page.getByRole("button", { name: "04 视频" }).click();
  const node = page.locator(".graph-node").filter({ hasText: "S01" });
  await expect(node).toContainText("尚未提交");
  p.jobs[0].input.generationHash = p.compiled.shotHashes.S01;
  await page.getByRole("button", { name: "↻ 刷新" }).click();
  await expect(node).toContainText("已完成");
});

test("工程与镜头导入按实际接口筛选文件", async ({ page }) => {
  const mock = await mockApi(page),
    p = mock.getProject();
  p.files = ["video/mp4", "audio/wav", "image/png"].map((mime, index) => ({
    id: `file-${index}`,
    projectId: p.id,
    name: `fixture-${index}`,
    mime,
    sha256: "a".repeat(64),
    bytes: 10,
    relativePath: `files/${"a".repeat(64)}`,
    createdAt: p.createdAt,
  }));
  await openProject(page);
  await page.getByRole("button", { name: "04 视频" }).click();
  await page.getByRole("button", { name: /素材与成片/ }).click();
  await page.getByRole("button", { name: "导入已有镜头素材 ＋" }).click();
  const modal = page.getByRole("dialog");
  await modal
    .getByRole("combobox", { name: "素材类型", exact: true })
    .selectOption("graphic");
  const files = modal.getByRole("combobox", {
    name: "已上传文件",
    exact: true,
  });
  await expect(files.locator("option")).toHaveText([
    "选择媒体文件",
    "fixture-0",
  ]);
  await expect(
    modal.getByText("这里导入已渲染的图示视频。", { exact: false }),
  ).toBeVisible();
  await files.selectOption("file-0");
  await modal
    .getByRole("combobox", { name: "素材类型", exact: true })
    .selectOption("voice");
  await expect(files).toHaveValue("");
  await expect(files.locator("option")).toHaveText([
    "选择媒体文件",
    "fixture-1",
  ]);
  await modal
    .getByRole("combobox", { name: "素材类型", exact: true })
    .selectOption("lipsync");
  await expect(
    modal.getByText("请先将该镜头的驱动声音", { exact: false }),
  ).toBeVisible();
  await expect(
    modal
      .getByRole("combobox", { name: "同一口型对应的音轨" })
      .locator("option"),
  ).toHaveCount(1);
  await files.selectOption("file-0");
  await expect(
    modal.getByRole("button", { name: "登记为待验收素材" }),
  ).toBeDisabled();
  await modal.getByRole("button", { name: "关闭" }).click();
  await page.getByRole("button", { name: "返回项目列表" }).click();
  await expect(
    page.locator(".library-heading input[type=file]"),
  ).toHaveAttribute("accept", ".zip");
});


test("真实资产候选可比较、明确批准与采用，返回保留筛选", async ({ page }, testInfo) => {
  const mock=await mockApi(page,false,true), p=mock.getProject();
  p.files=["first","second"].map((id,index)=>({id:`file-${id}`,projectId:p.id,name:`${id}.svg`,mime:"image/svg+xml",sha256:String(index+1).repeat(64),bytes:300,relativePath:`fixtures/${id}`,createdAt:p.createdAt}));
  p.artifacts=["first","second"].map((id,index)=>({id:`candidate-${id}`,projectId:p.id,jobId:`image-${id}`,kind:"image",assetId:"portrait",fileId:`file-${id}`,sourceHash:"image-hash",accepted:false,metadata:{origin:"ai-generated",modelRequested:"fixture-image",reviewStatus:"pending",parentAssets:[]},createdAt:index ? "2026-10-10T01:01:00Z":p.createdAt}));
  p.ontology.assets[0].previewImage={artifactId:"candidate-first",fileId:"file-first",sha256:"1".repeat(64)};
  p.imageTargetHashes={portrait:"image-hash"};
  await openProject(page);
  await page.getByRole("button",{name:"03 审核 确认每一处细节 →"}).click();
  await page.getByRole("button",{name:"资产图与首帧",exact:true}).click();
  await page.getByLabel("搜索资产与分镜").fill("医生");
  await page.getByRole("button",{name:"审图：指定医生参考照",exact:true}).click();
  const dialog=page.getByRole("dialog",{name:"审图：指定医生参考照"});
  await expect(dialog.getByRole("button",{name:"采用为制作资产",exact:true})).toBeDisabled();
  await dialog.getByLabel("并排比较").selectOption("candidate-second");
  await expect(dialog.getByAltText("指定医生参考照对比候选")).toBeVisible();
  await page.screenshot({path:testInfo.outputPath("candidate-review.png"),animations:"disabled"});
  await dialog.getByLabel("当前候选审图意见").fill("核对指定医生身份，批准当前候选。");
  await dialog.getByRole("button",{name:"确认此图通过",exact:true}).click();
  await expect(dialog.getByRole("button",{name:"采用为制作资产",exact:true})).toBeEnabled();
  await dialog.getByRole("button",{name:"作为审稿展示图",exact:true}).click();
  expect(mock.requests.filter(r=>r.path.endsWith("/select")).at(-1)?.body.usage).toBe("preview");
  expect(p.ontology.assets[0].fileId).toBeUndefined();
  await dialog.getByRole("button",{name:"采用为制作资产",exact:true}).click();
  expect(p.ontology.assets[0].fileId).toBe("file-first");
  await page.keyboard.press("Escape");
  await expect(page.getByLabel("搜索资产与分镜")).toHaveValue("医生");
  expect(mock.requests.filter(r=>r.path.endsWith("/image-generations"))).toHaveLength(0);
});

test("图片无配置不提交且手机审图保持视口", async ({page}) => {
  const mock=await mockApi(page);await page.setViewportSize({width:390,height:850});await openProject(page);
  await page.getByRole("button",{name:"补齐专属资产图 ↗",exact:true}).click();
  await expect(page.getByText("图片服务尚未配置",{exact:true})).toBeVisible();
  await expect.poll(()=>page.locator(".sf-image-grid").first().evaluate(el=>getComputedStyle(el).gridTemplateColumns.split(" ").length)).toBe(1);
  await page.getByRole("button",{name:"审图：指定医生参考照",exact:true}).click();
  await page.getByText("生成新的候选图",{exact:true}).click();
  await expect(page.getByRole("button",{name:"提交生成一个候选",exact:true})).toBeDisabled();
  await expect.poll(()=>page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth+1)).toBe(true);
  await page.keyboard.press("Escape");
  expect(mock.requests.filter(r=>r.path.endsWith("/image-generations"))).toHaveLength(0);
});


test("旧父图候选禁止用于制作，导入意见需要明确转成待审",async({page})=>{
  const mock=await mockApi(page,false,true),p=mock.getProject();
  p.files=[{id:"file-first",projectId:p.id,name:"fixture.svg",mime:"image/svg+xml",sha256:"1".repeat(64),bytes:300,relativePath:"fixture",createdAt:p.createdAt}];
  p.artifacts=[{id:"candidate-first",projectId:p.id,jobId:"image-first",kind:"image",assetId:"portrait",fileId:"file-first",sourceHash:"same-target-hash",accepted:true,metadata:{origin:"ai-generated",reviewStatus:"pass"},createdAt:p.createdAt}];
  p.imageCandidateCurrent={"candidate-first":false};
  p.ontology.assets[0].previewImage={artifactId:"candidate-first",fileId:"file-first",sha256:"1".repeat(64)};
  p.reviews=[{targetId:"S01",targetHash:"imported-opinion",status:"pending",note:"请把口腔溃疡与对应症状素材核对。",updatedAt:p.updatedAt,imported:{sourceRevision:1,snapshotHash:"prior-hash",targetHash:p.compiled.targetHashes.S01,originalStatus:"pass",match:"historical"}}];
  await openProject(page);await page.getByRole("button",{name:"03 审核 确认每一处细节 →"}).click();
  await page.getByText(/导入审稿意见 · 待人工核对/).click();
  await page.getByRole("button",{name:"采用意见为当前待审",exact:true}).click();
  expect(mock.getProject().reviews.find(r=>r.targetId==="S01")?.status).toBe("pending");
  await page.getByRole("button",{name:"资产图与首帧",exact:true}).click();
  await page.getByRole("button",{name:"审图：指定医生参考照",exact:true}).click();
  await expect(page.getByText("此图基于旧修订，保留供对比，不能作为当前制作输入。",{exact:true})).toBeVisible();
  await expect(page.getByRole("button",{name:"采用为制作资产",exact:true})).toBeDisabled();
});


test("实际参考图可取消与明确发送，卡片缩略图与技术返修独立显示",async({page})=>{
  const mock=await mockApi(page,false,true),p=mock.getProject();
  p.files=["first","thumb"].map((id,index)=>({id:`file-${id}`,projectId:p.id,name:`${id}.png`,mime:"image/png",sha256:String(index+1).repeat(64),bytes:300,relativePath:`fixtures/${id}`,createdAt:p.createdAt}));
  p.artifacts=[{id:"candidate-first",projectId:p.id,jobId:"image-first",kind:"image",assetId:"portrait",fileId:"file-first",sourceHash:"fixture-hash",accepted:false,metadata:{origin:"ai-generated",reviewStatus:"pending",thumbnailFileId:"file-thumb",technicalReview:{contentReview:"needs_revision"},reviewNote:"技术检查：请核对医生服装，尚未人工定稿。"},createdAt:p.createdAt}];
  p.ontology.assets[0].previewImage={artifactId:"candidate-first",fileId:"file-first",sha256:"1".repeat(64)};
  await openProject(page);await page.getByRole("button",{name:"03 审核 确认每一处细节 →"}).click();await page.getByRole("button",{name:"资产图与首帧",exact:true}).click();
  await page.getByLabel("筛选图片状态").selectOption("change");
  const card=page.getByRole("button",{name:"审图：指定医生参考照",exact:true});
  await expect(card.locator("img")).toHaveAttribute("src","/api/files/file-thumb");
  await expect(card.getByText("技术建议返修",{exact:true})).toBeVisible();
  await expect(card.getByText("生成成功 · 待审",{exact:true})).toBeVisible();
  await card.click();await expect(page.getByAltText("指定医生参考照当前候选")).toHaveAttribute("src","/api/files/file-first");
  await expect(page.getByRole("note").getByText("技术检查：请核对医生服装，尚未人工定稿。",{exact:true})).toBeVisible();await page.keyboard.press("Escape");
  await page.getByLabel("筛选图片状态").selectOption("all");await page.getByRole("button",{name:"逐镜首帧",exact:true}).click();await page.getByRole("button",{name:"审图：向医生寻求帮助",exact:true}).click();
  await page.getByText("生成新的候选图",{exact:true}).click();
  const checkbox=page.getByLabel("参考图 指定医生参考照",{exact:true});await expect(checkbox).toBeChecked();await checkbox.uncheck();await expect(checkbox).not.toBeChecked();await checkbox.check();
  await page.getByLabel("补充图片要求").fill("更明亮的人物面部");
  expect(mock.requests.filter(r=>r.path.endsWith("/image-generations"))).toHaveLength(0);
  await page.getByRole("button",{name:"提交生成一个候选",exact:true}).click();
  const request=mock.requests.filter(r=>r.path.endsWith("/image-generations"));expect(request).toHaveLength(1);expect(request[0].body.targets[0].referenceAssetIds).toEqual(["portrait"]);expect(request[0].body.targets[0].shotId).toBe("S02");expect(request[0].body.targets[0].prompt).toContain("医生口型");expect(request[0].body.targets[0].prompt).toContain("更明亮的人物面部");
});
