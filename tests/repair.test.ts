import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, describe, expect, it } from 'vitest'
import { createCheckpoint } from '../src/checkpoints.js'
import { DoctorEngine } from '../src/repair.js'

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

async function healthyFixture(): Promise<{ root: string; manifest: string }> {
  const root = await mkdtemp(join(tmpdir(), 'dsh-doctor-repair-'))
  roots.push(root)
  const profile = join(root, 'profiles', 'web')
  await mkdir(join(profile, 'node_modules', '@deepseek-ai', 'dsh'), { recursive: true })
  const manifest = join(profile, 'package.json')
  await writeFile(manifest, JSON.stringify({ dsh: { profile: { bundles: [] } }, dependencies: {} }, null, 2))
  await writeFile(join(profile, 'node_modules', '@deepseek-ai', 'dsh', 'package.json'), JSON.stringify({
    name: '@deepseek-ai/dsh', version: '0.1.0-rc.6',
  }))
  await createCheckpoint(root, 'web', 'healthy', true)
  return { root, manifest }
}

describe('DoctorEngine', () => {
  it('restores a proven-invalid file from the last healthy checkpoint', async () => {
    const { root, manifest } = await healthyFixture()
    await writeFile(manifest, '{broken')
    const engine = new DoctorEngine(root)
    const report = await engine.scan({ profile: 'web' })
    const plan = await engine.plan(report, { profile: 'web' })
    const restore = plan.actions.find(action => action.kind === 'restore-checkpoint-file')
    expect(restore).toBeDefined()
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

  it('requires confirmation before disabling a failed third-party plugin', async () => {
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
    expect(plan.actions.some(action => action.kind === 'restore-checkpoint-file')).toBe(false)
  })
})
