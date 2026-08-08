import { describe, expect, it } from 'vitest'
import { ModelType } from '@shared/model'
import { TOOL_EXECUTION, type MCPToolDefinition } from '@shared/types/core/mcp'
import {
  assemblePromptSections,
  createPromptAssemblySection
} from '@/agent/deepchat/resources/promptAssembly'
import {
  ExecutionContractError,
  MAX_EXECUTION_CONTRACT_PROMPT_SECTIONS,
  MAX_EXECUTION_CONTRACT_TOOLS,
  buildEffectiveGenerationConfigHash,
  buildExecutionContract,
  buildProviderVisibleToolDefinitionsHash,
  isToolEffectWithinCeiling,
  meetToolEffects,
  verifyExecutionContractHash,
  type BuildExecutionContractInput
} from '@/tape/domain/executionContract'

const RUN_ID = '11111111-1111-4111-8111-111111111111'
const SERVER_ID = '22222222-2222-4222-8222-222222222222'
const BINDING_HASH = 'a'.repeat(64)

function agentTool(
  name: string,
  execution: MCPToolDefinition['execution'] = TOOL_EXECUTION.read.parallel
): MCPToolDefinition {
  return {
    source: 'agent',
    execution,
    type: 'function',
    function: {
      name,
      description: `${name} description`,
      parameters: { type: 'object', properties: {} }
    },
    server: {
      name: 'agent-filesystem',
      icons: '',
      description: 'Agent tools'
    }
  }
}

function mcpTool(
  overrides: {
    name?: string
    serverId?: string
    execution?: MCPToolDefinition['execution']
  } = {}
): MCPToolDefinition {
  const name = overrides.name ?? 'remote_read'
  return {
    source: 'mcp',
    execution: overrides.execution ?? TOOL_EXECUTION.write,
    type: 'function',
    function: {
      name,
      description: `${name} description`,
      parameters: { type: 'object', properties: { optional: undefined } }
    },
    server: {
      name: 'remote',
      icons: '',
      description: 'Remote tools',
      id: overrides.serverId ?? SERVER_ID,
      configGeneration: 3,
      bindingHash: BINDING_HASH
    },
    raw: {
      name: 'read',
      inputSchema: { type: 'object', properties: {} }
    }
  }
}

function buildInput(
  overrides: Partial<BuildExecutionContractInput> = {}
): BuildExecutionContractInput {
  const promptAssembly = assemblePromptSections([
    createPromptAssemblySection({
      kind: 'configured_prompt',
      sourceRef: 'session:generation-settings.system-prompt',
      content: 'Keep this secret body out of the contract.'
    }),
    createPromptAssemblySection({
      kind: 'agents_instructions',
      sourceRef: 'workspace:AGENTS.md',
      content: '',
      freshness: 'missing',
      degradationCodes: ['agents_file_missing']
    })
  ])
  return {
    request: {
      sessionId: 'session-1',
      messageId: 'message-1',
      runId: RUN_ID,
      requestSeq: 2
    },
    promptAssembly,
    providerMessages: [
      { role: 'system', content: promptAssembly.prompt },
      { role: 'user', content: 'Hello' }
    ],
    tools: [mcpTool(), agentTool('read')],
    providerId: 'provider-1',
    modelId: 'model-1',
    modelConfig: {
      maxTokens: 4096,
      contextLength: 32_768,
      vision: false,
      functionCall: true,
      reasoning: false,
      type: ModelType.Chat,
      conversationId: 'session-1'
    },
    temperature: 0.2,
    maxTokens: 2048,
    workspace: { kind: 'path', path: '/workspace/project/' },
    maxSubagentDepth: 1,
    dynamicControlSnapshot: {
      permissionMode: 'default',
      requestAdmitted: true,
      cancellationRequested: false
    },
    assemblerVersion: 'deepchat-view-v1',
    ...overrides
  }
}

describe('ExecutionContract domain', () => {
  it('builds a bounded immutable contract without persisting prompt bodies', () => {
    const contract = buildExecutionContract(buildInput())
    const serialized = JSON.stringify(contract)

    expect(contract).toMatchObject({
      schemaVersion: 1,
      hashVersion: 1,
      request: { runId: RUN_ID, requestSeq: 2 },
      ceilings: {
        workspace: { kind: 'path', path: '/workspace/project/' },
        maxSubagentDepth: 1
      },
      provenance: {
        promptSections: [
          {
            kind: 'configured_prompt',
            contentHash: expect.stringMatching(/^[0-9a-f]{64}$/)
          },
          {
            kind: 'agents_instructions',
            inclusion: 'omitted',
            freshness: 'missing',
            degradationCodes: ['agents_file_missing']
          }
        ],
        taskContractRef: null
      },
      contractHash: expect.stringMatching(/^[0-9a-f]{64}$/)
    })
    expect(serialized).not.toContain('Keep this secret body')
    expect(contract.ceilings.tools.map((tool) => tool.target.providerVisibleName)).toEqual([
      'remote_read',
      'read'
    ])
    expect(
      contract.ceilings.tools.find((tool) => tool.target.source === 'agent')?.target
    ).toMatchObject({
      source: 'agent',
      serverId: null,
      configGeneration: null,
      bindingHash: null,
      originalName: 'read'
    })
    expect(Object.isFrozen(contract)).toBe(true)
    expect(Object.isFrozen(contract.ceilings.tools[0].target)).toBe(true)
    expect(Object.isFrozen(contract.provenance.promptSections)).toBe(true)
    expect(verifyExecutionContractHash(contract)).toBe(true)
  })

  it('hashes the exact provider order while canonicalizing the enforcement projection', () => {
    const first = buildExecutionContract(buildInput({ tools: [mcpTool(), agentTool('read')] }))
    const reversed = buildExecutionContract(buildInput({ tools: [agentTool('read'), mcpTool()] }))

    expect(first.ceilings.tools).toEqual(reversed.ceilings.tools)
    expect(first.provenance.internalExecutionPolicyHash).toBe(
      reversed.provenance.internalExecutionPolicyHash
    )
    expect(first.provenance.providerVisibleToolDefinitionsHash).not.toBe(
      reversed.provenance.providerVisibleToolDefinitionsHash
    )
    expect(first.contractHash).not.toBe(reversed.contractHash)
  })

  it('excludes execution policy from the provider-visible hash and includes it internally', () => {
    const read = buildExecutionContract(
      buildInput({ tools: [agentTool('inspect', TOOL_EXECUTION.read.sequential)] })
    )
    const write = buildExecutionContract(
      buildInput({ tools: [agentTool('inspect', TOOL_EXECUTION.write)] })
    )

    expect(read.provenance.providerVisibleToolDefinitionsHash).toBe(
      write.provenance.providerVisibleToolDefinitionsHash
    )
    expect(read.provenance.internalExecutionPolicyHash).not.toBe(
      write.provenance.internalExecutionPolicyHash
    )

    const otherWorkspace = buildExecutionContract(
      buildInput({
        tools: [agentTool('inspect', TOOL_EXECUTION.read.sequential)],
        workspace: { kind: 'path', path: '/workspace/other' }
      })
    )
    expect(read.provenance.internalExecutionPolicyHash).not.toBe(
      otherWorkspace.provenance.internalExecutionPolicyHash
    )
  })

  it('deduplicates identical targets and rejects ambiguous target or policy mappings', () => {
    const duplicate = agentTool('read')
    expect(
      buildExecutionContract(buildInput({ tools: [duplicate, duplicate] })).ceilings.tools
    ).toHaveLength(1)

    expect(() =>
      buildExecutionContract(
        buildInput({
          tools: [
            agentTool('read', TOOL_EXECUTION.read.parallel),
            agentTool('read', TOOL_EXECUTION.write)
          ]
        })
      )
    ).toThrow(/conflicting execution policies/)
    expect(() =>
      buildExecutionContract(
        buildInput({
          tools: [mcpTool(), mcpTool({ serverId: '33333333-3333-4333-8333-333333333333' })]
        })
      )
    ).toThrow(/resolves to conflicting targets/)

    const changedDefinition = agentTool('read')
    changedDefinition.function.description = 'A different provider-visible definition'
    expect(() =>
      buildExecutionContract(buildInput({ tools: [agentTool('read'), changedDefinition] }))
    ).toThrow(/conflicting provider definitions/)
  })

  it('requires stable MCP bindings and matching prompt provenance', () => {
    const missingBinding = mcpTool()
    delete missingBinding.server.bindingHash
    expect(() => buildExecutionContract(buildInput({ tools: [missingBinding] }))).toThrow(
      /server.bindingHash/
    )

    const input = buildInput()
    expect(() =>
      buildExecutionContract({
        ...input,
        providerMessages: [{ role: 'system', content: 'different prompt' }]
      })
    ).toThrow(/does not match the provider-visible system message/)

    const corruptedSection = {
      ...input.promptAssembly.sections[0],
      contentHash: '0'.repeat(64)
    }
    expect(() =>
      buildExecutionContract({
        ...input,
        promptAssembly: {
          ...input.promptAssembly,
          sections: [corruptedSection]
        }
      })
    ).toThrow(/contentHash does not match/)
  })

  it('omits conversation identity from the generation hash without mutating config', () => {
    const firstConfig = buildInput().modelConfig
    const secondConfig = { ...firstConfig, conversationId: 'session-2' }

    expect(
      buildEffectiveGenerationConfigHash({
        modelConfig: firstConfig,
        temperature: 0.2,
        maxTokens: 2048
      })
    ).toBe(
      buildEffectiveGenerationConfigHash({
        modelConfig: secondConfig,
        temperature: 0.2,
        maxTokens: 2048
      })
    )
    expect(firstConfig.conversationId).toBe('session-1')
  })

  it('preserves prototype-shaped schema keys in provider-visible tool hashes', () => {
    const tool = mcpTool()
    Object.defineProperty(tool.function.parameters.properties, '__proto__', {
      value: { type: 'string' },
      enumerable: true,
      configurable: true
    })
    const baseline = mcpTool()

    expect(buildProviderVisibleToolDefinitionsHash([tool])).not.toBe(
      buildProviderVisibleToolDefinitionsHash([baseline])
    )
  })

  it('enforces tool and prompt-section count limits before canonical construction', () => {
    expect(() =>
      buildExecutionContract(
        buildInput({
          tools: Array.from({ length: MAX_EXECUTION_CONTRACT_TOOLS + 1 }, (_, index) =>
            agentTool(`tool_${index}`)
          )
        })
      )
    ).toThrow(ExecutionContractError)

    expect(() => buildExecutionContract(buildInput({ maxSubagentDepth: 2 }))).toThrow(
      /V1 limit of 1/
    )

    const promptAssembly = assemblePromptSections(
      Array.from({ length: MAX_EXECUTION_CONTRACT_PROMPT_SECTIONS }, (_, index) =>
        createPromptAssemblySection({
          kind: 'tooling',
          sourceRef: `runtime:tooling:${index}`,
          content: `section ${index}`
        })
      )
    )
    const extraSection = createPromptAssemblySection({
      kind: 'tooling',
      sourceRef: 'runtime:tooling:extra',
      content: 'extra'
    })
    expect(() =>
      buildExecutionContract(
        buildInput({
          promptAssembly: {
            prompt: promptAssembly.prompt,
            sections: [...promptAssembly.sections, extraSection]
          },
          providerMessages: [{ role: 'system', content: promptAssembly.prompt }]
        })
      )
    ).toThrow(ExecutionContractError)
  })

  it('rejects a canonical contract above the persistence byte budget', () => {
    const promptAssembly = assemblePromptSections(
      Array.from({ length: 40 }, (_, index) =>
        createPromptAssemblySection({
          kind: 'tooling',
          sourceRef: `runtime:${index}:${'x'.repeat(1_900)}`,
          content: `section ${index}`
        })
      )
    )

    expect(() =>
      buildExecutionContract(
        buildInput({
          promptAssembly,
          providerMessages: [{ role: 'system', content: promptAssembly.prompt }]
        })
      )
    ).toThrow(/exceeds 65536 UTF-8 bytes/)
  })

  it('detects hash tampering and applies the declared effect ordering', () => {
    const contract = buildExecutionContract(buildInput())
    const tampered = {
      ...contract,
      dynamicControlSnapshot: { ...contract.dynamicControlSnapshot, permissionMode: 'full_access' }
    } as typeof contract

    expect(verifyExecutionContractHash(tampered)).toBe(false)
    expect(isToolEffectWithinCeiling('read', 'write')).toBe(true)
    expect(isToolEffectWithinCeiling('write', 'read')).toBe(false)
    expect(meetToolEffects('read', 'write')).toBe('read')
    expect(meetToolEffects('write', 'write')).toBe('write')
  })
})
