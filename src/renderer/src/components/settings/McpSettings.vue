<template>
  <div class="w-full h-full overflow-y-auto flex flex-col">
    <!-- MCP全局开关 -->
    <div class="p-4 flex-shrink-0">
      <div class="flex items-center justify-between">
        <div>
          <h3 class="text-sm font-medium">{{ t('settings.mcp.enabledTitle') }}</h3>
          <p class="text-xs text-muted-foreground mt-1">
            {{ t('settings.mcp.enabledDescription') }}
          </p>
        </div>
        <Switch :checked="mcpEnabled" @update:checked="handleMcpEnabledChange" />
      </div>
    </div>

    <!-- MCP配置 -->
    <div v-if="mcpEnabled" class="border-t flex-grow">
      <McpConfig />
    </div>
    <div v-else class="p-4 text-center text-secondary-foreground text-sm">
      {{ t('settings.mcp.enableToAccess') }}
    </div>
  </div>
</template>

<script setup lang="ts">
import { useI18n } from 'vue-i18n'
import { computed } from 'vue'
import McpConfig from '@/components/mcp-config/mcpConfig.vue'
import { Switch } from '@/components/ui/switch'
import { useMcpStore } from '@/stores/mcp'

const { t } = useI18n()
const mcpStore = useMcpStore()

// 计算属性
const mcpEnabled = computed(() => mcpStore.mcpEnabled)

// 处理MCP开关状态变化
const handleMcpEnabledChange = async (enabled: boolean) => {
  await mcpStore.setMcpEnabled(enabled)
}
</script>
