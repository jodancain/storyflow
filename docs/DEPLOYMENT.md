# StoryFlow 独立运行与维护

本仓库准备本机开发与独立容器。v0.2 另行更新既有云动静态审稿页；v0.3 增加可配置的在线审图入口。静态包发布或配置文件存在都不代表后台已经部署。`compose.yaml` 仅监听 `127.0.0.1:18296`，不修改原视频服务，不配置公网 DNS，不发布到生产。未来反向代理模板位于 `deploy/nginx/storyflow.conf`，当前未挂载或启用。

## 运行边界

- Node 22（最低 22.13）承载 API、持久任务和构建后的 React 页面。
- 一个 Debian 容器包含 Chromium、FFmpeg / FFprobe、Noto CJK 字体、Python venv 和固定 `pypdf==6.1.1`；进程以 `node` 非 root 用户运行，Tini 转发停止信号。
- 活动数据库和所有资产保存在专属 Docker named volume `storyflow-local-data`；容器内路径 `/data/storyflow`。不把 SQLite WAL 绑定到 SynologyDrive、iCloud、Dropbox、SMB/NFS 或 Git 工作目录。
- Mac 原生默认数据路径是 `~/.local/share/storyflow`，与仓库、旧项目和容器卷分离。迁移必须使用本项目备份/还原命令。
- 提供商密钥只存在本机 `.env` 或运行环境中，不进入镜像、Git、审稿页或备份。缺少密钥仍可打开工作台与审稿；真实生成需要相应配置及界面审核/任务门禁。
- 首次启动通过界面设置管理员密码，或以 `STORYFLOW_ADMIN_PASSWORD` 初始化。密码须至少 12 字符；已存在管理员时环境变量不覆盖密码。

## Mac 原生运行

安装 Node 22、FFmpeg、Python 3、Chromium（或 Chrome）后，在仓库根目录执行：

```sh
npm ci
cp .env.example .env
python3 -m venv .venv
.venv/bin/pip install pypdf==6.1.1
```

在 `.env` 中设置 `PYTHON=.venv/bin/python`。`STORYFLOW_DATA_DIR` 留空使用上述默认路径；不要指向当前同步仓库。按需填写图片、Opus、Seedance、fal 的独立凭据，不复制旧项目配置包。

```sh
npm run doctor
npm run check
npm run build
npm start
```

浏览器访问 `http://127.0.0.1:18296`。开发热更新另开终端执行 `npm run dev:ui`；API 仍通过 `npm run dev` 启动。生产模式也运行同一 Node API，仅使用 `dist/` 静态页面。

`FFMPEG_PATH` / `FFPROBE_PATH` 与旧命名 `FFMPEG` / `FFPROBE` 均支持，前者优先。未设置 `CHROMIUM_PATH` 时优先使用 Playwright 安装版 Chromium（`npx playwright install chromium`）；Mac 没有安装版时回退到已安装的 Chrome，也可显式设置 `STORYFLOW_BROWSER_CHANNEL=chrome`。`doctor` 只检查配置是否存在，不发送模型请求；它检查真实 Chromium PNG 渲染、SQLite WAL 读写和媒体工具。

## 本机 Docker

以下命令是启动说明，不代表已在当前机器执行。需要可用的 Docker Engine / Compose。Mac 可使用独立 Colima profile `storyflow`，建议 4 CPU、8 GiB 内存；不要复用原生产宿主。若已安装 Colima，可手动运行：

```sh
colima start --profile storyflow --cpu 4 --memory 8 --disk 60
docker context use colima-storyflow
docker compose build
docker compose up -d
docker compose exec storyflow npm run doctor -- --json
curl --fail http://127.0.0.1:18296/healthz
```

Compose 自动读取本目录 `.env`，只向容器传递配置文件里明确列出的应用变量；不会挂载 `.env` 或本机资料目录。容器固定使用镜像里的 Python、FFmpeg 和 Chromium，不继承 Mac 的二进制路径。需要换本机端口时设置 `STORYFLOW_PORT`，并同步调整 `PUBLIC_BASE_URL`。

```sh
docker compose stop
docker compose up -d --build
```

重建容器保留 named volume。**不要使用 `docker compose down -v`，该命令会删除工程与素材。** 本版本单进程、单管理员运行，同一个数据目录不允许启动多个实例。

## 停机备份

备份是包含审稿数据、管理员密码哈希和生成记录的私有归档，不是可公开分享包。它包含相对路径 `storyflow.sqlite`、`manifest.json`、`files/<sha256>`，以及确有图片任务归属的 `work/<job-id>/image-receipt.json`。这些图片回执是恢复已受理任务所需的持久证据，不能当渲染缓存丢弃。归档不含 `.env`、提供商密钥、原始宿主路径清单、其他 `work/` 渲染缓存或历史还原目录。数据库内部可能含用户录入内容及供应商回执，因此归档不能公开上传。

先停止服务，再运行备份。CLI 与运行服务使用同一独占锁，运行中调用会明确拒绝。备份做 WAL checkpoint、SQLite `VACUUM INTO` 一致快照、完整性检查和全部资产／图片回执的 SHA-256 校验，再写入新的 `.tar`；已有归档不覆盖。数据库 schema 2 保留逐次意见与关联任务的审核历史，旧 schema 1 由启动迁移兼容。未完成图片任务标明已有供应商回执却找不到文件时，备份会拒绝，避免交付一份无法安全续作的数据。

原生模式：

```sh
# 先在运行 npm start 的终端按 Ctrl-C，并等待进程结束。
mkdir -p "$HOME/.local/share/storyflow-backups"
npm run backup -- --output "$HOME/.local/share/storyflow-backups/storyflow-2026-10-10.tar"
```

容器模式：

```sh
docker compose stop
mkdir -p "$HOME/.local/share/storyflow-backups"
docker compose run --rm --no-deps \
  -v "$HOME/.local/share/storyflow-backups:/backup" \
  storyflow npm run backup -- --output /backup/storyflow-2026-10-10.tar
docker compose up -d
```

挂载的备份目录必须可被容器 UID 1000 写入；Mac Docker 虚拟化一般会处理主机目录映射。Linux 上由管理员创建对应权限，不以 root 重启应用来绕过权限。

两个 CLI 均支持 `--data-dir /本地数据目录` 覆盖环境配置。`backup` 必须提供 `--output`，`restore` 必须提供 `--input`；其他未识别参数直接报错。归档必须位于目标数据目录外，不允许把正在维护的目录同时当作归档路径。归档文件权限为 `0600`；备份目录本身的访问权限仍由宿主管理。

## 还原与回退

先保留当前数据的备份，停止服务。还原默认只接受空目标；已有数据时必须显式 `--replace`。还原会先在暂存目录验证归档路径、普通文件类型、数据库完整性、所有文件哈希和数据库资产清单，再替换数据。拒绝路径穿越、符号链接、硬链接、重复文件和归档外内容。上限为 100000 个资产和 100000 个图片回执、普通单文件 8 GiB、每份图片回执 64 MiB、归档解包总量 256 GiB。图片回执还核验数据库中的图片任务归属；不接受任意 `work/` 文件。

```sh
npm run restore -- --input "$HOME/.local/share/storyflow-backups/storyflow-2026-10-10.tar" --replace
npm start
```

```sh
docker compose stop
docker compose run --rm --no-deps \
  -v "$HOME/.local/share/storyflow-backups:/backup:ro" \
  storyflow npm run restore -- --input /backup/storyflow-2026-10-10.tar --replace
docker compose up -d
```

还原成功后必须重新登录；旧会话已清除，管理员密码保留。旧数据库、WAL、资产和缓存保存在数据目录下 `.before-restore-<时间>-<ID>`，CLI 返回准确路径。验收成功后可在停机状态自行清理该目录；脚本不会自动删除旧数据。若需要回退，优先还原变更前的独立归档；不在运行中手动移动数据库文件。

供应商密钥和 base URL 必须另外恢复为该项目原配置。数据库保留任务 ID、prepared receipt 和受理不明状态；重启后按任务状态恢复查询，不因为还原而重复付费提交。`work/` 中除 `image-receipt.json` 外是可重建渲染缓存，已入库素材保留；本地未完成合成允许重新执行。已有图片回执的失败任务通过原任务重试，只恢复下载或画幅处理，不再提交生图。恢复时若非终态任务所需回执缺失，会在替换当前数据库之前拒绝。带上游任务句柄的任务继续查询，上游受理不明必须人工核对，不能直接重发。

## 锁与异常中断

`.storyflow-lock.sqlite` 是独立的 SQLite 独占进程锁，不是业务数据库。它在进程退出或 SIGKILL 后由操作系统释放，容器重启不会被过期 PID 阻挡。`.storyflow.lock` 仅包含 PID、主机、角色和启动时间，供诊断，不决定是否可以启动。

出现 `DATA_LOCKED` 时，先检查是否仍有 StoryFlow 服务、备份或还原进程在运行并正常停止。**不要删除或替换 `.storyflow-lock.sqlite` 来绕过锁**，那会产生两个不同 inode 上的“锁”，破坏互斥。无需“清理旧锁”命令；残留的诊断 JSON 会在下一次成功获取真正锁时更新。

## 未来 HTTPS 配置

真正配置 HTTPS 时须把 `PUBLIC_BASE_URL` 改成外部 HTTPS origin，重启应用并重新登录。会话 cookie 的 `Secure` 由此配置决定，同时始终使用 `HttpOnly`、`SameSite=Strict`、`Path=/`；域名使用 host-only cookie，不共享原项目登录。不能只在代理终止 TLS 而继续把应用的公开地址留为 HTTP。

`deploy/nginx/storyflow.conf` 是回环 HTTP 模板；`deploy/nginx/storyflow.https.conf.template` 是未来域名的完整 80→443 重定向与 TLS 反代模板，证书路径须由部署者准备，两者均未安装或启用。未来应在受控 TLS 入口代理到回环 API，并保留 Host / X-Forwarded-Proto；应用只信任回环代理。若将代理改为独立容器，不能直接把 `trust proxy` 放宽为信任任何客户端，应按实际网络边界单独配置。不要把本地开发入口或首次管理员设置接口直接开放公网。

## Docker 静态复核

- 构建与运行都使用 `node:22-bookworm-slim`，CI 使用 Node 22，符合 `node:sqlite` 与 Vite 的版本要求。基础镜像使用 22 系列标签，实际 patch 版本由 CI 构建记录确认。
- 镜像预先创建并交给 UID 1000 的 `/data/storyflow`；新的 named volume 使用该目录初始权限。已有且权限错误的外来 volume 不自动递归改权，避免误接旧服务数据。CI 检查非 root 写入、删除容器、重建容器后的持久性。
- Chromium 由 Debian 安装，Playwright 使用 `CHROMIUM_PATH`，不额外下载运行时浏览器。当前 Playwright 的 `chromiumSandbox` 默认关闭，避免 Docker 未开放用户命名空间时启动失败。渲染器只加载项目自己序列化的 SVG/字幕，禁止网络请求和模型任意脚本；进程仍受非 root 容器与 `no-new-privileges` 约束。这里不宣称启用了 Chromium 自身的 OS sandbox。
- Docker 与 CI 均安装 `fonts-noto-cjk`；字幕渲染优先使用 `Noto Sans CJK SC`，并等待 `document.fonts.ready`。容器里的真实中文字体绘制仍需 CI/镜像运行结果确认，Mac 的字体环境不替代 Debian 验证。
- `/tmp` 为临时内存文件系统，渲染缓存位于 named volume 的 `work/`；`shm_size` 为 256 MiB，并使用 Chromium `--disable-dev-shm-usage`。

## CI 与验收状态

GitHub Actions 定义了两条检查：

1. Node 类型检查、单元/真实媒体测试（含完整1080P竖屏）、前端构建及 Playwright 交互测试。
2. 构建独立 Docker 镜像，确认非 root、媒体依赖、健康接口，并通过删除/重建容器验证专属卷持久化及锁恢复。

CI 不使用提供商密钥，不执行付费模型生成，不推送镜像，也不部署生产。工作流文件存在不等于 CI 已通过；真实 Docker 构建、容器验收、真实模型成片及内容验收分别记录。

### v0.1 的2026-10-10本机执行记录（历史）

| 检查 | 结果与范围 |
| --- | --- |
| `npm run doctor -- --json` | 通过；Node 22.23.1、FFmpeg/FFprobe 8.1.2、Python 3.9.6 + 本机 pypdf 6.14.2、SQLite WAL 读写、非同步数据目录、Chrome 154 的 PNG 渲染。镜像固定的 pypdf 6.1.1 已在首轮 CI 容器 doctor 通过。 |
| `tests/maintenance.test.ts` | 5/5 通过：互斥、SIGKILL 释放、运行中拒绝/停机恢复/会话清除、篡改拒绝、路径穿越与符号链接拒绝。 |
| 实际 npm 维护命令 | 临时独立目录完成 backup → 空目录 restore → `--replace` restore，业务值保持；只用本地 fixture。 |
| 完整竖屏媒体合成 | 新增实际 1080×1920、25fps、60 秒测试通过：1500 帧、AAC 时长 60 秒、音画起点偏差 0、完整解码通过；中文字幕及图示通过输出像素检查。固定图层只渲染 1 张 PNG，其余帧硬链接复用。 |
| 完整媒体测试耗时 | 本机底片准备 1.26 秒、合成 16.11 秒、全部校验合计 18.89 秒；临时目录在测试后删除。此值不是 CI/生产性能承诺，未涉及模型生成。测试超时 10 分钟，CI test job 上限 45 分钟包含依赖安装与其他测试。 |
| HTTPS cookie 配置 | 临时 API 以 HTTPS canonical URL 启动，核验登录响应包含 Secure / HttpOnly / SameSite=Strict / Path=/；不连接公网。 |
| 配置静态检查 | Compose / CI YAML 解析通过；named volume 和回环监听断言通过；Python 脚本编译及维护模块严格 TypeScript 检查通过。 |
| Docker / GitHub CI | 本机未安装 Docker；[首轮 GitHub CI](https://github.com/jodancain/storyflow/actions/runs/37977592720) 的 test/container 均成功，包含实际Docker构建、非root doctor及容器重建持久卷。当前提交新增工程/素材重建检查，以对应Actions结果为准。未进行生产操作。 |
| 模型接口 | Doctor 仅查看是否配置；本轮维护验证没有实际模型提交或付费调用。 |


## v0.2 图片配置与静态审稿交付

图片供应商使用独立的 `IMAGE_BASE_URL`、`IMAGE_API_KEY`、`IMAGE_MODEL`。base URL 应与供应商OpenAI兼容路径一致（需要时包含 `/v1`），不要填到 `/images/generations` 完整端点。默认请求模型名为 `gpt-image-2`，能力接口只返回是否配置及模型名，不返回密钥。实际模型身份取自回执，未回传时保持未知。

工作台图片请求由持久队列处理，用户关闭页面不取消已提交任务。受理不明时先核对原请求；下载失败可从持久化响应恢复，不再POST。批量接口上限52项是防误操作边界，不是每次新工程都自动获准调用52次。

构建命令同时生成 `dist/` 和 `dist-review/`。未包含交互审稿组件的构建不能作为完整快照交付。已登录管理员可用 `/api/projects/:id/review-snapshot` 导出固定公开包，其中只有页面和被允许展示的图片；上传静态托管时以整个包为单位更新，并在覆盖前备份旧页面。不要把整个数据卷、工程ZIP或数据库放到公网。

源代码ZIP是另一台Mac继续开发的包；工程ZIP是私有数据迁移包；审稿快照ZIP是供发布/查看的安全展示包。三者用途不同，文件名和清单不能混用。

本轮默认不部署 `storyflow.yundongyl.cn`，不改DNS、不安装本机Docker。既有V6静态页发布只影响其独立目录。新Mac启动、Docker构建、CI与真实公网发布仍分别记录证据；模型候选成功不等于医学内容或完整影片验收通过。


## v0.3 在线审图配置

在线审图默认关闭。只有 `STORYFLOW_PUBLIC_REVIEW_PROJECTS` 中明确列出的工程能够匿名读取安全审图快照；完整工程、原照、人工审核意见、模型回执和提交任务接口仍需管理员会话。单个工程公开后，允许展示的 AI 候选图会随任务完成更新。被声明为指定人物原照的源文件及同内容哈希副本始终排除，即使文件曾带有公开标记。

先在本机启动应用、导入工程并取得工程 ID，再按实际部署位置配置。以下只是配置示例，不执行 DNS 或上线操作：

```dotenv
PUBLIC_BASE_URL=https://storyflow.yundongyl.cn
STORYFLOW_ADMIN_PASSWORD=<至少12字符的独立审核密码>
STORYFLOW_PUBLIC_REVIEW_PROJECTS=<允许公开审稿的工程UUID>
STORYFLOW_PUBLIC_REVIEW_API_BASE=/api
```

多个工程 ID 使用英文逗号分隔，不支持通配符。密码只用于首次初始化；已有管理员时不会被环境变量覆盖。启用公开工程但尚未创建管理员且未提供有效初始化密码时，服务拒绝启动，避免把首次设置入口暴露到公网。共享页面中的“登录审核”使用同源会话，分享 URL 不携带密码或生图凭据。

独立域名可访问 `/review/<project-id>`。页面请求 `/api/public-review/<project-id>` 获取安全快照，并通过受保护的 `POST /api/projects/<project-id>/review-submissions` 提交意见。通过只批准所审图片；不通过必须填写修改意见，提交后每目标最多建立一个返修任务。缺配置、未批准角色基准、既有进行中任务或受理不明时，意见仍保存并显示阻塞原因，不伪造排队或生成结果。相同提交标识重复请求会返回原记录。

若将审图后台接在既有云动域名的独立反向代理路径下，可设置：

```dotenv
PUBLIC_BASE_URL=https://yundongyl.cn
STORYFLOW_PUBLIC_REVIEW_API_BASE=/storyflow-review/api
```

此时代理须将外部 `/storyflow-review/api/...` 映射到应用的 `/api/...`，并把相应页面入口映射到 `/review/<project-id>`；该变量只告诉浏览器使用哪个同源 API 路径，不自动创建代理路由。保留 `Host` / `X-Forwarded-Proto`，使用 HTTPS origin 以启用 Secure cookie。完整工作台和静态审稿包不必随之公开；不要把原视频 API 或数据目录复用为本应用的审图后端。

公开快照 ZIP 仍是离线展示包，默认没有在线连接。要让既有链接可提交，必须实际配置后台与同源路由，并用在线页面或带对应在线配置的安全页面替换该入口；仅复制 ZIP 不会产生审核服务器。上线后分别核验匿名只读、登录提交、原照不可访问、断网重试不重复任务和服务重启后的恢复。本版本源码检查与本机模拟测试不替代这些生产验证。
