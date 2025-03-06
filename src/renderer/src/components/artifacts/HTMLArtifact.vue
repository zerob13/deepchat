<template>
  <div class="html-artifact">
    <div v-if="props.isPreview">
      <iframe
        ref="iframeRef"
        :srcdoc="sanitizedContent"
        class="w-full h-full min-h-[400px]"
        sandbox="allow-scripts allow-same-origin"
      ></iframe>
    </div>
    <div v-else class="h-full p-4">
      <pre class="rounded-lg bg-muted p-4 h-full"><code>{{ props.block.content }}</code></pre>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, ref, onMounted } from 'vue'
import DOMPurify from 'dompurify'

const props = defineProps<{
  block: {
    artifact: {
      type: string
      title: string
    }
    content: string
  }
  isPreview: boolean
}>()

const iframeRef = ref<HTMLIFrameElement>()

const sanitizedContent = computed(() => {
  if (!props.block.content) return ''
  return DOMPurify.sanitize(props.block.content, {
    WHOLE_DOCUMENT: true,
    ADD_TAGS: ['script', 'style'],
    ADD_ATTR: ['src', 'style', 'onclick'],
    ALLOWED_URI_REGEXP:
      /^(?:(?:(?:f|ht)tps?|mailto|tel|callto|cid|xmpp|xxx):|[^a-z]|[a-z+.]+(?:[^a-z+.:]|$))/i
  })
})

onMounted(() => {
  if (props.isPreview && iframeRef.value) {
    const iframe = iframeRef.value
    iframe.onload = () => {
      // 调整 iframe 高度以适应内容
      const height = iframe.contentWindow?.document.documentElement.scrollHeight
      if (height) {
        iframe.style.height = `${height}px`
      }
      const resetCSS = `
      * {
        margin: 0;
        padding: 0;
        box-sizing: border-box;
      }
      html, body {
        height: 100%;
        font-family: Arial, sans-serif;
      }
      img {
        max-width: 100%;
        height: auto;
      }
      a {
        text-decoration: none;
        color: inherit;
      }
    `
      const styleElement = document.createElement('style')
      styleElement.textContent = resetCSS
      iframeRef.value?.contentDocument?.head.appendChild(styleElement)
    }
  }
})
</script>

<style scoped>
.html-artifact {
  width: 100%;
  height: 100%;
  display: flex;
  flex-direction: column;
}

pre {
  margin: 0;
  overflow: auto;
  height: 100%;
}

code {
  font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace;
  font-size: 0.875rem;
  line-height: 1.5;
  height: 100%;
  display: block;
}
</style>
