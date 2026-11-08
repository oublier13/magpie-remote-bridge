# 自动发布到 VS Code Marketplace

`.github/workflows/ci.yml` 的发布任务依赖完整测试矩阵。macOS、Linux、Windows × Node.js 22、24 六组检查全部通过后，主仓库 `main` 分支的 push 或手动运行才会进入发布任务。PR、其他分支、标签和 fork 不会发布。

发布使用官方 vsce 的 GitHub OIDC Trusted Publishing，不保存 PAT。每次上传本次测试提交构建出的 VSIX；如果 `package.json` 的版本已存在，`--skip-duplicate` 跳过重复上传。发布串行执行，安装包作为 Actions artifact 保留 14 天。

## 一次性配置

1. 在 Marketplace 发布者 `wkoa` 的 **Trusted Publishing** 页添加 GitHub Actions 策略：仓库所有者 `wkoa`、仓库 `magpie-remote-bridge`、工作流文件 `ci.yml`（位于 `.github/workflows/`）、环境 `vscode-marketplace`。
2. GitHub 仓库的 `vscode-marketplace` Environment 只允许 `main` 分支部署。该环境名必须与工作流和 Marketplace 策略一致。
3. 配置完成后，将仓库 Actions 变量 `MARKETPLACE_PUBLISH_ENABLED` 设为 `true`。未开启时，CI 仍测试和打包，发布任务会跳过。

策略授权该仓库与工作流以发布者身份上传扩展，因此应由发布者所有者审阅确认。不要将令牌或本机账号信息写入工作流、仓库变量或日志。

## 每次发布

更新 `package.json` 与 `package-lock.json` 的版本，填写 Changelog，合并到 `main`。六组 CI 通过后自动发布；无需手动上传 VSIX。需要重试时，在 Actions 中手动运行 **Validate**，选择 `main`。

Marketplace 服务端验证和搜索索引更新发生在上传之后。应在发布日志及公开市场页面核对版本；日志中的已存在版本跳过不代表上传了新代码。同一版本的内容变更必须先升级版本号。

暂停自动发布：将 `MARKETPLACE_PUBLISH_ENABLED` 改为 `false`。撤销授权：在 Marketplace 删除相应 Trusted Publishing 策略。

官方参考：[发布 VS Code 扩展](https://code.visualstudio.com/api/working-with-extensions/publishing-extension)、[vsce Trusted Publishing](https://github.com/microsoft/vscode-vsce#trusted-publishing)。
