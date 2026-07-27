<script setup lang="ts">
import { useI18n } from 'vue-i18n'

import { Button } from '@shadcn/components/ui/button'
import { Skeleton } from '@shadcn/components/ui/skeleton'

defineProps<{
  state: 'loading' | 'error'
}>()

defineEmits<{
  retry: []
}>()

const { t } = useI18n()
</script>

<template>
  <div
    v-if="state === 'loading'"
    data-testid="generation-parameter-loading"
    class="min-h-[5.25rem] space-y-3"
  >
    <div class="flex items-center justify-between gap-3">
      <Skeleton class="h-4 w-24" />
      <Skeleton class="h-4 w-10" />
    </div>
    <Skeleton class="h-9 w-full" />
    <Skeleton class="h-3 w-2/3" />
  </div>
  <div
    v-else
    data-testid="generation-parameter-error"
    class="flex min-h-[5.25rem] items-center justify-between gap-3 rounded-md border border-dashed px-3 py-2"
  >
    <p class="text-xs text-muted-foreground">
      {{ t('settings.model.capabilityLoadError') }}
    </p>
    <Button
      type="button"
      variant="outline"
      size="sm"
      class="shrink-0"
      data-testid="generation-parameter-retry"
      @click="$emit('retry')"
    >
      {{ t('common.retry') }}
    </Button>
  </div>
</template>
