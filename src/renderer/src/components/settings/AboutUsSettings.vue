<template>
  <div class="w-full h-full">
    <div class="w-full h-full flex flex-col gap-2">
      <div class="w-full h-full flex flex-col items-center justify-center gap-2">
        <img src="@/assets/logo.png" class="w-10 h-10" />
        <div class="flex flex-col gap-2 items-center">
          <h1 class="text-2xl font-bold">{{ t('about.title') }}</h1>
          <p class="text-xs text-muted-foreground pb-4">v{{ appVersion }}</p>
          <p class="text-sm text-muted-foreground">
            {{ t('about.description') }}
          </p>
          <a
            class="text-xs text-muted-foreground hover:text-primary"
            href="https://deepchat.thinkinai.xyz/"
            >{{ t('about.website') }}</a
          >
        </div>
        <div class="text-sm text-muted-foreground p-4 rounded-lg shadow-md">
          <h2 class="text-lg font-semibold mb-2">{{ t('about.deviceInfo.title') }}</h2>
          <div class="flex h-5 items-center space-x-4">
            <div>
              <strong>{{ t('about.deviceInfo.platform') }}:</strong> {{ deviceInfo.platform }}
            </div>
            <Separator orientation="vertical" />
            <div>
              <strong>{{ t('about.deviceInfo.arch') }}:</strong> {{ deviceInfo.arch }}
            </div>
            <Separator orientation="vertical" />
            <div>
              <strong>{{ t('about.deviceInfo.cpuModel') }}:</strong> {{ deviceInfo.cpuModel }}
            </div>
            <Separator orientation="vertical" />
            <div>
              <strong>{{ t('about.deviceInfo.totalMemory') }}:</strong>
              {{ (deviceInfo.totalMemory / (1024 * 1024 * 1024)).toFixed(0) }} GB
            </div>
            <Separator orientation="vertical" />
            <div>
              <strong>{{ t('about.deviceInfo.osVersion') }}:</strong> {{ deviceInfo.osVersion }}
            </div>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { usePresenter } from '@/composables/usePresenter'
import { onMounted, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { Separator } from '@/components/ui/separator'
const { t } = useI18n()
const devicePresenter = usePresenter('devicePresenter')
const deviceInfo = ref<{
  platform: string
  arch: string
  cpuModel: string
  totalMemory: number
  osVersion: string
}>({
  platform: '',
  arch: '',
  cpuModel: '',
  totalMemory: 0,
  osVersion: ''
})
const appVersion = ref('')
onMounted(async () => {
  deviceInfo.value = await devicePresenter.getDeviceInfo()
  appVersion.value = await devicePresenter.getAppVersion()
  console.log(deviceInfo.value)
})
</script>
