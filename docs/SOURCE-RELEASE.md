# 完整源码发布与跨 Mac 交付

完整包包括主应用、`ops/editor/`、两套锁文件、Docker／Compose、迁移、文档、测试及已有授权示例。源包不包含运行数据库、真实任务、会话、原始医生照片、影片或配置密钥。源码包和私有工程／数据库备份是不同交付物；迁移自己的媒体请另用应用导出或备份工具，私下传输。

## 从指定提交生成

在 Git 仓库中先完成检查与提交，再运行：

```sh
python3 scripts/package-source.py --commit HEAD --output-dir /tmp/storyflow-release-new
```

`--output-dir` 必须不存在。工具解析完整 commit，直接读取该提交的 Git blobs；工作区的改动、忽略文件和未跟踪文件均不进入 ZIP。不会自动提交、推送、调用模型或部署。若需要禁止某些私有原照的字节混入，可增加 `--deny-sha256-file /private/original-photo-hashes.txt`；该文件每行一个 SHA-256，不随包分发。

输出包含：

- `storyflow-source-<commit前12位>.zip`：唯一顶层 `storyflow/`，里面每个文件都来自同一提交。
- `SOURCE.json`：完整提交号、逐文件 Git blob／SHA-256／权限／大小及 ZIP 哈希，位于 ZIP 外，避免给“同一提交源码”混入额外文件。
- `COMMIT` 和 `SHA256SUMS`：提交号与 ZIP、清单的校验值。

工具拒绝链接、submodule、明显运行／凭据路径、真实私钥内容及配置的原照哈希，失败清理本次新建的输出目录，保留旧包。路径筛查不能识别所有伪装命名的私人内容；发布者仍须审查新增跟踪文件。已有 `examples/assets/generated/originals/` 是此前获准交付的 AI 产物原尺寸文件，不是指定医生原照，不能只按 `originals` 字样删除整个授权示例。

## 新电脑核验与启动

```sh
cd /path/to/downloaded-release
shasum -a 256 -c SHA256SUMS
unzip storyflow-source-<commit前12位>.zip -d /tmp/storyflow-clean
cd /tmp/storyflow-clean/storyflow
npm ci
npm run check
STORYFLOW_BROWSER_CHANNEL=chrome npm run test:ui  # 已安装系统Chrome时
```

原生依赖与启动步骤见 [README](../README.md#在另一台-mac-开发)。没有 Chrome 时按文档安装 Playwright Chromium；FFmpeg、Python 和 PDF 依赖也需要按说明配置。没有供应商凭据可以运行编译、审核与模拟测试。ZIP 不带 `.git`，仍可开发和测试；需要 Git 历史或再次从提交打包时 clone 私有仓库，核对 `COMMIT` 后 checkout 同一提交。

编辑器依赖 Linux 沙箱，在 Mac 上应使用 Docker 的 Linux VM；不能把 Mac 单元测试等同于真实 Landlock／seccomp 通过。此版本在 Linux amd64 做过真实运行，未据此宣称 Apple Silicon Docker 完成实测。先按 [编辑器指南](EDITOR-WORKER.md) 构建并执行沙箱烟雾，再配置任务和私有 key。

## Release 验收记录

每次 Release 另附 `ACCEPTANCE.json`，记录**该提交**的构建／测试、全新解压检查、源码逐字节一致性、GitHub CI 链接和已知边界。记录不能放入其自身已冻结的源码 ZIP 再改变 ZIP 哈希。版本发布不自动生产部署；保留原有 Release，不覆盖旧产物。

GitHub CI 不含私有凭据，也不运行付费模型。本版新包的模型能力来自已有影片的真实执行记录和当前离线回归，不能标成“本次重新做了一轮模型生成”。
