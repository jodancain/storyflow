# Claude 开发入口

遵循本目录 `AGENTS.md`。先阅读 README、开发交接和本体方法文档。

v0.4.0 先读 `docs/VOICE-FIRST-WORKFLOW.md`：脚本／资产审核、完整声音人审、同音轨医生口型、人工冻结输入后交给 `ops/editor/` 的Docker Claude Code实际后期，独立检查再审片。工作台还没有自动对接该独立编辑器。原生9Router请求 `ezr/claude-opus-5-5`，无auto/fallback；应用结构化输出与编辑器受限代码执行是两条边界。跨机器交付见 `docs/SOURCE-RELEASE.md`；源码ZIP从同一Git提交产生，不能携带原照、密钥、日志、会话或旧片授权。

Node 22／React 19／TypeScript；`npm ci` 后用 `npm run check` 验证。服务端 `npm start`，UI 开发另开 `npm run dev:ui`。媒体依赖用 `npm run doctor` 检查。数据路径由 `STORYFLOW_DATA_DIR` 配置，不写入仓库。

本项目为独立源码交付。未配置供应商时可完成本体编译、审稿和导入已有媒体流程。不得编造真实模型调用成功、自动重投受理不明任务、默认新增旁白或自行部署生产。


v0.2 已实现图片任务、候选审图与独立首帧绑定、共享静态审稿导出。先看 `docs/VERIFICATION.md` 区分真实图片、技术检查与人工定稿；示例不是已批准的影片。图片配置使用独立 `IMAGE_*` 环境变量。源码可带本次授权的医生 AI 派生图，原照仍禁止打包。既有静态页与未部署的独立应用是两个交付对象，不要混称已经上线整个应用。


v0.3 当前入口：`docs/REVIEW-WORKFLOW-v0.3.md` 与 `docs/IMAGE-CONSISTENCY.md`。图片下审核直接持久提交，拒绝意见一次最多新建一个返修候选；通过不自动修改视频首帧。角色依赖必须引用唯一批准基准，指定医生基准返修还需私有、已审核原照。示例旧图标记 legacy-unverified，不是已通过新一致性规则的产物。在线审稿需另行配置常驻服务、管理员及公开工程白名单；静态包不能假装在线。SQLite schema 2 完整备份保留必要图片回执，导入工程不会重放任务。
