<!-- eslint-disable vue/no-v-html -->
<template>
  <div ref="messageBlock" class="markdown-content-wrapper relative w-full">
    <div
      :id="id"
      class="markdown-content prose prose-sm dark:prose-invert max-w-full break-words"
      @click="handleCopyClick"
      v-html="renderedContent"
    ></div>
    <LoadingCursor v-show="block.status === 'loading'" ref="loadingCursor" />
    <ReferencePreview :show="showPreview" :content="previewContent" :rect="previewRect" />
  </div>
</template>

<script setup lang="ts">
import { computed, ref, nextTick, watch, onMounted } from 'vue'
import { useI18n } from 'vue-i18n'
import {
  createCodeBlockRenderer,
  initReference,
  renderMarkdown
  // enableDebugRendering
} from '@/lib/markdown.helper'
import { EditorView, basicSetup } from 'codemirror'
import { javascript } from '@codemirror/lang-javascript'
import { python } from '@codemirror/lang-python'
import { html } from '@codemirror/lang-html'
import { css } from '@codemirror/lang-css'
import { json } from '@codemirror/lang-json'
import { java } from '@codemirror/lang-java'
import { go } from '@codemirror/lang-go'
import { markdown } from '@codemirror/lang-markdown'
import { sql } from '@codemirror/lang-sql'
import { xml } from '@codemirror/lang-xml'
import { cpp } from '@codemirror/lang-cpp'
import { rust } from '@codemirror/lang-rust'
import { shell } from '@codemirror/legacy-modes/mode/shell'
import { swift } from '@codemirror/legacy-modes/mode/swift'
import { ruby } from '@codemirror/legacy-modes/mode/ruby'
import { perl } from '@codemirror/legacy-modes/mode/perl'
import { lua } from '@codemirror/legacy-modes/mode/lua'
import { haskell } from '@codemirror/legacy-modes/mode/haskell'
import { erlang } from '@codemirror/legacy-modes/mode/erlang'
import { clojure } from '@codemirror/legacy-modes/mode/clojure'

import { StreamLanguage } from '@codemirror/language'
import { php } from '@codemirror/lang-php'
import { yaml } from '@codemirror/lang-yaml'

import { EditorState } from '@codemirror/state'
import { v4 as uuidv4 } from 'uuid'
import { anysphereTheme } from '@/lib/code.theme'
import LoadingCursor from '@/components/LoadingCursor.vue'
import { usePresenter } from '@/composables/usePresenter'
import { SearchResult } from '@shared/presenter'
import ReferencePreview from './ReferencePreview.vue'
// import mk from '@vscode/markdown-it-katex'
// import 'katex/dist/katex.min.css'

const threadPresenter = usePresenter('threadPresenter')
const searchResults = ref<SearchResult[]>([])

const id = ref(`editor-${uuidv4()}`)

const loadingCursor = ref<InstanceType<typeof LoadingCursor> | null>(null)

const previewContent = ref<SearchResult | undefined>()
const showPreview = ref(false)
const previewRect = ref<DOMRect>()

const onReferenceClick = (id: string) => {
  const index = parseInt(id) - 1
  if (searchResults.value && searchResults.value[index]) {
    // Handle navigation or content display
    // console.log('Navigate to:', searchResults.value[index])
    window.open(searchResults.value[index].url, '_blank')
  }
}

const onReferenceHover = (id: string, isHover: boolean, rect: DOMRect) => {
  const index = parseInt(id) - 1
  // console.log(id, isHover, rect)
  if (searchResults.value && searchResults.value[index]) {
    if (isHover) {
      previewContent.value = searchResults.value[index]
      previewRect.value = rect
      showPreview.value = true
    } else {
      previewContent.value = undefined
      showPreview.value = false
    }
  }
}

// Store editor instances for cleanup
const editorInstances = ref<Map<string, EditorView>>(new Map())

const { t } = useI18n()

const messageBlock = ref<HTMLDivElement>()

const refreshLoadingCursor = () => {
  if (messageBlock.value) {
    loadingCursor.value?.updateCursorPosition(messageBlock.value)
  }
}

initReference({
  onClick: onReferenceClick,
  onHover: onReferenceHover
})
// Remove all the markdown-it configuration and setup
// Instead, just configure the code block renderer
createCodeBlockRenderer(t)
// enableDebugRendering() // Optional, remove if debug logging is not needed

// Initialize code editors
const initCodeEditors = () => {
  const codeBlocks = document.querySelectorAll(`#${id.value} .code-block`)

  codeBlocks.forEach((block) => {
    const editorId = block.getAttribute('id')
    const editorContainer = block.querySelector('.code-editor')
    const code = block.getAttribute('data-code')
    const lang = block.getAttribute('data-lang')

    if (!editorId || !editorContainer || !code || !lang) {
      return
    }

    const decodedCode = decodeURIComponent(escape(atob(code)))

    // 如果编辑器已存在，更新内容而不是重新创建
    if (editorInstances.value.has(editorId)) {
      const existingEditor = editorInstances.value.get(editorId)
      const currentContent = existingEditor?.state.doc.toString()

      // 只在内容变化时更新
      if (currentContent !== decodedCode) {
        existingEditor?.dispatch({
          changes: {
            from: 0,
            to: currentContent?.length || 0,
            insert: decodedCode
          }
        })
      }
      return
    }

    // 创建新的编辑器实例
    const extensions = [
      basicSetup,
      anysphereTheme,
      EditorView.lineWrapping,
      EditorState.tabSize.of(2)
    ]

    switch (lang.toLowerCase()) {
      case 'javascript':
      case 'js':
      case 'ts':
      case 'typescript':
        extensions.push(javascript())
        break
      case 'react':
      case 'vue':
      case 'html':
        extensions.push(html())
        break
      case 'css':
        extensions.push(css())
        break
      case 'json':
        extensions.push(json())
        break
      case 'python':
      case 'py':
        extensions.push(python())
        break
      case 'kotlin':
      case 'kt':
      case 'java':
        extensions.push(java())
        break
      case 'go':
      case 'golang':
        extensions.push(go())
        break
      case 'markdown':
      case 'md':
        extensions.push(markdown())
        break
      case 'sql':
        extensions.push(sql())
        break
      case 'xml':
        extensions.push(xml())
        break
      case 'cpp':
      case 'c++':
      case 'c':
        extensions.push(cpp())
        break
      case 'rust':
      case 'rs':
        extensions.push(rust())
        break
      case 'bash':
      case 'sh':
      case 'shell':
      case 'zsh':
        extensions.push(StreamLanguage.define(shell))
        break
      case 'php':
        extensions.push(php())
        break
      case 'yaml':
      case 'yml':
        extensions.push(yaml())
        break
      case 'swift':
        extensions.push(StreamLanguage.define(swift))
        break
      case 'ruby':
        extensions.push(StreamLanguage.define(ruby))
        break
      case 'perl':
        extensions.push(StreamLanguage.define(perl))
        break
      case 'lua':
        extensions.push(StreamLanguage.define(lua))
        break
      case 'haskell':
        extensions.push(StreamLanguage.define(haskell))
        break
      case 'erlang':
        extensions.push(StreamLanguage.define(erlang))
        break
      case 'clojure':
        extensions.push(StreamLanguage.define(clojure))
        break
    }

    try {
      const editorView = new EditorView({
        state: EditorState.create({
          doc: decodedCode,
          extensions: [...extensions, EditorState.readOnly.of(true)]
        }),
        parent: editorContainer as HTMLElement
      })
      editorInstances.value.set(editorId, editorView)
    } catch (error) {
      console.error('Failed to initialize editor:', error)
    }
  })
}

// Handle copy functionality
const handleCopyClick = async (e: MouseEvent) => {
  const target = e.target as HTMLElement
  if (target.classList.contains('copy-button')) {
    const encodedCode = target.getAttribute('data-code')
    if (encodedCode) {
      try {
        const decodedCode = decodeURIComponent(escape(atob(encodedCode)))
        await navigator.clipboard.writeText(decodedCode)
        const originalText = target.textContent
        target.textContent = t('common.copySuccess')
        setTimeout(() => {
          target.textContent = originalText
        }, 2000)
      } catch (err) {
        console.error('Failed to copy:', err)
      }
    }
  }
}

// Cleanup editors on unmount
const cleanupEditors = () => {
  editorInstances.value.forEach((editor) => {
    editor.destroy()
  })
  editorInstances.value.clear()
}

const props = defineProps<{
  block: {
    content: string
    status?: 'loading'
  }
  messageId: string
  isSearchResult?: boolean
}>()

const renderedContent = computed(() => {
  const content = props.block.content
  refreshLoadingCursor()
  return renderMarkdown(
    props.block.status === 'loading' ? content + loadingCursor.value?.CURSOR_MARKER : content
  )
})

// 添加 watch 来监听内容变化
watch(
  renderedContent,
  () => {
    nextTick(() => {
      // 清理现有的编辑器实例
      cleanupEditors()
      // 初始化新的编辑器
      initCodeEditors()
    })
  },
  { immediate: true }
)

onMounted(async () => {
  if (props.isSearchResult) {
    searchResults.value = await threadPresenter.getSearchResults(props.messageId)
  }
})
</script>

<style>
.prose {
  @apply leading-7;
  font-family:
    -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif;
  -webkit-font-smoothing: antialiased;
  -moz-osx-font-smoothing: grayscale;
}

/* 添加行内公式样式 */
.prose .math-inline {
  @apply inline-block;
  white-space: nowrap;
}

/* 确保块级公式正确显示 */
.prose .math-block {
  @apply block my-4;
}

.prose pre {
  @apply bg-transparent p-0 m-0;
}

.prose h1 {
  @apply text-xl mt-4 mb-2;
}

.prose h2 {
  @apply text-lg mt-4 mb-2;
}

.prose h3 {
  @apply text-base mt-3 mb-2;
}

.prose .code-block {
  @apply rounded-lg overflow-hidden mt-2  mb-4 text-xs;
}

.prose .code-header {
  @apply flex justify-between items-center px-4 py-2 bg-[#181818];
}

.prose .code-lang {
  @apply text-xs text-gray-400;
}

.prose .copy-button {
  @apply text-xs text-gray-400 hover:text-white;
}

.prose .code-editor {
  @apply overflow-auto;
}

.prose hr {
  @apply my-4;
}

.prose hr:last-child {
  @apply mb-4;
}

.prose hr + p {
  @apply mt-4;
}

/* MathJax 容器样式 */
.prose mjx-container:not([display='true']) {
  display: inline-block !important;
  margin: 0 !important;
  vertical-align: middle !important;
}

.prose mjx-container[display='true'] {
  @apply block my-4;
  text-align: center;
}
.prose .reference-link {
  @apply inline-block text-xs text-muted-foreground bg-muted rounded-md text-center min-w-4 py-0.5 mx-0.5 hover:bg-accent;
}
</style>
