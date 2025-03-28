<template>
  <div
    class="text-xs bg-red-100 text-red-700 rounded-lg border border-red-400 flex flex-col gap-2 px-2 py-2"
  >
    <div class="flex flex-row gap-2 items-center cursor-pointer">
      <Icon icon="lucide:info" class="w-4 h-4 text-red-700" />
    </div>
    <div class="prose prose-sm max-w-full break-all whitespace-pre-wrap leading-7">
      {{ t(block.content) }}
      {{ block }}
    </div>
  </div>
</template>

<script setup lang="ts">
import { useI18n } from 'vue-i18n'
import { Icon } from '@iconify/vue'

const { t } = useI18n()

defineProps<{
  block: {
    content: string
    action_type?: string
  }
}>()
</script>
