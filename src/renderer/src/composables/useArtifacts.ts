import { computed } from 'vue'
export interface ProcessedPart {
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
export const useBlockContent = (props: {
  block: {
    content: string
    status?: 'loading' | 'success' | 'error'
    timestamp: number
  }
}) => {
  const processedContent = computed<ProcessedPart[]>(() => {
    if (!props.block.content) return [{ type: 'text', content: '' }]
    // if (props.block.status === 'loading') {
    //   return [
    //     {
    //       type: 'text',
    //       content: props.block.content
    //     }
    //   ]
    // }
    // 调试代码：
    // 严格的Markdown代码块检测

    // 正常的内容处理逻辑（提取代码块和Mermaid图表）
    const parts: ProcessedPart[] = []
    let content = props.block.content
    let lastIndex = 0

    // 处理 antThinking 标签
    const thinkingRegex = /<antThinking>(.*?)<\/antThinking>/gs
    let match
    let hasMatchedClosedThinkingTags = false

    while ((match = thinkingRegex.exec(content)) !== null) {
      hasMatchedClosedThinkingTags = true
      // 添加思考前的普通文本
      if (match.index > lastIndex) {
        // const text = content.substring(lastIndex, match.index)
        // if (text.trim()) {
        //   parts.push({
        //     type: 'thinking',
        //     content: text
        //   })
        // }
      }

      // 添加思考内容
      parts.push({
        type: 'thinking',
        content: match[1].trim()
      })

      console.log(match[0], '\n\n', match[1])

      lastIndex = match.index + match[0].length
    }

    // 如果没有找到闭合的思考标签，尝试查找未闭合的 antThinking 标签
    if (!hasMatchedClosedThinkingTags) {
      // 重置 lastIndex 以便从头开始搜索
      lastIndex = 0
      // 只匹配开始标签的正则表达式
      const unclosedThinkingRegex = /<antThinking>([\s\S]*)/gs

      while ((match = unclosedThinkingRegex.exec(content)) !== null) {
        // 添加 thinking 前的普通文本
        if (match.index > lastIndex) {
          const text = content.substring(lastIndex, match.index)
          if (text.trim()) {
            parts.push({
              type: 'text',
              content: text
            })
          }
        }

        // 添加未闭合标签的思考内容（将剩余所有内容视为思考内容）
        parts.push({
          type: 'thinking',
          content: match[1].trim()
        })

        lastIndex = match.index + match[0].length
      }
    }

    // 处理 antArtifact 标签
    const artifactRegex =
      /<antArtifact\s+identifier="([^"]+)"\s+type="([^"]+)"\s+title="([^"]+)"(?:\s+language="([^"]+)")?\s*>([\s\S]*?)<\/antArtifact>/gs
    content = props.block.content
    let hasMatchedClosedTags = false

    while ((match = artifactRegex.exec(content)) !== null) {
      hasMatchedClosedTags = true
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

    // 如果没有找到闭合的标签，尝试查找未闭合的 antArtifact 标签
    if (!hasMatchedClosedTags) {
      // 重置 lastIndex 以便从头开始搜索
      // 只匹配开始标签的正则表达式
      const unclosedArtifactRegex =
        /<antArtifact\s+identifier="([^"]+)"\s+type="([^"]+)"\s+title="([^"]+)"(?:\s+language="([^"]+)")?\s*>([\s\S]*)/gs

      while ((match = unclosedArtifactRegex.exec(content)) !== null) {
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

        // 添加未闭合标签的 artifact 内容（将剩余所有内容视为 artifact 的内容）
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

    console.log(parts)
    return parts
  })
  return {
    processedContent
  }
}
