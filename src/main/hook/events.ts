import type { HookEventName } from '@shared/hooksNotifications'

export interface HookSessionFacts {
  readonly sessionId: string
  readonly agentId?: string | null
  readonly projectDir?: string | null
  readonly providerId?: string
  readonly modelId?: string
  readonly messageId?: string
}

export interface HookToolFacts {
  readonly callId?: string
  readonly name?: string
  readonly params?: string
  readonly response?: string
  readonly error?: string
}

export interface HookStopFacts {
  readonly reason?: string
  readonly userStop?: boolean
}

export interface HookErrorFacts {
  readonly message?: string
  readonly stack?: string
}

export type HookUsageFacts = Readonly<Record<string, number>>

export type HookPermissionFacts = Readonly<Record<string, unknown>>

export type HookEventBody =
  | { readonly event: 'SessionStart'; readonly promptPreview?: string }
  | { readonly event: 'UserPromptSubmit'; readonly promptPreview: string }
  | { readonly event: 'PreToolUse'; readonly tool: HookToolFacts }
  | { readonly event: 'PostToolUse'; readonly tool: HookToolFacts }
  | { readonly event: 'PostToolUseFailure'; readonly tool: HookToolFacts }
  | {
      readonly event: 'PermissionRequest'
      readonly tool: HookToolFacts
      readonly permission: HookPermissionFacts
    }
  | { readonly event: 'Stop'; readonly stop: HookStopFacts }
  | {
      readonly event: 'SessionEnd'
      readonly usage?: HookUsageFacts | null
      readonly error?: HookErrorFacts | null
    }

export type HookEvent = HookEventBody & { readonly session: HookSessionFacts }

type AssertNever<T extends never> = T
type AssertTrue<T extends true> = T
type Rejects<TCandidate> = TCandidate extends HookEventBody ? false : true

/** Fails compilation when HookEventBody and HOOK_EVENT_NAMES drift apart in either direction. */
export type HookEventCoverage = [
  AssertNever<Exclude<HookEventName, HookEventBody['event']>>,
  AssertNever<Exclude<HookEventBody['event'], HookEventName>>
]

/**
 * Pins the combinations the union must refuse. Surplus fields on an event literal are refused by
 * excess property checking at the emit site, which no type-level assertion can express.
 */
export type HookEventBodyRejections = [
  AssertTrue<Rejects<{ event: 'PreToolUse' }>>,
  AssertTrue<Rejects<{ event: 'PermissionRequest'; tool: HookToolFacts }>>,
  AssertTrue<Rejects<{ event: 'Stop'; tool: HookToolFacts }>>,
  AssertTrue<Rejects<{ event: 'UserPromptSubmit' }>>
]
