# 故障模式目录（Failure Patterns Catalog）

> Doctor 的「进化回路」输入：从 DeepSeek Harness 官方讨论区、生态仓库、社区博客与 npm 生态中采矿，
> 每条模式 = 社区信号 → 症状 → 根因 → Doctor 对策（检测/修复/提示）→ 状态。
> 状态：`已覆盖`（Doctor 已实现）/ `计划`（列入后续计划）/ `仅提示`（只能人话解释，无法程序检测）。

## A. 启动失败类（Boot failures）

### A1. 全局安装导致依赖闭包断裂（cordis-plugin-timer / 约 88 个包找不到）
- 来源: https://github.com/deepseek-ai/deepseek-harness/discussions/55 · https://github.com/deepseek-ai/deepseek-harness/discussions/204
- 症状: `pnpm add -g @deepseek-ai/dsh` 后 `dsh --version` 正常，但启动即崩：`ERR_MODULE_NOT_FOUND: Cannot find package '@deepseek-ai/cordis-plugin-timer'`；另一例全局 pnpm 安装后约 88 个插件包无法解析
- 根因: pnpm 全局安装不提升（不 hoist）依赖树，cordis loader 期望扁平 node_modules 解析
- Doctor 对策: 检测「dsh 是全局安装 + 启动时插件包解析失败」→ 提示改用 `npm install -g` / `npx`，并列出缺失包名（boot 探针已能捕获 ERR_MODULE_NOT_FOUND；补安装方式检测）（计划）
- 优先级: 高 · 状态: 计划

### A2. Node 版本不满足 engine 要求（zstd 导出缺失 / 启动卡死）
- 来源: https://github.com/deepseek-ai/deepseek-harness/discussions/100 · https://github.com/deepseek-ai/deepseek-harness/discussions/111 · https://github.com/deepseek-ai/deepseek-harness/discussions/43
- 症状: `node:zlib does not provide an export named 'createZstdDecompress'`（Node 22.14 < 22.19，`session-persistence-jsonl` 用到 22.19 才有的 API）；macOS Beta + Node 25.9 启动直接卡住；pnpm install 出现 engine/platform WARN
- 根因: dsh engine 要求 `^22.19.0 || >=24.0.0`，越界版本静默失败或挂起；native 模块平台不匹配
- Doctor 对策: 环境预检新增「Node 版本区间校验」issue（`NODE_VERSION_UNSUPPORTED`）：低于下限报 error、高于已知测试范围报 warning，并提示推荐版本（计划）
- 优先级: 高 · 状态: 计划

### A2b. 原生模块缺 prebuild（node-pty 加载失败）
- 来源: https://github.com/deepseek-ai/deepseek-harness/discussions/49 · https://github.com/deepseek-ai/deepseek-harness/discussions/177
- 症状: Arch Linux（Node 26.7）/ Ubuntu 26.04 上启动报 `Failed to load native module: pty.node ... Cannot find module './prebuilds/linux-x64//pty.node'`
- 根因: `node-pty` 没有当前 Node ABI 的 prebuild，npx 安装路径下未触发 node-gyp 编译，`dsh-subprocess-local` 加载失败拖垮整棵插件树
- Doctor 对策: boot 探针捕获 `pty.node` 加载失败 → 归类为「原生依赖环境问题」，提示 `npm rebuild node-pty` 或换官方支持的 Node 版本（计划）
- 优先级: 高 · 状态: 计划

### A3. `.env` 是个目录而不是文件（EISDIR）
- 来源: https://github.com/deepseek-ai/deepseek-harness/discussions/71
- 症状: 工作目录或 `~/.dsh` 下存在名为 `.env` 的**目录**时，每次启动都报 `failed to load .env: EISDIR`
- 根因: dotenv 加载器把 `.env` 目录当文件读
- Doctor 对策: 新增只读检查「`.env` 路径是目录」→ 警告并提示改名（计划）
- 优先级: 中 · 状态: 计划

### A4. 启动时终端被关 / 期望后台运行
- 来源: https://github.com/deepseek-ai/deepseek-harness/discussions/74 · https://github.com/deepseek-ai/deepseek-harness/discussions/50 · cnblogs 一键后台启停文章
- 症状: 关掉启动终端 WebUI 就掉；Windows 上 `dsh web` 会多出一个控制台窗口
- 根因: 前端进程是终端的子进程（设计如此），无内置 daemon 模式
- Doctor 对策: 仅提示——README/`launch` 文档化「后台运行」姿势（nohup/Start-Process/计划任务）（仅提示）
- 优先级: 低 · 状态: 仅提示

### A5. `--host 0.0.0.0` 被有意拒绝
- 来源: https://github.com/deepseek-ai/deepseek-harness/discussions/76
- 症状: `dsh web --host 0.0.0.0` 直接报错「intentionally not supported for safety: it would expose remote code execution」
- 根因: 安全设计，非 bug
- Doctor 对策: 仅提示——文档说明远程访问应走 SSH 隧道等方案（仅提示）
- 优先级: 低 · 状态: 仅提示

### A6. 端口被旧实例占用（EADDRINUSE）
- 来源: 用户本机实测（本次会话）；社区普遍存在
- 症状: `listen EADDRINUSE: address already in use 127.0.0.1:3080`
- 根因: 旧 Harness 进程未退出
- Doctor 对策: **已覆盖** —— `boot` 探针报 `PORT_IN_USE` 并给出占用端口；`launch` 可托管启动
- 优先级: 高 · 状态: 已覆盖

## B. 工作区 / 路径类

### B1. 工作区不支持中文路径（UTF-16 低字节 0x00 截断）
- 来源: https://github.com/deepseek-ai/deepseek-harness/discussions/47 · /107 · /151 · /210
- 症状: 含「开」(U+5F00)、「耀」(U+8000)、「言」(U+8A00) 等字符的路径被截断 → `workspace create failed: workspace-invalid-path / ENOENT`
- 根因: `win32-dialog-bindings.ts` 的 `readUtf16` 用「单字节是否为 0」判断字符串结束，这些汉字的 UTF-16LE 低字节恰为 0x00
- Doctor 对策: 新增检查「workspace 路径含低字节 0x00 的字符」→ 精确报出具体字符与目录，建议换目录（计划）
- 优先级: 高（中文用户群体大） · 状态: 计划

### B2. 选择磁盘根目录作为工作区 → 空标题 / EPERM
- 来源: https://github.com/deepseek-ai/deepseek-harness/discussions/65 · /143
- 症状: 选 `D:\` 或 `/` 后生成「空标题工作区」无法点击；`session.create` 报 `EPERM`
- 根因: `basename(根目录)` 为空字符串（上游 bug）；整盘符写入权限问题
- Doctor 对策: 检查 `storages/workspace.json` 中存在根目录工作区 → 警告并提供「隔离/删除该记录」确认级动作（计划）
- 优先级: 中 · 状态: 计划

### B3. Windows 目录选择器失败 / 后台弹出（koffi 缺失 + 窗口遮挡）
- 来源: https://github.com/deepseek-ai/deepseek-harness/discussions/30 · /38 · /92 · /37
- 症状: `directory picker failed: win32 folder dialog worker exited before reporting a result`；`Cannot find package '...\node_modules\koffi\index.js'`；Firefox/Edge 下对话框弹到后台（Brave 正常）
- 根因: ①全局安装布局下 `koffi` 原生 FFI 绑定不在 worker 解析位置 → worker 退出；②原生对话框 z-order 未置顶
- Doctor 对策: 检测 `koffi`/picker 依赖可解析性（缺失 → 提示重装依赖）；「对话框可能被遮挡，Alt+Tab 切换」作为已知 UI 问题提示（计划+仅提示）
- 优先级: 中 · 状态: 计划

## C. 会话 / 存储类

### C1. 会话归档后无法查看/恢复
- 来源: https://github.com/deepseek-ai/deepseek-harness/discussions/40
- 症状: 归档的会话在设置里找不到、无法恢复
- 根因: 产品功能缺口（归档入口与列表不完整）
- Doctor 对策: 仅提示（上游功能问题）——会话存储只读诊断已覆盖损坏检测，不越界（仅提示）
- 优先级: 低 · 状态: 仅提示

## D. 模型 / 配置类

### D1. Windows 快速模式调用 Linux 终端命令失败
- 来源: https://github.com/deepseek-ai/deepseek-harness/discussions/53
- 症状: `terminal inspection is unsupported on platform win32`（执行 `pwd && ls -la` 这类命令）
- 根因: preset 的默认命令集是类 Unix 的，与平台不符
- Doctor 对策: 仅提示——引导换用 PowerShell 命令或切换 preset（仅提示）
- 优先级: 中 · 状态: 仅提示

### D2. 工具调用返回大量参数错误 / Flash 模型 think 块异常 / 输出重复字符
- 来源: https://github.com/deepseek-ai/deepseek-harness/discussions/56 · /80 · /97 · /70
- 症状: 任意工具调用报参数错误；Flash 模型无限重复字符（如 `€鈹`）；`<think>` 块未折叠为思考区；轨迹有 ASSISTANT 但页面无输出
- 根因: 模型/呈现层兼容问题（多为上游 bug）
- Doctor 对策: 仅提示——live-probe 已验证模型连通时可排除「密钥/路由」类原因，指引用户到对应 discussion 或换模型（仅提示）
- 优先级: 低 · 状态: 仅提示

### D3. 模型一直连接不上（api.deepseek.com 网络失败，非密钥问题）
- 来源: https://github.com/deepseek-ai/deepseek-harness/discussions/175
- 症状: 配置好 key 后任何模型都失败，反复打印 `DeepSeek API request to https://api.deepseek.com failed` + 重试延迟
- 根因: 到 `api.deepseek.com` 的网络请求失败（连通性/代理/镜像），而非密钥本身
- Doctor 对策: live-probe/scan 增加「API 端点可达性探测」——把「网络不通」与「密钥错误」分开报（现有 live-probe 已能判密钥类失败码；补端点连通性检查与代理/镜像提示）（计划）
- 优先级: 高 · 状态: 计划

### D4. 子代理广度爆炸拖死 Web 服务端
- 来源: https://github.com/deepseek-ai/deepseek-harness/discussions/131
- 症状: 一次任务并行派生约 56 个子代理（继续嵌套），进程涨到 ~2.2GB、单核满载 20 分钟，`:3080` 完全无响应，只能杀进程；重启后「继续」仍复现
- 根因: `tool-subagent` 只有深度限制没有数量/并发上限，所有子代理与 web 服务端共享同一事件循环
- Doctor 对策: scan 增加「运行时健康」读数（当前会话/子代理数量、进程 RSS、事件循环延迟）→ 超阈值警告并提示配置并发上限；诊断「UI 无响应」时优先提示此模式（计划；读数来源需调研 Harness 内部服务）（计划）
- 优先级: 高 · 状态: 计划

### D5. 首次 npx 运行无进度反馈（8 分钟像卡死）
- 来源: https://github.com/deepseek-ai/deepseek-harness/discussions/176
- 症状: Windows 首次 `npx --yes @deepseek-ai/dsh web` 约 8 分钟无任何进度输出，用户误以为卡死杀进程
- 根因: 首次需下载依赖并构建，但无阶段性进度；慢网络（国内）下体验极差
- Doctor 对策: 仅提示——README/`launch` 文档化「首次运行需数分钟」与镜像配置建议（仅提示）
- 优先级: 低 · 状态: 仅提示

### D6. 全局 core.hooksPath 冲突 / 构建缺 unrun
- 来源: https://github.com/deepseek-ai/deepseek-harness/discussions/139 · /43
- 症状: `pnpm install` root postinstall 报 `refusing to replace user-owned core.hooksPath`；`pnpm run build` 报 `Failed to import module "unrun"`
- 根因: 用户全局 git hooks 配置（如 Codex）与 lefthook 冲突；tsdown 缺可选依赖 unrun
- Doctor 对策: 仅提示（面向源码构建者而非终端用户）——环境预检可顺带报告 `git config --global core.hooksPath`（仅提示）
- 优先级: 低 · 状态: 仅提示

### D7. 远程/WSL 访问被安全策略拒绝（403 / --host 被禁）
- 来源: https://github.com/deepseek-ai/deepseek-harness/discussions/128 · /76
- 症状: WSL/远程访问 `/api/host.listDirectory` 返回 403；`--host 0.0.0.0` 直接报错
- 根因: 非 loopback 暴露被有意禁用（防远程代码执行）
- Doctor 对策: 仅提示——引导 loopback + SSH 隧道（仅提示）
- 优先级: 低 · 状态: 仅提示

## E. 插件开发类（来自 Discussion #380，已逐条复核）

### E1. `link:` 本地插件解析不到 `@deepseek-ai/*`
- 来源: https://github.com/deepseek-ai/deepseek-harness/discussions/380（坑 1）
- 症状: dev 链接插件启动即 `ERR_MODULE_NOT_FOUND: Cannot find package '@deepseek-ai/schemastery'`；同一份代码发 npm 再装就正常
- 根因: Node 沿软链接真实路径向上找不到 `~/.dsh/profiles/node_modules` 扁平兜底目录
- Doctor 对策: 新增检查 `LINKED_PLUGIN_RESOLUTION`——对每个 `link:`/`file:` 依赖用 `createRequire` 实测能否解析 `@deepseek-ai/cordis`/`schemastery` 等，失败即报错并给出两种解法（①插件只 import node 内置 + ctx 服务 ②构建时把 peer deps 打进去）（计划）
- 优先级: 高（开发者画像核心痛点） · 状态: 计划

### E2. `inject` 写成对象 → 插件永远 pending
- 来源: https://github.com/deepseek-ai/deepseek-harness/discussions/380（坑 2）
- 症状: `dsh: 1 entry did not activate / my-plugin: pending (waiting for services: required, optional)`
- 根因: cordis 把对象的 key 当服务名，`{required, optional}` 被当成两个服务等不到
- Doctor 对策: **已覆盖检测**（`PLUGIN_RUNTIME_PENDING`）；补人话 hint：「常见原因：插件的 inject 写成了对象，应改为字符串数组」（hint 已就位，随 0.2.1 发布）
- 优先级: 中 · 状态: 已覆盖(补 hint)

### E3. 装了插件但没声明 `dsh.bundle` → 静默不生效
- 来源: https://github.com/deepseek-ai/deepseek-harness/discussions/380（坑 3）
- 症状: `dsh plugin add` 成功但插件毫无动静；夹在输出里的 warning「declares no dsh.bundle — installed as a plain dependency」
- 根因: 无 `dsh.bundle` 声明的包只当普通依赖，不挂载
- Doctor 对策: 新增检查 `INACTIVE_PLUGIN_DEPENDENCY`——profile dependencies 中存在「看起来像 dsh 插件（名字带 dsh/plugin 关键词）但未出现在 `dsh.profile.bundles`」的包 → 警告 + 人话解释（计划）
- 优先级: 高 · 状态: 计划

### E4. 包改名后 patch 里的 name 不同步
- 来源: https://github.com/deepseek-ai/deepseek-harness/discussions/380（坑 3）
- 症状: `plugin(s) failed to load: 旧包名; could not be resolved`
- 根因: `cordis.patch.yml` 的 `insert[].name` 是 loader import 的模块名，改名没同步
- Doctor 对策: 新增检查——patch 中 `insert[].name` 无法在 profile node_modules 中解析 → 报错并指出具体条目（计划）
- 优先级: 中 · 状态: 计划

### E5. 国内镜像只读 / `--otp` 交互导致发布失败
- 来源: https://github.com/deepseek-ai/deepseek-harness/discussions/380（坑 6）；本次会话实测（2FA + token 类型三连坑）
- 症状: registry 指向 npmmirror 时 publish 只读报错；2FA 下 CI 发布 404/EOTP
- 根因: 镜像只读；npm 11 弃用 `NODE_AUTH_TOKEN` 环境变量；Publish 型 token 在 CI 要 OTP
- Doctor 对策: 未来的 `doctor release` 发布前体检：registry 指向检查、token 类型提示、CI workflow 模板（远期计划）
- 优先级: 中 · 状态: 计划（远期）

## F. 生态信号（来源：awesome 列表与第三方插件，待四线采矿合并）

### F1. 生态雷达提供了「兼容性验证」的最佳实践
- 来源: https://github.com/AdamPlatin123/awesome-dsh-plugins
- 事实: 已索引 2513 个仓库、收录 750 个插件、94 个确认、59 个 K8s 运行级实测；每 8 小时自动发现，四维兼容检查 = **补丁格式 / seam 符号 / peerDeps / 编译**
- 含义: 社区大量插件的失败集中在「cordis.patch.yml 格式错」「seam 符号（inject 服务名）错」「peer 依赖版本对不上」「编译产物不对」四类——这与 Discussion #380 的六个坑高度吻合
- Doctor 对策: ①把四维检查固化进未来的 `doctor check-plugin`（发布前体检）；②把该雷达设为「采矿回路」的长期信号源，每 8h 的兼容矩阵 = 现成的故障样本库；③`check-plugin` 输出与其兼容（能被雷达/市场消费的机器可读报告）
- 优先级: 高 · 状态: 计划（远期）

（其余条目由四条并行采矿线结果填充）

## G. npm 生态 / 发布类

### G1. 官方内部子包 latest dist-tag 停摆（已实证）
- 来源: https://registry.npmjs.org/@deepseek-ai%2Fdsh-llm（实测 `latest=0.0.1-rc.1`，`next=0.1.0-rc.6`）
- 症状: 裸装 `@deepseek-ai/dsh-llm`/`-tools`/`-client-runtime` 等拿到远古 rc.1 → 与 rc.6 插件混装出双副本单例冲突
- 根因: rc 期间官方只维护 `next` 标签
- Doctor 对策: 检测 profile 内 `@deepseek-ai/*` 各包版本线不一致 → 警告并建议锁定 `0.1.0-rc.6`（计划）
- 优先级: 高 · 状态: 计划

### G2. Node engines 四分五裂
- 来源: npm registry 逐包核对（dsh-doctor>=24 / dsh-do>=22.19 / dsh-plugin-doctor>=20 / create-dsh-plugin ^22.19||>=24 / 核心未声明）
- 症状: 不同插件要求不同 Node 区间，用户装混后报引擎错误
- Doctor 对策: 环境预检统一按 Harness 引擎区间报告（已实现 `NODE_VERSION_UNSUPPORTED`），插件级差异并入 `check-plugin`（计划）
- 优先级: 中 · 状态: 部分覆盖

### G3. React 版本基线冲突（待复核）
- 来源: npm registry / 社区报告（dsh-do 疑捆 react^19，官方 UI 与 dsh-doctor 钉 react^18）
- 症状: 多插件混装时双 React 副本 → 界面异常
- Doctor 对策: `check-plugin` 检查 React peer 基线（待 tarball 复核后实现）（计划）
- 优先级: 中 · 状态: 计划

### G4. dsh.compatibility 字段不被核心消费（待复核）
- 来源: dsh-plugin-doctor README（声明约定），核心未实现校验
- 症状: 插件自称兼容某版本，但核心不校验，不兼容插件仍装入并崩溃
- Doctor 对策: `check-plugin` 实现兼容声明比对（peerDeps 三档 + 生态雷达矩阵）（计划）
- 优先级: 高 · 状态: 计划

### G5. 近名混淆
- 来源: npm（dsh-doctor / dsh-plugin-doctor / dsh-do / dsh-plugins）
- 症状: 用户装错包
- Doctor 对策: 仅提示——README 里加「认准 astra3294/dsh-doctor」（仅提示）
- 优先级: 低 · 状态: 仅提示

## H. 中文社区补充（博客矿线）

### H1. PowerShell 5.1 缺 Unix 工具 / 白屏 / 未选工作区发不出消息 / Python SDK id collision
- 来源: cnblogs foxcharon、locdd 80393、v2ex 1234341、discussion #712
- Doctor 对策: `PS_UNIX_TOOLS_MISSING`（已实现）；白屏→提示强刷清缓存（仅提示）；未选工作区→引导选择（仅提示）；`session id collision`→识别并给 workaround（计划）
- 状态: 部分覆盖

### H2. 强杀后消息丢失（200ms write-behind）
- 来源: discussion #483
- 症状: force-kill 重启后，最后一批输入/历史静默丢失（未 flush 的 write-behind 尾部）
- Doctor 对策: 检测非优雅退出痕迹（历史 run/进程状态）→ 提示「最近输入可能未持久化」+ 提供优雅停止姿势（`dsh-doctor stop`）（计划）
- 优先级: 高 · 状态: 计划

## 统计

- 四条矿线：官方讨论 15 + 生态仓库 15 + 中文社区 15 + npm 生态 10 = 55 条原始发现；去重后 ≈40 条独立模式
- 已覆盖（0.2.1 实现）：NODE_VERSION_UNSUPPORTED、DOTENV_DIRECTORY、PORT_IN_EXCLUDED_RANGE、PS_UNIX_TOOLS_MISSING、KOFFI_VERSION_RISK、UTF16_PATH_TRUNCATION、ROOT_WORKSPACE、LINKED_PLUGIN_RESOLUTION、INACTIVE_PLUGIN_DEPENDENCY、PATCH_NAME_UNRESOLVED、PATCH_PATH_NOT_URL、PLUGIN_PEER_MISMATCH、WEB_SKILL_DISABLED（13 条）
- 计划: A1、A2b、B3、D3、D4、G1、G4、H2、E1-E5 其余、F1
- 仅提示: A4、A5、C1、D1、D2、D5、D6、D7、G5 等

> 采矿时间：2026-08-15。Harness 版本窗口：0.1.0-rc.6。官方 Issues 未开放（Discussion-only）。
