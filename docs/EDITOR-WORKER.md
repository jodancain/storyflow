# 独立 Claude Code 编辑 worker

这是一项独立、私有的后期执行服务，不复用 StoryFlow 的数据库、审核状态或生产容器。代码在 `ops/editor/`。只有操作者明确提交 JSON 任务时才运行模型；部署或编译镜像本身不会创建编辑任务。生成成功只表示程序及产物校验完成，不表示声音、医学内容或影片已获人工批准。

## 固定环境与边界

- Node `22.23.1` Debian bookworm slim；Claude Code npm 包及所有平台包固定 `2.1.258`，`package-lock.json` 保存 registry integrity。主包 SHA-512：`Zis1AYrHuCcK4V1tXJUkzJdklFsTvvqIcj7gk4K8lyEeJOW99ZoQH/E+WxugMqDEO7xncYZ41gydxlkSTmj/2Q==`。容器启动任务前核对 CLI 版本。
- apt通过Docker ARG明确固定本轮已安装版本：`python3=3.11.2-1+b1`（含 `wave`、`audioop`）、`ffmpeg=7:5.1.9-0+deb12u1`（含FFprobe）、`chromium=154.0.8037.92-1~deb12u1`、`fonts-noto-cjk=1:20220127+repack1-1`。仓库缺少精确版本时构建失败，须人工明确调整ARG并重做运行与媒体验收，不自动升版或去掉固定。编译器、系统库与apt传递依赖未做完整快照固定。当前 MCP 仅允许 Python、Node、FFmpeg、FFprobe 执行；**Chromium 已安装，但浏览器渲染未开放，也未因此宣称可用**。
- 默认 profile `9router-native`：Claude Code 原生 Messages 端点为 `https://router.yundongyl.cn/v1/messages`，base配置为 `https://router.yundongyl.cn`，请求 wire 模型为 `ezr/claude-opus-5-5`，不用 `/auto`。显式旧选项 `ezr-direct` 使用 `https://ezr.sh` 和 `claude-opus-5-5`；不自动切换profile。CLI 参数固定 `--print --output-format stream-json --verbose --model`，禁用普通 Bash、内置工具、自动模型切换、外部 MCP 自动发现、项目设置、更新及无关遥测。模型有多次正常工具轮次，任务不是单个 HTTP 请求；不把 CLI 启动次数当作供应商计费请求数。
- 私有 API Key 只从 `/run/secrets/anthropic_api_key` 读取，在创建 CLI 子进程时放入其 `ANTHROPIC_API_KEY`。不放在 Compose environment、命令参数、任务 JSON、日志或镜像中。其他供应商/OAuth/代理环境不继承。
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

图片工具 `read_image` 返回真实 PNG/JPEG imageContent，上限8MiB、1600万像素；视频先经FFmpeg提帧。当前不提供音频听觉工具；可用FFprobe、wave样本/声学统计辅助编辑，人耳听审仍单列。

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

## 本轮验证范围

本地45项单元/模拟子进程测试通过，覆盖幂等冲突、intent先写、文件实证、输入漂移、模型名漂移、末包错误、重启未知不重投、已完成哈希恢复、显式同会话resume、全局锁、路径/链接隔离与并发换链、索引预约断电恢复、孤立attempt、后代清理、日志脱敏、imageContent及真实本地MCP stdio初始化/读写、profile匹配、wire别名、合法去前缀回传和恢复历史隔离。测试没有模型调用。

主执行者于2026-10-12记录真实运行验收：Linux镜像、Landlock/seccomp烟雾、CLI 2.1.258与5项MCP工具接通；经9Router原生Messages完成真实模型工具闭环，回传 `claude-opus-5-5`，7次成功工具、2次实际Python执行；生成1秒、25帧H.264/AAC MP4，并通过独立媒体检查。原ezr直连403历史保留，没有自动补投或替换证明。该回传名称仍不能独立证明底层供应商身份。

正式声音任务已交主执行者运行，声音内容与听感仍待审；本worker尚未执行正式视频制作。以上运行证据与45项本地源码测试分开，不把烟雾成功视为完整声音或影片批准。私有日志、会话标识、内部地址和产物哈希保留在私有报告，不写入此文。不改核心应用、原工程审核或生产数据库。本次补充版本固定与构建缓存仅改变下次构建，不重启正在执行的声音任务；新版Dockerfile仍由主执行者后续构建验证。

官方参考：[CLI参数](https://code.claude.com/docs/en/cli-reference)、[环境变量](https://code.claude.com/docs/en/env-vars)、[Linux Landlock](https://docs.kernel.org/userspace-api/landlock.html)。2.1.258不支持的后续新增参数不作为本实现前提。
