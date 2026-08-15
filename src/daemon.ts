import { spawn } from 'node:child_process'
import { open, rm, writeFile } from 'node:fs/promises'
import { createConnection } from 'node:net'
import { join } from 'node:path'
import { DEFAULT_WEB_PORT } from './constants.js'
import { ensurePrivateDir, readText } from './fs-utils.js'
import { doctorRoot, resolveDshHome } from './paths.js'

export interface DaemonStatus {
  readonly running: boolean
  readonly portOpen: boolean
  readonly pid?: number
  readonly startedAt?: string
  readonly logFile: string
}

function runDir(dshHome: string): string {
  return join(doctorRoot(dshHome), 'run')
}

function pidFile(dshHome: string): string {
  return join(runDir(dshHome), 'dsh.pid')
}

export function logFile(dshHome: string): string {
  return join(runDir(dshHome), 'dsh.log')
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM'
  }
}

function portListening(port: number): Promise<boolean> {
  return new Promise(resolvePromise => {
    const socket = createConnection({ host: '127.0.0.1', port })
    const timer = setTimeout(() => { socket.destroy(); resolvePromise(false) }, 400)
    socket.once('connect', () => { clearTimeout(timer); socket.destroy(); resolvePromise(true) })
    socket.once('error', () => { clearTimeout(timer); socket.destroy(); resolvePromise(false) })
  })
}

export async function daemonStatus(dshHomeInput?: string, port = DEFAULT_WEB_PORT): Promise<DaemonStatus> {
  const dshHome = resolveDshHome(dshHomeInput)
  const raw = await readText(pidFile(dshHome))
  let pid: number | undefined
  let startedAt: string | undefined
  if (raw !== undefined) {
    try {
      const record = JSON.parse(raw) as { pid?: number; startedAt?: string }
      if (typeof record.pid === 'number') pid = record.pid
      if (typeof record.startedAt === 'string') startedAt = record.startedAt
    } catch {
      // A corrupt pid file counts as not running.
    }
  }
  const alive = pid !== undefined && pidAlive(pid)
  return { running: alive, portOpen: await portListening(port), pid: alive ? pid : undefined, startedAt, logFile: logFile(dshHome) }
}

/** Start the Harness detached, logging to the Doctor run directory. */
export async function daemonStart(dshHomeInput?: string, profile = 'web'): Promise<{ pid: number; logFile: string }> {
  const dshHome = resolveDshHome(dshHomeInput)
  await ensurePrivateDir(runDir(dshHome))
  const handle = await open(logFile(dshHome), 'a')
  const command = process.platform === 'win32' ? 'dsh.cmd' : 'dsh'
  const child = spawn(command, ['--profile', profile], {
    detached: true,
    stdio: ['ignore', handle.fd, handle.fd],
    windowsHide: true,
    env: { ...process.env, ...(dshHome === resolveDshHome() ? {} : { DSH_HOME: dshHome }) },
  })
  await handle.close()
  child.unref()
  if (child.pid === undefined) throw new Error('failed to capture the Harness pid')
  await writeFile(pidFile(dshHome), JSON.stringify({ pid: child.pid, startedAt: new Date().toISOString() }), 'utf8')
  return { pid: child.pid, logFile: logFile(dshHome) }
}

/** Stop the daemonized Harness (process tree) and clean the pid file. */
export async function daemonStop(dshHomeInput?: string): Promise<boolean> {
  const dshHome = resolveDshHome(dshHomeInput)
  const status = await daemonStatus(dshHome)
  if (!status.running || status.pid === undefined) return false
  if (process.platform === 'win32') {
    spawn('taskkill', ['/pid', String(status.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' })
  } else {
    try { process.kill(status.pid, 'SIGTERM') } catch {}
  }
  await rm(pidFile(dshHome), { force: true }).catch(() => {})
  return true
}
