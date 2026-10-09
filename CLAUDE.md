# Claude 开发入口

遵循本目录 `AGENTS.md`。先阅读 README、开发交接和本体方法文档。

Node 22／React 19／TypeScript；`npm ci` 后用 `npm run check` 验证。服务端 `npm start`，UI 开发另开 `npm run dev:ui`。媒体依赖用 `npm run doctor` 检查。数据路径由 `STORYFLOW_DATA_DIR` 配置，不写入仓库。

本项目为独立源码交付。未配置供应商时可完成本体编译、审稿和导入已有媒体流程。不得编造真实模型调用成功、自动重投受理不明任务、默认新增旁白或自行部署生产。
