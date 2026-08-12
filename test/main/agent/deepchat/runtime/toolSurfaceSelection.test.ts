import { describe, expect, it } from 'vitest'
import { computeToolSurfaceVirtualizationTrigger } from '@/agent/deepchat/runtime/toolSurface'
import {
  createAutomaticToolSurfaceSelectionPolicy,
  isAutomaticToolSurfaceRunModeAssignment,
  selectAutomaticToolSurfaceRunMode,
  type ToolSurfaceRunModeAssignment
} from '@/agent/deepchat/runtime/toolSurfaceSelection'

describe('Tool Surface adapter selection', () => {
  const policy = createAutomaticToolSurfaceSelectionPolicy(256)

  it('counts native search overhead and applies cross-Run hysteresis only as a hint', () => {
    expect(
      computeToolSurfaceVirtualizationTrigger({
        policy,
        ceilingToolCount: 39,
        ceilingDefinitionTokens: 1_000
      })
    ).toMatchObject({ virtualizationTriggered: false, triggerReason: 'none' })
    expect(
      computeToolSurfaceVirtualizationTrigger({
        policy,
        ceilingToolCount: 40,
        ceilingDefinitionTokens: 1_000
      })
    ).toMatchObject({ virtualizationTriggered: true, triggerReason: 'tool-count' })
    expect(
      computeToolSurfaceVirtualizationTrigger({
        policy,
        ceilingToolCount: 32,
        ceilingDefinitionTokens: 1_000,
        previouslyVirtualized: true
      })
    ).toMatchObject({ virtualizationTriggered: true, triggerReason: 'hysteresis' })
    expect(
      computeToolSurfaceVirtualizationTrigger({
        policy,
        ceilingToolCount: 31,
        ceilingDefinitionTokens: 1_000,
        previouslyVirtualized: true
      })
    ).toMatchObject({ virtualizationTriggered: false, triggerReason: 'none' })
  })

  it('uses Direct Native for a small catalog regardless of CLI evidence', () => {
    expect(
      selectAutomaticToolSurfaceRunMode({
        virtualizationTriggered: false,
        cliProgrammaticCapability: 'proven',
        agentExecAvailable: true,
        programmaticRunCeilingFits: true
      })
    ).toBe('full')
  })

  it.each([
    {
      cliProgrammaticCapability: 'unproven' as const,
      agentExecAvailable: true,
      programmaticRunCeilingFits: true
    },
    {
      cliProgrammaticCapability: 'proven' as const,
      agentExecAvailable: false,
      programmaticRunCeilingFits: true
    },
    {
      cliProgrammaticCapability: 'proven' as const,
      agentExecAvailable: true,
      programmaticRunCeilingFits: false
    }
  ])(
    'keeps a large catalog on Native Activation when a CLI gate is absent: $cliProgrammaticCapability/$agentExecAvailable/$programmaticRunCeilingFits',
    (input) => {
      expect(
        selectAutomaticToolSurfaceRunMode({ virtualizationTriggered: true, ...input })
      ).toBe('native-activation')
    }
  )

  it('selects CLI Programmatic only when every CLI gate is proven', () => {
    expect(
      selectAutomaticToolSurfaceRunMode({
        virtualizationTriggered: true,
        cliProgrammaticCapability: 'proven',
        agentExecAvailable: true,
        programmaticRunCeilingFits: true
      })
    ).toBe('cli-programmatic')
  })

  it('rejects malformed automatic assignments at the rollout boundary', () => {
    expect(
      isAutomaticToolSurfaceRunModeAssignment({
        mode: 'automatic',
        cliProgrammaticCapability: 'inferred'
      } as unknown as ToolSurfaceRunModeAssignment)
    ).toBe(false)
  })
})
