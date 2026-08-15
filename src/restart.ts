import { spawn } from 'node:child_process'

/**
 * In-process restart: the Host plugin schedules a detached helper that waits
 * for this process to exit, then launches a fresh Harness for the same
 * profile. The helper survives `process.exit()` because it is detached and
 * its stdio is disconnected.
 */

/** The helper program (node -e) that relaunches the Harness after a delay. */
export function relaunchScript(platform: string, profile: string): string {
  const command = platform === 'win32' ? 'dsh.cmd' : 'dsh'
  const profileJson = JSON.stringify(profile)
  const commandJson = JSON.stringify(command)
  return `setTimeout(() => { const { spawn } = require('child_process'); const p = spawn(${commandJson}, ['--profile', ${profileJson}], { detached: true, stdio: 'ignore', shell: ${platform === 'win32' ? 'true' : 'false'}, windowsHide: true, env: process.env }); p.unref(); }, 1500)`
}

export interface RestartAck {
  readonly ok: true
  readonly message: string
}

/**
 * Schedule the restart and begin shutting this process down. The HTTP
 * response usually still reaches the client before the exit lands, but the
 * caller must not rely on it (fire-and-forget).
 */
export function scheduleRestart(profile: string): RestartAck {
  const helper = spawn(process.execPath, ['-e', relaunchScript(process.platform, profile)], {
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
    env: process.env,
  })
  helper.unref()
  setTimeout(() => process.exit(0), 300)
  return { ok: true, message: `restart scheduled for profile ${profile}` }
}
