<template>
  <div class="w-full h-full overflow-y-auto p-4">
    <div class="space-y-6">
      <div>
        <h2 class="text-lg font-semibold mb-2">{{ t('settings.mcp.title') }}</h2>
        <p class="text-sm text-muted-foreground mb-4">
          {{ t('settings.mcp.description') }}
        </p>
      </div>

      <div class="border rounded-lg p-4">
        <McpConfig />
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { useI18n } from 'vue-i18n'
import McpConfig from '@/components/mcp-config/mcpConfig.vue'

const { t } = useI18n()
</script>
