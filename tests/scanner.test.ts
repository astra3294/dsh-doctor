import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { join, parse } from 'node:path'
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

describe('mined failure patterns (0.2.1)', () => {
  async function withManifest(root: string, manifest: object, bundles: string[] = []): Promise<void> {
    await writeFile(join(root, 'profiles', 'web', 'package.json'), JSON.stringify({
      dsh: { profile: { bundles } },
      ...manifest,
    }, null, 2))
  }

  it('flags a `.env` directory (EISDIR pattern)', async () => {
    const root = await fixture()
    await withManifest(root, { dependencies: {} })
    await mkdir(join(root, '.env'), { recursive: true })
    const report = await scanHarness({ dshHome: root, profile: 'web' })
    expect(report.issues.map(item => item.code)).toContain('DOTENV_DIRECTORY')
  })

  it('flags a workspace path with UTF-16 truncation characters', async () => {
    const root = await fixture()
    await withManifest(root, { dependencies: {} })
    await mkdir(join(root, 'storages'), { recursive: true })
    await writeFile(join(root, 'storages', 'workspace.json'), JSON.stringify([{ path: `C:\\temp\\开`, title: 'x' }]))
    const report = await scanHarness({ dshHome: root, profile: 'web' })
    expect(report.issues.map(item => item.code)).toContain('UTF16_PATH_TRUNCATION')
  })

  it('flags a filesystem root registered as a workspace', async () => {
    const root = await fixture()
    await withManifest(root, { dependencies: {} })
    await mkdir(join(root, 'storages'), { recursive: true })
    const fsRoot = parse(root).root
    await writeFile(join(root, 'storages', 'workspace.json'), JSON.stringify([{ path: fsRoot, title: 'root' }]))
    const report = await scanHarness({ dshHome: root, profile: 'web' })
    expect(report.issues.map(item => item.code)).toContain('ROOT_WORKSPACE')
  })

  it('flags a linked plugin that cannot resolve @deepseek-ai packages', async () => {
    const root = await fixture()
    await mkdir(join(root, 'my-plug'), { recursive: true })
    await writeFile(join(root, 'my-plug', 'package.json'), JSON.stringify({ name: 'my-plug', main: 'index.js' }))
    await writeFile(join(root, 'my-plug', 'index.js'), "import cordis from '@deepseek-ai/cordis'\nexport default cordis\n")
    await withManifest(root, { dependencies: { 'my-plug': `link:${join(root, 'my-plug')}` } })
    const report = await scanHarness({ dshHome: root, profile: 'web' })
    expect(report.issues.map(item => item.code)).toContain('LINKED_PLUGIN_RESOLUTION')
  })

  it('does not flag a linked plugin that avoids @deepseek-ai imports', async () => {
    const root = await fixture()
    await mkdir(join(root, 'my-plug'), { recursive: true })
    await writeFile(join(root, 'my-plug', 'package.json'), JSON.stringify({ name: 'my-plug', main: 'index.js' }))
    await writeFile(join(root, 'my-plug', 'index.js'), 'export default {}\n')
    await withManifest(root, { dependencies: { 'my-plug': `link:${join(root, 'my-plug')}` } })
    const report = await scanHarness({ dshHome: root, profile: 'web' })
    expect(report.issues.map(item => item.code)).not.toContain('LINKED_PLUGIN_RESOLUTION')
  })

  it('flags a plugin-looking dependency that is not mounted as a bundle', async () => {
    const root = await fixture()
    await withManifest(root, { dependencies: { 'dsh-ghost-plugin': '^1.0.0' } })
    const report = await scanHarness({ dshHome: root, profile: 'web' })
    expect(report.issues.map(item => item.code)).toContain('INACTIVE_PLUGIN_DEPENDENCY')
  })

  it('flags an unresolvable patch insert name', async () => {
    const root = await fixture()
    await withManifest(root, { dependencies: {} })
    await writeFile(join(root, 'profiles', 'web', 'cordis.patch.yml'), '- insert:\n    - id: ghost\n      name: ghost-package-xyz\n')
    const report = await scanHarness({ dshHome: root, profile: 'web' })
    expect(report.issues.map(item => item.code)).toContain('PATCH_NAME_UNRESOLVED')
  })

  it('flags a bare drive path in a patch insert name', async () => {
    const root = await fixture()
    await withManifest(root, { dependencies: {} })
    await writeFile(join(root, 'profiles', 'web', 'cordis.patch.yml'), '- insert:\n    - id: ghost\n      name: D:/some/plugin\n')
    const report = await scanHarness({ dshHome: root, profile: 'web' })
    expect(report.issues.map(item => item.code)).toContain('PATCH_PATH_NOT_URL')
  })

  it('flags a peer dependency on the wrong @deepseek-ai version line', async () => {
    const root = await fixture()
    await withManifest(root, { dependencies: { badplug: '^1.0.0' } })
    await mkdir(join(root, 'profiles', 'node_modules', '@deepseek-ai', 'dsh-tools'), { recursive: true })
    await writeFile(join(root, 'profiles', 'node_modules', '@deepseek-ai', 'dsh-tools', 'package.json'), JSON.stringify({ name: '@deepseek-ai/dsh-tools', version: '0.0.1-rc.1' }))
    await mkdir(join(root, 'profiles', 'web', 'node_modules', 'badplug'), { recursive: true })
    await writeFile(join(root, 'profiles', 'web', 'node_modules', 'badplug', 'package.json'), JSON.stringify({
      name: 'badplug', version: '1.0.0', peerDependencies: { '@deepseek-ai/dsh-tools': '^0.1.0-rc.6' },
    }))
    const report = await scanHarness({ dshHome: root, profile: 'web' })
    expect(report.issues.map(item => item.code)).toContain('PLUGIN_PEER_MISMATCH')
  })

  it('flags the web bundle disabling skills by default', async () => {
    const root = await fixture()
    await withManifest(root, { dependencies: {} })
    await mkdir(join(root, 'profiles', 'node_modules', '@deepseek-ai', 'dsh-web-app'), { recursive: true })
    await writeFile(join(root, 'profiles', 'node_modules', '@deepseek-ai', 'dsh-web-app', 'package.json'), JSON.stringify({
      name: '@deepseek-ai/dsh-web-app', version: '0.1.0-rc.6', dsh: { bundle: { patch: './cordis.patch.yml' } },
    }))
    await writeFile(join(root, 'profiles', 'node_modules', '@deepseek-ai', 'dsh-web-app', 'cordis.patch.yml'), '- id: skill-filesystem\n  disabled: true\n- id: tool-skill\n  disabled: true\n')
    const report = await scanHarness({ dshHome: root, profile: 'web' })
    expect(report.issues.map(item => item.code)).toContain('WEB_SKILL_DISABLED')
  })

  it('flags a risky koffi version', async () => {
    const root = await fixture()
    await withManifest(root, { dependencies: {} })
    await mkdir(join(root, 'profiles', 'node_modules', 'koffi'), { recursive: true })
    await writeFile(join(root, 'profiles', 'node_modules', 'koffi', 'package.json'), JSON.stringify({ name: 'koffi', version: '3.0.0' }))
    const report = await scanHarness({ dshHome: root, profile: 'web' })
    expect(report.issues.map(item => item.code)).toContain('KOFFI_VERSION_RISK')
  })

  it('flags a Node version outside the Harness engine range', async () => {
    const root = await fixture()
    await withManifest(root, { dependencies: {} })
    await mkdir(join(root, 'profiles', 'node_modules', '@deepseek-ai', 'dsh'), { recursive: true })
    await writeFile(join(root, 'profiles', 'node_modules', '@deepseek-ai', 'dsh', 'package.json'), JSON.stringify({
      name: '@deepseek-ai/dsh', version: '0.1.0-rc.6', engines: { node: '^22.19.0 || >=24.0.0' },
    }))
    const report = await scanHarness({ dshHome: root, profile: 'web', nodeVersion: 'v20.0.0' })
    expect(report.issues.map(item => item.code)).toContain('NODE_VERSION_UNSUPPORTED')
  })

  it('flags mixed @deepseek-ai version lines via the knowledge layer', async () => {
    const root = await fixture()
    await withManifest(root, { dependencies: {} })
    for (const entry of [['alpha', '0.0.1-rc.1'], ['beta', '0.1.0-rc.6']] as const) {
      const [name, version] = entry
      await mkdir(join(root, 'profiles', 'node_modules', '@deepseek-ai', name), { recursive: true })
      await writeFile(join(root, 'profiles', 'node_modules', '@deepseek-ai', name, 'package.json'), JSON.stringify({ name: `@deepseek-ai/${name}`, version }))
    }
    const report = await scanHarness({ dshHome: root, profile: 'web' })
    expect(report.issues.map(item => item.code)).toContain('DSH_VERSION_LINE_MIX')
  })
})
