<template>
  <div
    class="inline-flex flex-row bg-card border items-center justify-start rounded-md text-xs cursor-pointer select-none overflow-hidden"
    @click="$emit('click', fileName)"
  >
    <span class="flex flex-row gap-2 items-center hover:bg-accent px-2 py-1">
      <Icon icon="lucide:file" class="w-4 h-4 text-muted-foreground" />
      {{ fileName }}
    </span>

    <span v-if="deletable" class="h-3 w-[1px] bg-border"></span>
    <span
      v-if="deletable"
      class="hover:bg-accent px-2 h-full flex items-center justify-center"
      @click.stop.prevent="$emit('delete', fileName)"
    >
      <Icon icon="lucide:x" class="w-3 h-3 text-muted-foreground" />
    </span>
  </div>
</template>

<script setup lang="ts">
import { Icon } from '@iconify/vue'

defineProps<{
  fileName: string
  deletable: boolean
}>()

defineEmits<{
  click: [fileName: string]
  delete: [fileName: string]
}>()
</script>
