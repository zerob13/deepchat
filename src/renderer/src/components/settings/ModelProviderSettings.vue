<template>
  <div class="w-full h-full flex flex-row">
    <div class="w-52 border-r h-full overflow-y-auto space-y-2 p-2">
      <div
        v-for="provider in providers"
        :key="provider.name"
        :class="[
          'flex flex-row items-center hover:bg-accent gap-2 rounded-lg p-2 cursor-pointer',
          route.params?.providerId === provider.id ? 'bg-accent' : ''
        ]"
        @click="setActiveProvider(provider.id)"
      >
        <ModelIcon
          :model-id="provider.id"
          :custom-class="'w-4 h-4 text-muted-foreground'"
        ></ModelIcon>
        <span class="text-sm font-medium flex-1">{{ provider.name }}</span>
        <Switch
          :checked="provider.enable"
          @click.stop="toggleProviderStatus(provider)"
          class="h-4 w-7"
        />
      </div>
    </div>
    <ModelProviderSettingsDetail
      v-if="activeProvider"
      :key="activeProvider.id"
      :provider="activeProvider"
      class="flex-1"
    />
  </div>
</template>
<script setup lang="ts">
import { computed } from 'vue'
import { useSettingsStore } from '@/stores/settings'
import { useRoute, useRouter } from 'vue-router'
import ModelProviderSettingsDetail from './ModelProviderSettingsDetail.vue'
import ModelIcon from '@/components/icons/ModelIcon.vue'
import { Switch } from '@/components/ui/switch'

const route = useRoute()
const router = useRouter()

const settingsStore = useSettingsStore()
const { providers } = settingsStore

const setActiveProvider = (providerId: string) => {
  router.push({
    name: 'settings-provider',
    params: {
      providerId
    }
  })
}

const toggleProviderStatus = async (provider) => {
  await settingsStore.updateProviderStatus(provider.id, !provider.enable)
}

const activeProvider = computed(() => {
  return providers.find((p) => p.id === route.params.providerId)
})
</script>
