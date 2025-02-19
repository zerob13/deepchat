<template>
  <div class="flex items-center justify-between w-full p-2">
    <Popover v-model:open="modelSelectOpen">
      <PopoverTrigger as-child>
        <Button variant="outline" class="flex items-center gap-1.5 px-2" size="sm">
          <ModelIcon class="w-5 h-5" :model-id="model.id"></ModelIcon>
          <!-- <Icon icon="lucide:message-circle" class="w-5 h-5 text-muted-foreground" /> -->
          <h2 class="text-xs font-bold">{{ model.name }}</h2>
          <Badge
            v-for="tag in model.tags"
            :key="tag"
            variant="outline"
            class="py-0 rounded-lg"
            size="xs"
            >{{ t(`model.tags.${tag}`) }}</Badge
          >
          <Icon icon="lucide:chevron-right" class="w-4 h-4 text-muted-foreground" />
        </Button>
      </PopoverTrigger>
      <PopoverContent align="start" class="p-0 w-80">
        <ModelSelect @update:model="handleModelUpdate" />
      </PopoverContent>
    </Popover>

    <div class="flex items-center gap-2">
      <Popover>
        <PopoverTrigger as-child>
          <Button class="w-7 h-7 rounded-md hover:bg-accent" size="icon" variant="outline">
            <Icon icon="lucide:settings-2" class="w-4 h-4 text-muted-foreground" />
          </Button>
        </PopoverTrigger>
        <PopoverContent align="end" class="p-0 w-80">
          <ChatConfig @update:config="handleConfigUpdate" />
        </PopoverContent>
      </Popover>
    </div>
  </div>
</template>

<script setup lang="ts">
import { useI18n } from 'vue-i18n'
import { Icon } from '@iconify/vue'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import ChatConfig from './ChatConfig.vue'
import ModelSelect from './ModelSelect.vue'
import ModelIcon from './icons/ModelIcon.vue'
import { MODEL_META } from '@shared/presenter'
import { ref } from 'vue'

const { t } = useI18n()

type Model = {
  name: string
  id: string
  tags: string[]
}

withDefaults(
  defineProps<{
    model?: Model
  }>(),
  {
    model: () => ({
      name: 'DeepSeek R1',
      id: 'deepseek-r1',
      tags: ['reasoning']
    })
  }
)
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const handleConfigUpdate = (config: any) => {
  console.log('config', config)
}

const modelSelectOpen = ref(false)
const handleModelUpdate = (model: MODEL_META) => {
  console.log('model', model)
  modelSelectOpen.value = false
}
</script>

<style scoped></style>
