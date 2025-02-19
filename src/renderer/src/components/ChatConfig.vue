<script setup lang="ts">
import { useI18n } from 'vue-i18n'

import { watch, computed } from 'vue'
import { Label } from '@/components/ui/label'
import { Slider } from '@/components/ui/slider'
import { Icon } from '@iconify/vue'
import { Textarea } from '@/components/ui/textarea'
// import { Button } from '@/components/ui/button'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip'
import { useChatStore } from '@/stores/chat'

const chatStore = useChatStore()
const { t } = useI18n()
// 计算属性用于处理 Slider 的数组值
const temperatureValue = computed({
  get: () => [chatStore.chatConfig.temperature],
  set: ([value]) => {
    chatStore.updateChatConfig({ temperature: value })
  }
})

const contextLengthValue = computed({
  get: () => [chatStore.chatConfig.contextLength],
  set: ([value]) => {
    chatStore.updateChatConfig({ contextLength: value })
  }
})

const maxTokensValue = computed({
  get: () => [chatStore.chatConfig.maxTokens],
  set: ([value]) => {
    chatStore.updateChatConfig({ maxTokens: value })
  }
})

// 添加格式化函数
const formatSize = (size: number): string => {
  if (size >= 1024 * 1024) {
    return `${(size / (1024 * 1024)).toFixed(1)}M`
  } else if (size >= 1024) {
    return `${(size / 1024).toFixed(1)}K`
  }
  return `${size}`
}

// 监听系统提示词变化
watch(
  () => chatStore.chatConfig.systemPrompt,
  () => {
    chatStore.updateChatConfig({ systemPrompt: chatStore.chatConfig.systemPrompt })
  }
)

// 监听配置变化并自动保存
watch(
  () => chatStore.chatConfig,
  async () => {
    await chatStore.saveChatConfig()
  },
  { deep: true }
)
</script>

<template>
  <div class="pt-2 pb-6 px-2">
    <h2 class="text-xs text-secondary-foreground px-2">{{ t('settings.model.title') }}</h2>

    <div class="space-y-6">
      <!-- System Prompt -->
      <div class="space-y-2 px-2">
        <div class="flex items-center space-x-2 py-1.5">
          <Icon icon="lucide:terminal" class="w-4 h-4 text-muted-foreground" />
          <Label class="text-xs font-medium">{{ t('settings.model.systemPrompt.label') }}</Label>
          <TooltipProvider>
            <Tooltip>
              <TooltipTrigger>
                <Icon icon="lucide:help-circle" class="w-4 h-4 text-muted-foreground" />
              </TooltipTrigger>
              <TooltipContent>
                <p>{{ t('settings.model.systemPrompt.description') }}</p>
              </TooltipContent>
            </Tooltip>
          </TooltipProvider>
        </div>
        <Textarea
          v-model="chatStore.chatConfig.systemPrompt"
          :placeholder="t('settings.model.systemPrompt.placeholder')"
        />
      </div>

      <!-- Temperature -->
      <div class="space-y-4 px-2">
        <div class="flex items-center justify-between">
          <div class="flex items-center space-x-2">
            <Icon icon="lucide:thermometer" class="w-4 h-4 text-muted-foreground" />
            <Label class="text-xs font-medium">{{ t('settings.model.temperature.label') }}</Label>
            <TooltipProvider>
              <Tooltip>
                <TooltipTrigger>
                  <Icon icon="lucide:help-circle" class="w-4 h-4 text-muted-foreground" />
                </TooltipTrigger>
                <TooltipContent>
                  <p>{{ t('settings.model.temperature.description') }}</p>
                </TooltipContent>
              </Tooltip>
            </TooltipProvider>
          </div>
          <span class="text-xs text-muted-foreground">{{ chatStore.chatConfig.temperature }}</span>
        </div>
        <Slider v-model="temperatureValue" :min="0.1" :max="1.5" :step="0.1" />
      </div>

      <!-- Context Length -->
      <div class="space-y-4 px-2">
        <div class="flex items-center justify-between">
          <div class="flex items-center space-x-2">
            <Icon icon="lucide:pencil-ruler" class="w-4 h-4 text-muted-foreground" />
            <Label class="text-xs font-medium">{{ t('settings.model.contextLength.label') }}</Label>
            <TooltipProvider>
              <Tooltip>
                <TooltipTrigger>
                  <Icon icon="lucide:help-circle" class="w-4 h-4 text-muted-foreground" />
                </TooltipTrigger>
                <TooltipContent>
                  <p>{{ t('settings.model.contextLength.description') }}</p>
                </TooltipContent>
              </Tooltip>
            </TooltipProvider>
          </div>
          <span class="text-xs text-muted-foreground">{{
            formatSize(chatStore.chatConfig.contextLength)
          }}</span>
        </div>
        <Slider v-model="contextLengthValue" :min="2048" :max="65536" :step="1024" />
      </div>

      <!-- Response Length -->
      <div class="space-y-4 px-2">
        <div class="flex items-center justify-between">
          <div class="flex items-center space-x-2">
            <Icon icon="lucide:message-circle-reply" class="w-4 h-4 text-muted-foreground" />
            <Label class="text-xs font-medium">{{
              t('settings.model.responseLength.label')
            }}</Label>
            <TooltipProvider>
              <Tooltip>
                <TooltipTrigger>
                  <Icon icon="lucide:help-circle" class="w-4 h-4 text-muted-foreground" />
                </TooltipTrigger>
                <TooltipContent>
                  <p>{{ t('settings.model.responseLength.description') }}</p>
                </TooltipContent>
              </Tooltip>
            </TooltipProvider>
          </div>
          <span class="text-xs text-muted-foreground">{{
            formatSize(chatStore.chatConfig.maxTokens)
          }}</span>
        </div>
        <Slider v-model="maxTokensValue" :min="1024" :max="8192" :step="128" />
      </div>
    </div>
  </div>
</template>
