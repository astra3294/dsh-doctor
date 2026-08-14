import { DOCTOR_VERSION } from './constants.js'
import { ISSUE_HINTS } from './hints.js'
import { redactSecrets } from './redact.js'
import type { DoctorIssue, DoctorRun, DoctorScanReport } from './types.js'

/** What the user sees before anything leaves the machine. */
export interface ReportPayload {
  readonly doctorVersion: string
  readonly node: string
  readonly platform: string
  readonly dshVersion?: string
  readonly summary: { errors: number; warnings: number; info: number }
  readonly rootCause: string
  readonly issues: readonly {
    code: string
    severity: string
    title: string
    message: string
    evidence?: string
    hint?: string
  }[]
  readonly recovery?: {
    phase: string
    results: readonly string[]
    error?: string
  }
}

/** Conservative local-path masking on top of secret redaction. */
export function maskLocalPaths(value: string): string {
  return redactSecrets(value)
    .replace(/[A-Za-z]:[\\/][^\s,;"']+/g, '<local-path>')
    .replace(/(?:\/(?:home|Users|root)\/)[^\s,;"']+/g, '<local-path>')
}

export function rootCauseSummary(report: DoctorScanReport): string {
  const counts = new Map<string, number>()
  for (const item of report.issues) {
    if (item.severity !== 'error' && item.severity !== 'warning') continue
    counts.set(item.code, (counts.get(item.code) ?? 0) + 1)
  }
  if (counts.size === 0) return 'no blocking findings'
  return [...counts.entries()].sort((a, b) => b[1] - a[1]).map(([code, count]) => `${code}×${String(count)}`).join(', ')
}

function safeIssue(item: DoctorIssue, dshHome: string): ReportPayload['issues'][number] {
  const hint = ISSUE_HINTS[item.code]
  return {
    code: item.code,
    severity: item.severity,
    title: item.title,
    message: item.message,
    ...(item.evidence === undefined ? {} : { evidence: maskLocalPaths(String(item.evidence).split(dshHome).join('$DSH_HOME')) }),
    ...(hint === undefined ? {} : { hint: hint.en }),
  }
}

/** Build the redacted, opt-in payload a user may submit. */
export function buildReportPayload(report: DoctorScanReport, recovery?: DoctorRun, dshHome?: string): ReportPayload {
  const home = dshHome ?? process.env.DSH_HOME ?? ''
  return {
    doctorVersion: DOCTOR_VERSION,
    node: report.environment.node,
    platform: report.environment.platform,
    dshVersion: report.profiles.find(profile => profile.dshVersion !== undefined)?.dshVersion,
    summary: report.summary,
    rootCause: rootCauseSummary(report),
    issues: report.issues.map(item => safeIssue(item, home)),
    ...(recovery === undefined ? {} : { recovery: {
      phase: recovery.phase,
      results: recovery.results.map(result => result.message),
      ...(recovery.error === undefined ? {} : { error: maskLocalPaths(recovery.error) }),
    } }),
  }
}

export function renderIssueMarkdown(payload: ReportPayload): string {
  const lines: string[] = [
    `### Environment`,
    `- dsh-doctor ${payload.doctorVersion} · Node ${payload.node} · ${payload.platform}`,
    `- Harness ${payload.dshVersion ?? 'unknown'} · ${payload.summary.errors} error(s), ${payload.summary.warnings} warning(s), ${payload.summary.info} info`,
    ``,
    `### Root cause`,
    payload.rootCause,
    ``,
    `### Findings`,
  ]
  for (const item of payload.issues) {
    lines.push(`- [${item.severity.toUpperCase()}] ${item.code}: ${item.title}`)
    lines.push(`  ${item.message}`)
    if (item.evidence !== undefined) lines.push(`  evidence: ${item.evidence}`)
    if (item.hint !== undefined) lines.push(`  💡 ${item.hint}`)
  }
  if (payload.recovery !== undefined) {
    lines.push('', '### Recovery outcome', `phase: ${payload.recovery.phase}`)
    for (const result of payload.recovery.results) lines.push(`- ${result}`)
    if (payload.recovery.error !== undefined) lines.push(`error: ${payload.recovery.error}`)
  }
  lines.push('', '> Submitted via `dsh-doctor report` (redacted: no keys, no absolute paths).')
  return lines.join('\n')
}

/** Pre-filled GitHub new-issue URL for the payload. */
export function reportIssueUrl(repo: string, payload: ReportPayload): string {
  const title = encodeURIComponent(`[doctor-report] ${payload.rootCause} (Node ${payload.node}, ${payload.platform})`)
  const body = encodeURIComponent(renderIssueMarkdown(payload))
  return `https://github.com/${repo}/issues/new?title=${title}&body=${body}`
}
