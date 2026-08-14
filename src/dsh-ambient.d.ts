declare module '@deepseek-ai/dsh-llm/message' {
  export function createUserMessage(input: {
    source: { kind: 'user' }
    content: readonly { type: 'text'; text: string }[]
  }): unknown
}

declare module '@deepseek-ai/dsh-client-runtime/client' {
  export interface ClientContext {
    slots: {
      inject(name: string, callback: () => unknown): unknown
      register(options: Record<string, unknown>, component: unknown): () => void
    }
    locale: {
      register(namespace: string, dictionaries: Record<string, Record<string, string>>): () => void
      bind(namespace: string): (key: string) => string
    }
    get(name: string): unknown
    effect(callback: () => unknown, label?: string): unknown
    on(event: string, listener: () => void): () => void
  }
}

declare module '@deepseek-ai/dsh-client-ui-primitives' {
  import type { ComponentType, SVGProps } from 'react'
  export const IconSettingsOutline16: ComponentType<SVGProps<SVGSVGElement> & { size?: number }>
  export const IconCheckOutline16: ComponentType<SVGProps<SVGSVGElement> & { size?: number }>
  export const IconCloseOutline16: ComponentType<SVGProps<SVGSVGElement> & { size?: number }>
  export const IconRefreshOutline16: ComponentType<SVGProps<SVGSVGElement> & { size?: number }>
}

interface Window {
  __ModuleLoader__: {
    load(input: { id: string; factory: (require: (id: string) => unknown) => unknown }): void
  }
}
