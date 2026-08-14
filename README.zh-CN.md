# DSH Doctor

[DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 的确定性诊断与恢复工具。

DSH Doctor 是 Harness「把自己改坏」两种典型情况的安全网：**开得了但无法对话**（WebUI 能打开但对话循环坏了），以及**根本起不来**（改了配置、依赖或插件后启动失败）。WebUI 还能打开时，Doctor 按钮调用仅限本机访问的 Host 救援服务；Harness 起不来时，同一套引擎以独立 CLI 运行——包括捕获启动失败的启动探针，和「一键恢复到最近健康检查点」的重置，让插件开发者可以放心折腾、随时回到能对话能用工具的状态。

> DSH Doctor 0.2.0 面向 `@deepseek-ai/dsh 0.1.0-rc.6`。DeepSeek Harness 仍处于 Developer Preview；遇到未知版本时，Doctor 只做保守的只读诊断。

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
- 设置中的完整 Doctor 页面，用于查看问题、检查点和回滚；
- 页面框架层的应急浮标入口：profile 出问题时自动出现，不依赖侧栏与对话插件是否存活。

如果 WebUI 无法启动：

```bash
npx dsh-doctor recover --profile web
```

## CLI

```bash
# 扫描一个 profile（默认离线、隐藏绝对路径）
npx dsh-doctor scan

# 启动探针：判断 Harness 能否启动，并从启动输出诊断失败原因
npx dsh-doctor boot

# 一键恢复：配置重置到健康检查点、对齐依赖，并再次验证能否启动
npx dsh-doctor recover --profile web
npx dsh-doctor recover --profile web --yes   # 同时执行需确认的动作

# 把当前 profile 快照为健康恢复基准
npx dsh-doctor checkpoint --profile web

# 启动 Harness；启动失败时自动诊断（--auto-recover 会修复并重启一次）
npx dsh-doctor launch --auto-recover

# 回滚检查点
npx dsh-doctor rollback <checkpoint-id>
```

`recover` 零确认执行安全动作，之后在 Harness 原本未运行时用启动探针验证结果。仍有 Error 或启动验证失败时退出码为 `1`；Warning 默认返回 `0`，`--strict` 时返回 `1`；参数或内部错误返回 `2`。`--json` 输出机器可读结果。

## v0.2.0 检查内容

- Node、操作系统、Harness 版本和 profile；
- profile manifest、bundle 列表、`cordis.yml`、`cordis.patch.yml`、pnpm workspace 的语法与权限；
- 缺失依赖、重复 bundle 和损坏链接；
- 从 WebUI 调用时的 Cordis 插件运行阶段；
- 启动失败：真实启动探针（端口监听 + 捕获输出并映射为修复动作）；
- 会话记录（`session.jsonl.zstd`）与 storage 缓存的完整性；
- 本地近期日志中的 fatal/plugin failure 标记；
- 非 registry 和外部插件来源（仅提示，永不阻塞恢复）；
- 模型路由/凭据状态，以及验证模型真实应答的极小非会话请求。

## 恢复

每次修改都遵守同一事务：

1. 重新检查修复计划是否过期，并核对 profile 文件哈希。
2. 创建仅本机可访问的修复前检查点。
3. 只执行用户选定的动作。
4. 重新运行完整结构检查（Harness 原本未运行时追加启动验证）。
5. 验证失败时自动回滚。

一键安全动作包括准备 Doctor 状态，以及**把 profile 配置整体重置到最近健康检查点**。冷启动（还没有健康检查点）时，Doctor 可以在明确确认后合成最小合法配置文件，损坏的原文件保留在修复前检查点里。安装依赖、禁用导致启动崩溃的插件、隔离损坏的会话文件、重新启用被 Doctor 禁用的插件都需要确认。Doctor 拒绝禁用连接、布局、设置、对话、运行时、模块加载器以及 Doctor 自身入口。

检查点位于 `$DSH_HOME/doctor/checkpoints/`，每个 profile 保留最近 10 个，且最新的健康检查点永不被清理。为了精确回滚，检查点可能包含本地配置文件的原始副本，但绝不会进入诊断报告或上传。Doctor 不显示、不修改也不上传 API Key。

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
