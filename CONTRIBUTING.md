# 贡献说明

## 本地验证

使用 Node.js 22+ 和 npm；macOS/Linux 开发检查与远端适配器测试还需要 Python 3。项目保持 CommonJS JavaScript，没有运行时 npm 依赖，也不需要编译或打包前置步骤。侧边栏远端适配器仅依赖 Python 标准库。

```sh
npm ci
npm run check
npm test
npm run test:coverage
npm run package
```

安装包输出到 `dist/`。请不要提交本机配置、账号、密码、令牌、原始联调日志或 VSIX 文件。发布和安装扩展需要另外执行，不由检查脚本自动完成。

### 可选的官方 Codex 协议验证

默认测试使用本机模拟服务，不调用模型。额外提供真实官方二进制兼容检查，所有配置都位于临时 `CODEX_HOME`，不会读取或修改原有 Codex 认证文件：

```sh
MAGPIE_TEST_CODEX_BINARY=/absolute/path/to/codex node --test test/codex-remote.test.js
npm run test:codex-sidebar -- /absolute/path/to/codex
```

第一项覆盖真实配置 RPC 和恢复；第二项启动官方 app-server，经生产凭据 broker 向本机模拟 Responses 服务发送请求并读取固定 SSE 回复，检查新线程 provider 与令牌未落盘。不会调用真实模型、SSH 或外部 API。这些检查不能代替真实远端侧边栏 UI 验收。

## 模块边界

| 文件 | 职责 |
| --- | --- |
| `src/extension.js` | VS Code 命令、进度、状态栏、终端与通知 |
| `src/session.js` | 无 VS Code 依赖的连接状态机，拥有代理、认证辅助器和隧道 |
| `src/host-picker.js` | 工作区目标选择、取消交互和旧 Host 状态迁移 |
| `src/host.js` | 纯 SSH 地址解析和校验 |
| `src/config.js` | 本机设置快照与 SecretStorage 读取 |
| `src/log.js` | 已知凭据脱敏 |
| `src/cancellation.js` | 可及时结束的取消等待，保留迟到资源的清理路径 |
| `src/ui.js` | AbortSignal 与 VS Code 取消令牌互通 |
| `src/proxy.js` | 固定路由白名单、认证替换、HTTP/SSE 代理和模型目录查询 |
| `src/tunnel.js` | OpenSSH 参数、子进程、远端 HTTP/CLI 检查和取消清理 |
| `src/auth.js` / `src/askpass-client.js` | 本机安全输入框与 SSH ASKPASS 认证通道 |
| `src/agents.js` | 白名单模型导入与临时终端启动配置 |
| `src/codex-sidebar.js` | Codex 侧边栏凭据通道与会话/重连生命周期 |
| `src/credential-broker.js` | 仅通过私有 Unix socket 提供命令式凭据，无 TCP 监听 |
| `src/codex-remote.py` | Python 标准库远端适配器、官方配置 RPC、账户租约与逐字段恢复 |

状态机的连接阶段为选择目标、检查网关、建立 SSH、验证远端 HTTP 和已连接。意外断线进入重连，重连保留代理和令牌；手动取消、失败或释放扩展会撤销会话。异步步骤完成后必须再次确认会话仍有效，防止取消后恢复连接。

## 测试与翻译

- 状态机测试注入假隧道、可控时钟和本机服务替身，避免真实 SSH 登录。
- 入口测试使用 `test/helpers/vscode.js`，直接加载入口模块，代码覆盖率可以包含真实入口。不要读取开发者的真实 SSH 或模型配置。
- 仅适用于 POSIX 的 shell/ASKPASS 测试在 Windows 跳过。平台分支应单独测试。
- 界面用英文字符串调用 `t('…')`，简体中文放在 `l10n/bundle.l10n.zh-cn.json`。清单用 `%key%` 引用 `package.nls.json` 和 `package.nls.zh-cn.json`。
- 增加命令时同步清单和入口。新增源文件会自动纳入语法与翻译检查。

## 需要保留的安全约束

代理只监听本机回环，固定允许模型接口，过滤并替换认证头。远端只获取随机会话令牌，上游密钥保留在本机。令牌不得写入命令参数、日志或文件。SSH 必须验证主机指纹并使用回环反向转发。设置维持 application scope，密码只用于本次认证。任何改变这些约束的补丁都需要明确的负向测试。

## 真实远端验收

自动化检查不能证明所有 OpenSSH 配置、登录 shell 和 CLI 版本都兼容。发布前在可信测试服务器中验证安装、密码或密钥认证、远端模型目录、完整 agent 会话、取消连接、真实断网重连以及旧令牌撤销。将验证范围写入 `docs/VALIDATION.md`，不要提交服务器地址、账号或令牌。
