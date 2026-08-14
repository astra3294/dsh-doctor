import { randomUUID } from 'node:crypto'
import { RPC_CHANNEL } from './constants.js'
import { DoctorService } from './service.js'
import type { ApplyPlanOptions, RuntimeModelStatus, RuntimePluginEntry, ScanOptions } from './types.js'

export * from './types.js'
export { DoctorEngine } from './repair.js'
export { DoctorService } from './service.js'
export { scanHarness } from './scanner.js'

export const name = 'dsh-doctor'
export const inject = ['connection']

interface RpcResult<T> {
  ok: boolean
  value?: T
  error?: { code: string; message: string; details: { issues: unknown[] } }
}

interface HostContext {
  connection: {
    rpc: {
      handle(
        channel: string,
        handler: (endpoint: string, payload: unknown, signal: AbortSignal) => Promise<RpcResult<unknown>>,
        options: { authority: 'loopback' | 'trusted-host' },
      ): () => Promise<void>
    }
  }
  get(name: string): unknown
  effect(callback: () => unknown, label?: string): unknown
}

export interface Config {
  dshHome?: string
  activeProfile?: string
}

function payloadRecord(payload: unknown): Record<string, unknown> {
  if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) throw new Error('payload must be an object')
  return payload as Record<string, unknown>
}

function runtimeEntries(ctx: HostContext): RuntimePluginEntry[] {
  const loader = ctx.get('loader') as { entries?: () => Iterable<{
    id: string
    disabled?: boolean
    options?: { name?: string; group?: boolean }
    fiber?: { state?: number }
  }> } | undefined
  if (loader?.entries === undefined) return []
  const phases = ['pending', 'loading', 'active', 'failed', null, 'unloading'] as const
  return [...loader.entries()]
    .filter(entry => entry.options?.group !== true)
    .map(entry => ({
      entryId: entry.id,
      moduleName: entry.options?.name ?? entry.id,
      enabled: entry.disabled !== true,
      phase: entry.fiber?.state === undefined ? null : (phases[entry.fiber.state] ?? null),
    }))
}

async function runtimeModelStatus(ctx: HostContext, signal: AbortSignal, online: boolean): Promise<RuntimeModelStatus> {
  const defaults = ctx.get('agentDefaultModel') as { currentSelection?: () => { provider: string; model: string } } | undefined
  const llm = ctx.get('llm') as {
    listProviders?: () => readonly { id: string }[]
    resolveModelInfo?: (provider: string, model: string, signal?: AbortSignal) => Promise<unknown>
  } | undefined
  const selection = defaults?.currentSelection?.()
  if (selection === undefined) return {}
  const providers = llm?.listProviders?.()
  const providerAvailable = providers?.some(provider => provider.id === selection.provider)
  let modelAvailable: boolean | undefined
  let credentialFailure: 'missing' | 'invalid' | undefined
  if (online && providerAvailable === true && llm?.resolveModelInfo !== undefined) {
    try {
      await llm.resolveModelInfo(selection.provider, selection.model, signal)
      modelAvailable = true
    } catch (error) {
      modelAvailable = false
      const code = (error as { code?: unknown } | null)?.code
      const status = (error as { status?: unknown } | null)?.status
      if (code === 'INVALID_CREDENTIAL' || status === 401) credentialFailure = 'invalid'
      else if (code === 'MISSING_CREDENTIAL') credentialFailure = 'missing'
    }
  }
  return { ...selection, providerAvailable, modelAvailable, ...(credentialFailure === undefined ? {} : { credentialFailure }) }
}

async function liveProbe(ctx: HostContext, signal: AbortSignal): Promise<{
  status: 'passed' | 'failed' | 'unavailable'
  message: string
}> {
  const llm = ctx.get('llm') as { stream?: (options: Record<string, unknown>) => AsyncIterable<{
    type?: string
    reason?: { kind?: string; failure?: { code?: string; status?: number } }
  }> } | undefined
  const defaults = ctx.get('agentDefaultModel') as { currentSelection?: () => { provider: string; model: string; reasoningEffort?: string } } | undefined
  if (llm?.stream === undefined || defaults?.currentSelection === undefined) {
    return { status: 'unavailable', message: 'The LLM runtime or default model service is unavailable.' }
  }
  try {
    // Deliberately no `@deepseek-ai/*` import here: the Host plugin must keep
    // working when the profile links it from a local dev directory (the
    // module-resolution fallback never covers linked real paths). The message
    // mirrors dsh-llm's createUserMessage shape (role + source + content + id).
    const selection = defaults.currentSelection()
    const message = {
      role: 'user',
      source: { kind: 'user' },
      content: [{ type: 'text', text: 'Reply with OK.' }],
      id: randomUUID(),
    }
    let terminal: { type?: string; reason?: { kind?: string; failure?: { code?: string; status?: number } } } | undefined
    const chunks: unknown[] = []
    for await (const chunk of llm.stream({
      ...selection,
      messages: [message],
      maxTokens: 4,
      temperature: 0,
      signal,
    })) {
      chunks.push(chunk)
      if (chunk.type === 'finish') terminal = chunk
    }
    const finish = terminal?.reason
    if (finish?.kind === 'error' || finish?.kind === 'aborted') {
      const credential = finish.failure?.code === 'INVALID_CREDENTIAL'
        || finish.failure?.code === 'MISSING_CREDENTIAL'
        || finish.failure?.status === 401
      return {
        status: 'failed',
        message: credential
          ? 'The model credential was rejected. Open Model settings and enter it again; Doctor did not read or change the key.'
          : 'The configured model returned a terminal failure.',
      }
    }
    const sawContent = chunks.some(chunk => (chunk as { type?: string }).type !== 'finish')
    const acknowledged = /\bOK\b/i.test(JSON.stringify(chunks).slice(0, 4000))
    if (!sawContent) return { status: 'failed', message: 'The model stream finished without emitting any content.' }
    if (!acknowledged) return { status: 'failed', message: 'The model answered, but the response did not include the expected acknowledgment; the route may be misconfigured.' }
    return { status: 'passed', message: 'The configured model completed a minimal non-session request and acknowledged it.' }
  } catch (error) {
    return { status: 'failed', message: `Live model probe failed: ${String(error)}` }
  }
}

export function apply(ctx: HostContext, config: Config = {}): void {
  const service = new DoctorService(config)
  ctx.effect(() => ctx.connection.rpc.handle(RPC_CHANNEL, async (endpoint, rawPayload, signal) => {
    try {
      const payload = payloadRecord(rawPayload)
      let value: unknown
      switch (endpoint) {
        case 'status': value = service.status(); break
        case 'scan': value = await service.scan(
          runtimeEntries(ctx), payload as ScanOptions, await runtimeModelStatus(ctx, signal, payload.online === true),
        ); break
        case 'plan': {
          const report = payload.report
          if (report === undefined) throw new Error('report is required')
          value = await service.engine.plan(report as Parameters<DoctorService['engine']['plan']>[0], {
            dshHome: service.dshHome,
            profile: typeof payload.profile === 'string' ? payload.profile : service.activeProfile,
          })
          break
        }
        case 'apply': {
          if (typeof payload.planId !== 'string') throw new Error('planId is required')
          value = await service.engine.apply(payload.planId, payload.options as ApplyPlanOptions | undefined)
          break
        }
        case 'verify': value = await service.engine.verify({ dshHome: service.dshHome, profile: service.activeProfile }); break
        case 'rollback': {
          if (typeof payload.checkpointId !== 'string') throw new Error('checkpointId is required')
          value = await service.engine.rollback(payload.checkpointId, { dshHome: service.dshHome })
          break
        }
        case 'history': value = await service.engine.history({ dshHome: service.dshHome, profile: service.activeProfile }); break
        case 'mark-healthy': value = await service.engine.markHealthy(service.activeProfile, { dshHome: service.dshHome }); break
        case 'live-probe': value = await liveProbe(ctx, signal); break
        default: throw new Error(`unknown Doctor endpoint: ${endpoint}`)
      }
      return { ok: true, value }
    } catch (error) {
      return { ok: false, error: { code: 'doctor-error', message: String(error), details: { issues: [] } } }
    }
  }, { authority: 'loopback' }), 'dsh-doctor: loopback recovery RPC')
}

export default { name, inject, apply }
