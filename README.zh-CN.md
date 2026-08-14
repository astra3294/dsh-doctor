# DSH Doctor

[DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 的确定性诊断与恢复工具。

DSH Doctor 刻意独立于 Agent 对话循环。当 WebUI 还能打开但无法对话时，Doctor 按钮会调用仅限本机访问的 Host 救援服务，而不是向模型发送“请修复自己”。当 Harness 无法启动时，同一套修复引擎可以通过独立 CLI 使用。

> DSH Doctor 0.1.0 面向 `@deepseek-ai/dsh 0.1.0-rc.6`。DeepSeek Harness 仍处于 Developer Preview；遇到未知版本时，Doctor 只做保守的只读诊断。

[English](./README.md)

## 安装

把 Doctor 安装进 Web profile：

```bash
dsh plugin --profile web add dsh-doctor
dsh --profile web
```

一个 npm 包同时包含 Host 与浏览器部分，并在 WebUI 中提供：

- 侧栏设置旁边常驻的 Doctor 入口；
- Prompt 或 Agent 失败后，在输入框上方主动出现的恢复提示；
- 设置中的完整 Doctor 页面，用于查看问题、检查点和回滚。

如果 WebUI 无法启动：

```bash
npx dsh-doctor recover --profile web
```

## CLI

```bash
# 默认离线、隐藏绝对路径，扫描全部 profile
npx dsh-doctor scan

# 扫描一个 profile 并输出 JSON
npx dsh-doctor scan --profile web --json

# 执行安全修复，列出需要确认的动作
npx dsh-doctor recover --profile web

# 明确批准可逆的依赖修复
npx dsh-doctor recover --profile web --yes

# 回滚检查点
npx dsh-doctor rollback <checkpoint-id>
```

仍有 Error 时退出码为 `1`。Warning 默认返回 `0`，使用 `--strict` 后返回 `1`。参数或内部错误返回 `2`。

## v0.1.0 检查内容

- Node、操作系统、Harness 版本和 profile；
- profile manifest 与 bundle 列表；
- YAML/JSON 语法及文件权限；
- 缺失依赖、重复 bundle 和损坏链接；
- 从 WebUI 调用时的 Cordis 插件运行阶段；
- 本地近期日志中的 fatal/plugin failure 标记；
- 非 registry 和外部插件来源；
- 用户同意后，以极小非会话请求验证真实模型连接。

## 修复安全

每次修改都遵守同一事务：

1. 重新检查修复计划是否过期，并核对 profile 文件哈希。
2. 创建仅本机可访问的修复前检查点。
3. 只执行用户选定的动作。
4. 重新运行完整结构检查。
5. 验证失败时自动回滚。

一键安全动作包括准备 Doctor 状态，以及从最近的健康检查点恢复已确认损坏的文件。安装依赖或禁用失败的第三方插件必须再次确认。Doctor 拒绝禁用连接、布局、设置、对话、运行时、模块加载器以及 Doctor 自身入口。

检查点位于 `$DSH_HOME/doctor/checkpoints/`，每个 profile 保留最近 5 个。为了精确回滚，检查点可能包含本地配置文件的原始副本，但绝不会进入诊断报告或上传。Doctor 不显示、不修改也不上传 API Key。

参见[恢复矩阵](./docs/RECOVERY_MATRIX.zh-CN.md)和[安全策略](./SECURITY.md)。

## 开发

需要 Node 24 和 pnpm：

```bash
pnpm install
pnpm check
npm pack --dry-run
```

## 许可证

MIT
