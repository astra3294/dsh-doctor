import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { rename } from 'node:fs/promises'
import { spawn } from 'node:child_process'
import { CHECKPOINT_RETENTION, PLAN_TTL_MS } from './constants.js'
import {
  createCheckpoint, findLastHealthyCheckpoint, listCheckpoints, restoreCheckpointFile, rollbackCheckpoint,
} from './checkpoints.js'
import { atomicWrite, ensurePrivateDir, fileHash, readText, sha256, withFileLock } from './fs-utils.js'
import { Document, parseDocument, YAMLMap, YAMLSeq } from 'yaml'
import { doctorRoot, profileRoot, resolveDshHome, resolveSymbolicPath, safeProfileName } from './paths.js'
import { blockingIssues, scanHarness } from './scanner.js'
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
  const files = [
    join(root, 'package.json'),
    join(root, 'cordis.patch.yml'),
    join(root, 'cordis.yml'),
    join(root, 'pnpm-workspace.yaml'),
    join(dshHome, 'settings.yaml'),
  ]
  const hashes: Record<string, string | undefined> = {}
  for (const file of files) hashes[file] = await fileHash(file)
  return sha256(JSON.stringify(hashes))
}

function repairableFile(issueFile: string | undefined, dshHome: string): string | undefined {
  return issueFile === undefined ? undefined : resolveSymbolicPath(issueFile, dshHome)
}

/** Issue codes whose broken file can be fixed by a config reset/synthesis. */
const CONFIG_FAMILY = new Set([
  'PROFILE_JSON_INVALID', 'PROFILE_MANIFEST_MISSING', 'CORDIS_PATCH_INVALID',
  'CORDIS_YML_INVALID', 'WORKSPACE_YAML_INVALID', 'SETTINGS_INVALID',
])

const PROTECTED_IDS = new Set([
  'modules', 'connection', 'client-runtime', 'ui-layout', 'ui-sidebar', 'ui-settings', 'ui-conversation', 'dsh-doctor',
])

// ---------------------------------------------------------------------------
// cordis.patch.yml edits. The loader requires ONE top-level YAML array of
// patch entries; every edit parses the AST, mutates the sequence, and
// re-stringifies the whole document — never string concatenation.
// ---------------------------------------------------------------------------

function parsePatchDocument(current: string): Document {
  const doc = parseDocument(current)
  if (doc.errors.length > 0) throw new Error('cannot modify cordis.patch.yml while it is invalid')
  return doc
}

function requirePatchList(doc: Document): YAMLSeq {
  if (doc.contents === null) {
    const list = new YAMLSeq()
    doc.contents = list
    return list
  }
  if (doc.contents instanceof YAMLSeq) return doc.contents
  throw new Error('cordis.patch.yml must be a top-level array of patch entries')
}

function patchEntryId(item: unknown): unknown {
  if (item instanceof YAMLMap) return item.get('id') as unknown
  if (item !== null && typeof item === 'object' && 'id' in item) return (item as { id?: unknown }).id
  return undefined
}

async function appendPatchDisable(dshHome: string, profile: string, target: string): Promise<void> {
  const patchPath = join(profileRoot(dshHome, profile), 'cordis.patch.yml')
  const current = await readText(patchPath) ?? ''
  const doc = parsePatchDocument(current)
  const list = requirePatchList(doc)
  if (!list.items.some(item => patchEntryId(item) === target)) {
    const map = new YAMLMap()
    map.set('id', target)
    map.set('disabled', true)
    list.items.push(map)
  }
  if (list.flow) list.flow = false
  await atomicWrite(patchPath, `${doc.toString().trimEnd()}\n`)
}

async function removePatchDisable(dshHome: string, profile: string, target: string): Promise<void> {
  const patchPath = join(profileRoot(dshHome, profile), 'cordis.patch.yml')
  const current = await readText(patchPath) ?? ''
  const doc = parsePatchDocument(current)
  const list = requirePatchList(doc)
  list.items = list.items.filter(item => !(
    patchEntryId(item) === target && item instanceof YAMLMap && (item.get('disabled') as unknown) === true
  ))
  await atomicWrite(patchPath, `${doc.toString().trimEnd()}\n`)
}

// ---------------------------------------------------------------------------
// Cold-start synthesis: minimal valid config files for a first rescue.
// ---------------------------------------------------------------------------

function synthesizedContent(file: string): string | undefined {
  const name = file.replace(/\\/g, '/').split('/').at(-1) ?? ''
  switch (name) {
    case 'package.json':
      return `${JSON.stringify({
        name: 'dsh-profile-web',
        private: true,
        dependencies: {},
        dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app'] } },
      }, null, 2)}\n`
    case 'cordis.patch.yml':
      return '# Your patch layer for this dsh profile, applied after every bundle layer:\n# a top-level YAML array of loader patch entries (id-targeted config\n# overrides, disables, and insert lists).\n[]\n'
    case 'cordis.yml':
      return '# dsh profile root — an empty entry list. Edit cordis.patch.yml, not this file.\n[]\n'
    case 'pnpm-workspace.yaml':
      return 'packages:\n  - .\n\nnodeLinker: hoisted\nautoInstallPeers: false\n'
    case 'settings.yaml':
    case 'settings.yml':
    case 'settings.json':
      return '{}\n'
    default:
      return undefined
  }
}

async function synthesizeManifest(dshHome: string, file: string): Promise<void> {
  const content = synthesizedContent(file)
  if (content === undefined) throw new Error(`cannot synthesize a minimal manifest for ${file}`)
  await atomicWrite(file, content)
}

async function quarantineFile(dshHome: string, file: string): Promise<void> {
  const target = `${file}.doctor-quarantine-${new Date().toISOString().replace(/[:.]/g, '-')}`
  await rename(file, target)
}

// ---------------------------------------------------------------------------
// Engine
// ---------------------------------------------------------------------------

export class DoctorEngine {
  private readonly plans = new Map<string, StoredPlan>()
  private readonly runs: DoctorRun[] = []
  private historyLoaded = false

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

    // Config-family corruption: one-click reset to the latest healthy
    // checkpoint, or synthesize minimal configs on a cold start.
    const configIssues = report.issues.filter(item => CONFIG_FAMILY.has(item.code))
    if (supported && configIssues.length > 0) {
      if (healthy !== undefined) {
        actions.push({
          id: randomUUID(), issueCode: 'LKG_RESET', kind: 'reset-to-healthy',
          title: 'Restore profile to the last healthy checkpoint',
          description: `Restore every config file from the healthy checkpoint ${healthy.id} (${healthy.createdAt}).`,
          profile, sourceCheckpointId: healthy.id,
          risk: 'safe', reversible: true, needsRestart: true,
        })
      } else {
        for (const item of configIssues) {
          const file = repairableFile(item.file, dshHome)
          if (file === undefined) continue
          actions.push({
            id: randomUUID(), issueCode: item.code, kind: 'synthesize-manifest',
            title: `Rebuild a minimal valid ${item.title.toLowerCase()}`,
            description: 'No healthy checkpoint exists yet. Write a minimal valid file; the broken original is preserved in the pre-repair checkpoint.',
            profile, file, risk: 'confirmation', reversible: true, needsRestart: true,
          })
        }
        actions.push({
          id: randomUUID(), issueCode: 'COLD_START_NO_CHECKPOINT', kind: 'manual',
          title: 'No healthy checkpoint exists',
          description: 'This is a cold-start rescue: only explicitly confirmed synthesis can rebuild the broken files.',
          profile, risk: 'manual', reversible: false, needsRestart: true,
        })
      }
    }

    // Dependency reconciliation (one action regardless of issue count).
    if (supported && report.issues.some(item => ['PROFILE_DEPENDENCY_MISSING', 'BROKEN_PROFILE_LINK'].includes(item.code))) {
      actions.push({
        id: randomUUID(), issueCode: 'PROFILE_DEPENDENCY_MISSING', kind: 'install-profile-dependencies',
        title: 'Reconcile profile dependencies',
        description: 'Run pnpm install in the profile. Network access is used only when explicitly enabled.',
        profile, risk: 'confirmation', reversible: true, needsRestart: true,
      })
    }

    for (const item of report.issues) {
      if (item.code === 'PLUGIN_RUNTIME_FAILED') {
        const target = item.evidence
        actions.push({
          id: randomUUID(), issueCode: item.code, kind: PROTECTED_IDS.has(target ?? '') ? 'manual' : 'disable-plugin',
          title: PROTECTED_IDS.has(target ?? '') ? 'Repair the failed core plugin manually' : 'Disable the failed plugin',
          description: PROTECTED_IDS.has(target ?? '')
            ? `${target ?? 'A required plugin'} is part of the Web rescue path and cannot be disabled safely.`
            : `Persist disabled: true for ${target ?? 'the failed plugin'} in the active profile patch.`,
          profile, target,
          risk: PROTECTED_IDS.has(target ?? '') ? 'manual' : 'confirmation', reversible: true, needsRestart: true,
        })
      }
      if (item.code === 'PLUGIN_DISABLED' && typeof item.evidence === 'string') {
        actions.push({
          id: randomUUID(), issueCode: item.code, kind: 'undisable-plugin',
          title: 'Re-enable a Doctor-disabled plugin',
          description: `Remove the disabled entry for ${item.evidence} from the profile patch.`,
          profile, target: item.evidence, risk: 'confirmation', reversible: true, needsRestart: true,
        })
      }
      if (item.code === 'SESSION_STORE_CORRUPT') {
        const file = repairableFile(item.file, dshHome)
        if (file === undefined) continue
        actions.push({
          id: randomUUID(), issueCode: item.code, kind: 'quarantine-session-file',
          title: 'Quarantine the corrupt session file',
          description: 'Rename the corrupt file aside (reversible); the Harness can then start fresh sessions.',
          profile, file, risk: 'confirmation', reversible: true, needsRestart: true,
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
          // Successful recovery refreshes the healthy baseline (best effort).
          if (verification.blocking === 0) {
            await createCheckpoint(stored.dshHome, profile, 'healthy', true).catch(() => {})
          }
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
    const blocking = blockingIssues(report)
    return blocking.length === 0
      ? {
        structural: 'passed', liveProbe: 'not-requested', summary: report.summary, blocking: 0,
        message: 'Structural checks passed; live model verification was not requested.',
      }
      : {
        structural: 'failed', liveProbe: 'not-requested', summary: report.summary, blocking: blocking.length,
        message: `${String(blocking.length)} blocking issue(s) remain.`,
      }
  }

  async markHealthy(profile: string, options: { dshHome?: string } = {}) {
    const dshHome = resolveDshHome(options.dshHome ?? this.defaultHome)
    const report = await this.scan({ dshHome, profile })
    const blocking = blockingIssues(report)
    if (blocking.length > 0) {
      throw new Error(`current profile cannot be marked healthy while ${String(blocking.length)} blocking issue(s) remain: ${blocking.slice(0, 3).map(item => item.code).join(', ')}`)
    }
    return createCheckpoint(dshHome, profile, 'healthy', true)
  }

  async rollback(checkpointId: string, options: { dshHome?: string } = {}) {
    return rollbackCheckpoint(resolveDshHome(options.dshHome ?? this.defaultHome), checkpointId)
  }

  async history(options: { dshHome?: string; profile?: string } = {}) {
    const dshHome = resolveDshHome(options.dshHome ?? this.defaultHome)
    if (!this.historyLoaded) {
      this.historyLoaded = true
      await this.loadPersistedHistory(dshHome)
    }
    return { runs: this.runs.slice(0, 20), checkpoints: await listCheckpoints(dshHome, options.profile) }
  }

  private replaceRun(run: DoctorRun): void {
    const index = this.runs.findIndex(item => item.id === run.id)
    if (index >= 0) this.runs[index] = run
    else this.runs.unshift(run)
  }

  private async loadPersistedHistory(dshHome: string): Promise<void> {
    try {
      const raw = await readText(join(doctorRoot(dshHome), 'history.json'))
      if (raw === undefined) return
      const parsed = JSON.parse(raw) as unknown
      if (Array.isArray(parsed)) {
        const valid = parsed.filter(item => item !== null && typeof item === 'object' && 'id' in item && 'phase' in item) as DoctorRun[]
        this.runs.push(...valid.slice(0, 20))
      }
    } catch {}
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
      case 'reset-to-healthy': {
        if (action.sourceCheckpointId === undefined) throw new Error('reset action is incomplete')
        await rollbackCheckpoint(dshHome, action.sourceCheckpointId)
        return
      }
      case 'synthesize-manifest': {
        if (action.file === undefined) throw new Error('synthesis action is incomplete')
        await synthesizeManifest(dshHome, action.file)
        return
      }
      case 'install-profile-dependencies': {
        const profile = safeProfileName(action.profile ?? 'web')
        await runPnpmInstall(profileRoot(dshHome, profile), options.online ?? false)
        return
      }
      case 'disable-plugin': {
        const profile = safeProfileName(action.profile ?? 'web')
        const target = action.target
        if (target === undefined || !/^[A-Za-z0-9._/-]+$/.test(target)) throw new Error('failed plugin id is invalid')
        if (PROTECTED_IDS.has(target)) throw new Error(`Doctor refuses to disable required plugin ${target}`)
        await appendPatchDisable(dshHome, profile, target)
        return
      }
      case 'undisable-plugin': {
        const profile = safeProfileName(action.profile ?? 'web')
        const target = action.target
        if (target === undefined || !/^[A-Za-z0-9._/-]+$/.test(target)) throw new Error('plugin id is invalid')
        if (PROTECTED_IDS.has(target)) throw new Error(`Doctor refuses to re-enable required plugin ${target}`)
        await removePatchDisable(dshHome, profile, target)
        return
      }
      case 'quarantine-session-file': {
        if (action.file === undefined) throw new Error('quarantine action is incomplete')
        await quarantineFile(dshHome, action.file)
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
