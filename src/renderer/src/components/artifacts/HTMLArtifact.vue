<template>
  <div class="html-artifact">
    <iframe
      ref="iframeRef"
      :srcdoc="sanitizedContent"
      class="w-full h-full min-h-[400px]"
      sandbox="allow-scripts allow-same-origin"
    ></iframe>
  </div>
</template>

<script setup lang="ts">
import { computed, ref, onMounted } from 'vue'
import { AssistantMessageBlock } from '@shared/chat'
import DOMPurify from 'dompurify'

const props = defineProps<{
  block: AssistantMessageBlock
}>()

const iframeRef = ref<HTMLIFrameElement>()

const sanitizedContent = computed(() => {
  if (!props.block.content) return ''
  return DOMPurify.sanitize(props.block.content, {
    ADD_TAGS: ['script'],
    ADD_ATTR: ['src'],
    ALLOWED_URI_REGEXP:
      /^(?:(?:(?:f|ht)tps?|mailto|tel|callto|cid|xmpp|xxx):|[^a-z]|[a-z+.]+(?:[^a-z+.:]|$))/i
  })
})

onMounted(() => {
  if (iframeRef.value) {
    const iframe = iframeRef.value
    iframe.onload = () => {
      // 调整 iframe 高度以适应内容
      const height = iframe.contentWindow?.document.documentElement.scrollHeight
      if (height) {
        iframe.style.height = `${height}px`
      }
    }
  }
})
</script>

<style>
.html-artifact {
  width: 100%;
  overflow: hidden;
  border-radius: 8px;
}
</style>
