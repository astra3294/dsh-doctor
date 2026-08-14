import { spawnSync } from 'node:child_process'
import { lstat, readdir } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { dirname, join, parse, resolve } from 'node:path'
import semver from 'semver'
import { parseDocument, YAMLMap, YAMLSeq } from 'yaml'
import { DEFAULT_WEB_PORT } from './constants.js'
import { exists, readText } from './fs-utils.js'
import { displayPath, safeEvidence } from './redact.js'
import type { DoctorIssue, ScanOptions } from './types.js'

interface ProfilePluginFacts {
  readonly name: string
  readonly root: string
  readonly dshHome: string
  readonly manifest: { dependencies?: Record<string, string> }
  readonly bundles: readonly string[]
  readonly includePaths: boolean
}

function push(issues: DoctorIssue[], input: DoctorIssue): void {
  issues.push(input)
}

// ---------------------------------------------------------------------------
// Shared resolution helpers
// ---------------------------------------------------------------------------

async function resolvePackageJson(dshHome: string, packageName: string): Promise<{ path: string; manifest: Record<string, unknown> } | undefined> {
  const segments = packageName.startsWith('@') ? packageName.split('/') : [packageName]
  const candidates = [
    join(dshHome, 'profiles', 'node_modules', ...segments, 'package.json'),
    join(dshHome, 'profiles', 'web', 'node_modules', ...segments, 'package.json'),
  ]
  for (const candidate of candidates) {
    const raw = await readText(candidate)
    if (raw === undefined) continue
    try {
      return { path: candidate, manifest: JSON.parse(raw) as Record<string, unknown> }
    } catch {
      return undefined
    }
  }
  return undefined
}

async function packageVersion(dshHome: string, packageName: string): Promise<string | undefined> {
  const resolved = await resolvePackageJson(dshHome, packageName)
  if (resolved === undefined) return undefined
  return typeof resolved.manifest.version === 'string' ? resolved.manifest.version : undefined
}

/** Require a module name from a package root; undefined when unresolvable. */
function tryRequire(fromPackageRoot: string, moduleName: string): string | undefined {
  try {
    const require = createRequire(join(fromPackageRoot, '__doctor_probe__.js'))
    return require.resolve(moduleName)
  } catch {
    return undefined
  }
}

// ---------------------------------------------------------------------------
// A. Environment checks
// ---------------------------------------------------------------------------

export async function inspectEnvironment(
  dshHome: string,
  includePaths: boolean,
  issues: DoctorIssue[],
  options: ScanOptions = {},
): Promise<void> {
  const nodeVersion = options.nodeVersion ?? process.version

  // A1: Node version against the Harness's own engine range.
  const dsh = await resolvePackageJson(dshHome, '@deepseek-ai/dsh')
  const enginesNode = dsh?.manifest.engines !== undefined && typeof dsh.manifest.engines === 'object'
    ? (dsh.manifest.engines as { node?: unknown }).node
    : undefined
  if (typeof enginesNode === 'string' && semver.valid(semver.coerce(nodeVersion) ?? '') !== null) {
    const satisfied = semver.satisfies(nodeVersion, enginesNode, { includePrerelease: true })
    if (!satisfied) push(issues, {
      code: 'NODE_VERSION_UNSUPPORTED', severity: 'error',
      title: 'The installed Node version is outside the Harness engine range',
      message: `Harness requires Node ${enginesNode}, but this environment runs ${nodeVersion}. Boot may fail with obscure errors (zstd exports, native modules, hangs).`,
      evidence: `${nodeVersion} (needs ${enginesNode})`, recoverability: 'manual',
    })
  }

  // A2: `.env` is a directory instead of a file.
  for (const base of [process.cwd(), dshHome]) {
    const dotenvPath = join(base, '.env')
    try {
      const stat = await lstat(dotenvPath)
      if (stat.isDirectory()) push(issues, {
        code: 'DOTENV_DIRECTORY', severity: 'warning',
        title: '`.env` is a directory, not a file',
        message: 'The Harness tries to read `.env` as a file and prints an EISDIR error on every boot. Rename the directory.',
        file: displayPath(dotenvPath, dshHome, includePaths), recoverability: 'manual',
      })
    } catch {
      // ENOENT is the normal case.
    }
  }

  // A3: the WebUI port falls inside a Windows excluded (reserved) port range.
  if (process.platform === 'win32') {
    try {
      const result = spawnSync('netsh', ['int', 'ipv4', 'show', 'excludedportrange', 'protocol=tcp'], {
        encoding: 'utf8', timeout: 5000, windowsHide: true,
      })
      const output = `${result.stdout ?? ''}\n${result.stderr ?? ''}`
      const inExcludedRange = /^\s*(\d+)\s+(\d+)\s/m.test(output)
        ? output.split(/\r?\n/).some(line => {
          const match = line.match(/^\s*(\d+)\s+(\d+)\s/)
          if (match === null) return false
          const start = Number(match[1])
          const end = Number(match[2])
          return DEFAULT_WEB_PORT >= start && DEFAULT_WEB_PORT <= end
        })
        : false
      if (inExcludedRange) push(issues, {
        code: 'PORT_IN_EXCLUDED_RANGE', severity: 'warning',
        title: `Port ${String(DEFAULT_WEB_PORT)} falls inside a Windows reserved range`,
        message: 'Hyper-V/WSL2 reserve dynamic port ranges on Windows; the default 3080 is often inside one, causing EACCES at boot. Start the Harness on another port.',
        evidence: `port ${String(DEFAULT_WEB_PORT)} in excluded range`, recoverability: 'manual',
      })
    } catch {
      // netsh unavailable: skip silently.
    }
  }

  // A4: PowerShell 5.1 without Unix tools (head/tail/grep missing).
  if (process.platform === 'win32') {
    const modulePath = process.env.PSModulePath ?? ''
    const pathValue = process.env.PATH ?? ''
    if (modulePath.includes('WindowsPowerShell') && !/Git[\\/]usr[\\/]bin/i.test(pathValue)) {
      push(issues, {
        code: 'PS_UNIX_TOOLS_MISSING', severity: 'info',
        title: 'PowerShell 5.1 without Unix tools on PATH',
        message: 'Commands like `head`/`tail`/`grep` fail in this shell. Use PowerShell equivalents, or run from Git Bash / WSL / PowerShell 7.',
        recoverability: 'manual',
      })
    }
  }

  // A5: risky koffi version (native directory-picker crashes).
  const koffiVersion = await packageVersion(dshHome, 'koffi')
  if (koffiVersion !== undefined && semver.lt(koffiVersion, '3.1.2')) {
    push(issues, {
      code: 'KOFFI_VERSION_RISK', severity: 'warning',
      title: 'Installed koffi version is known to crash the native directory picker',
      message: `koffi@${koffiVersion} has native crashes on some Windows setups. Community-verified workaround: pin koffi@3.1.2.`,
      evidence: `koffi@${koffiVersion}`, recoverability: 'manual',
    })
  }
}

// ---------------------------------------------------------------------------
// B. Workspace checks
// ---------------------------------------------------------------------------

/** Characters whose UTF-16LE low byte is 0x00 (misread as string end by readUtf16). */
function utf16TruncationChars(path: string): string[] {
  const hits: string[] = []
  for (const char of path) {
    const code = char.codePointAt(0) ?? 0
    if (code >= 0x100 && (code & 0xff) === 0) hits.push(char)
  }
  return [...new Set(hits)]
}

async function workspaceEntries(dshHome: string): Promise<{ path: string; title?: string }[]> {
  const file = join(dshHome, 'storages', 'workspace.json')
  const raw = await readText(file)
  if (raw === undefined) return []
  try {
    const parsed = JSON.parse(raw) as unknown
    let candidates: unknown[] = []
    if (Array.isArray(parsed)) candidates = parsed
    else if (parsed !== null && typeof parsed === 'object') {
      const values = Object.values(parsed as Record<string, unknown>)
      const array = values.find(value => Array.isArray(value))
      if (array !== undefined) candidates = array as unknown[]
    }
    return candidates
      .filter(item => item !== null && typeof item === 'object' && typeof (item as { path?: unknown }).path === 'string')
      .map(item => {
        const record = item as { path: string; title?: unknown }
        return { path: record.path, title: typeof record.title === 'string' ? record.title : undefined }
      })
  } catch {
    return []
  }
}

export async function inspectWorkspaces(dshHome: string, includePaths: boolean, issues: DoctorIssue[]): Promise<void> {
  for (const entry of await workspaceEntries(dshHome)) {
    // B1: UTF-16 low-byte-zero characters truncate workspace paths.
    const hits = utf16TruncationChars(entry.path)
    if (hits.length > 0) push(issues, {
      code: 'UTF16_PATH_TRUNCATION', severity: 'error',
      title: 'A workspace path contains characters that truncate under UTF-16',
      message: `The path contains ${hits.join(' ')} — characters whose UTF-16LE low byte is 0x00. The Harness misreads them as end-of-string, so workspace creation fails with ENOENT. Move the workspace to a path without these characters.`,
      evidence: safeEvidence(entry.path, dshHome, includePaths), recoverability: 'manual',
    })

    // B2: filesystem root chosen as a workspace.
    const normalized = resolve(entry.path)
    if (normalized === parse(normalized).root) push(issues, {
      code: 'ROOT_WORKSPACE', severity: 'warning',
      title: 'A filesystem root is registered as a workspace',
      message: 'Choosing a drive/volume root as a workspace produces an empty-title workspace and EPERM failures. Pick a concrete subdirectory instead.',
      evidence: safeEvidence(entry.path, dshHome, includePaths), recoverability: 'manual',
    })
  }
}

// ---------------------------------------------------------------------------
// C. Profile plugin checks (the Discussion #380 pitfalls and peer ecosystem)
// ---------------------------------------------------------------------------

function patchInsertNames(raw: string): { id?: string; name?: string }[] {
  const doc = parseDocument(raw)
  if (doc.errors.length > 0 || !(doc.contents instanceof YAMLSeq)) return []
  const entries: { id?: string; name?: string }[] = []
  for (const item of doc.contents.items) {
    if (!(item instanceof YAMLMap)) continue
    const insert = item.get('insert') as unknown
    if (insert instanceof YAMLSeq) {
      for (const row of insert.items) {
        if (row instanceof YAMLMap) entries.push({
          id: row.get('id') as unknown as string | undefined,
          name: row.get('name') as unknown as string | undefined,
        })
      }
    }
  }
  return entries
}

async function patchDisabledIds(dshHome: string, packageName: string): Promise<string[]> {
  const resolved = await resolvePackageJson(dshHome, packageName)
  if (resolved === undefined) return []
  const bundle = resolved.manifest.dsh as { bundle?: { patch?: unknown } } | undefined
  if (typeof bundle?.bundle?.patch !== 'string') return []
  const patchPath = join(dirname(resolved.path), bundle.bundle.patch)
  const raw = await readText(patchPath)
  if (raw === undefined) return []
  const doc = parseDocument(raw)
  if (doc.errors.length > 0 || !(doc.contents instanceof YAMLSeq)) return []
  const ids: string[] = []
  for (const item of doc.contents.items) {
    if (item instanceof YAMLMap && (item.get('disabled') as unknown) === true) {
      const id = item.get('id') as unknown
      if (typeof id === 'string') ids.push(id)
    }
  }
  return ids
}

export async function inspectProfilePlugins(facts: ProfilePluginFacts, issues: DoctorIssue[]): Promise<void> {
  const { root, dshHome, name, includePaths } = facts
  const dependencies = facts.manifest.dependencies ?? {}

  // C1: linked/file dependencies that cannot resolve @deepseek-ai/* packages.
  for (const [dependency, spec] of Object.entries(dependencies)) {
    if (!/^(?:link|file):/i.test(spec)) continue
    let target = spec.replace(/^(?:link|file):/i, '')
    target = resolve(root, target)
    try {
      if (!(await lstat(target)).isDirectory()) continue
    } catch {
      continue
    }
    const probe = tryRequire(target, '@deepseek-ai/cordis')
    if (probe !== undefined) continue
    // Only a real finding when the plugin's built entry actually imports
    // @deepseek-ai/* (a link-safe plugin that avoids those imports is fine).
    const manifestRaw = await readText(join(target, 'package.json'))
    if (manifestRaw === undefined) continue
    let entry: string | undefined
    try {
      const manifest = JSON.parse(manifestRaw) as { main?: string; exports?: unknown }
      entry = typeof manifest.main === 'string' ? manifest.main : undefined
      if (entry === undefined && manifest.exports !== undefined && typeof manifest.exports === 'object') {
        const dot = (manifest.exports as { '.'?: unknown })['.']
        if (typeof dot === 'string') entry = dot
        else if (dot !== null && typeof dot === 'object' && typeof (dot as { default?: unknown }).default === 'string') {
          entry = (dot as { default?: string }).default
        }
      }
    } catch {
      continue
    }
    if (entry === undefined) continue
    const entryContent = await readText(join(target, entry))
    if (entryContent === undefined) continue
    // Only real import statements count — string literals that merely mention
    // the namespace (diagnostics data) are not runtime dependencies.
    const importReference = /(?:import\s*\(\s*['"]|import\s+[^;]*?\bfrom\s*['"]|require\s*\(\s*['"]|export\s+[^;]*?\bfrom\s*['"])@deepseek-ai\//
    if (!importReference.test(entryContent)) continue
    push(issues, {
      code: 'LINKED_PLUGIN_RESOLUTION', severity: 'error',
      title: 'A locally linked plugin cannot resolve @deepseek-ai packages',
      message: `${dependency} (${spec}) imports @deepseek-ai packages, but Node resolves modules from its real path and never reaches the profile fallback directory — it will crash at boot. Either avoid importing @deepseek-ai/* (use ctx services), or bundle the peer dependencies into the build.`,
      evidence: safeEvidence(spec, dshHome, includePaths), recoverability: 'manual',
    })
  }

  // C2: dependencies that look like dsh plugins but are not mounted.
  const bundles = new Set(facts.bundles)
  for (const dependency of Object.keys(dependencies)) {
    if (bundles.has(dependency)) continue
    if (/(?:^dsh-|^@[^/]+\/dsh-|plugin)/i.test(dependency)) push(issues, {
      code: 'INACTIVE_PLUGIN_DEPENDENCY', severity: 'warning',
      title: 'A plugin-looking dependency is not mounted as a bundle',
      message: `${dependency} is installed but not listed in dsh.profile.bundles, so it never activates. Add it to the bundle list (and declare dsh.bundle in its package.json).`,
      evidence: dependency, recoverability: 'confirmation',
    })
  }

  // C3/C4: patch insert names that cannot resolve, or use bare drive paths.
  const patchPath = join(root, 'cordis.patch.yml')
  const rawPatch = await readText(patchPath)
  if (rawPatch !== undefined) {
    for (const entry of patchInsertNames(rawPatch)) {
      const entryName = entry.name
      if (entryName === undefined) continue
      if (/^[A-Za-z]:[\\/]/.test(entryName)) {
        push(issues, {
          code: 'PATCH_PATH_NOT_URL', severity: 'error',
          title: 'A plugin path in cordis.patch.yml is not a file:// URL',
          message: `"${entryName}" is a bare drive path; the loader only accepts file:/// URLs, so the plugin will not load (ERR_UNSUPPORTED_ESM_URL_SCHEME).`,
          evidence: safeEvidence(entryName, dshHome, includePaths),
          file: displayPath(patchPath, dshHome, includePaths), recoverability: 'confirmation',
        })
        continue
      }
      if (/^file:\/\//i.test(entryName)) continue
      const resolvedName = tryRequire(root, entryName)
      if (resolvedName === undefined) push(issues, {
        code: 'PATCH_NAME_UNRESOLVED', severity: 'error',
        title: 'A patch entry name cannot be resolved',
        message: `cordis.patch.yml inserts "${entryName}" but no such package can be resolved from the profile. This is often a stale name after a package rename.`,
        evidence: safeEvidence(entryName, dshHome, includePaths),
        file: displayPath(patchPath, dshHome, includePaths), recoverability: 'confirmation',
      })
    }
  }

  // C5: peerDependencies vs installed @deepseek-ai versions (three tiers).
  let peerIssues = 0
  const searchRoots = [join(root, 'node_modules'), join(dshHome, 'profiles', 'node_modules')]
  for (const searchRoot of searchRoots) {
    if (peerIssues >= 5) break
    if (!await exists(searchRoot)) continue
    let packages: string[]
    try {
      packages = (await readdir(searchRoot, { withFileTypes: true }))
        .filter(entry => entry.isDirectory())
        .map(entry => entry.name)
    } catch {
      continue
    }
    for (const packageName of packages) {
      if (peerIssues >= 5) break
      const manifestPath = join(searchRoot, packageName, 'package.json')
      const raw = await readText(manifestPath)
      if (raw === undefined) continue
      let peer: Record<string, string> | undefined
      try {
        peer = (JSON.parse(raw) as { peerDependencies?: Record<string, string> }).peerDependencies
      } catch {
        continue
      }
      if (peer === undefined) continue
      for (const [peerName, range] of Object.entries(peer)) {
        if (!peerName.startsWith('@deepseek-ai/')) continue
        const installed = await packageVersion(dshHome, peerName)
        if (installed === undefined) continue
        if (!semver.satisfies(installed, range, { includePrerelease: true })) {
          push(issues, {
            code: 'PLUGIN_PEER_MISMATCH', severity: 'warning',
            title: 'A plugin peer dependency does not match the installed version line',
            message: `${packageName} wants ${peerName}@${range}, but ${peerName}@${installed} is installed. The plugin may silently malfunction or crash the Web UI; wait for a plugin update or pin the matching line.`,
            evidence: `${packageName}: ${peerName}@${range} (installed ${installed})`, recoverability: 'manual',
          })
          peerIssues += 1
        }
      }
    }
  }

  // C6: web bundle disables skills by default (silent no-op).
  const disabledIds = await patchDisabledIds(dshHome, '@deepseek-ai/dsh-web-app')
  for (const id of disabledIds) {
    if (!['skill-filesystem', 'tool-skill', 'skill-badge', 'agent-instructions'].includes(id)) continue
    push(issues, {
      code: 'WEB_SKILL_DISABLED', severity: 'info',
      title: 'Skills are disabled in the web profile by default',
      message: `${id} is disabled in the web bundle, so skills silently do nothing in the Web UI. Enable it via a --patch overlay if you need skills.`,
      evidence: id, recoverability: 'manual',
    })
  }
}
