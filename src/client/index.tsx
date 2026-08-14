import { useCallback, useEffect, useRef, useState, useSyncExternalStore, type ReactNode } from 'react'
import {
  IconCheckOutline16, IconCloseOutline16, IconRefreshOutline16, IconSettingsOutline16,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client'
import { RPC_CHANNEL } from '../constants.js'
import type {
  DoctorCheckpoint, DoctorRun, DoctorScanReport, RepairAction, RepairPlan,
} from '../types.js'
import { installDoctorStyles } from './styles.js'

type Translator = (key: string) => string

interface RpcFailure {
  readonly code: string
  readonly message: string
}

interface RpcResult<T> {
  readonly ok: boolean
  readonly value?: T
  readonly error?: RpcFailure
}

interface Connection {
  readonly isLoopback?: boolean
  readonly rpc: {
    call(channel: string, endpoint: string, payload: unknown, signal?: AbortSignal): Promise<RpcResult<unknown>>
  }
}

interface ControllerSnapshot {
  readonly open: boolean
  readonly busy: boolean
  readonly available: boolean
  readonly phase: string
  readonly rescueCommand: string
  readonly report?: DoctorScanReport
  readonly plan?: RepairPlan
  readonly run?: DoctorRun
  readonly confirmationActions: readonly RepairAction[]
  readonly askLiveProbe: boolean
  readonly liveProbe?: { status: 'passed' | 'failed' | 'unavailable'; message: string }
  readonly checkpoints: readonly DoctorCheckpoint[]
  readonly error?: string
}

const INITIAL: ControllerSnapshot = {
  open: false,
  busy: false,
  available: true,
  phase: 'ready',
  rescueCommand: 'npx dsh-doctor recover --profile web',
  confirmationActions: [],
  askLiveProbe: false,
  checkpoints: [],
}

class DoctorController {
  private snapshot: ControllerSnapshot = INITIAL
  private readonly listeners = new Set<() => void>()
  private initialized = false
  private markedHealthy = false

  constructor(private readonly connection: Connection) {}

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  getSnapshot = (): ControllerSnapshot => this.snapshot

  async initialize(): Promise<void> {
    if (this.initialized) return
    this.initialized = true
    try {
      const status = await this.call<{ available: boolean; rescueCommand: string }>('status', {})
      this.patch({ available: status.available, rescueCommand: status.rescueCommand })
      await Promise.all([this.scan(), this.loadHistory()])
    } catch (error) {
      this.patch({ available: false, error: String(error) })
    }
  }

  open = (): void => { this.patch({ open: true }); void this.initialize() }
  close = (): void => this.patch({ open: false })

  async scan(): Promise<DoctorScanReport | undefined> {
    this.patch({ busy: true, phase: 'scanning', error: undefined })
    try {
      const report = await this.call<DoctorScanReport>('scan', {})
      this.patch({ report, busy: false, phase: 'ready' })
      return report
    } catch (error) {
      this.patch({ busy: false, available: false, phase: 'failed', error: String(error) })
      return undefined
    }
  }

  async recover(confirmed = false): Promise<void> {
    this.patch({ busy: true, phase: 'checkpointing', error: undefined, askLiveProbe: false, liveProbe: undefined })
    try {
      const report = await this.call<DoctorScanReport>('scan', {})
      let plan = await this.call<RepairPlan>('plan', { report })
      const selected = confirmed
        ? plan.actions.filter(action => action.risk !== 'manual')
        : plan.actions.filter(action => action.risk === 'safe')
      let run: DoctorRun | undefined
      if (selected.length > 0) run = await this.call<DoctorRun>('apply', {
        planId: plan.id,
        options: { actionIds: selected.map(action => action.id), confirmed },
      })
      const refreshed = await this.call<DoctorScanReport>('scan', {})
      plan = await this.call<RepairPlan>('plan', { report: refreshed })
      const confirmations = plan.actions.filter(action => action.risk === 'confirmation')
      const structurallyHealthy = refreshed.summary.errors === 0
      this.patch({
        busy: false,
        phase: structurallyHealthy ? (run?.phase ?? 'recovered') : 'needs-attention',
        report: refreshed,
        plan,
        run,
        confirmationActions: confirmations,
        askLiveProbe: structurallyHealthy,
      })
      await this.loadHistory()
    } catch (error) {
      this.patch({ busy: false, phase: 'failed', error: String(error) })
    }
  }

  async liveProbe(): Promise<void> {
    this.patch({ busy: true, phase: 'verifying', error: undefined })
    try {
      const result = await this.call<{ status: 'passed' | 'failed' | 'unavailable'; message: string }>('live-probe', {})
      this.patch({ busy: false, phase: result.status === 'passed' ? 'recovered' : 'needs-attention', askLiveProbe: false, liveProbe: result })
    } catch (error) {
      this.patch({ busy: false, phase: 'needs-attention', askLiveProbe: false, error: String(error) })
    }
  }

  skipLiveProbe(): void {
    this.patch({ askLiveProbe: false, liveProbe: { status: 'unavailable', message: 'Structural recovery passed; live conversation verification was skipped.' } })
  }

  async loadHistory(): Promise<void> {
    try {
      const history = await this.call<{ checkpoints: DoctorCheckpoint[] }>('history', {})
      this.patch({ checkpoints: history.checkpoints })
    } catch {}
  }

  async rollback(checkpointId: string): Promise<void> {
    this.patch({ busy: true, phase: 'repairing', error: undefined })
    try {
      await this.call('rollback', { checkpointId })
      await this.scan()
      await this.loadHistory()
    } catch (error) {
      this.patch({ busy: false, phase: 'failed', error: String(error) })
    }
  }

  async markHealthy(): Promise<void> {
    if (this.markedHealthy) return
    this.markedHealthy = true
    try {
      await this.call('mark-healthy', {})
      await this.loadHistory()
    } catch {
      this.markedHealthy = false
    }
  }

  private patch(next: Partial<ControllerSnapshot>): void {
    this.snapshot = { ...this.snapshot, ...next }
    for (const listener of this.listeners) listener()
  }

  private async call<T = unknown>(endpoint: string, payload: unknown): Promise<T> {
    const result = await this.connection.rpc.call(RPC_CHANNEL, endpoint, payload)
    if (!result.ok) throw new Error(result.error?.message ?? `${endpoint} failed`)
    return result.value as T
  }
}

function useDoctor(controller: DoctorController): ControllerSnapshot {
  return useSyncExternalStore(controller.subscribe, controller.getSnapshot, controller.getSnapshot)
}

function healthLevel(snapshot: ControllerSnapshot): 'healthy' | 'warning' | 'error' | 'unknown' {
  if (!snapshot.available) return 'error'
  if (snapshot.report === undefined) return 'unknown'
  if (snapshot.report.summary.errors > 0) return 'error'
  if (snapshot.report.summary.warnings > 0) return 'warning'
  return 'healthy'
}

function phaseLabel(phase: string, t: Translator): string {
  const key = `phase.${phase}`
  const translated = t(key)
  return translated === key ? phase : translated
}

interface SharedProps {
  controller: DoctorController
  t: Translator
}

function DoctorSidebarButton({ controller, t, wide }: SharedProps & { wide: boolean }): ReactNode {
  const snapshot = useDoctor(controller)
  const level = healthLevel(snapshot)
  return (
    <button className="dshDoctorButton" data-wide={String(wide)} type="button" onClick={controller.open} aria-label={t('open')} title={t('open')}>
      <IconSettingsOutline16 size={wide ? 16 : 18} aria-hidden="true" />
      {wide ? <span>{t('doctor')}</span> : null}
      <span className="dshDoctorStatus" data-level={level} aria-hidden="true" />
      <span className="dshDoctorVisuallyHidden">{t(`health.${level}`)}</span>
    </button>
  )
}

function Progress({ phase, t }: { phase: string; t: Translator }): ReactNode {
  const steps = ['checkpointing', 'scanning', 'repairing', 'verifying']
  return (
    <div className="dshDoctorProgress" aria-live="polite">
      <ol>{steps.map(step => <li key={step} data-active={String(phase === step)}>{t(`phase.${step}`)}</li>)}</ol>
    </div>
  )
}

function Summary({ snapshot, t }: { snapshot: ControllerSnapshot; t: Translator }): ReactNode {
  const report = snapshot.report
  return (
    <>
      <div className="dshDoctorHero">
        <span className="dshDoctorHeroIcon" aria-hidden="true"><IconSettingsOutline16 size={20} /></span>
        <div>
          <h3>{phaseLabel(snapshot.phase, t)}</h3>
          <p>{snapshot.available ? t('summary.ready') : t('summary.unavailable')}</p>
        </div>
      </div>
      {report !== undefined ? (
        <div className="dshDoctorCounts" aria-label={t('summary.issues')}>
          <span className="dshDoctorBadge" data-level="error">{String(report.summary.errors)} {t('errors')}</span>
          <span className="dshDoctorBadge" data-level="warning">{String(report.summary.warnings)} {t('warnings')}</span>
          <span className="dshDoctorBadge">{String(report.summary.info)} {t('info')}</span>
        </div>
      ) : null}
    </>
  )
}

function RecoveryActions({ controller, snapshot, t }: SharedProps & { snapshot: ControllerSnapshot }): ReactNode {
  const copyCommand = useCallback(() => { void navigator.clipboard?.writeText(snapshot.rescueCommand) }, [snapshot.rescueCommand])
  if (!snapshot.available) return (
    <div className="dshDoctorActions">
      <button className="dshDoctorSecondary" type="button" onClick={copyCommand}>{t('copyRescue')}</button>
    </div>
  )
  return (
    <>
      <div className="dshDoctorActions">
        <button className="dshDoctorPrimary" type="button" disabled={snapshot.busy} onClick={() => { void controller.recover(false) }}>{t('recover')}</button>
        <button className="dshDoctorSecondary" type="button" disabled={snapshot.busy} onClick={() => { void controller.scan() }}><IconRefreshOutline16 size={14} aria-hidden="true" /> {t('scan')}</button>
      </div>
      {snapshot.confirmationActions.length > 0 ? (
        <div className="dshDoctorCard">
          <h3>{t('confirmation.title')}</h3>
          <ul className="dshDoctorIssueList">{snapshot.confirmationActions.map(action => (
            <li className="dshDoctorIssue" key={action.id}>
              <span className="dshDoctorIssueDot" data-level="warning" />
              <div><strong>{action.title}</strong><p>{action.description}</p></div>
            </li>
          ))}</ul>
          <div className="dshDoctorActions"><button className="dshDoctorDanger" type="button" onClick={() => { void controller.recover(true) }}>{t('confirmation.apply')}</button></div>
        </div>
      ) : null}
      {snapshot.askLiveProbe ? (
        <div className="dshDoctorCard">
          <h3>{t('probe.title')}</h3><p className="dshDoctorEmpty">{t('probe.description')}</p>
          <div className="dshDoctorActions">
            <button className="dshDoctorPrimary" type="button" onClick={() => { void controller.liveProbe() }}>{t('probe.run')}</button>
            <button className="dshDoctorSecondary" type="button" onClick={() => controller.skipLiveProbe()}>{t('probe.skip')}</button>
          </div>
        </div>
      ) : null}
      {snapshot.liveProbe !== undefined ? <div className="dshDoctorProgress"><strong>{t(`probe.${snapshot.liveProbe.status}`)}</strong><br />{snapshot.liveProbe.message}</div> : null}
    </>
  )
}

function DoctorOverlay({ controller, t }: SharedProps): ReactNode {
  const snapshot = useDoctor(controller)
  const closeRef = useRef<HTMLButtonElement | null>(null)
  useEffect(() => {
    if (!snapshot.open) return
    closeRef.current?.focus()
    const onKeyDown = (event: KeyboardEvent) => { if (event.key === 'Escape') controller.close() }
    document.addEventListener('keydown', onKeyDown)
    return () => document.removeEventListener('keydown', onKeyDown)
  }, [controller, snapshot.open])
  if (!snapshot.open) return null
  return (
    <div className="dshDoctorOverlay" role="presentation">
      <div className="dshDoctorMask" onClick={controller.close} aria-hidden="true" />
      <section className="dshDoctorPanel" role="dialog" aria-modal="true" aria-labelledby="dsh-doctor-title">
        <header className="dshDoctorPanelHeader">
          <h2 id="dsh-doctor-title">{t('title')}</h2>
          <button ref={closeRef} className="dshDoctorIconButton" type="button" onClick={controller.close} aria-label={t('close')}><IconCloseOutline16 size={16} /></button>
        </header>
        <Summary snapshot={snapshot} t={t} />
        {snapshot.busy ? <Progress phase={snapshot.phase} t={t} /> : null}
        {snapshot.error !== undefined ? <div className="dshDoctorError" role="alert">{snapshot.error}</div> : null}
        <RecoveryActions controller={controller} snapshot={snapshot} t={t} />
      </section>
    </div>
  )
}

function IssueList({ report, t }: { report?: DoctorScanReport; t: Translator }): ReactNode {
  if (report === undefined || report.issues.length === 0) return <p className="dshDoctorEmpty">{t('issues.empty')}</p>
  return <ul className="dshDoctorIssueList">{report.issues.map((item, index) => (
    <li className="dshDoctorIssue" key={`${item.code}-${String(index)}`}>
      <span className="dshDoctorIssueDot" data-level={item.severity} aria-hidden="true" />
      <div><strong>{item.title}</strong><p>{item.message}</p></div>
    </li>
  ))}</ul>
}

function DoctorSettingsSection({ controller, t }: SharedProps): ReactNode {
  const snapshot = useDoctor(controller)
  useEffect(() => { void controller.initialize(); void controller.loadHistory() }, [controller])
  return (
    <section className="dshDoctorSection" aria-labelledby="dsh-doctor-settings-title">
      <header className="dshDoctorSectionHeader">
        <div><h2 id="dsh-doctor-settings-title">{t('title')}</h2><p>{t('settings.description')}</p></div>
        <button className="dshDoctorSecondary" type="button" disabled={snapshot.busy} onClick={() => { void controller.scan() }}>{t('scan')}</button>
      </header>
      <div className="dshDoctorCard"><Summary snapshot={snapshot} t={t} /><RecoveryActions controller={controller} snapshot={snapshot} t={t} /></div>
      <div className="dshDoctorCard"><h3>{t('issues.title')}</h3><IssueList report={snapshot.report} t={t} /></div>
      <div className="dshDoctorCard">
        <h3>{t('checkpoints.title')}</h3>
        {snapshot.checkpoints.length === 0 ? <p className="dshDoctorEmpty">{t('checkpoints.empty')}</p> : (
          <ul className="dshDoctorHistoryList">{snapshot.checkpoints.map(checkpoint => (
            <li className="dshDoctorHistoryRow" key={checkpoint.id}>
              <span>{checkpoint.kind} · {new Date(checkpoint.createdAt).toLocaleString()}</span>
              <button className="dshDoctorSecondary" type="button" disabled={snapshot.busy} onClick={() => { void controller.rollback(checkpoint.id) }}>{t('rollback')}</button>
            </li>
          ))}</ul>
        )}
      </div>
    </section>
  )
}

interface SessionSnapshot {
  running?: boolean
  promptError?: unknown
  lastAgentError?: string | null
}

function FailureBanner({ controller, t, useSession }: SharedProps & { useSession: (selector: (snapshot: SessionSnapshot) => unknown) => unknown }): ReactNode {
  const doctor = useDoctor(controller)
  const running = Boolean(useSession(snapshot => snapshot.running))
  const promptError = useSession(snapshot => snapshot.promptError)
  const agentError = useSession(snapshot => snapshot.lastAgentError)
  const fingerprint = JSON.stringify([promptError, agentError, doctor.report?.summary.errors ?? 0])
  const [dismissed, setDismissed] = useState<string | undefined>(undefined)
  const previousRunning = useRef(running)
  useEffect(() => {
    if (previousRunning.current && !running && promptError == null && agentError == null) void controller.markHealthy()
    previousRunning.current = running
  }, [agentError, controller, promptError, running])
  const broken = promptError != null || agentError != null || (doctor.report?.summary.errors ?? 0) > 0
  if (!broken || dismissed === fingerprint) return null
  return (
    <div className="dshDoctorBanner" role="alert">
      <div className="dshDoctorBannerText"><span className="dshDoctorIssueDot" data-level="error" />{t('banner')}</div>
      <div className="dshDoctorBannerActions">
        <button className="dshDoctorPrimary" type="button" onClick={controller.open}>{t('recover')}</button>
        <button className="dshDoctorIconButton" type="button" aria-label={t('dismiss')} onClick={() => setDismissed(fingerprint)}><IconCloseOutline16 size={14} /></button>
      </div>
    </div>
  )
}

const en: Record<string, string> = {
  doctor: 'Doctor', open: 'Open DSH Doctor', close: 'Close', dismiss: 'Dismiss', title: 'DSH Doctor', nav: 'Doctor',
  recover: 'One-click recovery', scan: 'Scan again', rollback: 'Rollback', copyRescue: 'Copy rescue command',
  errors: 'errors', warnings: 'warnings', info: 'info', banner: 'Conversation problem detected',
  'health.healthy': 'Healthy', 'health.warning': 'Warnings found', 'health.error': 'Problems found', 'health.unknown': 'Not checked',
  'phase.ready': 'Ready to check', 'phase.checkpointing': 'Creating a checkpoint', 'phase.scanning': 'Scanning',
  'phase.repairing': 'Applying safe repairs', 'phase.verifying': 'Verifying', 'phase.recovered': 'Recovered',
  'phase.restart-required': 'Recovered; restart required', 'phase.needs-attention': 'Needs your attention', 'phase.failed': 'Recovery failed',
  'summary.ready': 'Doctor runs outside the Agent loop and can recover the active profile.',
  'summary.unavailable': 'The Host recovery service is unreachable. Use the external rescue command.', 'summary.issues': 'Issue summary',
  'confirmation.title': 'These changes need confirmation', 'confirmation.apply': 'Confirm and apply',
  'probe.title': 'Verify the real model connection?', 'probe.description': 'This sends a tiny non-session request and may incur a very small API charge.',
  'probe.run': 'Run live probe', 'probe.skip': 'Skip', 'probe.passed': 'Live probe passed', 'probe.failed': 'Live probe failed', 'probe.unavailable': 'Live probe skipped or unavailable',
  'settings.description': 'Diagnostics, recovery history, and protected rollback checkpoints.',
  'issues.title': 'Current findings', 'issues.empty': 'No issues found.',
  'checkpoints.title': 'Recovery checkpoints', 'checkpoints.empty': 'No checkpoints yet.',
}

const zh: Record<string, string> = {
  doctor: 'Doctor', open: '打开 DSH Doctor', close: '关闭', dismiss: '暂时关闭', title: 'DSH Doctor', nav: 'Doctor',
  recover: '一键恢复对话', scan: '重新检查', rollback: '回滚', copyRescue: '复制外部救援命令',
  errors: '个错误', warnings: '个警告', info: '条信息', banner: '检测到对话异常',
  'health.healthy': '状态正常', 'health.warning': '发现警告', 'health.error': '发现故障', 'health.unknown': '尚未检查',
  'phase.ready': '准备检查', 'phase.checkpointing': '正在创建备份', 'phase.scanning': '正在扫描',
  'phase.repairing': '正在执行安全修复', 'phase.verifying': '正在验证', 'phase.recovered': '已经恢复',
  'phase.restart-required': '已经修复，需要重启', 'phase.needs-attention': '需要你的处理', 'phase.failed': '恢复失败',
  'summary.ready': 'Doctor 独立于 Agent 对话循环，可直接救援当前 profile。',
  'summary.unavailable': '无法连接 Host 救援服务，请使用外部救援命令。', 'summary.issues': '问题汇总',
  'confirmation.title': '以下修改需要确认', 'confirmation.apply': '确认并执行',
  'probe.title': '是否验证真实模型连接？', 'probe.description': '这会发送一次极小的非会话请求，可能产生少量 API 费用。',
  'probe.run': '进行真实验证', 'probe.skip': '暂不验证', 'probe.passed': '真实验证通过', 'probe.failed': '真实验证失败', 'probe.unavailable': '已跳过或无法进行真实验证',
  'settings.description': '查看诊断结果、修复记录和受保护的回滚检查点。',
  'issues.title': '当前发现', 'issues.empty': '没有发现问题。',
  'checkpoints.title': '恢复检查点', 'checkpoints.empty': '还没有检查点。',
}

export const inject = ['slots', 'locale', 'connection']
const NS = 'dshDoctor'

export function apply(ctx: ClientContext): void {
  const connection = ctx.get('connection') as Connection
  const controller = new DoctorController(connection)
  ctx.effect(() => installDoctorStyles(), 'dsh-doctor: styles')
  ctx.effect(() => ctx.locale.register(NS, { en, zh }), 'dsh-doctor: dictionaries')
  const t = ctx.locale.bind(NS)
  const injected = () => ({ controller, t })

  ctx.slots.inject('sidebar.footer.action', () => ctx.slots.register({
    name: 'sidebar.footer.action', id: 'dsh-doctor', order: 90, locale: NS, inject: injected,
  }, DoctorSidebarButton))
  ctx.slots.inject('shell.overlay', () => ctx.slots.register({
    name: 'shell.overlay', id: 'dsh-doctor', order: 90, locale: NS, inject: injected,
  }, DoctorOverlay))
  ctx.slots.inject('settings.section', () => ctx.slots.register({
    name: 'settings.section', id: 'doctor', order: 90, label: () => t('nav'), locale: NS, inject: injected,
  }, DoctorSettingsSection))
  ctx.slots.inject('conversation.input.dock', () => ctx.slots.register({
    name: 'conversation.input.dock', id: 'dsh-doctor', order: 30, locale: NS, inject: injected,
  }, FailureBanner))

  void controller.initialize()
}

export default { inject, apply }
