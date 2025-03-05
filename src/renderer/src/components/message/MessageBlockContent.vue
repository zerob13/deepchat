<!-- eslint-disable @typescript-eslint/no-explicit-any -->
<!-- eslint-disable vue/no-v-html -->
<template>
  <div ref="messageBlock" class="markdown-content-wrapper relative w-full">
    <template v-for="(part, index) in processedContent" :key="index">
      <div
        v-if="part.type === 'text'"
        :id="id"
        class="markdown-content prose prose-sm dark:prose-invert max-w-full break-words"
        @click="handleCopyClick"
        @contextmenu="handleContextMenu"
        v-html="renderContent(part.content)"
      ></div>
      <ArtifactThinking
        v-else-if="part.type === 'thinking'"
        :block="{
          content: part.content
        }"
      />
      <ArtifactBlock
        class="max-h-[500px] overflow-auto"
        v-else-if="part.type === 'artifact' && part.artifact"
        :block="{
          content: part.content,
          artifact: part.artifact
        }"
      />
    </template>
    <LoadingCursor v-show="block.status === 'loading'" ref="loadingCursor" />
    <ReferencePreview :show="showPreview" :content="previewContent" :rect="previewRect" />
  </div>
</template>

<script setup lang="ts">
import { computed, ref, nextTick, watch, onMounted } from 'vue'
import { useI18n } from 'vue-i18n'
import { getMarkdown, renderMarkdown } from '@/lib/markdown.helper'
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
import mermaid from 'mermaid'

import { usePresenter } from '@/composables/usePresenter'
import { SearchResult } from '@shared/presenter'
import ReferencePreview from './ReferencePreview.vue'

const threadPresenter = usePresenter('threadPresenter')
const searchResults = ref<SearchResult[]>([])

import ArtifactThinking from '../artifacts/ArtifactThinking.vue'
import ArtifactBlock from '../artifacts/ArtifactBlock.vue'

const props = defineProps<{
  block: {
    content: string
    status?: 'loading' | 'success' | 'error'
    timestamp: number
  }
  messageId: string
  isSearchResult?: boolean
}>()

const id = ref(`editor-${uuidv4()}`)

const loadingCursor = ref<InstanceType<typeof LoadingCursor> | null>(null)
const messageBlock = ref<HTMLDivElement>()

const previewContent = ref<SearchResult | undefined>()
const showPreview = ref(false)
const previewRect = ref<DOMRect>()

// Store editor instances for cleanup
const editorInstances = ref<Map<string, EditorView>>(new Map())

const { t } = useI18n()

interface ProcessedPart {
  type: 'text' | 'thinking' | 'artifact'
  content: string
  artifact?: {
    identifier: string
    title: string
    type:
      | 'application/vnd.ant.code'
      | 'text/markdown'
      | 'text/html'
      | 'image/svg+xml'
      | 'application/vnd.ant.mermaid'
    language?: string
  }
}

const refreshLoadingCursor = () => {
  if (messageBlock.value) {
    loadingCursor.value?.updateCursorPosition(messageBlock.value)
  }
}

const md = getMarkdown(id.value, t)

// eslint-disable-next-line @typescript-eslint/no-explicit-any
;(window as any).addEventListener('reference-click', (e: CustomEvent) => {
  const { msgId, refId } = e.detail
  if (msgId !== id.value) {
    return
  }
  const index = parseInt(refId) - 1
  if (searchResults.value && searchResults.value[index]) {
    // Handle navigation or content display
    // console.log('Navigate to:', searchResults.value[index])
    window.open(searchResults.value[index].url, '_blank')
  }
})

// eslint-disable-next-line @typescript-eslint/no-explicit-any
;(window as any).addEventListener('reference-hover', (e: CustomEvent) => {
  const { msgId, refId, isHover, event } = e.detail
  const rect = (event.target as HTMLElement).getBoundingClientRect()
  if (msgId !== id.value) {
    if (!isHover) {
      previewContent.value = undefined
      showPreview.value = false
    }
    return
  }
  const index = parseInt(refId) - 1
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
})

// Remove all the markdown-it configuration and setup
// Instead, just configure the code block renderer
// createCodeBlockRenderer(t)
// enableDebugRendering() // Optional, remove if debug logging is not needed

const processedContent = computed<ProcessedPart[]>(() => {
  if (!props.block.content) return [{ type: 'text', content: '' }]
  if (props.block.status === 'loading') {
    return [
      {
        type: 'text',
        content: props.block.content
      }
    ]
  }

  const parts: ProcessedPart[] = []
  let content = props.block.content
  let lastIndex = 0

  // 处理 antThinking 标签
  const thinkingRegex = /<antThinking>(.*?)<\/antThinking>/gs
  let match
  while ((match = thinkingRegex.exec(content)) !== null) {
    // 添加思考前的普通文本
    if (match.index > lastIndex) {
      const text = content.substring(lastIndex, match.index)
      if (text.trim()) {
        parts.push({
          type: 'text',
          content: text
        })
      }
    }

    // 添加思考内容
    parts.push({
      type: 'thinking',
      content: match[1].trim()
    })

    lastIndex = match.index + match[0].length
  }

  // 处理 antArtifact 标签
  const artifactRegex =
    /<antArtifact\s+identifier="([^"]+)"\s+type="([^"]+)"\s+title="([^"]+)"(?:\s+language="([^"]+)")?\s*>([\s\S]*?)<\/antArtifact>/gs
  content = props.block.content
  lastIndex = 0

  while ((match = artifactRegex.exec(content)) !== null) {
    // 添加 artifact 前的普通文本
    if (match.index > lastIndex) {
      const text = content.substring(lastIndex, match.index)
      if (text.trim()) {
        parts.push({
          type: 'text',
          content: text
        })
      }
    }

    // 添加 artifact 内容
    parts.push({
      type: 'artifact',
      content: match[5].trim(),
      artifact: {
        identifier: match[1],
        type: match[2] as
          | 'application/vnd.ant.code'
          | 'text/markdown'
          | 'text/html'
          | 'image/svg+xml'
          | 'application/vnd.ant.mermaid',
        title: match[3],
        language: match[4]
      }
    })

    lastIndex = match.index + match[0].length
  }

  // 添加剩余的普通文本
  if (lastIndex < content.length) {
    const text = content.substring(lastIndex)
    if (text.trim()) {
      parts.push({
        type: 'text',
        content: text
      })
    }
  }

  // 如果没有任何特殊标签，返回原始内容
  if (parts.length === 0) {
    return [
      {
        type: 'text',
        content: content
      }
    ]
  }

  return parts
})

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

    // 如果是 mermaid 代码块，渲染图表
    if (lang.toLowerCase() === 'mermaid' && props.block.status !== 'loading') {
      renderMermaidDiagram(editorContainer as HTMLElement, decodedCode, editorId)
      return
    }

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
      case 'mermaid':
        // 使用简单的文本编辑器，不使用 StreamLanguage
        extensions.push(markdown())
        break
    }

    try {
      if (editorContainer instanceof HTMLElement) {
        try {
          const editorView = new EditorView({
            state: EditorState.create({
              doc: decodedCode,
              extensions: [
                ...extensions,
                EditorState.readOnly.of(true)
                // Remove the inline theme configuration
              ]
            }),
            parent: editorContainer
          })
          editorInstances.value.set(editorId, editorView)
        } catch (innerError) {
          console.error('Failed with standard method, trying fallback:', innerError)
          // Fallback if CodeMirror fails - create a basic pre element with escaped HTML
          const escapedCode = decodedCode
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#039;')
          editorContainer.innerHTML = `<pre style="white-space: pre-wrap; color: #ffffff; margin: 0;">${escapedCode}</pre>`
        }
      } else {
        console.error('Editor container is not a valid HTMLElement')
      }
    } catch (error) {
      console.error('Failed to initialize editor:', error)
    }
  })
}

// 渲染 Mermaid 图表
const renderMermaidDiagram = async (container: HTMLElement, code: string, id: string) => {
  try {
    // 创建一个包含编辑器和图表的容器，使用 Tailwind 类
    container.innerHTML = `
      <div class="relative w-full">
        <!-- 视图切换按钮 -->
        <div class="absolute top-2 left-2 z-10">
          <div class="flex items-center gap-1 bg-muted/80 backdrop-blur rounded-lg p-0.5">
            <button 
              id="preview-btn-${id}" 
              class="px-2 py-1 text-xs rounded bg-background text-foreground transition-colors flex items-center gap-1"
              data-id="${id}"
            >
              <svg class="h-3 w-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <path d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
                <path d="M2.458 12C3.732 7.943 7.523 5 12 5c4.478 0 8.268 2.943 9.542 7-1.274 4.057-5.064 7-9.542 7-4.477 0-8.268-2.943-9.542-7z" />
              </svg>
              Preview
            </button>
            <button 
              id="code-btn-${id}" 
              class="px-2 py-1 text-xs rounded text-muted-foreground hover:text-foreground transition-colors flex items-center gap-1"
              data-id="${id}"
            >
              <svg class="h-3 w-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <path d="M16 18l6-6-6-6M8 6l-6 6 6 6" />
              </svg>
              Code
            </button>
          </div>
        </div>

        <!-- 内容区域 -->
        <div class="rounded-lg overflow-hidden">
          <!-- 代码视图 -->
          <div id="code-view-${id}" class="hidden bg-[#1e1e1e] p-4 rounded text-white font-mono text-xs leading-relaxed whitespace-pre-wrap overflow-y-auto max-h-[500px]">
            <pre>${code}</pre>
          </div>
          <!-- 预览视图 -->
          <div id="preview-view-${id}" class="bg-white rounded p-4 flex justify-center items-center min-h-[200px] max-h-[500px] overflow-auto">
            <div id="mermaid-${id}" class="mermaid w-full text-center">${code}</div>
          </div>
        </div>

        <!-- 导出按钮组 -->
        <div class="mt-2 flex justify-end gap-2">
          <button class="save-svg-btn px-2 py-1 bg-emerald-600 hover:bg-emerald-700 text-white text-xs rounded border-none cursor-pointer transition-colors flex items-center gap-1" data-id="${id}">
            <svg class="h-3 w-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4M7 10l5 5 5-5M12 15V3" />
            </svg>
            Export SVG
          </button>
          <button class="save-code-btn px-2 py-1 bg-amber-500 hover:bg-amber-600 text-white text-xs rounded border-none cursor-pointer transition-colors flex items-center gap-1" data-id="${id}">
            <svg class="h-3 w-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <path d="M19 21H5a2 2 0 01-2-2V5a2 2 0 012-2h11l5 5v11a2 2 0 01-2 2z" />
              <polyline points="17 21 17 13 7 13 7 21" />
              <polyline points="7 3 7 8 15 8" />
            </svg>
            Save Code
          </button>
        </div>
      </div>
    `

    // 初始化 mermaid
    mermaid.initialize({
      startOnLoad: false,
      theme: 'dark',
      securityLevel: 'loose',
      fontFamily: 'monospace',
      logLevel: 3,
      darkMode: true
    })

    // 渲染图表
    const mermaidElement = document.getElementById(`mermaid-${id}`)
    if (mermaidElement) {
      mermaid
        .run({
          nodes: [mermaidElement]
        })
        .catch((e) => {
          console.info('Failed to render mermaid diagram:', e)
        })
    }

    // 添加视图切换事件监听器
    const previewBtn = container.querySelector(`#preview-btn-${id}`)
    const codeBtn = container.querySelector(`#code-btn-${id}`)
    const previewView = container.querySelector(`#preview-view-${id}`)
    const codeView = container.querySelector(`#code-view-${id}`)

    if (previewBtn && codeBtn && previewView && codeView) {
      previewBtn.addEventListener('click', () => {
        previewView.classList.remove('hidden')
        codeView.classList.add('hidden')
        previewBtn.classList.add('bg-background', 'text-foreground')
        previewBtn.classList.remove('text-muted-foreground')
        codeBtn.classList.remove('bg-background', 'text-foreground')
        codeBtn.classList.add('text-muted-foreground')
      })

      codeBtn.addEventListener('click', () => {
        previewView.classList.add('hidden')
        codeView.classList.remove('hidden')
        codeBtn.classList.add('bg-background', 'text-foreground')
        codeBtn.classList.remove('text-muted-foreground')
        previewBtn.classList.remove('bg-background', 'text-foreground')
        previewBtn.classList.add('text-muted-foreground')
      })
    }

    // 添加导出按钮事件监听器
    const saveSvgBtn = container.querySelector('.save-svg-btn')
    const saveCodeBtn = container.querySelector('.save-code-btn')

    if (saveSvgBtn) {
      saveSvgBtn.addEventListener('click', () => saveMermaidAsSVG(id))
    }

    if (saveCodeBtn) {
      saveCodeBtn.addEventListener('click', () => {
        try {
          const blob = new Blob([code], { type: 'text/plain;charset=utf-8' })
          const url = URL.createObjectURL(blob)
          const downloadLink = document.createElement('a')
          downloadLink.href = url
          downloadLink.download = `diagram-${Date.now()}.mmd`
          document.body.appendChild(downloadLink)
          downloadLink.click()
          document.body.removeChild(downloadLink)
          URL.revokeObjectURL(url)
        } catch (error) {
          console.error('Failed to save code:', error)
        }
      })
    }
  } catch (error: unknown) {
    console.error('Failed to render mermaid diagram:', error)
    const errorMessage = error instanceof Error ? error.message : '未知错误'
    container.innerHTML = `<div class="text-red-500 p-2 bg-red-100 rounded">Failed to render diagram: ${errorMessage}</div>`
  }
}

// 保存 Mermaid 图表为 SVG
const saveMermaidAsSVG = (id: string) => {
  try {
    const svgElement = document.querySelector(`#mermaid-${id} svg`)
    if (!svgElement) {
      console.error('SVG element not found')
      return
    }

    // 获取 SVG 内容
    const svgData = new XMLSerializer().serializeToString(svgElement)
    const svgBlob = new Blob([svgData], { type: 'image/svg+xml;charset=utf-8' })
    const svgUrl = URL.createObjectURL(svgBlob)

    // 创建下载链接
    const downloadLink = document.createElement('a')
    downloadLink.href = svgUrl
    downloadLink.download = `diagram-${Date.now()}.svg`
    document.body.appendChild(downloadLink)
    downloadLink.click()
    document.body.removeChild(downloadLink)
    URL.revokeObjectURL(svgUrl)
  } catch (error) {
    console.error('Failed to save SVG:', error)
  }
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

const renderContent = (content: string) => {
  refreshLoadingCursor()

  const rawContent = renderMarkdown(
    md,
    props.block.status === 'loading' ? content + loadingCursor.value?.CURSOR_MARKER : content
  )
  // Note: Content is not sanitized to allow proper code rendering
  // Be careful with user-generated content as this could pose XSS risks
  // const safeContent = DOMPurify.sanitize(rawContent, {
  //   WHOLE_DOCUMENT: false,
  //   FORBID_TAGS: ['script', 'style', 'code'],
  //   ALLOWED_URI_REGEXP:
  //     /^(?:(?:(?:f|ht)tps?|mailto|tel|callto|cid|xmpp|xxx):|[^a-z]|[a-z+.]+(?:[^a-z+.:]|$))/i
  // })
  return rawContent
}

// 右键菜单事件处理
const handleContextMenu = (event) => {
  // 检查目标元素是否是可编辑元素或其中的一部分
  const target = event.target as HTMLElement
  const isEditable =
    target.isContentEditable ||
    target.tagName === 'INPUT' ||
    target.tagName === 'TEXTAREA' ||
    !!target.closest('input, textarea, [contenteditable="true"]')

  // 只有在非可编辑元素上且没有选中文本时才自动选择
  if (!isEditable && window.getSelection()?.toString().trim().length === 0) {
    // 获取事件目标元素
    const targetForSelection = event.currentTarget

    // 创建范围选择整个元素内容
    const range = document.createRange()
    range.selectNodeContents(targetForSelection)

    // 应用选择
    const selection = window.getSelection()
    selection?.removeAllRanges()
    selection?.addRange(range)
  }
}

// 添加 watch 来监听内容变化
watch(
  processedContent,
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
  min-height: 10px;
  background-color: #1e1e1e;
  color: #ffffff;
  padding: 8px;
  border-radius: 0 0 0.5rem 0.5rem;
}

/* Mermaid SVG 样式 */
.mermaid svg {
  @apply max-w-full h-auto;
}

.prose .code-editor .cm-editor {
  background-color: #1e1e1e;
}

.prose .code-editor .cm-content {
  color: #ffffff !important;
}

.prose .code-editor .cm-line {
  padding: 0 8px;
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
