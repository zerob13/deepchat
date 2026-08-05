<template>
  <section class="flex flex-col gap-1" data-testid="cli-launcher-settings">
    <div class="flex min-h-10 items-center gap-3">
      <div class="flex min-w-0 grow items-center gap-2">
        <Icon icon="lucide:terminal" class="h-4 w-4 shrink-0 text-muted-foreground" />
        <div class="min-w-0">
          <div class="flex items-center gap-2 text-sm font-medium">
            <span>DeepChat CLI</span>
            <span
              class="text-xs font-normal text-muted-foreground"
              data-testid="cli-launcher-status"
              :title="status?.reason ?? undefined"
            >
              {{ statusLabel }}
            </span>
          </div>
          <code
            v-if="status?.commandPath"
            class="block max-w-[34rem] truncate text-xs text-muted-foreground"
            :title="status.commandPath"
          >
            {{ status.commandPath }}
          </code>
        </div>
      </div>

      <Button
        v-if="canRepair"
        type="button"
        variant="ghost"
        size="sm"
        :disabled="busy"
        data-testid="cli-launcher-repair"
        @click="updateInstalled(true)"
      >
        <Icon icon="lucide:refresh-cw" class="mr-1 h-3.5 w-3.5" />
        {{ t('common.retry') }}
      </Button>
      <Switch
        id="cli-launcher-switch"
        :model-value="status?.owned ?? false"
        :disabled="!canToggle"
        aria-label="DeepChat CLI"
        data-testid="cli-launcher-switch"
        @update:model-value="updateInstalled"
      />
    </div>

    <p v-if="actionFailed" class="text-xs text-destructive" role="alert">
      {{ t('common.notifications.actionFailed') }}
    </p>
  </section>
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { Icon } from '@iconify/vue'
import { Button } from '@shadcn/components/ui/button'
import { Switch } from '@shadcn/components/ui/switch'
import type { CliLauncherStatus } from '@shared/contracts/routes'
import { createCliClient } from '@api/CliClient'

const { t } = useI18n()
const cliClient = createCliClient()
const status = ref<CliLauncherStatus | null>(null)
const busy = ref(true)
const actionFailed = ref(false)
let active = true

const statusLabel = computed(() => {
  if (!status.value) {
    return actionFailed.value ? t('common.error.operationFailed') : t('common.loading')
  }
  if (status.value.state === 'installed') return t('common.enabled')
  if (status.value.state === 'conflict') return t('common.error.operationFailed')
  if (status.value.state === 'not-installed' || !status.value.owned) {
    return t('common.disabled')
  }
  if (status.value.state === 'stale' || status.value.state === 'needs-repair') {
    return t('common.retry')
  }
  return t('common.error.operationFailed')
})

const canRepair = computed(
  () =>
    Boolean(status.value?.owned) &&
    (status.value?.state === 'stale' || status.value?.state === 'needs-repair') &&
    status.value?.reason !== 'path-unavailable'
)

const canToggle = computed(() => {
  if (busy.value || !status.value || status.value.state === 'conflict') return false
  return status.value.owned || status.value.state === 'not-installed'
})

async function loadStatus(): Promise<void> {
  busy.value = true
  actionFailed.value = false
  try {
    const nextStatus = await cliClient.getLauncherStatus()
    if (active) status.value = nextStatus
  } catch {
    if (active) actionFailed.value = true
  } finally {
    if (active) busy.value = false
  }
}

async function updateInstalled(installed: boolean): Promise<void> {
  if (busy.value) return
  busy.value = true
  actionFailed.value = false
  try {
    const nextStatus = await cliClient.setLauncherInstalled(installed)
    if (active) status.value = nextStatus
  } catch {
    if (!active) return
    try {
      const currentStatus = await cliClient.getLauncherStatus()
      if (active) {
        status.value = currentStatus
        actionFailed.value = installed ? currentStatus.state !== 'installed' : currentStatus.owned
      }
    } catch {
      if (active) actionFailed.value = true
    }
  } finally {
    if (active) busy.value = false
  }
}

onMounted(() => void loadStatus())
onBeforeUnmount(() => {
  active = false
})
</script>
