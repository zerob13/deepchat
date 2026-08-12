import type {
  TapeEffectiveUserMessageSourceReader,
  TapeExecutionViewManifestReader,
  TapeIncarnationReader,
  TapeRunViewManifestReader,
  TapeSkillMaterializationReader,
  TapeSkillMaterializationWriter
} from '../ports/capabilities'

export type SkillContextTapePort = TapeIncarnationReader &
  TapeSkillMaterializationWriter &
  TapeSkillMaterializationReader &
  TapeEffectiveUserMessageSourceReader &
  TapeRunViewManifestReader

export type SkillExecutionAuthorityTapePort = TapeExecutionViewManifestReader &
  TapeIncarnationReader &
  TapeSkillMaterializationReader

export function createSkillContextTapePort(source: SkillContextTapePort): SkillContextTapePort {
  return Object.freeze({
    getTapeIncarnationId: (sessionId: string) => source.getTapeIncarnationId(sessionId),
    materializeSkillContexts: (
      inputs: Parameters<SkillContextTapePort['materializeSkillContexts']>[0]
    ) => source.materializeSkillContexts(inputs),
    readSkillMaterialization: (
      ref: Parameters<SkillContextTapePort['readSkillMaterialization']>[0]
    ) => source.readSkillMaterialization(ref),
    getEffectiveUserMessageSourceEntryId: (sessionId: string, messageId: string) =>
      source.getEffectiveUserMessageSourceEntryId(sessionId, messageId),
    getLatestViewManifestByRunBinding: (
      input: Parameters<SkillContextTapePort['getLatestViewManifestByRunBinding']>[0]
    ) => source.getLatestViewManifestByRunBinding(input)
  })
}

export function createSkillExecutionAuthorityTapePort(
  source: SkillExecutionAuthorityTapePort
): SkillExecutionAuthorityTapePort {
  return Object.freeze({
    getViewManifestByExecutionBinding: (
      input: Parameters<SkillExecutionAuthorityTapePort['getViewManifestByExecutionBinding']>[0]
    ) => source.getViewManifestByExecutionBinding(input),
    getTapeIncarnationId: (sessionId: string) => source.getTapeIncarnationId(sessionId),
    readSkillMaterialization: (
      ref: Parameters<SkillExecutionAuthorityTapePort['readSkillMaterialization']>[0]
    ) => source.readSkillMaterialization(ref)
  })
}
