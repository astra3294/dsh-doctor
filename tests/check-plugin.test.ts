import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, describe, expect, it } from 'vitest'
import { checkPlugin } from '../src/check-plugin.js'

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

async function fixtureHome(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'dsh-doctor-checkplugin-'))
  roots.push(root)
  await mkdir(join(root, 'profiles', 'node_modules', '@deepseek-ai', 'cordis'), { recursive: true })
  await writeFile(join(root, 'profiles', 'node_modules', '@deepseek-ai', 'cordis', 'package.json'), JSON.stringify({ name: '@deepseek-ai/cordis', version: '4.0.1' }))
  return root
}

async function fixturePlugin(overrides: {
  manifest?: object
  patch?: string
  entry?: string
  extra?: [string, string][]
} = {}): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-doctor-plugin-'))
  roots.push(dir)
  await writeFile(join(dir, 'package.json'), JSON.stringify({
    name: 'my-plugin', version: '1.0.0', main: 'lib/index.js',
    dsh: { bundle: { patch: './cordis.patch.yml' } },
    peerDependencies: { '@deepseek-ai/cordis': '^4.0.0' },
    ...overrides.manifest,
  }, null, 2))
  await writeFile(join(dir, 'cordis.patch.yml'), overrides.patch ?? '- insert:\n    - id: my-plugin\n      name: my-plugin\n')
  await mkdir(join(dir, 'lib'), { recursive: true })
  await writeFile(join(dir, 'lib', 'index.js'), overrides.entry ?? 'export const inject = []\nexport function apply() {}\n')
  for (const [path, content] of overrides.extra ?? []) {
    await mkdir(join(dir, path.split('/').slice(0, -1).join('/')), { recursive: true })
    await writeFile(join(dir, path), content)
  }
  return dir
}

describe('checkPlugin', () => {
  it('passes a well-formed plugin', async () => {
    const home = await fixtureHome()
    const plugin = await fixturePlugin()
    const findings = await checkPlugin(plugin, home)
    expect(findings.some(finding => finding.level === 'danger')).toBe(false)
    expect(findings.some(finding => finding.check === 'summary' && finding.level === 'ok')).toBe(true)
  })

  it('rejects a missing dsh.bundle declaration', async () => {
    const home = await fixtureHome()
    const plugin = await fixturePlugin({ manifest: { dsh: {} } })
    const findings = await checkPlugin(plugin, home)
    expect(findings.some(finding => finding.check === 'bundle' && finding.level === 'danger')).toBe(true)
  })

  it('rejects invalid patch YAML', async () => {
    const home = await fixtureHome()
    const plugin = await fixturePlugin({ patch: '- insert: [broken\n' })
    const findings = await checkPlugin(plugin, home)
    expect(findings.some(finding => finding.check === 'patch' && finding.level === 'danger')).toBe(true)
  })

  it('rejects a bare drive path in a patch name', async () => {
    const home = await fixtureHome()
    const plugin = await fixturePlugin({ patch: '- insert:\n    - id: x\n      name: D:/some/plugin\n' })
    const findings = await checkPlugin(plugin, home)
    expect(findings.some(finding => finding.check === 'patch' && finding.level === 'danger')).toBe(true)
  })

  it('rejects an object-shaped inject (the pending pitfall)', async () => {
    const home = await fixtureHome()
    const plugin = await fixturePlugin({ entry: 'export const inject = { required: [\u0027x\u0027] }\n' })
    const findings = await checkPlugin(plugin, home)
    expect(findings.some(finding => finding.check === 'seam' && finding.level === 'danger')).toBe(true)
  })

  it('rejects a peer dependency on the wrong version line', async () => {
    const home = await fixtureHome()
    const plugin = await fixturePlugin({ manifest: { peerDependencies: { '@deepseek-ai/cordis': '^5.0.0' } } })
    const findings = await checkPlugin(plugin, home)
    expect(findings.some(finding => finding.check === 'peers' && finding.level === 'danger')).toBe(true)
  })

  it('rejects a missing build artifact', async () => {
    const home = await fixtureHome()
    const plugin = await fixturePlugin()
    await rm(join(plugin, 'lib', 'index.js'))
    const findings = await checkPlugin(plugin, home)
    expect(findings.some(finding => finding.check === 'build' && finding.level === 'danger')).toBe(true)
  })

  it('rejects embedded credentials', async () => {
    const home = await fixtureHome()
    const plugin = await fixturePlugin({ extra: [['src/config.ts', "const key = 'sk-abcdef1234567890'\n"]] })
    const findings = await checkPlugin(plugin, home)
    expect(findings.some(finding => finding.check === 'secrets' && finding.level === 'danger')).toBe(true)
  })
})
