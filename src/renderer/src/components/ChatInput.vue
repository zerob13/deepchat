<template>
  <div class="w-full max-w-5xl mx-auto">
    <div
      class="bg-card border border-border rounded-lg focus-within:border-primary p-2 flex flex-col gap-2 shadow-sm"
    >
      <!-- {{  t('chat.input.fileArea') }} -->
      <div v-if="selectedFiles.length > 0">
        <TransitionGroup
          name="file-list"
          tag="div"
          class="flex flex-wrap gap-1.5"
          enter-active-class="transition-all duration-300 ease-in-out"
          leave-active-class="transition-all duration-300 ease-in-out"
          enter-from-class="opacity-0 -translate-y-2"
          leave-to-class="opacity-0 -translate-y-2"
          move-class="transition-transform duration-300 ease-in-out"
        >
          <FileItem
            v-for="(file, idx) in selectedFiles"
            :key="file.name"
            :file-name="file.name"
            :deletable="true"
            @delete="deleteFile(idx)"
          />
        </TransitionGroup>
      </div>
      <!-- {{ t('chat.input.inputArea') }} -->
      <ContextMenu>
        <ContextMenuTrigger>
          <Textarea
            ref="textareaRef"
            v-model="inputText"
            :auto-focus="true"
            :rows="rows"
            :max-rows="maxRows"
            :placeholder="t('chat.input.placeholder')"
            class="border-none max-h-[10rem] shadow-none p-2 focus-visible:ring-0 focus-within:ring-0 ring-0 outline-none focus-within:outline-none text-sm resize-none overflow-y-auto"
            @keydown.enter.exact.prevent="handleEnterKey"
            @input="adjustHeight"
          ></Textarea>
        </ContextMenuTrigger>
        <ContextMenuContent>
          <ContextMenuItem @click="copyText">
            <Icon icon="lucide:copy" class="w-4 h-4 mr-2" />
            {{ t('common.copy') }}
          </ContextMenuItem>
          <ContextMenuItem @click="pasteText">
            <Icon icon="lucide:clipboard" class="w-4 h-4 mr-2" />
            {{ t('common.paste') }}
          </ContextMenuItem>
        </ContextMenuContent>
      </ContextMenu>

      <div class="flex items-center justify-between">
        <!-- {{ t('chat.input.functionSwitch') }} -->
        <div class="flex gap-1.5">
          <!-- {{ t('chat.input.fileSelect') }} -->
          <slot name="addon-buttons"></slot>
          <Button
            v-show="false"
            variant="outline"
            size="icon"
            class="w-7 h-7 text-xs text-muted-foreground"
            @click="openFilePicker"
          >
            <Icon icon="lucide:plus" class="w-4 h-4" />
            <input ref="fileInput" type="file" class="hidden" multiple @change="handleFileSelect" />
          </Button>
          <Button
            v-show="false"
            variant="outline"
            size="xs"
            :class="[
              'rounded-lg text-xs font-normal',
              settings.deepThinking
                ? '!bg-primary dark:!bg-primary border-primary text-primary-foreground hover:bg-primary/90 hover:text-primary-foreground'
                : 'text-muted-foreground'
            ]"
            @click="onDeepThinkingClick"
          >
            <Icon icon="lucide:sparkles" class="w-4 h-4" />
            {{ t('chat.features.deepThinking') }}
          </Button>
          <Button
            variant="outline"
            size="xs"
            :class="[
              'rounded-lg text-xs font-normal',
              settings.webSearch
                ? 'dark:!bg-primary bg-primary border-primary text-primary-foreground hover:bg-primary/90 hover:text-primary-foreground'
                : 'text-muted-foreground'
            ]"
            @click="onWebSearchClick"
          >
            <Icon icon="lucide:globe" class="w-4 h-4" />
            {{ t('chat.features.webSearch') }}
          </Button>
        </div>
        <Button
          variant="default"
          size="icon"
          class="w-7 h-7 text-xs"
          :disabled="disabledSend"
          @click="emitSend"
        >
          <Icon icon="lucide:send" class="w-4 h-4" />
        </Button>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { useI18n } from 'vue-i18n'
import { computed, nextTick, onMounted, ref } from 'vue'
import { Textarea } from '@/components/ui/textarea'
import { Button } from '@/components/ui/button'
import { Icon } from '@iconify/vue'
import FileItem from './FileItem.vue'
import { useChatStore } from '@/stores/chat'
import { UserMessageContent } from '@shared/chat'
import { usePresenter } from '@/composables/usePresenter'
import { 
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuTrigger
} from '@/components/ui/context-menu'

const { t } = useI18n()
const configPresenter = usePresenter('configPresenter')
const chatStore = useChatStore()
const inputText = ref('')
const fileInput = ref<HTMLInputElement>()
const settings = ref({
  deepThinking: false,
  webSearch: false
})

const textareaRef = ref<HTMLTextAreaElement>()

const selectedFiles = ref<File[]>([])
withDefaults(
  defineProps<{
    maxRows?: number
    rows?: number
  }>(),
  {
    maxRows: 10,
    rows: 1
  }
)

const emit = defineEmits(['send', 'file-upload'])

const openFilePicker = () => {
  fileInput.value?.click()
}

const handleFileSelect = (e: Event) => {
  const files = (e.target as HTMLInputElement).files
  if (files && files.length > 0) {
    selectedFiles.value.push(...Array.from(files))
    emit('file-upload', selectedFiles.value)
  }
}

const emitSend = () => {
  if (inputText.value.trim()) {
    const messageContent: UserMessageContent = {
      text: inputText.value.trim(),
      files: [],
      links: [],
      search: settings.value.webSearch,
      think: settings.value.deepThinking
    }

    emit('send', messageContent)
    inputText.value = ''
  }
}

const adjustHeight = (e: Event) => {
  const target = e.target as HTMLTextAreaElement
  target.style.height = 'auto'
  target.style.height = `${target.scrollHeight}px`
}

const deleteFile = (idx: number) => {
  selectedFiles.value.splice(idx, 1)
}

const disabledSend = computed(() => {
  return (
    chatStore.generatingThreadIds.has(chatStore.activeThreadId ?? '') || inputText.value.length <= 0
  )
})

const handleEnterKey = (e: KeyboardEvent) => {
  if (disabledSend.value) {
    return
  }
  if (!e.isComposing) {
    emitSend()
  }
}

const onWebSearchClick = async () => {
  settings.value.webSearch = !settings.value.webSearch
  await configPresenter.setSetting('input_webSearch', settings.value.webSearch)
}

const onDeepThinkingClick = async () => {
  settings.value.deepThinking = !settings.value.deepThinking
  await configPresenter.setSetting('input_deepThinking', settings.value.deepThinking)
}

const initSettings = async () => {
  settings.value.deepThinking = Boolean(await configPresenter.getSetting('input_deepThinking'))
  settings.value.webSearch = Boolean(await configPresenter.getSetting('input_webSearch'))
}

const copyText = () => {
  const textareaElement = textareaRef.value
  if (textareaElement) {
    const start = textareaElement.selectionStart
    const end = textareaElement.selectionEnd
    
    if (start !== end) {
      const selectedText = inputText.value.substring(start, end)
      navigator.clipboard.writeText(selectedText)
    }
  }
}

const pasteText = async () => {
  try {
    const clipboardText = await navigator.clipboard.readText()
    if (clipboardText) {
      const textareaElement = textareaRef.value
      if (textareaElement) {
        const start = textareaElement.selectionStart
        const end = textareaElement.selectionEnd
        inputText.value = 
          inputText.value.substring(0, start) + 
          clipboardText + 
          inputText.value.substring(end)
        
        // 设置光标位置到粘贴文本之后
        nextTick(() => {
          textareaElement.selectionStart = textareaElement.selectionEnd = start + clipboardText.length
          textareaElement.focus()
        })
      }
    }
  } catch (err) {
    console.error('粘贴失败:', err)
  }
}

onMounted(() => {
  initSettings()

  nextTick(() => {
    textareaRef.value?.focus()
  })
})
</script>

<style scoped></style>
