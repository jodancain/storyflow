import { createHash } from "node:crypto";
import { resolveImageConsistency, validateImageConsistency } from "./image-consistency.js";
import type {
  Anchor,
  Asset,
  Caption,
  Compiled,
  Entity,
  Evidence,
  Issue,
  Ontology,
  Requirements,
  Shot,
  TaskPlan,
} from "./types.js";

const record = (value: unknown): value is Record<string, any> =>
  Boolean(value) && typeof value === "object" && !Array.isArray(value);
const list = <T = any>(value: unknown): T[] =>
  Array.isArray(value) ? value : [];
const unique = <T>(values: T[]): T[] => [...new Set(values)];
const ordered = <T extends { id: string }>(values: T[]): T[] =>
  [...values].sort((a, b) => a.id.localeCompare(b.id, "en"));
const idPattern = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/;

/** Canonical JSON: object key order is irrelevant; array order remains meaningful. */
export function hash(value: unknown): string {
  const seen = new Set<object>();
  const canonical = (v: any): any => {
    if (v === undefined) return null;
    if (v === null || typeof v === "string" || typeof v === "boolean") return v;
    if (typeof v === "number")
      return Number.isFinite(v) ? v : { $invalidNumber: String(v) };
    if (typeof v !== "object") return { $invalidType: typeof v };
    if (seen.has(v)) return { $invalidCycle: true };
    seen.add(v);
    const result = Array.isArray(v)
      ? v.map(canonical)
      : Object.fromEntries(
          Object.keys(v)
            .filter((k) => v[k] !== undefined)
            .sort()
            .map((k) => [k, canonical(v[k])]),
        );
    seen.delete(v);
    return result;
  };
  return createHash("sha256")
    .update(JSON.stringify(canonical(value)), "utf8")
    .digest("hex");
}

/** Validate without repairing or deleting user content. Invalid drafts remain editable. */
export function validateOntology(value: unknown): Issue[] {
  const issues: Issue[] = [];
  const issue = (
    path: string,
    code: string,
    message: string,
    severity: Issue["severity"] = "error",
  ) => issues.push({ path, code, message, severity });
  const string = (
    v: unknown,
    path: string,
    max = 16000,
    allowEmpty = false,
  ) => {
    if (typeof v !== "string" || (!allowEmpty && !v.trim()) || v.length > max)
      issue(
        path,
        "invalid_text",
        `需要${allowEmpty ? "" : "非空"}文本，最多 ${max} 字符。`,
      );
  };
  const integer = (v: unknown, path: string, min: number, max: number) => {
    if (!Number.isInteger(v) || Number(v) < min || Number(v) > max)
      issue(path, "invalid_integer", `需要 ${min}–${max} 范围内的整数。`);
  };
  const strings = (v: unknown, path: string) => {
    if (!Array.isArray(v))
      return issue(path, "invalid_array", "需要文本数组。");
    v.forEach((x, i) => string(x, `${path}[${i}]`));
  };
  const enumeration = (v: unknown, values: string[], path: string) => {
    if (!values.includes(String(v)))
      issue(path, "invalid_enum", `允许值：${values.join(" / ")}。`);
  };
  if (!record(value))
    return [
      {
        path: "$",
        code: "invalid_ontology",
        message: "本体必须是 JSON 对象。",
        severity: "error",
      },
    ];
  const o = value;
  if (o.schemaVersion !== 1)
    issue(
      "schemaVersion",
      "unsupported_schema",
      "当前只支持 schemaVersion 1。",
    );
  string(o.title, "title", 500);
  if (!record(o.spec))
    issue("spec", "invalid_spec", "需要帧率、尺寸与总帧数。");
  const spec = record(o.spec) ? o.spec : {};
  if (![24, 25].includes(spec.fps))
    issue("spec.fps", "unsupported_fps", "帧率只能为 24 或 25。");
  for (const dimension of ["width", "height"]) {
    integer(spec[dimension], `spec.${dimension}`, 16, 8192);
    if (Number.isInteger(spec[dimension]) && spec[dimension] % 2)
      issue(`spec.${dimension}`, "odd_dimension", "H.264 输出尺寸必须是偶数。");
  }
  integer(spec.totalFrames, "spec.totalFrames", 1, 25 * 60 * 60);
  const total =
    Number.isInteger(spec.totalFrames) && spec.totalFrames > 0
      ? spec.totalFrames
      : 25 * 60 * 60;
  const collections = [
    "entities",
    "relations",
    "assets",
    "anchors",
    "evidence",
    "shots",
  ] as const;
  const maps: Record<string, Map<string, any>> = {};
  const ids = new Map<string, string>();
  for (const key of collections) {
    maps[key] = new Map();
    if (!Array.isArray(o[key])) issue(key, "invalid_array", "需要数组。");
    if (list(o[key]).length > 5000)
      issue(key, "collection_limit", "单类对象不能超过 5000 项。");
    list(o[key]).forEach((item, index) => {
      const path = `${key}[${index}]`;
      if (!record(item))
        return issue(path, "invalid_object", "条目必须是对象。");
      if (
        typeof item.id !== "string" ||
        !idPattern.test(item.id) ||
        item.id === "post"
      )
        issue(
          `${path}.id`,
          "invalid_id",
          "ID 必须为 1–128 位字母、数字、点、下划线、冒号或连字符，且不能为保留字 post。",
        );
      else if (ids.has(item.id))
        issue(
          `${path}.id`,
          "duplicate_id",
          `ID ${item.id} 与 ${ids.get(item.id)} 重复。`,
        );
      else ids.set(item.id, `${path}.id`);
      if (typeof item.id === "string" && !maps[key].has(item.id))
        maps[key].set(item.id, item);
    });
  }
  const ref = (v: unknown, collection: string, path: string) => {
    if (typeof v !== "string" || !maps[collection].has(v))
      issue(
        path,
        "unknown_reference",
        `引用的${collection}对象不存在：${String(v)}。`,
      );
  };
  const refs = (v: unknown, collection: string, path: string) => {
    if (!Array.isArray(v))
      return issue(path, "invalid_array", "需要 ID 数组。");
    const seen = new Set();
    v.forEach((id, i) => {
      ref(id, collection, `${path}[${i}]`);
      if (seen.has(id))
        issue(`${path}[${i}]`, "duplicate_reference", `重复引用 ${id}。`);
      seen.add(id);
    });
  };
  const interval = (entry: any, path: string, lo = 0, hi = total) => {
    integer(entry.startFrame, `${path}.startFrame`, lo, hi);
    integer(entry.endFrame, `${path}.endFrame`, lo, hi);
    if (
      Number.isInteger(entry.startFrame) &&
      Number.isInteger(entry.endFrame) &&
      entry.startFrame >= entry.endFrame
    )
      issue(
        path,
        "empty_interval",
        "帧区间必须 startFrame < endFrame（右端不包含）。",
      );
  };
  const validItems = (key: string): Record<string, any>[] =>
    list(o[key]).filter(record);
  validItems("entities").forEach((e, i) => {
    const p = `entities[${i}]`;
    enumeration(
      e.type,
      ["character", "scene", "prop", "action", "medical-fact"],
      `${p}.type`,
    );
    string(e.label, `${p}.label`, 500);
    if (!record(e.attributes))
      issue(
        `${p}.attributes`,
        "invalid_attributes",
        "属性必须是标量字段对象。",
      );
    else
      Object.entries(e.attributes).forEach(([key, v]) => {
        if (
          !["string", "number", "boolean"].includes(typeof v) ||
          (typeof v === "number" && !Number.isFinite(v))
        )
          issue(
            `${p}.attributes.${key}`,
            "invalid_attribute",
            "属性只接受文本、有限数值或布尔值，不执行代码或嵌套脚本。",
          );
      });
    refs(e.evidenceIds, "evidence", `${p}.evidenceIds`);
    if (e.type === "medical-fact" && !list(e.evidenceIds).length)
      issue(
        `${p}.evidenceIds`,
        "fact_without_evidence",
        "医学事实必须挂接可核对的依据。",
      );
    if (e.fictional !== undefined && typeof e.fictional !== "boolean")
      issue(`${p}.fictional`, "invalid_boolean", "fictional 必须是布尔值。");
  });
  validItems("evidence").forEach((e, i) => {
    const p = `evidence[${i}]`;
    string(e.title, `${p}.title`, 500);
    string(e.excerpt, `${p}.excerpt`);
    if (e.locator !== undefined) string(e.locator, `${p}.locator`, 2000);
    if (
      e.url !== undefined &&
      (typeof e.url !== "string" || !/^https?:\/\//i.test(e.url))
    )
      issue(
        `${p}.url`,
        "invalid_url",
        "证据地址只能使用 HTTP(S)，本地资料请使用定位说明。",
      );
  });
  const imageAttempt = (value:any,path:string) => {
    if(value === undefined) return;
    if(!record(value)) {issue(path,"invalid_image_history","图片历史必须是对象");return;}
    if(value.origin !== "external-history" || !["failed","blocked"].includes(value.state) || typeof value.submitted !== "boolean" || (value.state === "blocked" && value.submitted))
      issue(path,"invalid_image_history","图片历史状态或来源无效");
    string(value.code,`${path}.code`,100);string(value.reason,`${path}.reason`,1000);
    for(const key of ["modelRequested","modelActual","blockingParent"]) if(value[key] !== undefined && value[key] !== null) string(value[key],`${path}.${key}`,200);
    if(value.sourceStoryHash !== undefined && !/^[a-f0-9]{64}$/.test(value.sourceStoryHash)) issue(`${path}.sourceStoryHash`,"invalid_image_history","需要来源哈希");
    if(value.imagePostNumber !== undefined && (!Number.isInteger(value.imagePostNumber) || value.imagePostNumber<1 || value.imagePostNumber>52)) issue(`${path}.imagePostNumber`,"invalid_image_history","提交序号无效");
  };
  const imageBinding = (value: any, path: string) => {
    if (value === undefined) return;
    if (!record(value)) { issue(path, "invalid_image_binding", "图片绑定须为对象"); return; }
    for (const k of ["artifactId", "fileId"])
      if (typeof value[k] !== "string" || !idPattern.test(value[k]))
        issue(`${path}.${k}`, "invalid_image_binding", "图片须引用本工程的候选及文件 ID");
    if (typeof value.sha256 !== "string" || !/^[a-f0-9]{64}$/.test(value.sha256))
      issue(`${path}.sha256`, "invalid_image_binding", "图片须保存内容 SHA-256");
  };
  validItems("assets").forEach((a, i) => {
    const p = `assets[${i}]`;
    string(a.label, `${p}.label`, 500);
    enumeration(
      a.kind,
      ["image", "video", "audio", "document", "graphic"],
      `${p}.kind`,
    );
    enumeration(a.purpose, ["reference", "production"], `${p}.purpose`);
    if (typeof a.gap !== "boolean")
      issue(`${p}.gap`, "invalid_boolean", "gap 必须明确为布尔值。");
    if (
      a.fileId !== undefined &&
      (typeof a.fileId !== "string" || !idPattern.test(a.fileId))
    )
      issue(
        `${p}.fileId`,
        "invalid_file_id",
        "文件应引用导入后注册的 ID，不能是本机路径。",
      );
    if (
      a.sha256 !== undefined &&
      (typeof a.sha256 !== "string" || !/^[a-f0-9]{64}$/i.test(a.sha256))
    )
      issue(`${p}.sha256`, "invalid_sha256", "需要 64 位 SHA-256。");
    if (a.fileId && !a.sha256)
      issue(`${p}.sha256`, "missing_content_hash", "绑定文件必须有内容哈希。");
    if (!a.gap && (!a.fileId || !a.sha256))
      issue(
        p,
        "asset_unbound",
        "参考条目已登记，但文件尚未在本项目绑定。",
        "warning",
      );
    imageAttempt(a.imageAttempt, `${p}.imageAttempt`);
    imageBinding(a.previewImage, `${p}.previewImage`);
    if (a.mustShow !== undefined) strings(a.mustShow, `${p}.mustShow`);
    if (a.rejectIf !== undefined) strings(a.rejectIf, `${p}.rejectIf`);
    if (a.source !== undefined) {
      if (!record(a.source))
        issue(`${p}.source`, "invalid_source", "来源必须是对象。");
      else {
        for (const key of ["author", "license", "use"])
          if (a.source[key] !== undefined)
            string(a.source[key], `${p}.source.${key}`, 16000, true);
        if (
          a.source.url !== undefined &&
          (typeof a.source.url !== "string" ||
            !/^https?:\/\//i.test(a.source.url))
        )
          issue(
            `${p}.source.url`,
            "invalid_url",
            "素材来源使用 HTTP(S)原页，不得存放本机路径。",
          );
      }
    }
  });
  validItems("anchors").forEach((a, i) => {
    const p = `anchors[${i}]`;
    ref(a.entityId, "entities", `${p}.entityId`);
    ref(a.assetId, "assets", `${p}.assetId`);
    string(a.state, `${p}.state`);
    enumeration(a.role, ["identity", "start", "end"], `${p}.role`);
    const asset = maps.assets.get(a.assetId);
    if (asset && asset.kind !== "image")
      issue(
        `${p}.assetId`,
        "anchor_not_image",
        "身份与帧锚图必须引用图片素材。",
      );
  });
  validItems("relations").forEach((r, i) => {
    const p = `relations[${i}]`;
    enumeration(
      r.type,
      [
        "part_of",
        "located_in",
        "holds",
        "depicts",
        "supported_by",
        "depends_on",
      ],
      `${p}.type`,
    );
    for (const side of ["from", "to"])
      if (!ids.has(r[side]) || maps.relations.has(r[side]))
        issue(
          `${p}.${side}`,
          "unknown_reference",
          "关系端点必须是存在的实体、素材、锚图、证据或镜头。",
        );
    if (r.from === r.to)
      issue(p, "self_relation", "关系两端不能是同一个对象。");
    if (r.type === "supported_by") ref(r.to, "evidence", `${p}.to`);
    if (r.type === "depends_on") {
      ref(r.from, "shots", `${p}.from`);
      ref(r.to, "shots", `${p}.to`);
    }
    if (r.projection !== undefined)
      enumeration(
        r.projection,
        ["together", "sequence", "footnote"],
        `${p}.projection`,
      );
  });
  const lineIds = new Set<string>();
  validItems("shots").forEach((s, i) => {
    const p = `shots[${i}]`;
    imageAttempt(s.imageAttempt, `${p}.imageAttempt`);
    imageBinding(s.reviewImage, `${p}.reviewImage`);
    imageBinding(s.firstFrameImage, `${p}.firstFrameImage`);
    string(s.title, `${p}.title`, 500);
    interval(s, p);
    for (const field of ["action", "startState", "endState", "scale", "camera"])
      string(s[field], `${p}.${field}`);
    string(s.prompt, `${p}.prompt`, 40000, true);
    refs(s.entityIds, "entities", `${p}.entityIds`);
    refs(s.requiredAssetIds, "assets", `${p}.requiredAssetIds`);
    refs(s.evidenceIds, "evidence", `${p}.evidenceIds`);
    refs(s.dependencies, "shots", `${p}.dependencies`);
    strings(s.mustShow, `${p}.mustShow`);
    strings(s.rejectIf, `${p}.rejectIf`);
    enumeration(s.route, ["seedance", "doctor", "graphic"], `${p}.route`);
    for (const field of ["firstAnchorId", "endAnchorId"])
      if (s[field] !== undefined) ref(s[field], "anchors", `${p}.${field}`);
    if (s.firstAnchorId && s.endAnchorId) {
      const a = maps.anchors.get(s.firstAnchorId),
        b = maps.anchors.get(s.endAnchorId);
      if (a && b && a.entityId !== b.entityId)
        issue(
          p,
          "anchor_identity_mismatch",
          "起止锚图必须指向同一主体，避免不同身份间补间。",
        );
    }
    if (!Array.isArray(s.dialogue))
      issue(`${p}.dialogue`, "invalid_array", "需要对白数组。");
    list(s.dialogue).forEach((d, j) => {
      const dp = `${p}.dialogue[${j}]`;
      if (!record(d)) return issue(dp, "invalid_dialogue", "对白必须是对象。");
      if (
        typeof d.id !== "string" ||
        !idPattern.test(d.id) ||
        lineIds.has(d.id)
      )
        issue(
          `${dp}.id`,
          "invalid_line_id",
          "对白和字幕 ID 必须有效且全片唯一。",
        );
      else lineIds.add(d.id);
      ref(d.speakerId, "entities", `${dp}.speakerId`);
      string(d.text, `${dp}.text`, 4000);
      if (
        maps.entities.has(d.speakerId) &&
        maps.entities.get(d.speakerId).type !== "character"
      )
        issue(`${dp}.speakerId`, "speaker_not_character", "发言者必须是角色。");
      if (d.startFrame !== undefined || d.endFrame !== undefined)
        interval(d, dp, s.startFrame, s.endFrame);
    });
    if (s.route === "doctor" && !list(s.dialogue).length)
      issue(
        `${p}.dialogue`,
        "doctor_without_dialogue",
        "音频驱动镜头必须有明确台词。",
      );
    if (s.route === "doctor" && !s.firstAnchorId)
      issue(
        `${p}.firstAnchorId`,
        "doctor_reference_missing",
        "医生口型路线需要绑定已审核医生参考图的身份锚点。",
        "warning",
      );
    if (!Array.isArray(s.subtitles))
      issue(`${p}.subtitles`, "invalid_array", "需要字幕数组。");
    list(s.subtitles).forEach((c, j) => {
      const cp = `${p}.subtitles[${j}]`;
      if (!record(c)) return issue(cp, "invalid_caption", "字幕必须是对象。");
      if (
        typeof c.id !== "string" ||
        !idPattern.test(c.id) ||
        lineIds.has(c.id)
      )
        issue(
          `${cp}.id`,
          "invalid_line_id",
          "对白和字幕 ID 必须有效且全片唯一。",
        );
      else lineIds.add(c.id);
      string(c.text, `${cp}.text`, 4000);
      interval(c, cp, s.startFrame, s.endFrame);
    });
    const captions = list<any>(s.subtitles)
      .filter(record)
      .sort((a, b) => a.startFrame - b.startFrame);
    captions.slice(1).forEach((c, j) => {
      if (c.startFrame < captions[j].endFrame)
        issue(
          `${p}.subtitles`,
          "caption_overlap",
          `字幕 ${captions[j].id} 与 ${c.id} 重叠，请合并为同一字幕或调整时间。`,
        );
    });
  });
  const shots = validItems("shots")
    .filter(
      (s) => Number.isInteger(s.startFrame) && Number.isInteger(s.endFrame),
    )
    .sort((a, b) => a.startFrame - b.startFrame);
  if (!shots.length)
    issue(
      "shots",
      "empty_story",
      "当前尚无分镜，可先填写需求或展开故事。",
      "warning",
    );
  else {
    let covered = 0;
    for (const shot of shots) {
      if (shot.startFrame < covered)
        issue(
          `shots.${shot.id}`,
          "shot_overlap",
          "镜头与前面的镜头发生帧区间重叠。",
        );
      else if (shot.startFrame > covered)
        issue(
          `shots.${shot.id}`,
          "timeline_gap",
          `时间线缺少 ${covered}–${shot.startFrame} 帧。`,
        );
      covered = Math.max(covered, shot.endFrame);
    }
    if (covered < total)
      issue("shots", "timeline_gap", `时间线末尾缺少 ${covered}–${total} 帧。`);
  }
  const depMap = new Map<string, string[]>();
  for (const [id, s] of maps.shots)
    depMap.set(
      id,
      unique([
        ...list<string>(s.dependencies),
        ...validItems("relations")
          .filter((r) => r.type === "depends_on" && r.from === id)
          .map((r) => r.to),
      ]),
    );
  const colour = new Map<string, number>();
  const visit = (id: string, stack: string[]) => {
    if (colour.get(id) === 1) {
      issue(
        `shots.${id}.dependencies`,
        "dependency_cycle",
        `生成依赖成环：${[...stack, id].join(" → ")}。`,
      );
      return;
    }
    if (colour.get(id) === 2) return;
    colour.set(id, 1);
    for (const dep of depMap.get(id) || [])
      if (maps.shots.has(dep)) {
        const here = maps.shots.get(id),
          before = maps.shots.get(dep);
        if (
          Number.isInteger(before.endFrame) &&
          Number.isInteger(here.startFrame) &&
          before.endFrame > here.startFrame
        )
          issue(
            `shots.${id}.dependencies`,
            "dependency_not_before_shot",
            `依赖镜头 ${dep} 必须在当前镜头之前结束。`,
          );
        visit(dep, [...stack, id]);
      }
    colour.set(id, 2);
  };
  for (const id of depMap.keys()) visit(id, []);
  if (o.postProgram !== undefined) {
    const p = o.postProgram;
    if (!record(p) || p.version !== 1 || !Array.isArray(p.elements))
      issue(
        "postProgram",
        "invalid_post_program",
        "后期只接受 version 1 的声明式图形数组，不接受脚本。",
      );
    else {
      if (p.elements.length > 500)
        issue("postProgram.elements", "graphic_limit", "最多 500 个图形元素。");
      p.elements.forEach((el: any, i: number) => {
        const path = `postProgram.elements[${i}]`;
        if (!record(el))
          return issue(path, "invalid_graphic", "图形必须是声明式对象。");
        for (const key of Object.keys(el))
          if (
            ![
              "type",
              "text",
              "x",
              "y",
              "w",
              "h",
              "color",
              "size",
              "startFrame",
              "endFrame",
              "fadeFrames",
            ].includes(key)
          )
            issue(
              `${path}.${key}`,
              "unknown_graphic_field",
              "不支持此图形字段。",
            );
        enumeration(
          el.type,
          ["text", "rect", "circle", "arrow"],
          `${path}.type`,
        );
        interval(el, path);
        for (const [key, max] of [
          ["x", spec.width],
          ["y", spec.height],
        ] as const)
          if (!Number.isFinite(el[key]) || el[key] < 0 || el[key] > max)
            issue(`${path}.${key}`, "graphic_bounds", "图形坐标必须在画幅内。");
        for (const [key, max] of [
          ["w", spec.width],
          ["h", spec.height],
          ["size", spec.height],
        ] as const)
          if (
            el[key] !== undefined &&
            (!Number.isFinite(el[key]) || el[key] <= 0 || el[key] > max)
          )
            issue(
              `${path}.${key}`,
              "graphic_bounds",
              "图形尺寸必须是画幅范围内的正数。",
            );
        if (el.type === "text") string(el.text, `${path}.text`, 1000);
        if (
          typeof el.color !== "string" ||
          !/^#(?:[0-9a-f]{3}|[0-9a-f]{6}|[0-9a-f]{8})$/i.test(el.color)
        )
          issue(
            `${path}.color`,
            "invalid_colour",
            "颜色使用十六进制 #RGB / #RRGGBB / #RRGGBBAA。",
          );
        if (el.fadeFrames !== undefined)
          integer(
            el.fadeFrames,
            `${path}.fadeFrames`,
            0,
            Math.max(0, el.endFrame - el.startFrame),
          );
      });
    }
  }
  issues.push(...validateImageConsistency(value));
  return issues;
}

/** A usable editable starting point; this does not fabricate any scene or asset. */
export function createEmptyOntology(
  title: string,
  requirements: Requirements,
): Ontology {
  const fps = requirements?.fps === 24 ? 24 : 25;
  const seconds =
    Number.isFinite(requirements?.duration) && requirements.duration > 0
      ? Math.min(requirements.duration, 3600)
      : 60;
  const portrait = requirements?.aspect !== "16:9";
  return {
    schemaVersion: 1,
    title: String(title || requirements?.topic || "未命名项目").slice(0, 500),
    spec: {
      fps,
      width: portrait ? 1080 : 1920,
      height: portrait ? 1920 : 1080,
      totalFrames: Math.round(seconds * fps),
    },
    entities: [],
    relations: [],
    assets: [],
    anchors: [],
    evidence: [],
    shots: [],
  };
}

/** Compile editable data into review, dependency and provider-neutral execution artifacts. */
export function compileOntology(ontology: Ontology): Compiled {
  const issues = validateOntology(ontology);
  const raw: any = record(ontology) ? ontology : {};
  const usable = (v: any) => record(v) && typeof v.id === "string";
  const entities = list<Entity>(raw.entities).filter(usable),
    assets = list<Asset>(raw.assets).filter(usable),
    evidence = list<Evidence>(raw.evidence).filter(usable),
    anchors = list<Anchor>(raw.anchors).filter(usable),
    relations = list<any>(raw.relations).filter(usable),
    shots = list<Shot>(raw.shots).filter(usable);
  const by = <T extends { id: string }>(items: T[]) =>
    new Map(
      items.filter((x) => typeof x.id === "string").map((x) => [x.id, x]),
    );
  const entityBy = by(entities),
    assetBy = by(assets),
    evidenceBy = by(evidence),
    anchorBy = by(anchors),
    shotBy = by(shots);
  const spec = record(raw.spec) ? raw.spec : {};
  const dependencies = (s: Shot) =>
    unique([
      ...list<string>(s.dependencies),
      ...relations
        .filter((r) => r.type === "depends_on" && r.from === s.id)
        .map((r) => r.to),
    ])
      .filter((x) => typeof x === "string")
      .sort();
  const finalTask = (s: Shot) =>
    `${s.route === "doctor" ? "lipsync" : s.route === "graphic" ? "graphic" : "video"}:${s.id}`;
  const contexts = new Map<
    string,
    {
      entities: Entity[];
      assets: Asset[];
      evidence: Evidence[];
      anchors: Anchor[];
      relations: any[];
    }
  >();
  const prompts: Record<string, string> = {};
  for (const s of shots) {
    if (typeof s.id !== "string") continue;
    const entityIds = new Set([
      ...list<string>(s.entityIds),
      ...list<any>(s.dialogue)
        .filter(record)
        .map((d) => d.speakerId),
    ]);
    const shotAnchors = anchors.filter(
      (a) =>
        a.id === s.firstAnchorId ||
        a.id === s.endAnchorId ||
        (a.role === "identity" && entityIds.has(a.entityId)),
    );
    for (const a of shotAnchors) entityIds.add(a.entityId);
    const assetIds = new Set([
      ...list<string>(s.requiredAssetIds),
      ...shotAnchors.map((a) => a.assetId),
      ...resolveImageConsistency(ontology, s.id).requiredIdentityAssetIds,
    ]);
    const selectedEntities = ordered(
      [...entityIds]
        .map((id) => entityBy.get(id))
        .filter((x): x is Entity => Boolean(x)),
    );
    const evidenceIds = new Set([
      ...list<string>(s.evidenceIds),
      ...selectedEntities.flatMap((e) => list<string>(e.evidenceIds)),
    ]);
    const known = new Set([...entityIds, ...assetIds, ...evidenceIds, s.id]);
    const relevantRelations = relations.filter(
      (r) => r.type !== "depends_on" && (known.has(r.from) || known.has(r.to)),
    );
    for (const r of relevantRelations)
      if (r.type === "supported_by") evidenceIds.add(r.to);
    const context = {
      entities: selectedEntities,
      assets: ordered(
        [...assetIds]
          .map((id) => assetBy.get(id))
          .filter((x): x is Asset => Boolean(x)),
      ),
      evidence: ordered(
        [...evidenceIds]
          .map((id) => evidenceBy.get(id))
          .filter((x): x is Evidence => Boolean(x)),
      ),
      anchors: ordered(shotAnchors),
      relations: ordered(relevantRelations),
    };
    contexts.set(s.id, context);
    // Asset constraints describe the asset's own deliverable (for example an
    // empty set plate), not every shot using it. Whole-shot requirements belong
    // to Shot; identity, state and medical meaning remain in entities/evidence.
    const constraintMust = unique(list<string>(s.mustShow));
    const constraintReject = unique(list<string>(s.rejectIf));
    prompts[s.id] = [
      s.prompt || "",
      resolveImageConsistency(ontology, s.id).promptGuard,
      `画幅 ${spec.width}×${spec.height}，目标镜头 ${s.endFrame - s.startFrame} 帧 / ${spec.fps}fps。`,
      `景别：${s.scale || ""}；机位：${s.camera || ""}。`,
      `开始：${s.startState || ""}\n动作：${s.action || ""}\n结束：${s.endState || ""}`,
      context.entities.length
        ? `本镜对象（固定身份与状态）：\n${context.entities
            .map(
              (e) =>
                `${e.id} ${e.label}；${Object.entries(
                  record(e.attributes) ? e.attributes : {},
                )
                  .map(([k, v]) => `${k}=${v}`)
                  .join("；")}`,
            )
            .join("\n")}`
        : "",
      list<any>(s.dialogue).filter(record).length
        ? `准确原声对白，不额外添加台词：\n${list<any>(s.dialogue)
            .filter(record)
            .map(
              (d) =>
                `${entityBy.get(d.speakerId)?.label || d.speakerId}：「${d.text}」`,
            )
            .join("\n")}`
        : "没有对白，不添加旁白；可保留匹配动作的环境声。",
      constraintMust.length ? `必须可见：${constraintMust.join("；")}` : "",
      constraintReject.length ? `拒收条件：${constraintReject.join("；")}` : "",
      context.evidence.length
        ? `事实边界（仅创作依据，不声称输出已经验证）：\n${context.evidence.map((e) => `${e.id}：${e.excerpt}`).join("\n")}`
        : "",
      "不要把字幕、界面或水印生成到原视频；后期字幕由独立时间线渲染。参考条件以实际任务回执为准。",
    ]
      .filter(Boolean)
      .join("\n\n");
  }
  const shotHashes: Record<string, string> = {},
    visiting = new Set<string>();
  const shotGenerationHash = (id: string): string => {
    if (shotHashes[id]) return shotHashes[id];
    const s = shotBy.get(id);
    if (!s) return hash({ missingShot: id });
    if (visiting.has(id)) return hash({ invalidCycle: id });
    visiting.add(id);
    const c = contexts.get(id)!;
    const result = hash({
      schema: "storyflow-generation-v1",
      spec: { fps: spec.fps, width: spec.width, height: spec.height },
      shot: {
        id,
        durationFrames: s.endFrame - s.startFrame,
        route: s.route,
        action: s.action,
        startState: s.startState,
        endState: s.endState,
        scale: s.scale,
        camera: s.camera,
        entityIds: s.entityIds,
        requiredAssetIds: s.requiredAssetIds,
        evidenceIds: s.evidenceIds,
        firstFrameHash: s.firstFrameImage?.sha256,
        firstAnchorId: s.firstAnchorId,
        endAnchorId: s.endAnchorId,
        mustShow: s.mustShow,
        rejectIf: s.rejectIf,
        dialogue: list<any>(s.dialogue)
          .filter(record)
          .map((d) => ({
            ...d,
            startFrame:
              d.startFrame === undefined
                ? undefined
                : d.startFrame - s.startFrame,
            endFrame:
              d.endFrame === undefined ? undefined : d.endFrame - s.startFrame,
          })),
      },
      prompt: prompts[id],
      entities: c.entities,
      evidence: c.evidence,
      anchors: c.anchors,
      relations: c.relations,
      assets: c.assets.map((a) => ({
        id: a.id,
        kind: a.kind,
        purpose: a.purpose,
        sha256: a.sha256,
        gap: a.gap,
        mustShow: a.mustShow,
        rejectIf: a.rejectIf,
      })),
      dependencyHashes: dependencies(s).map((dep) => ({
        shotId: dep,
        hash: shotGenerationHash(dep),
      })),
    });
    visiting.delete(id);
    shotHashes[id] = result;
    return result;
  };
  for (const s of ordered(shots.filter((s) => typeof s.id === "string")))
    shotGenerationHash(s.id);
  const subtitles: Caption[] = shots
    .flatMap((s) => list<Caption>(s.subtitles).filter(record))
    .sort(
      (a, b) =>
        a.startFrame - b.startFrame || String(a.id).localeCompare(String(b.id)),
    );
  const postHash = hash({
    schema: "storyflow-post-v1",
    spec,
    postProgram: raw.postProgram || null,
    timeline: [...shots]
      .sort((a, b) => a.startFrame - b.startFrame)
      .map((s) => ({
        id: s.id,
        startFrame: s.startFrame,
        endFrame: s.endFrame,
        sourceHash: shotHashes[s.id],
      })),
    subtitles,
  });
  const targetHashes: Record<string, string> = { post: postHash };
  for (const e of entities)
    if (typeof e.id === "string")
      targetHashes[e.id] = hash({
        entity: e,
        evidence: list<string>(e.evidenceIds).map(
          (id) => evidenceBy.get(id) || { missing: id },
        ),
      });
  for (const a of assets)
    if (typeof a.id === "string") targetHashes[a.id] = hash({ ...a, imageAttempt:undefined, previewImage: a.previewImage ? {sha256:a.previewImage.sha256} : undefined,
      ...(ontology.imageConsistency ? {identity:resolveImageConsistency(ontology,a.id).desiredReferences} : {}) });
  for (const s of shots)
    if (typeof s.id === "string")
      targetHashes[s.id] = hash({
        shot: { ...s, imageAttempt:undefined, reviewImage: s.reviewImage ? {sha256:s.reviewImage.sha256} : undefined },
        context: {...contexts.get(s.id),assets:contexts.get(s.id)?.assets.map(({imageAttempt,...a})=>a)},
        generationHash: shotHashes[s.id],
      });
  const gaps: Compiled["gaps"] = assets
    .filter((a) => a.gap || !a.fileId || !a.sha256)
    .map((a) => ({
      assetId: a.id,
      shotIds: shots
        .filter((s) =>
          contexts.get(s.id)?.assets.some((ref) => ref.id === a.id),
        )
        .map((s) => s.id),
      reason: a.gap
        ? "专属素材尚未制作或尚未确认；参考图不能自动替代。"
        : "素材登记存在，尚需导入并绑定内容文件。",
    }));
  const tasks: TaskPlan[] = [];
  const emitted = new Set<string>(),
    taskStack = new Set<string>();
  const emit = (s: Shot) => {
    if (emitted.has(s.id) || taskStack.has(s.id)) return;
    taskStack.add(s.id);
    const deps = dependencies(s);
    deps.forEach((id) => {
      const d = shotBy.get(id);
      if (d) emit(d);
    });
    const dependencyTasks = deps.map((id) =>
      shotBy.has(id) ? finalTask(shotBy.get(id)!) : `missing:${id}`,
    );
    const durationFrames = s.endFrame - s.startFrame;
    const c = contexts.get(s.id)!;
    const first = anchorBy.get(s.firstAnchorId || ""),
      end = anchorBy.get(s.endAnchorId || "");
    const continuityAction = c.entities.find(
      (e) =>
        e.type === "action" && typeof e.attributes?.matchRequired === "boolean",
    );
    const input: Record<string, unknown> = {
      shotId: s.id,
      generationHash: shotHashes[s.id],
      prompt: prompts[s.id],
      fps: spec.fps,
      width: spec.width,
      height: spec.height,
      startFrame: s.startFrame,
      endFrame: s.endFrame,
      durationFrames,
      targetDurationSeconds: durationFrames / spec.fps,
      duration: Math.max(4, Math.ceil(durationFrames / spec.fps)),
      route: s.route,
      firstAnchorId: s.firstAnchorId,
      endAnchorId: s.endAnchorId,
      firstAssetId: first?.assetId,
      endAssetId: end?.assetId,
      assetIds: c.assets.map((a) => a.id),
      requiredAssetIds: list(s.requiredAssetIds),
      dialogue: list(s.dialogue),
      dependencyShotIds: deps,
      dependencyOutputTaskIds: dependencyTasks,
      continuity: deps.map((id) => ({
        shotId: id,
        outputTaskId: shotBy.has(id)
          ? finalTask(shotBy.get(id)!)
          : `missing:${id}`,
        use: "accepted-parent-output",
        acceptanceRequired: true,
        startState: s.startState,
        matchRequired: continuityAction?.attributes.matchRequired ?? false,
        transitionMethod:
          continuityAction?.attributes.transitionMethod ||
          "review-continuity-before-next-shot",
        stateToMatch: continuityAction?.attributes.stateToMatch || s.startState,
        sameSceneTailFrameMustBeExplicitlySelected: true,
      })),
      referencePlan: {
        firstAssetId: first?.assetId,
        endAssetId: end?.assetId,
        effective: "verify-provider-capability-at-submission",
        endFrameMustNotBeClaimedAsSentWithoutReceipt: true,
      },
    };
    if (s.route === "doctor") {
      tasks.push({
        id: `voice:${s.id}`,
        kind: "voice",
        shotId: s.id,
        dependsOn: dependencyTasks,
        input: {
          ...input,
          purpose: "voice",
          approvalRequired: "accepted-exact-speech-before-lipsync",
        },
      });
      tasks.push({
        id: `lipsync:${s.id}`,
        kind: "lipsync",
        shotId: s.id,
        dependsOn: [`voice:${s.id}`, ...dependencyTasks],
        input: {
          ...input,
          purpose: "lipsync",
          audioTaskId: `voice:${s.id}`,
          sameReviewedAudioRequired: true,
          portraitAssetId: first?.assetId,
          approvalRequired: "accepted-lipsync-before-child-shot-or-compose",
        },
      });
    } else
      tasks.push({
        id: finalTask(s),
        kind: s.route === "graphic" ? "graphic" : "video",
        shotId: s.id,
        dependsOn: dependencyTasks,
        input: {
          ...input,
          purpose: "video",
          approvalRequired: "accepted-output-before-child-shot-or-compose",
        },
      });
    emitted.add(s.id);
    taskStack.delete(s.id);
  };
  for (const s of [...shots]
    .filter((s) => typeof s.id === "string")
    .sort((a, b) => a.startFrame - b.startFrame || a.id.localeCompare(b.id)))
    emit(s);
  if (shots.length)
    tasks.push({
      id: "compose",
      kind: "compose",
      dependsOn: shots.map(finalTask),
      input: {
        postHash,
        spec,
        subtitles,
        postProgram: raw.postProgram || null,
        sourceTaskIds: shots.map(finalTask),
        acceptedSourceRequired: true,
        narration: "only-explicit-dialogue",
        noTimeStretch: true,
      },
    });
  const nodes: Compiled["graph"]["nodes"] = [],
    edges: Compiled["graph"]["edges"] = [];
  const addEdge = (from: string, to: string) => {
    if (from && to && !edges.some((e) => e.from === from && e.to === to))
      edges.push({ from, to });
  };
  for (const e of entities) {
    nodes.push({ id: e.id, label: e.label, kind: e.type });
    list<string>(e.evidenceIds).forEach((id) => addEdge(id, e.id));
  }
  for (const a of assets)
    nodes.push({ id: a.id, label: a.label, kind: `asset:${a.kind}` });
  for (const e of evidence)
    nodes.push({ id: e.id, label: e.title, kind: "evidence" });
  for (const a of anchors) {
    nodes.push({ id: a.id, label: `${a.role} · ${a.state}`, kind: "anchor" });
    addEdge(a.entityId, a.id);
    addEdge(a.assetId, a.id);
  }
  for (const r of relations) {
    nodes.push({
      id: r.id,
      label: r.type,
      kind: `relation:${r.projection || "together"}`,
    });
    addEdge(r.from, r.id);
    addEdge(r.id, r.to);
  }
  for (const s of shots) {
    nodes.push({ id: s.id, label: s.title, kind: `shot:${s.route}` });
    [
      ...list<string>(s.entityIds),
      ...list<string>(s.requiredAssetIds),
      ...list<string>(s.evidenceIds),
      s.firstAnchorId,
      s.endAnchorId,
    ]
      .filter(Boolean)
      .forEach((id) => addEdge(id!, s.id));
    dependencies(s).forEach((id) => addEdge(id, s.id));
  }
  for (const t of tasks) {
    const id = `task:${t.id}`;
    nodes.push({ id, label: t.kind, kind: "task" });
    if (t.shotId) addEdge(t.shotId, id);
    t.dependsOn.forEach((dep) => addEdge(`task:${dep}`, id));
  }
  return {
    hash: hash(ontology),
    shotHashes,
    postHash,
    targetHashes,
    issues,
    gaps,
    tasks,
    graph: { nodes, edges },
    reviewData: ontology,
    prompts,
    subtitles,
  };
}

/** Stable image brief hashes exclude candidate choice so selecting a result cannot invalidate itself. */
export function imageTargetHashes(ontology: Ontology): Record<string, string> {
  const copy=structuredClone(ontology);
  for(const shot of copy.shots) { delete shot.reviewImage; delete shot.firstFrameImage; delete shot.imageAttempt; }
  const compiled=compileOntology(copy), values:Record<string,string>={};
  for(const asset of ontology.assets) {
    const {fileId,sha256,gap,previewImage,imageAttempt,...brief}=asset;
    values[asset.id]=hash({schema:"storyflow-image-brief-v1",spec:{width:ontology.spec.width,height:ontology.spec.height},asset:brief,
      ...(ontology.imageConsistency ? {identity:resolveImageConsistency(ontology,asset.id).desiredReferences} : {})});
  }
  for(const shot of ontology.shots)
    values[shot.id]=hash({schema:"storyflow-image-brief-v1",shotHash:compiled.shotHashes[shot.id]});
  return values;
}
export function imageTargetHash(ontology: Ontology, target: {assetId?: string;shotId?: string}): string {
  return imageTargetHashes(ontology)[target.assetId || target.shotId || ""] || hash({missingTarget:target});
}
