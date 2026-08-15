/**
 * Plain-language explanations for every diagnostic code, in both UI
 * languages. A Doctor report should never force a human to decode a code:
 * each finding carries its own "what this is / is it harmful / what to do"
 * sentence.
 */
export interface IssueHint {
  readonly en: string
  readonly zh: string
}

export const ISSUE_HINTS: Readonly<Record<string, IssueHint>> = {
  PROFILE_MISSING: {
    en: 'The profile folder is gone. Doctor cannot recover a profile it cannot see; recreate it or switch DSH_HOME.',
    zh: '这个 profile 文件夹不存在。Doctor 看不到它就修不了；重新创建 profile，或换一个 DSH_HOME。',
  },
  PROFILE_MANIFEST_MISSING: {
    en: 'The profile lost its package.json. Doctor can restore it from the last healthy checkpoint (one click).',
    zh: 'profile 的 package.json 丢了。点「恢复到健康状态」可以从健康检查点还原。',
  },
  PROFILE_BUNDLES_INVALID: {
    en: 'The plugin bundle list in package.json is malformed. Fix the list, or restore the file from a healthy checkpoint.',
    zh: 'package.json 里的 bundle 列表格式不对。手动改回，或从健康检查点还原该文件。',
  },
  DUPLICATE_BUNDLE: {
    en: 'The same plugin bundle is listed twice. Harmless to read, but Doctor can deduplicate it for you after confirmation.',
    zh: '同一个 bundle 被写了两遍。不影响诊断，但确认后 Doctor 可以帮你去重。',
  },
  PROFILE_JSON_INVALID: {
    en: 'package.json is not valid JSON, so the Harness cannot boot or read the profile. Restore it from the healthy checkpoint.',
    zh: 'package.json 不是合法 JSON，Harness 会因此起不来。点「恢复到健康状态」还原。',
  },
  CORDIS_PATCH_INVALID: {
    en: 'cordis.patch.yml cannot be parsed — a common cause of "Harness will not start". Doctor can restore it in one click.',
    zh: 'cordis.patch.yml 语法坏了，这是「Harness 起不来」最常见的原因之一。一键恢复即可还原。',
  },
  CORDIS_YML_INVALID: {
    en: 'cordis.yml cannot be parsed. This file is boot-critical; restore it from the healthy checkpoint.',
    zh: 'cordis.yml 语法坏了，这个文件影响启动。从健康检查点还原。',
  },
  WORKSPACE_YAML_INVALID: {
    en: 'pnpm-workspace.yaml cannot be parsed, which breaks dependency management. Restore it from the healthy checkpoint.',
    zh: 'pnpm-workspace.yaml 语法坏了，会导致依赖管理失效。从健康检查点还原。',
  },
  EXTERNAL_PLUGIN_SOURCE: {
    en: 'The patch references a URL or local source. If you wrote it yourself for development, ignore this; otherwise review it before repair.',
    zh: '插件补丁里引用了外部 URL 或本地路径。如果是你自己开发时写的，忽略即可；否则先检查再修复。',
  },
  NON_REGISTRY_DEPENDENCY: {
    en: 'A dependency comes from outside the npm registry (a local link, git, or file). This is normal while developing plugins locally — ignore it; it never blocks recovery.',
    zh: '有依赖不是从 npm registry 装的（本地 link、git 或 file）。本地开发插件时这完全正常，忽略即可，也不会阻塞任何恢复。',
  },
  PROFILE_DEPENDENCY_MISSING: {
    en: 'A declared dependency is not installed. Doctor can run pnpm install to reconcile it (asks for confirmation first).',
    zh: '有依赖声明了但没装上。确认后 Doctor 可以运行 pnpm install 帮你对齐。',
  },
  BROKEN_PROFILE_LINK: {
    en: 'A dependency link points at a folder that no longer exists. Dependency reconciliation can repair it after confirmation.',
    zh: '某个依赖链接指向的目录已经不存在了。确认后可以用依赖对齐修复。',
  },
  CONFIG_PERMISSION: {
    en: 'Doctor cannot read or write a config file, so recovery would fail. Fix the file permissions (or run as the owning user).',
    zh: '配置文件没有读写权限，Doctor 会修不动。请修复文件权限（或用正确的用户运行）。',
  },
  SETTINGS_INVALID: {
    en: 'The settings document is unreadable. Doctor can restore it from the healthy checkpoint; your API keys are never touched.',
    zh: 'settings 文档损坏无法解析。Doctor 可从健康检查点还原；API Key 不会被触碰。',
  },
  PLUGIN_RUNTIME_FAILED: {
    en: 'A plugin crashed while the Harness was running. After your confirmation, Doctor can disable it so the Harness starts again.',
    zh: '有个插件在运行时崩溃了。你确认后，Doctor 可以禁用它让 Harness 恢复。',
  },
  PLUGIN_RUNTIME_PENDING: {
    en: 'A plugin is stuck waiting for a dependency. Usually resolves by itself; if it persists, restart the Harness.',
    zh: '有个插件卡在等待依赖。一般自己会好；如果一直卡着，重启 Harness。',
  },
  MODEL_ROUTE_MISSING: {
    en: 'No model has been selected. Open Model settings and pick a provider and model.',
    zh: '还没有选择模型。去「模型设置」选一个 provider 和模型。',
  },
  MODEL_ROUTE_UNAVAILABLE: {
    en: 'The selected model route is not working. Open Model settings and pick a working provider/model.',
    zh: '当前选的模型路由不可用。去「模型设置」换一个可用的 provider/模型。',
  },
  CREDENTIAL_INVALID: {
    en: 'The model rejected the API key. Open Model settings and re-enter it — Doctor never reads or changes your key.',
    zh: '模型拒绝了当前的 API Key。去「模型设置」重新填写——Doctor 从不读取或修改你的 Key。',
  },
  CREDENTIAL_MISSING: {
    en: 'No API key is configured for the model. Open Model settings and add it — Doctor never touches keys.',
    zh: '模型没有配置 API Key。去「模型设置」补上——Doctor 从不触碰 Key。',
  },
  RECENT_LOG_FAILURE: {
    en: 'Recent local logs contain a failure marker. Informational: check the evidence line; it may already be fixed.',
    zh: '最近的本地日志里有失败记录。仅供参考：看看证据行，可能已经自行恢复。',
  },
  NO_PROFILES: {
    en: 'No profile folders were found. Start the Harness once, or check DSH_HOME.',
    zh: '找不到任何 profile。先启动一次 Harness，或检查 DSH_HOME 指向。',
  },
  DSH_VERSION_UNKNOWN: {
    en: 'The installed Harness version could not be detected, so Doctor stays in conservative read-only mode.',
    zh: '检测不到 Harness 版本，Doctor 会保持保守的只读模式，不做修改。',
  },
  DSH_VERSION_UNSUPPORTED: {
    en: 'This Harness version is outside the tested range, so Doctor only reports and never mutates anything.',
    zh: '这个 Harness 版本超出已测试范围，Doctor 只报告、不做任何修改。',
  },
  ONLINE_CHECK_FAILED: {
    en: 'Could not reach the npm registry. Offline diagnostics are unaffected.',
    zh: '连不上 npm registry。离线诊断不受影响。',
  },
  ONLINE_VERSION: {
    en: 'The latest Harness version published on npm (informational only).',
    zh: 'npm 上发布的最新 Harness 版本（仅供参考）。',
  },
  PLUGIN_DISABLED: {
    en: 'A plugin was disabled (by Doctor or manually). After review, Doctor can re-enable it.',
    zh: '有插件处于禁用状态（Doctor 或手动禁的）。确认后 Doctor 可以重新启用它。',
  },
  SESSION_STORE_CORRUPT: {
    en: 'A session record or cache looks corrupt and may break conversation loading. Doctor can quarantine it (a reversible rename — nothing is deleted).',
    zh: '会话记录或缓存疑似损坏，可能影响对话加载。Doctor 可以把它隔离（可逆改名，不删除任何数据）。',
  },
  PORT_IN_USE: {
    en: 'The WebUI port is occupied by another process, so the Harness cannot start. Close the other process or choose a different port.',
    zh: 'WebUI 端口被别的进程占用，所以 Harness 起不来。关掉那个进程或换个端口。',
  },
  BOOT_PROBE_FAILED: {
    en: 'The Harness exited while starting. Read the captured output for the root cause; Doctor maps common failures to one-click repairs.',
    zh: 'Harness 在启动过程中退出了。看捕获的输出定位根因；常见故障 Doctor 都能一键修复。',
  },
  COLD_START_NO_CHECKPOINT: {
    en: 'There is no healthy checkpoint yet, so this is a cold-start rescue: rebuilding broken files requires your explicit confirmation.',
    zh: '还没有健康检查点，属于冷启动救援：重建损坏文件需要你明确确认。',
  },
  NODE_VERSION_UNSUPPORTED: {
    en: 'Your Node version is outside the range the Harness declares. This explains mysterious zstd/native-module errors and hangs — upgrade or pin Node first.',
    zh: '当前 Node 版本超出 Harness 声明的引擎范围——这正是 zstd 报错/原生模块报错/启动卡死的常见根源。先升级或锁定 Node 版本。',
  },
  DOTENV_DIRECTORY: {
    en: 'A folder named `.env` confuses the Harness (it expects a file). Rename it and the EISDIR warning disappears.',
    zh: '存在一个名为 `.env` 的文件夹（Harness 期望它是文件）。把它改名，每次启动的 EISDIR 报错就会消失。',
  },
  PORT_IN_EXCLUDED_RANGE: {
    en: 'The default 3080 port sits inside a Windows reserved range (Hyper-V/WSL2), so binding fails with EACCES. Start the Harness on a different port.',
    zh: '默认 3080 端口落在 Windows 保留端口区间内（Hyper-V/WSL2 导致），绑定会报 EACCES。换个端口启动 Harness。',
  },
  PS_UNIX_TOOLS_MISSING: {
    en: 'PowerShell 5.1 lacks head/tail/grep unless Git is on PATH. Use PowerShell cmdlets or Git Bash / WSL / PowerShell 7.',
    zh: 'PowerShell 5.1 没有 head/tail/grep（除非 PATH 里有 Git）。改用 PowerShell 命令，或换 Git Bash / WSL / PowerShell 7。',
  },
  KOFFI_VERSION_RISK: {
    en: 'This koffi version is known to crash the native directory picker on some Windows setups. Community workaround: pin koffi@3.1.2.',
    zh: '这个 koffi 版本在部分 Windows 环境会导致原生目录选择器崩溃。社区验证的规避方案：锁定 koffi@3.1.2。',
  },
  UTF16_PATH_TRUNCATION: {
    en: 'This path contains characters (shown in the message) that the Harness misreads as end-of-string, so the workspace silently fails. Move it to a different path.',
    zh: '该路径包含会被 Harness 误判为字符串结尾的字符（见消息中列出），工作区会因此静默失败。换一个目录。',
  },
  ROOT_WORKSPACE: {
    en: 'A drive/volume root was chosen as a workspace, which produces an empty title and EPERM errors. Use a concrete subdirectory.',
    zh: '把磁盘/卷根目录当成了工作区，会产生空标题和 EPERM 错误。请选一个具体子目录。',
  },
  LINKED_PLUGIN_RESOLUTION: {
    en: 'A locally linked plugin resolves modules from its real folder, so @deepseek-ai packages are unreachable at boot. Fix: use ctx services instead of imports, or bundle the peers.',
    zh: '本地 link 的插件会从真实目录解析模块，启动时找不到 @deepseek-ai 包。修法：改用 ctx 服务而不 import 这些包，或把 peer 依赖打进构建。',
  },
  INACTIVE_PLUGIN_DEPENDENCY: {
    en: 'This package is installed but never mounted: it is missing from dsh.profile.bundles (or lacks a dsh.bundle declaration), so it silently does nothing.',
    zh: '这个包装了但没被挂载：不在 dsh.profile.bundles 里（或缺少 dsh.bundle 声明），所以静默不生效。',
  },
  PATCH_NAME_UNRESOLVED: {
    en: 'cordis.patch.yml names a plugin that cannot be resolved — usually a stale name after a rename. Fix the name (and the bundle list) to match the installed package.',
    zh: 'cordis.patch.yml 里写的插件名解析不到——通常是改包名后没同步。把名字改成已安装的包名。',
  },
  PATCH_PATH_NOT_URL: {
    en: 'Plugin paths in cordis.patch.yml must be file:/// URLs; bare drive paths fail with ERR_UNSUPPORTED_ESM_URL_SCHEME. Prefix the path with file:///.',
    zh: 'cordis.patch.yml 里的插件路径必须是 file:/// URL；裸盘符路径会报 ERR_UNSUPPORTED_ESM_URL_SCHEME。给路径加上 file:/// 前缀。',
  },
  PLUGIN_PEER_MISMATCH: {
    en: 'A plugin wants a different @deepseek-ai version line than the one installed. rc-stage APIs break often; wait for a plugin update or pin the matching line.',
    zh: '插件的 @deepseek-ai 依赖版本线与已安装的不匹配。rc 阶段 API 变动频繁：等插件更新，或锁定匹配的版本线。',
  },
  WEB_SKILL_DISABLED: {
    en: 'Skills are disabled in the web bundle by default and fail silently. Enable them with a --patch overlay if you need skills in the Web UI.',
    zh: 'Web 版默认禁用 skill 且不报错。如果需要在 WebUI 里用 skill，用 --patch 覆盖打开。',
  },
  DSH_VERSION_LINE_MIX: {
    en: 'Installed @deepseek-ai packages span multiple version lines. The official latest dist-tag stalls on old lines, so bare installs mix them — lock every package to one line.',
    zh: '已安装的 @deepseek-ai 包跨越了多条版本线。官方 latest 标签停在旧线上，裸装容易混装——把所有包锁定到同一条版本线。',
  },
  DUAL_INSTANCE_RISK: {
    en: 'Two Harness instances writing the same session logs corrupt them (seq gap). Never run two instances against one DSH_HOME; use dsh-doctor start/stop to manage a single one.',
    zh: '两个 Harness 实例同时写同一份会话日志会把它写坏（seq gap）。绝不要对同一个 DSH_HOME 跑两个实例；用 dsh-doctor start/stop 管理单实例。',
  },
  NATIVE_MODULE_MISSING: {
    en: 'A native module (like node-pty) has no prebuild for this Node ABI and the boot fails. Run npm rebuild for it, or switch to an officially supported Node version.',
    zh: '某个原生模块（如 node-pty）没有当前 Node ABI 的预编译产物导致启动失败。对它执行 npm rebuild，或换用官方支持的 Node 版本。',
  },
}

/** Locale-dictionary entries keyed `hint.<code>` for one UI language. */
export function hintEntries(language: 'en' | 'zh'): Record<string, string> {
  const entries: Record<string, string> = {}
  for (const [code, hint] of Object.entries(ISSUE_HINTS)) entries[`hint.${code}`] = hint[language]
  return entries
}
