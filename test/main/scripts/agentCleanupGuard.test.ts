import path from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  findDeepChatRootOwnershipViolations,
  findMissingDeepChatOwnershipSymbols,
  isDeepChatRuntimeCoordinatorImport
} from '../../../scripts/agent-cleanup-guard.mjs'

const repositoryRoot = process.cwd()
const coordinatorFile = path.join(
  repositoryRoot,
  'src/main/agent/deepchat/runtime/deepChatRuntimeCoordinator.ts'
)

describe('agent cleanup guard', () => {
  it('rejects concrete root imports from every DeepChat owner directory', () => {
    const ownerFiles = [
      'src/main/agent/deepchat/instance/deepChatAgentRuntime.ts',
      'src/main/agent/deepchat/loop/contextCoordinator.ts',
      'src/main/agent/deepchat/memory/memoryRuntimeCoordinator.ts',
      'src/main/agent/deepchat/runtime/runLifecycleCoordinator.ts'
    ]

    for (const ownerFile of ownerFiles) {
      expect(
        isDeepChatRuntimeCoordinatorImport(
          path.join(repositoryRoot, ownerFile),
          '@/agent/deepchat/runtime/deepChatRuntimeCoordinator'
        )
      ).toBe(true)
    }
  })

  it('recognizes relative imports with source or emitted extensions', () => {
    const ownerFile = path.join(
      repositoryRoot,
      'src/main/agent/deepchat/memory/memoryRuntimeCoordinator.ts'
    )

    expect(
      isDeepChatRuntimeCoordinatorImport(
        ownerFile,
        '../runtime/deepChatRuntimeCoordinator.ts'
      )
    ).toBe(true)
    expect(
      isDeepChatRuntimeCoordinatorImport(
        ownerFile,
        '../runtime/deepChatRuntimeCoordinator.js'
      )
    ).toBe(true)
  })

  it('allows the root itself and adapters outside the DeepChat implementation', () => {
    expect(
      isDeepChatRuntimeCoordinatorImport(coordinatorFile, './deepChatRuntimeCoordinator')
    ).toBe(false)
    expect(
      isDeepChatRuntimeCoordinatorImport(
        path.join(repositoryRoot, 'src/main/agent/manager/deepChatAgentBackend.ts'),
        '@/agent/deepchat/runtime/deepChatRuntimeCoordinator'
      )
    ).toBe(false)
  })

  it('detects protected ownership calls through syntax rather than source text', () => {
    expect(
      findDeepChatRootOwnershipViolations(`
        class Coordinator {
          run() {
            this.pendingInputs.claimQueuedInput('session', 'item')
          }
        }
      `)
    ).toContainEqual({
      kind: 'pending-input-claim-lifecycle',
      detail: 'claimQueuedInput()'
    })
  })

  it('ignores protected symbol names that appear only in comments or strings', () => {
    expect(
      findDeepChatRootOwnershipViolations(`
        // this.pendingInputs.claimQueuedInput('session', 'item')
        const diagnostic = 'tryAcquirePendingQueueDrain()'
      `)
    ).toEqual([])
  })

  it('keeps every configured ownership symbol anchored to a real owner declaration', async () => {
    await expect(findMissingDeepChatOwnershipSymbols()).resolves.toEqual([])
  })
})
