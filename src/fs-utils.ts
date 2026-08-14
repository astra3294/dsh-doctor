import { constants } from 'node:fs'
import { access, chmod, mkdir, open, readFile, rename, rm, stat } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { createHash, randomUUID } from 'node:crypto'
import { STALE_LOCK_MS } from './constants.js'

export async function exists(path: string): Promise<boolean> {
  try {
    await access(path, constants.F_OK)
    return true
  } catch {
    return false
  }
}

export async function readText(path: string): Promise<string | undefined> {
  try {
    return await readFile(path, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw error
  }
}

export function sha256(value: string | Uint8Array): string {
  return createHash('sha256').update(value).digest('hex')
}

export async function fileHash(path: string): Promise<string | undefined> {
  const value = await readText(path)
  return value === undefined ? undefined : sha256(value)
}

export async function ensurePrivateDir(path: string): Promise<void> {
  await mkdir(path, { recursive: true, mode: 0o700 })
  if (process.platform !== 'win32') await chmod(path, 0o700)
}

export async function atomicWrite(path: string, content: string | Uint8Array): Promise<void> {
  await ensurePrivateDir(dirname(path))
  const temporary = join(dirname(path), `.${randomUUID()}.tmp`)
  try {
    const handle = await open(temporary, 'wx', 0o600)
    try {
      await handle.writeFile(content)
      await handle.sync()
    } finally {
      await handle.close()
    }
    await rename(temporary, path)
    if (process.platform !== 'win32') await chmod(path, 0o600)
  } catch (error) {
    await rm(temporary, { force: true }).catch(() => {})
    throw error
  }
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM'
  }
}

interface LockRecord {
  pid?: number
  startedAt?: string
}

async function lockStale(lockPath: string): Promise<boolean> {
  let record: LockRecord
  try {
    record = JSON.parse(await readFile(lockPath, 'utf8')) as LockRecord
  } catch {
    // Unreadable or malformed lock: treat by age via mtime below.
    record = {}
  }
  if (typeof record.pid === 'number' && pidAlive(record.pid)) return false
  if (typeof record.startedAt === 'string') {
    const age = Date.now() - Date.parse(record.startedAt)
    if (Number.isFinite(age)) return age > STALE_LOCK_MS
  }
  try {
    const info = await stat(lockPath)
    return Date.now() - info.mtimeMs > STALE_LOCK_MS
  } catch {
    return false
  }
}

export async function withFileLock<T>(lockPath: string, operation: () => Promise<T>): Promise<T> {
  await ensurePrivateDir(dirname(lockPath))
  let handle
  try {
    handle = await open(lockPath, 'wx', 0o600)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
      if (await lockStale(lockPath)) {
        await rm(lockPath, { force: true }).catch(() => {})
        handle = await open(lockPath, 'wx', 0o600)
      } else {
        throw new Error(`another Doctor repair is already running (${lockPath})`)
      }
    } else {
      throw error
    }
  }
  try {
    await handle.writeFile(JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }))
    return await operation()
  } finally {
    await handle.close().catch(() => {})
    await rm(lockPath, { force: true }).catch(() => {})
  }
}

export async function isReadableWritable(path: string): Promise<{ readable: boolean; writable: boolean }> {
  const check = async (mode: number) => {
    try {
      await access(path, mode)
      return true
    } catch {
      return false
    }
  }
  return { readable: await check(constants.R_OK), writable: await check(constants.W_OK) }
}

export async function fileSize(path: string): Promise<number | undefined> {
  try {
    return (await stat(path)).size
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw error
  }
}
