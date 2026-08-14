import { DoctorEngine } from './repair.js'
import { resolveDshHome } from './paths.js'
import type { RuntimeModelStatus, RuntimePluginEntry, ScanOptions } from './types.js'

export interface DoctorServiceOptions {
  readonly dshHome?: string
  readonly activeProfile?: string
}

export class DoctorService {
  readonly engine: DoctorEngine
  readonly dshHome: string
  readonly activeProfile: string

  constructor(options: DoctorServiceOptions = {}) {
    this.dshHome = resolveDshHome(options.dshHome)
    this.activeProfile = options.activeProfile ?? process.env.DSH_PROFILE ?? 'web'
    this.engine = new DoctorEngine(this.dshHome)
  }

  status() {
    return {
      available: true,
      activeProfile: this.activeProfile,
      rescueCommand: `npx dsh-doctor recover --profile ${this.activeProfile}`,
    }
  }

  scan(runtimeEntries?: readonly RuntimePluginEntry[], options: ScanOptions = {}, runtimeModel?: RuntimeModelStatus) {
    return this.engine.scan({
      ...options,
      dshHome: this.dshHome,
      profile: options.allProfiles ? undefined : (options.profile ?? this.activeProfile),
      runtimeEntries,
      runtimeModel,
    })
  }
}
