import { createHash } from 'node:crypto'
import type {
  DeepChatPromptAssembly,
  DeepChatPromptAssemblySection,
  DeepChatPromptDegradationCode,
  DeepChatPromptSectionKind,
  DeepChatPromptSourceFreshness
} from '@shared/types/prompt-assembly'

const MAX_PROMPT_SECTIONS = 64
const MAX_SECTION_DEGRADATION_CODES = 16

function hashContent(content: string): string {
  return createHash('sha256').update(content, 'utf8').digest('hex')
}

function normalizeDegradationCodes(
  codes: readonly DeepChatPromptDegradationCode[] | undefined
): readonly DeepChatPromptDegradationCode[] | undefined {
  const normalized = [...new Set(codes ?? [])].sort().slice(0, MAX_SECTION_DEGRADATION_CODES)
  return normalized.length > 0 ? Object.freeze(normalized) : undefined
}

export function createPromptAssemblySection(input: {
  kind: DeepChatPromptSectionKind
  sourceRef: string
  content: string
  separatorBefore?: '\n' | '\n\n'
  freshness?: DeepChatPromptSourceFreshness
  degradationCodes?: readonly DeepChatPromptDegradationCode[]
  normalize?: 'trim' | 'trim_end' | 'none'
}): DeepChatPromptAssemblySection {
  const content =
    input.normalize === 'none'
      ? input.content
      : input.normalize === 'trim_end'
        ? input.content.trimEnd()
        : input.content.trim()
  const hasContent = content.trim().length > 0
  const degradationCodes = normalizeDegradationCodes(input.degradationCodes)
  const inclusion = !hasContent
    ? 'omitted'
    : degradationCodes
      ? 'degraded'
      : 'included'

  return Object.freeze({
    kind: input.kind,
    sourceRef: input.sourceRef,
    inclusion,
    ...(hasContent ? { contentHash: hashContent(content) } : {}),
    ...(input.freshness ? { freshness: input.freshness } : {}),
    ...(degradationCodes ? { degradationCodes } : {}),
    content,
    ...(input.separatorBefore ? { separatorBefore: input.separatorBefore } : {})
  })
}

export function assemblePromptSections(
  sections: readonly DeepChatPromptAssemblySection[]
): DeepChatPromptAssembly {
  if (sections.length > MAX_PROMPT_SECTIONS) {
    throw new RangeError(`System prompt has more than ${MAX_PROMPT_SECTIONS} provenance sections.`)
  }

  let prompt = ''
  for (const section of sections) {
    if (!section.content.trim()) continue
    if (!prompt) {
      prompt = section.content
      continue
    }
    prompt += `${section.separatorBefore ?? '\n\n'}${section.content}`
  }

  return Object.freeze({
    prompt,
    sections: Object.freeze([...sections])
  })
}

export function appendPromptAssemblySection(
  assembly: DeepChatPromptAssembly,
  section: DeepChatPromptAssemblySection
): DeepChatPromptAssembly {
  if (
    assembly.sections.some(
      (candidate) =>
        candidate.kind === section.kind &&
        candidate.sourceRef === section.sourceRef &&
        candidate.contentHash === section.contentHash
    )
  ) {
    return assembly
  }
  if (assembly.sections.length >= MAX_PROMPT_SECTIONS) {
    throw new RangeError(`System prompt has more than ${MAX_PROMPT_SECTIONS} provenance sections.`)
  }
  const prompt = !section.content.trim()
    ? assembly.prompt
    : assembly.prompt
      ? `${assembly.prompt}${section.separatorBefore ?? '\n\n'}${section.content}`
      : section.content
  return Object.freeze({
    prompt,
    sections: Object.freeze([...assembly.sections, section])
  })
}

export function recordPromptAssemblyObservation(
  assembly: DeepChatPromptAssembly,
  section: DeepChatPromptAssemblySection
): DeepChatPromptAssembly {
  if (assembly.sections.length >= MAX_PROMPT_SECTIONS) {
    throw new RangeError(`System prompt has more than ${MAX_PROMPT_SECTIONS} provenance sections.`)
  }
  return Object.freeze({
    prompt: assembly.prompt,
    sections: Object.freeze([...assembly.sections, section])
  })
}

export function createOpaquePromptAssembly(prompt: string): DeepChatPromptAssembly {
  return assemblePromptSections([
    createPromptAssemblySection({
      kind: 'effective_system_prompt',
      sourceRef: 'runtime:provided-system-message',
      content: prompt,
      degradationCodes: ['legacy_prompt_provenance'],
      normalize: 'none'
    })
  ])
}

export function reconcilePromptAssembly(
  assembly: DeepChatPromptAssembly,
  effectiveSystemPrompt: string
): DeepChatPromptAssembly {
  if (assembly.prompt === effectiveSystemPrompt) return assembly
  return assemblePromptSections([
    createPromptAssemblySection({
      kind: 'effective_system_prompt',
      sourceRef: 'runtime:effective-system-message',
      content: effectiveSystemPrompt,
      degradationCodes: ['prompt_projection_mismatch'],
      normalize: 'none'
    })
  ])
}
