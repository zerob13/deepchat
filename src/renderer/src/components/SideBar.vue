<template>
  <div class="flex p-2 flex-col items-center border-r bg-background">
    <!-- Navigation Items -->
    <nav class="flex flex-1 flex-col gap-2">
      <!-- Chat Section -->
      <Button
        variant="ghost"
        size="icon"
        class="rounded-lg w-9 h-9"
        :class="{ 'bg-accent': modelValue === 'chat' }"
        @click="$emit('update:modelValue', 'chat')"
      >
        <Icon
          icon="lucide:message-circle"
          :class="['h-5 w-5', modelValue === 'chat' ? ' text-primary' : 'text-muted-foreground']"
        />
        <span class="sr-only">Chat</span>
      </Button>

      <!-- Settings Section -->

      <Button
        variant="ghost"
        size="icon"
        class="rounded-lg w-9 h-9"
        :class="{ 'bg-accent': modelValue === 'settings' }"
        @click="$emit('update:modelValue', 'settings')"
      >
        <Icon
          icon="lucide:bolt"
          :class="[
            'h-5 w-5',
            modelValue === 'settings' ? ' text-primary' : 'text-muted-foreground'
          ]"
        />
        <span class="sr-only">Settings</span>
      </Button>
      <!-- Debug Section -->
      <!-- <Button
        variant="ghost"
        size="icon"
        class="rounded-lg w-9 h-9"
        :class="{ 'bg-accent': modelValue === 'debug' }"
        @click="$emit('update:modelValue', 'debug')"
      >
        <Icon
          icon="lucide:bug"
          :class="['h-5 w-5', modelValue === 'debug' ? ' text-primary' : 'text-muted-foreground']"
        />
        <span class="sr-only">Debug</span>
      </Button> -->
    </nav>
    <!-- User Profile Section -->
    <div class="mt-auto pb-4 relative flex flex-col items-center">
      <Button variant="ghost" size="icon" class="w-9 h-9 rounded-lg" @click="toggleDark()">
        <Icon :icon="isDark ? 'lucide:sun' : 'lucide:moon'" class="w-4 h-4" />
      </Button>
      <Button variant="ghost" size="icon" class="rounded-lg w-9 h-9" @click="handleProfileClick">
        <Icon icon="lucide:user" class="h-5 w-5" />
        <span
          v-if="settings.hasUpdate"
          class="absolute top-0 right-0 w-2 h-2 bg-red-500 rounded-full animate-pulse"
        ></span>
        <span class="sr-only">User Profile</span>
      </Button>
    </div>
    <Dialog :open="showUpdateDialog" @update:open="showUpdateDialog = $event">
      <DialogContent>
        <DialogHeader>
          <DialogTitle>发现新版本</DialogTitle>
          <DialogDescription>
            <div class="space-y-2">
              <p>版本: {{ settings.updateInfo?.version }}</p>
              <p>发布日期: {{ settings.updateInfo?.releaseDate }}</p>
              <!-- <div v-if="settings.updateInfo?.releaseNotes" class="mt-2">
                <p class="font-medium">更新内容:</p>
                <p class="whitespace-pre-line">{{ settings.updateInfo?.releaseNotes }}</p>
              </div> -->
            </div>
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button variant="outline" @click="showUpdateDialog = false">稍后再说</Button>
          <Button @click="handleUpdate" :disabled="isUpdating">
            <Icon
              v-if="isUpdating"
              icon="lucide:loader-circle
            "
              class="mr-2 h-4 w-4 animate-spin"
            />
            {{ isUpdating ? '更新中...' : '立即更新' }}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  </div>
</template>

<script setup lang="ts">
import { Icon } from '@iconify/vue'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from '@/components/ui/dialog'
import { useSettingsStore } from '@/stores/settings'
import { ref, onMounted } from 'vue'
import { useDark, useToggle } from '@vueuse/core'

defineProps<{
  modelValue: string
}>()

defineEmits<{
  'update:modelValue': [value: string]
}>()

const settings = useSettingsStore()
const showUpdateDialog = ref(false)
const isUpdating = ref(false)

const isDark = useDark()
const toggleDark = useToggle(isDark)

const handleProfileClick = async () => {
  if (!settings.hasUpdate) {
    await settings.checkUpdate()
  } else {
    showUpdateDialog.value = true
  }
}

const handleUpdate = async () => {
  isUpdating.value = true
  try {
    const success = await settings.startUpdate()
    if (success) {
      showUpdateDialog.value = false
    }
  } catch (error) {
    console.error('Update failed:', error)
  } finally {
    isUpdating.value = false
  }
}

onMounted(() => {
  settings.checkUpdate()
})
</script>
