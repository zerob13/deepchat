<template>
  <div>
    <div
      class="flex items-center gap-2 p-2 rounded-lg border bg-card text-card-foreground hover:bg-accent/50 cursor-pointer"
      @click="handleClick"
    >
      <div class="flex-shrink-0">
        <Icon :icon="getArtifactIcon(block.artifact?.type)" class="w-6 h-6 text-muted-foreground" />
      </div>
      <div class="flex-grow">
        <h3 class="text-base font-medium leading-none tracking-tight">
          {{ displayTitle }}
        </h3>
        <p class="text-sm text-muted-foreground mt-0.5">{{ t('artifacts.clickToOpen') }}</p>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { Icon } from '@iconify/vue'
import { useArtifactStore } from '@/stores/artifact'
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'

const { t } = useI18n()
const artifactStore = useArtifactStore()

const props = defineProps<{
  block: {
    artifact: {
      type: string
      title: string
    }
    content: string
  }
  messageId: string
  threadId: string
}>()

const displayTitle = computed(() => {
  const { type, title } = props.block.artifact
  const content = props.block.content

  // 如果已有有意义的标题，且不是自动生成的标题
  if (title && 
      !title.startsWith('artifact_') && 
      !title.match(/^[0-9a-f-]+$/) &&
      !title.match(/^(Mermaid Diagram|Code Block)\s+\d+$/)) {
    return title
  }

  // 根据不同类型生成标题
  switch (type) {
    case 'application/vnd.ant.code': {
      let codeTitle = t('artifacts.codeSnippet')
      const lines = content.split('\n')
      
      // 尝试从注释中提取标题
      for (const line of lines.slice(0, 5)) { // 检查前5行
        const trimmedLine = line.trim()
        // 匹配各种注释格式
        if (trimmedLine.startsWith('//') || trimmedLine.startsWith('#') || 
            trimmedLine.startsWith('/*') || trimmedLine.startsWith('"""') || 
            trimmedLine.startsWith("'''")) {
          const commentContent = trimmedLine.replace(/^[/#*\s"']+/, '').trim()
          if (commentContent && commentContent.length > 1) {
            codeTitle = commentContent
            break
          }
        }
      }

      if (codeTitle === t('artifacts.codeSnippet')) {
        // 尝试识别函数定义
        const functionMatch = content.match(/(?:function|def|func)\s+([a-zA-Z_]\w*)\s*\([^)]*\)/);
        if (functionMatch) {
          const funcName = functionMatch[1]
          // 尝试从函数名生成更有意义的标题
          codeTitle = funcName.replace(/[A-Z]/g, ' $&').trim() // 驼峰转空格
            .toLowerCase()
            .replace(/(?:^|\s)\S/g, c => c.toUpperCase()) // 首字母大写
            .replace(/_/g, ' ') // 下划线转空格
          codeTitle += t('artifacts.function')
          return codeTitle
        }

        // 尝试识别类定义
        const classMatch = content.match(/(?:class)\s+([a-zA-Z_]\w*)/);
        if (classMatch) {
          const className = classMatch[1]
          codeTitle = className.replace(/[A-Z]/g, ' $&').trim()
            .toLowerCase()
            .replace(/(?:^|\s)\S/g, c => c.toUpperCase())
            .replace(/_/g, ' ')
          codeTitle += t('artifacts.class')
          return codeTitle
        }

        // 尝试识别主要的代码特征
        if (content.includes('export default')) {
          codeTitle = t('artifacts.vueComponent')
        } else if (content.includes('import') && content.includes('from')) {
          codeTitle = t('artifacts.moduleImport')
        } else if (content.includes('const') || content.includes('let') || content.includes('var')) {
          const varMatch = content.match(/(?:const|let|var)\s+([a-zA-Z_]\w*)\s*=/);
          if (varMatch) {
            codeTitle = t('artifacts.variableDefinition', { name: varMatch[1] })
          }
        }
      }
      
      return codeTitle
    }
    case 'text/markdown': {
      // 尝试从 Markdown 内容中提取第一个标题
      const headingMatch = content.match(/^#\s+(.+)$/m)
      return headingMatch ? headingMatch[1] : t('artifacts.markdownDocument')
    }
    case 'text/html': {
      // 尝试从 HTML 中提取 title 或第一个标题
      const htmlTitleMatch = content.match(/<title>(.+?)<\/title>/i) || 
                            content.match(/<h[1-6][^>]*>(.+?)<\/h[1-6]>/i)
      return htmlTitleMatch ? htmlTitleMatch[1] : t('artifacts.htmlDocument')
    }
    case 'image/svg+xml':
      return t('artifacts.svgImage')
    case 'application/vnd.ant.mermaid': {
      const lines = content.trim().split('\n')
      const firstLine = lines[0].toLowerCase()
      let chartType = ''
      let chartTitle = ''

      // 确定图表类型
      if (firstLine.includes('flowchart') || firstLine.includes('graph')) {
        chartType = t('artifacts.flowchart')
      } else if (firstLine.includes('sequencediagram')) {
        chartType = t('artifacts.sequenceDiagram')
      } else if (firstLine.includes('classdiagram')) {
        chartType = t('artifacts.classDiagram')
      } else if (firstLine.includes('statediagram')) {
        chartType = t('artifacts.stateDiagram')
      } else if (firstLine.includes('erdiagram')) {
        chartType = t('artifacts.erDiagram')
      } else if (firstLine.includes('gantt')) {
        chartType = t('artifacts.ganttChart')
      } else if (firstLine.includes('pie')) {
        chartType = t('artifacts.pieChart')
      } else {
        return t('artifacts.mermaidDiagram')
      }

      // 尝试从内容中提取更多信息
      switch (chartType) {
        case t('artifacts.flowchart'): {
          // 尝试找到第一个节点的文本作为主题
          const nodeMatch = content.match(/[A-Za-z0-9]+\["([^"]+)"\]/);
          if (nodeMatch) {
            chartTitle = t('artifacts.flowchartOf', { name: nodeMatch[1] })
          }
          break
        }
        case t('artifacts.sequenceDiagram'): {
          // 尝试找到参与者
          const participants = lines
            .filter(line => line.toLowerCase().includes('participant') || line.match(/^[^->\s]+/))
            .slice(0, 2)
            .map(line => {
              const match = line.match(/participant\s+([^->\s]+)|^([^->\s]+)/i)
              return match ? (match[1] || match[2]) : null
            })
            .filter(Boolean)
          if (participants.length > 0) {
            chartTitle = t('artifacts.sequenceDiagramBetween', { participants: participants.join(t('artifacts.and')) })
          }
          break
        }
        case t('artifacts.classDiagram'): {
          // 尝试找到主要的类名
          const classMatch = content.match(/class\s+([^\s{]+)/);
          if (classMatch) {
            chartTitle = t('artifacts.classDiagramOf', { name: classMatch[1] })
          }
          break
        }
        case t('artifacts.stateDiagram'): {
          // 尝试找到初始状态
          const stateMatch = content.match(/[*]?\s*-->\s*([^[\]:\n]+)/);
          if (stateMatch) {
            chartTitle = t('artifacts.stateDiagramOf', { name: stateMatch[1].trim() })
          }
          break
        }
        case t('artifacts.erDiagram'): {
          // 尝试找到主要的实体
          const entityMatch = content.match(/([^\s|{}]+)\s*{/);
          if (entityMatch) {
            chartTitle = t('artifacts.erDiagramOf', { name: entityMatch[1] })
          }
          break
        }
        case t('artifacts.ganttChart'): {
          // 尝试找到项目标题
          const titleMatch = content.match(/title\s+([^\n]+)/i);
          if (titleMatch) {
            chartTitle = titleMatch[1].trim()
          }
          break
        }
        case t('artifacts.pieChart'): {
          // 尝试找到标题或第一个数据项
          const pieTitle = content.match(/title\s+([^\n]+)|"([^"]+)"/i);
          if (pieTitle) {
            chartTitle = t('artifacts.pieChartOf', { name: pieTitle[1] || pieTitle[2] })
          }
          break
        }
      }

      return chartTitle || chartType
    }
    default:
      return title || t('artifacts.unknownDocument')
  }
})

const handleClick = () => {
  if (artifactStore.isOpen && 
      artifactStore.currentArtifact?.type === props.block.artifact.type &&
      artifactStore.currentArtifact?.title === displayTitle.value &&
      artifactStore.currentArtifact?.content === props.block.content) {
    artifactStore.hideArtifact()
  } else {
    artifactStore.showArtifact({
      type: props.block.artifact.type,
      title: displayTitle.value,
      content: props.block.content
    }, props.messageId, props.threadId)
  }
}

const getArtifactIcon = (type: string | undefined) => {
  if (!type) return 'lucide:file'
  switch (type) {
    case 'application/vnd.ant.code':
      return 'lucide:code'
    case 'text/markdown':
      return 'lucide:file-text'
    case 'text/html':
      return 'lucide:file-code'
    case 'image/svg+xml':
      return 'lucide:image'
    case 'application/vnd.ant.mermaid':
      return 'lucide:git-branch'
    default:
      return 'lucide:file'
  }
}
</script> 
