import {
  DEEPCHAT_TASK_CONTRACT_REF_SCHEMA_VERSION,
  type DeepChatTaskContract,
  type DeepChatTaskContractRef
} from '@shared/types/task-contract'
import { isDeepChatTaskContract, serializeTaskContractRef } from '../domain/taskContract'
import { canonicalJsonStringifyData } from '../domain/canonicalJson'
import { computeTapeIdentity } from '../domain/tapeIdentity'
import type { DeepChatTapeEntryRow, TapeEventAppendInput } from '../domain/entry'
import type { ContractPersistenceStore } from '../ports/storage'

const TASK_CONTRACT_FACT_SCHEMA_VERSION = 1 as const
const TASK_CONTRACT_FACT_NAME = 'contract/task_frozen' as const
const TASK_CONTRACT_FACT_PROTOCOL_VERSION = 1 as const

type ParentTaskContractFactData = {
  schemaVersion: typeof TASK_CONTRACT_FACT_SCHEMA_VERSION
  delivery: 'parent_frozen'
  contract: DeepChatTaskContract
  originRef: null
  supersedesRef: null
}

type StrictTaskContractEventInput = Omit<TapeEventAppendInput, 'name'> & {
  name: typeof TASK_CONTRACT_FACT_NAME
  source: NonNullable<TapeEventAppendInput['source']>
  provenanceKey: string
  data: ParentTaskContractFactData
}

export interface FreezeParentTaskContractInput {
  parentSessionId: string
  contract: DeepChatTaskContract
  createdAt?: number
}

export interface TaskContractCommitReceipt {
  contract: DeepChatTaskContract
  ref: DeepChatTaskContractRef
  created: boolean
}

export interface ParentTaskContractWriter {
  freezeParentTaskContract(input: FreezeParentTaskContractInput): TaskContractCommitReceipt
}

export class TaskContractPersistenceError extends Error {
  constructor(
    message: string,
    readonly code:
      | 'invalid_contract'
      | 'transaction_required'
      | 'corruption'
      | 'persistence_failed',
    options?: ErrorOptions
  ) {
    super(message, options)
    this.name = 'TaskContractPersistenceError'
  }
}

function canonicalJsonEquals(raw: string, expected: unknown): boolean {
  try {
    return canonicalJsonStringifyData(JSON.parse(raw)) === canonicalJsonStringifyData(expected)
  } catch {
    return false
  }
}

function rowMatchesTaskContractFact(
  row: DeepChatTapeEntryRow,
  input: StrictTaskContractEventInput
): boolean {
  return (
    row.session_id === input.sessionId &&
    row.kind === 'event' &&
    row.name === input.name &&
    row.source_type === input.source.type &&
    row.source_id === input.source.id &&
    row.source_seq === (input.source.seq ?? null) &&
    row.provenance_key === input.provenanceKey &&
    canonicalJsonEquals(row.payload_json, { name: input.name, data: input.data }) &&
    canonicalJsonEquals(row.meta_json, input.meta ?? {})
  )
}

function buildTaskContractRef(
  row: DeepChatTapeEntryRow,
  tapeIdentity: string,
  contractHash: string
): DeepChatTaskContractRef {
  const ref: DeepChatTaskContractRef = {
    schemaVersion: DEEPCHAT_TASK_CONTRACT_REF_SCHEMA_VERSION,
    sessionId: row.session_id,
    tapeIdentity,
    entryId: row.entry_id,
    contractHash
  }
  serializeTaskContractRef(ref)
  return Object.freeze(ref)
}

export class TaskContractService implements ParentTaskContractWriter {
  constructor(private readonly getStore: () => ContractPersistenceStore) {}

  freezeParentTaskContract(input: FreezeParentTaskContractInput): TaskContractCommitReceipt {
    if (!isDeepChatTaskContract(input.contract)) {
      throw new TaskContractPersistenceError(
        'Cannot freeze a malformed or non-canonical TaskContract.',
        'invalid_contract'
      )
    }
    const description = input.contract.taskDescription
    if (input.parentSessionId !== description.parentSessionId) {
      throw new TaskContractPersistenceError(
        'TaskContract parent Session does not match its persistence target.',
        'invalid_contract'
      )
    }
    if (
      input.createdAt !== undefined &&
      (!Number.isSafeInteger(input.createdAt) || input.createdAt < 0)
    ) {
      throw new TaskContractPersistenceError(
        'TaskContract timestamp is invalid.',
        'invalid_contract'
      )
    }

    const store = this.getStore()
    if (!store.isInTransaction()) {
      throw new TaskContractPersistenceError(
        'Parent TaskContract freeze requires the live-delegation host transaction.',
        'transaction_required'
      )
    }

    try {
      store.ensureBootstrapAnchor(input.parentSessionId)
      const firstEntry = store.getFirstEntriesBySessions([input.parentSessionId])[0]
      if (!firstEntry || firstEntry.session_id !== input.parentSessionId) {
        throw new TaskContractPersistenceError(
          `Parent Tape ${input.parentSessionId} has no stable identity.`,
          'persistence_failed'
        )
      }
      const tapeIdentity = computeTapeIdentity(firstEntry)
      const provenanceKey = `contract:task_frozen:v1:parent:${description.turnId}`
      const event: StrictTaskContractEventInput = {
        sessionId: input.parentSessionId,
        name: TASK_CONTRACT_FACT_NAME,
        source: { type: 'subagent', id: description.turnId, seq: description.turnSeq },
        provenanceKey,
        data: {
          schemaVersion: TASK_CONTRACT_FACT_SCHEMA_VERSION,
          delivery: 'parent_frozen',
          contract: input.contract,
          originRef: null,
          supersedesRef: null
        },
        meta: { protocolVersion: TASK_CONTRACT_FACT_PROTOCOL_VERSION },
        createdAt: input.createdAt
      }

      const existing = store.getByProvenanceKey(input.parentSessionId, provenanceKey)
      if (existing) {
        if (!rowMatchesTaskContractFact(existing, event)) {
          throw new TaskContractPersistenceError(
            `Stored TaskContract conflicts with turn ${description.turnId}.`,
            'corruption'
          )
        }
        return {
          contract: input.contract,
          ref: buildTaskContractRef(existing, tapeIdentity, input.contract.contractHash),
          created: false
        }
      }

      const row = store.appendContractEvent({ ...event, idempotent: false })
      if (!rowMatchesTaskContractFact(row, event)) {
        throw new TaskContractPersistenceError(
          `Contract writer returned a conflicting fact for turn ${description.turnId}.`,
          'corruption'
        )
      }
      return {
        contract: input.contract,
        ref: buildTaskContractRef(row, tapeIdentity, input.contract.contractHash),
        created: true
      }
    } catch (error) {
      if (error instanceof TaskContractPersistenceError) throw error
      throw new TaskContractPersistenceError(
        `Failed to freeze TaskContract for turn ${description.turnId}.`,
        'persistence_failed',
        { cause: error }
      )
    }
  }
}
