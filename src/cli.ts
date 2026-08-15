import { spawn, spawnSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Command, CommanderError } from 'commander'
import semver from 'semver'
import { DEFAULT_PROFILE, DEFAULT_WEB_PORT, DOCTOR_VERSION } from './constants.js'
import { probeBoot, type BootProbeResult } from './boot-probe.js'
import { daemonStart, daemonStatus, daemonStop } from './daemon.js'
import { DoctorEngine } from './repair.js'
import { summarizeIssues } from './scanner.js'
import { ISSUE_HINTS } from './hints.js'
import { BUILTIN_PATTERNS, mergedPatterns, storeFetchedPatterns, type PatternCatalog } from './knowledge.js'
import { buildReportPayload, renderIssueMarkdown, reportIssueUrl, rootCauseSummary } from './report.js'
import { profileRoot, resolveDshHome } from './paths.js'
import type { DoctorIssue, DoctorScanReport } from './types.js'

function outputReport(report: DoctorScanReport, json: boolean): void {
  if (json) {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`)
    return
  }
  process.stdout.write(`DSH Doctor ${DOCTOR_VERSION}\n`)
  process.stdout.write(`Node ${report.environment.node} · ${report.environment.platform}\n`)
  for (const profile of report.profiles) process.stdout.write(`Profile ${profile.name}: ${profile.exists ? 'found' : 'missing'}${profile.dshVersion ? ` · DSH ${profile.dshVersion}` : ''}\n`)
  process.stdout.write(`\n${String(report.summary.errors)} error(s), ${String(report.summary.warnings)} warning(s), ${String(report.summary.info)} info\n`)
  process.stdout.write(`Root cause: ${rootCauseSummary(report)}\n`)
  for (const item of report.issues) outputIssue(item)
}

function outputIssue(item: DoctorIssue): void {
  const marker = item.severity === 'error' ? 'ERROR' : item.severity === 'warning' ? 'WARN' : 'INFO'
  process.stdout.write(`\n[${marker}] ${item.code}: ${item.title}\n  ${item.message}\n`)
  if (item.evidence !== undefined) process.stdout.write(`  ${item.evidence}\n`)
  const hint = ISSUE_HINTS[item.code]?.en
  if (hint !== undefined) process.stdout.write(`  ${hint}\n`)
}

function exitCode(report: DoctorScanReport, strict: boolean): number {
  if (report.summary.errors > 0) return 1
  if (strict && report.summary.warnings > 0) return 1
  return 0
}

function outputBootProbe(result: BootProbeResult, label: string): void {
  process.stdout.write(`\nBoot ${label}: ${result.status} (port ${String(result.port)})\n`)
  for (const item of result.issues) outputIssue(item)
  if (result.evidence !== undefined) process.stdout.write(`  ${result.evidence}\n`)
}

function runDshInherit(): Promise<number | null> {
  return new Promise(resolvePromise => {
    const command = process.platform === 'win32' ? 'dsh.cmd' : 'dsh'
    const child = spawn(command, [], { stdio: 'inherit', windowsHide: false })
    child.once('error', () => resolvePromise(null))
    child.once('exit', code => resolvePromise(code))
  })
}

interface CommonOptions {
  profile?: string
  allProfiles?: boolean
  json?: boolean
  online?: boolean
  includePaths?: boolean
  strict?: boolean
}

const program = new Command()
  .name('dsh-doctor')
  .description('Deterministic diagnostics and recovery for DeepSeek Harness')
  .version(DOCTOR_VERSION)
  .showHelpAfterError()
  .exitOverride()

program.command('scan', { isDefault: true })
  .description('Scan Harness profiles without changing them')
  .option('-p, --profile <name>', 'scan one profile')
  .option('--all-profiles', 'scan every profile', true)
  .option('--json', 'emit machine-readable JSON')
  .option('--online', 'query the npm registry for current version metadata')
  .option('--include-paths', 'include absolute local paths in output')
  .option('--strict', 'treat warnings as a failing exit status')
  .action(async (options: CommonOptions) => {
    const engine = new DoctorEngine()
    const report = await engine.scan({
      profile: options.profile,
      allProfiles: options.profile === undefined && options.allProfiles,
      online: options.online,
      includePaths: options.includePaths,
    })
    outputReport(report, options.json ?? false)
    process.exitCode = exitCode(report, options.strict ?? false)
  })

async function recoverOnce(input: {
  profile: string
  confirmed: boolean
  online: boolean
  includePaths: boolean
  bootTimeoutMs: number
  port: number
}) {
  const engine = new DoctorEngine()
  const dshHome = resolveDshHome()
  let report = await engine.scan({ profile: input.profile, online: input.online, includePaths: input.includePaths })
  let before: BootProbeResult | undefined
  const initial = await probeBoot({ dshHome, port: input.port, profile: input.profile, timeoutMs: input.bootTimeoutMs })
  if (initial.status === 'failed' || initial.status === 'timeout' || initial.status === 'spawn-error') {
    // The Harness is down: the boot probe is the only live evidence source.
    before = initial
    const merged = [...report.issues, ...initial.issues]
    report = { ...report, issues: merged, summary: summarizeIssues(merged) }
  }
  const plan = await engine.plan(report, { profile: input.profile })
  const safe = plan.actions.filter(action => action.risk === 'safe')
  const confirmation = plan.actions.filter(action => action.risk === 'confirmation')
  const selected = input.confirmed ? [...safe, ...confirmation] : safe
  const run = await engine.apply(plan.id, {
    actionIds: selected.map(action => action.id),
    confirmed: input.confirmed,
    online: input.online,
  })
  let after: BootProbeResult | undefined
  if (run.phase !== 'failed' && initial.status !== 'already-running') {
    after = await probeBoot({ dshHome, port: input.port, profile: input.profile, timeoutMs: input.bootTimeoutMs })
  }
  return { report, plan, run, confirmation, boot: { before, after } }
}

program.command('recover')
  .description('One-click recovery: reset configs to the healthy checkpoint, reconcile dependencies, and verify the boot')
  .option('-p, --profile <name>', 'profile to recover', DEFAULT_PROFILE)
  .option('--yes', 'confirm reversible dependency/plugin actions')
  .option('--online', 'allow package manager network access')
  .option('--port <port>', 'WebUI port to watch during boot verification', String(DEFAULT_WEB_PORT))
  .option('--boot-timeout <ms>', 'boot verification window in milliseconds', '60000')
  .option('--json', 'emit machine-readable JSON')
  .option('--include-paths', 'include absolute local paths in output')
  .action(async (options: CommonOptions & { yes?: boolean; port?: string; bootTimeout?: string }) => {
    const outcome = await recoverOnce({
      profile: options.profile ?? DEFAULT_PROFILE,
      confirmed: options.yes ?? false,
      online: options.online ?? false,
      includePaths: options.includePaths ?? false,
      bootTimeoutMs: Number(options.bootTimeout ?? 60000),
      port: Number(options.port ?? DEFAULT_WEB_PORT),
    })
    if (options.json) {
      process.stdout.write(`${JSON.stringify(outcome, null, 2)}\n`)
    } else {
      outputReport(outcome.report, false)
      process.stdout.write(`\nRecovery: ${outcome.run.phase}\n`)
      for (const result of outcome.run.results) process.stdout.write(`  ${result.ok ? 'OK' : 'FAILED'} ${result.message}\n`)
      if (outcome.confirmation.length > 0 && !options.yes) process.stdout.write(`\n${String(outcome.confirmation.length)} action(s) require confirmation. Re-run with --yes after reviewing the report.\n`)
      if (outcome.run.error !== undefined) process.stderr.write(`${outcome.run.error}\n`)
      if (outcome.boot.before !== undefined) outputBootProbe(outcome.boot.before, 'diagnosis')
      if (outcome.boot.after !== undefined) outputBootProbe(outcome.boot.after, 'verification')
      if (outcome.boot.after?.status === 'passed') process.stdout.write('\nThe Harness boots successfully. Start it with `dsh` or `dsh-doctor launch`.\n')
    }
    process.exitCode = outcome.run.phase === 'failed' ? 1 : 0
  })

program.command('boot')
  .description('Probe whether the Harness can start, and diagnose boot failures')
  .option('-p, --profile <name>', 'profile used for evidence paths', DEFAULT_PROFILE)
  .option('--port <port>', 'WebUI port to watch', String(DEFAULT_WEB_PORT))
  .option('--timeout <ms>', 'boot window in milliseconds', '60000')
  .option('--mark-healthy', 'snapshot a healthy checkpoint when the boot succeeds')
  .option('--json', 'emit machine-readable JSON')
  .action(async (options: { profile?: string; port?: string; timeout?: string; markHealthy?: boolean; json?: boolean }) => {
    const result = await probeBoot({
      profile: options.profile ?? DEFAULT_PROFILE,
      port: Number(options.port ?? DEFAULT_WEB_PORT),
      timeoutMs: Number(options.timeout ?? 60000),
    })
    if (options.json) {
      process.stdout.write(`${JSON.stringify(result, null, 2)}\n`)
    } else {
      process.stdout.write(`Boot probe: ${result.status} (port ${String(result.port)})\n`)
      for (const item of result.issues) outputIssue(item)
      if (result.evidence !== undefined) process.stdout.write(`  ${result.evidence}\n`)
      if (result.status === 'already-running') {
        process.stdout.write(`  ${ISSUE_HINTS.DUAL_INSTANCE_RISK?.en ?? ''}\n`)
      }
    }
    if ((result.status === 'passed' || result.status === 'already-running') && options.markHealthy) {
      try {
        const checkpoint = await new DoctorEngine().markHealthy(options.profile ?? DEFAULT_PROFILE)
        process.stdout.write(`\nHealthy checkpoint created: ${checkpoint.id}\n`)
      } catch (error) {
        process.stderr.write(`Skipped healthy checkpoint: ${String(error)}\n`)
      }
    }
    process.exitCode = result.status === 'passed' || result.status === 'already-running' ? 0 : 1
  })

program.command('checkpoint')
  .description('Snapshot the current profile as a healthy recovery baseline')
  .option('-p, --profile <name>', 'profile to snapshot', DEFAULT_PROFILE)
  .option('--json', 'emit machine-readable JSON')
  .action(async (options: { profile?: string; json?: boolean }) => {
    const checkpoint = await new DoctorEngine().markHealthy(options.profile ?? DEFAULT_PROFILE)
    if (options.json) process.stdout.write(`${JSON.stringify(checkpoint, null, 2)}\n`)
    else process.stdout.write(`Healthy checkpoint created: ${checkpoint.id} (${checkpoint.createdAt})\n`)
  })

program.command('update')
  .description('Fetch community failure-pattern knowledge (data only — no code runs)')
  .option('--check', 'only report whether newer knowledge exists')
  .option('--source <url>', 'override the knowledge catalog URL')
  .action(async (options: { check?: boolean; source?: string }) => {
    const source = options.source ?? 'https://raw.githubusercontent.com/astra3294/dsh-doctor/main/src/failure-patterns.json'
    let fetched: PatternCatalog | undefined
    try {
      const response = await fetch(source, { signal: AbortSignal.timeout(10_000) })
      if (!response.ok) throw new Error(`HTTP ${String(response.status)}`)
      fetched = await response.json() as PatternCatalog
    } catch (error) {
      process.stderr.write(`Knowledge fetch failed (offline?): ${String(error)}\n`)
      process.exitCode = 2
      return
    }
    const builtinIds = new Set(BUILTIN_PATTERNS.patterns.map(pattern => pattern.id))
    const fresh = fetched.patterns.filter(pattern => !builtinIds.has(pattern.id))
    if (options.check) {
      process.stdout.write(`${String(BUILTIN_PATTERNS.patterns.length)} builtin pattern(s), ${String(fresh.length)} new available.\n`)
      return
    }
    await storeFetchedPatterns(resolveDshHome(), fetched)
    process.stdout.write(`Knowledge updated: ${String(fresh.length)} new pattern(s), ${String(fetched.patterns.length - fresh.length)} refreshed. The next scan uses them (no restart, no release).\n`)
  })

program.command('self-update')
  .description('Upgrade the Doctor package itself in the active profile')
  .option('--apply', 'install the latest version into the profile now')
  .option('--json', 'emit machine-readable JSON')
  .action(async (options: { apply?: boolean; json?: boolean }) => {
    let latest: string
    try {
      const response = await fetch('https://registry.npmjs.org/dsh-doctor/latest', { signal: AbortSignal.timeout(10_000) })
      if (!response.ok) throw new Error(`HTTP ${String(response.status)}`)
      latest = ((await response.json()) as { version?: string }).version ?? DOCTOR_VERSION
    } catch (error) {
      process.stderr.write(`Version check failed (offline?): ${String(error)}\n`)
      process.exitCode = 2
      return
    }
    const current = DOCTOR_VERSION
    if (options.json) process.stdout.write(`${JSON.stringify({ current, latest, updateAvailable: semver.gt(latest, current) }, null, 2)}\n`)
    else process.stdout.write(`DSH Doctor: installed ${current}, latest ${latest}${semver.gt(latest, current) ? ' (update available)' : ''}\n`)
    if (!options.apply || !semver.gt(latest, current)) return
    const cwd = profileRoot(resolveDshHome(), DEFAULT_PROFILE)
    const command = process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm'
    const result = spawnSync(command, ['add', `dsh-doctor@${latest}`], { cwd, encoding: 'utf8', timeout: 180_000, windowsHide: true })
    if (result.status !== 0) {
      process.stderr.write(`Install failed: ${result.stderr?.trim() || `exit ${String(result.status)}`}\n`)
      process.exitCode = 1
      return
    }
    process.stdout.write(`Installed dsh-doctor@${latest} into the profile. Restart the Harness to load it.\n`)
  })

program.command('start')
  .description('Start the Harness detached; logs go to the Doctor run directory')
  .action(async () => {
    const status = await daemonStatus()
    if (status.running || status.portOpen) {
      process.stderr.write(`A Harness instance already runs (pid ${status.pid ?? 'unknown'}, port open: ${String(status.portOpen)}).\n`)
      process.stderr.write(`${ISSUE_HINTS.DUAL_INSTANCE_RISK?.en ?? ''}\n`)
      process.exitCode = 1
      return
    }
    const started = await daemonStart()
    process.stdout.write(`Started Harness (pid ${String(started.pid)}). Logs: ${started.logFile}\n`)
    process.stdout.write('Track it with `dsh-doctor status`, stop it with `dsh-doctor stop`.\n')
  })

program.command('stop')
  .description('Stop the daemonized Harness')
  .option('--json', 'emit machine-readable JSON')
  .action(async (options: { json?: boolean }) => {
    const stopped = await daemonStop()
    if (options.json) process.stdout.write(`${JSON.stringify({ stopped }, null, 2)}\n`)
    else process.stdout.write(stopped ? 'Harness stopped.\n' : 'No daemonized Harness was running.\n')
  })

program.command('status')
  .description('Show the daemonized Harness status')
  .option('--json', 'emit machine-readable JSON')
  .action(async (options: { json?: boolean }) => {
    const status = await daemonStatus()
    if (options.json) process.stdout.write(`${JSON.stringify(status, null, 2)}\n`)
    else {
      process.stdout.write(status.running
        ? `Running (pid ${String(status.pid)}${status.startedAt ? `, since ${status.startedAt}` : ''})\n`
        : status.portOpen
          ? 'A Harness is listening on the WebUI port but was not started by dsh-doctor (another instance).\n'
          : 'Not running.\n')
      process.stdout.write(`Logs: ${status.logFile}\n`)
    }
    process.exitCode = status.running || status.portOpen ? 0 : 1
  })

program.command('report')
  .description('Build a redacted, opt-in failure report to share with the community')
  .option('-p, --profile <name>', 'profile to report on', DEFAULT_PROFILE)
  .option('--json', 'emit the redacted payload as JSON')
  .option('--open', 'open the pre-filled GitHub issue page in the browser')
  .option('--submit', 'submit via the gh CLI (requires gh auth)')
  .action(async (options: { profile?: string; json?: boolean; open?: boolean; submit?: boolean }) => {
    const engine = new DoctorEngine()
    const profile = options.profile ?? DEFAULT_PROFILE
    const report = await engine.scan({ profile })
    const history = await engine.history({ profile })
    const payload = buildReportPayload(report, history.runs[0], resolveDshHome())
    if (options.json) {
      process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`)
      return
    }
    const markdown = renderIssueMarkdown(payload)
    process.stdout.write('=== Preview (everything below is redacted: no keys, no absolute paths) ===\n\n')
    process.stdout.write(`${markdown}\n\n`)
    const title = `[doctor-report] ${payload.rootCause} (Node ${payload.node}, ${payload.platform})`
    if (options.submit) {
      const bodyFile = join(tmpdir(), `dsh-doctor-report-${String(process.pid)}.md`)
      writeFileSync(bodyFile, markdown, 'utf8')
      const gh = spawnSync('gh', ['issue', 'create', '--repo', reportRepo(), '--title', title, '--body-file', bodyFile], { encoding: 'utf8' })
      if (gh.status !== 0) {
        process.stderr.write(`gh submission failed: ${gh.stderr?.trim() || 'gh CLI unavailable'}\n`)
        process.stderr.write('Re-run with --open to submit via the browser instead.\n')
        process.exitCode = 2
      } else {
        process.stdout.write(`${gh.stdout}`)
      }
      return
    }
    if (options.open) {
      openBrowser(reportIssueUrl(reportRepo(), payload))
      return
    }
    process.stdout.write('To share: run `dsh-doctor report --open` (browser) or `dsh-doctor report --submit` (gh CLI).\n')
  })

function reportRepo(): string {
  try {
    const manifest = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { repository?: { url?: string } }
    const match = manifest.repository?.url?.match(/github\.com[:/]([^/]+\/[^/.]+?)(?:\.git)?$/i)
    if (match !== null && match !== undefined) return match[1]!
  } catch {}
  return 'astra3294/dsh-doctor'
}

function openBrowser(url: string): void {
  if (process.platform === 'win32') spawn('cmd', ['/c', 'start', '""', url], { windowsHide: true, stdio: 'ignore' })
  else if (process.platform === 'darwin') spawn('open', [url], { stdio: 'ignore' })
  else spawn('xdg-open', [url], { stdio: 'ignore' })
}

program.command('launch')
  .description('Start the Harness; diagnose automatically when it fails to boot')
  .option('-p, --profile <name>', 'profile to recover when boot fails', DEFAULT_PROFILE)
  .option('--auto-recover', 'apply confirmed recovery and relaunch once when boot fails')
  .action(async (options: { profile?: string; autoRecover?: boolean }) => {
    let code = await runDshInherit()
    if (code === null) {
      process.stderr.write('Failed to launch dsh (command not found on PATH?).\n')
      process.exitCode = 2
      return
    }
    if (code === 0) return
    process.stderr.write(`\nThe Harness exited with code ${String(code)} during boot.\n`)
    if (options.autoRecover !== true) {
      const probe = await probeBoot({ profile: options.profile ?? DEFAULT_PROFILE, timeoutMs: 30000 })
      if (probe.status === 'failed' || probe.status === 'timeout') {
        for (const item of probe.issues) process.stderr.write(`[${item.code}] ${item.title}: ${item.message}\n`)
      }
      process.stderr.write('Run `dsh-doctor recover --yes` to repair, or `dsh-doctor launch --auto-recover`.\n')
      process.exitCode = 1
      return
    }
    process.stderr.write('Running Doctor recovery…\n')
    const outcome = await recoverOnce({
      profile: options.profile ?? DEFAULT_PROFILE,
      confirmed: true, online: false, includePaths: false, bootTimeoutMs: 60000, port: DEFAULT_WEB_PORT,
    })
    if (outcome.run.phase === 'failed') {
      process.stderr.write(`Recovery failed: ${outcome.run.error ?? 'unknown error'}\n`)
      process.exitCode = 1
      return
    }
    process.stderr.write('Recovery succeeded; relaunching the Harness…\n')
    code = await runDshInherit()
    process.exitCode = code === 0 ? 0 : 1
  })

program.command('rollback')
  .description('Restore every file from a Doctor checkpoint')
  .argument('<checkpoint-id>')
  .option('--json', 'emit machine-readable JSON')
  .action(async (checkpointId: string, options: { json?: boolean }) => {
    const checkpoint = await new DoctorEngine().rollback(checkpointId)
    if (options.json) process.stdout.write(`${JSON.stringify(checkpoint, null, 2)}\n`)
    else process.stdout.write(`Restored checkpoint ${checkpoint.id} for profile ${checkpoint.profile}.\n`)
  })

try {
  await program.parseAsync(process.argv)
} catch (error) {
  if (error instanceof CommanderError) {
    process.exitCode = error.exitCode === 0 ? 0 : 2
  } else {
    process.stderr.write(`DSH Doctor failed: ${String(error)}\n`)
    process.exitCode = 2
  }
}
