import { readdir } from 'node:fs/promises'
import { join } from 'node:path'
import semver from 'semver'
import { atomicWrite, exists, readText } from './fs-utils.js'
import { doctorRoot } from './paths.js'
import type { DoctorIssue } from './types.js'
import builtinPatterns from './failure-patterns.json' with { type: 'json' }

export interface PatternHint {
  readonly en: string
  readonly zh: string
}

export interface PatternDetector {
  readonly type: string
  readonly params: Record<string, unknown>
}

export interface FailurePattern {
  readonly id: string
  readonly code: string
  readonly severity: 'error' | 'warning' | 'info'
  readonly source?: string
  readonly hint: PatternHint
  readonly detectors?: readonly PatternDetector[]
}

export interface PatternCatalog {
  readonly version: number
  readonly updatedAt?: string
  readonly patterns: readonly FailurePattern[]
}

export const BUILTIN_PATTERNS: PatternCatalog = builtinPatterns as unknown as PatternCatalog

export function knowledgeFile(dshHome: string): string {
  return join(doctorRoot(dshHome), 'knowledge', 'failure-patterns.json')
}

/** The fetched (community-updated) catalog, when the user has run `update`. */
export async function fetchedPatterns(dshHome: string): Promise<PatternCatalog | undefined> {
  const raw = await readText(knowledgeFile(dshHome))
  if (raw === undefined) return undefined
  try {
    const parsed = JSON.parse(raw) as PatternCatalog
    if (Array.isArray(parsed.patterns)) return parsed
  } catch {
    // A corrupt fetched catalog is ignored; the builtin one still applies.
  }
  return undefined
}

/** Fetched patterns override builtin ones by id; new ids extend the set. */
export async function mergedPatterns(dshHome: string): Promise<PatternCatalog> {
  const fetched = await fetchedPatterns(dshHome)
  if (fetched === undefined) return BUILTIN_PATTERNS
  const byId = new Map<string, FailurePattern>()
  for (const pattern of BUILTIN_PATTERNS.patterns) byId.set(pattern.id, pattern)
  for (const pattern of fetched.patterns) byId.set(pattern.id, pattern)
  return {
    version: BUILTIN_PATTERNS.version,
    updatedAt: fetched.updatedAt,
    patterns: [...byId.values()],
  }
}

export async function storeFetchedPatterns(dshHome: string, catalog: PatternCatalog): Promise<void> {
  await atomicWrite(knowledgeFile(dshHome), `${JSON.stringify(catalog, null, 2)}\n`)
}

/** Hint lookup over the merged catalog (fetched wins). */
export function patternHint(patterns: PatternCatalog, code: string): PatternHint | undefined {
  return patterns.patterns.find(pattern => pattern.code === code)?.hint
}

// ---------------------------------------------------------------------------
// Data-driven detectors. New simple patterns can ship as JSON rows instead of
// a code release. Detector types:
//   mixed-version-lines  { prefix: "@deepseek-ai/" } — flag packages under
//                        profiles/node_modules whose versions span multiple
//                        major.minor.patch lines.
// ---------------------------------------------------------------------------

async function detectMixedVersionLines(dshHome: string, params: Record<string, unknown>, issues: DoctorIssue[]): Promise<void> {
  const prefix = typeof params.prefix === 'string' ? params.prefix : '@deepseek-ai/'
  const scoped = prefix.startsWith('@') && prefix.endsWith('/')
  const base = scoped ? join(dshHome, 'profiles', 'node_modules', prefix.slice(0, -1)) : join(dshHome, 'profiles', 'node_modules')
  if (!await exists(base)) return
  let names: string[]
  try {
    names = (await readdir(base, { withFileTypes: true })).filter(entry => entry.isDirectory()).map(entry => entry.name)
  } catch {
    return
  }
  const lines = new Map<string, string[]>()
  for (const name of names) {
    const packageName = scoped ? `${prefix}${name}` : name
    const raw = await readText(join(base, name, 'package.json'))
    if (raw === undefined) continue
    try {
      const version = (JSON.parse(raw) as { version?: string }).version
      if (typeof version !== 'string') continue
      const parsed = semver.parse(version)
      if (parsed === null) continue
      const line = `${parsed.major}.${parsed.minor}.${parsed.patch}`
      const existing = lines.get(line) ?? []
      existing.push(`${packageName}@${version}`)
      lines.set(line, existing)
    } catch {
      continue
    }
  }
  if (lines.size > 1) {
    const detail = [...lines.entries()].map(([line, packages]) => `${line}: ${packages.join(', ')}`).join(' | ')
    issues.push({
      code: 'DSH_VERSION_LINE_MIX', severity: 'warning',
      title: 'Installed @deepseek-ai packages span multiple version lines',
      message: detail,
      evidence: detail, recoverability: 'manual',
    })
  }
}

/** Run every data-driven detector in the merged catalog. */
export async function runKnowledgeDetectors(dshHome: string, catalog: PatternCatalog, issues: DoctorIssue[]): Promise<void> {
  for (const pattern of catalog.patterns) {
    for (const detector of pattern.detectors ?? []) {
      if (detector.type === 'mixed-version-lines') {
        await detectMixedVersionLines(dshHome, detector.params, issues)
      }
    }
  }
}
