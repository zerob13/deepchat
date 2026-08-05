import { z } from 'zod'
import { JsonValueSchema, TimestampMsSchema, defineEventContract } from '../common'
import { LocalControlEffectSchema, LocalControlMethodSchema } from '../localControl'
import { ApprovalRequestIdSchema } from '../routes/approvals.routes'

export const approvalRequestedEvent = defineEventContract({
  name: 'approvals.requested',
  payload: z
    .object({
      requestId: ApprovalRequestIdSchema,
      operation: LocalControlMethodSchema,
      effect: LocalControlEffectSchema,
      principal: z.enum(['human', 'agent']),
      expiresAt: TimestampMsSchema,
      displayData: JsonValueSchema.optional()
    })
    .strict()
})

export const approvalClosedEvent = defineEventContract({
  name: 'approvals.closed',
  payload: z
    .object({
      requestId: ApprovalRequestIdSchema,
      reason: z.enum(['approved', 'denied', 'cancelled', 'timeout', 'unavailable'])
    })
    .strict()
})
