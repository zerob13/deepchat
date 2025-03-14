<script setup lang="ts">
import { ref, onMounted, computed } from 'vue'
import { useI18n } from 'vue-i18n'
import { Icon } from '@iconify/vue'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { usePresenter } from '@/composables/usePresenter'
import { MCPToolDefinition } from '@shared/presenter'

const { t } = useI18n()
const mcpPresenter = usePresenter('mcpPresenter')

// 状态
const tools = ref<MCPToolDefinition[]>([])
const isLoading = ref(false)
const isError = ref(false)
const errorMessage = ref('')

// 计算属性
const toolCount = computed(() => tools.value.length)
const hasTools = computed(() => toolCount.value > 0)

// 加载工具
const loadTools = async () => {
  try {
    isLoading.value = true
    isError.value = false
    errorMessage.value = ''

    // 获取所有工具定义
    tools.value = await mcpPresenter.getAllToolDefinitions()
  } catch (error) {
    console.error('Failed to load MCP tools:', error)
    isError.value = true
    errorMessage.value = error instanceof Error ? error.message : String(error)
  } finally {
    isLoading.value = false
  }
}

// 生命周期钩子
onMounted(async () => {
  await loadTools()
})
</script>

<template>
  <TooltipProvider>
    <Popover>
      <PopoverTrigger>
        <div class="relative">
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                class="flex items-center justify-center h-7 rounded-lg border border-border text-muted-foreground hover:bg-accent hover:text-accent-foreground transition-colors px-2"
              >
                <Icon v-if="isLoading" icon="lucide:loader" class="w-4 h-4 animate-spin" />
                <Icon
                  v-else-if="isError"
                  icon="lucide:alert-circle"
                  class="w-4 h-4 text-destructive"
                />
                <Icon v-else icon="lucide:hammer" class="w-4 h-4" />

                <span
                  v-if="hasTools && !isLoading && !isError"
                  class="text-muted-foreground text-sm pl-2"
                  >{{ toolCount }}</span
                >
              </button>
            </TooltipTrigger>
            <TooltipContent>
              <p v-if="isLoading">{{ t('mcp.tools.loading') }}</p>
              <p v-else-if="isError">{{ t('mcp.tools.error') }}</p>
              <p v-else-if="hasTools">{{ t('mcp.tools.available', { count: toolCount }) }}</p>
              <p v-else>{{ t('mcp.tools.none') }}</p>
            </TooltipContent>
          </Tooltip>
        </div>
      </PopoverTrigger>

      <PopoverContent class="w-80 p-0" align="end">
        <div class="p-4 border-b">
          <h3 class="text-sm font-medium">{{ t('mcp.tools.title') }}</h3>
          <p class="text-xs text-muted-foreground mt-1">{{ t('mcp.tools.description') }}</p>
        </div>

        <div class="max-h-[300px] overflow-y-auto">
          <div v-if="isLoading" class="flex justify-center items-center py-8">
            <Icon icon="lucide:loader" class="w-6 h-6 animate-spin" />
          </div>

          <div v-else-if="isError" class="p-4 text-sm text-destructive">
            {{ t('mcp.tools.loadError') }}: {{ errorMessage }}
          </div>

          <div v-else-if="tools.length === 0" class="p-4 text-sm text-muted-foreground text-center">
            {{ t('mcp.tools.empty') }}
          </div>

          <div v-else class="divide-y">
            <div v-for="tool in tools" :key="tool.function.name" class="p-3 hover:bg-accent">
              <div class="font-medium text-sm">{{ tool.function.name }}</div>
              <div class="text-xs text-muted-foreground mt-1">{{ tool.function.description }}</div>

              <!-- 参数列表 -->
              <div v-if="tool.function.parameters?.properties" class="mt-2">
                <div class="text-xs font-medium text-muted-foreground mb-1">
                  {{ t('mcp.tools.parameters') }}:
                </div>
                <div class="space-y-1">
                  <div
                    v-for="(param, paramName) in tool.function.parameters.properties"
                    :key="paramName"
                    class="text-xs flex"
                  >
                    <span class="font-mono mr-1">{{ paramName }}</span>
                    <span class="text-muted-foreground">{{ param.description }}</span>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>

        <div class="p-2 border-t flex justify-end">
          <button class="text-xs text-primary hover:underline" @click="loadTools">
            {{ t('mcp.tools.refresh') }}
          </button>
        </div>
      </PopoverContent>
    </Popover>
  </TooltipProvider>
</template>
