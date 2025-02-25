<template>
  <div class="h-full w-full flex flex-col items-center justify-center">
    <img src="@/assets/logo-dark.png" class="w-24 h-24" />
    <h1 class="text-2xl font-bold px-8 pt-4">{{ t('newThread.greeting') }}</h1>
    <h3 class="text-lg text-muted-foreground px-8 pb-2">{{ t('newThread.prompt') }}</h3>
    <div class="h-12"></div>
    <ChatInput class="!max-w-2xl flex-shrink-0 px-4" @send="handleSend">
      <template #addon-buttons>
        <Popover v-model:open="modelSelectOpen">
          <PopoverTrigger as-child>
            <Button variant="outline" class="flex items-center gap-1.5 px-2 h-auto py-1" size="sm">
              <ModelIcon class="w-4 h-4" :model-id="activeModel.id"></ModelIcon>
              <!-- <Icon icon="lucide:message-circle" class="w-5 h-5 text-muted-foreground" /> -->
              <h2 class="text-xs font-bold">{{ activeModel.name }}</h2>
              <Badge
                v-for="tag in activeModel.tags"
                :key="tag"
                variant="outline"
                class="py-0 rounded-lg"
                size="xs"
                >{{ t(`model.tags.${tag}`) }}</Badge
              >
              <Icon icon="lucide:chevron-right" class="w-4 h-4 text-muted-foreground" />
            </Button>
          </PopoverTrigger>
          <PopoverContent align="start" class="p-0 w-80">
            <ModelSelect @update:model="handleModelUpdate" />
          </PopoverContent>
        </Popover>
      </template>
    </ChatInput>
    <div class="h-12"></div>
  </div>
</template>

<script setup lang="ts">
import { useI18n } from 'vue-i18n'
import ChatInput from './ChatInput.vue'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { Button } from '@/components/ui/button'
import ModelIcon from './icons/ModelIcon.vue'
import { Badge } from '@/components/ui/badge'
import { Icon } from '@iconify/vue'
import ModelSelect from './ModelSelect.vue'
import { useChatStore } from '@/stores/chat'
import { MODEL_META } from '@shared/presenter'
import { useSettingsStore } from '@/stores/settings'
import { ref, watch } from 'vue'
import { UserMessageContent } from '@shared/chat'

const { t } = useI18n()

const chatStore = useChatStore()
const settingsStore = useSettingsStore()
const activeModel = ref({
  name: '',
  id: '',
  providerId: '',
  tags: []
} as {
  name: string
  id: string
  providerId: string
  tags: string[]
})

watch(
  () => [settingsStore.enabledModels, chatStore.threads],
  () => {
    if (chatStore.threads.length > 0) {
      if (chatStore.threads[0].dtThreads.length > 0) {
        const thread = chatStore.threads[0].dtThreads[0]
        const modelId = thread.settings.modelId
        for (const provider of settingsStore.enabledModels) {
          for (const model of provider.models) {
            if (model.id === modelId) {
              activeModel.value = {
                name: model.name,
                id: model.id,
                providerId: provider.providerId,
                tags: []
              }
              return
            }
          }
        }
      }
    }
    // console.log(settingsStore.enabledModels.length)
    if (settingsStore.enabledModels.length > 0) {
      const model = settingsStore.enabledModels[0].models[0]
      if (model) {
        activeModel.value = {
          name: model.name,
          id: model.id,
          providerId: settingsStore.enabledModels[0].providerId,
          tags: []
        }
      }
    }
  },
  { immediate: true, deep: true }
)

const modelSelectOpen = ref(false)
const handleModelUpdate = (model: MODEL_META, providerId: string) => {
  activeModel.value = {
    name: model.name,
    id: model.id,
    providerId: providerId,
    tags: []
  }
  modelSelectOpen.value = false
}

const handleSend = async (content: UserMessageContent) => {
  const threadId = await chatStore.createThread(content.text, {
    providerId: activeModel.value.providerId,
    modelId: activeModel.value.id,
    systemPrompt: '',
    temperature: 0.7,
    contextLength: 1000,
    maxTokens: 2000
  })
  console.log('threadId', threadId, activeModel.value)
  await chatStore.setActiveThread(threadId)
  chatStore.sendMessage(content)
}
</script>

<style scoped></style>
