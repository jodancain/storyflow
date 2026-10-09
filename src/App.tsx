import { useEffect, useRef, useState } from "react";
import type {
  Project,
  Requirements,
  Ontology,
  Shot,
  Asset,
  Job,
  Artifact,
} from "../shared/types";
import { api, ApiError, idempotencyKey, fileUrl, dateText } from "./api";
import {
  Badge,
  Empty,
  SectionHead,
  Modal,
  JsonDetails,
  Issues,
  MediaPreview,
  WorkflowGraph,
  isCurrentJob,
  stageText,
  currentReview,
  routeLabels,
  statusLabels,
} from "./components";

type Tab = "requirements" | "expand" | "review" | "video";
type Config = {
  version: string;
  capabilities: Record<
    string,
    { configured: boolean; model?: string; reason?: string }
  >;
};
type Act = <T>(
  operation: () => Promise<T>,
  message?: string,
) => Promise<T | undefined>;
const tabs: { id: Tab; label: string; sub: string }[] = [
  { id: "requirements", label: "需求", sub: "确定方向" },
  { id: "expand", label: "展开", sub: "把故事讲清楚" },
  { id: "review", label: "审核", sub: "确认每一处细节" },
  { id: "video", label: "视频", sub: "让故事发生" },
];
const defaultRequirements: Requirements = {
  topic: "",
  audience: "公众",
  duration: 60,
  aspect: "9:16",
  fps: 25,
  style: "清晰、温暖、故事化医学科普",
  doctorMode: "photo",
  sound: "角色对白与环境声；医生逐句口播，不额外添加旁白",
  brief: "",
};
function Brand() {
  return (
    <div className="brand">
      <span className="brand-icon">映</span>
      <span>
        映序<small>STORYFLOW</small>
      </span>
    </div>
  );
}
export default function App() {
  const [auth, setAuth] = useState<{
    setupRequired: boolean;
    authenticated: boolean;
  } | null>(null);
  const [projects, setProjects] = useState<Project[]>([]),
    [project, setProject] = useState<Project | null>(null),
    [config, setConfig] = useState<Config | null>(null);
  const [tab, setTab] = useState<Tab>("requirements"),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [toast, setToast] = useState(""),
    [create, setCreate] = useState(false),
    [zoom, setZoom] = useState<{ src: string; title: string } | null>(null);
  const selectedRef = useRef<string | null>(null);
  const toastTimer = useRef<ReturnType<typeof setTimeout> | undefined>(
    undefined,
  );
  const act: Act = async (operation, message) => {
    setBusy(true);
    setError("");
    try {
      const result = await operation();
      if (message) {
        setToast(message);
        clearTimeout(toastTimer.current);
        toastTimer.current = setTimeout(() => setToast(""), 5000);
      }
      return result;
    } catch (e) {
      setError(
        e instanceof ApiError
          ? `${e.message}${e.issues?.length ? " · " + e.issues.map((i) => i.message).join("；") : ""}`
          : e instanceof Error
            ? e.message
            : String(e),
      );
      return undefined;
    } finally {
      setBusy(false);
    }
  };
  function update(p: Project) {
    setProject(p);
    setProjects((list) => list.map((x) => (x.id === p.id ? p : x)));
  }
  async function select(id: string) {
    const p = await act(() => api<Project>(`/api/projects/${id}`));
    if (p) {
      selectedRef.current = id;
      setProject(p);
      const url = new URL(location.href);
      url.searchParams.set("project", id);
      history.replaceState(null, "", url);
      setTab("requirements");
    }
  }
  async function refresh() {
    const [list, cfg] = await Promise.all([
      api<Project[]>("/api/projects"),
      api<Config>("/api/config"),
    ]);
    setProjects(list);
    setConfig(cfg);
    const id =
      selectedRef.current || new URL(location.href).searchParams.get("project");
    if (id && list.some((p) => p.id === id)) {
      selectedRef.current = id;
      setProject(await api<Project>(`/api/projects/${id}`));
    }
  }
  useEffect(() => {
    api<typeof auth>("/api/auth")
      .then(setAuth)
      .catch((e) => setError(e.message));
    return () => clearTimeout(toastTimer.current);
  }, []);
  useEffect(() => {
    if (auth?.authenticated) void act(refresh);
  }, [auth?.authenticated]);
  useEffect(() => {
    if (project) {
      const url = new URL(location.href);
      url.searchParams.set("project", project.id);
      history.replaceState(null, "", url);
    }
  }, [project?.id]);
  const active = project?.jobs.some((j) =>
    ["queued", "running", "waiting_review"].includes(j.state),
  );
  useEffect(() => {
    if (!active || !project) return;
    let stopped = false;
    const id = project.id;
    const timer = setInterval(() => {
      api<Project>(`/api/projects/${id}`)
        .then((p) => {
          if (!stopped && selectedRef.current === id) update(p);
        })
        .catch((e) => {
          if (!stopped) setError(`进度暂时无法刷新：${e.message}`);
        });
    }, 3000);
    return () => {
      stopped = true;
      clearInterval(timer);
    };
  }, [active, project?.id]);
  async function authenticate(password: string) {
    await act(async () => {
      await api(
        `/api/auth/${auth?.setupRequired ? "setup" : "login"}`,
        "POST",
        { password },
      );
      setAuth({ setupRequired: false, authenticated: true });
    });
  }
  async function importProject(file: File) {
    const data = new FormData();
    data.append("file", file);
    const p = await act(
      () => api<Project>("/api/import", "POST", data),
      "工程已导入",
    );
    if (p) {
      setProjects((list) => [p, ...list]);
      selectedRef.current = p.id;
      setProject(p);
    }
  }
  async function mutate(
    path: string,
    method: string,
    body: unknown,
    message: string,
  ) {
    const p = await act(
      () => api<Project>(`/api/projects/${project!.id}${path}`, method, body),
      message,
    );
    if (p) update(p);
    return p;
  }
  async function submit(path: string, body: Record<string, unknown> = {}) {
    await act(async () => {
      await api(`/api/projects/${project!.id}${path}`, "POST", {
        baseRevision: project!.revision,
        idempotencyKey: idempotencyKey(),
        ...body,
      });
      update(await api<Project>(`/api/projects/${project!.id}`));
    }, "操作已提交，请查看任务状态");
  }
  const shared = project
    ? {
        project,
        act,
        update,
        mutate,
        submit,
        busy,
        onZoom: (src: string, title: string) => setZoom({ src, title }),
      }
    : null;
  if (!auth || !auth.authenticated)
    return (
      <div className="login-page">
        <header>
          <Brand />
          <span className="quiet">让每一帧都有依据</span>
        </header>
        <main>
          <div className="login-story">
            <span className="eyebrow">FROM INTENT TO STORY</span>
            <h1>
              一个想法。
              <br />
              一段值得<span>被看见</span>的故事。
            </h1>
            <p>
              从需求、本体展开到逐镜审核。把医学的准确与故事的温度，一起带到画面里。
            </p>
            <div className="login-steps">
              需求 <i>→</i> 展开 <i>→</i> 审核 <i>→</i> 视频
            </div>
          </div>
          {auth ? (
            <Login
              setup={auth.setupRequired}
              busy={busy}
              onSubmit={authenticate}
              error={error}
            />
          ) : (
            <div className="card">
              <h2>正在连接工作区</h2>
              {error && <p role="alert">{error}</p>}
            </div>
          )}
        </main>
        <footer>
          映序 StoryFlow <span>独立创作工作区</span>
        </footer>
      </div>
    );
  return (
    <div className="app-shell">
      <aside className="sidebar">
        <button
          className="brand-button"
          onClick={() => {
            setProject(null);
            selectedRef.current = null;
          }}
          aria-label="返回项目列表"
        >
          <Brand />
        </button>
        <div className="workspace-label">
          我的创作空间 <span>个人</span>
        </div>
        <button
          className={`nav-home ${!project ? "active" : ""}`}
          onClick={() => {
            setProject(null);
            selectedRef.current = null;
          }}
        >
          ▦ <span>所有项目</span>
          <small>{projects.length}</small>
        </button>
        <div className="sidebar-title">
          最近创作
          <button onClick={() => setCreate(true)} aria-label="创建项目">
            ＋
          </button>
        </div>
        <div className="sidebar-projects">
          {projects.slice(0, 10).map((p) => (
            <button
              key={p.id}
              className={project?.id === p.id ? "selected" : ""}
              onClick={() => void select(p.id)}
            >
              <span className="project-dot" />
              <span>{p.name}</span>
            </button>
          ))}
        </div>
        <div className="sidebar-bottom">
          <div className="quiet">
            私有工作区 · {config?.version || "StoryFlow"}
          </div>
          <button
            className="text-btn"
            onClick={() =>
              void act(async () => {
                await api("/api/auth/logout", "POST");
                setAuth({ setupRequired: false, authenticated: false });
                setProject(null);
              })
            }
          >
            退出登录 ↗
          </button>
        </div>
      </aside>
      <div className="workspace">
        <header className="topbar">
          <div>
            <span className="breadcrumb">我的工作区</span>
            <span className="slash">/</span>
            <b>{project?.name || "所有项目"}</b>
          </div>
          <span className="admin-avatar" title="管理员">
            管
          </span>
        </header>
        <main className="main-content" aria-busy={busy}>
          {error && (
            <div className="error-banner" role="alert">
              <span>
                <b>操作未完成</b>
                <br />
                {error}
              </span>
              <button onClick={() => setError("")} aria-label="关闭错误">
                ×
              </button>
            </div>
          )}
          {project && shared ? (
            <>
              <div className="project-heading">
                <div>
                  <span className="eyebrow">
                    STORY WORKSPACE <span className="dot-separator">·</span> V
                    {project.revision}
                  </span>
                  <h1>{project.name}</h1>
                  <p>
                    {project.requirements.audience} ·{" "}
                    {project.requirements.duration} 秒 ·{" "}
                    {project.requirements.aspect}{" "}
                    <span className="dot-separator">/</span> 最近保存{" "}
                    {dateText(project.updatedAt)}
                  </p>
                </div>
                <div className="actions">
                  <a
                    className="button secondary"
                    href={`/api/projects/${project.id}/review.html`}
                    target="_blank"
                    rel="noreferrer"
                  >
                    审稿页 ↗
                  </a>
                  <a
                    className="button secondary"
                    href={`/api/projects/${project.id}/export`}
                  >
                    导出工程 ↓
                  </a>
                </div>
              </div>
              <nav className="stage-nav" aria-label="制作阶段">
                {tabs.map((t, i) => (
                  <button
                    key={t.id}
                    className={tab === t.id ? "active" : ""}
                    onClick={() => setTab(t.id)}
                    aria-current={tab === t.id ? "step" : undefined}
                  >
                    <span className="stage-num">0{i + 1}</span>
                    <span>
                      <b>{t.label}</b>
                      <small>{t.sub}</small>
                    </span>
                    <i>→</i>
                  </button>
                ))}
              </nav>
              <div className="tab-content" key={`${project.id}-${tab}`}>
                {tab === "requirements" && <RequirementsPanel {...shared} />}{" "}
                {tab === "expand" && <ExpandPanel {...shared} />}{" "}
                {tab === "review" && <ReviewPanel {...shared} />}{" "}
                {tab === "video" && <VideoPanel {...shared} config={config} />}
              </div>
            </>
          ) : (
            <>
              <SectionHead
                eyebrow="YOUR STORY LIBRARY"
                title="让好故事，从这里开始。"
                action={
                  <button className="primary" onClick={() => setCreate(true)}>
                    ＋ 新建项目
                  </button>
                }
              >
                把零散的想法与资料，变成一部有依据、有温度的科普影片。
              </SectionHead>
              <div className="library-hero">
                <div>
                  <span className="eyebrow">A CLEAR PATH TO YOUR FILM</span>
                  <h2>
                    先讲清楚，
                    <br />
                    <em>再让它发生。</em>
                  </h2>
                  <p>
                    每一份依据、每一个镜头、每一次修改，
                    <br />
                    都在同一条创作路径里。
                  </p>
                  <button className="primary" onClick={() => setCreate(true)}>
                    开始一段新故事 <span>↗</span>
                  </button>
                </div>
                <div className="hero-flow">
                  <div>
                    <b>01</b> 想法与资料
                  </div>
                  <i>↓</i>
                  <div>
                    <b>02</b> 故事与本体
                  </div>
                  <i>↓</i>
                  <div>
                    <b>03</b> 逐镜审核
                  </div>
                  <i>↓</i>
                  <div className="dark">
                    <b>04</b> 可追溯的影片 <span>▶</span>
                  </div>
                </div>
              </div>
              <div className="library-heading">
                <h2>
                  创作中的项目 <span>{projects.length}</span>
                </h2>
                <label className="button secondary upload-label">
                  导入工程
                  <input
                    type="file"
                    accept=".zip"
                    onChange={(e) => {
                      if (e.target.files?.[0])
                        void importProject(e.target.files[0]);
                      e.target.value = "";
                    }}
                  />
                </label>
              </div>
              {projects.length ? (
                <div className="project-grid">
                  {projects.map((p, i) => (
                    <button
                      className="project-card"
                      key={p.id}
                      onClick={() => void select(p.id)}
                    >
                      <div className={`project-cover cover-${i % 3}`}>
                        <span>STORY {String(i + 1).padStart(2, "0")}</span>
                        <div className="cover-art">
                          {i % 3 === 0 ? "✧" : i % 3 === 1 ? "◒" : "◇"}
                        </div>
                        <small>
                          {p.requirements?.duration || 60} 秒 ·{" "}
                          {p.requirements?.aspect || "9:16"}
                        </small>
                      </div>
                      <div className="project-card-body">
                        <h3>{p.name}</h3>
                        <p>{p.requirements?.topic || "新的创作计划"}</p>
                        <div>
                          <span>
                            V{p.revision} · {dateText(p.updatedAt)}
                          </span>
                          <b>↗</b>
                        </div>
                      </div>
                    </button>
                  ))}
                </div>
              ) : (
                <Empty title="第一段故事，还在等你">
                  新建项目，从空白开始；也可以使用狼疮科普模板，体验完整的审稿流程。
                </Empty>
              )}
            </>
          )}
        </main>
        <footer className="workspace-footer">
          映序 · 让创意有序发生 <span>从需求到成片，每一步可追溯。</span>
        </footer>
      </div>
      {toast && (
        <div className="toast" role="status">
          ✓ {toast}
        </div>
      )}
      {busy && <div className="busy-line" aria-label="正在处理" />}
      {create && (
        <CreateProject
          busy={busy}
          onClose={() => setCreate(false)}
          onCreate={async (name, requirements, template) => {
            const p = await act(
              () =>
                api<Project>("/api/projects", "POST", {
                  name,
                  requirements,
                  template,
                }),
              "项目已创建",
            );
            if (p) {
              setProjects((list) => [p, ...list]);
              selectedRef.current = p.id;
              setProject(p);
              setTab("requirements");
              setCreate(false);
            }
          }}
        />
      )}{" "}
      {zoom && (
        <Modal title={zoom.title} onClose={() => setZoom(null)} wide>
          <img className="zoom-image" src={zoom.src} alt={zoom.title} />
        </Modal>
      )}
    </div>
  );
}

function Login({
  setup,
  busy,
  onSubmit,
  error,
}: {
  setup: boolean;
  busy: boolean;
  onSubmit: (password: string) => void;
  error: string;
}) {
  const [password, setPassword] = useState("");
  return (
    <form
      className="login-card"
      onSubmit={(e) => {
        e.preventDefault();
        onSubmit(password);
      }}
    >
      <span className="eyebrow">YOUR PRIVATE WORKSPACE</span>
      <h2>{setup ? "欢迎，故事的创作者" : "欢迎回到映序"}</h2>
      <p>
        {setup
          ? "设置管理员密码，开启你的独立创作空间。"
          : "登录后，继续上一次的故事。"}
      </p>
      <label>
        管理员密码
        <input
          name="password"
          type="password"
          minLength={12}
          required
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          autoComplete={setup ? "new-password" : "current-password"}
          placeholder={setup ? "至少 12 位字符" : "输入密码"}
        />
      </label>
      {setup && (
        <small className="quiet">请保存好密码，它将用于访问本工作区。</small>
      )}
      {error && (
        <p className="inline-error" role="alert">
          {error}
        </p>
      )}
      <button className="primary" disabled={busy}>
        {busy ? "正在连接…" : setup ? "建立工作区 →" : "进入工作区 →"}
      </button>
    </form>
  );
}
function CreateProject({
  busy,
  onClose,
  onCreate,
}: {
  busy: boolean;
  onClose: () => void;
  onCreate: (
    name: string,
    requirements: Requirements,
    template?: "lupus-v6",
  ) => void;
}) {
  const [template, setTemplate] = useState(false),
    [name, setName] = useState(""),
    [topic, setTopic] = useState("");
  return (
    <Modal title="开启新的创作" onClose={onClose}>
      <form
        className="form-stack"
        onSubmit={(e) => {
          e.preventDefault();
          onCreate(
            name.trim() ||
              (template ? "把线索连成答案 · 狼疮科普" : "未命名故事"),
            {
              ...defaultRequirements,
              topic: topic || (template ? "系统性红斑狼疮" : ""),
            },
            template ? "lupus-v6" : undefined,
          );
        }}
      >
        <div className="template-choice">
          <button
            type="button"
            className={!template ? "chosen" : ""}
            onClick={() => setTemplate(false)}
          >
            <span>＋</span>
            <b>从空白开始</b>
            <small>你的主题，你的讲述方式</small>
          </button>
          <button
            type="button"
            className={template ? "chosen" : ""}
            onClick={() => setTemplate(true)}
          >
            <span>✧</span>
            <b>狼疮科普模板</b>
            <small>60 秒 · 本体与分镜示例</small>
          </button>
        </div>
        <label>
          项目名称
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder={
              template ? "把线索连成答案 · 狼疮科普" : "为你的故事取个名字"
            }
            maxLength={120}
          />
        </label>
        <label>
          视频主题
          <input
            value={topic}
            onChange={(e) => setTopic(e.target.value)}
            placeholder={
              template ? "系统性红斑狼疮" : "这一次，你希望观众了解什么？"
            }
          />
        </label>
        <div className="notice">
          <span>
            模板中的人物与图片是脱敏示例。制作前需要补齐并审核你实际使用的素材。
          </span>
        </div>
        <button className="primary" disabled={busy}>
          创建项目 →
        </button>
      </form>
    </Modal>
  );
}

type PanelProps = {
  project: Project;
  act: Act;
  update: (p: Project) => void;
  mutate: (
    path: string,
    method: string,
    body: unknown,
    message: string,
  ) => Promise<Project | undefined>;
  submit: (path: string, body?: Record<string, unknown>) => Promise<void>;
  busy: boolean;
  onZoom: (src: string, title: string) => void;
};
function RequirementFields({
  value,
  onChange,
}: {
  value: Requirements;
  onChange: (v: Requirements) => void;
}) {
  const change = (key: keyof Requirements, v: unknown) =>
    onChange({ ...value, [key]: v });
  return (
    <div className="form-grid">
      <label className="full">
        视频主题
        <input
          value={value.topic}
          onChange={(e) => change("topic", e.target.value)}
          placeholder="观众看完后，需要记住什么？"
        />
      </label>
      <label>
        目标观众
        <input
          value={value.audience}
          onChange={(e) => change("audience", e.target.value)}
        />
      </label>
      <label>
        影片时长（秒）
        <input
          type="number"
          min={1}
          max={600}
          value={value.duration}
          onChange={(e) => change("duration", Number(e.target.value))}
        />
      </label>
      <label>
        画面比例
        <select
          value={value.aspect}
          onChange={(e) => change("aspect", e.target.value)}
        >
          <option value="9:16">9:16 · 竖屏</option>
          <option value="16:9">16:9 · 横屏</option>
        </select>
      </label>
      <label>
        每秒帧数
        <select
          value={value.fps}
          onChange={(e) => change("fps", Number(e.target.value))}
        >
          <option value={25}>25 fps</option>
          <option value={24}>24 fps</option>
        </select>
      </label>
      <label>
        医生出镜方式
        <select
          value={value.doctorMode}
          onChange={(e) => change("doctorMode", e.target.value)}
        >
          <option value="photo">指定医生照片 · 音轨驱动口型</option>
          <option value="fictional">虚构医生 · 模型生成</option>
        </select>
      </label>
      <label>
        画面风格
        <input
          value={value.style}
          onChange={(e) => change("style", e.target.value)}
        />
      </label>
      <label className="full">
        声音要求
        <textarea
          rows={2}
          value={value.sound}
          onChange={(e) => change("sound", e.target.value)}
        />
      </label>
      <label className="full">
        创作需求
        <textarea
          rows={5}
          value={value.brief}
          onChange={(e) => change("brief", e.target.value)}
          placeholder="要讲述的故事、必须出现的内容、希望避免的内容……"
        />
      </label>
    </div>
  );
}
function RequirementsPanel({
  project,
  act,
  update,
  mutate,
  busy,
  onZoom,
}: PanelProps) {
  const [value, setValue] = useState(project.requirements),
    [name, setName] = useState(project.name),
    [dirty, setDirty] = useState(false),
    [uploaded, setUploaded] = useState(false);
  useEffect(() => {
    if (!dirty) {
      setValue(project.requirements);
      setName(project.name);
    }
  }, [project.revision, dirty]);
  return (
    <>
      <SectionHead eyebrow="01 / INTENT" title="先确定，为什么讲这个故事。">
        明确受众和表达目标，再把资料交给故事。
      </SectionHead>
      <div className="requirements-layout">
        <form
          className="card form-stack"
          onSubmit={async (e) => {
            e.preventDefault();
            const p = await mutate(
              "",
              "PATCH",
              { baseRevision: project.revision, name, requirements: value },
              "需求已保存",
            );
            if (p) setDirty(false);
          }}
        >
          <div className="card-heading">
            <h3>创作简报</h3>
            {dirty ? (
              <Badge status="pending">尚未保存</Badge>
            ) : (
              <Badge status="pass">已保存</Badge>
            )}
          </div>
          <label>
            项目名称
            <input
              value={name}
              onChange={(e) => {
                setName(e.target.value);
                setDirty(true);
              }}
              required
            />
          </label>
          <RequirementFields
            value={value}
            onChange={(v) => {
              setValue(v);
              setDirty(true);
            }}
          />
          <div className="form-footer">
            <span className="quiet">
              修改需求后，请在展开阶段检查相关分镜。
            </span>
            <button className="primary" disabled={busy || !dirty}>
              保存需求
            </button>
          </div>
        </form>
        <aside className="materials-panel">
          <div className="card">
            <h3>带上你的制作资料</h3>
            <p className="quiet">
              文档、参考图与原始资料包，让每一个画面有据可依。
            </p>
            <label className="dropzone">
              <span>↑</span>
              <b>{busy ? "正在处理…" : "选择文件上传"}</b>
              <small>ZIP / PDF / DOCX / TXT / 图片与媒体</small>
              <input
                type="file"
                multiple
                disabled={busy}
                onChange={async (e) => {
                  if (!e.target.files?.length) return;
                  const data = new FormData();
                  Array.from(e.target.files).forEach((f) =>
                    data.append("files", f),
                  );
                  e.target.value = "";
                  const result = await act(
                    () =>
                      api(`/api/projects/${project.id}/files`, "POST", data),
                    "资料已上传，解析结果见文件列表",
                  );
                  if (result) {
                    update(await api<Project>(`/api/projects/${project.id}`));
                    setUploaded(true);
                  }
                }}
              />
            </label>
            {uploaded && (
              <small className="quiet">
                文件已保存。到审核阶段，将图片或媒体绑定到对应素材位。
              </small>
            )}
            <div className="file-list">
              {project.files.map((f) => (
                <details key={f.id}>
                  <summary>
                    <span className="file-type">
                      {f.mime.startsWith("image") ? "▧" : "▤"}
                    </span>
                    <span>
                      {f.name}
                      <small>{(f.bytes / 1024).toFixed(1)} KB</small>
                    </span>
                  </summary>
                  {f.mime.startsWith("image") && (
                    <MediaPreview
                      fileId={f.id}
                      mime={f.mime}
                      label={f.name}
                      onZoom={onZoom}
                    />
                  )}{" "}
                  {f.text ? (
                    <pre className="extracted-text">{f.text}</pre>
                  ) : (
                    <p className="quiet">
                      {String(
                        f.metadata?.parseError ||
                          "此文件没有可显示的文本。参考图片与媒体可直接绑定使用。",
                      )}
                    </p>
                  )}
                  <a href={fileUrl(f.id, true)}>下载原文件 ↓</a>
                </details>
              ))}
            </div>
            {!project.files.length && (
              <p className="quiet center">暂无已上传的资料</p>
            )}
          </div>
          <div className="note-card">
            <span className="eyebrow">小提示</span>
            <h3>一处对象，一份专属素材。</h3>
            <p>
              口腔溃疡、蝶形红斑、医生与道具应分别对应准确素材。上传不等于审核通过。
            </p>
          </div>
        </aside>
      </div>
    </>
  );
}

function ExpandPanel(props: PanelProps) {
  const { project, act, update, mutate, submit, busy } = props;
  const [view, setView] = useState<
      "story" | "ontology" | "references" | "history"
    >("story"),
    [editor, setEditor] = useState(JSON.stringify(project.ontology, null, 2)),
    [dirty, setDirty] = useState(false),
    [editing, setEditing] = useState<Shot | null>(null);
  const [query, setQuery] = useState(""),
    [source, setSource] = useState("pubmed"),
    [references, setReferences] = useState<any[]>([]),
    [searched, setSearched] = useState(false),
    [revisions, setRevisions] = useState<any[]>([]),
    [snapshot, setSnapshot] = useState<any>(null),
    [ontologyNode, setOntologyNode] = useState<string | null>(null);
  useEffect(() => {
    if (!dirty) setEditor(JSON.stringify(project.ontology, null, 2));
  }, [project.revision, dirty]);
  const patchOntology = async (o: Ontology) =>
    mutate(
      "",
      "PATCH",
      { baseRevision: project.revision, ontology: o },
      "故事修订已保存",
    );
  return (
    <>
      <SectionHead
        eyebrow="02 / DEVELOP"
        title="把想法，展开为完整的故事。"
        action={
          <>
            <button
              className="secondary"
              disabled={busy}
              onClick={() =>
                void act(async () => {
                  await api(`/api/projects/${project.id}/compile`, "POST");
                  update(await api<Project>(`/api/projects/${project.id}`));
                }, "本体已重新校验与编译")
              }
            >
              校验与编译
            </button>
            <button
              className="primary"
              disabled={busy}
              onClick={() => void submit("/expand")}
            >
              AI 展开故事 ↗
            </button>
          </>
        }
      >
        把人物、医学依据、动作与镜头联系起来，再决定每一帧要呈现什么。
      </SectionHead>
      <Issues compiled={project.compiled} />
      <div className="subnav" role="tablist" aria-label="展开视图">
        {(
          [
            { id: "story", label: "故事与分镜" },
            { id: "ontology", label: "本体与关系" },
            { id: "references", label: "参考与依据" },
            { id: "history", label: "修订历史" },
          ] as const
        ).map((v) => (
          <button
            role="tab"
            aria-selected={view === v.id}
            key={v.id}
            className={view === v.id ? "active" : ""}
            onClick={() => {
              setView(v.id);
              if (v.id === "history")
                void act(async () =>
                  setRevisions(
                    await api<any[]>(`/api/projects/${project.id}/revisions`),
                  ),
                );
            }}
          >
            {v.label}
          </button>
        ))}
      </div>
      {view === "story" && (
        <>
          <div className="stats-strip">
            <div>
              <strong>{project.ontology.shots.length}</strong>
              <span>个镜头</span>
            </div>
            <div>
              <strong>
                {
                  project.ontology.entities.filter(
                    (e) => e.type === "character",
                  ).length
                }
              </strong>
              <span>位角色</span>
            </div>
            <div>
              <strong>{project.ontology.assets.length}</strong>
              <span>处素材</span>
            </div>
            <div>
              <strong>
                {project.ontology.spec.totalFrames / project.ontology.spec.fps}
                <small>s</small>
              </strong>
              <span>故事长度</span>
            </div>
          </div>
          {!project.ontology.shots.length ? (
            <Empty
              title="故事还没有展开"
              action={
                <button
                  className="secondary"
                  disabled={busy}
                  onClick={() => setView("ontology")}
                >
                  手动编辑本体
                </button>
              }
            >
              先完善创作简报和资料，再使用 AI
              展开。也可以手动编辑，或从模板开始。
            </Empty>
          ) : (
            <div className="shot-list">
              {project.ontology.shots.map((s, index) => (
                <article className="shot-row" key={s.id}>
                  <div className="shot-number">
                    <span>{String(index + 1).padStart(2, "0")}</span>
                    <small>
                      {(s.startFrame / project.ontology.spec.fps).toFixed(1)}–
                      {(s.endFrame / project.ontology.spec.fps).toFixed(1)}s
                    </small>
                  </div>
                  <div className="shot-main">
                    <div className="card-heading">
                      <h3>{s.title}</h3>
                      <Badge>{routeLabels[s.route]}</Badge>
                    </div>
                    <p>{s.action}</p>
                    <div className="shot-chips">
                      <span>{s.scale || "待定景别"}</span>
                      <span>{s.camera || "待定机位"}</span>
                      {s.dependencies.length > 0 && (
                        <span>接续 {s.dependencies.join("、")}</span>
                      )}
                    </div>
                    {s.dialogue.length > 0 && (
                      <blockquote>
                        {s.dialogue.map((d) => (
                          <p key={d.id}>
                            <b>
                              {project.ontology.entities.find(
                                (e) => e.id === d.speakerId,
                              )?.label || d.speakerId}
                            </b>{" "}
                            “{d.text}”
                          </p>
                        ))}
                      </blockquote>
                    )}
                    <div className="shot-state">
                      <span>
                        <b>起始</b>
                        {s.startState || "待完善"}
                      </span>
                      <i>→</i>
                      <span>
                        <b>结束</b>
                        {s.endState || "待完善"}
                      </span>
                    </div>
                  </div>
                  <div className="shot-side">
                    <button
                      className="secondary small"
                      onClick={() => setEditing(s)}
                    >
                      编辑镜头
                    </button>
                    <Badge
                      status={currentReview(project, s.id)?.status || "pending"}
                    />
                    <small>
                      {s.requiredAssetIds.length} 处素材 ·{" "}
                      {s.evidenceIds.length} 条依据
                    </small>
                  </div>
                </article>
              ))}
            </div>
          )}
        </>
      )}
      {view === "ontology" && (
        <>
          <div className="section-head compact">
            <div>
              <h3>故事本体</h3>
              <p>
                对象、关系和约束共同描述故事；编译后形成可审核、可执行的镜头计划。
              </p>
            </div>
            <Badge>
              {project.ontology.entities.length} 对象 /{" "}
              {project.ontology.relations.length} 关系
            </Badge>
          </div>
          <div className="entity-grid">
            {project.ontology.entities.map((e) => (
              <article className="entity-card" key={e.id}>
                <span className="entity-symbol">
                  {e.type === "character"
                    ? "◉"
                    : e.type === "medical-fact"
                      ? "✧"
                      : "◇"}
                </span>
                <div>
                  <small>
                    {
                      {
                        character: "角色",
                        scene: "场景",
                        prop: "道具",
                        action: "动作",
                        "medical-fact": "医学事实",
                      }[e.type]
                    }{" "}
                    · {e.id}
                  </small>
                  <h3>{e.label}</h3>
                  <p>
                    {Object.entries(e.attributes)
                      .slice(0, 3)
                      .map(([k, v]) => `${k}：${v}`)
                      .join(" · ") || "尚未添加特征"}
                  </p>
                  {e.fictional && <Badge>创作设定</Badge>}
                  {e.evidenceIds.length > 0 && (
                    <Badge>{e.evidenceIds.length} 条依据</Badge>
                  )}
                </div>
              </article>
            ))}
          </div>
          <div className="card relations-card">
            <h3>关系与锚图</h3>
            <details className="json-details relation-diagram">
              <summary>展开本体关系框图</summary>
              <WorkflowGraph
                compiled={project.compiled}
                jobs={[]}
                variant="ontology"
                onInspect={setOntologyNode}
              />
            </details>
            {project.ontology.relations.length ? (
              <div className="relations-list">
                {project.ontology.relations.map((r) => (
                  <div key={r.id}>
                    <span>
                      {project.ontology.entities.find((e) => e.id === r.from)
                        ?.label || r.from}
                    </span>
                    <i>
                      {
                        {
                          part_of: "属于",
                          located_in: "位于",
                          holds: "持有",
                          depicts: "呈现",
                          supported_by: "依据",
                          depends_on: "依赖",
                        }[r.type]
                      }{" "}
                      →
                    </i>
                    <span>
                      {project.ontology.entities.find((e) => e.id === r.to)
                        ?.label || r.to}
                    </span>
                  </div>
                ))}
              </div>
            ) : (
              <p className="quiet">暂无关系，添加后可校验关联是否完整。</p>
            )}
            <details className="json-details">
              <summary>
                查看 {project.ontology.anchors.length} 个身份／状态锚点
              </summary>
              {project.ontology.anchors.map((a) => (
                <p key={a.id}>
                  <b>{a.id}</b> · {a.entityId} → {a.assetId} · {a.role} ·{" "}
                  {a.state}
                </p>
              ))}
            </details>
          </div>
          <form
            className="card form-stack ontology-editor"
            onSubmit={async (e) => {
              e.preventDefault();
              const p = await act(async () => {
                let value: Ontology;
                try {
                  value = JSON.parse(editor);
                } catch {
                  throw new Error("本体格式无法读取。请检查逗号、引号与括号。");
                }
                const p = await api<Project>(
                  `/api/projects/${project.id}`,
                  "PATCH",
                  { baseRevision: project.revision, ontology: value },
                );
                update(p);
                return p;
              }, "本体已保存并重新编译");
              if (p) setDirty(false);
            }}
          >
            <div className="card-heading">
              <h3>编辑本体数据</h3>
              {dirty && <Badge status="pending">有未保存的修改</Badge>}
            </div>
            <p className="quiet">
              用于精确维护对象、素材、镜头与约束。保存草稿后会列出具体校验问题，不会自动提交生成。
            </p>
            <textarea
              aria-label="本体 JSON"
              spellCheck={false}
              className="code-editor"
              rows={20}
              value={editor}
              onChange={(e) => {
                setEditor(e.target.value);
                setDirty(true);
              }}
            />
            <div className="actions">
              <button
                className="secondary"
                type="button"
                onClick={() => {
                  setEditor(JSON.stringify(project.ontology, null, 2));
                  setDirty(false);
                }}
              >
                恢复已保存内容
              </button>
              <button className="primary" disabled={busy || !dirty}>
                保存并校验
              </button>
            </div>
          </form>
        </>
      )}
      {view === "references" && (
        <>
          <form
            className="search-form card"
            onSubmit={async (e) => {
              e.preventDefault();
              await act(async () => {
                const result = await api<{ items: any[] }>(
                  `/api/references/search?q=${encodeURIComponent(query)}&source=${source}`,
                );
                setReferences(result.items);
                setSearched(true);
              });
            }}
          >
            <label>
              寻找医学依据与素材
              <input
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="例如：systemic lupus oral ulcers"
                required
              />
            </label>
            <label>
              来源
              <select
                value={source}
                onChange={(e) => {
                  setSource(e.target.value);
                  setSearched(false);
                  setReferences([]);
                }}
              >
                <option value="pubmed">PubMed / PMC · 医学依据</option>
                <option value="commons">Wikimedia Commons · 图片素材</option>
              </select>
            </label>
            <button className="primary" disabled={busy}>
              检索 ↗
            </button>
          </form>
          <p className="quiet">
            检索结果仅供筛选；请核对原始出处与使用许可，再加入项目。
          </p>
          {searched && !references.length && (
            <Empty title="没有找到匹配的结果">
              换一个更具体的关键词，或使用英文症状名称。
            </Empty>
          )}
          <div className="reference-grid">
            {references.map((r, index) => (
              <article className="card reference-card" key={r.id || index}>
                {r.image && (
                  <img
                    src={r.image}
                    loading="lazy"
                    alt={r.title}
                    referrerPolicy="no-referrer"
                  />
                )}
                <h3>{r.title}</h3>
                <p>{r.excerpt}</p>
                <small>
                  {r.author} {r.license && `· ${r.license}`}
                </small>
                <div className="actions">
                  <a
                    className="text-btn"
                    href={r.url}
                    target="_blank"
                    rel="noreferrer"
                  >
                    原始来源 ↗
                  </a>
                  <button
                    className="secondary small"
                    disabled={busy}
                    onClick={() =>
                      void mutate(
                        "/references",
                        "POST",
                        { baseRevision: project.revision, item: r },
                        "参考已加入项目，请确认对应关系与使用方式",
                      )
                    }
                  >
                    加入项目 ＋
                  </button>
                </div>
              </article>
            ))}
          </div>
          <SectionHead title="项目中的医学依据" />
          {project.ontology.evidence.map((e) => (
            <article className="card evidence-card" key={e.id}>
              <small>{e.id}</small>
              <h3>{e.title}</h3>
              <p>{e.excerpt}</p>
              {e.locator && <small>{e.locator}</small>}
              {e.url && (
                <a href={e.url} target="_blank" rel="noreferrer">
                  核对来源 ↗
                </a>
              )}
            </article>
          ))}
        </>
      )}
      {view === "history" && (
        <div className="history-layout">
          <div className="card">
            <h3>每一次修改，都有来处</h3>
            {revisions.map((r, i) => (
              <button
                className="revision-row"
                key={r.revision || i}
                onClick={() =>
                  void act(async () =>
                    setSnapshot(
                      await api(
                        `/api/projects/${project.id}/revisions/${r.revision}`,
                      ),
                    ),
                  )
                }
              >
                <span>V{r.revision}</span>
                <small>
                  {r.createdAt
                    ? dateText(r.createdAt)
                    : r.updatedAt
                      ? dateText(r.updatedAt)
                      : "已保存快照"}
                </small>
                <b>查看差异 ↗</b>
              </button>
            ))}
          </div>
          <div className="card">
            {snapshot ? (
              <RevisionDiff current={project.ontology} snapshot={snapshot} />
            ) : (
              <Empty title="选择一个历史版本">
                比较它与当前版本的故事、对象和素材差异。
              </Empty>
            )}
          </div>
        </div>
      )}
      {ontologyNode && (
        <Modal
          title={`本体对象 · ${ontologyNode}`}
          onClose={() => setOntologyNode(null)}
          wide
        >
          <JsonDetails
            title="对象详情"
            value={[
              ...project.ontology.entities,
              ...project.ontology.assets,
              ...project.ontology.anchors,
              ...project.ontology.relations,
              ...project.ontology.evidence,
              ...project.ontology.shots,
            ].find((x) => x.id === ontologyNode)}
          />
          <JsonDetails
            title="输入与输出关系"
            value={project.compiled.graph.edges.filter(
              (e) => e.from === ontologyNode || e.to === ontologyNode,
            )}
          />
        </Modal>
      )}
      {editing && (
        <ShotEditor
          shot={editing}
          fps={project.ontology.spec.fps}
          busy={busy}
          onClose={() => setEditing(null)}
          onSave={async (s) => {
            const p = await patchOntology({
              ...project.ontology,
              shots: project.ontology.shots.map((x) => (x.id === s.id ? s : x)),
            });
            if (p) setEditing(null);
          }}
        />
      )}
    </>
  );
}
function RevisionDiff({
  current,
  snapshot,
}: {
  current: Ontology;
  snapshot: any;
}) {
  const old =
    snapshot.ontology ||
    snapshot.snapshot?.ontology ||
    snapshot.project?.ontology ||
    snapshot;
  const rows: (keyof Ontology)[] = [
    "title",
    "spec",
    "entities",
    "relations",
    "assets",
    "anchors",
    "evidence",
    "shots",
    "postProgram",
  ];
  const changed = rows.filter(
    (k) => JSON.stringify(old[k]) !== JSON.stringify(current[k]),
  );
  return (
    <>
      <h3>历史版本 → 当前版本</h3>
      <p className="quiet">
        {changed.length} 类内容发生变化。左侧为历史内容，右侧为当前内容。
      </p>
      {changed.map((k) => (
        <details className="diff-row" key={k}>
          <summary>
            {
              (
                {
                  title: "标题",
                  spec: "画面规格",
                  entities: "对象",
                  relations: "关系",
                  assets: "素材",
                  anchors: "锚图",
                  evidence: "医学依据",
                  shots: "分镜",
                  postProgram: "后期方案",
                } as any
              )[k]
            }
          </summary>
          <div className="diff-columns">
            <pre>{JSON.stringify(old[k], null, 2) || "无"}</pre>
            <pre>{JSON.stringify(current[k], null, 2) || "无"}</pre>
          </div>
        </details>
      ))}
      {!changed.length && <Badge status="pass">与当前内容一致</Badge>}
    </>
  );
}
function ShotEditor({
  shot,
  fps,
  busy,
  onSave,
  onClose,
}: {
  shot: Shot;
  fps: number;
  busy: boolean;
  onSave: (s: Shot) => void;
  onClose: () => void;
}) {
  const [s, setS] = useState(structuredClone(shot));
  const field = (key: keyof Shot, v: unknown) => setS({ ...s, [key]: v });
  return (
    <Modal title={`编辑镜头 · ${shot.id}`} onClose={onClose} wide>
      <form
        className="form-stack"
        onSubmit={(e) => {
          e.preventDefault();
          onSave(s);
        }}
      >
        <div className="form-grid">
          <label className="full">
            镜头标题
            <input
              value={s.title}
              onChange={(e) => field("title", e.target.value)}
            />
          </label>
          <label>
            起始帧
            <input
              type="number"
              min={0}
              value={s.startFrame}
              onChange={(e) => field("startFrame", Number(e.target.value))}
            />
          </label>
          <label>
            结束帧（不包含）
            <input
              type="number"
              min={1}
              value={s.endFrame}
              onChange={(e) => field("endFrame", Number(e.target.value))}
            />
          </label>
          <label>
            景别
            <input
              value={s.scale}
              onChange={(e) => field("scale", e.target.value)}
            />
          </label>
          <label>
            机位与运镜
            <input
              value={s.camera}
              onChange={(e) => field("camera", e.target.value)}
            />
          </label>
          <label>
            制作方式
            <select
              value={s.route}
              onChange={(e) => field("route", e.target.value)}
            >
              <option value="seedance">故事视频</option>
              <option value="doctor">指定医生</option>
              <option value="graphic">医学图示</option>
            </select>
          </label>
          <div className="quiet field-note">
            {((s.endFrame - s.startFrame) / fps).toFixed(2)} 秒 ·
            修改对白后，对应口型需要重新制作。
          </div>
          <label className="full">
            动作与叙事
            <textarea
              rows={3}
              value={s.action}
              onChange={(e) => field("action", e.target.value)}
            />
          </label>
          <label>
            起始状态
            <textarea
              rows={2}
              value={s.startState}
              onChange={(e) => field("startState", e.target.value)}
            />
          </label>
          <label>
            结束状态
            <textarea
              rows={2}
              value={s.endState}
              onChange={(e) => field("endState", e.target.value)}
            />
          </label>
          {s.dialogue.map((d, i) => (
            <label className="full" key={d.id}>
              对白 · {d.speakerId}
              <textarea
                rows={2}
                value={d.text}
                onChange={(e) =>
                  field(
                    "dialogue",
                    s.dialogue.map((v, n) =>
                      n === i ? { ...v, text: e.target.value } : v,
                    ),
                  )
                }
              />
            </label>
          ))}
          {s.subtitles.map((c, i) => (
            <label className="full" key={c.id}>
              字幕 · {c.startFrame}–{c.endFrame} 帧
              <input
                value={c.text}
                onChange={(e) =>
                  field(
                    "subtitles",
                    s.subtitles.map((v, n) =>
                      n === i ? { ...v, text: e.target.value } : v,
                    ),
                  )
                }
              />
            </label>
          ))}
          <label className="full">
            必须呈现（每行一项）
            <textarea
              rows={2}
              value={s.mustShow.join("\n")}
              onChange={(e) =>
                field("mustShow", e.target.value.split("\n").filter(Boolean))
              }
            />
          </label>
          <label className="full">
            生成提示词
            <textarea
              rows={4}
              value={s.prompt}
              onChange={(e) => field("prompt", e.target.value)}
            />
          </label>
        </div>
        <div className="actions">
          <button className="secondary" type="button" onClick={onClose}>
            取消
          </button>
          <button className="primary" disabled={busy}>
            保存镜头修订
          </button>
        </div>
      </form>
    </Modal>
  );
}

function ReviewPanel(props: PanelProps) {
  const { project, act, update, mutate, busy, onZoom } = props;
  const [view, setView] = useState<"shots" | "assets" | "entities">("shots"),
    [filter, setFilter] = useState("all"),
    [batch, setBatch] = useState(false);
  const targets =
    view === "shots"
      ? project.ontology.shots
      : view === "assets"
        ? project.ontology.assets
        : project.ontology.entities;
  const pending = Object.keys(project.compiled.targetHashes).filter(
    (id) => currentReview(project, id)?.status !== "pass",
  );
  async function review(
    targetId: string,
    status: "pass" | "change" | "pending",
    note: string,
  ) {
    await mutate(
      "/reviews",
      "PUT",
      {
        targetId,
        targetHash: project.compiled.targetHashes[targetId],
        status,
        note,
      },
      "审核意见已保存",
    );
  }
  return (
    <>
      <SectionHead
        eyebrow="03 / REVIEW"
        title="好故事，经得起逐项确认。"
        action={
          <>
            <label className="button secondary upload-label">
              导入意见
              <input
                type="file"
                accept=".json"
                onChange={async (e) => {
                  const f = e.target.files?.[0];
                  e.target.value = "";
                  if (f)
                    await act(async () => {
                      const data = JSON.parse(await f.text());
                      update(
                        await api<Project>(
                          `/api/projects/${project.id}/reviews/import`,
                          "POST",
                          data,
                        ),
                      );
                    }, "意见已导入；版本不匹配的意见保留为历史记录");
                }}
              />
            </label>
            <button
              className="primary"
              disabled={busy}
              onClick={() => setBatch(true)}
            >
              批量确认可用内容
            </button>
          </>
        }
      >
        确认当前版本的故事、素材与医学对应。通过审核后，才可进入制作。
      </SectionHead>
      <Issues compiled={project.compiled} />
      <div className="review-summary">
        <div className="review-progress">
          <span
            style={{
              width: `${Object.keys(project.compiled.targetHashes).length ? 100 - (pending.length / Object.keys(project.compiled.targetHashes).length) * 100 : 0}%`,
            }}
          />
        </div>
        <span>
          <b>
            {Object.keys(project.compiled.targetHashes).length - pending.length}
          </b>{" "}
          / {Object.keys(project.compiled.targetHashes).length} 项已确认{" "}
          <small>意见绑定当前修订内容</small>
        </span>
      </div>
      <div className="review-toolbar">
        <div className="subnav">
          <button
            className={view === "shots" ? "active" : ""}
            onClick={() => setView("shots")}
          >
            分镜与台词 <small>{project.ontology.shots.length}</small>
          </button>
          <button
            className={view === "assets" ? "active" : ""}
            onClick={() => setView("assets")}
          >
            专属素材 <small>{project.ontology.assets.length}</small>
          </button>
          <button
            className={view === "entities" ? "active" : ""}
            onClick={() => setView("entities")}
          >
            人物与事实 <small>{project.ontology.entities.length}</small>
          </button>
        </div>
        <label className="sr-only" htmlFor="review-filter">
          筛选审核状态
        </label>
        <select
          id="review-filter"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
        >
          <option value="all">全部内容</option>
          <option value="pending">待审核</option>
          <option value="change">需要修改</option>
          <option value="pass">已通过</option>
        </select>
      </div>
      <div className={view === "assets" ? "asset-grid" : "review-list"}>
        {targets
          .filter(
            (t) =>
              filter === "all" ||
              (currentReview(project, t.id)?.status || "pending") === filter,
          )
          .map((t) => {
            const r = currentReview(project, t.id);
            return (
              <article
                className={`card review-card ${r?.status || "pending"}`}
                key={t.id}
              >
                {view === "assets" ? (
                  <AssetContents asset={t as Asset} {...props} />
                ) : view === "shots" ? (
                  <>
                    <div className="card-heading">
                      <div>
                        <small className="eyebrow">
                          {t.id} ·{" "}
                          {(
                            (t as Shot).startFrame / project.ontology.spec.fps
                          ).toFixed(1)}
                          –
                          {(
                            (t as Shot).endFrame / project.ontology.spec.fps
                          ).toFixed(1)}
                          s
                        </small>
                        <h3>{(t as Shot).title}</h3>
                      </div>
                      <Badge>{routeLabels[(t as Shot).route]}</Badge>
                    </div>
                    <p>{(t as Shot).action}</p>
                    {(t as Shot).dialogue.map((d) => (
                      <blockquote key={d.id}>
                        <b>
                          {project.ontology.entities.find(
                            (e) => e.id === d.speakerId,
                          )?.label || d.speakerId}
                        </b>{" "}
                        “{d.text}”
                      </blockquote>
                    ))}
                    <div className="review-checks">
                      <div>
                        <b>必须看见</b>
                        <p>{(t as Shot).mustShow.join("；") || "未单独指定"}</p>
                      </div>
                      <div>
                        <b>不应出现</b>
                        <p>{(t as Shot).rejectIf.join("；") || "未单独指定"}</p>
                      </div>
                    </div>
                    {(t as Shot).subtitles.length > 0 && (
                      <div className="caption-preview">
                        字幕：
                        {(t as Shot).subtitles.map((c) => c.text).join(" / ")}
                      </div>
                    )}
                    <div className="inline-asset-links">
                      {(t as Shot).requiredAssetIds.map((id) => {
                        const a = project.ontology.assets.find(
                          (x) => x.id === id,
                        );
                        return (
                          <span key={id} className={a?.gap ? "gap" : ""}>
                            {a?.gap ? "○" : "✓"} {a?.label || id}
                          </span>
                        );
                      })}
                    </div>
                    <details className="json-details">
                      <summary>查看实际编译提示词与医学依据</summary>
                      <p>{project.compiled.prompts[t.id]}</p>
                      {(t as Shot).evidenceIds.map((id) => {
                        const e = project.ontology.evidence.find(
                          (x) => x.id === id,
                        );
                        return (
                          <p key={id}>
                            {e?.title || id}
                            {e?.url && (
                              <>
                                {" "}
                                ·{" "}
                                <a
                                  href={e.url}
                                  target="_blank"
                                  rel="noreferrer"
                                >
                                  来源 ↗
                                </a>
                              </>
                            )}
                          </p>
                        );
                      })}
                    </details>
                  </>
                ) : (
                  <>
                    <small className="eyebrow">{t.id}</small>
                    <h3>{(t as any).label}</h3>
                    <p>
                      {Object.entries((t as any).attributes || {})
                        .map(([k, v]) => `${k}：${v}`)
                        .join("；")}
                    </p>
                    {(t as any).fictional && <Badge>创作设定</Badge>}
                    <p className="quiet">
                      对应依据：{(t as any).evidenceIds?.join("、") || "无"}
                    </p>
                  </>
                )}
                <ReviewControls
                  key={`${t.id}-${r?.updatedAt || "none"}`}
                  status={r?.status || "pending"}
                  note={r?.note || ""}
                  busy={busy}
                  canPass={
                    view !== "assets" ||
                    (!(t as Asset).gap && !!(t as Asset).fileId)
                  }
                  onSave={(status, note) => void review(t.id, status, note)}
                />
              </article>
            );
          })}
      </div>
      {targets.length === 0 && (
        <Empty title="这里还没有待审内容">
          先在展开阶段创建故事和素材清单。
        </Empty>
      )}
      {view === "shots" && (
        <article className="card review-card post-review">
          <div className="card-heading">
            <h3>后期、字幕与图示方案</h3>
            <Badge>
              {project.ontology.postProgram?.elements.length || 0} 个图示元素
            </Badge>
          </div>
          <p className="quiet">
            字幕和图示将在已通过的视频与原声音轨上制作；不会用字幕替代正确发音。
          </p>
          <JsonDetails
            title="查看声明式后期方案"
            value={project.ontology.postProgram || { elements: [] }}
          />
          <ReviewControls
            key={currentReview(project, "post")?.updatedAt || "post"}
            status={currentReview(project, "post")?.status || "pending"}
            note={currentReview(project, "post")?.note || ""}
            busy={busy}
            onSave={(status, note) => void review("post", status, note)}
          />
        </article>
      )}
      {batch && (
        <Modal title="确认当前可用内容" onClose={() => setBatch(false)}>
          <p>
            该操作会将当前已具备素材、没有校验错误的内容标记为通过。请先完成事实核对与逐镜阅读。
          </p>
          <div className="notice">
            缺失素材不会自动补齐；有错误或素材缺口的镜头会保留待审。
          </div>
          <div className="actions">
            <button className="secondary" onClick={() => setBatch(false)}>
              继续逐项检查
            </button>
            <button
              className="primary"
              disabled={busy}
              onClick={() =>
                void act(async () => {
                  let p = project;
                  const validAssets = project.ontology.assets.filter(
                    (a) => !a.gap && !!a.fileId,
                  );
                  const validShots = project.ontology.shots.filter(
                    (s, index) =>
                      !project.compiled.gaps.some((g) =>
                        g.shotIds.includes(s.id),
                      ) &&
                      !project.compiled.issues.some(
                        (i) =>
                          i.severity === "error" &&
                          (i.path.includes(s.id) ||
                            i.path.startsWith(`shots[${index}]`) ||
                            !i.path.startsWith("shots[")),
                      ),
                  );
                  const ids = [
                    ...project.ontology.entities.map((e) => e.id),
                    ...validAssets.map((a) => a.id),
                    ...validShots.map((s) => s.id),
                    "post",
                  ].filter((id) => project.compiled.targetHashes[id]);
                  for (const targetId of ids)
                    p = await api<Project>(
                      `/api/projects/${project.id}/reviews`,
                      "PUT",
                      {
                        targetId,
                        targetHash: project.compiled.targetHashes[targetId],
                        status: "pass",
                        note: "已逐项核对后批量确认。",
                      },
                    );
                  update(p);
                  setBatch(false);
                }, "当前可用内容已确认，仍需处理的缺口已保留")
              }
            >
              我已核对，确认可用内容
            </button>
          </div>
        </Modal>
      )}
    </>
  );
}
function ReviewControls({
  status,
  note,
  busy,
  onSave,
  canPass = true,
}: {
  canPass?: boolean;
  status: "pending" | "pass" | "change";
  note: string;
  busy: boolean;
  onSave: (status: "pending" | "pass" | "change", note: string) => void;
}) {
  const [text, setText] = useState(note);
  return (
    <div className="review-controls">
      <div className="card-heading">
        <Badge status={status} />
        <span className="quiet">审核当前内容</span>
      </div>
      <textarea
        aria-label="审核意见"
        rows={2}
        value={text}
        onChange={(e) => setText(e.target.value)}
        placeholder="写下需要调整的地方，或本次确认的重点…"
      />
      <div className="actions">
        <button
          className="text-btn"
          disabled={busy}
          onClick={() => onSave("pending", text)}
        >
          保存意见
        </button>
        <button
          className="secondary small"
          disabled={busy}
          onClick={() => onSave("change", text)}
        >
          需要修改
        </button>
        <button
          className="primary small"
          disabled={busy || !canPass}
          title={!canPass ? "请先绑定并核对对应素材" : undefined}
          onClick={() => onSave("pass", text)}
        >
          ✓ 通过
        </button>
      </div>
    </div>
  );
}
function AssetContents({
  asset,
  project,
  mutate,
  busy,
  onZoom,
}: PanelProps & { asset: Asset }) {
  const [fileId, setFileId] = useState(asset.fileId || "");
  const file = project.files.find((f) => f.id === asset.fileId);
  return (
    <>
      <div className="asset-media">
        <MediaPreview
          fileId={asset.fileId}
          mime={file?.mime}
          label={asset.label}
          onZoom={onZoom}
        />
        <Badge status={asset.gap ? "pending" : "pass"}>
          {asset.gap
            ? "素材缺口"
            : asset.purpose === "reference"
              ? "仅作参考"
              : "成片素材"}
        </Badge>
      </div>
      <div className="card-heading">
        <h3>{asset.label}</h3>
        <small>{asset.id}</small>
      </div>
      {asset.mustShow?.length ? (
        <p className="quiet">
          <b>必须对应：</b>
          {asset.mustShow.join("；")}
        </p>
      ) : null}
      {asset.rejectIf?.length ? (
        <p className="quiet">
          <b>不可替代：</b>
          {asset.rejectIf.join("；")}
        </p>
      ) : null}
      {asset.source && (
        <div className="asset-source">
          <span>
            {asset.source.author || "作者待核对"} ·{" "}
            {asset.source.license || "许可待核对"}
          </span>
          {asset.source.url && (
            <a href={asset.source.url} target="_blank" rel="noreferrer">
              查看来源 ↗
            </a>
          )}
          {asset.source.use && <small>{asset.source.use}</small>}
        </div>
      )}
      <label className="bind-label">
        绑定专属文件
        <select
          aria-label={`绑定${asset.label}`}
          value={fileId}
          onChange={(e) => setFileId(e.target.value)}
        >
          <option value="">选择已上传的文件</option>
          {project.files.map((f) => (
            <option value={f.id} key={f.id}>
              {f.name}
            </option>
          ))}
        </select>
      </label>
      <button
        className="secondary small full-width"
        disabled={busy || !fileId || fileId === asset.fileId}
        onClick={() =>
          void mutate(
            "/assets/bind",
            "POST",
            { baseRevision: project.revision, assetId: asset.id, fileId },
            "素材已绑定，相关内容需要重新审核",
          )
        }
      >
        绑定此文件
      </button>
    </>
  );
}

function VideoPanel(props: PanelProps & { config: Config | null }) {
  const { project, act, update, submit, busy, config, onZoom } = props;
  const [view, setView] = useState<"flow" | "jobs" | "results">("flow"),
    [node, setNode] = useState<string | null>(null),
    [jobId, setJobId] = useState<string | null>(null),
    [submission, setSubmission] = useState(false),
    [importing, setImporting] = useState(false),
    [selected, setSelected] = useState<string[]>([]);
  const inspectJob = project.jobs.find((j) => j.id === jobId),
    task = project.compiled.tasks.find((t) => t.id === node);
  const related = task
    ? [...project.jobs]
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
        .filter(
          (j) =>
            j.kind === task.kind &&
            j.shotId === task.shotId &&
            isCurrentJob(j, project.compiled),
        )
    : [];
  const latest = related[0];
  const counts = {
    complete: project.jobs.filter((j) => j.state === "complete").length,
    active: project.jobs.filter((j) => ["running", "queued"].includes(j.state))
      .length,
    review: project.jobs.filter((j) => j.state === "waiting_review").length,
    failed: project.jobs.filter((j) =>
      ["failed", "uncertain", "blocked"].includes(j.state),
    ).length,
  };
  async function jobAction(id: string, action: string) {
    await act(
      async () => {
        await api(
          `/api/jobs/${id}/${action}`,
          "POST",
          action === "apply"
            ? { baseRevision: project.revision }
            : { idempotencyKey: idempotencyKey() },
        );
        update(await api<Project>(`/api/projects/${project.id}`));
      },
      action === "cancel"
        ? "已请求取消"
        : action === "apply"
          ? "建议已应用为新修订"
          : "该任务已提交重试",
    );
  }
  return (
    <>
      <SectionHead
        eyebrow="04 / PRODUCTION"
        title="把已确认的故事，带到画面里。"
        action={
          <>
            <button
              className="secondary"
              disabled={busy}
              onClick={() => void submit("/post-plan")}
            >
              生成后期方案
            </button>
            <button
              className="secondary"
              disabled={busy}
              onClick={() => void submit("/compose")}
            >
              合成影片
            </button>
            <button
              className="primary"
              disabled={busy || !project.ontology.shots.length}
              onClick={() => {
                setSelected(
                  project.ontology.shots
                    .filter((s) => s.route !== "graphic")
                    .map((s) => s.id),
                );
                setSubmission(true);
              }}
            >
              提交镜头制作 →
            </button>
          </>
        }
      >
        按审核后的输入制作，保留原片和音轨。素材与成片分别验收。
      </SectionHead>
      <div className="capabilities">
        {Object.entries(config?.capabilities || {}).map(([key, c]) => (
          <div key={key} className={c.configured ? "ready" : "unavailable"}>
            <span className="status-dot" />
            <div>
              <b>
                {{
                  seedance: "故事与原声",
                  fal: "医生口型",
                  opus: "故事与后期",
                  media: "剪辑与合成",
                }[key] || key}
              </b>
              <small>
                {c.configured ? c.model || "已就绪" : c.reason || "待配置"}
              </small>
            </div>
            <Badge status={c.configured ? "pass" : "pending"}>
              {c.configured ? "可用" : "待配置"}
            </Badge>
          </div>
        ))}
      </div>
      <Issues compiled={project.compiled} />
      <div className="stats-strip production-stats">
        <div>
          <strong>{counts.active}</strong>
          <span>正在制作</span>
        </div>
        <div>
          <strong>{counts.review}</strong>
          <span>等待审核</span>
        </div>
        <div>
          <strong>{counts.complete}</strong>
          <span>任务完成</span>
        </div>
        <div>
          <strong>{counts.failed}</strong>
          <span>需要处理</span>
        </div>
      </div>
      <div className="subnav">
        <button
          className={view === "flow" ? "active" : ""}
          onClick={() => setView("flow")}
        >
          制作框图
        </button>
        <button
          className={view === "jobs" ? "active" : ""}
          onClick={() => setView("jobs")}
        >
          任务记录 <small>{project.jobs.length}</small>
        </button>
        <button
          className={view === "results" ? "active" : ""}
          onClick={() => setView("results")}
        >
          素材与成片 <small>{project.artifacts.length}</small>
        </button>
        <button
          className="refresh-btn"
          disabled={busy}
          onClick={() =>
            void act(async () =>
              update(await api<Project>(`/api/projects/${project.id}`)),
            )
          }
        >
          ↻ 刷新
        </button>
      </div>
      {view === "flow" && (
        <>
          <div className="graph-caption">
            <p>箭头表示依赖关系，点击节点查看输入与产物；宽图可横向滑动。</p>
            <span>
              <i /> 尚未提交 <i className="green" /> 已完成{" "}
              <i className="coral" /> 需要处理
            </span>
          </div>
          <WorkflowGraph
            compiled={project.compiled}
            jobs={project.jobs}
            artifacts={project.artifacts}
            onInspect={setNode}
          />
          <div className="workflow-notes">
            <article>
              <span>01</span>
              <h3>声音先通过，口型再制作</h3>
              <p>
                指定医生使用逐句确认的同一音轨。错词需先改声音；仅口型不符，可保留已审音轨。
              </p>
            </article>
            <article>
              <span>02</span>
              <h3>按真实素材制作后期</h3>
              <p>图示与字幕依据最终底片和原声定时。生成完成不等于内容通过。</p>
            </article>
            <article>
              <span>03</span>
              <h3>只返修受影响的部分</h3>
              <p>
                失败任务可以单独处理。提交是否被受理不明时，先核对原任务，不自动重投。
              </p>
            </article>
          </div>
        </>
      )}
      {view === "jobs" && (
        <div className="job-list">
          {!project.jobs.length && (
            <Empty title="还没有制作任务">
              审核通过后，选择镜头并提交。缺少模型配置时，会显示具体原因。
            </Empty>
          )}
          {[...project.jobs]
            .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
            .map((j) => (
              <article className="card job-card" key={j.id}>
                <div className="job-symbol">
                  {j.kind === "compose" ? "▶" : j.kind === "voice" ? "♫" : "◇"}
                </div>
                <div className="job-main">
                  <div className="card-heading">
                    <h3>
                      {j.shotId ? `${j.shotId} · ` : ""}
                      {routeLabels[j.kind] || j.kind}
                    </h3>
                    <Badge status={j.state} />
                  </div>
                  <p>{j.error || stageText(j.stage) || "等待更新"}</p>
                  <small>
                    {dateText(j.updatedAt)} · 第 {j.attempts} 次尝试
                  </small>
                  {j.state === "uncertain" && (
                    <div className="notice warn">
                      请求是否已被受理尚未确定，请先核对原任务。不会自动重复提交。
                    </div>
                  )}
                  {j.result?.applied === false && (
                    <div className="notice warn">
                      创作内容已更新，本次建议尚未覆盖当前修订。请查看结果后决定是否应用。
                    </div>
                  )}
                </div>
                <div className="job-actions">
                  <button
                    className="secondary small"
                    onClick={() => setJobId(j.id)}
                  >
                    查看详情
                  </button>
                  {["queued", "running", "waiting_review", "blocked"].includes(
                    j.state,
                  ) && (
                    <button
                      className="text-btn"
                      disabled={busy}
                      onClick={() => void jobAction(j.id, "cancel")}
                    >
                      取消任务
                    </button>
                  )}
                  {["failed", "blocked"].includes(j.state) && (
                    <button
                      className="text-btn"
                      disabled={busy}
                      onClick={() => void jobAction(j.id, "retry")}
                    >
                      重试此任务
                    </button>
                  )}
                </div>
              </article>
            ))}
        </div>
      )}
      {view === "results" && (
        <>
          <div className="actions">
            <button className="secondary" onClick={() => setImporting(true)}>
              导入已有镜头素材 ＋
            </button>
          </div>
          <div className="notice">
            <span>
              先播放并审核生成素材，再选择入剪。医生原声通过后，才会继续口型驱动。
            </span>
          </div>
          {!project.artifacts.length ? (
            <Empty title="影片从这里诞生">
              生成素材、原声和最终影片会在完成后出现在这里；当前没有可播放的结果。
            </Empty>
          ) : (
            <div className="artifact-grid">
              {[...project.artifacts]
                .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
                .map((a) => (
                  <ArtifactCard key={a.id} artifact={a} {...props} />
                ))}
            </div>
          )}
        </>
      )}
      {(node || inspectJob) && (
        <Modal
          title={
            inspectJob
              ? `${routeLabels[inspectJob.kind]} · 任务详情`
              : task
                ? `${task.shotId || ""} · ${routeLabels[task.kind]}`
                : "流程节点"
          }
          onClose={() => {
            setNode(null);
            setJobId(null);
          }}
          wide
        >
          {task && !inspectJob && (
            <>
              <div className="notice">
                <b>{latest ? statusLabels[latest.state] : "尚未提交"}</b>
                <span>
                  {latest?.error ||
                    (latest?.stage ? stageText(latest.stage) : undefined) ||
                    "这是当前本体编译出的制作计划。提交后才能查看实际结果。"}
                </span>
              </div>
              <h3>前置条件</h3>
              <p>{task.dependsOn.join(" → ") || "无前置制作任务"}</p>
              <JsonDetails title="计划输入" value={task.input} />
            </>
          )}
          {inspectJob || latest ? (
            <JobDetails
              job={(inspectJob || latest)!}
              busy={busy}
              onAction={(action) =>
                void jobAction((inspectJob || latest)!.id, action)
              }
              onReconcile={async (providerTaskId) => {
                await act(async () => {
                  await api(
                    `/api/jobs/${(inspectJob || latest)!.id}/reconcile`,
                    "POST",
                    { providerTaskId },
                  );
                  update(await api<Project>(`/api/projects/${project.id}`));
                }, "已绑定核对后的任务，继续查询结果");
              }}
            />
          ) : (
            <>
              <p className="quiet">暂无供应商回执与实际使用条件。</p>
              {task &&
                project.artifacts.some(
                  (a) =>
                    a.kind === task.kind &&
                    a.shotId === task.shotId &&
                    a.sourceHash ===
                      project.compiled.shotHashes[a.shotId || ""],
                ) && (
                  <button
                    className="secondary"
                    onClick={() => {
                      setNode(null);
                      setJobId(null);
                      setView("results");
                    }}
                  >
                    查看已导入的对应素材 →
                  </button>
                )}
            </>
          )}
        </Modal>
      )}
      {importing && (
        <ImportArtifact {...props} onClose={() => setImporting(false)} />
      )}{" "}
      {submission && (
        <Modal title="提交已审核镜头" onClose={() => setSubmission(false)}>
          <p>
            仅提交本次选择的镜头。每个新任务可能产生服务费用；重复输入会去重，提交不明不会自动重投。
          </p>
          <div className="shot-selection">
            {project.ontology.shots
              .filter((s) => s.route !== "graphic")
              .map((s) => (
                <label key={s.id}>
                  <input
                    type="checkbox"
                    checked={selected.includes(s.id)}
                    onChange={(e) =>
                      setSelected((list) =>
                        e.target.checked
                          ? [...list, s.id]
                          : list.filter((id) => id !== s.id),
                      )
                    }
                  />
                  <span>
                    <b>
                      {s.id} · {s.title}
                    </b>
                    <small>
                      {routeLabels[s.route]} ·{" "}
                      {(
                        (s.endFrame - s.startFrame) /
                        project.ontology.spec.fps
                      ).toFixed(1)}{" "}
                      秒
                    </small>
                  </span>
                  <Badge
                    status={currentReview(project, s.id)?.status || "pending"}
                  />
                </label>
              ))}
          </div>
          <div className="notice">
            未审核内容、素材缺口或配置不完整时，系统会阻止制作并说明原因。
          </div>
          <div className="actions">
            <button className="secondary" onClick={() => setSubmission(false)}>
              返回检查
            </button>
            <button
              className="primary"
              disabled={busy || !selected.length}
              onClick={async () => {
                await submit("/runs", { shotIds: selected });
                setSubmission(false);
                setView("jobs");
              }}
            >
              提交 {selected.length} 个镜头
            </button>
          </div>
        </Modal>
      )}
    </>
  );
}
function JobDetails({
  job,
  busy,
  onAction,
  onReconcile,
}: {
  job: Job;
  busy: boolean;
  onAction: (action: string) => void;
  onReconcile: (id: string) => void;
}) {
  const [taskId, setTaskId] = useState("");
  return (
    <div className="job-details">
      <div className="card-heading">
        <h3>
          {job.shotId || "工程"} · {routeLabels[job.kind]}
        </h3>
        <Badge status={job.state} />
      </div>
      {job.error && <div className="notice warn">{job.error}</div>}
      <dl>
        <div>
          <dt>当前阶段</dt>
          <dd>{stageText(job.stage)}</dd>
        </div>
        <div>
          <dt>创建时间</dt>
          <dd>{dateText(job.createdAt)}</dd>
        </div>
        <div>
          <dt>最近更新</dt>
          <dd>{dateText(job.updatedAt)}</dd>
        </div>
        <div>
          <dt>供应商任务</dt>
          <dd>{job.handle?.id || "暂无已受理回执"}</dd>
        </div>
      </dl>
      <JsonDetails title="本次输入快照" value={job.input} />
      {job.handle && (
        <JsonDetails title="实际模型、条件与供应商回执" value={job.handle} />
      )}{" "}
      {job.result && (
        <JsonDetails title="任务结果 / 待应用建议" value={job.result} />
      )}{" "}
      {job.result?.applied === false && (
        <button
          className="primary"
          disabled={busy}
          onClick={() => onAction("apply")}
        >
          应用此建议到当前修订
        </button>
      )}
      {job.state === "uncertain" && (
        <form
          className="form-stack"
          onSubmit={(e) => {
            e.preventDefault();
            onReconcile(taskId.trim());
          }}
        >
          <p className="quiet">
            请先在供应商处核对是否受理，再填写该次真实任务编号继续查询。此操作不会重新生成。
          </p>
          <label>
            已核对的供应商任务编号
            <input
              required
              value={taskId}
              onChange={(e) => setTaskId(e.target.value)}
            />
          </label>
          <button className="secondary" disabled={busy || !taskId.trim()}>
            绑定原任务并继续查询
          </button>
        </form>
      )}
    </div>
  );
}
function ArtifactCard({
  artifact: a,
  project,
  act,
  update,
  busy,
  onZoom,
}: PanelProps & { artifact: Artifact }) {
  const file = project.files.find((f) => f.id === a.fileId);
  const selection = (
    project as Project & {
      selections?: { artifactId: string; sourceInSeconds: number }[];
    }
  ).selections?.find((s) => s.artifactId === a.id);
  const currentHash = a.shotId
    ? project.compiled.shotHashes[a.shotId]
    : project.compiled.postHash;
  const stale = a.shotId && a.sourceHash !== currentHash;
  const [note, setNote] = useState(String(a.metadata.reviewNote || "")),
    [sourceIn, setSourceIn] = useState(
      Number(selection?.sourceInSeconds ?? a.metadata.sourceInSeconds ?? 0),
    );
  async function change(path: string, body: unknown, message: string) {
    const p = await act(
      () => api<Project>(`/api/artifacts/${a.id}/${path}`, "POST", body),
      message,
    );
    if (p) update(p);
  }
  return (
    <article className="card artifact-card">
      <div className="artifact-preview">
        <MediaPreview
          fileId={a.fileId}
          mime={file?.mime || (a.kind === "voice" ? "audio/wav" : "video/mp4")}
          label={`${a.shotId || "成片"} ${routeLabels[a.kind] || a.kind}`}
          onZoom={onZoom}
        />
      </div>
      <div className="card-heading">
        <h3>
          {a.shotId || "完整影片"} ·{" "}
          {
            (
              {
                video: "故事底片",
                voice: "原声",
                lipsync: "医生口型",
                graphic: "图示",
                final: "成片",
              } as any
            )[a.kind]
          }
        </h3>
        <Badge status={a.accepted ? "pass" : "pending"}>
          {a.accepted ? "素材已通过" : "待内容验收"}
        </Badge>
      </div>
      <small className="quiet">
        {dateText(a.createdAt)}{" "}
        {selection && <Badge status="pass">当前入剪版本</Badge>}{" "}
        {stale && <Badge status="change">属于旧修订</Badge>}
      </small>
      <textarea
        rows={2}
        aria-label="素材验收意见"
        value={note}
        onChange={(e) => setNote(e.target.value)}
        placeholder={
          a.kind === "voice"
            ? "逐字听审：错字、重音、停顿与句尾…"
            : "验收：人物、动作、医学对应、声音与口型…"
        }
      />
      <div className="actions">
        <a className="button secondary small" href={fileUrl(a.fileId, true)}>
          下载 ↓
        </a>
        <button
          className="secondary small"
          disabled={busy}
          onClick={() =>
            void change("review", { accepted: false, note }, "已标记需要返修")
          }
        >
          需返修
        </button>
        <button
          className="primary small"
          disabled={busy}
          onClick={() =>
            void change(
              "review",
              { accepted: true, note },
              a.kind === "voice"
                ? "原声已确认，后续口型将使用同一音轨"
                : "素材已验收",
            )
          }
        >
          验收通过
        </button>
      </div>
      {a.kind !== "voice" && a.kind !== "final" && (
        <div className="use-artifact">
          <label>
            素材入点（秒）
            <input
              type="number"
              step="0.04"
              min={0}
              value={sourceIn}
              onChange={(e) => setSourceIn(Number(e.target.value))}
            />
          </label>
          <button
            className="secondary small"
            disabled={busy || !a.accepted || !!stale}
            onClick={() =>
              void change(
                "select",
                { sourceInSeconds: sourceIn },
                "已选择此版本入剪",
              )
            }
          >
            使用此版本
          </button>
        </div>
      )}
      <JsonDetails
        title="素材来源与实际参数"
        value={{
          sourceHash: a.sourceHash,
          audioHash: a.audioHash,
          ...a.metadata,
        }}
      />
    </article>
  );
}

function ImportArtifact({
  project,
  act,
  update,
  busy,
  onClose,
}: PanelProps & { onClose: () => void }) {
  const [shotId, setShotId] = useState(project.ontology.shots[0]?.id || ""),
    [fileId, setFileId] = useState(""),
    [kind, setKind] = useState("video"),
    [audioFileId, setAudioFileId] = useState("");
  return (
    <Modal title="导入已有镜头素材" onClose={onClose}>
      <form
        className="form-stack"
        onSubmit={async (e) => {
          e.preventDefault();
          const p = await act(
            () =>
              api<Project>(
                `/api/projects/${project.id}/artifacts/import`,
                "POST",
                {
                  shotId,
                  fileId,
                  kind,
                  ...(audioFileId ? { audioFileId } : {}),
                },
              ),
            "素材已登记，请先验收后选择入剪",
          );
          if (p) {
            update(p);
            onClose();
          }
        }}
      >
        <p className="quiet">
          先在需求阶段上传媒体，再将它与镜头关联。导入后保留文件哈希与当前镜头修订，仍需内容验收。
        </p>
        <label>
          对应镜头
          <select
            value={shotId}
            onChange={(e) => {
              setShotId(e.target.value);
              setAudioFileId("");
            }}
            required
          >
            <option value="">选择镜头</option>
            {project.ontology.shots.map((s) => (
              <option key={s.id} value={s.id}>
                {s.id} · {s.title}
              </option>
            ))}
          </select>
        </label>
        <label>
          素材类型
          <select
            value={kind}
            onChange={(e) => {
              setKind(e.target.value);
              setFileId("");
              setAudioFileId("");
            }}
          >
            <option value="video">故事视频</option>
            <option value="lipsync">医生口型视频</option>
            <option value="voice">原声音频</option>
            <option value="graphic">医学图示</option>
          </select>
        </label>
        <label>
          已上传文件
          <select
            value={fileId}
            onChange={(e) => setFileId(e.target.value)}
            required
          >
            <option value="">选择媒体文件</option>
            {project.files
              .filter((f) =>
                f.mime.startsWith(kind === "voice" ? "audio/" : "video/"),
              )
              .map((f) => (
                <option key={f.id} value={f.id}>
                  {f.name}
                </option>
              ))}
          </select>
        </label>
        {kind === "graphic" && (
          <p className="quiet">
            这里导入已渲染的图示视频。静态图片请在需求阶段上传，并绑定到对应的素材位。
          </p>
        )}
        {kind === "lipsync" && (
          <>
            <div className="notice">
              请先将该镜头的驱动声音作为「原声音频」导入并验收，再导入医生口型视频；只能绑定同一镜头、当前修订下已审核的原声音轨。
            </div>
            <label>
              同一口型对应的音轨
              <select
                value={audioFileId}
                onChange={(e) => setAudioFileId(e.target.value)}
                required
              >
                <option value="">选择已审核的同镜原声</option>
                {project.files
                  .filter(
                    (f) =>
                      f.mime.startsWith("audio/") &&
                      project.artifacts.some(
                        (a) =>
                          a.fileId === f.id &&
                          a.kind === "voice" &&
                          a.shotId === shotId &&
                          a.accepted &&
                          a.sourceHash === project.compiled.shotHashes[shotId],
                      ),
                  )
                  .map((f) => (
                    <option value={f.id} key={f.id}>
                      {f.name}
                    </option>
                  ))}
              </select>
            </label>
          </>
        )}
        <div className="actions">
          <button className="secondary" type="button" onClick={onClose}>
            取消
          </button>
          <button
            className="primary"
            disabled={
              busy || !fileId || !shotId || (kind === "lipsync" && !audioFileId)
            }
          >
            登记为待验收素材
          </button>
        </div>
      </form>
    </Modal>
  );
}
