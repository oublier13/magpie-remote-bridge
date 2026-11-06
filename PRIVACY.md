# Privacy / 隐私说明

Magpie Remote Bridge does not operate a cloud service and does not add analytics, advertising, or telemetry endpoints.

The extension connects an SSH workspace to the Magpie gateway running on your local computer. Model requests, prompts, tool definitions, and tool results sent by a remote client pass through the SSH tunnel and the local proxy into Magpie. Magpie and the model providers you configure determine the subsequent processing and retention of that content. Review their policies separately.

## 本机保留的信息

- SSH Host 与 VS Code 远端工作区标识的映射保存在本机 VS Code 扩展状态中。
- 模型选择、端口等偏好保存在本机 VS Code 设置中。
- 可选的 Magpie 网关密钥使用 VS Code SecretStorage 保存。
- 为保持模型选择一致，插件可以读取本机 Claude Code settings 中的固定白名单模型环境字段。

插件不导出 Magpie 的供应商配置或登录文件。SSH 密码通过安全输入框完成本次认证，不写入配置、文件或日志。

## 传输和会话

远端程序使用本次连接的临时令牌访问模型 API。临时令牌通过终端环境或 SSH 标准输入传递；用户执行“复制远端扩展接入信息”时，该令牌会进入本机剪贴板。远端管理员及同账户进程可能读取进程环境，因此应仅连接可信服务器。

本机代理只公开 README 中列出的模型 API，过滤管理路由及转发身份头。SSH 主机名和连接错误可能出现在本机输出面板中；插件不记录模型请求/响应正文或认证令牌。

断开桥接会关闭会话代理、插件创建的终端、SSH 隧道并清理生成的临时认证辅助文件。已保存的偏好、Host 映射与可选网关密钥可通过 VS Code 的扩展状态/设置和密钥命令管理。

## 联系和问题

项目问题请使用 [GitHub Issues](https://github.com/wkoa/magpie-remote-bridge/issues)。请先删除日志中的主机、账号、路径、提示词和凭据，再提交问题。
