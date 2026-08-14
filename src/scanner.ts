import { lstat, open, readdir, readlink } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { randomUUID } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { parseDocument, YAMLMap, YAMLSeq } from 'yaml'
import semver from 'semver'
import { DEFAULT_PROFILE, DOCTOR_VERSION, SUPPORTED_DSH_VERSION } from './constants.js'
import { exists, fileSize, isReadableWritable, readText } from './fs-utils.js'
import { displayPath, safeEvidence } from './redact.js'
import { profileRoot, resolveDshHome, safeProfileName } from './paths.js'
import type {
  DoctorIssue, DoctorScanReport, DoctorSummary, ProfileReport, RuntimeModelStatus, RuntimePluginEntry, ScanOptions,
} from './types.js'

interface ProfileManifest {
  dependencies?: Record<string, string>
  devDependencies?: Record<string, string>
  dsh?: { profile?: { bundles?: unknown } }
}

function issue(input: DoctorIssue): DoctorIssue {
  return input
}

function summarize(issues: readonly DoctorIssue[]): DoctorSummary {
  return summarizeIssues(issues)
}

/** Recompute a summary for an issue list (exported for boot-probe merging). */
export function summarizeIssues(issues: readonly DoctorIssue[]): DoctorSummary {
  return {
    errors: issues.filter(item => item.severity === 'error').length,
    warnings: issues.filter(item => item.severity === 'warning').length,
    info: issues.filter(item => item.severity === 'info').length,
  }
}

/**
 * Warnings that veto a `healthy` checkpoint. Intentional developer patterns
 * (non-registry sources, external plugin sources, unknown-but-untouched
 * versions) are NOT blocking — otherwise a plugin developer with a
 * `file:`-linked package could never establish a recovery baseline.
 */
const BLOCKING_WARNING_CODES = new Set([
  'CONFIG_PERMISSION', 'PLUGIN_RUNTIME_PENDING', 'DSH_VERSION_UNSUPPORTED', 'RECENT_LOG_FAILURE',
])

/** Issues that must be absent before a profile may be marked healthy. */
export function blockingIssues(report: DoctorScanReport): DoctorIssue[] {
  return report.issues.filter(item => item.severity === 'error' || BLOCKING_WARNING_CODES.has(item.code))
}

async function profileNames(dshHome: string, options: ScanOptions): Promise<string[]> {
  if (options.profile !== undefined) return [safeProfileName(options.profile)]
  if (options.allProfiles === false) return [safeProfileName(process.env.DSH_PROFILE ?? DEFAULT_PROFILE)]
  const directory = join(dshHome, 'profiles')
  if (!await exists(directory)) return []
  return (await readdir(directory, { withFileTypes: true }))
    .filter(entry => entry.isDirectory())
    .map(entry => entry.name)
    .filter(name => /^[A-Za-z0-9._-]+$/.test(name))
    .sort()
}

function parseYaml(text: string, path: string): string[] {
  const document = parseDocument(text, { prettyErrors: false, strict: true })
  return document.errors.map(error => `${path}: ${error.message}`)
}

async function resolveDependency(profilePath: string, dshHome: string, name: string): Promise<string | undefined> {
  const packagePath = name.startsWith('@') ? name.split('/') : [name]
  const candidates = [
    join(profilePath, 'node_modules', ...packagePath, 'package.json'),
    join(dshHome, 'profiles', 'node_modules', ...packagePath, 'package.json'),
  ]
  for (const candidate of candidates) if (await exists(candidate)) return candidate
  return undefined
}

async function inspectProfile(
  name: string,
  dshHome: string,
  includePaths: boolean,
  issues: DoctorIssue[],
): Promise<ProfileReport> {
  const root = profileRoot(dshHome, name)
  const packagePath = join(root, 'package.json')
  if (!await exists(root)) {
    issues.push(issue({
      code: 'PROFILE_MISSING', severity: 'error', title: 'Profile does not exist',
      message: `The ${name} profile directory is missing.`, profile: name,
      evidence: displayPath(root, dshHome, includePaths), recoverability: 'manual',
    }))
    return { name, path: displayPath(root, dshHome, includePaths), exists: false, dependencies: [], bundles: [] }
  }

  const dependencies: string[] = []
  const bundles: string[] = []
  let manifest: ProfileManifest | undefined
  const rawPackage = await readText(packagePath)
  if (rawPackage === undefined) {
    issues.push(issue({
      code: 'PROFILE_MANIFEST_MISSING', severity: 'error', title: 'Profile manifest is missing',
      message: 'package.json is required for a DSH profile.', profile: name,
      file: displayPath(packagePath, dshHome, includePaths), recoverability: 'automatic',
    }))
  } else {
    try {
      manifest = JSON.parse(rawPackage) as ProfileManifest
      dependencies.push(...Object.keys(manifest.dependencies ?? {}))
      const rawBundles = manifest.dsh?.profile?.bundles
      if (Array.isArray(rawBundles) && rawBundles.every(value => typeof value === 'string')) {
        bundles.push(...rawBundles)
      } else {
        issues.push(issue({
          code: 'PROFILE_BUNDLES_INVALID', severity: 'error', title: 'Profile bundle list is invalid',
          message: 'dsh.profile.bundles must be an array of package names.', profile: name,
          file: displayPath(packagePath, dshHome, includePaths), recoverability: 'confirmation',
        }))
      }
      const duplicateBundles = bundles.filter((value, index) => bundles.indexOf(value) !== index)
      if (duplicateBundles.length > 0) issues.push(issue({
        code: 'DUPLICATE_BUNDLE', severity: 'error', title: 'Duplicate profile bundles',
        message: `Duplicate bundles: ${[...new Set(duplicateBundles)].join(', ')}`, profile: name,
        file: displayPath(packagePath, dshHome, includePaths), recoverability: 'confirmation',
      }))
    } catch (error) {
      issues.push(issue({
        code: 'PROFILE_JSON_INVALID', severity: 'error', title: 'Profile manifest cannot be parsed',
        message: 'package.json contains invalid JSON.', profile: name,
        evidence: safeEvidence(String(error), dshHome, includePaths),
        file: displayPath(packagePath, dshHome, includePaths), recoverability: 'automatic',
      }))
    }
  }

  const patchPath = join(root, 'cordis.patch.yml')
  const rawPatch = await readText(patchPath)
  if (rawPatch !== undefined) {
    const errors = parseYaml(rawPatch, displayPath(patchPath, dshHome, includePaths))
    if (errors.length > 0) issues.push(issue({
      code: 'CORDIS_PATCH_INVALID', severity: 'error', title: 'Cordis patch cannot be parsed',
      message: 'cordis.patch.yml contains invalid YAML.', profile: name,
      evidence: safeEvidence(errors.join('; '), dshHome, includePaths),
      file: displayPath(patchPath, dshHome, includePaths), recoverability: 'automatic',
    }))
    if (/\b(?:https?|git\+|file):/i.test(rawPatch)) issues.push(issue({
      code: 'EXTERNAL_PLUGIN_SOURCE', severity: 'warning', title: 'External plugin source detected',
      message: 'The Cordis patch references a URL or local package source; review it before repair.', profile: name,
      file: displayPath(patchPath, dshHome, includePaths), recoverability: 'manual',
    }))
    if (errors.length === 0) {
      const doc = parseDocument(rawPatch)
      const list = doc.contents instanceof YAMLSeq ? doc.contents : undefined
      for (const item of list?.items ?? []) {
        if (item instanceof YAMLMap && (item.get('disabled') as unknown) === true) {
          const id = item.get('id') as unknown
          if (typeof id === 'string') issues.push(issue({
            code: 'PLUGIN_DISABLED', severity: 'info', title: 'A plugin was disabled by Doctor',
            message: `${id} is disabled in the profile patch; it can be re-enabled after review.`, profile: name,
            evidence: id, file: displayPath(patchPath, dshHome, includePaths), recoverability: 'confirmation',
          }))
        }
      }
    }
  }

  for (const yamlFile of [
    { name: 'cordis.yml', code: 'CORDIS_YML_INVALID', title: 'Cordis composition cannot be parsed' },
    { name: 'pnpm-workspace.yaml', code: 'WORKSPACE_YAML_INVALID', title: 'pnpm workspace cannot be parsed' },
  ]) {
    const path = join(root, yamlFile.name)
    const raw = await readText(path)
    if (raw === undefined) continue
    const errors = parseYaml(raw, displayPath(path, dshHome, includePaths))
    if (errors.length > 0) issues.push(issue({
      code: yamlFile.code, severity: 'error', title: yamlFile.title,
      message: `${yamlFile.name} contains invalid YAML and can block Harness startup.`, profile: name,
      evidence: safeEvidence(errors.join('; '), dshHome, includePaths),
      file: displayPath(path, dshHome, includePaths), recoverability: 'automatic',
    }))
  }

  for (const dependency of dependencies) {
    const spec = manifest?.dependencies?.[dependency] ?? ''
    if (/^(?:https?|git\+|file|link):/i.test(spec)) issues.push(issue({
      code: 'NON_REGISTRY_DEPENDENCY', severity: 'warning', title: 'Non-registry dependency detected',
      message: `${dependency} uses a non-registry source.`, profile: name,
      evidence: safeEvidence(spec, dshHome, includePaths), recoverability: 'manual',
    }))
    const resolved = await resolveDependency(root, dshHome, dependency)
    if (resolved === undefined) issues.push(issue({
      code: 'PROFILE_DEPENDENCY_MISSING', severity: 'error', title: 'Profile dependency is missing',
      message: `${dependency} is declared but cannot be resolved.`, profile: name,
      evidence: dependency, recoverability: 'confirmation',
    }))
  }

  const nodeModules = join(root, 'node_modules')
  if (await exists(nodeModules)) {
    for (const dependency of dependencies) {
      const segments = dependency.startsWith('@') ? dependency.split('/') : [dependency]
      const dependencyPath = join(nodeModules, ...segments)
      try {
        const entry = await lstat(dependencyPath)
        if (entry.isSymbolicLink()) {
          const target = resolve(join(dependencyPath, '..'), await readlink(dependencyPath))
          if (!await exists(target)) issues.push(issue({
            code: 'BROKEN_PROFILE_LINK', severity: 'error', title: 'Broken profile dependency link',
            message: `${dependency} points to a missing target.`, profile: name,
            evidence: displayPath(dependencyPath, dshHome, includePaths), recoverability: 'confirmation',
          }))
        }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      }
    }
  }

  for (const file of [packagePath, patchPath]) {
    if (!await exists(file)) continue
    const permission = await isReadableWritable(file)
    if (!permission.readable || !permission.writable) issues.push(issue({
      code: 'CONFIG_PERMISSION', severity: permission.readable ? 'warning' : 'error',
      title: 'Configuration file permissions prevent recovery',
      message: `Doctor needs read and write access to ${displayPath(file, dshHome, includePaths)}.`,
      profile: name, file: displayPath(file, dshHome, includePaths), recoverability: 'manual',
    }))
  }

  let dshVersion: string | undefined
  const dshPackage = await resolveDependency(root, dshHome, '@deepseek-ai/dsh')
  if (dshPackage !== undefined) {
    try { dshVersion = (JSON.parse(await readText(dshPackage) ?? '{}') as { version?: string }).version } catch {}
  }
  return { name, path: displayPath(root, dshHome, includePaths), exists: true, dshVersion, dependencies, bundles }
}

async function versionFromRunningEntry(): Promise<string | undefined> {
  let directory = dirname(resolve(process.argv[1] ?? process.execPath))
  for (let depth = 0; depth < 12; depth += 1) {
    const raw = await readText(join(directory, 'package.json'))
    if (raw !== undefined) {
      try {
        const manifest = JSON.parse(raw) as { name?: string; version?: string }
        if (manifest.name === '@deepseek-ai/dsh' && typeof manifest.version === 'string') return manifest.version
      } catch {}
    }
    const parent = dirname(directory)
    if (parent === directory) break
    directory = parent
  }
  return undefined
}

async function detectCliVersion(): Promise<string | undefined> {
  const running = await versionFromRunningEntry()
  if (running !== undefined) return running
  const command = process.platform === 'win32' ? 'dsh.cmd' : 'dsh'
  const result = spawnSync(command, ['--version'], { encoding: 'utf8', timeout: 5000, windowsHide: true })
  const output = `${result.stdout ?? ''} ${result.stderr ?? ''}`
  return output.match(/\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?/)?.[0]
}

async function inspectSettings(dshHome: string, includePaths: boolean, issues: DoctorIssue[]): Promise<void> {
  const candidates = ['settings.yaml', 'settings.yml', 'settings.json'].map(name => join(dshHome, name))
  for (const path of candidates) {
    const raw = await readText(path)
    if (raw === undefined) continue
    try {
      if (path.endsWith('.json')) JSON.parse(raw)
      else {
        const errors = parseYaml(raw, displayPath(path, dshHome, includePaths))
        if (errors.length > 0) throw new Error(errors.join('; '))
      }
    } catch (error) {
      issues.push(issue({
        code: 'SETTINGS_INVALID', severity: 'error', title: 'Settings document cannot be parsed',
        message: 'The Harness settings document is invalid; stored credentials are not inspected.',
        evidence: safeEvidence(String(error), dshHome, includePaths),
        file: displayPath(path, dshHome, includePaths), recoverability: 'automatic',
      }))
    }
  }
}

function inspectRuntime(entries: readonly RuntimePluginEntry[], issues: DoctorIssue[]): void {
  for (const entry of entries) {
    if (entry.phase === 'failed') issues.push(issue({
      code: 'PLUGIN_RUNTIME_FAILED', severity: 'error', title: 'Plugin failed at runtime',
      message: `${entry.moduleName} is in the failed Cordis phase.`,
      evidence: entry.entryId, recoverability: 'confirmation',
    }))
    if (entry.phase === 'pending') issues.push(issue({
      code: 'PLUGIN_RUNTIME_PENDING', severity: 'warning', title: 'Plugin is waiting for a dependency',
      message: `${entry.moduleName} is still pending.`, evidence: entry.entryId, recoverability: 'manual',
    }))
  }
}

function inspectRuntimeModel(status: RuntimeModelStatus | undefined, issues: DoctorIssue[]): void {
  if (status === undefined) return
  if (status.provider === undefined || status.model === undefined) {
    issues.push(issue({
      code: 'MODEL_ROUTE_MISSING', severity: 'error', title: 'No default model route is configured',
      message: 'Choose a provider and model in Model settings.', recoverability: 'manual',
    }))
    return
  }
  if (status.providerAvailable === false || status.modelAvailable === false) issues.push(issue({
    code: 'MODEL_ROUTE_UNAVAILABLE', severity: 'error', title: 'The configured model route is unavailable',
    message: `${status.provider}/${status.model} is not available. Choose a working route in Model settings.`,
    evidence: `${status.provider}/${status.model}`, recoverability: 'manual',
  }))
  if (status.credentialFailure !== undefined) issues.push(issue({
    code: status.credentialFailure === 'invalid' ? 'CREDENTIAL_INVALID' : 'CREDENTIAL_MISSING',
    severity: 'error', title: status.credentialFailure === 'invalid' ? 'The model credential is invalid' : 'The model credential is missing',
    message: 'Doctor never reads or replaces API keys. Open Model settings and enter the credential again.',
    recoverability: 'manual',
  }))
}

async function inspectLogs(dshHome: string, includePaths: boolean, issues: DoctorIssue[]): Promise<void> {
  const directory = join(dshHome, 'logs')
  if (!await exists(directory)) return
  const entries = (await readdir(directory, { withFileTypes: true }))
    .filter(entry => entry.isFile() && /\.log$/i.test(entry.name))
    .slice(-5)
  for (const entry of entries) {
    const path = join(directory, entry.name)
    const size = await fileSize(path)
    if (size === undefined || size > 10 * 1024 * 1024) continue
    const raw = await readText(path)
    const line = raw?.split(/\r?\n/).reverse().find(value => /\b(?:fatal|uncaught|plugin.*failed)\b/i.test(value))
      ?? raw?.split(/\r?\n/).reverse().find(value => /\b(?:INVALID_CREDENTIAL|MISSING_CREDENTIAL|NO_ADAPTER)\b/i.test(value))
    if (line !== undefined && /\b(?:INVALID_CREDENTIAL|MISSING_CREDENTIAL)\b/i.test(line)) {
      const invalid = /\bINVALID_CREDENTIAL\b/i.test(line)
      issues.push(issue({
        code: invalid ? 'CREDENTIAL_INVALID' : 'CREDENTIAL_MISSING', severity: 'error',
        title: invalid ? 'A recent model request rejected the credential' : 'A recent model request had no credential',
        message: 'Doctor never reads or replaces API keys. Open Model settings and enter the credential again.',
        file: displayPath(path, dshHome, includePaths), recoverability: 'manual',
      }))
      continue
    }
    if (line !== undefined && /\bNO_ADAPTER\b/i.test(line)) {
      issues.push(issue({
        code: 'MODEL_ROUTE_UNAVAILABLE', severity: 'error', title: 'A recent model route had no adapter',
        message: 'Choose a provider and model that has an active adapter in Model settings.',
        file: displayPath(path, dshHome, includePaths), recoverability: 'manual',
      }))
      continue
    }
    if (line !== undefined) issues.push(issue({
      code: 'RECENT_LOG_FAILURE', severity: 'warning', title: 'Recent failure found in local logs',
      message: 'A recent Harness log contains a failure marker.',
      evidence: safeEvidence(line.slice(0, 300), dshHome, includePaths),
      file: displayPath(path, dshHome, includePaths), recoverability: 'manual',
    }))
  }
}

async function onlineLatestVersion(): Promise<string | undefined> {
  try {
    const response = await fetch('https://registry.npmjs.org/@deepseek-ai%2Fdsh/latest', { signal: AbortSignal.timeout(5000) })
    if (!response.ok) return undefined
    return ((await response.json()) as { version?: string }).version
  } catch {
    return undefined
  }
}

/** zstd frame magic (0xFD2FB528) read little-endian as the first 4 bytes. */
const ZSTD_MAGIC = 0xFD2FB528
const SESSION_FILES_CAP = 50

async function zstdHeaderValid(path: string): Promise<boolean | undefined> {
  try {
    const handle = await open(path, 'r')
    try {
      const buffer = Buffer.alloc(4)
      const { bytesRead } = await handle.read(buffer, 0, 4, 0)
      if (bytesRead < 4) return false
      return buffer.readUInt32LE(0) === ZSTD_MAGIC
    } finally {
      await handle.close()
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw error
  }
}

/** Read-only integrity probe for conversation state. Never deletes anything. */
async function inspectSessionStore(dshHome: string, includePaths: boolean, issues: DoctorIssue[]): Promise<void> {
  const sessions = join(dshHome, 'sessions')
  if (await exists(sessions)) {
    try {
      const workspaces = (await readdir(sessions, { withFileTypes: true })).filter(entry => entry.isDirectory())
      for (const workspace of workspaces) {
        const workspacePath = join(sessions, workspace.name)
        let files: { name: string }[]
        try {
          files = (await readdir(workspacePath, { withFileTypes: true }))
            .filter(entry => entry.isFile() && /\.zstd$/i.test(entry.name))
            .slice(0, SESSION_FILES_CAP)
        } catch {
          continue
        }
        for (const file of files) {
          const path = join(workspacePath, file.name)
          const size = await fileSize(path)
          const header = await zstdHeaderValid(path)
          if (size !== undefined && (size === 0 || header === false)) {
            issues.push(issue({
              code: 'SESSION_STORE_CORRUPT', severity: 'warning', title: 'A session record looks corrupt',
              message: 'This file cannot be read as a zstd session record; conversations may fail to load. Doctor can quarantine it (reversible) so the Harness starts fresh sessions.',
              file: displayPath(path, dshHome, includePaths), recoverability: 'confirmation',
            }))
          }
        }
      }
    } catch {
      // A malformed sessions tree must not break the scan.
    }
  }

  const storages = join(dshHome, 'storages')
  if (await exists(storages)) {
    let files: { name: string }[]
    try {
      files = (await readdir(storages, { withFileTypes: true })).filter(entry => entry.isFile() && /\.json$/i.test(entry.name))
    } catch {
      files = []
    }
    for (const file of files) {
      const path = join(storages, file.name)
      const raw = await readText(path)
      if (raw === undefined) continue
      try {
        JSON.parse(raw)
      } catch (error) {
        issues.push(issue({
          code: 'SESSION_STORE_CORRUPT', severity: 'warning', title: 'A storage cache is corrupt',
          message: 'This JSON cache is invalid and can be quarantined (reversible) so the Harness rebuilds it.',
          evidence: safeEvidence(String(error), dshHome, includePaths),
          file: displayPath(path, dshHome, includePaths), recoverability: 'confirmation',
        }))
      }
    }
  }
}

export async function scanHarness(options: ScanOptions = {}): Promise<DoctorScanReport> {
  const dshHome = resolveDshHome(options.dshHome)
  const includePaths = options.includePaths ?? false
  const issues: DoctorIssue[] = []
  const names = await profileNames(dshHome, options)
  if (names.length === 0) issues.push(issue({
    code: 'NO_PROFILES', severity: 'warning', title: 'No Harness profiles found',
    message: 'No profile directory was found. Start DSH once or choose a different DSH_HOME.',
    evidence: displayPath(join(dshHome, 'profiles'), dshHome, includePaths), recoverability: 'manual',
  }))
  const profiles: ProfileReport[] = []
  for (const name of names) profiles.push(await inspectProfile(name, dshHome, includePaths, issues))
  await inspectSettings(dshHome, includePaths, issues)
  await inspectLogs(dshHome, includePaths, issues)
  await inspectSessionStore(dshHome, includePaths, issues)
  inspectRuntime(options.runtimeEntries ?? [], issues)
  inspectRuntimeModel(options.runtimeModel, issues)

  const version = profiles.find(profile => profile.dshVersion !== undefined)?.dshVersion ?? await detectCliVersion()
  if (version === undefined) issues.push(issue({
    code: 'DSH_VERSION_UNKNOWN', severity: 'warning', title: 'Harness version could not be detected',
    message: 'Doctor will keep all repairs conservative until the installed DSH version is known.',
    recoverability: 'manual',
  }))
  else if (semver.valid(version) === null || !semver.eq(version, SUPPORTED_DSH_VERSION)) issues.push(issue({
    code: 'DSH_VERSION_UNSUPPORTED', severity: 'warning', title: 'Harness version is outside the tested range',
    message: `Installed ${version}; v0.1.0 is tested with ${SUPPORTED_DSH_VERSION}. Mutating repairs are disabled.`,
    evidence: version, recoverability: 'none',
  }))

  if (options.online) {
    const latest = await onlineLatestVersion()
    issues.push(issue({
      code: latest === undefined ? 'ONLINE_CHECK_FAILED' : 'ONLINE_VERSION',
      severity: 'info', title: latest === undefined ? 'Online version check failed' : 'Latest published Harness version',
      message: latest === undefined ? 'The npm registry did not return version metadata.' : latest,
      evidence: latest, recoverability: 'none',
    }))
  }

  return {
    id: randomUUID(),
    environment: {
      doctorVersion: DOCTOR_VERSION,
      supportedDsh: SUPPORTED_DSH_VERSION,
      dshHome: displayPath(dshHome, dshHome, includePaths),
      node: process.version,
      platform: process.platform,
      online: options.online ?? false,
      generatedAt: new Date().toISOString(),
    },
    profiles,
    issues,
    summary: summarize(issues),
  }
}
