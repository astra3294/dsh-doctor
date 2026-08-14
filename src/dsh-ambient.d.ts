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
  import type { ButtonHTMLAttributes, ComponentType, ReactNode, SVGProps } from 'react'

  export type ButtonVariant = 'primary' | 'ghost' | 'outline' | 'toolbar'
  export const Button: ComponentType<ButtonHTMLAttributes<HTMLButtonElement> & {
    variant?: ButtonVariant
    size?: 'md' | 'sm'
    icon?: ReactNode
  }>

  export type StateDotState = 'done' | 'warning' | 'ongoing' | 'error'
  export const StateDot: ComponentType<{
    state: StateDotState
    size?: number
    className?: string
  }>

  export const Modal: ComponentType<{
    open: boolean
    onClose: () => void
    title: string
    closeLabel?: string
    description?: string
    children?: ReactNode
    footer?: ReactNode
    className?: string
    contentClassName?: string
    headless?: boolean
  }>

  export const IconCloseOutline16: ComponentType<SVGProps<SVGSVGElement> & { size?: number }>
  export const IconCopyOutline16: ComponentType<SVGProps<SVGSVGElement> & { size?: number }>
  export const IconRefreshOutline16: ComponentType<SVGProps<SVGSVGElement> & { size?: number }>
}

interface Window {
  __ModuleLoader__: {
    load(input: { id: string; factory: (require: (id: string) => unknown) => unknown }): void
  }
}
