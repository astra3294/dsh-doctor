import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { spawn } from 'node:child_process'
import { CHECKPOINT_RETENTION, PLAN_TTL_MS } from './constants.js'
import {
  createCheckpoint, findLastHealthyCheckpoint, listCheckpoints, restoreCheckpointFile, rollbackCheckpoint,
} from './checkpoints.js'
import { atomicWrite, ensurePrivateDir, fileHash, readText, sha256, withFileLock } from './fs-utils.js'
import { parseDocument, stringify } from 'yaml'
import { doctorRoot, profileRoot, resolveDshHome, safeProfileName } from './paths.js'
import { scanHarness } from './scanner.js'
import type {
  ApplyPlanOptions, DoctorRun, DoctorScanReport, DoctorVerification, RepairAction, RepairPlan, ScanOptions,
} from './types.js'

interface StoredPlan {
  readonly plan: RepairPlan
  readonly report: DoctorScanReport
  readonly dshHome: string
}

function actionFingerprint(report: DoctorScanReport, actions: readonly RepairAction[]): string {
  return sha256(JSON.stringify({ scanId: report.id, issues: report.issues, actions }))
}

async function profileFileFingerprint(dshHome: string, profile: string): Promise<string> {
  const root = profileRoot(dshHome, profile)
  const files = [join(root, 'package.json'), join(root, 'cordis.patch.yml'), join(dshHome, 'settings.yaml')]
  const hashes: Record<string, string | undefined> = {}
  for (const file of files) hashes[file] = await fileHash(file)
  return sha256(JSON.stringify(hashes))
}

function repairableFile(issueFile: string | undefined, dshHome: string): string | undefined {
  if (issueFile === undefined || issueFile.includes('$DSH_HOME')) {
    if (issueFile === undefined) return undefined
    return issueFile.replace('$DSH_HOME', dshHome)
  }
  return issueFile.startsWith('<') ? undefined : issueFile
}

export class DoctorEngine {
  private readonly plans = new Map<string, StoredPlan>()
  private readonly runs: DoctorRun[] = []

  constructor(private readonly defaultHome?: string) {}

  async scan(options: ScanOptions = {}): Promise<DoctorScanReport> {
    return scanHarness({ ...options, dshHome: options.dshHome ?? this.defaultHome })
  }

  async plan(report: DoctorScanReport, options: { dshHome?: string; profile?: string } = {}): Promise<RepairPlan> {
    const dshHome = resolveDshHome(options.dshHome ?? this.defaultHome)
    const profile = safeProfileName(options.profile ?? report.profiles[0]?.name ?? 'web')
    const healthy = await findLastHealthyCheckpoint(dshHome, profile)
    const actions: RepairAction[] = [{
      id: randomUUID(), issueCode: 'DOCTOR_STATE', kind: 'ensure-doctor-state',
      title: 'Prepare Doctor recovery state',
      description: `Create protected state and retain ${String(CHECKPOINT_RETENTION)} checkpoints.`,
      profile, risk: 'safe', reversible: true, needsRestart: false,
    }]
    const supported = !report.issues.some(item => ['DSH_VERSION_UNKNOWN', 'DSH_VERSION_UNSUPPORTED'].includes(item.code))
    for (const item of report.issues) {
      const file = repairableFile(item.file, dshHome)
      if (supported && healthy !== undefined && file !== undefined
        && ['PROFILE_JSON_INVALID', 'PROFILE_MANIFEST_MISSING', 'CORDIS_PATCH_INVALID', 'SETTINGS_INVALID'].includes(item.code)) {
        actions.push({
          id: randomUUID(), issueCode: item.code, kind: 'restore-checkpoint-file',
          title: `Restore ${item.title.toLowerCase()}`,
          description: 'Restore only the proven-invalid file from the most recent healthy checkpoint.',
          profile, file, sourceCheckpointId: healthy.id,
          risk: 'safe', reversible: true, needsRestart: true,
        })
        continue
      }
      if (supported && ['PROFILE_DEPENDENCY_MISSING', 'BROKEN_PROFILE_LINK'].includes(item.code)) {
        actions.push({
          id: randomUUID(), issueCode: item.code, kind: 'install-profile-dependencies',
          title: 'Reconcile profile dependencies',
          description: 'Run pnpm install in the profile. Network access is used only when explicitly enabled.',
          profile, risk: 'confirmation', reversible: true, needsRestart: true,
        })
        continue
      }
      if (item.code === 'PLUGIN_RUNTIME_FAILED') {
        const target = item.evidence
        const protectedIds = new Set(['modules', 'connection', 'client-runtime', 'ui-layout', 'ui-sidebar', 'ui-settings', 'ui-conversation', 'dsh-doctor'])
        actions.push({
          id: randomUUID(), issueCode: item.code, kind: protectedIds.has(target ?? '') ? 'manual' : 'disable-plugin',
          title: protectedIds.has(target ?? '') ? 'Repair the failed core plugin manually' : 'Disable the failed plugin',
          description: protectedIds.has(target ?? '')
            ? `${target ?? 'A required plugin'} is part of the Web rescue path and cannot be disabled safely.`
            : `Persist disabled: true for ${target ?? 'the failed plugin'} in the active profile patch.`,
          profile, target,
          risk: protectedIds.has(target ?? '') ? 'manual' : 'confirmation', reversible: true, needsRestart: true,
        })
      }
    }
    const createdAt = new Date()
    const plan: RepairPlan = {
      id: randomUUID(),
      scanId: report.id,
      createdAt: createdAt.toISOString(),
      expiresAt: new Date(createdAt.getTime() + PLAN_TTL_MS).toISOString(),
      actions,
      fingerprint: `${actionFingerprint(report, actions)}:${await profileFileFingerprint(dshHome, profile)}`,
    }
    this.plans.set(plan.id, { plan, report, dshHome })
    return plan
  }

  async apply(planId: string, options: ApplyPlanOptions = {}): Promise<DoctorRun> {
    const stored = this.plans.get(planId)
    if (stored === undefined) throw new Error('repair plan is missing or expired; scan again')
    if (Date.now() > Date.parse(stored.plan.expiresAt)) {
      this.plans.delete(planId)
      throw new Error('repair plan expired; scan again')
    }
    const profile = stored.plan.actions.find(action => action.profile !== undefined)?.profile ?? 'web'
    const currentFingerprint = `${actionFingerprint(stored.report, stored.plan.actions)}:${await profileFileFingerprint(stored.dshHome, profile)}`
    if (currentFingerprint !== stored.plan.fingerprint) throw new Error('profile changed after scanning; scan again')
    const selected = options.actionIds === undefined
      ? stored.plan.actions
      : stored.plan.actions.filter(action => options.actionIds?.includes(action.id))
    if (selected.some(action => action.risk === 'confirmation') && options.confirmed !== true) {
      throw new Error('selected repair actions require explicit confirmation')
    }
    if (selected.some(action => action.risk === 'manual')) {
      throw new Error('manual repair actions cannot be executed automatically')
    }

    const startedAt = new Date().toISOString()
    let run: DoctorRun = { id: randomUUID(), phase: 'checkpointing', startedAt, profile, results: [] }
    this.runs.unshift(run)
    const lock = join(doctorRoot(stored.dshHome), 'repair.lock')
    return withFileLock(lock, async () => {
      const checkpoint = await createCheckpoint(stored.dshHome, profile, 'pre-repair', false)
      run = { ...run, phase: 'repairing', checkpointId: checkpoint.id }
      this.replaceRun(run)
      const results: { actionId: string; ok: boolean; message: string }[] = []
      try {
        for (const action of selected) {
          await this.executeAction(stored.dshHome, action, options)
          results.push({ actionId: action.id, ok: true, message: action.title })
        }
        run = { ...run, phase: 'verifying', results }
        this.replaceRun(run)
        const verification = await this.verify({ dshHome: stored.dshHome, profile })
        if (verification.structural === 'failed') {
          await rollbackCheckpoint(stored.dshHome, checkpoint.id)
          run = {
            ...run, phase: 'failed', results, verification,
            finishedAt: new Date().toISOString(), error: 'verification failed; pre-repair checkpoint restored',
          }
        } else {
          const needsRestart = selected.some(action => action.needsRestart)
          run = {
            ...run, phase: needsRestart ? 'restart-required' : 'recovered', results, verification,
            finishedAt: new Date().toISOString(),
          }
        }
      } catch (error) {
        await rollbackCheckpoint(stored.dshHome, checkpoint.id).catch(() => {})
        run = {
          ...run, phase: 'failed', results,
          finishedAt: new Date().toISOString(), error: String(error),
        }
      }
      this.replaceRun(run)
      await this.persistHistory(stored.dshHome)
      return run
    })
  }

  async verify(options: ScanOptions = {}): Promise<DoctorVerification> {
    const report = await this.scan(options)
    const blocking = report.issues.filter(item => item.severity === 'error')
    return blocking.length === 0
      ? { structural: 'passed', liveProbe: 'not-requested', message: 'Structural checks passed; live model verification was not requested.' }
      : { structural: 'failed', liveProbe: 'not-requested', message: `${String(blocking.length)} blocking issue(s) remain.` }
  }

  async markHealthy(profile: string, options: { dshHome?: string } = {}) {
    const dshHome = resolveDshHome(options.dshHome ?? this.defaultHome)
    const report = await this.scan({ dshHome, profile })
    if (report.summary.errors > 0) throw new Error('current profile cannot be marked healthy while errors remain')
    return createCheckpoint(dshHome, profile, 'healthy', true)
  }

  async rollback(checkpointId: string, options: { dshHome?: string } = {}) {
    return rollbackCheckpoint(resolveDshHome(options.dshHome ?? this.defaultHome), checkpointId)
  }

  async history(options: { dshHome?: string; profile?: string } = {}) {
    const dshHome = resolveDshHome(options.dshHome ?? this.defaultHome)
    return { runs: this.runs.slice(0, 20), checkpoints: await listCheckpoints(dshHome, options.profile) }
  }

  private replaceRun(run: DoctorRun): void {
    const index = this.runs.findIndex(item => item.id === run.id)
    if (index >= 0) this.runs[index] = run
    else this.runs.unshift(run)
  }

  private async persistHistory(dshHome: string): Promise<void> {
    await ensurePrivateDir(doctorRoot(dshHome))
    await atomicWrite(join(doctorRoot(dshHome), 'history.json'), `${JSON.stringify(this.runs.slice(0, 20), null, 2)}\n`)
  }

  private async executeAction(dshHome: string, action: RepairAction, options: ApplyPlanOptions): Promise<void> {
    switch (action.kind) {
      case 'ensure-doctor-state':
        await ensurePrivateDir(doctorRoot(dshHome))
        return
      case 'restore-checkpoint-file':
        if (action.sourceCheckpointId === undefined || action.file === undefined) throw new Error('restore action is incomplete')
        await restoreCheckpointFile(dshHome, action.sourceCheckpointId, action.file)
        return
      case 'install-profile-dependencies': {
        const profile = safeProfileName(action.profile ?? 'web')
        await runPnpmInstall(profileRoot(dshHome, profile), options.online ?? false)
        return
      }
      case 'disable-plugin': {
        const profile = safeProfileName(action.profile ?? 'web')
        const target = action.target
        if (target === undefined || !/^[A-Za-z0-9._/-]+$/.test(target)) throw new Error('failed plugin id is invalid')
        const protectedIds = new Set(['modules', 'connection', 'client-runtime', 'ui-layout', 'ui-sidebar', 'ui-settings', 'ui-conversation', 'dsh-doctor'])
        if (protectedIds.has(target)) throw new Error(`Doctor refuses to disable required plugin ${target}`)
        const patchPath = join(profileRoot(dshHome, profile), 'cordis.patch.yml')
        const current = await readText(patchPath) ?? ''
        const parsed = parseDocument(current)
        if (parsed.errors.length > 0) throw new Error('cannot disable a plugin while cordis.patch.yml is invalid')
        const suffix = stringify([{ id: target, disabled: true }]).trimEnd()
        await atomicWrite(patchPath, `${current.trimEnd()}${current.trim().length > 0 ? '\n\n' : ''}# Disabled by DSH Doctor after explicit confirmation.\n${suffix}\n`)
        return
      }
      default:
        throw new Error(`${action.kind} requires manual repair in v0.1.0`)
    }
  }
}

async function runPnpmInstall(cwd: string, online: boolean): Promise<void> {
  await new Promise<void>((resolvePromise, reject) => {
    const command = process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm'
    const args = ['install', '--frozen-lockfile=false', ...(online ? [] : ['--offline'])]
    const child = spawn(command, args, { cwd, stdio: 'ignore', windowsHide: true })
    const timer = setTimeout(() => child.kill(), 120_000)
    child.once('error', error => { clearTimeout(timer); reject(error) })
    child.once('exit', code => {
      clearTimeout(timer)
      if (code === 0) resolvePromise()
      else reject(new Error(`pnpm install exited with code ${String(code)}`))
    })
  })
}
