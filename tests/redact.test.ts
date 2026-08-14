import { describe, expect, it } from 'vitest'
import { redactSecrets, safeEvidence } from '../src/redact.js'

describe('redaction', () => {
  it('removes API keys and bearer tokens', () => {
    const value = redactSecrets('api_key=sk-supersecret123 Bearer abc.def.ghi')
    expect(value).not.toContain('supersecret')
    expect(value).not.toContain('abc.def.ghi')
    expect(value).toContain('<redacted>')
  })

  it('symbolizes DSH_HOME in evidence', () => {
    expect(safeEvidence('C:\\Users\\tester\\.dsh\\settings.yaml', 'C:\\Users\\tester\\.dsh', false))
      .toBe('$DSH_HOME\\settings.yaml')
  })
})
