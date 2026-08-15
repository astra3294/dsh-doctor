import { readdir } from 'node:fs/promises'
import { join } from 'node:path'
import semver from 'semver'
import { parseDocument, YAMLMap, YAMLSeq } from 'yaml'
import { exists, readText } from './fs-utils.js'

export type CheckLevel = 'ok' | 'warn' | 'danger'

export interface PluginFinding {
  readonly level: CheckLevel
  readonly check: string
  readonly message: string
}

/** Secret patterns mirrored from the runtime redactor (detection only). */
const SECRET_PATTERNS = [
  /\b(sk-[A-Za-z0-9_-]{8,})/g,
  /\b(Bearer\s+)[A-Za-z0-9._~+\/-]{8,}/gi,
  /((?:api[_-]?key|token|secret|password)\s*[:=]\s*)[^\s,;]{8,}/gi,
]

const IGNORED_DIRS = new Set(['node_modules', '.git', 'lib', 'dist', '.vite', 'coverage'])
const TEXT_EXTENSIONS = /\.(?:ts|tsx|js|mjs|cjs|json|yml|yaml|md|txt|env|example)$/i

async function scanSecrets(dir: string, findings: PluginFinding[], depth = 0): Promise<void> {
  if (depth > 4 || !await exists(dir)) return
  let entries
  try {
    entries = await readdir(dir, { withFileTypes: true })
  } catch {
    return
  }
  for (const entry of entries) {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) {
      if (IGNORED_DIRS.has(entry.name) || entry.name.startsWith('.') || /(?:^|[\\/])(?:test|tests|spec|specs|__tests__)(?:[\\/]|$)/i.test(entry.name)) continue
      await scanSecrets(path, findings, depth + 1)
      continue
    }
    if (!TEXT_EXTENSIONS.test(entry.name)) continue
    if (entry.name === 'package.json' || /\.(?:test|spec)\./i.test(entry.name)) continue
    const raw = await readText(path)
    if (raw === undefined || raw.length > 512 * 1024) continue
    for (const pattern of SECRET_PATTERNS) {
      if (pattern.test(raw)) {
        findings.push({
          level: 'danger', check: 'secrets',
          message: `Possible credential in ${path} (matched pattern). Remove it and rotate the credential.`,
        })
        break
      }
    }
  }
}

interface PatchInsert {
  readonly id?: string
  readonly name?: string
}

function patchInserts(raw: string): PatchInsert[] {
  const doc = parseDocument(raw)
  if (doc.errors.length > 0 || !(doc.contents instanceof YAMLSeq)) return []
  const entries: PatchInsert[] = []
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

async function installedVersion(dshHome: string, packageName: string): Promise<string | undefined> {
  const segments = packageName.startsWith('@') ? packageName.split('/') : [packageName]
  const candidates = [
    join(dshHome, 'profiles', 'node_modules', ...segments, 'package.json'),
    join(dshHome, 'profiles', 'web', 'node_modules', ...segments, 'package.json'),
  ]
  for (const candidate of candidates) {
    const raw = await readText(candidate)
    if (raw === undefined) continue
    try {
      return (JSON.parse(raw) as { version?: string }).version
    } catch {
      return undefined
    }
  }
  return undefined
}

/**
 * Static pre-publish examination of a plugin directory: the four dimensions
 * the ecosystem radar validates (patch / seam symbols / peerDeps / build
 * artifacts) plus the secret scan. Deterministic, read-only.
 */
export async function checkPlugin(pluginDir: string, dshHome: string): Promise<PluginFinding[]> {
  const findings: PluginFinding[] = []

  const manifestPath = join(pluginDir, 'package.json')
  const manifestRaw = await readText(manifestPath)
  if (manifestRaw === undefined) {
    findings.push({ level: 'danger', check: 'manifest', message: 'package.json is missing; this is not a publishable package.' })
    return findings
  }
  let manifest: {
    name?: string
    main?: string
    version?: string
    scripts?: Record<string, string>
    peerDependencies?: Record<string, string>
    dsh?: { bundle?: { patch?: unknown }; client?: { inject?: unknown } }
  }
  try {
    manifest = JSON.parse(manifestRaw) as typeof manifest
  } catch (error) {
    findings.push({ level: 'danger', check: 'manifest', message: `package.json cannot be parsed: ${String(error)}` })
    return findings
  }

  // Dimension 1: bundle declaration (the silent no-op pitfall).
  const patchName = typeof manifest.dsh?.bundle?.patch === 'string' ? manifest.dsh.bundle.patch : undefined
  if (patchName === undefined) {
    findings.push({ level: 'danger', check: 'bundle', message: 'Missing dsh.bundle.patch — the plugin installs as a plain dependency and never mounts.' })
  } else if (!await exists(join(pluginDir, patchName))) {
    findings.push({ level: 'danger', check: 'bundle', message: `dsh.bundle.patch points at ${patchName}, which does not exist in the package.` })
  }

  // Dimension 2: patch shape and resolvable names.
  if (patchName !== undefined) {
    const rawPatch = await readText(join(pluginDir, patchName))
    if (rawPatch === undefined) {
      findings.push({ level: 'danger', check: 'patch', message: `${patchName} is missing.` })
    } else {
      const doc = parseDocument(rawPatch)
      if (doc.errors.length > 0) {
        findings.push({ level: 'danger', check: 'patch', message: `${patchName} is not valid YAML: ${doc.errors.map(error => error.message).join('; ')}` })
      } else if (!(doc.contents instanceof YAMLSeq)) {
        findings.push({ level: 'danger', check: 'patch', message: `${patchName} must be a top-level YAML array of loader patch entries.` })
      } else {
        const inserts = patchInserts(rawPatch)
        if (inserts.length === 0) {
          findings.push({ level: 'warn', check: 'patch', message: `${patchName} contains no insert entries; the plugin may never be mounted.` })
        }
        for (const entry of inserts) {
          if (entry.id === undefined || entry.name === undefined) {
            findings.push({ level: 'danger', check: 'patch', message: 'An insert entry is missing id or name.' })
            continue
          }
          if (/^[A-Za-z]:[\\/]/.test(entry.name)) {
            findings.push({ level: 'danger', check: 'patch', message: `"${entry.name}" is a bare drive path; loader names must be package names or file:/// URLs.` })
            continue
          }
          if (/^file:\/\//i.test(entry.name)) continue
          if (entry.name !== manifest.name) {
            findings.push({ level: 'warn', check: 'patch', message: `Insert name "${entry.name}" does not match the package name "${manifest.name ?? '(none)'}" — the loader imports it as a module name.` })
          }
        }
      }
    }
  }

  // Dimension 3: seam symbols (inject must be a string array).
  if (typeof manifest.main === 'string') {
    const entryRaw = await readText(join(pluginDir, manifest.main))
    if (entryRaw !== undefined) {
      if (/export\s+(?:const|let|var)\s+inject\s*=\s*\{/.test(entryRaw)) {
        findings.push({ level: 'danger', check: 'seam', message: 'inject is declared as an object; cordis treats object keys as service names and the plugin waits forever (the classic pending pitfall). Use a string array.' })
      } else if (/export\s+(?:const|let|var)\s+inject\s*=\s*\[/.test(entryRaw)) {
        findings.push({ level: 'ok', check: 'seam', message: 'inject is a string array.' })
      }
    } else if (await exists(join(pluginDir, manifest.main))) {
      findings.push({ level: 'danger', check: 'build', message: `Entry file ${manifest.main} exists but is unreadable.` })
    } else {
      findings.push({ level: 'danger', check: 'build', message: `Entry file ${manifest.main} is missing — run the build before publishing.` })
    }
  }

  // Dimension 4: peer dependencies vs the installed line (three tiers).
  for (const [peerName, range] of Object.entries(manifest.peerDependencies ?? {})) {
    if (!peerName.startsWith('@deepseek-ai/')) continue
    const installed = await installedVersion(dshHome, peerName)
    if (installed === undefined) {
      findings.push({ level: 'danger', check: 'peers', message: `${peerName}@${range} is not installed in the profile — the plugin will crash on mount.` })
    } else if (!semver.satisfies(installed, range, { includePrerelease: true })) {
      findings.push({ level: 'danger', check: 'peers', message: `${peerName} wants ${range}, but the profile has ${installed} (version-line mismatch).` })
    } else {
      findings.push({ level: 'ok', check: 'peers', message: `${peerName}@${range} matches the installed ${installed}.` })
    }
  }

  await scanSecrets(pluginDir, findings)
  if (!findings.some(finding => finding.level === 'danger')) {
    findings.push({ level: 'ok', check: 'summary', message: 'No blocking findings — safe to publish.' })
  }
  return findings
}
