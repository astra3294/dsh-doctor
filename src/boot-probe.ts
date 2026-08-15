import { spawn, type ChildProcess } from 'node:child_process'
import { createConnection } from 'node:net'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { DEFAULT_WEB_PORT } from './constants.js'
import { displayPath, redactSecrets } from './redact.js'
import { profileRoot } from './paths.js'
import type { DoctorIssue } from './types.js'

export interface BootProbeOptions {
  /** DSH_HOME for the spawned instance (also used for evidence paths). */
  readonly dshHome?: string
  /** WebUI port to watch (default 3080). */
  readonly port?: number
  /** Total window to wait for the port (default 60s). */
  readonly timeoutMs?: number
  /** Override the boot command (default `dsh` / `dsh.cmd`). */
  readonly command?: readonly string[]
  /** Profile name for evidence file paths (default web). */
  readonly profile?: string
}

export interface BootProbeResult {
  readonly status: 'already-running' | 'passed' | 'failed' | 'timeout' | 'spawn-error'
  readonly port: number
  readonly exitCode?: number | null
  /** Redacted tail of the probe output (failed/timeout only). */
  readonly evidence?: string
  readonly issues: readonly DoctorIssue[]
}

function portOpen(port: number, timeoutMs: number): Promise<boolean> {
  return new Promise(resolvePromise => {
    const socket = createConnection({ host: '127.0.0.1', port })
    const timer = setTimeout(() => { socket.destroy(); resolvePromise(false) }, timeoutMs)
    socket.once('connect', () => { clearTimeout(timer); socket.destroy(); resolvePromise(true) })
    socket.once('error', () => { clearTimeout(timer); socket.destroy(); resolvePromise(false) })
  })
}

function killTree(child: ChildProcess): void {
  if (child.pid === undefined) return
  if (process.platform === 'win32') {
    spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' })
  } else {
    try { process.kill(child.pid, 'SIGKILL') } catch {}
  }
}

function tail(value: string, limit = 4000): string {
  return value.length > limit ? value.slice(value.length - limit) : value
}

const PLUGIN_ID_PATTERN = /(?:plugin|entry)\s+[`'"]([A-Za-z0-9@/._-]+)[`'"]|(?:failed to load|failed loading|loading failed)\s*[`'"]?([A-Za-z0-9@/._-]+)/i
const MODULE_PATTERN = /Cannot find (?:module|package) ['"]([^'"]+)['"]/i

/**
 * Map a failed boot's captured output onto deterministic Doctor issues so the
 * repair planner can act on the evidence (no live loader state required).
 */
export function analyzeBootFailure(output: string, options: { port: number; dshHome?: string; profile?: string }): DoctorIssue[] {
  const issues: DoctorIssue[] = []
  const profile = options.profile ?? 'web'
  const dshHome = options.dshHome ?? process.env.DSH_HOME ?? join(homedir(), '.dsh')
  const fileFor = (name: string) => options.dshHome === undefined
    ? undefined
    : displayPath(join(profileRoot(dshHome, profile), name), dshHome, false)

  if (/EADDRINUSE/i.test(output)) {
    issues.push({
      code: 'PORT_IN_USE', severity: 'error', title: 'The WebUI port is already in use',
      message: `Port ${String(options.port)} is occupied by another process; the Harness cannot bind it.`,
      evidence: String(options.port), recoverability: 'manual',
    })
  }
  const module = output.match(MODULE_PATTERN)?.[1]
  if (module !== undefined) {
    issues.push({
      code: 'PROFILE_DEPENDENCY_MISSING', severity: 'error', title: 'A required dependency is missing',
      message: `Boot failed resolving ${module}; run dependency reconciliation.`,
      evidence: redactSecrets(module), recoverability: 'confirmation',
    })
  }
  if (/\b(?:patch|overlay).*(?:failed to parse|invalid)|\bfailed to parse\b.*\b(?:patch|overlay)|must be a top-level YAML array|YAMLParseError/i.test(output)) {
    issues.push({
      code: 'CORDIS_PATCH_INVALID', severity: 'error', title: 'Cordis patch cannot be parsed',
      message: 'Boot failed parsing cordis.patch.yml; Doctor can restore it from the healthy checkpoint.',
      evidence: redactSecrets(tail(output, 400)), file: fileFor('cordis.patch.yml'), recoverability: 'automatic',
    })
  }
  if (/Unexpected (?:token|end).*JSON|JSON\.parse|in JSON at position/i.test(output)) {
    issues.push({
      code: 'PROFILE_JSON_INVALID', severity: 'error', title: 'Profile manifest cannot be parsed',
      message: 'Boot failed parsing package.json; Doctor can restore it from the healthy checkpoint.',
      evidence: redactSecrets(tail(output, 400)), file: fileFor('package.json'), recoverability: 'automatic',
    })
  }
  const plugin = output.match(PLUGIN_ID_PATTERN)
  const pluginId = plugin?.[1] ?? plugin?.[2]
  if (pluginId !== undefined) {
    issues.push({
      code: 'PLUGIN_RUNTIME_FAILED', severity: 'error', title: 'A plugin crashed during boot',
      message: `Boot failed while loading ${pluginId}; Doctor can disable it after confirmation.`,
      evidence: pluginId, recoverability: 'confirmation',
    })
  }
  if (/Failed to load native module|pty\.node|prebuilds\//i.test(output)) {
    issues.push({
      code: 'NATIVE_MODULE_MISSING', severity: 'error', title: 'A native module has no prebuild for this Node',
      message: 'A native module (such as node-pty) failed to load: its prebuild for this Node ABI is missing. Run npm rebuild for it, or switch to an officially supported Node version.',
      evidence: redactSecrets(tail(output, 400)), recoverability: 'manual',
    })
  }
  if (/EACCES/i.test(output) && /\blisten|bind\b/i.test(output)) {
    issues.push({
      code: 'PORT_IN_EXCLUDED_RANGE', severity: 'error', title: 'The port bind failed with EACCES',
      message: `Binding port ${String(options.port)} was denied — on Windows this usually means the port sits in a reserved range (Hyper-V/WSL2). Start the Harness on a different port.`,
      evidence: `port ${String(options.port)} EACCES`, recoverability: 'manual',
    })
  }
  if (issues.length === 0) {
    issues.push({
      code: 'BOOT_PROBE_FAILED', severity: 'error', title: 'Harness failed to start',
      message: 'The Harness process exited during boot. Review the captured output below.',
      evidence: redactSecrets(tail(output, 1200)), recoverability: 'manual',
    })
  }
  return issues
}

/**
 * Spawn `dsh` and decide whether it boots: the WebUI port opening is the
 * success signal; a fast non-zero exit is a failure whose output becomes the
 * forensic evidence. The probe process is always reaped.
 */
export async function probeBoot(options: BootProbeOptions = {}): Promise<BootProbeResult> {
  const port = options.port ?? DEFAULT_WEB_PORT
  const timeoutMs = options.timeoutMs ?? 60_000

  if (await portOpen(port, 500)) {
    return { status: 'already-running', port, issues: [] }
  }

  const parts = options.command ?? [process.platform === 'win32' ? 'dsh.cmd' : 'dsh']
  const child = spawn(parts[0] ?? (process.platform === 'win32' ? 'dsh.cmd' : 'dsh'), parts.slice(1), {
    cwd: options.dshHome,
    env: { ...process.env, ...(options.dshHome === undefined ? {} : { DSH_HOME: options.dshHome }) },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  })
  let output = ''
  child.stdout?.on('data', chunk => { output += String(chunk) })
  child.stderr?.on('data', chunk => { output += String(chunk) })

  return new Promise<BootProbeResult>(resolvePromise => {
    let settled = false
    let deadline: NodeJS.Timeout | undefined
    let poll: NodeJS.Timeout | undefined
    const finish = (result: BootProbeResult) => {
      if (settled) return
      settled = true
      if (deadline !== undefined) clearTimeout(deadline)
      if (poll !== undefined) clearInterval(poll)
      resolvePromise(result)
    }
    deadline = setTimeout(() => {
      killTree(child)
      finish({ status: 'timeout', port, evidence: redactSecrets(tail(output)), issues: [] })
    }, timeoutMs)
    child.once('error', error => {
      finish({ status: 'spawn-error', port, evidence: redactSecrets(String(error)), issues: [] })
    })
    child.once('exit', code => {
      finish({
        status: 'failed', port, exitCode: code, evidence: redactSecrets(tail(output)),
        issues: analyzeBootFailure(output, { port, dshHome: options.dshHome, profile: options.profile }),
      })
    })
    poll = setInterval(() => {
      if (settled) return
      void portOpen(port, 300).then(open => {
        if (!open || settled) return
        killTree(child)
        finish({ status: 'passed', port, exitCode: null, issues: [] })
      })
    }, 250)
  })
}
