# 生产性测试与放行规则

本规程采用其他项目已使用的独立运行清单、版本冻结、宿主复核、重启后读盘和失败保留方法。所有结果绑定实际源码、运行环境和证据；本机通过、隔离 Linux 运行、现有生产只读检查与正式升级分别记录。

## 三类环境

1. **本机隔离回归**：临时 SQLite、合成素材、loopback HTTP 供应商。可以真实运行 FFmpeg、强杀子进程和修改合成工程，不使用实际凭据。
2. **Linux 候选运行**：独立镜像名、容器名、named volume、loopback 端口。限制 CPU、内存和 PID；不挂载生产数据、密钥或 Docker 控制接口到应用。恢复操作只对候选卷执行。完成后只清理本次资源。
3. **现有公网只读**：HTTPS 页面、公开 API、媒体、Range、真实下载哈希、匿名浏览器和手机布局。不提交意见、修改批准或新建付费任务。反向代理返回404的管理路由不能当作API鉴权401，也不能因其被阻断而认定越权。

生产升级不属于测试脚本的副作用。真实供应商和人审状态另列；模拟接口成功不能改写医学审核、声音批准或影片观感结论。

## 固定验收矩阵

| 门槛 | 必须提供的证据 |
|---|---|
| 源码与构建 | 提交号或候选逐文件清单；类型检查、两套前端构建、核心测试、浏览器测试；不能用旧日志代替 |
| 意图与重启 | 真实进程在准备后、POST已受理但回执未到、持久handle后查询中、下载中被SIGKILL；独立供应商ledger证明没有重复POST |
| 取消与并发 | 媒体探测、音轨提取期间取消不发布候选；旧修订不能覆盖新编辑；审核/选用与生成条件分别绑定 |
| 数据维护 | 运行中拒绝备份/还原；新卷恢复后文件SHA一致、旧登录失效；还原及显式回滚中断后不创建空库、不静默覆盖 |
| 访问范围 | 匿名管理访问、伪造cookie、私有原照、非白名单项目、跨站写入、登录限流；记录每次实际状态 |
| 媒体 | 合成fixture通过实际管线输出24/25fps精确60秒；1080×1920/1500帧、字幕、音轨、完整解码、缺料拒绝 |
| Linux编辑器 | 从固定Dockerfile实际构建，非root、只读根目录、无外网、无凭据运行sandbox_smoke；secret/proc/输入写入/网络/进程组逃逸拒绝 |
| 有限持续运行 | 单独候选实例的固定时长、固定请求预算、延迟分位数、RSS、容器退出/OOM/重启数；10分钟观察不等于长期无泄漏或容量SLA |
| 公网交付 | 当前页面/文件HTTPS、首尾Range与416、原文件哈希、播放和跳播、手机宽度；合成素材不冒充真实影片 |
| 交付 | ZIP从同一提交Git blobs创建，逐文件和SHA校验；CI及干净解压启动/测试；真实调用状态单列 |

## 执行

```sh
npm ci
npm run check
STORYFLOW_BROWSER_CHANNEL=chrome npm run test:ui
node --import tsx --test --test-concurrency=1 tests/process-recovery.test.ts tests/maintenance.test.ts tests/jobs.test.ts
docker build -t storyflow-editor:qa ops/editor
docker run --rm --network none --read-only --user 10001:10001 \
  --cap-drop ALL --security-opt no-new-privileges --cpus 1 --memory 768m --pids-limit 128 \
  --tmpfs /tmp:rw,nosuid,nodev,noexec,size=128m,mode=1777 \
  storyflow-editor:qa python3 /opt/editor/sandbox_smoke.py
```

专项命令用于定位，不必在全量已通过后无理由反复执行。`tests/process-recovery.test.ts`使用实际Node子进程、SQLite WAL和原生HTTP；父进程模拟供应商落盘请求ledger。它证明列出的应用恢复行为，不证明真实供应商幂等实现或物理机器断电。

GitHub CI同时构建主应用和独立编辑器；编辑器门槛没有模型凭据、不请求模型。不支持Landlock或固定依赖不可获取时应失败并保留原因，不能关闭安全边界让验收变绿。

## 还原中断处理（v0.4.1）

还原开始替换数据前，将原数据与新数据清单写入持久日志 `.storyflow-restore.json`。只要日志仍存在，服务、直接Store访问、备份和新的还原都会拒绝启动，避免在缺失数据库时初始化空库。

先停止所有使用该数据目录的StoryFlow进程并保留整个目录，再显式执行：

```sh
npm run restore -- --recover rollback --data-dir /实际数据目录
```

不得同时传`--input`或`--replace`。工具先核对日志完整性、路径、所有现场文件SHA及物理文件身份，再将原数据恢复原位。回滚保留原会话状态；新的待安装数据及恢复日志留在`.restore-*`供核查。回滚再次中断时，可以在完整核对后继续同一命令。

普通还原**成功**时，旧登录会话仍按原约定清除，原数据保留在`.before-restore-*`。这与失败后的回滚语义不同。没有日志的旧版中断现场、损坏日志、符号链接或被改写的数据会拒绝自动恢复；应离线检查备份及现场，不能删除日志强行启动。不提供猜测式“自动完成”。

## 结果纪律

每项保留`pass / fail / blocked / observed / historical`、时间、目标版本、实际值和原因。先前失败及修复后的回归同时保留。独立检查者从文件、数据库、HTTP或媒体重新读回，不能只接受执行代理的一句“完成”。认证cookie、密钥、原照、供应商原始回执及私有运行记录放在忽略的私有证据目录，不进入仓库或源码包。
