import { describe, expect, it } from 'vitest'
import { relaunchScript } from '../src/restart.js'

describe('relaunchScript', () => {
  it('launches the platform dsh command with the profile', () => {
    expect(relaunchScript('win32', 'web')).toContain('"dsh.cmd"')
    expect(relaunchScript('win32', 'web')).toContain("['--profile', \"web\"]")
    expect(relaunchScript('linux', 'headless')).toContain('"dsh"')
    expect(relaunchScript('linux', 'headless')).toContain("['--profile', \"headless\"]")
  })

  it('detaches from the helper and waits before relaunching', () => {
    const script = relaunchScript('linux', 'web')
    expect(script).toContain('detached: true')
    expect(script).toContain('setTimeout')
    expect(script).toContain('p.unref()')
  })
})
