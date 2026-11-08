# 自动发布到 VS Code Marketplace 和 GitHub Releases

`.github/workflows/ci.yml` 的发布任务依赖完整测试矩阵。macOS、Linux、Windows × Node.js 22、24 六组检查全部通过后，主仓库 `main` 分支的 push 或手动运行才会进入发布任务。PR、其他分支、标签和 fork 不会发布。

发布使用官方 vsce 的 GitHub OIDC Trusted Publishing，不保存 PAT。每次上传本次测试提交构建出的 VSIX；如果 `package.json` 的版本已存在，`--skip-duplicate` 跳过重复上传。发布串行执行，安装包作为 Actions artifact 保留 14 天。

市场上传成功后，独立的 **Publish GitHub Release** 任务会等待市场版本可下载，再从市场下载实际发布的同一份 VSIX，核对扩展身份并生成 SHA-256，创建对应 `v<版本>` 标签和 GitHub Release。等待市场验证最多约 18 分钟；超时后任务会明确失败，可以重试。

只有 GitHub Release 任务获得 `contents: write`，市场发布任务仍使用只读仓库权限和 OIDC。重复运行会跳过附件齐全的 Release；如果上次只上传部分附件，则补齐缺失文件，不覆盖已有附件或改写历史标签。下载包和已有资产的摘要冲突时会拒绝发布。

## 一次性配置

1. 在 Marketplace 发布者 `wkoa` 的 **Trusted Publishing** 页添加 GitHub Actions 策略：仓库所有者 `wkoa`、仓库 `magpie-remote-bridge`、工作流文件 `ci.yml`（位于 `.github/workflows/`）、环境 `vscode-marketplace`。
2. GitHub 仓库的 `vscode-marketplace` Environment 只允许 `main` 分支部署。该环境名必须与工作流和 Marketplace 策略一致。
3. 配置完成后，将仓库 Actions 变量 `MARKETPLACE_PUBLISH_ENABLED` 设为 `true`。未开启时，CI 仍测试和打包，发布任务会跳过。

策略授权该仓库与工作流以发布者身份上传扩展，因此应由发布者所有者审阅确认。不要将令牌或本机账号信息写入工作流、仓库变量或日志。

## 每次发布

更新 `package.json` 与 `package-lock.json` 的版本，填写 Changelog，合并到 `main`。六组 CI 通过后自动发布到市场，再同步创建 GitHub Release，附件包括 `.vsix` 和 `.vsix.sha256`；无需手动上传。需要重试时，在 Actions 中手动运行 **Validate**，选择 `main`。重试时不需要修改版本号。

Marketplace 服务端验证和搜索索引更新发生在上传之后。应在发布日志及公开市场页面核对版本；日志中的已存在版本跳过不代表上传了新代码。同一版本的内容变更必须先升级版本号。

暂停自动发布：将 `MARKETPLACE_PUBLISH_ENABLED` 改为 `false`。撤销授权：在 Marketplace 删除相应 Trusted Publishing 策略。

官方参考：[发布 VS Code 扩展](https://code.visualstudio.com/api/working-with-extensions/publishing-extension)、[vsce Trusted Publishing](https://github.com/microsoft/vscode-vsce#trusted-publishing)。
