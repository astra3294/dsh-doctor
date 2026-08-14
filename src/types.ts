export type DoctorSeverity = 'error' | 'warning' | 'info'

export type DoctorRunPhase =
  | 'ready'
  | 'checkpointing'
  | 'scanning'
  | 'repairing'
  | 'verifying'
  | 'recovered'
  | 'restart-required'
  | 'needs-attention'
  | 'failed'

export interface DoctorIssue {
  readonly code: string
  readonly severity: DoctorSeverity
  readonly title: string
  readonly message: string
  readonly profile?: string
  readonly evidence?: string
  readonly file?: string
  readonly recoverability: 'automatic' | 'confirmation' | 'manual' | 'none'
}

export interface DoctorSummary {
  readonly errors: number
  readonly warnings: number
  readonly info: number
}

export interface ProfileReport {
  readonly name: string
  readonly path: string
  readonly exists: boolean
  readonly dshVersion?: string
  readonly dependencies: readonly string[]
  readonly bundles: readonly string[]
}

export interface DoctorEnvironment {
  readonly doctorVersion: string
  readonly supportedDsh: string
  readonly dshHome: string
  readonly node: string
  readonly platform: NodeJS.Platform
  readonly online: boolean
  readonly generatedAt: string
}

export interface DoctorScanReport {
  readonly id: string
  readonly environment: DoctorEnvironment
  readonly profiles: readonly ProfileReport[]
  readonly issues: readonly DoctorIssue[]
  readonly summary: DoctorSummary
}

export type RepairRisk = 'safe' | 'confirmation' | 'manual'

export type RepairActionKind =
  | 'ensure-doctor-state'
  | 'restore-checkpoint-file'
  | 'reset-to-healthy'
  | 'synthesize-manifest'
  | 'install-profile-dependencies'
  | 'disable-plugin'
  | 'undisable-plugin'
  | 'quarantine-session-file'
  | 'switch-model'
  | 'manual'

export interface RepairAction {
  readonly id: string
  readonly issueCode: string
  readonly kind: RepairActionKind
  readonly title: string
  readonly description: string
  readonly profile?: string
  readonly file?: string
  readonly target?: string
  readonly sourceCheckpointId?: string
  readonly risk: RepairRisk
  readonly reversible: boolean
  readonly needsRestart: boolean
}

export interface RepairPlan {
  readonly id: string
  readonly scanId: string
  readonly createdAt: string
  readonly expiresAt: string
  readonly actions: readonly RepairAction[]
  readonly fingerprint: string
}

export interface CheckpointFile {
  readonly relativePath: string
  readonly sourcePath: string
  readonly present: boolean
  readonly sha256?: string
}

export interface DoctorCheckpoint {
  readonly id: string
  readonly profile: string
  readonly kind: 'healthy' | 'pre-repair' | 'manual'
  readonly createdAt: string
  readonly valid: boolean
  readonly files: readonly CheckpointFile[]
}

export interface RepairActionResult {
  readonly actionId: string
  readonly ok: boolean
  readonly message: string
}

export interface DoctorVerification {
  readonly structural: 'passed' | 'failed'
  readonly liveProbe: 'not-requested' | 'passed' | 'failed' | 'unavailable'
  readonly message: string
  readonly summary?: DoctorSummary
  readonly blocking?: number
}

export interface DoctorRun {
  readonly id: string
  readonly phase: DoctorRunPhase
  readonly startedAt: string
  readonly finishedAt?: string
  readonly profile: string
  readonly checkpointId?: string
  readonly results: readonly RepairActionResult[]
  readonly verification?: DoctorVerification
  readonly error?: string
}

export interface RuntimePluginEntry {
  readonly entryId: string
  readonly moduleName: string
  readonly enabled: boolean
  readonly phase: 'pending' | 'loading' | 'active' | 'failed' | 'unloading' | null
}

export interface RuntimeModelStatus {
  readonly provider?: string
  readonly model?: string
  readonly providerAvailable?: boolean
  readonly modelAvailable?: boolean
  readonly credentialFailure?: 'missing' | 'invalid'
}

export interface ScanOptions {
  readonly dshHome?: string
  readonly profile?: string
  readonly allProfiles?: boolean
  readonly online?: boolean
  readonly includePaths?: boolean
  readonly runtimeEntries?: readonly RuntimePluginEntry[]
  readonly runtimeModel?: RuntimeModelStatus
}

export interface ApplyPlanOptions {
  readonly actionIds?: readonly string[]
  readonly confirmed?: boolean
  readonly online?: boolean
}
