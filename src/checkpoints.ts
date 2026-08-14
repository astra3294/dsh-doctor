import { readdir, readFile, rm } from 'node:fs/promises'
import { basename, dirname, join, relative, resolve } from 'node:path'
import { randomUUID } from 'node:crypto'
import { CHECKPOINT_RETENTION } from './constants.js'
import { atomicWrite, ensurePrivateDir, exists, fileHash, readText } from './fs-utils.js'
import { doctorRoot, profileRoot, safeProfileName } from './paths.js'
import type { CheckpointFile, DoctorCheckpoint } from './types.js'

function checkpointDirectory(dshHome: string, profile: string, id: string): string {
  return join(doctorRoot(dshHome), 'checkpoints', safeProfileName(profile), id)
}

function candidateFiles(dshHome: string, profile: string): string[] {
  const root = profileRoot(dshHome, profile)
  return [
    join(root, 'package.json'),
    join(root, 'cordis.patch.yml'),
    join(root, 'cordis.yml'),
    join(root, 'pnpm-workspace.yaml'),
    join(root, 'pnpm-lock.yaml'),
    join(dshHome, 'settings.yaml'),
    join(dshHome, 'settings.yml'),
    join(dshHome, 'settings.json'),
  ]
}

function storedName(sourcePath: string, dshHome: string, profile: string): string {
  const profilePath = profileRoot(dshHome, profile)
  const absolute = resolve(sourcePath)
  if (absolute.startsWith(`${resolve(profilePath)}\\`) || absolute.startsWith(`${resolve(profilePath)}/`)) {
    return join('profile', relative(profilePath, absolute))
  }
  return join('home', basename(absolute))
}

export async function createCheckpoint(
  dshHome: string,
  profile: string,
  kind: DoctorCheckpoint['kind'],
  valid: boolean,
): Promise<DoctorCheckpoint> {
  safeProfileName(profile)
  const id = `${new Date().toISOString().replace(/[:.]/g, '-')}-${randomUUID().slice(0, 8)}`
  const target = checkpointDirectory(dshHome, profile, id)
  await ensurePrivateDir(target)
  const files: CheckpointFile[] = []
  for (const sourcePath of candidateFiles(dshHome, profile)) {
    const relativePath = storedName(sourcePath, dshHome, profile)
    const content = await readText(sourcePath)
    if (content === undefined) {
      files.push({ relativePath, sourcePath, present: false })
      continue
    }
    await atomicWrite(join(target, 'files', relativePath), content)
    files.push({ relativePath, sourcePath, present: true, sha256: await fileHash(sourcePath) })
  }
  const checkpoint: DoctorCheckpoint = {
    id,
    profile,
    kind,
    createdAt: new Date().toISOString(),
    valid,
    files,
  }
  await atomicWrite(join(target, 'checkpoint.json'), `${JSON.stringify(checkpoint, null, 2)}\n`)
  await pruneCheckpoints(dshHome, profile)
  return checkpoint
}

export async function listCheckpoints(dshHome: string, profile?: string): Promise<DoctorCheckpoint[]> {
  const root = join(doctorRoot(dshHome), 'checkpoints')
  if (!await exists(root)) return []
  const profiles = profile === undefined
    ? (await readdir(root, { withFileTypes: true })).filter(entry => entry.isDirectory()).map(entry => entry.name)
    : [safeProfileName(profile)]
  const checkpoints: DoctorCheckpoint[] = []
  for (const profileName of profiles) {
    const directory = join(root, profileName)
    if (!await exists(directory)) continue
    const ids = await readdir(directory, { withFileTypes: true })
    for (const entry of ids) {
      if (!entry.isDirectory()) continue
      try {
        const raw = await readFile(join(directory, entry.name, 'checkpoint.json'), 'utf8')
        checkpoints.push(JSON.parse(raw) as DoctorCheckpoint)
      } catch {
        // A partial checkpoint is deliberately ignored; repair never trusts it.
      }
    }
  }
  return checkpoints.sort((a, b) => b.createdAt.localeCompare(a.createdAt))
}

export async function findLastHealthyCheckpoint(dshHome: string, profile: string): Promise<DoctorCheckpoint | undefined> {
  return (await listCheckpoints(dshHome, profile)).find(checkpoint => checkpoint.valid && checkpoint.kind === 'healthy')
}

export async function restoreCheckpointFile(
  dshHome: string,
  checkpointId: string,
  sourcePath: string,
): Promise<void> {
  const checkpoint = (await listCheckpoints(dshHome)).find(item => item.id === checkpointId)
  if (checkpoint === undefined) throw new Error(`checkpoint not found: ${checkpointId}`)
  const descriptor = checkpoint.files.find(item => resolve(item.sourcePath) === resolve(sourcePath))
  if (descriptor === undefined) throw new Error(`checkpoint does not cover ${sourcePath}`)
  if (!descriptor.present) {
    await rm(sourcePath, { force: true })
    return
  }
  const backupPath = join(checkpointDirectory(dshHome, checkpoint.profile, checkpoint.id), 'files', descriptor.relativePath)
  const content = await readFile(backupPath)
  await atomicWrite(sourcePath, content)
  const restoredHash = await fileHash(sourcePath)
  if (restoredHash !== descriptor.sha256) throw new Error(`restored file hash mismatch: ${sourcePath}`)
}

export async function rollbackCheckpoint(dshHome: string, checkpointId: string): Promise<DoctorCheckpoint> {
  const checkpoint = (await listCheckpoints(dshHome)).find(item => item.id === checkpointId)
  if (checkpoint === undefined) throw new Error(`checkpoint not found: ${checkpointId}`)
  for (const file of checkpoint.files) await restoreCheckpointFile(dshHome, checkpoint.id, file.sourcePath)
  return checkpoint
}

async function pruneCheckpoints(dshHome: string, profile: string): Promise<void> {
  const checkpoints = await listCheckpoints(dshHome, profile)
  // Newest-first. Always retain the most recent healthy checkpoint beyond the
  // retention cap: it is the recovery baseline and must never be pruned away.
  const newestHealthy = checkpoints.find(checkpoint => checkpoint.valid && checkpoint.kind === 'healthy')
  const excess = checkpoints.slice(CHECKPOINT_RETENTION).filter(checkpoint => checkpoint.id !== newestHealthy?.id)
  for (const checkpoint of excess) {
    await rm(checkpointDirectory(dshHome, profile, checkpoint.id), { recursive: true, force: true })
  }
}
