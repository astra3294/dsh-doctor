import { describe, expect, it } from 'vitest'
import { buildReportPayload, maskLocalPaths, renderIssueMarkdown } from '../src/report.js'
import type { DoctorScanReport } from '../src/types.js'

const baseReport: DoctorScanReport = {
  id: 'r1',
  environment: {
    doctorVersion: '0.2.1', supportedDsh: '0.1.0-rc.6', dshHome: '$DSH_HOME',
    node: 'v24.15.0', platform: 'win32', online: false, generatedAt: new Date().toISOString(),
  },
  profiles: [{ name: 'web', path: '$DSH_HOME/profiles/web', exists: true, dependencies: [], bundles: [] }],
  issues: [],
  summary: { errors: 0, warnings: 0, info: 0 },
}

describe('report redaction', () => {
  it('masks secrets and local paths', () => {
    const masked = maskLocalPaths('token: sk-abc123456789012345 and C:\\Users\\alice\\secret.txt and /home/alice/x')
    expect(masked).not.toContain('sk-abc123456789012345')
    expect(masked).not.toContain('C:\\Users\\alice')
    expect(masked).not.toContain('/home/alice')
    expect(masked).toContain('<redacted>')
    expect(masked).toContain('<local-path>')
  })

  it('builds a redacted payload with human hints', () => {
    const report: DoctorScanReport = {
      ...baseReport,
      issues: [{
        code: 'NON_REGISTRY_DEPENDENCY', severity: 'warning', title: 'Non-registry dependency detected',
        message: 'dsh-doctor uses a non-registry source.', evidence: 'link:E:/dsh-doctor', recoverability: 'manual',
      }],
      summary: { errors: 0, warnings: 1, info: 0 },
    }
    const payload = buildReportPayload(report, undefined, 'C:\\Users\\alice\\.dsh')
    expect(payload.issues[0]?.evidence).not.toContain('E:/dsh-doctor')
    expect(payload.issues[0]?.evidence).toContain('<local-path>')
    expect(payload.issues[0]?.hint).toBeDefined()
  })

  it('renders markdown suitable for a GitHub issue', () => {
    const markdown = renderIssueMarkdown(buildReportPayload(baseReport))
    expect(markdown).toContain('### Findings')
    expect(markdown).toContain('dsh-doctor')
    expect(markdown).toContain('### Environment')
  })
})
