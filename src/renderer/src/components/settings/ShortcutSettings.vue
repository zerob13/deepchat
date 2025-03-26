<template>
  <ScrollArea class="w-full h-full p-2">
    <div class="w-full h-full flex flex-col gap-1.5">
      <div class="flex flex-row p-2 items-center gap-2 px-2">
        <span class="flex flex-row items-center gap-2 flex-grow w-full">
          <Icon icon="lucide:keyboard" class="w-4 h-4 text-muted-foreground" />
          <span class="text-sm font-medium">{{ t('settings.shortcut.title') }}</span>
        </span>
      </div>
      <!-- 快捷键列表 -->
      <div class="flex flex-col gap-2">
        <div
          v-for="shortcut in shortcuts"
          :key="shortcut.id"
          class="flex flex-row p-2 items-center gap-2 px-2"
        >
          <span class="flex flex-row items-center gap-2 flex-grow w-full">
            <Icon :icon="shortcut.icon" class="w-4 h-4 text-muted-foreground" />
            <span class="text-sm font-medium">{{ t(shortcut.label) }}</span>
          </span>
          <div class="flex-shrink-0 min-w-32">
            <Button
              variant="outline"
              class="w-full justify-between"
              @click="startRecording(shortcut.id)"
              @keydown.stop="handleKeyDown"
            >
              <span class="text-sm">{{
                isRecording && recordingId === shortcut.id
                  ? t('settings.shortcut.recording')
                  : formatShortcut(shortcut.key)
              }}</span>
            </Button>
          </div>
        </div>
      </div>
    </div>
  </ScrollArea>
</template>

<script setup lang="ts">
import { ref, onMounted, onUnmounted } from 'vue'
import { useI18n } from 'vue-i18n'
import { Icon } from '@iconify/vue'
import { Button } from '@/components/ui/button'
import { ScrollArea } from '@/components/ui/scroll-area'
import { useSettingsStore } from '@/stores/settings'

const { t } = useI18n()
const settingsStore = useSettingsStore()

const shortcuts = ref([
  {
    id: 'new_chat',
    icon: 'lucide:plus',
    label: 'settings.shortcut.newChat',
    key: 'CommandOrControl+N'
  }
])

const isRecording = ref(false)
const recordingId = ref('')

const startRecording = (id: string) => {
  isRecording.value = true
  recordingId.value = id
}

const handleKeyDown = (event: KeyboardEvent) => {
  if (!isRecording.value) return

  event.preventDefault()
  event.stopPropagation()

  const modifiers = []
  if (event.metaKey) modifiers.push('Command')
  if (event.ctrlKey) modifiers.push('Control')
  if (event.altKey) modifiers.push('Alt')
  if (event.shiftKey) modifiers.push('Shift')

  const key = event.key.toUpperCase()
  if (key !== 'META' && key !== 'CONTROL' && key !== 'ALT' && key !== 'SHIFT') {
    const shortcutKey = [...modifiers, key].join('+')
    const shortcut = shortcuts.value.find((s) => s.id === recordingId.value)
    if (shortcut) {
      shortcut.key = shortcutKey
      settingsStore.updateShortcut(shortcut.id, shortcutKey)
    }
    isRecording.value = false
    recordingId.value = ''
  }
}

const formatShortcut = (shortcut: string) => {
  return shortcut
    .replace('CommandOrControl', /Mac|iPod|iPhone|iPad/.test(window.navigator.platform) ? '⌘' : 'Ctrl')
    .replace('Command', '⌘')
    .replace('Control', 'Ctrl')
    .replace('Alt', '⌥')
    .replace('Shift', '⇧')
    .replace(/\+/g, ' + ')
}

onMounted(() => {
  document.addEventListener('keydown', handleKeyDown)
})

onUnmounted(() => {
  document.removeEventListener('keydown', handleKeyDown)
})
</script>