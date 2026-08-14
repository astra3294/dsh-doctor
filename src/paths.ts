import { homedir } from 'node:os'
import { isAbsolute, join, resolve } from 'node:path'

export function resolveDshHome(explicit?: string): string {
  const candidate = explicit ?? process.env.DSH_HOME
  if (candidate === undefined || candidate.trim() === '') return join(homedir(), '.dsh')
  if (candidate === '~') return homedir()
  if (candidate.startsWith('~/') || candidate.startsWith('~\\')) {
    return resolve(homedir(), candidate.slice(2))
  }
  return isAbsolute(candidate) ? candidate : resolve(candidate)
}

export function profileRoot(dshHome: string, profile: string): string {
  return join(dshHome, 'profiles', profile)
}

export function doctorRoot(dshHome: string): string {
  return join(dshHome, 'doctor')
}

export function symbolicPath(path: string, dshHome: string): string {
  const normalizedHome = resolve(dshHome)
  const normalizedPath = resolve(path)
  if (normalizedPath === normalizedHome) return '$DSH_HOME'
  if (normalizedPath.startsWith(`${normalizedHome}\\`) || normalizedPath.startsWith(`${normalizedHome}/`)) {
    return `$DSH_HOME${normalizedPath.slice(normalizedHome.length)}`
  }
  return '<external-path>'
}

/**
 * Inverse of {@link symbolicPath}: turn a display path back into an absolute
 * local path. Returns `undefined` for paths that are not repairable — the
 * `<external-path>` marker (outside DSH_HOME) is never a recovery target.
 */
export function resolveSymbolicPath(path: string, dshHome: string): string | undefined {
  const home = resolve(dshHome)
  if (path === '$DSH_HOME') return home
  if (path.startsWith('$DSH_HOME/') || path.startsWith('$DSH_HOME\\')) return join(home, path.slice('$DSH_HOME'.length + 1))
  if (path.startsWith('<')) return undefined
  return isAbsolute(path) ? path : resolve(path)
}

export function safeProfileName(value: string): string {
  if (!/^[A-Za-z0-9._-]+$/.test(value) || value === '.' || value === '..') {
    throw new Error(`invalid profile name: ${JSON.stringify(value)}`)
  }
  return value
}
