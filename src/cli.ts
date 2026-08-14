import { Command, CommanderError } from 'commander'
import { DEFAULT_PROFILE, DOCTOR_VERSION } from './constants.js'
import { DoctorEngine } from './repair.js'
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
  for (const item of report.issues) outputIssue(item)
}

function outputIssue(item: DoctorIssue): void {
  const marker = item.severity === 'error' ? 'ERROR' : item.severity === 'warning' ? 'WARN' : 'INFO'
  process.stdout.write(`\n[${marker}] ${item.code}: ${item.title}\n  ${item.message}\n`)
  if (item.evidence !== undefined) process.stdout.write(`  ${item.evidence}\n`)
}

function exitCode(report: DoctorScanReport, strict: boolean): number {
  if (report.summary.errors > 0) return 1
  if (strict && report.summary.warnings > 0) return 1
  return 0
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

program.command('recover')
  .description('Create a checkpoint and apply deterministic recovery actions')
  .option('-p, --profile <name>', 'profile to recover', DEFAULT_PROFILE)
  .option('--yes', 'confirm reversible dependency reconciliation actions')
  .option('--online', 'allow package manager network access')
  .option('--json', 'emit machine-readable JSON')
  .option('--include-paths', 'include absolute local paths in output')
  .action(async (options: CommonOptions & { yes?: boolean }) => {
    const profile = options.profile ?? DEFAULT_PROFILE
    const engine = new DoctorEngine()
    const report = await engine.scan({ profile, online: options.online, includePaths: options.includePaths })
    const plan = await engine.plan(report, { profile })
    const safe = plan.actions.filter(action => action.risk === 'safe')
    const confirmed = plan.actions.filter(action => action.risk === 'confirmation')
    const selected = options.yes ? [...safe, ...confirmed] : safe
    const run = await engine.apply(plan.id, {
      actionIds: selected.map(action => action.id),
      confirmed: options.yes,
      online: options.online,
    })
    if (options.json) process.stdout.write(`${JSON.stringify({ report, plan, run }, null, 2)}\n`)
    else {
      outputReport(report, false)
      process.stdout.write(`\nRecovery: ${run.phase}\n`)
      for (const result of run.results) process.stdout.write(`  ${result.ok ? 'OK' : 'FAILED'} ${result.message}\n`)
      if (confirmed.length > 0 && !options.yes) process.stdout.write(`\n${String(confirmed.length)} action(s) require confirmation. Re-run with --yes after reviewing the report.\n`)
      if (run.error !== undefined) process.stderr.write(`${run.error}\n`)
    }
    process.exitCode = run.phase === 'failed' ? 1 : 0
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
