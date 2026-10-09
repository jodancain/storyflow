import { useEffect, useState, type ReactNode } from "react";
import type { Compiled, Job, Project, Review, Artifact } from "../shared/types";
import { fileUrl } from "./api";
export const statusLabels: Record<string, string> = {
  queued: "排队中",
  running: "进行中",
  waiting_review: "等待审核",
  blocked: "等待条件",
  uncertain: "提交待核对",
  failed: "未完成",
  complete: "已完成",
  cancelled: "已取消",
  pending: "待审核",
  pass: "已通过",
  change: "需要修改",
};
export const stageText = (stage: string) =>
  (
    ({
      queued: "等待排程",
      submitting: "正在提交生成请求",
      polling: "等待供应商完成",
      downloading: "正在下载产物",
      rendering: "正在渲染与合成",
      review_dependency: "等待前置素材验收",
      dependency_blocked: "前置任务尚未完成",
      acceptance_unknown: "提交受理状态待核对",
      complete: "任务已完成",
      cancelled: "任务已取消",
    }) as Record<string, string>
  )[stage] || stage;
export const routeLabels: Record<string, string> = {
  seedance: "故事视频",
  doctor: "医生讲解",
  graphic: "医学图示",
  video: "故事视频",
  voice: "原声生成",
  lipsync: "医生口型",
  compose: "成片合成",
  expand: "展开故事",
  "post-plan": "后期方案",
};
export function Badge({
  status,
  children,
}: {
  status?: string;
  children?: ReactNode;
}) {
  return (
    <span className={`badge ${status || ""}`}>
      {children || statusLabels[status || ""] || status}
    </span>
  );
}
export function Empty({
  title,
  children,
  action,
}: {
  title: string;
  children: ReactNode;
  action?: ReactNode;
}) {
  return (
    <div className="empty">
      <span className="empty-glyph">◇</span>
      <h3>{title}</h3>
      <p>{children}</p>
      {action}
    </div>
  );
}
export function SectionHead({
  eyebrow,
  title,
  children,
  action,
}: {
  eyebrow?: string;
  title: string;
  children?: ReactNode;
  action?: ReactNode;
}) {
  return (
    <div className="section-head">
      <div>
        {eyebrow && <span className="eyebrow">{eyebrow}</span>}
        <h2>{title}</h2>
        {children && <p>{children}</p>}
      </div>
      {action && <div className="actions">{action}</div>}
    </div>
  );
}
export function Modal({
  title,
  onClose,
  children,
  wide = false,
}: {
  title: string;
  onClose: () => void;
  children: ReactNode;
  wide?: boolean;
}) {
  useEffect(() => {
    const listener = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    document.addEventListener("keydown", listener);
    const before = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.removeEventListener("keydown", listener);
      document.body.style.overflow = before;
    };
  }, [onClose]);
  return (
    <div
      className="modal-backdrop"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <section
        role="dialog"
        aria-modal="true"
        aria-label={title}
        className={`modal ${wide ? "wide" : ""}`}
      >
        <header>
          <h2>{title}</h2>
          <button className="icon-btn" onClick={onClose} aria-label="关闭">
            ×
          </button>
        </header>
        {children}
      </section>
    </div>
  );
}
export function JsonDetails({
  title,
  value,
}: {
  title: string;
  value: unknown;
}) {
  return (
    <details className="json-details">
      <summary>{title}</summary>
      <pre>{JSON.stringify(value, null, 2)}</pre>
    </details>
  );
}
export function Issues({ compiled }: { compiled: Compiled }) {
  const [open, setOpen] = useState(false);
  const errors = compiled.issues.filter((x) => x.severity === "error");
  const warnings = compiled.issues.filter((x) => x.severity === "warning");
  if (!errors.length && !warnings.length && !compiled.gaps.length)
    return (
      <div className="notice good">
        <b>结构校验通过</b>
        <span>接下来请确认故事、素材与医学内容，再提交制作。</span>
      </div>
    );
  return (
    <div className={`validation ${errors.length ? "has-errors" : ""}`}>
      <button
        className="validation-summary"
        onClick={() => setOpen(!open)}
        aria-expanded={open}
      >
        <span>
          <b>{errors.length ? `${errors.length} 项需要修正` : "结构可展开"}</b>{" "}
          · {compiled.gaps.length} 项素材缺口
          {warnings.length ? ` · ${warnings.length} 项提醒` : ""}
        </span>
        <span>{open ? "收起 −" : "查看 +"}</span>
      </button>
      {open && (
        <div className="validation-body">
          {compiled.issues.map((i, n) => (
            <div key={n} className="issue">
              <Badge status={i.severity === "error" ? "change" : "pending"}>
                {i.severity === "error" ? "错误" : "提醒"}
              </Badge>
              <p>
                {i.message}
                <small>{i.path}</small>
              </p>
            </div>
          ))}
          {compiled.gaps.map((g, n) => (
            <div className="issue" key={`gap${n}`}>
              <Badge status="pending">素材</Badge>
              <p>
                {compiled.reviewData.assets.find((a) => a.id === g.assetId)
                  ?.label || g.assetId}
                ：{g.reason}
                <small>
                  {g.assetId} · {g.shotIds.join("、")}
                </small>
              </p>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
export function currentReview(
  project: Project,
  id: string,
): Review | undefined {
  return project.reviews.find(
    (r) =>
      r.targetId === id && r.targetHash === project.compiled.targetHashes[id],
  );
}
export function MediaPreview({
  fileId,
  mime,
  label,
  onZoom,
}: {
  fileId?: string;
  mime?: string;
  label: string;
  onZoom?: (src: string, title: string) => void;
}) {
  if (!fileId)
    return (
      <div className="media-placeholder">
        <span>◇</span>
        <small>等待对应素材</small>
      </div>
    );
  const url = fileUrl(fileId);
  if (mime?.startsWith("image/"))
    return (
      <button
        className="image-preview"
        onClick={() => onZoom?.(url, label)}
        aria-label={`放大${label}`}
      >
        <img src={url} alt={label} loading="lazy" />
      </button>
    );
  if (mime?.startsWith("video/"))
    return <video src={url} controls preload="metadata" playsInline />;
  if (mime?.startsWith("audio/"))
    return (
      <div className="audio-preview">
        <span>♫</span>
        <audio src={url} controls preload="metadata" />
      </div>
    );
  return (
    <a className="file-preview" href={url} target="_blank" rel="noreferrer">
      ↗ 查看资料
    </a>
  );
}
export function isCurrentJob(job: Job, compiled: Compiled) {
  return job.shotId
    ? job.input?.generationHash === compiled.shotHashes[job.shotId]
    : job.kind === "compose"
      ? job.input?.postHash === compiled.postHash
      : true;
}
export function WorkflowGraph({
  compiled,
  jobs,
  onInspect,
  variant = "tasks",
  artifacts = [],
}: {
  artifacts?: Artifact[];
  variant?: "tasks" | "ontology";
  compiled: Compiled;
  jobs: Job[];
  onInspect: (id: string) => void;
}) {
  const nodes =
    variant === "tasks"
      ? compiled.tasks.map((t) => ({
          id: t.id,
          kind: t.kind,
          label: t.shotId
            ? `${t.shotId} · ${compiled.reviewData.shots.find((s) => s.id === t.shotId)?.title || routeLabels[t.kind]}`
            : "完整影片合成",
        }))
      : compiled.graph.nodes.filter((n) => !n.id.startsWith("task:"));
  const nodeIds = new Set(nodes.map((n) => n.id));
  const edges =
    variant === "tasks"
      ? compiled.tasks.flatMap((t) =>
          t.dependsOn.map((from) => ({ from, to: t.id })),
        )
      : compiled.graph.edges.filter(
          (e) => nodeIds.has(e.from) && nodeIds.has(e.to),
        );
  const depths = new Map<string, number>();
  const visiting = new Set<string>();
  function depth(id: string): number {
    if (depths.has(id)) return depths.get(id)!;
    if (visiting.has(id)) return 0;
    visiting.add(id);
    const parents = edges.filter(
      (e) => e.to === id && nodes.some((n) => n.id === e.from),
    );
    const level = parents.length
      ? Math.max(...parents.map((e) => depth(e.from))) + 1
      : 0;
    visiting.delete(id);
    depths.set(id, level);
    return level;
  }
  nodes.forEach((n) => depth(n.id));
  const levels = [...new Set(depths.values())].sort((a, b) => a - b);
  const positions = new Map<string, { x: number; y: number }>();
  const width = Math.max(
    280,
    ...levels.map(
      (l) => nodes.filter((n) => depths.get(n.id) === l).length * 218 + 48,
    ),
  );
  for (const level of levels) {
    const row = nodes.filter((n) => depths.get(n.id) === level);
    row.forEach((n, i) =>
      positions.set(n.id, {
        x: (width - row.length * 218) / 2 + i * 218 + 10,
        y: level * 150 + 26,
      }),
    );
  }
  const height = Math.max(180, levels.length * 150 + 30);
  const latest = (id: string) => {
    const task = compiled.tasks.find((t) => t.id === id);
    return [...jobs]
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .find(
        (j) =>
          ((j.kind === task?.kind && j.shotId === task?.shotId) ||
            j.id === id) &&
          isCurrentJob(j, compiled),
      );
  };
  if (!nodes.length)
    return (
      <Empty title="从故事开始绘制流程">
        完善分镜并编译后，这里会呈现实际的制作依赖。
      </Empty>
    );
  return (
    <div
      className="graph-scroll"
      tabIndex={0}
      aria-label="制作依赖框图，可横向滚动"
    >
      <div className="graph-board" style={{ width, height }}>
        <svg
          className="graph-lines"
          width={width}
          height={height}
          aria-hidden="true"
        >
          <defs>
            <marker
              id="flow-arrow"
              viewBox="0 0 10 10"
              refX="8"
              refY="5"
              markerWidth="6"
              markerHeight="6"
              orient="auto"
            >
              <path d="M 0 0 L 10 5 L 0 10 z" fill="#789587" />
            </marker>
          </defs>
          {edges.map((e, i) => {
            const a = positions.get(e.from),
              b = positions.get(e.to);
            if (!a || !b) return null;
            const x = a.x + 96,
              y = a.y + 88,
              bx = b.x + 96,
              by = b.y;
            return (
              <path
                key={i}
                d={`M${x},${y} V${y + 26} H${bx} V${by - 5}`}
                fill="none"
                stroke="#789587"
                strokeWidth="1.5"
                markerEnd="url(#flow-arrow)"
              />
            );
          })}
        </svg>
        {nodes.map((n) => {
          const p = positions.get(n.id)!;
          const job = latest(n.id);
          const plan = compiled.tasks.find((t) => t.id === n.id);
          const artifact = artifacts.find(
            (a) =>
              a.kind === plan?.kind &&
              a.shotId === plan?.shotId &&
              a.sourceHash === compiled.shotHashes[a.shotId || ""],
          );
          return (
            <button
              key={n.id}
              className={`graph-node ${job?.state || (artifact ? (artifact.accepted ? "complete" : "waiting_review") : "draft")}`}
              style={{ left: p.x, top: p.y }}
              onClick={() => onInspect(n.id)}
            >
              <small>
                {routeLabels[n.kind] ||
                  (
                    {
                      character: "角色",
                      scene: "场景",
                      prop: "道具",
                      action: "动作",
                      "medical-fact": "医学事实",
                      evidence: "证据",
                      anchor: "锚图",
                      "asset:image": "图片素材",
                      "asset:video": "视频素材",
                      "asset:audio": "音频素材",
                      "asset:document": "文档素材",
                      "asset:graphic": "图示素材",
                      "shot:seedance": "故事分镜",
                      "shot:doctor": "医生分镜",
                      "shot:graphic": "图示分镜",
                      "relation:together": "空间关系",
                      "relation:sequence": "时序关系",
                      "relation:footnote": "依据关系",
                    } as Record<string, string>
                  )[n.kind] ||
                  n.kind}
              </small>
              <strong>{n.label}</strong>
              <span>
                {variant === "ontology"
                  ? "查看对象与关联"
                  : job
                    ? statusLabels[job.state]
                    : artifact
                      ? artifact.accepted
                        ? "导入素材已验收"
                        : "导入素材待验收"
                      : "尚未提交"}{" "}
                <i>↗</i>
              </span>
            </button>
          );
        })}
      </div>
    </div>
  );
}
