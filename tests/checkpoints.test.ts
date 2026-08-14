import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, describe, expect, it } from 'vitest'
import { createCheckpoint, rollbackCheckpoint } from '../src/checkpoints.js'

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

describe('checkpoints', () => {
  it('restores every covered file byte-for-byte', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-doctor-checkpoint-'))
    roots.push(root)
    const profile = join(root, 'profiles', 'web')
    await mkdir(profile, { recursive: true })
    const manifest = join(profile, 'package.json')
    const settings = join(root, 'settings.yaml')
    await writeFile(manifest, '{"healthy":true}\n')
    await writeFile(settings, 'theme: dark\n')
    const checkpoint = await createCheckpoint(root, 'web', 'healthy', true)
    await writeFile(manifest, '{broken')
    await writeFile(settings, 'theme: light\n')
    await rollbackCheckpoint(root, checkpoint.id)
    expect(await readFile(manifest, 'utf8')).toBe('{"healthy":true}\n')
    expect(await readFile(settings, 'utf8')).toBe('theme: dark\n')
  })
})
