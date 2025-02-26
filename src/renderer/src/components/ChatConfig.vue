<script setup lang="ts">
import { useI18n } from 'vue-i18n'

import { watch, computed, ref } from 'vue'
import { useDebounceFn } from '@vueuse/core'
import { Label } from '@/components/ui/label'
import { Slider } from '@/components/ui/slider'
import { Icon } from '@iconify/vue'
import { Textarea } from '@/components/ui/textarea'
import { Switch } from '@/components/ui/switch'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip'
import { useChatStore } from '@/stores/chat'

const chatStore = useChatStore()
const { t } = useI18n()

// 使用本地响应式变量存储滑块数值，以便立即响应UI
const localTemperature = ref([chatStore.chatConfig.temperature])
const localContextLength = ref([chatStore.chatConfig.contextLength])
const localMaxTokens = ref([chatStore.chatConfig.maxTokens])

// 为每个配置项创建独立的防抖函数
const debouncedUpdateTemperature = useDebounceFn((value: number) => {
  chatStore.updateChatConfig({ temperature: value })
}, 500)

const debouncedUpdateContextLength = useDebounceFn((value: number) => {
  chatStore.updateChatConfig({ contextLength: value })
}, 500)

const debouncedUpdateMaxTokens = useDebounceFn((value: number) => {
  chatStore.updateChatConfig({ maxTokens: value })
}, 500)

// 监听本地变量变化并使用防抖函数更新配置
watch(localTemperature, (value) => {
  debouncedUpdateTemperature(value[0])
})

watch(localContextLength, (value) => {
  debouncedUpdateContextLength(value[0])
})

watch(localMaxTokens, (value) => {
  debouncedUpdateMaxTokens(value[0])
})

// 监听store中的值变化并更新本地变量
watch(
  () => chatStore.chatConfig.temperature,
  (value) => {
    localTemperature.value = [value]
  }
)

watch(
  () => chatStore.chatConfig.contextLength,
  (value) => {
    localContextLength.value = [value]
  }
)

watch(
  () => chatStore.chatConfig.maxTokens,
  (value) => {
    localMaxTokens.value = [value]
  }
)

const formatSize = (size: number): string => {
  if (size >= 1024 * 1024) {
    return `${(size / (1024 * 1024)).toFixed(1)}M`
  } else if (size >= 1024) {
    return `${(size / 1024).toFixed(1)}K`
  }
  return `${size}`
}

// 使用本地响应式变量存储系统提示
const localSystemPrompt = ref(chatStore.chatConfig.systemPrompt)

// 为系统提示创建独立的防抖函数
const debouncedUpdateSystemPrompt = useDebounceFn((value: string) => {
  chatStore.updateChatConfig({ systemPrompt: value })
}, 500)

// 监听本地系统提示变化并使用防抖函数更新配置
watch(localSystemPrompt, (value) => {
  debouncedUpdateSystemPrompt(value)
})

// 监听store中的系统提示变化并更新本地变量
watch(
  () => chatStore.chatConfig.systemPrompt,
  (value) => {
    localSystemPrompt.value = value
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

// 使用本地响应式变量存储 artifacts 状态
const localArtifactsEnabled = ref(chatStore.chatConfig.artifacts === 1)

// 使用独立的防抖函数更新 artifacts 配置
const debouncedUpdateArtifacts = useDebounceFn((enabled: boolean) => {
  chatStore.updateChatConfig({ artifacts: enabled ? 1 : 0 })
}, 500)

// 监听本地 artifacts 状态变化并使用防抖函数更新配置
watch(localArtifactsEnabled, (value) => {
  debouncedUpdateArtifacts(value)
})

// 监听store中的 artifacts 状态变化并更新本地变量
watch(
  () => chatStore.chatConfig.artifacts,
  (value) => {
    localArtifactsEnabled.value = value === 1
  }
)

const artifactsEnable = computed({
  get() {
    return localArtifactsEnabled.value
  },
  set(nv: boolean) {
    localArtifactsEnabled.value = nv
  }
})

const toggleArtifacts = async (nv: boolean) => {
  console.log('toggleArtifacts', nv)
  artifactsEnable.value = !artifactsEnable.value
  console.log('toggleArtifacts', artifactsEnable.value ? 1 : 0)
}
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
          v-model="localSystemPrompt"
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
          <span class="text-xs text-muted-foreground">{{ localTemperature[0] }}</span>
        </div>
        <Slider v-model="localTemperature" :min="0.1" :max="1.5" :step="0.1" />
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
          <span class="text-xs text-muted-foreground">{{ formatSize(localContextLength[0]) }}</span>
        </div>
        <Slider v-model="localContextLength" :min="2048" :max="65536" :step="1024" />
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
          <span class="text-xs text-muted-foreground">{{ formatSize(localMaxTokens[0]) }}</span>
        </div>
        <Slider v-model="localMaxTokens" :min="1024" :max="8192" :step="128" />
      </div>
      <!-- Artifacts Toggle -->
      <div class="space-y-2 px-2">
        <div class="flex items-center justify-between">
          <div class="flex items-center space-x-2">
            <Label for="artifacts-mode">Artifacts</Label>
            <Switch
              id="artifacts-mode"
              v-model:checked="artifactsEnable"
              @update:model-value="toggleArtifacts"
            />
            <TooltipProvider>
              <Tooltip>
                <TooltipTrigger>
                  <Icon icon="lucide:help-circle" class="w-4 h-4 text-muted-foreground" />
                </TooltipTrigger>
                <TooltipContent>
                  <p>{{ t('settings.model.artifacts.description') }}</p>
                </TooltipContent>
              </Tooltip>
            </TooltipProvider>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>
