import type {
  SkillServicePort,
  SkillListInput,
  SkillListResult,
  SkillManageRequest,
  SkillManageResult,
  SkillViewResult
} from '@shared/types/skill'
import { BUILTIN_SKILL_AGENT_ID } from './agentSkillRoots'
import { buildSkillListResult } from './routingCatalog'

export class SkillTools {
  constructor(private readonly skillService: SkillServicePort) {}

  async handleSkillList(
    conversationId?: string,
    activeSkillNames?: string[],
    input: SkillListInput = {}
  ): Promise<SkillListResult> {
    const resolvedAgentId = conversationId
      ? await this.skillService.resolveSessionAgentId(conversationId)
      : BUILTIN_SKILL_AGENT_ID
    if (!resolvedAgentId) {
      return {
        skills: [],
        sessionActiveCount: 0,
        activeForExecutionCount: 0,
        pinnedCount: 0,
        activeCount: 0,
        totalCount: 0,
        totalMatched: 0,
        omittedCount: 0
      }
    }
    const agentId = resolvedAgentId
    const allSkills = await this.skillService.getMetadataList(agentId)
    const listedSkillNames = new Set(allSkills.map((skill) => skill.name))
    const sessionActiveSkills = conversationId
      ? (await this.skillService.getActiveSkills(conversationId)).filter((skillName) =>
          listedSkillNames.has(skillName)
        )
      : []
    const runtimeSkills = (activeSkillNames ?? []).filter((skillName) =>
      listedSkillNames.has(skillName)
    )
    return buildSkillListResult(allSkills, sessionActiveSkills, runtimeSkills, input)
  }

  async handleSkillView(
    conversationId: string | undefined,
    input: { name: string; file_path?: string }
  ): Promise<SkillViewResult> {
    const requestedSkillName = input.name.trim()
    const agentId = conversationId
      ? await this.skillService.resolveSessionAgentId(conversationId)
      : null
    if (!agentId) {
      return {
        success: false,
        name: requestedSkillName,
        error: 'No DeepChat Agent context available'
      }
    }

    return await this.skillService.viewSkillForAgent(agentId, requestedSkillName, {
      filePath: input.file_path,
      conversationId
    })
  }

  async handleSkillManage(
    conversationId: string | undefined,
    request: SkillManageRequest,
    options: { beforeMutation?: () => void } = {}
  ): Promise<SkillManageResult> {
    if (!conversationId) {
      return {
        success: false,
        action: request.action,
        error: 'No conversation context available for skill_manage'
      }
    }

    return options.beforeMutation
      ? await this.skillService.manageDraftSkill(conversationId, request, options)
      : await this.skillService.manageDraftSkill(conversationId, request)
  }
}
