<!-- eslint-disable vue/no-v-html -->
<template>
  <div
    class="text-xs text-muted-foreground bg-muted rounded-lg border flex flex-col gap-2 px-2 py-2"
  >
    <div class="flex flex-row gap-2 items-center cursor-pointer" @click="collapse = !collapse">
      <Button variant="ghost" size="icon" class="w-4 h-4 text-muted-foreground">
        <Icon icon="lucide:chevrons-up-down" class="w-4 h-4" />
      </Button>
      <span class="flex-grow">{{ t('chat.features.artifactThinking') }}</span>
    </div>
    <div v-show="!collapse" ref="messageBlock" class="w-full relative">
      <div
        class="prose prose-sm dark:prose-invert w-full max-w-full leading-7"
        v-html="renderedContent"
      ></div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { useI18n } from 'vue-i18n'
import { Icon } from '@iconify/vue'
import { Button } from '@/components/ui/button'
import { computed, onMounted, ref, watch } from 'vue'
import { usePresenter } from '@/composables/usePresenter'
import MarkdownIt from 'markdown-it'

const { t } = useI18n()
const configPresenter = usePresenter('configPresenter')
const messageBlock = ref<HTMLDivElement | null>(null)
const collapse = ref(false)

const props = defineProps<{
  block: {
    content: string
  }
}>()

const md = new MarkdownIt({
  html: true,
  linkify: true,
  typographer: true,
  breaks: true
})

const renderedContent = computed(() => {
  return md.render(props.block.content)
})

watch(
  () => collapse.value,
  () => {
    configPresenter.setSetting('artifact_think_collapse', collapse.value)
  }
)

onMounted(async () => {
  collapse.value = Boolean(await configPresenter.getSetting('artifact_think_collapse'))
})
</script>
