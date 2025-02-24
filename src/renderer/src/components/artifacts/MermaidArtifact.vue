<template>
  <div class="mermaid-artifact">
    <div ref="mermaidRef" class="mermaid">{{ block.content }}</div>
  </div>
</template>

<script setup lang="ts">
import { ref, onMounted } from 'vue'
import { AssistantMessageBlock } from '@shared/chat'
import mermaid from 'mermaid'

const props = defineProps<{
  block: AssistantMessageBlock
}>()

const mermaidRef = ref<HTMLElement>()

onMounted(async () => {
  if (mermaidRef.value && props.block.content) {
    try {
      await mermaid.init()
      await mermaid.run({
        nodes: [mermaidRef.value]
      })
    } catch (error) {
      console.error('Failed to render mermaid diagram:', error)
    }
  }
})
</script>

<style>
.mermaid-artifact {
  width: 100%;
  display: flex;
  justify-content: center;
  align-items: center;
  padding: 1rem;
}

.mermaid {
  width: 100%;
  text-align: center;
}

.mermaid svg {
  max-width: 100%;
  height: auto;
}
</style>
