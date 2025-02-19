<script setup lang="ts">
import { onMounted, ref, watch } from 'vue'
import { RouterView, useRoute, useRouter } from 'vue-router'
import AppBar from './components/AppBar.vue'
import SideBar from './components/SideBar.vue'
import { useSettingsStore } from './stores/settings'
import { usePresenter } from './composables/usePresenter'
const route = useRoute()
const configPresenter = usePresenter('configPresenter')

const router = useRouter()
const activeTab = ref('chat')
const settingsStore = useSettingsStore()
console.info(settingsStore.providers)

const getInitComplete = async () => {
  const initComplete = await configPresenter.getSetting('init_complete')
  if (!initComplete) {
    router.push({ name: 'welcome' })
  }
}

getInitComplete()

onMounted(() => {
  watch(
    () => activeTab.value,
    (newVal) => {
      router.push({ name: newVal })
    }
  )

  watch(
    () => route.fullPath,
    (newVal) => {
      const pathWithoutQuery = newVal.split('?')[0]
      const newTab =
        pathWithoutQuery === '/'
          ? (route.name as string)
          : pathWithoutQuery.split('/').filter(Boolean)[0] || ''
      if (newTab !== activeTab.value) {
        activeTab.value = newTab
      }
    }
  )
})
</script>

<template>
  <div class="flex flex-col h-screen">
    <AppBar />
    <div class="flex flex-row h-0 flex-grow">
      <!-- 侧边导航栏 -->
      <SideBar v-show="route.name !== 'welcome'" v-model:model-value="activeTab" class="h-full" />

      <!-- 主内容区域 -->
      <div class="flex-1 w-0 h-full">
        <RouterView />
      </div>
    </div>
  </div>
</template>

<style></style>
