import { describe, expect, it } from 'vitest'
import type { ChatMessage } from '@shared/types/core/chat-message'
import type { MCPToolDefinition } from '@shared/types/core/mcp'
import { TOOL_EXECUTION } from '@shared/types/core/mcp'
import type { DeepChatToolProfileKind } from '@/agent/deepchat/instance/deepChatAgentInstance'
import type { RunToolDefinitionUniverse } from '@/agent/deepchat/runtime/toolResolver'
import { buildCanonicalToolCatalog } from '@/agent/deepchat/runtime/toolSurface'
import {
  TOOL_SURFACE_P0A_SHADOW_POLICY,
  ToolSurfaceShadowDiagnosticsCollector
} from '@/agent/deepchat/runtime/toolSurfaceDiagnostics'

function agentTool(name: string, options: { description?: string } = {}): MCPToolDefinition {
  return {
    type: 'function',
    function: {
      name,
      description: options.description ?? name,
      parameters: { type: 'object', properties: {} }
    },
    server: {
      name: 'agent-core',
      icons: '',
      description: 'Agent core tools'
    },
    source: 'agent',
    execution: TOOL_EXECUTION.read.parallel
  }
}

function universe(
  definitions: MCPToolDefinition[],
  overrides: Partial<RunToolDefinitionUniverse> = {}
): RunToolDefinitionUniverse {
  return {
    status: 'resolved',
    complete: true,
    mandatoryAdmissionBlocked: false,
    definitions,
    activeSkillNames: [],
    skillRequirements: [],
    degradationCounts: [],
    ...overrides
  }
}

function collector(
  options: {
    sampleCapacity?: number
    policy?: typeof TOOL_SURFACE_P0A_SHADOW_POLICY
    toolProfile?: DeepChatToolProfileKind
  } = {}
): ToolSurfaceShadowDiagnosticsCollector {
  return new ToolSurfaceShadowDiagnosticsCollector({
    scope: {
      sessionId: 'session-1',
      providerId: 'provider-1',
      modelId: 'model-1',
      toolProfile: options.toolProfile ?? 'code'
    },
    ...(options.sampleCapacity === undefined ? {} : { sampleCapacity: options.sampleCapacity }),
    ...(options.policy === undefined ? {} : { policy: options.policy })
  })
}

function assistantToolMessage(name: string): ChatMessage {
  return {
    role: 'assistant',
    tool_calls: [
      {
        id: 'opaque-id',
        type: 'function',
        function: { name, arguments: '{"path":"private"}' }
      }
    ]
  }
}

describe('Tool Surface shadow diagnostics selection', () => {
  it('keeps small eligible catalogs fully active', () => {
    const diagnostics = collector()
    const definitions = [
      agentTool('read'),
      agentTool('update_plan'),
      agentTool('tape_search'),
      agentTool('skill_tool'),
      agentTool('recent_tool')
    ]
    diagnostics.startRun({
      universe: universe(definitions),
      eligibleDefinitions: definitions,
      initialViewRequestSeq: 1
    })

    expect(diagnostics.snapshot()).toMatchObject({
      runs: {
        observed: 1,
        measured: 1,
        virtualizationTriggered: 0,
        triggerCounts: { none: 1 }
      },
      surface: {
        eligibleToolCount: { samples: 1, p50: definitions.length },
        hypotheticalActiveToolCount: { samples: 1, p50: definitions.length }
      }
    })
  })

  it('combines policy, profile, active Skill, and recent selection inputs', () => {
    const diagnostics = collector({
      policy: {
        ...TOOL_SURFACE_P0A_SHADOW_POLICY,
        policyVersion: 'selection-test-v1',
        enterToolCount: 1,
        exitToolCount: 0
      }
    })
    const definitions = [
      agentTool('read'),
      agentTool('tape_search'),
      agentTool('skill_tool'),
      agentTool('recent_tool'),
      agentTool('hidden_until_search')
    ]
    const skillTarget = buildCanonicalToolCatalog(definitions).entries.find(
      (entry) => entry.target.providerVisibleName === 'skill_tool'
    )!.stableTargetKey
    diagnostics.startRun({
      universe: universe(definitions, {
        activeSkillNames: ['active-skill'],
        skillRequirements: [
          {
            skillName: 'active-skill',
            activeAtRunStart: true,
            activatable: true,
            requiredStableTargetKeys: [skillTarget],
            issueCodes: []
          }
        ]
      }),
      eligibleDefinitions: definitions,
      initialViewRequestSeq: 1,
      messages: [assistantToolMessage('recent_tool')]
    })

    expect(diagnostics.snapshot()).toMatchObject({
      policyVersion: 'selection-test-v1',
      runs: { virtualizationTriggered: 1 },
      surface: {
        eligibleToolCount: { p50: 5 },
        hypotheticalActiveToolCount: { p50: 5 }
      }
    })
  })

  it('virtualizes large catalogs and includes one hypothetical ToolSearch definition', () => {
    const diagnostics = collector()
    const definitions = Array.from(
      { length: TOOL_SURFACE_P0A_SHADOW_POLICY.enterToolCount + 1 },
      (_, index) => agentTool(index === 0 ? 'read' : `tool_${index}`)
    )
    diagnostics.startRun({
      universe: universe(definitions),
      eligibleDefinitions: definitions,
      initialViewRequestSeq: 1
    })

    const snapshot = diagnostics.snapshot()
    expect(snapshot.runs).toMatchObject({
      virtualizationTriggered: 1,
      triggerCounts: { 'tool-count': 1 }
    })
    expect(snapshot.surface.hypotheticalActiveToolCount.max).toBeLessThan(definitions.length)
  })

  it('excludes ACP, reports incomplete universes, and fails collection open', () => {
    const diagnostics = collector()
    diagnostics.startRun({
      universe: universe([], { status: 'degraded', complete: false }),
      eligibleDefinitions: [],
      initialViewRequestSeq: 1
    })
    diagnostics.startRun({
      universe: universe([], {
        status: 'acp-excluded',
        complete: false,
        mandatoryAdmissionBlocked: true
      }),
      eligibleDefinitions: [],
      initialViewRequestSeq: 2
    })
    diagnostics.startRun({
      universe: universe([
        agentTool('duplicate'),
        agentTool('duplicate', { description: 'conflicting duplicate' })
      ]),
      eligibleDefinitions: [],
      initialViewRequestSeq: 3
    })

    expect(diagnostics.snapshot().runs).toMatchObject({
      observed: 3,
      measured: 0,
      degraded: 1,
      acpExcluded: 1,
      mandatoryAdmissionBlocked: 0,
      collectorFailures: 1,
      surfaceRelationCounts: { first: 0, unchanged: 0, changed: 0, unavailable: 3 }
    })
  })
})

describe('Tool Surface shadow diagnostics attempt correlation', () => {
  it('binds recorders to an initial View while allowing interleaved Runs', () => {
    const diagnostics = collector({ sampleCapacity: 8 })
    const firstDefinitions = [agentTool('read')]
    const first = diagnostics.startRun({
      universe: universe(firstDefinitions),
      eligibleDefinitions: firstDefinitions,
      initialViewRequestSeq: 7
    })
    const unchanged = diagnostics.startRun({
      universe: universe(firstDefinitions),
      eligibleDefinitions: firstDefinitions,
      initialViewRequestSeq: 8
    })
    const changedDefinitions = [agentTool('read'), agentTool('write')]
    const changed = diagnostics.startRun({
      universe: universe(changedDefinitions),
      eligibleDefinitions: changedDefinitions,
      initialViewRequestSeq: 9
    })

    unchanged.recordProviderAttempt({
      requestSeq: 8,
      physicalAttempt: 1,
      usage: { inputTokens: 100, cacheReadTokens: 80, cacheWriteTokens: 10 }
    })
    unchanged.recordProviderAttempt({
      requestSeq: 8,
      physicalAttempt: 2,
      usage: { inputTokens: 90, cacheReadTokens: 70 }
    })
    unchanged.recordProviderAttempt({
      requestSeq: 8,
      physicalAttempt: 2,
      usage: { inputTokens: 999, cacheReadTokens: 999 }
    })
    unchanged.recordProviderAttempt({
      requestSeq: 10,
      physicalAttempt: 1,
      usage: { inputTokens: 999, cacheReadTokens: 999 }
    })
    changed.recordProviderAttempt({
      requestSeq: 9,
      physicalAttempt: 1,
      usage: { inputTokens: 120, cacheReadTokens: 0 }
    })
    first.recordProviderAttempt({
      requestSeq: 7,
      physicalAttempt: 1,
      usage: { inputTokens: 80, cacheReadTokens: 10 }
    })

    expect(diagnostics.snapshot()).toMatchObject({
      runs: {
        surfaceRelationCounts: { first: 1, unchanged: 1, changed: 1, unavailable: 0 }
      },
      surface: {
        staticOverlapJaccardRatio: { samples: 2, p50: 0.5, p95: 1, max: 1 }
      },
      initialViewAttempts: {
        observed: 4,
        withUsage: 4,
        withCacheReadMetric: 4,
        withCacheWriteMetric: 1,
        bySurfaceRelation: {
          first: { observed: 1, cacheReadTokens: { p50: 10 } },
          unchanged: {
            observed: 2,
            cacheReadTokens: { samples: 2, p50: 70, p95: 80 },
            surfaceOverlapJaccardRatio: { samples: 2, p50: 1, p95: 1 }
          },
          changed: {
            observed: 1,
            cacheReadTokens: { samples: 1, p50: 0 },
            surfaceOverlapJaccardRatio: { samples: 1, p50: 0.5 }
          }
        }
      }
    })
  })

  it('stops finished and cleared recorders from accepting late attempts', () => {
    const diagnostics = collector()
    const definitions = [agentTool('read')]
    const finished = diagnostics.startRun({
      universe: universe(definitions),
      eligibleDefinitions: definitions,
      initialViewRequestSeq: 1
    })
    finished.finish()
    finished.recordProviderAttempt({
      requestSeq: 1,
      physicalAttempt: 1,
      usage: { inputTokens: 100 }
    })
    const cleared = diagnostics.startRun({
      universe: universe(definitions),
      eligibleDefinitions: definitions,
      initialViewRequestSeq: 2
    })
    diagnostics.clear()
    cleared.recordProviderAttempt({
      requestSeq: 2,
      physicalAttempt: 1,
      usage: { inputTokens: 100 }
    })

    expect(diagnostics.snapshot()).toMatchObject({
      runs: { observed: 0 },
      initialViewAttempts: { observed: 0, withUsage: 0 }
    })
  })

  it('distinguishes unavailable metrics from zero cache tokens', () => {
    const diagnostics = collector()
    const definitions = [agentTool('read')]
    const recorder = diagnostics.startRun({
      universe: universe(definitions),
      eligibleDefinitions: definitions,
      initialViewRequestSeq: 1
    })
    recorder.recordProviderAttempt({
      requestSeq: 1,
      physicalAttempt: 1,
      usage: { inputTokens: 100 }
    })
    recorder.recordProviderAttempt({
      requestSeq: 1,
      physicalAttempt: 2,
      usage: { inputTokens: 100, cacheReadTokens: 0, cacheWriteTokens: 0 }
    })

    expect(diagnostics.snapshot().initialViewAttempts).toMatchObject({
      observed: 2,
      withUsage: 2,
      withCacheReadMetric: 1,
      withCacheWriteMetric: 1,
      cacheReadTokens: { samples: 1, p50: 0 },
      cacheWriteTokens: { samples: 1, p50: 0 }
    })
  })
})

describe('Tool Surface shadow diagnostics bounds', () => {
  it('keeps only the configured number of numeric samples', () => {
    const diagnostics = collector({ sampleCapacity: 2, toolProfile: 'general' })
    for (const [index, toolCount] of [1, 2, 3].entries()) {
      const definitions = Array.from({ length: toolCount }, (_, toolIndex) =>
        agentTool(`tool_${toolIndex}`)
      )
      diagnostics.startRun({
        universe: universe(definitions),
        eligibleDefinitions: definitions,
        initialViewRequestSeq: index + 1
      })
    }

    expect(diagnostics.snapshot().surface.ceilingToolCount).toEqual({
      samples: 2,
      p50: 2,
      p95: 3,
      max: 3
    })
  })

  it('freezes its policy copy and preserves signed estimates', () => {
    const policy = {
      ...TOOL_SURFACE_P0A_SHADOW_POLICY,
      policyVersion: 'negative-estimate-v1',
      enterToolCount: 1,
      exitToolCount: 0,
      enterEstimatedInputTokens: 100_000,
      exitEstimatedInputTokens: 90_000,
      maxInitialDefinitionTokens: 10_000,
      activationReserveDefinitionTokens: 0,
      toolSearchPromptTokens: 1_000
    }
    const diagnostics = collector({ policy })
    policy.policyVersion = 'mutated-version'
    policy.enterToolCount = 1_000
    const definitions = [agentTool('read')]
    diagnostics.startRun({
      universe: universe(definitions),
      eligibleDefinitions: definitions,
      initialViewRequestSeq: 1
    })

    expect(diagnostics.snapshot()).toMatchObject({
      policyVersion: 'negative-estimate-v1',
      runs: { virtualizationTriggered: 1 },
      surface: { estimatedNetInputTokenReduction: { samples: 1 } }
    })
    expect(diagnostics.snapshot().surface.estimatedNetInputTokenReduction.max).toBeLessThan(0)
  })

  it('does not execute message getters or expose content in snapshots', () => {
    const diagnostics = collector({
      policy: {
        ...TOOL_SURFACE_P0A_SHADOW_POLICY,
        policyVersion: 'privacy-test-v1',
        enterToolCount: 1,
        exitToolCount: 0
      }
    })
    let getterInvoked = false
    const hostileFunctionCall = Object.defineProperty({}, 'name', {
      enumerable: true,
      get: () => {
        getterInvoked = true
        return 'secret_tool'
      }
    })
    const messages = [
      { role: 'user', content: 'private user request' },
      {
        role: 'assistant',
        tool_calls: [
          {
            id: 'opaque-id',
            type: 'function',
            function: hostileFunctionCall
          },
          {
            id: 'opaque-id-2',
            type: 'function',
            function: { name: 'x'.repeat(2_000), arguments: 'private arguments' }
          }
        ]
      }
    ] as unknown as ChatMessage[]
    const definitions = [agentTool('read'), agentTool('secret_tool')]
    diagnostics.startRun({
      universe: universe(definitions),
      eligibleDefinitions: definitions,
      initialViewRequestSeq: 1,
      messages
    })

    const serialized = JSON.stringify(diagnostics.snapshot())
    expect(getterInvoked).toBe(false)
    expect(serialized).not.toContain('secret_tool')
    expect(serialized).not.toContain('private')
    expect(serialized).not.toContain('agent-core')
    expect(serialized).not.toContain('session-1')
    expect(serialized).not.toContain('provider-1')
    expect(serialized).not.toContain('model-1')
  })

  it('turns an invalid scope or request identity into a bounded no-op', () => {
    const diagnostics = new ToolSurfaceShadowDiagnosticsCollector({
      scope: {
        sessionId: '',
        providerId: 'provider-1',
        modelId: 'model-1',
        toolProfile: 'code'
      }
    })
    const definitions = [agentTool('read')]
    const recorder = diagnostics.startRun({
      universe: universe(definitions),
      eligibleDefinitions: definitions,
      initialViewRequestSeq: 0
    })
    recorder.recordProviderAttempt({
      requestSeq: 1,
      physicalAttempt: 1,
      usage: { inputTokens: 100 }
    })

    expect(diagnostics.snapshot()).toMatchObject({
      runs: { observed: 1, measured: 0, collectorFailures: 1 },
      initialViewAttempts: { observed: 0 }
    })
  })

  it('contains throwing boundary accessors inside the fail-open collector', () => {
    const diagnostics = collector()
    const invalidRequest = Object.defineProperty({}, 'initialViewRequestSeq', {
      enumerable: true,
      get: () => {
        throw new Error('request getter must stay contained')
      }
    }) as Parameters<ToolSurfaceShadowDiagnosticsCollector['startRun']>[0]
    const invalidUniverse = Object.defineProperty(universe([]), 'status', {
      enumerable: true,
      get: () => {
        throw new Error('universe getter must stay contained')
      }
    })

    expect(() => diagnostics.startRun(invalidRequest)).not.toThrow()
    expect(() =>
      diagnostics.startRun({
        universe: invalidUniverse,
        eligibleDefinitions: [],
        initialViewRequestSeq: 1
      })
    ).not.toThrow()
    expect(diagnostics.snapshot().runs).toMatchObject({
      observed: 2,
      measured: 0,
      collectorFailures: 2,
      surfaceRelationCounts: { unavailable: 2 }
    })
  })
})
