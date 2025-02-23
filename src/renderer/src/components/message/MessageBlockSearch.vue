<template>
  <div
    class="inline-flex z-0 flex-row gap-2 items-center cursor-pointer h-9 text-xs text-muted-foreground hover:bg-accent px-2 rounded-md"
  >
    <template v-if="block.status === 'success'">
      <div v-if="block.extra.pages" class="flex flex-row ml-1.5">
        <template v-for="(page, index) in block.extra.pages" :key="index">
          <img
            v-if="page.icon"
            :src="page.icon"
            :style="{
              zIndex: block.extra.pages.length - index
            }"
            class="w-6 h-6 -ml-1.5 border-card rounded-full bg-card border-2 box-border"
          />
          <Icon
            v-else
            icon="lucide:compass"
            class="w-6 h-6 -ml-1.5 border-card rounded-full bg-card border-2 box-border"
          />
        </template>
      </div>
      <span>{{ t('chat.search.results', [block.extra.total]) }}</span>
      <Icon icon="lucide:chevron-right" class="w-4 h-4 text-muted-foreground" />
    </template>
    <template v-else-if="block.status === 'loading'">
      <Icon icon="lucide:loader-circle" class="w-4 h-4 text-muted-foreground animate-spin" />
      <span>{{
        block.extra.total > 0
          ? t('chat.search.results', [block.extra.total])
          : t('chat.search.searching')
      }}</span>
    </template>
  </div>
</template>

<script setup lang="ts">
import { useI18n } from 'vue-i18n'
import { Icon } from '@iconify/vue'
const { t } = useI18n()

defineProps<{
  block: {
    status: 'success' | 'loading'
    extra: {
      total: number
      pages?: Array<{
        url: string
        icon: string
      }>
    }
  }
}>()
</script>
