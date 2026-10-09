# 映序 StoryFlow

面向故事化医学科普的独立制作应用：**需求 → 展开 → 审核 → 视频**。包含可运行的本体校验与编译、素材来源、逐镜审核、后台任务、候选成片与工程迁移。默认医学模板为 **60 秒／25fps／1500 帧／1080×1920**，也支持 24fps 项目。

本仓库与原视频工作台独立。未来地址是 `https://storyflow.yundongyl.cn`；本次交付只提供源码和部署模板，不配置 DNS、不部署生产、不调用付费生成。

## 在另一台 Mac 开发

支持 Apple Silicon 与 Intel。使用 Node 22.13+（建议 `.nvmrc` 对应版本），Python 3、FFmpeg 和 Chromium／Chrome。无需原项目目录、原电脑用户名或 Docker。

```bash
git clone git@github.com:jodancain/storyflow.git
cd storyflow
npm ci
python3 -m venv .venv
.venv/bin/pip install -r requirements.txt
cp .env.example .env
# .env 设置 PYTHON=.venv/bin/python；已安装 FFmpeg 时可保留默认命令名。
npx playwright install chromium
npm run doctor
npm run build
npm start
```

打开 `http://127.0.0.1:18296`，首次设置至少 12 位管理员密码。开发 UI 时保持 API 运行，在另一个终端执行 `npm run dev:ui`，打开 `http://127.0.0.1:18297`。修改服务端代码后重启 API。

媒体与 SQLite 默认写到 `~/.local/share/storyflow`，不在 Git 或同步盘内。可通过 `STORYFLOW_DATA_DIR` 更换为本机持久目录。不要把活动数据库放到 iCloud、NAS SMB 或其他同步目录。只能运行一个工作进程。

无模型凭据即可创建需求、解析资料、导入脱敏模板、编辑本体、查看框图、审核、导入已有视频／声音、合成和导出工程。模型任务明确显示“待配置”。配置方式见 [.env.example](.env.example) 和 [部署文档](docs/DEPLOYMENT.md)。密钥不进入浏览器、源码或项目包。

## 操作流程

1. **需求**：填写主题、受众、时长、画幅和医生方式。导入 ZIP、PDF、DOCX、文本及参考图。扫描 PDF 提示补充可读文本；不会编造 OCR 内容。
2. **展开**：导入狼疮 V6 示例或调用已配置的 Opus。编辑人物、关系、镜头、台词、医学来源和素材对应关系，运行校验与编译。可检索 PubMed／Wikimedia Commons 并登记来源；检索条目不等于已获成片使用许可或已下载素材。
3. **审核**：逐镜与逐素材保存意见。批准绑定当前内容哈希；相关修改自动使旧批准失效。图示和字幕有独立后期审核。导入的历史意见保留为待确认，不自动批准新工程。
4. **视频**：按当前审核快照提交全片或单镜。照片医生先生成原生声音，审核该音轨后交 fal OmniHuman 1.5 做口型。候选产物审核后选择入剪；最后统一合成字幕、图示和声音。素材不足会报出缺口，不循环或加速补齐。

原片、声音与来源哈希始终保留。单改字幕只需重新审核相关内容和合成，视频生成哈希不变。导入已有音轨并审核后，照片医生任务可直接复用同一音轨。平台无法自动判断医学正确性、嘴形自然度或叙事表现，最终内容仍须审片。

## 模型与执行边界

| 职责 | 当前实现 | 真实验证状态 |
|---|---|---|
| 故事／虚构医生视频与声音 | Seedance 中转适配器；文本或首帧；单段上限 12 秒 | 协议模拟通过；本次未真实调用 |
| 指定照片医生口型 | fal OmniHuman 1.5 队列；同一已审音轨；默认 1080p | 协议模拟通过；本次未真实调用 |
| 本体展开与后期图示 | Anthropic Messages 兼容 Opus 接口，结构化 JSON | 协议模拟通过；本次未真实调用 |
| 字幕／图示／剪辑 | Chromium 受限声明式绘制 + FFmpeg | 本地固定媒体实测；详见 [验收记录](docs/VERIFICATION.md) |

模型名由部署者按供应商实际可用名称配置。`OPUS_MODEL` 默认值仅是预设，不代表该账户已开通。Opus 输出不会作为任意 Python／JS／Shell 执行。当前 Seedance 只发送首帧；尾锚图是审稿目标，回执中明确标为未传入，不能称为完整动作控制。

所有外部提交先保存意图和请求哈希。重启续查已受理任务；受理不明时停止自动重投，可核对供应商任务 ID 后恢复。取消仅停止本地跟进，不能承诺供应商退款。后台执行不依赖浏览器保持打开。

## 文档与检查

- [本体方法与编译规则](docs/ONTOLOGY.md)
- [架构与维护交接](docs/HANDOFF.md)
- [API 契约](docs/IMPLEMENTATION_CONTRACT.md)
- [Docker／域名／备份恢复](docs/DEPLOYMENT.md)
- [示例与来源署名](examples/README.md)、[逐件参考素材许可](examples/assets/CREDITS.json)
- [代码验证与真实模型验收表](docs/VERIFICATION.md)

```bash
npm run check       # 类型、服务端/本体/恢复/真实媒体测试、前端构建
npm run test:ui     # 浏览器交互与真实临时 API 集成
npm run doctor     # 只显示依赖与凭据是否配置，不输出密钥
```

测试使用隔离临时目录、模拟供应商和合成媒体，不访问生产凭据、不生成付费影片。GitHub CI 运行这些检查及 Docker 构建，不含生产部署。

源代码包不包含 `.env`、指定医生照片、原始资料包、历史影片或私有运行数据库。请在新 Mac 通过资料导入重新载入，或使用私有工程导出／备份迁移。工程 ZIP 和备份可能包含你上传的私人资料，应自行妥善保管。
