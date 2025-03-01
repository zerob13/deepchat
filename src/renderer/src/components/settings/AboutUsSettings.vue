<template>
  <div class="w-full h-full">
    <div class="w-full h-full flex flex-col gap-2">
      <div class="w-full h-full flex flex-col items-center justify-center gap-2">
        <img src="@/assets/logo.png" class="w-10 h-10" />
        <div class="flex flex-col gap-2 items-center">
          <h1 class="text-2xl font-bold">{{ t('about.title') }}</h1>
          <p class="text-sm text-muted-foreground">
            {{ t('about.description') }}
          </p>
          <a
            class="text-xs text-muted-foreground hover:text-primary"
            href="https://deepchat.thinkinai.xyz/"
            >{{ t('about.website') }}</a
          >
        </div>

        <!-- 免责声明按钮 -->
        <Button variant="outline" size="sm" class="mb-2 text-xs" @click="openDisclaimerDialog">
          <Icon icon="lucide:info" class="mr-1 h-3 w-3" />
          {{ t('about.disclaimerButton') }}
        </Button>

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
          </div>
        </div>
      </div>
    </div>
  </div>

  <!-- 免责声明对话框 -->
  <Dialog :open="isDisclaimerOpen" @update:open="isDisclaimerOpen = $event">
    <DialogContent>
      <DialogHeader>
        <DialogTitle>{{ t('about.disclaimerTitle') }}</DialogTitle>
        <DialogDescription>
          <div
            class="max-h-[300px] overflow-y-auto"
            v-html="renderMarkdown(t('searchDisclaimer'))"
          ></div>
        </DialogDescription>
      </DialogHeader>
      <DialogFooter>
        <Button @click="isDisclaimerOpen = false">{{ t('common.close') }}</Button>
      </DialogFooter>
    </DialogContent>
  </Dialog>
</template>

<script setup lang="ts">
import { usePresenter } from '@/composables/usePresenter'
import { onMounted, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { Separator } from '@/components/ui/separator'
import { Button } from '@/components/ui/button'
import { Icon } from '@iconify/vue'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from '@/components/ui/dialog'
import { renderMarkdown } from '@/lib/markdown.helper'

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

// 免责声明对话框状态
const isDisclaimerOpen = ref(false)

// 打开免责声明对话框
const openDisclaimerDialog = () => {
  isDisclaimerOpen.value = true
}

onMounted(async () => {
  deviceInfo.value = await devicePresenter.getDeviceInfo()
  console.log(deviceInfo.value)
})
</script>
