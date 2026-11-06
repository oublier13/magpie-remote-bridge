# Magpie Remote Bridge

让 VS Code Remote-SSH 中的编程 agent 直接使用你本机的 Magpie 网关。模型供应商、订阅登录和上游密钥继续由本机 Magpie 管理，远端无需再安装或配置一份 Magpie。

从 [GitHub Releases](https://github.com/wkoa/magpie-remote-bridge/releases/latest) 下载 VSIX 安装包。本项目为独立社区插件，与 Magpie、Microsoft、Anthropic 或 OpenAI 无官方隶属关系。

默认连接本机 `http://127.0.0.1:3425`，在远端提供 `http://127.0.0.1:13425`。

```text
远端 agent（CLI / 支持自定义地址的扩展）
  → 远端 127.0.0.1:13425
  → SSH 反向转发
  → 本机带临时令牌鉴权的 API 代理
  → 本机 Magpie 127.0.0.1:3425
  → Magpie 已配置的模型和账号
```

## 安装和使用

1. 本机启动 Magpie，确保网关运行在 `127.0.0.1:3425`。
2. 在本机 VS Code 的扩展面板菜单选择 **Install from VSIX… / 从 VSIX 安装…**，选择 `dist/magpie-remote-bridge-0.1.1.vsix`。扩展应安装在本机；它通过 `extensionKind: ["ui"]` 明确运行在本机。
3. 使用 VS Code **Remote-SSH** 打开远端项目文件夹。
4. 命令面板执行 **Magpie: 连接本机网关到远端**。首次选择与当前工作区对应的 SSH Host。每个远端 authority 的选择会在本机记住。
5. 执行 **Magpie: 在远端启动 Claude Code** 或 **Magpie: 在远端启动 Codex CLI**。终端工作目录就是远端项目，文件操作和命令执行发生在远端。

Claude Code 会读取本机 `~/.claude/settings.json` 中指向当前 Magpie 网关的模型环境项，仅同步白名单中的模型字段。也可以执行 **Magpie: 选择远端 agent 的模型** 显式指定。Codex 首次启动需选择一个模型，使用 `-c` 临时指定独立 provider，不修改远端 `~/.codex/config.toml`。

这些启动命令要求远端已安装对应的 `claude` / `codex` 可执行文件。插件自动处理网关连接和启动参数，不负责安装 agent 本身。选择模型只影响之后启动的会话，不切换已运行会话，也不修改本机 Magpie 的模型选择。

## 其他终端和远端扩展

**Magpie: 打开预配置的远端终端** 创建一个新的远端终端，注入：

- `OPENAI_BASE_URL=http://127.0.0.1:13425/v1`、`OPENAI_API_KEY`。
- `ANTHROPIC_BASE_URL=http://127.0.0.1:13425`、`ANTHROPIC_AUTH_TOKEN`。
- `MAGPIE_BRIDGE_URL`、`MAGPIE_BRIDGE_TOKEN`。
- Claude 模型环境项（本机使用 Magpie 时），或你在插件中选择的模型。

只有支持这些环境变量的程序会自动使用它们。普通 OpenAI-compatible 程序可在这个终端中直接启动。Codex 需要使用插件专用的启动命令，因为单独设置 `OPENAI_BASE_URL` 不保证覆盖已有 provider 和登录配置。

已有的其他远端 VS Code agent 扩展，可以执行 **Magpie: 复制远端扩展接入信息**，将地址和临时 API key 填入它自己的自定义 provider 设置。这些扩展需要支持对应协议和自定义 endpoint。插件不读取或修改第三方扩展的私有配置，也不会影响已经打开的普通终端；终端环境不会注入远端 extension host。

## 命令

| 命令 | 用途 |
|---|---|
| Magpie: 连接本机网关到远端 | 检查本机网关，建立隧道，再从远端发起 HTTP 验证 |
| Magpie: 断开远端桥接 | 结束隧道、关闭代理、销毁插件创建的终端 |
| Magpie: 更改当前工作区的 SSH Host | 清除当前工作区的映射并重新选择 |
| Magpie: 打开预配置的远端终端 | 新终端自动携带网关地址和临时令牌 |
| Magpie: 在远端启动 Claude Code | 使用本机模型环境或显式选择的模型 |
| Magpie: 在远端启动 Codex CLI | 临时 provider + Responses API + HTTP/SSE |
| Magpie: 选择远端 agent 的模型 | 从本机 Magpie 实时模型目录选择 |
| Magpie: 检查网关与隧道 | 只读检查本机目录及远端到本机的 HTTP 链路 |
| Magpie: 复制远端扩展接入信息 | 地址及本次会话临时令牌复制到剪贴板 |
| Magpie: 设置本机网关密钥（可选） | 密钥保存在本机 VS Code SecretStorage |
| Magpie: 显示连接日志 | 查看连接错误，不记录提示词、响应正文或令牌 |

## 配置

所有配置使用本机 application scope，远端仓库的 `.vscode/settings.json` 无法设置本机 SSH 可执行程序。

```json
{
  "magpieBridge.gatewayPort": 3425,
  "magpieBridge.remotePort": 13425,
  "magpieBridge.sshHost": "my-server",
  "magpieBridge.sshPath": "ssh",
  "magpieBridge.sshConfigFile": "",
  "magpieBridge.model": "",
  "magpieBridge.autoConnect": false,
  "magpieBridge.autoReconnect": true
}
```

`sshHost` 是首次选择时的候选值；已保存的工作区映射优先。选错 Host 时执行 **Magpie: 更改当前工作区的 SSH Host**。SSH 配置中的 Include / Match / ProxyJump 仍由 OpenSSH 解析；列表只枚举主文件的普通 Host，其他别名手动输入即可。

修改端口、SSH 路径或 SSH config 后，手动断开再连接。多窗口连接同一个服务器时给各窗口选择不同的远端端口；当前版本端口配置为本机全局值，修改后仅影响新连接。

自动连接默认关闭。开启后，仅对已经明确选择并保存 Host 的可信 SSH 工作区生效。意外断线最多退避重连三次，保持当前代理和令牌；稳定一分钟后恢复重试次数。手动断开或重载窗口会撤销本次令牌，关闭插件创建的终端，下一次连接产生新令牌。

## 支持范围和前提

- 桌面版 VS Code 1.90+，本机 OpenSSH 8.7+，Remote-SSH；远端为 POSIX shell，有 `cat`、`printf` 和 `curl`。
- 本机能够 SSH 登录同一个远端用户。先通过 Remote-SSH 完成主机指纹确认；插件严格验证已知主机。macOS/Linux 支持安全输入框中的 SSH 密码、key passphrase 或 keyboard-interactive challenge；密码不落盘。Windows 暂时仅支持 key / ssh-agent 非交互登录。
- 使用独立 SSH 连接，继承 OpenSSH config（包括 ProxyJump、IdentityFile、Port 等），不依赖 Remote-SSH 私有 API。在 macOS/Linux 的私有临时目录创建本次连接专用的 control socket，连通性检测复用同一条认证会话，不复用其他软件的 SSH master。
- 服务器必须允许 remote TCP forwarding，且远端端口空闲。服务器 `GatewayPorts` 应为 `no`（默认）或 `clientspecified`；管理员强制 `yes` 可能扩大监听地址。
- API 白名单：`GET /v1/models`、`GET /v1/codex/models`，以及 `POST /v1/chat/completions`、`/v1/responses`、`/v1/responses/compact`、`/v1/messages`、`/v1/messages/count_tokens`、`/v1/embeddings`。
- 支持 HTTP 请求和 SSE 流式响应；不支持 WebSocket、Gemini 原生协议、文件上传和 Magpie 管理/登录接口。Codex 强制禁用 WebSocket。
- 本机模型与账号经网关共享；完整 agent 进程、会话、skills、MCP 和本机文件系统不会被迁移到远端。若需要“本机运行 agent，远端只执行工具”，那是另一层工具桥，不属于这一版。
- 远端已有 agent 配置、shell 启动脚本或组织策略可能覆盖继承的环境变量；这种情况下先排除对应冲突。

## 凭据处理

上游 API key / OAuth 登录始终留在本机 Magpie。插件不扫描 Magpie 的 providers、logins 或本机 agent 的认证文件。本机 Claude settings 只提取固定白名单模型字段。

远端得到一个随机 256 位的会话 capability，它只能通过插件代理访问上述模型 API。代理向本机 Magpie 发出的认证值默认是 `magpie`（Magpie 默认 loopback 模式）；如你的网关需要专用 key，可用可选密钥命令设置，key 仅保存在本机 SecretStorage 并由代理替换注入。

临时 capability 经 VS Code terminal env 或 SSH 标准输入传递，不出现在 SSH / Codex 命令参数或连接日志中。用户主动复制接入信息时它会进入本机剪贴板。该令牌仍允许消耗模型额度；远端管理员及同账户进程能读取终端进程环境，应只连接可信服务器。

SSH 密码通过 OpenSSH ASKPASS 与本机随机令牌保护的回环 IPC 传递；输入框收到的密码直接返回 SSH，不缓存、不保存。临时目录权限为 0700，只包含启动脚本与 SSH control socket，断开后清理。重连若需要认证会重新提示。

## 故障排查

- **本机网关不可用**：确认 Magpie 已打开、网关端口正确；执行诊断命令。
- **Permission denied / Host key verification failed**：先通过 Remote-SSH 确认目标用户与主机指纹；macOS/Linux 在插件的安全输入框完成认证。硬件触摸或特殊企业 MFA 流程仍可能需要额外配置。
- **remote port forwarding failed**：检查远端 13425 是否占用，以及 sshd 的 `AllowTcpForwarding` / `PermitListen`。
- **远端检测失败**：确认 Host 与当前 VS Code 工作区相同、远端存在 curl，且 shell 不会在非交互命令前后输出额外内容。
- **扩展仍要求登录**：确认使用了插件的专用启动命令；第三方扩展需要自己支持自定义网关。
- **无模型或模型不支持**：检查本机 Magpie 的模型目录与路由。目录检查不发起模型生成；实际模型可用性需运行一次 agent 会话验证。

## 开发、打包和验收

无 npm 运行时依赖，Node.js 20+ 和 Python 3 可运行：

```bash
npm run check
npm test
npm run package
```

F5 使用 `.vscode/launch.json` 启动本机 Extension Development Host，再通过 Remote-SSH 打开测试项目。测试覆盖代理鉴权、路由限制、SSE 流式、SSH readiness / 错误分支、凭据传递及 CLI 参数转义。网络测试只访问本机模拟服务，不消费模型额度。

真实远端验收：安装 VSIX → Remote-SSH 打开项目 → 连接桥接并观察远端 HTTP 200 → 选择模型 → 启动 agent → 要求 agent 读取远端项目内一个已知文件并运行 `pwd` → 断开桥接确认终端关闭、旧令牌失效。需要在你自己的服务器完成此项，自动化模拟测试不能代替真实远端验收。

公开的验证范围见 [验证记录](docs/VALIDATION.md)。原始机器报告、服务器地址和账号信息保留在本地，不随仓库或安装包发布。

参考：[VS Code Remote 扩展架构](https://code.visualstudio.com/api/advanced-topics/remote-extensions)、[OpenSSH](https://man.openbsd.org/ssh)、[Magpie 网关](https://usemagpie.ai/docs/start)、[Magpie 参考](https://github.com/yetone/magpie/blob/main/docs/reference.md)、[Codex 配置](https://learn.chatgpt.com/docs/config-file/config-reference)。
