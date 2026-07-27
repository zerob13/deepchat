<template>
  <NodeViewWrapper
    class="file-chip inline-flex items-center gap-1 rounded-md border border-muted-foreground/25 bg-muted/25 px-1.5 py-0.5 text-xs text-muted-foreground select-none"
    data-file-attachment
    as="span"
  >
    <Icon :icon="fileIcon" class="h-3 w-3 shrink-0" />
    <span class="truncate max-w-[120px]">{{ node.attrs.fileName }}</span>
    <DropdownMenu v-if="hasRepresentationChoice">
      <DropdownMenuTrigger as-child>
        <button
          type="button"
          contenteditable="false"
          data-testid="attachment-representation-trigger"
          class="inline-flex h-4 items-center gap-0.5 rounded-sm px-1 text-[10px] font-medium text-muted-foreground hover:bg-muted-foreground/20 hover:text-foreground"
          :title="representationLabel"
          :aria-label="t('chat.attachments.chooseRepresentation', { name: node.attrs.fileName })"
          @mousedown.stop
        >
          <span>{{ representationLabel }}</span>
          <Icon icon="lucide:chevron-down" class="h-2.5 w-2.5" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" class="min-w-40" @mousedown.stop>
        <DropdownMenuRadioGroup
          :model-value="requestedRepresentation"
          @update:model-value="handleRepresentationChange"
        >
          <DropdownMenuRadioItem
            v-for="option in representationOptions"
            :key="option.value"
            :value="option.value"
          >
            {{ t(option.labelKey) }}
          </DropdownMenuRadioItem>
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
    <button
      type="button"
      class="inline-flex h-3.5 w-3.5 items-center justify-center rounded-sm hover:bg-muted-foreground/20"
      :aria-label="`${t('common.delete')} ${node.attrs.fileName}`"
      @mousedown.prevent="handleRemove"
    >
      <Icon icon="lucide:x" class="h-3 w-3" />
    </button>
  </NodeViewWrapper>
</template>

<script setup lang="ts">
import { computed, inject } from 'vue'
import { Icon } from '@iconify/vue'
import { NodeViewWrapper } from '@tiptap/vue-3'
import type { NodeViewProps } from '@tiptap/vue-3'
import { useI18n } from 'vue-i18n'
import { getMimeTypeIcon } from '@/lib/utils'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger
} from '@shadcn/components/ui/dropdown-menu'
import type { AttachmentRepresentationPreference } from '@shared/types/attachment'
import {
  isImageAttachment,
  isPdfAttachment,
  normalizeAttachmentRepresentationPreferenceForFile
} from '@shared/utils/attachmentRepresentation'
import { INPUT_NODE_ACTIONS, type InputNodeActions } from './symbols'

const props = defineProps<NodeViewProps>()
const actions = inject<InputNodeActions>(INPUT_NODE_ACTIONS)
const { t } = useI18n()

const fileIcon = computed(() => {
  const mimeType = (props.node.attrs.mimeType as string) || ''
  return getMimeTypeIcon(mimeType)
})

const attachmentFile = computed(() => ({
  name: String(props.node.attrs.fileName || ''),
  path: String(props.node.attrs.filePath || ''),
  mimeType: String(props.node.attrs.mimeType || ''),
  type: undefined
}))
const isImage = computed(() => isImageAttachment(attachmentFile.value))
const isPdf = computed(() => isPdfAttachment(attachmentFile.value))
const hasRepresentationChoice = computed(() => isImage.value || isPdf.value)
const requestedRepresentation = computed<AttachmentRepresentationPreference>(() =>
  normalizeAttachmentRepresentationPreferenceForFile(
    attachmentFile.value,
    props.node.attrs.requestedRepresentation
  )
)
const representationOptions = computed<
  Array<{ value: AttachmentRepresentationPreference; labelKey: string }>
>(() => {
  if (isPdf.value) {
    return [
      { value: 'auto', labelKey: 'chat.attachments.auto' },
      { value: 'embedded_text', labelKey: 'chat.attachments.useEmbeddedText' },
      { value: 'ocr_text', labelKey: 'chat.attachments.useOcrText' }
    ]
  }
  if (isImage.value) {
    return [
      { value: 'auto', labelKey: 'chat.attachments.auto' },
      { value: 'image', labelKey: 'chat.attachments.sendImage' },
      { value: 'ocr_text', labelKey: 'chat.attachments.useOcrText' }
    ]
  }
  return []
})
const representationLabel = computed(() => {
  const labelKeys: Record<AttachmentRepresentationPreference, string> = {
    auto: 'chat.attachments.auto',
    image: 'chat.attachments.imageBadge',
    embedded_text: 'chat.attachments.embeddedTextBadge',
    ocr_text: 'chat.attachments.ocrBadge'
  }
  return t(labelKeys[requestedRepresentation.value])
})

function handleRepresentationChange(value: unknown) {
  const preference = normalizeAttachmentRepresentationPreferenceForFile(attachmentFile.value, value)
  const filePath = props.node.attrs.filePath as string
  if (!filePath) {
    return
  }

  props.updateAttributes({ requestedRepresentation: preference })
  actions?.setFileRepresentation?.(filePath, preference)
}

function handleRemove() {
  const filePath = props.node.attrs.filePath as string
  props.deleteNode()
  if (filePath && actions?.removeFile) {
    actions.removeFile(filePath)
  }
}
</script>
