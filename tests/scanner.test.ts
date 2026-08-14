import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, describe, expect, it } from 'vitest'
import { scanHarness } from '../src/scanner.js'

const roots: string[] = []

async function fixture(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'dsh-doctor-test-'))
  roots.push(root)
  await mkdir(join(root, 'profiles', 'web'), { recursive: true })
  return root
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

describe('scanHarness', () => {
  it('reports an invalid profile manifest with a stable repair code', async () => {
    const root = await fixture()
    await writeFile(join(root, 'profiles', 'web', 'package.json'), '{broken')
    const report = await scanHarness({ dshHome: root, profile: 'web' })
    expect(report.issues).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'PROFILE_JSON_INVALID', severity: 'error', recoverability: 'automatic' }),
    ]))
    expect(report.summary.errors).toBeGreaterThan(0)
  })

  it('detects duplicate bundles and runtime plugin failures', async () => {
    const root = await fixture()
    await writeFile(join(root, 'profiles', 'web', 'package.json'), JSON.stringify({
      dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-base'] } },
      dependencies: {},
    }))
    const report = await scanHarness({
      dshHome: root,
      profile: 'web',
      runtimeEntries: [{ entryId: 'bad', moduleName: 'bad-plugin', enabled: true, phase: 'failed' }],
    })
    expect(report.issues.map(item => item.code)).toContain('DUPLICATE_BUNDLE')
    expect(report.issues.map(item => item.code)).toContain('PLUGIN_RUNTIME_FAILED')
  })

  it('never returns absolute paths unless includePaths is enabled', async () => {
    const root = await fixture()
    const manifest = join(root, 'profiles', 'web', 'package.json')
    await writeFile(manifest, '{broken')
    const safe = await scanHarness({ dshHome: root, profile: 'web' })
    expect(JSON.stringify(safe)).not.toContain(root)
    const detailed = await scanHarness({ dshHome: root, profile: 'web', includePaths: true })
    expect(detailed.environment.dshHome).toBe(root)
    expect(detailed.issues.find(item => item.code === 'PROFILE_JSON_INVALID')?.file).toContain(root)
  })

  it('reports unavailable model routes without inspecting credentials', async () => {
    const root = await fixture()
    await writeFile(join(root, 'profiles', 'web', 'package.json'), JSON.stringify({
      dsh: { profile: { bundles: [] } }, dependencies: {},
    }))
    const report = await scanHarness({
      dshHome: root,
      profile: 'web',
      runtimeModel: { provider: 'missing-provider', model: 'missing-model', providerAvailable: false },
    })
    expect(report.issues).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'MODEL_ROUTE_UNAVAILABLE', recoverability: 'manual' }),
    ]))
    expect(JSON.stringify(report)).not.toContain('missing-provider/missing-model/secret')
  })

  it('classifies credential failures from local logs without returning the log line', async () => {
    const root = await fixture()
    await writeFile(join(root, 'profiles', 'web', 'package.json'), JSON.stringify({
      dsh: { profile: { bundles: [] } }, dependencies: {},
    }))
    await mkdir(join(root, 'logs'), { recursive: true })
    await writeFile(join(root, 'logs', 'recent.log'), 'INVALID_CREDENTIAL api_key=super-secret-value')
    const report = await scanHarness({ dshHome: root, profile: 'web' })
    expect(report.issues.map(item => item.code)).toContain('CREDENTIAL_INVALID')
    expect(JSON.stringify(report)).not.toContain('super-secret-value')
  })
})
