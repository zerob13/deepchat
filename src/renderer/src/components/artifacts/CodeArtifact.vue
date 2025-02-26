<template>
  <div class="relative">
    <div class="absolute right-2 top-2 flex items-center gap-2">
      <div class="text-xs text-muted-foreground">{{ block.artifact?.language }}</div>
    </div>
    <pre><code :class="codeClass">{{ block.content }}</code></pre>
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted } from 'vue'

const props = defineProps<{
  block: {
    artifact: {
      language: string
    }
    content: string
  }
}>()

const codeClass = computed(() => {
  if (!props.block.artifact?.language) return ''
  return `language-${props.block.artifact.language}`
})

// 在组件挂载后高亮代码
onMounted(() => {
  if (props.block.content) {
    // hljs.highlightAll()
  }
})
</script>
