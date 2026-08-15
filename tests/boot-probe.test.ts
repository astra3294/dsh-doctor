import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, describe, expect, it } from 'vitest'
import { analyzeBootFailure, probeBoot, probeCommand } from '../src/boot-probe.js'

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

describe('analyzeBootFailure', () => {
  it('maps patch parse failures', () => {
    const issues = analyzeBootFailure('Error: failed to parse patches ...', { port: 3080 })
    expect(issues.map(item => item.code)).toContain('CORDIS_PATCH_INVALID')
  })

  it('maps missing modules', () => {
    const issues = analyzeBootFailure("Error: Cannot find module 'some-pkg'", { port: 3080 })
    expect(issues.some(item => item.code === 'PROFILE_DEPENDENCY_MISSING' && item.evidence === 'some-pkg')).toBe(true)
  })

  it('maps port conflicts', () => {
    const issues = analyzeBootFailure('EADDRINUSE: address already in use', { port: 3080 })
    expect(issues.map(item => item.code)).toContain('PORT_IN_USE')
  })

  it('maps plugin boot crashes', () => {
    const issues = analyzeBootFailure('failed to load "my-plugin" during boot', { port: 3080 })
    expect(issues.some(item => item.code === 'PLUGIN_RUNTIME_FAILED' && item.evidence === 'my-plugin')).toBe(true)
  })

  it('falls back to a generic boot failure', () => {
    const issues = analyzeBootFailure('something unexpected', { port: 3080 })
    expect(issues.map(item => item.code)).toEqual(['BOOT_PROBE_FAILED'])
  })

  it('redacts credentials in evidence', () => {
    const issues = analyzeBootFailure('failed with token: sk-1234567890abcdef', { port: 3080 })
    const evidence = issues.map(item => item.evidence ?? '').join(' ')
    expect(evidence).not.toContain('sk-1234567890abcdef')
    expect(evidence).toContain('<redacted>')
  })
})

describe('probeBoot', () => {
  it('reports passed when the child opens the port', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-doctor-boot-'))
    roots.push(root)
    const port = 32000 + Math.floor(Math.random() * 1000)
    const script = join(root, 'opens-port.cjs')
    await writeFile(script, `const net=require('net');net.createServer(()=>{}).listen(${port},'127.0.0.1');setInterval(()=>{},1000)`)
    const result = await probeBoot({ command: [process.execPath, script], port, timeoutMs: 15000 })
    expect(result.status).toBe('passed')
  })

  it('reports failed with mapped issues when the child exits', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-doctor-boot-'))
    roots.push(root)
    const port = 33000 + Math.floor(Math.random() * 1000)
    const script = join(root, 'fails.cjs')
    await writeFile(script, `console.error("Error: failed to parse patches file");process.exit(1)`)
    const result = await probeBoot({ command: [process.execPath, script], port, timeoutMs: 15000 })
    expect(result.status).toBe('failed')
    expect(result.issues.map(item => item.code)).toContain('CORDIS_PATCH_INVALID')
  })
})

describe('probeCommand (issue #3 regression)', () => {
  it('passes --profile for a real dsh invocation', () => {
    expect(probeCommand(undefined, 'web', 'win32')).toEqual(['dsh.cmd', '--profile', 'web'])
    expect(probeCommand(undefined, 'headless', 'linux')).toEqual(['dsh', '--profile', 'headless'])
    expect(probeCommand(undefined, undefined, 'linux')).toEqual(['dsh', '--profile', 'web'])
  })

  it('passes custom commands through untouched (test harnesses)', () => {
    expect(probeCommand(['node', 'fake.js'], 'web', 'win32')).toEqual(['node', 'fake.js'])
  })
})
