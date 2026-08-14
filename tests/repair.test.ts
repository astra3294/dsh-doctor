import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, describe, expect, it } from 'vitest'
import { createCheckpoint } from '../src/checkpoints.js'
import { DoctorEngine } from '../src/repair.js'
import { withFileLock } from '../src/fs-utils.js'

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

const DEFAULT_PATCH = '# Your patch layer for this dsh profile, applied after every bundle layer:\n# a top-level YAML array of loader patch entries (id-targeted config\n# overrides, disables, and insert lists).\n[]\n'

async function healthyFixture(): Promise<{ root: string; manifest: string }> {
  const root = await mkdtemp(join(tmpdir(), 'dsh-doctor-repair-'))
  roots.push(root)
  const profile = join(root, 'profiles', 'web')
  await mkdir(join(profile, 'node_modules', '@deepseek-ai', 'dsh'), { recursive: true })
  const manifest = join(profile, 'package.json')
  await writeFile(manifest, JSON.stringify({ dsh: { profile: { bundles: [] } }, dependencies: {} }, null, 2))
  await writeFile(join(profile, 'cordis.patch.yml'), DEFAULT_PATCH)
  await writeFile(join(profile, 'node_modules', '@deepseek-ai', 'dsh', 'package.json'), JSON.stringify({
    name: '@deepseek-ai/dsh', version: '0.1.0-rc.6',
  }))
  await createCheckpoint(root, 'web', 'healthy', true)
  return { root, manifest }
}

describe('DoctorEngine', () => {
  it('resets a proven-invalid file from the last healthy checkpoint', async () => {
    const { root, manifest } = await healthyFixture()
    await writeFile(manifest, '{broken')
    const engine = new DoctorEngine(root)
    const report = await engine.scan({ profile: 'web' })
    const plan = await engine.plan(report, { profile: 'web' })
    const reset = plan.actions.find(action => action.kind === 'reset-to-healthy')
    expect(reset).toBeDefined()
    const run = await engine.apply(plan.id, { actionIds: plan.actions.filter(action => action.risk === 'safe').map(action => action.id) })
    expect(run.phase).not.toBe('failed')
    const restored = await readFile(manifest, 'utf8')
    expect(() => JSON.parse(restored)).not.toThrow()
  })

  it('rejects a plan when profile files change after scanning', async () => {
    const { root, manifest } = await healthyFixture()
    const engine = new DoctorEngine(root)
    const report = await engine.scan({ profile: 'web' })
    const plan = await engine.plan(report, { profile: 'web' })
    await writeFile(manifest, JSON.stringify({ dsh: { profile: { bundles: ['changed'] } }, dependencies: {} }))
    await expect(engine.apply(plan.id)).rejects.toThrow('profile changed after scanning')
  })

  it('writes a disable entry into a real default cordis.patch.yml without corrupting it', async () => {
    const { root } = await healthyFixture()
    const engine = new DoctorEngine(root)
    const report = await engine.scan({
      profile: 'web',
      runtimeEntries: [{ entryId: 'broken-addon', moduleName: 'broken-addon', enabled: true, phase: 'failed' }],
    })
    const plan = await engine.plan(report, { profile: 'web' })
    const disable = plan.actions.find(action => action.kind === 'disable-plugin')
    expect(disable).toBeDefined()
    await expect(engine.apply(plan.id, { actionIds: [disable!.id] })).rejects.toThrow('explicit confirmation')
    const run = await engine.apply(plan.id, { actionIds: [disable!.id], confirmed: true })
    expect(run.phase).toBe('restart-required')
    const patch = await readFile(join(root, 'profiles', 'web', 'cordis.patch.yml'), 'utf8')
    expect(patch).toContain('id: broken-addon')
    expect(patch).toContain('disabled: true')
    // The result must stay ONE valid top-level YAML array (regression: the old
    // string-append produced a two-document stream that no loader can parse).
    const { parseDocument } = await import('yaml')
    const doc = parseDocument(patch)
    expect(doc.errors).toHaveLength(0)
    expect(Array.isArray(doc.toJS())).toBe(true)
    expect((doc.toJS() as Array<{ id?: string; disabled?: boolean }>).some(entry => entry.id === 'broken-addon' && entry.disabled === true)).toBe(true)
  })

  it('can re-enable a Doctor-disabled plugin (undisable-plugin)', async () => {
    const { root } = await healthyFixture()
    const profile = join(root, 'profiles', 'web')
    await writeFile(join(profile, 'cordis.patch.yml'), '- id: broken-addon\n  disabled: true\n')
    const engine = new DoctorEngine(root)
    const report = await engine.scan({ profile: 'web' })
    expect(report.issues.map(item => item.code)).toContain('PLUGIN_DISABLED')
    const plan = await engine.plan(report, { profile: 'web' })
    const action = plan.actions.find(item => item.kind === 'undisable-plugin')
    expect(action).toBeDefined()
    const run = await engine.apply(plan.id, { actionIds: [action!.id], confirmed: true })
    expect(run.phase).toBe('restart-required')
    const patch = await readFile(join(profile, 'cordis.patch.yml'), 'utf8')
    expect(patch).not.toContain('broken-addon')
  })

  it('never offers to disable a failed rescue-path plugin', async () => {
    const { root } = await healthyFixture()
    const engine = new DoctorEngine(root)
    const report = await engine.scan({
      profile: 'web',
      runtimeEntries: [{ entryId: 'ui-settings', moduleName: 'settings', enabled: true, phase: 'failed' }],
    })
    const plan = await engine.plan(report, { profile: 'web' })
    const action = plan.actions.find(item => item.issueCode === 'PLUGIN_RUNTIME_FAILED')
    expect(action?.kind).toBe('manual')
  })

  it('does not offer mutating recovery when the Harness version is unknown', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-doctor-unknown-version-'))
    roots.push(root)
    const profile = join(root, 'profiles', 'web')
    await mkdir(profile, { recursive: true })
    const manifest = join(profile, 'package.json')
    await writeFile(manifest, JSON.stringify({ dsh: { profile: { bundles: [] } }, dependencies: {} }))
    const engine = new DoctorEngine(root)
    const healthy = await createCheckpoint(root, 'web', 'healthy', true)
    await writeFile(manifest, '{broken')
    const report = await engine.scan({ profile: 'web' })
    const plan = await engine.plan(report, { profile: 'web' })
    expect(healthy.valid).toBe(true)
    expect(plan.actions.some(action => action.kind === 'reset-to-healthy')).toBe(false)
  })

  it('synthesizes a minimal manifest on a cold start (no healthy checkpoint)', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-doctor-coldstart-'))
    roots.push(root)
    const profile = join(root, 'profiles', 'web')
    await mkdir(join(profile, 'node_modules', '@deepseek-ai', 'dsh'), { recursive: true })
    await writeFile(join(profile, 'node_modules', '@deepseek-ai', 'dsh', 'package.json'), JSON.stringify({
      name: '@deepseek-ai/dsh', version: '0.1.0-rc.6',
    }))
    await writeFile(join(profile, 'package.json'), '{broken')
    const engine = new DoctorEngine(root)
    const report = await engine.scan({ profile: 'web' })
    const plan = await engine.plan(report, { profile: 'web' })
    const synthesize = plan.actions.find(action => action.kind === 'synthesize-manifest')
    expect(synthesize).toBeDefined()
    await expect(engine.apply(plan.id, { actionIds: [synthesize!.id] })).rejects.toThrow('explicit confirmation')
    const run = await engine.apply(plan.id, { actionIds: [synthesize!.id], confirmed: true })
    expect(run.phase).not.toBe('failed')
    const manifest = JSON.parse(await readFile(join(profile, 'package.json'), 'utf8')) as { dsh?: { profile?: { bundles?: string[] } } }
    expect(manifest.dsh?.profile?.bundles).toEqual(['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app'])
  })

  it('quarantines a corrupt session record without deleting it', async () => {
    const { root } = await healthyFixture()
    const sessions = join(root, 'sessions', 'ws')
    await mkdir(sessions, { recursive: true })
    const corrupt = join(sessions, 'session.jsonl.zstd')
    await writeFile(corrupt, 'garbage-not-zstd')
    const engine = new DoctorEngine(root)
    const report = await engine.scan({ profile: 'web' })
    expect(report.issues.map(item => item.code)).toContain('SESSION_STORE_CORRUPT')
    const plan = await engine.plan(report, { profile: 'web' })
    const action = plan.actions.find(item => item.kind === 'quarantine-session-file')
    expect(action).toBeDefined()
    const run = await engine.apply(plan.id, { actionIds: [action!.id], confirmed: true })
    expect(run.phase).not.toBe('failed')
    const entries = await readdir(sessions)
    expect(entries.some(name => name.startsWith('session.jsonl.zstd.doctor-quarantine-'))).toBe(true)
  })

  it('refuses to mark a profile healthy while errors remain', async () => {
    const { root, manifest } = await healthyFixture()
    await writeFile(manifest, '{broken')
    const engine = new DoctorEngine(root)
    await expect(engine.markHealthy('web', { dshHome: root })).rejects.toThrow('cannot be marked healthy')
  })

  it('reclaims a stale repair lock but honors a live one', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-doctor-lock-'))
    roots.push(root)
    const lock = join(root, 'doctor', 'repair.lock')
    await mkdir(join(root, 'doctor'), { recursive: true })
    await writeFile(lock, JSON.stringify({ pid: 999999999, startedAt: '2001-01-01T00:00:00.000Z' }))
    await expect(withFileLock(lock, async () => 'reclaimed')).resolves.toBe('reclaimed')
    await writeFile(lock, JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }))
    await expect(withFileLock(lock, async () => 'never')).rejects.toThrow('already running')
    await rm(lock, { force: true })
  })
})
