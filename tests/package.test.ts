import { readFile } from 'node:fs/promises'
import { describe, expect, it } from 'vitest'

describe('package contract', () => {
  it('declares a DSH bundle, browser client, CLI, and all three UI slots', async () => {
    const pkg = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8')) as {
      bin?: Record<string, string>
      dsh?: { bundle?: unknown; client?: unknown }
    }
    expect(pkg.bin?.['dsh-doctor']).toBe('lib/cli.js')
    expect(pkg.dsh?.bundle).toBeDefined()
    expect(pkg.dsh?.client).toBeDefined()
    expect(JSON.stringify(pkg.dsh?.client)).toContain('@deepseek-ai/dsh-client-ui-primitives')
    const source = await readFile(new URL('../src/client/index.tsx', import.meta.url), 'utf8')
    expect(source).toContain("'sidebar.footer.action'")
    expect(source).toContain("'conversation.input.dock'")
    expect(source).toContain("'settings.section'")
    expect(source).toContain("'shell.overlay'")
  })
})
