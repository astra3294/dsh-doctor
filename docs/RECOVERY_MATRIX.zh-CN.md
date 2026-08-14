# 恢复矩阵

| 故障 | 检测方式 | v0.2.0 动作 | 是否确认 | 是否重启 |
|---|---|---|---|---|
| `package.json` / `cordis.patch.yml` / `cordis.yml` / `pnpm-workspace.yaml` / settings 无法解析 | YAML/JSON 解析器（及启动探针输出） | 从最近健康检查点整体重置全部配置；冷启动时合成最小合法文件 | 检查点重置无需确认；冷启动合成需确认 | 是 |
| 依赖缺失或链接损坏 | 包解析与链接目标（及启动探针输出） | 运行 profile 的 `pnpm install`；除非明确允许，否则保持离线 | 是 | 是 |
| 第三方 Cordis 插件失败 | Loader 实时快照（及启动探针输出） | 向 profile patch 追加 `disabled: true`（AST 合并，绝不字符串拼接） | 是 | 是 |
| 救援链路或核心插件失败 | Loader 实时快照 | 拒绝自动禁用，提供人工处理指引 | 人工 | 是 |
| 被 Doctor 禁用的插件 | patch 检查 | 从 patch 中移除禁用条目以重新启用 | 是 | 是 |
| 会话记录或 storage 缓存损坏 | zstd 头/大小探测、JSON 解析 | 改名隔离（可逆），不删除数据 | 是 | 是 |
| API Key 无效或缺失 | 模型/Agent 错误、路由探测、真实探测 | 引导模型设置；绝不读取或覆盖密钥 | 人工 | 否 |
| Harness 无法启动 | 启动探针（端口监听 + 捕获输出） | 把启动失败映射到上表对应行并修复；`recover` 修复后重新验证启动 | 随映射行 | 是 |
| WebUI 端口被占用 | 启动探针 | 报告冲突端口 | 人工 | 不适用 |
| Harness 版本不受支持 | 版本比较 | 只读报告，不执行修改 | 不可用 | 不适用 |
| Host 无法连接 | Doctor RPC | 复制 `npx dsh-doctor recover --profile web`（或 `dsh-doctor launch --auto-recover`） | 否 | 不适用 |

“已经恢复”代表结构检查通过，且 Harness 原本未运行时启动探针通过。真实模型请求会被单独询问；用户跳过时绝不会报告为验证通过。
