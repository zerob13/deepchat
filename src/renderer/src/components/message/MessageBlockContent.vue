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
      <div v-else-if="part.type === 'artifact' && part.artifact" class="my-1">
        <ArtifactPreview
          :block="{
            content: part.content,
            artifact: part.artifact
          }"
          :message-id="messageId"
          :thread-id="threadId"
        />
      </div>
    </template>
    <LoadingCursor v-show="block.status === 'loading'" ref="loadingCursor" />
    <ReferencePreview :show="showPreview" :content="previewContent" :rect="previewRect" />
  </div>
</template>

<script setup lang="ts">
import { computed, ref, nextTick, watch, onMounted, createApp } from 'vue'
import { useI18n } from 'vue-i18n'
import { getMarkdown, renderMarkdown } from '@/lib/markdown.helper'
import { v4 as uuidv4 } from 'uuid'
import mermaid from 'mermaid'

import { usePresenter } from '@/composables/usePresenter'
import { SearchResult } from '@shared/presenter'
import ReferencePreview from './ReferencePreview.vue'
import LoadingCursor from '@/components/LoadingCursor.vue'

const threadPresenter = usePresenter('threadPresenter')
const searchResults = ref<SearchResult[]>([])

import ArtifactThinking from '../artifacts/ArtifactThinking.vue'
import ArtifactPreview from '../artifacts/ArtifactPreview.vue'

const props = defineProps<{
  block: {
    content: string
    status?: 'loading' | 'success' | 'error'
    timestamp: number
  }
  messageId: string
  threadId: string
  isSearchResult?: boolean
}>()

const id = ref(`editor-${uuidv4()}`)

const loadingCursor = ref<InstanceType<typeof LoadingCursor> | null>(null)
const messageBlock = ref<HTMLDivElement>()

const previewContent = ref<SearchResult | undefined>()
const showPreview = ref(false)
const previewRect = ref<DOMRect>()

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
    return [{ type: 'text', content: props.block.content }]
  }
  // 调试代码：
  //console.log(props.block.content)
  // 严格的Markdown代码块检测
  const isMarkdownCodeBlock = (content: string): boolean => {
    // 必须以```markdown或```md开头，并以```结尾
    return /^\s*```(markdown|md)\s*\n[\s\S]*?```\s*$/i.test(content.trim())
  }
  
  // 严格的Mermaid图表检测
  const isMermaidDiagram = (content: string): boolean => {
    // 必须以```mermaid开头，并以```结尾，且不是嵌套在Markdown中的
    const isMermaidBlock = /^\s*```mermaid\s*\n[\s\S]*?```\s*$/i.test(content.trim())
    // 检查是否嵌套在Markdown中
    const isNestedInMarkdown = /^\s*```(markdown|md)\s*\n[\s\S]*?```mermaid[\s\S]*?```[\s\S]*?```\s*$/i.test(content.trim())
    
    // 只有独立的Mermaid块才返回true，嵌套在Markdown中的返回false
    return isMermaidBlock && !isNestedInMarkdown
  }
  
  // 检查是否是完整的Markdown文档（包含嵌套的代码块）
  const isCompleteMarkdownWithNestedBlocks = (content: string): boolean => {
    const trimmedContent = content.trim()
    
    // 检查是否以```markdown或```md开头
    if (!/^\s*```(markdown|md)\s*\n/i.test(trimmedContent)) {
      return false
    }
    
    // 使用栈来匹配代码块，支持流式处理
    const stack: string[] = []
    const lines = trimmedContent.split('\n')
    let inMarkdown = false
    let isComplete = false
    
    for (const line of lines) {
      const trimmedLine = line.trim()
      
      // 检查行是否包含代码块标记
      if (trimmedLine.startsWith('```')) {
        // 获取语言标识符（如果有）
        const lang = trimmedLine.slice(3).trim().toLowerCase()
        
        if (!inMarkdown) {
          // 第一个代码块必须是markdown或md
          if (lang !== 'markdown' && lang !== 'md') {
            return false
          }
          inMarkdown = true
          stack.push('markdown')
        } else if (trimmedLine === '```') {
          // 结束当前代码块
          if (stack.length > 0) {
            const lastLang = stack.pop()
            // 如果弹出的是最外层的markdown，说明文档结束了
            if (lastLang === 'markdown' && stack.length === 0) {
              isComplete = true
              break
            }
          }
        } else {
          // 开始新的嵌套代码块
          stack.push(lang)
        }
      }
    }
    
    // 如果内容还在流式传输中，我们允许未完成的状态
    // 只有当遇到最外层markdown的结束标记时，才要求所有块都正确闭合
    return isComplete || (inMarkdown && stack.length > 0 && stack[0] === 'markdown')
  }
  
  // 修改processedContent的处理逻辑，支持流式处理
  if (isCompleteMarkdownWithNestedBlocks(props.block.content)) {
    const markdownContent = props.block.content.trim()
    let content = markdownContent
    
    // 如果文档已经完整（以最后的```结尾），则移除首尾的markdown标记
    if (/```\s*$/i.test(markdownContent)) {
      content = markdownContent
        .replace(/^\s*```(markdown|md)\s*\n/i, '')
        .replace(/```\s*$/i, '')
        .trim()
    } else {
      // 如果文档还在流式传输中，只移除开头的markdown标记
      content = markdownContent
        .replace(/^\s*```(markdown|md)\s*\n/i, '')
        .trim()
    }
    
    return [{
      type: 'artifact',
      content: content,
      artifact: {
        identifier: `markdown-nested-${props.messageId}`,
        type: 'text/markdown',
        title: '包含图表的Markdown文档',
        language: 'markdown'
      }
    }]
  }
  
  // 处理普通的Markdown代码块（不包含嵌套代码块）
  if (isMarkdownCodeBlock(props.block.content) && !isCompleteMarkdownWithNestedBlocks(props.block.content)) {
    const markdownContent = props.block.content.trim()
      .replace(/^\s*```(markdown|md)\s*\n/i, '')
      .replace(/```\s*$/i, '')
      .trim()
    
    return [{
      type: 'artifact',
      content: markdownContent,
      artifact: {
        identifier: `markdown-${props.messageId}`,
        type: 'text/markdown',
        title: 'Markdown 文档',
        language: 'markdown'
      }
    }]
  }
  
  // 处理独立的Mermaid图表
  if (isMermaidDiagram(props.block.content)) {
    const mermaidContent = props.block.content.trim()
      .replace(/^\s*```mermaid\s*\n/i, '')
      .replace(/```\s*$/i, '')
      .trim()
    
    return [{
      type: 'artifact',
      content: mermaidContent,
      artifact: {
        identifier: `mermaid-${props.messageId}`,
        type: 'application/vnd.ant.mermaid',
        title: 'Mermaid 图表',
        language: 'mermaid'
      }
    }]
  }
  
  // 正常的内容处理逻辑（提取代码块和Mermaid图表）
  const parts: ProcessedPart[] = []
  let content = props.block.content
  let lastIndex = 0
  let mermaidIndex = 0
  let codeIndex = 0

  // 先处理 Mermaid 代码块
  const mermaidRegex = /```mermaid\n([\s\S]*?)```/g
  let match

  while ((match = mermaidRegex.exec(content)) !== null) {
    // 添加 Mermaid 前的普通文本
    if (match.index > lastIndex) {
      const text = content.substring(lastIndex, match.index)
      if (text.trim()) {
        parts.push({
          type: 'text',
          content: text
        })
      }
    }

    // 添加 Mermaid 图表作为 artifact
    const diagramTitle = `Mermaid Diagram ${mermaidIndex + 1}`
    parts.push({
      type: 'artifact',
      content: match[1].trim(),
      artifact: {
        identifier: `mermaid-${props.messageId}-${mermaidIndex}`,
        type: 'application/vnd.ant.mermaid',
        title: diagramTitle,
        language: 'mermaid'
      }
    })

    lastIndex = match.index + match[0].length
    mermaidIndex++
  }

  // 处理剩余内容中的普通代码块
  content = content.substring(lastIndex)
  lastIndex = 0

  // 处理普通代码块
  const codeRegex = /```(\w+)?\n([\s\S]*?)```/g
  while ((match = codeRegex.exec(content)) !== null) {
    // 添加代码块前的普通文本
    if (match.index > lastIndex) {
      const text = content.substring(lastIndex, match.index)
      if (text.trim()) {
        parts.push({
          type: 'text',
          content: text
        })
      }
    }

    // 添加代码块作为 artifact
    const language = match[1] || 'text'
    const codeContent = match[2].trim()
    
    // 根据语言类型设置不同的artifact类型和标题
    let artifactType: 'application/vnd.ant.code' | 'text/markdown' | 'text/html' | 'image/svg+xml' | 'application/vnd.ant.mermaid' = 'application/vnd.ant.code'
    let title = `代码块 ${codeIndex + 1}`
    
    // 根据语言设置不同的类型
    if (language.toLowerCase() === 'markdown' || language.toLowerCase() === 'md') {
      artifactType = 'text/markdown'
      title = 'Markdown 文档'
    } else if (language.toLowerCase() === 'csv') {
      title = 'CSV 数据表格'
    } else if (language.toLowerCase() === 'python' || language.toLowerCase() === 'py') {
      title = 'Python 代码'
    } else if (language.toLowerCase() === 'html') {
      artifactType = 'text/html'
      title = 'HTML 文档'
    } else if (language.toLowerCase() === 'svg') {
      artifactType = 'image/svg+xml'
      title = 'SVG 图像'
    } else if (language.toLowerCase() === 'mermaid') {
      artifactType = 'application/vnd.ant.mermaid'
      title = 'Mermaid 图表'
    } else {
      // 对于其他语言，使用语言名称作为标题前缀
      const langCapitalized = language.charAt(0).toUpperCase() + language.slice(1).toLowerCase()
      title = `${langCapitalized} 代码`
    }
    
    parts.push({
      type: 'artifact',
      content: codeContent,
      artifact: {
        identifier: `code-${props.messageId}-${codeIndex}`,
        type: artifactType,
        title: title,
        language: language
      }
    })

    lastIndex = match.index + match[0].length
    codeIndex++
  }

  content = content.substring(lastIndex)
  lastIndex = 0

  // 处理 antThinking 标签
  const thinkingRegex = /<antThinking>(.*?)<\/antThinking>/gs
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
  content = content.substring(lastIndex)
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

const renderContent = (content: string) => {
  refreshLoadingCursor()
  
  // 完全移除旧的isCompleteMarkdown函数，替换为严格版本
  const isMarkdownDocument = (content: string): boolean => {
    // 检查是否以```markdown或```md开头
    const startsWithMarkdown = /^\s*```(markdown|md)\s*\n/i.test(content.trim())
    // 检查是否以```结尾，但要确保这是最后一个```
    const endsWithBackticks = content.trim().endsWith('```')
    // 计算```的数量，确保它们是成对的
    const backtickMatches = content.match(/```/g)
    const hasEvenBackticks = backtickMatches ? backtickMatches.length % 2 === 0 : false
    
    return startsWithMarkdown && endsWithBackticks && hasEvenBackticks
  }
  
  // 提取 Markdown 内容的函数
  const extractMarkdownContent = (content: string): string => {
    // 移除开头的 ```markdown 或 ```md
    let extracted = content.trim().replace(/^\s*```(markdown|md)\s*\n/i, '')
    // 移除最后的 ```
    extracted = extracted.replace(/```\s*$/i, '')
    return extracted.trim()
  }
  
  // 替换原来的判断条件
  if (isMarkdownDocument(content)) {
    nextTick(() => {
      if (messageBlock.value) {
        // 查找包含markdown内容的div
        const markdownDiv = messageBlock.value.querySelector(`#${id.value}`)
        if (markdownDiv && markdownDiv.parentNode) {
          // 创建一个artifact容器
          const artifactContainer = document.createElement('div')
          artifactContainer.className = 'my-1'
          
          // 创建点击处理器
          artifactContainer.onclick = () => {
            import('@/stores/artifact').then(module => {
              const artifactStore = module.useArtifactStore()
              if (artifactStore.isOpen) {
                artifactStore.hideArtifact()
              } else {
                // 使用提取的 Markdown 内容
                const markdownContent = extractMarkdownContent(content)
                artifactStore.showArtifact({
                  type: 'text/markdown',
                  title: '完整Markdown文档',
                  content: markdownContent
                }, props.messageId, props.threadId)
              }
            })
          }
          
          // 创建预览界面
          const previewUI = document.createElement('div')
          previewUI.className = 'flex items-center gap-2 p-2 rounded-lg border bg-card text-card-foreground hover:bg-accent/50 cursor-pointer'
          
          // 图标
          const iconContainer = document.createElement('div')
          iconContainer.className = 'flex-shrink-0'
          const icon = document.createElement('span')
          icon.className = 'w-6 h-6 text-muted-foreground'
          icon.innerHTML = '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14.5 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7.5L14.5 2z"></path><polyline points="14 2 14 8 20 8"></polyline></svg>'
          iconContainer.appendChild(icon)
          previewUI.appendChild(iconContainer)
          
          // 标题和提示
          const textContainer = document.createElement('div')
          textContainer.className = 'flex-grow'
          const heading = document.createElement('h3')
          heading.className = 'text-base font-medium leading-none tracking-tight'
          
          // 尝试从Markdown提取标题
          const titleMatch = extractMarkdownContent(content).match(/^#\s+(.+)$/m)
          heading.textContent = titleMatch ? titleMatch[1] : '完整Markdown文档'
          
          const hint = document.createElement('p')
          hint.className = 'text-sm text-muted-foreground mt-0.5'
          hint.textContent = '点击查看完整内容'
          textContainer.appendChild(heading)
          textContainer.appendChild(hint)
          previewUI.appendChild(textContainer)
          
          artifactContainer.appendChild(previewUI)
          
          // 替换原始的markdown内容
          markdownDiv.innerHTML = ''
          markdownDiv.appendChild(artifactContainer)
          return
        }
      }
    })
  }
  
  // 处理常规内容或代码块
  const rendered = renderMarkdown(
    md,
    props.block.status === 'loading' ? content + loadingCursor.value?.CURSOR_MARKER : content
  )
  
  // 处理代码块
  nextTick(() => {
    // 在DOM渲染完成后，处理代码块
    if (messageBlock.value) {
      const codeBlocks = messageBlock.value.querySelectorAll('.code-block')
      codeBlocks.forEach((block) => {
        const language = (block.getAttribute('data-lang') || '').toLowerCase()
        const codeData = block.getAttribute('data-code')
        
        // 定义不需要特殊处理的语言或类型
        const excludedTypes = [
          'output',    // 输出结果
          'text',      // 纯文本
          'plaintext', // 纯文本
          'log',       // 日志
          'console',   // 控制台输出
          ''          // 空语言类型
        ]
        
        // 处理所有非排除类型的代码块
        if (codeData && !excludedTypes.includes(language)) {
          try {
            // 解码代码内容
            const codeContent = decodeURIComponent(escape(atob(codeData)))
            
            // 创建artifact对象
            let artifactType: 'application/vnd.ant.code' | 'text/markdown' | 'text/html' | 'image/svg+xml' | 'application/vnd.ant.mermaid' = 'application/vnd.ant.code'
            
            // 根据特定语言设置不同的类型
            if (language === 'markdown' || language === 'md') {
              artifactType = 'text/markdown'
            } else if (language === 'html' || language === 'htm') {
              artifactType = 'text/html'
            } else if (language === 'svg') {
              artifactType = 'image/svg+xml'
            } else if (language === 'mermaid') {
              artifactType = 'application/vnd.ant.mermaid'
            }
            
            // 创建 Vue 组件
            const app = createApp(ArtifactPreview, {
              block: {
                content: codeContent,
                artifact: {
                  type: artifactType,
                  title: '', // 让组件自己处理标题
                  language: language
                }
              },
              messageId: props.messageId,
              threadId: props.threadId
            })
            
            // 创建容器
            const container = document.createElement('div')
            container.className = 'my-1'
            
            // 替换原代码块
            if (block.parentNode) {
              block.parentNode.replaceChild(container, block)
              app.mount(container)
            }
          } catch (err) {
            console.error('处理代码块时出错:', err)
          }
        }
      })
    }
  })
  
  return rendered
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

// 修改 watch 函数
watch(
  processedContent,
  () => {
    nextTick(() => {
      refreshLoadingCursor()
    })
  },
  { immediate: true }
)

onMounted(async () => {
  if (props.isSearchResult) {
    searchResults.value = await threadPresenter.getSearchResults(props.messageId)
  }
})

// 初始化 mermaid
mermaid.initialize({
  startOnLoad: false,
  theme: 'dark',
  securityLevel: 'loose'
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
  @apply rounded-lg overflow-hidden mt-2 mb-4 text-xs;
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
