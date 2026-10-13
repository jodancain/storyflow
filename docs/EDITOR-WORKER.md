# 独立 Claude Code 编辑 worker

这是一项独立、私有的后期执行服务，不复用 StoryFlow 的数据库、审核状态或生产容器。代码在 `ops/editor/`。只有操作者明确提交 JSON 任务时才运行模型；部署或编译镜像本身不会创建编辑任务。生成成功只表示程序及产物校验完成，不表示声音、医学内容或影片已获人工批准。最终合成后还须完成独立的逐段口型复核；待审或返修片段不能随 `completed` 状态被当成已通过成片发布。

## 固定环境与边界

- Node `22.23.1` Debian bookworm slim；Claude Code npm 包及所有平台包固定 `2.1.258`，`package-lock.json` 保存 registry integrity。主包 SHA-512：`Zis1AYrHuCcK4V1tXJUkzJdklFsTvvqIcj7gk4K8lyEeJOW99ZoQH/E+WxugMqDEO7xncYZ41gydxlkSTmj/2Q==`。容器启动任务前核对 CLI 版本。
- apt通过Docker ARG明确固定版本：`python3=3.11.2-1+b1`（含 `wave`、`audioop`）、`ffmpeg=7:5.1.9-0+deb12u1`（含FFprobe）、`chromium=155.0.8059.39-1~deb12u1`、`fonts-noto-cjk=1:20220127+repack1-1`。2026-10-13 全新 CI 构建发现旧 Chromium 154 pin 已从 amd64 仓库移除，因此按 [Debian 官方包索引](https://packages.debian.org/bookworm/chromium) 的 amd64/arm64 版本明确更新为 155；旧失败日志保留。仓库缺少精确版本时构建失败，须人工明确调整ARG并重做运行与媒体验收，不自动升版或去掉固定。编译器、系统库与apt传递依赖未做完整快照固定。当前 MCP 仅允许 Python、Node、FFmpeg、FFprobe 执行；**浏览器渲染未开放，也未因此宣称可用**。
- 默认 profile `9router-native`：Claude Code 原生 Messages 端点为 `https://router.yundongyl.cn/v1/messages`，base配置为 `https://router.yundongyl.cn`，请求 wire 模型为 `ezr/claude-opus-5-5`，不用 `/auto`。显式旧选项 `ezr-direct` 使用 `https://ezr.sh` 和 `claude-opus-5-5`；不自动切换profile。CLI 参数固定 `--print --output-format stream-json --verbose --model`，禁用普通 Bash、内置工具、自动模型切换、外部 MCP 自动发现、项目设置、更新及无关遥测。模型有多次正常工具轮次，任务不是单个 HTTP 请求；不把 CLI 启动次数当作供应商计费请求数。
- 私有 API Key 只从 `/run/secrets/anthropic_api_key` 读取。默认9Router profile使用下述容器内图片桥接，真实key仅在worker内存并发送给固定HTTPS上游；CLI的 `ANTHROPIC_API_KEY` 只含本轮随机loopback token。显式ezr-direct才将真实key交给CLI。均不放在Compose environment、命令参数、任务JSON、日志或镜像中。其他供应商/OAuth/代理环境不继承。
- 无公开端口、Docker socket、生产 DB 或宿主工程挂载。UID/GID `10001`；只读根文件系统、去除全部 capabilities、`no-new-privileges`；2 CPU、3 GiB 内存、128 PID。输入 bind mount 只读；state、work、sessions 使用三个独立 named volumes。
- 模型通过本地 stdio MCP 读取文字/图片、写本任务文件、执行后期脚本。脚本使用固定解释器和参数数组，`shell=false`。Landlock 将文件访问限制为本任务工作区、声明并校验 SHA 的输入快照和系统库；seccomp 禁网络、ptrace 等，不允许读取 `/proc`、会话卷、任务状态或 secret。子进程清空模型/API 环境。MCP 文件操作逐层使用目录 fd 与 O_NOFOLLOW，原子写入不跟随可并发替换的符号链接。
- Linux 至少需要启用 Landlock 的 5.13 内核；5.15 的 ABI 1 没有 truncate 权限，额外 seccomp 阻断 truncate/ftruncate 及只读 O_TRUNC 绕过。不支持或烟雾失败则 `waiting_configuration`，不退回无沙箱执行。MCP入口不提供Unix shell或Chromium。ELF动态加载器的精确amd64/arm64路径另外获得内核所需EXEC权限；任意脚本仍可能借加载器运行系统程序，因此固定工具入口不是完整ELF执行隔离，安全边界依靠继承的文件、网络和进程限制。
- 单个 worker 文件锁涵盖整个任务，MCP 工具串行执行；脚本也应等待每个 FFmpeg 结束，禁止自行启动后台任务。每次工具最长600秒，单任务最多7200秒；工具结束会清理同进程组子进程；脚本禁止 setsid/setpgid 及对其他进程发信号。worker 启用 Linux child-subreaper，CLI结束或中断后清理收养的后代，防止 MCP被杀时残留工具进程。

## 构建与本地隔离检查

```sh
python3 -m unittest discover -s ops/editor/tests -v
# 亦纳入 npm test 的 tests/editor-worker.test.ts
docker build -t storyflow-editor:claude-2.1.258 ops/editor
# 有需要时替换镜像，仅替换URI，保留Debian GPG签名验证。
docker build --build-arg DEBIAN_MIRROR=http://mirrors.cloud.tencent.com \
  -t storyflow-editor:claude-2.1.258 ops/editor
docker run --rm --user 10001:10001 --cap-drop ALL --security-opt no-new-privileges \
  storyflow-editor:claude-2.1.258 python3 /opt/editor/sandbox_smoke.py
```

使用BuildKit；npm安装复用 `id=storyflow-editor-npm,target=/root/.npm,sharing=locked` 下载缓存，包仍按锁文件integrity验证，缓存不包含模型凭据。Node slim 基础层可能尚无 CA 证书，首次 apt 镜像采用 HTTP（与默认 Debian 源一致）或提前安装 CA，不能用关闭 TLS 验证来绕过。后续 npm 与模型 API 使用 HTTPS。Docker 默认 seccomp 必须允许 Landlock 系统调用；若受阻先审精确系统调用，不使用 privileged 或关闭整个 seccomp。

上述测试不访问模型。Linux 烟雾验证真实 Python 写文件与 FFmpeg 执行，以及 secret、`/proc/1/environ`、输入写入、网络、truncate、脱离进程组和进程信号均被拒绝。Mac 只能运行单元/协议测试，不能用其结果代替 Linux 沙箱测试。

构建上下文采用 `.dockerignore` 的默认全排除＋逐文件白名单。`test_build_context.py`读取真实Dockerfile的所有本地COPY输入，验证文件存在、不是链接且已被白名单放行；新增脚本必须同时更新COPY与白名单。回归夹具重现遗漏 `image_bridge.py` 和文件缺失，均要求报错。该检查有意只支持当前的精确文件策略，遇到通配符/动态COPY或新的ignore语义会明确失败，要求复核，不能静默漏检。它不代替真实Docker构建与Linux运行检查。

## Compose 配置

把模型 secret 与任务输入放在镜像构建目录之外。私有父目录建议0700，secret由容器 UID10001读取（宿主可设置对应uid及0400）；本地 Compose 的 file secret 不保证应用 `uid/mode` 映射，部署者需实际验证可读性，验证只输出布尔值。

```sh
export EDITOR_INPUT_DIR=/private/editor-input
export EDITOR_API_KEY_FILE=/private/editor-secrets/anthropic-api-key
export EDITOR_ROUTE_PROFILE=9router-native
export EDITOR_ANTHROPIC_BASE_URL=https://router.yundongyl.cn
export EDITOR_MODEL=ezr/claude-opus-5-5
docker compose -f ops/editor/compose.yaml up -d --build
```

不要在终端输出 Key；不要将这些绝对路径写入 Git。profile、base、wire模型必须完整匹配 `.env.example` 的同一组配置；拒绝 `/auto`、其他前缀和混合profile。`ANTHROPIC_MODEL`、Opus、Sonnet、Haiku默认alias均固定同一个wire模型，未配置自动降级。网关是否支持Claude原生Messages与完整工具往返，由部署者真实烟雾确认。不使用 `models` 列表存在作为实际编辑能力已通过的证据。

## 提交任务

任务文件允许从 stdin（`/dev/stdin`）提交，输入媒体相对 `/input`。每个输入都须列入清单并指定实际 SHA-256；不会把输入根目录里其他文件复制给模型。输出相对本任务 workspace，必须非空普通文件且非符号/硬链接。输出 `sha256` 可选：已知精确目标时要求匹配；新生成作品无法预知哈希，完成时生成真实清单。

```json
{
  "schema": 1,
  "idempotencyKey": "human-approved-edit-v1",
  "prompt": "阅读brief.txt与source.wav。编写并执行build.py，生成1秒64×64、25fps且带声音的MP4，并输出report.json。不可调用其他模型，不可联网。",
  "inputs": [
    {"path": "source.wav", "sha256": "<实际64位小写SHA256>"},
    {"path": "brief.txt", "sha256": "<实际64位小写SHA256>"}
  ],
  "outputs": [
    {"path": "build.py"},
    {"path": "report.json"},
    {"path": "result.mp4", "media": {"kind": "video", "durationSeconds": 1, "toleranceSeconds": 0.04, "width": 64, "height": 64, "fps": 25, "frames": 25, "audioRequired": true}}
  ],
  "maxTurns": 30,
  "timeoutSeconds": 3600
}
```

```sh
docker compose -f ops/editor/compose.yaml exec -T editor \
  python3 /opt/editor/worker.py submit /dev/stdin < job.json
docker compose -f ops/editor/compose.yaml exec -T editor \
  python3 /opt/editor/worker.py status <返回的jobId>
```

提交即授权执行该冻结任务，应只在已有用户授权范围内使用。相同规范 JSON 返回同一 jobId；同一幂等键配不同内容直接拒绝。幂等索引在任务可运行前持久预约；中断后相同提交补齐同一快照，调度时再次核对索引。`maxBudgetUsd` 可作为可选 CLI 估算上限，但不是硬性供应商账单封顶，不能代替既有授权范围。

图片工具 `read_image` 返回真实 PNG/JPEG imageContent。默认9router-native profile的检查图硬上限为96KiB，工具描述和超限错误明确要求先用FFmpeg另存不超过64KiB的JPEG缩略图、核对文件尺寸后再读，小批检查；不跳过实际看图，不覆盖原图，最终视频仍可1080p。显式ezr-direct保持原8MiB上限。由worker根据固定profile向MCP注入仅含数字的 `EDITOR_IMAGE_MAX_BYTES`，不是任务可修改的参数，不包含密钥。两种模式仍保留1600万像素及原有格式/路径检查；视频先经FFmpeg提帧。当前不提供音频听觉工具；可用FFprobe、wave样本/声学统计辅助编辑，人耳听审仍单列。

### 9Router工具图片兼容

2026-10-13只读核对运行中的9Router `0.5.30`，其Claude→OpenAI转换器对`tool_result.content`只提取文字；纯图结果退回`JSON.stringify`，使base64变成大量文本，文字与图片混合时则丢掉图片。顶层user图片已有正确的`image_url`分支。实际剪辑任务也在首次成功返回图片后发生`prompt_too_long`；此前超尺寸图片失败与该问题分开记录。当前官方转换器已采用单独提取工具图片的方式，但本轮不修改生产9Router。

`image_bridge.py`仅在9router-native的单次attempt期间监听容器内`127.0.0.1`随机端口，无公开映射；CLI以随机本地token鉴权。它把工具结果中的图片移到紧随完整工具结果消息之后的独立user消息，保留图片字节、原有文字、全部tool ID/error字段及顶层图片，并标明图片对应的工具。多个并行工具结果保持相邻，不在中间插图。不会改写模型、提示词、工具定义或响应模型字段。

上游固定为`https://router.yundongyl.cn`，仅允许`POST /v1/messages`与`POST /v1/messages/count_tokens`（兼容SDK的`?beta=true`）；模型仍固定`ezr/claude-opus-5-5`。请求最多32MiB、单图8MiB；TLS验证保持开启，拒绝重定向，不重试、不切模型。HTTP错误与SSE字节透传；不记录body、key或上游异常内容。工具脚本的网络禁用仍有效。关闭CLI后关闭监听，原attempt日志不变；恢复旧会话时每次请求中的历史嵌套图片同样转换。

intent继续记录真实上游base与Messages端点，另记录兼容模式；`image-bridge.json`仅记录请求/图片数量、状态码与错误计数，不记录本地token或图片内容。新增离线协议与worker测试证明转换与转发行为，不代表真实模型已看懂画面；部署后由主执行者以真实工具图像往返及画面描述验收。

首次实际桥接恢复消除了原图片引发的HTTP400，但随后出现自动压缩上下文循环。只读核实该运行版本的 `usageTracking.js:338–347` 用 `ceil(JSON.stringify(body).length / 4)` 估算输入，图片base64也被计入；`stream.js:316–325`在结束包缺少有效usage时可把此估算回传。源码可确认这条风险路径，但没有逐请求上游原始usage，不能断言每次循环都由同一分支触发。MCP缩略图字节限制用于避免单图估算暴涨，不改写SSE用量或谎报模型上下文。原准备任务两次attempt保留为未完成，不自动继续；后续完整剪辑任务需独立冻结并真正读取小图。

## 持久状态与人工恢复

`/state/jobs/<jobId>/job.json` 是输入快照，规范哈希即 jobId；`state.json` 保存状态和 session UUID；`attempts/001/` 内保存 intent、脱敏 stream日志、CLI结果、实际工具调用证据和产物SHA清单；intent记录该次profile、实际base、Messages端点与请求wire模型。会话在 `/sessions/<jobId>/`，输入快照与workspace在 `/work/<jobId>/`。这些路径全部私有，不纳入公网目录或源码ZIP。

| 状态 | 行为 |
|---|---|
| queued | 等待全局串行锁 |
| waiting_configuration | 凭据、CLI版本或Linux沙箱未通过；提交次数仍0 |
| invalid_input | 输入哈希/工作目录异常；不调用模型 |
| submitting / running | 先持久 intent，再启动 CLI；一次 attempt 只启动一次 |
| needs_reconcile | 超时、断流、退出异常、结束记录不完整或重启时受理不明；不自动新投 |
| failed_validation | CLI完成，但没有成功实际工具执行，或文件缺失、哈希/媒体约束或完整解码失败；不算完成 |
| completed | CLI明确完成＋实际响应模型一致＋至少一次成功run＋实际产物通过；重启核对原文件哈希后恢复 |
| artifact_invalid | 已完成产物后来改变或丢失，不重跑模型 |

断流时禁止非流式回退及自动传输重试；无明确完成记录的状态均保守留待核对。CLI和网关的真实行为仍需部署烟雾确认。结果保留 `reportedModels` 原始字段和本轮 `observedModels`。9router-native只接受精确 `ezr/claude-opus-5-5` 或网关去前缀后返回的 `claude-opus-5-5`；ezr-direct只接受后者。未知/不同模型拒绝，缺失或仅 `<synthetic>` 返回均为needs_reconcile。**这只是网关回传证据，不能独立证明底层供应商模型身份**。记录 tool_use、tool_result、成功工具、成功run及成功Python/Node脚本的计数；模型文字声称完成不能替代实际工具返回成功。

人工确认旧会话与供应商状态后，可显式续接 **同一个session UUID**。这会产生新的模型轮次/费用；必须有新授权依据，不是免费续查。旧attempt永不覆盖，不能指定另一个session冒充恢复。旧403、synthetic及原日志原样保留；恢复时只统计当前attempt事件，忽略显式replay标志和旧日志的UUID/message ID/事件指纹，旧工具结果不能冒充本轮执行。切路由也不会自动恢复失败任务。

```sh
docker compose -f ops/editor/compose.yaml exec -T editor \
  python3 /opt/editor/worker.py resume <jobId> --session-id <原sessionId> \
  --authorization-ref '已确认的用户消息或人工核对记录ID' --prompt-file /dev/stdin < resume.txt
```

`resume`只对needs_reconcile/failed_validation/artifact_invalid开放。无授权字符串、错session、重复resume、已完成任务均拒绝。没有自动退回新会话的路径。resume保留已正确完成的文件，原哈希写入intent供审计，不要求每个输出都变化。仍须本次真实工具执行和完整产物约束通过，不能通过一句模型“已完成”绕过文件校验。旧的孤立attempt目录保留并标needs_reconcile；人工核对后续接使用新序号，不覆盖旧历史。

## 最终口型复核与返修

worker 的 `completed` 是执行合同完成，最终口型审核另行保存，不回写为模型已经替人批准。操作者在合成后冻结最终影片、已获审母带、逐段计划及驱动音轨哈希，按 [声音先行工作流](VOICE-FIRST-WORKFLOW.md#最后再对一遍嘴型) 逐段人工检查。全部声音段落都应列入，包括内心独白和画外音；不能只列认为正确的医生片段。

先以1倍速看听完整成片，再核对每段首中尾、开闭口、停顿、切点两侧、角色和台词。检查源片入点、实际速度、声音绑定以及字幕、裁切或动作遮嘴。必要时降速／逐帧定位。FFprobe、源帧与音频时钟匹配不能证明主观嘴形自然，也不能代替人工意见。

每段须有明确通过、返修或不适用及其理由。只有内心独白／画外声确实无可见说话口部时才可不适用；明显张嘴的女主旧画面配内心独白属于返修，意外遮嘴不能作为通过依据。不通过时记录具体帧区间，再根据已授权范围调整剪辑或用该段最终获审声音重做口型；照片＋音频生成的新片段不等于保持原视频动作的局部嘴部修复。

返修必须产生新候选，重新合成后再复核。最终文件或任一绑定输入哈希变化时，旧通过记录只作历史；不得用相同文件名继承批准。任何待审、返修、缺失输入、范围不完整或哈希不符均阻止本版口型通过，之后还需内容审片和公开许可。复核工具不自动调用模型，不自动部署、提交网页任务或发布影片；当前主应用与独立编辑器仍是人工冻结交接。

### 私有逐段记录

`final_lip_review.py` 是操作者运行的确定性工具，不使用模型或自动判断嘴形。时间线 schema 为 `storyflow-final-lip-timeline-v1`：`fps` 为24或25，`totalFrames` 为总帧数；`film`、`audio` 各含相对 `path` 与实际 `sha256`。`segments` 按帧完整、连续、无重叠地覆盖全片，每段保存 `id`、`startFrame`、`endFrame`、`mode`、`speakerId`、`text`、`sourceVideo` 文件引用、`sourceInFrame`、`sourceFps`、`speed: {numerator, denominator}`、`audio` 文件引用和 `audioInFrame`。区间从0起算，含 `startFrame`、不含 `endFrame`；`audioInFrame` 使用项目 `fps`，`sourceInFrame` 使用 `sourceFps`。无声段须令 `speakerId`、`text` 为空字符串、`audio` 为 `null`、`audioInFrame` 为0，其余说话段必须有角色、台词和音频引用。文件引用相对时间线目录，不接受URL或越界路径。

`mode` 区分 `visible_speech`、`voiceover` 与 `silent`。可见说话段只能以人工 `pass` 通过；画外声／内心独白及无声段必须逐段确认 `not_applicable` 并说明理由。时间线分类本身仍需人工核对：把明显说话画面填作 `voiceover` 不能证明画面合格。`change` 与尚未审核的 `pending` 均阻止通过。

为独立 worker 审核时，时间线放在 `/work/<jobId>/final-lip-timeline.json`，可引用 `workspace/result.mp4`、`inputs/master.wav` 和冻结源片。审核文件必须位于操作者控制的 `/state/jobs/<jobId>/final-lip-review.json`，不接受模型工作区中的“自我批准”。该目录不在模型可读写的 MCP 工作范围内。先填写并检查时间线，随后执行：

```sh
JOB_ID='<实际jobId>'
docker compose -f ops/editor/compose.yaml exec -T editor \
  python3 /opt/editor/final_lip_review.py init \
  --timeline "/work/$JOB_ID/final-lip-timeline.json" \
  --review "/state/jobs/$JOB_ID/final-lip-review.json"

# 只有人实际检查本段后才记录；版本号使用上次返回的 revision。
docker compose -f ops/editor/compose.yaml exec -T editor \
  python3 /opt/editor/final_lip_review.py record \
  --timeline "/work/$JOB_ID/final-lip-timeline.json" \
  --review "/state/jobs/$JOB_ID/final-lip-review.json" \
  --expected-revision 1 --segment S01 --status pass \
  --reviewer '实际审核人' --note '实际逐段检查结论'

docker compose -f ops/editor/compose.yaml exec -T editor \
  python3 /opt/editor/final_lip_review.py check \
  --timeline "/work/$JOB_ID/final-lip-timeline.json" \
  --review "/state/jobs/$JOB_ID/final-lip-review.json"
```

`init` 创建 revision 1、所有段落 `pending` 的记录，拒绝覆盖已有文件；`record` 以 `--expected-revision` 防止覆盖并发意见，状态可选 `pass`、`change`、`not_applicable`。工具绑定时间线原始文件 SHA 及全部被引用文件的实际 SHA；文件、排布或绑定改变后拒绝沿用记录，须保留旧记录并为新候选建立新审核。`check` 输出 JSON 的 `ok`、`state` 和 `revision`；未完成退出2，格式、哈希或并发错误退出1，全部通过才退出0。它校验记录完整性，不自动测量嘴形或确认最终音轨逐句对齐；审核人姓名是操作者的审计记录，不是身份认证，也不查证此前声音批准的真实性。

### 交付门槛与导出

先将复核与 worker 的技术产物关联，再导出到新的私有交接目录：

```sh
docker compose -f ops/editor/compose.yaml exec -T editor \
  python3 /opt/editor/worker.py delivery-check "$JOB_ID" \
  --timeline-file "/work/$JOB_ID/final-lip-timeline.json" \
  --review-file "/state/jobs/$JOB_ID/final-lip-review.json"

# /handoff 须先配置为 UID 10001 可写的独立私有持久挂载。
# 默认 Compose 没有此挂载；/tmp 只适合临时检查，不能当成交付存储。
docker compose -f ops/editor/compose.yaml exec -T editor \
  python3 /opt/editor/worker.py export-reviewed "$JOB_ID" \
  --timeline-file "/work/$JOB_ID/final-lip-timeline.json" \
  --review-file "/state/jobs/$JOB_ID/final-lip-review.json" \
  --destination /handoff/new-film-review
```

两条命令的 `--timeline-file` 可省略，此时读取审核文件记录的原时间线位置。门槛要求任务技术状态为 `completed`、当前输出匹配该次 `outputs.json` 回执并通过既有媒体检查、影片是合同中声明的视频、时间线帧率／帧数匹配、母带及每段驱动音轨哈希均属于冻结任务输入，且当前逐段复核通过。未通过不能导出；模型在其工作区写一个“通过”JSON无法替代私有人工记录。

导出目的目录必须尚不存在，并位于 `/state`、`/work`、`/sessions`、`/input` 等编辑器根目录之外。只复制 `film.mp4`（保留原扩展名）及脱敏 `DELIVERY.json`，再次核对复制后哈希与当前复核；不包含审核人姓名、台词、意见、私有路径、源片或程序。`DELIVERY.json` 的 `finalLipReview: "passed"` 只代表此次逐段口型门槛，`publiclyPublished` 始终为 `false`；不替代医学／内容批准或公开许可，也不会上传公网。

## 本轮验证范围

本地62项单元/模拟子进程测试通过，覆盖幂等冲突、intent先写、文件实证、输入漂移、模型名漂移、末包错误、重启未知不重投、已完成哈希恢复、显式同会话resume、全局锁、路径/链接隔离与并发换链、索引预约断电恢复、孤立attempt、后代清理、日志脱敏、imageContent及真实本地MCP stdio初始化/读写、profile匹配、wire别名、合法去前缀回传和恢复历史隔离，以及图片桥接的图文混合、多工具对应、SSE/HTTP错误不改写、无重试、固定路由、重定向拒绝、私有鉴权、Docker COPY源文件/构建白名单检查，以及profile图片大小限制、明确超限提示和原图保全。测试没有模型调用。

主执行者于2026-10-12记录真实运行验收：Linux镜像、Landlock/seccomp烟雾、CLI 2.1.258与5项MCP工具接通；经9Router原生Messages完成真实模型工具闭环，回传 `claude-opus-5-5`，7次成功工具、2次实际Python执行；生成1秒、25帧H.264/AAC MP4，并通过独立媒体检查。原ezr直连403历史保留，没有自动补投或替换证明。该回传名称仍不能独立证明底层供应商身份。

2026-10-13，用户明确要求直接制作视频，沿用此前的完整60秒声音。新版镜像已实际构建、完成Linux沙箱烟雾并运行正式剪辑任务：Claude Code真实读取12张检查图，编写并执行后期程序，完成36段剪辑、字幕及五段新医生口型的拼接。原图桥接准备任务的两次未完成attempt保留；正式任务为单独冻结任务，发生一次正常上下文压缩后完成。没有重复提交口型或重新合成声音。

正式任务自己发现首个封装结果音频只有59.264秒，修正FFmpeg结束条件后再输出。最终独立验证为60秒、1500帧、25fps、1080×1920、H.264/AAC，完整解码通过；13段声音及最后一句均与获准母带0毫秒偏移，34条字幕保留446字。五段医生使用的446个实际画面帧另做逐帧源匹配，起点误差均在20毫秒以内。上述媒体证据与62项源码测试分开；无配乐/音效，沿用素材仍存在礼物厚度和部分动作连续性差异，成片作为可播放审片版交付，不表示内容、医学或主观口型自然度已经定稿。私有日志、会话标识、内部地址和产物哈希保留在私有报告，不写入此文。核心应用、原工程审核与生产数据库未修改。

官方参考：[CLI参数](https://code.claude.com/docs/en/cli-reference)、[环境变量](https://code.claude.com/docs/en/env-vars)、[Linux Landlock](https://docs.kernel.org/userspace-api/landlock.html)。2.1.258不支持的后续新增参数不作为本实现前提。
