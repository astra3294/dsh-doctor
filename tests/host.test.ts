import { describe, expect, it } from 'vitest'
import { apply } from '../src/index.js'

describe('Host RPC adapter', () => {
  it('registers the Doctor channel behind the loopback trust fence', async () => {
    let channel = ''
    let authority = ''
    let handler: ((endpoint: string, payload: unknown, signal: AbortSignal) => Promise<unknown>) | undefined
    const ctx = {
      connection: {
        rpc: {
          handle(nextChannel: string, nextHandler: typeof handler, options: { authority: string }) {
            channel = nextChannel
            handler = nextHandler
            authority = options.authority
            return async () => {}
          },
        },
      },
      get: () => undefined,
      effect(callback: () => unknown) { return callback() },
    }
    apply(ctx as never, { dshHome: 'E:\\temp\\dsh-doctor-host-test', activeProfile: 'web' })
    expect(channel).toBe('/dsh-doctor')
    expect(authority).toBe('loopback')
    const result = await handler?.('status', {}, new AbortController().signal) as { ok: boolean; value?: { rescueCommand: string } }
    expect(result.ok).toBe(true)
    expect(result.value?.rescueCommand).toBe('npx dsh-doctor recover --profile web')
  })
})
