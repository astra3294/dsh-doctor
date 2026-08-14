import { symbolicPath } from './paths.js'

const SECRET_PATTERNS = [
  /\b(sk-[A-Za-z0-9_-]{8,})\b/g,
  /\b(Bearer\s+)[A-Za-z0-9._~+\/-]+=*/gi,
  /((?:api[_-]?key|token|secret|password)\s*[:=]\s*)[^\s,;]+/gi,
]

export function redactSecrets(value: string): string {
  return SECRET_PATTERNS.reduce((current, pattern) => current.replace(pattern, (_match, prefix?: string) => `${prefix ?? ''}<redacted>`), value)
}

export function displayPath(path: string, dshHome: string, includePaths: boolean): string {
  return includePaths ? path : symbolicPath(path, dshHome)
}

export function safeEvidence(value: string, dshHome: string, includePaths: boolean): string {
  const pathSafe = includePaths ? value : value.split(dshHome).join('$DSH_HOME')
  return redactSecrets(pathSafe)
}
