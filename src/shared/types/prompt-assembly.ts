export type DeepChatPromptSectionKind =
  | 'configured_prompt'
  | 'runtime_capabilities'
  | 'system_environment'
  | 'agents_instructions'
  | 'skills_metadata'
  | 'pinned_skills'
  | 'tooling'
  | 'orchestration_policy'
  | 'permission_rules'
  | 'verification_policy'
  | 'attachment_safety'
  | 'effective_system_prompt'

export type DeepChatPromptSectionInclusion = 'included' | 'omitted' | 'degraded'

export type DeepChatPromptSourceFreshness =
  | 'fresh'
  | 'cached'
  | 'deferred'
  | 'missing'
  | 'read_error'

export type DeepChatPromptDegradationCode =
  | 'agents_file_deferred'
  | 'agents_file_missing'
  | 'agents_file_read_error'
  | 'skill_agent_unavailable'
  | 'skill_metadata_unavailable'
  | 'active_skills_unavailable'
  | 'pinned_skill_unavailable'
  | 'pinned_skill_load_failed'
  | 'environment_build_failed'
  | 'tooling_build_failed'
  | 'prompt_projection_mismatch'
  | 'legacy_prompt_provenance'

export interface DeepChatPromptSectionProvenance {
  readonly kind: DeepChatPromptSectionKind
  readonly sourceRef: string
  readonly inclusion: DeepChatPromptSectionInclusion
  readonly contentHash?: string
  readonly freshness?: DeepChatPromptSourceFreshness
  readonly degradationCodes?: readonly DeepChatPromptDegradationCode[]
}

export interface DeepChatPromptAssemblySection extends DeepChatPromptSectionProvenance {
  readonly content: string
  readonly separatorBefore?: '\n' | '\n\n'
}

export interface DeepChatPromptAssembly {
  readonly prompt: string
  readonly sections: readonly DeepChatPromptAssemblySection[]
}
