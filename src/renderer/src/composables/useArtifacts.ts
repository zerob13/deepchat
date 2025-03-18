import { computed } from 'vue'
export interface ProcessedPart {
  type: 'text' | 'thinking' | 'artifact' | 'tool_call'
  content: string
  loading?: boolean
  artifact?: {
    identifier: string
    title: string
    type:
      | 'application/vnd.ant.code'
      | 'text/markdown'
      | 'text/html'
      | 'image/svg+xml'
      | 'application/vnd.ant.mermaid'
      | 'application/vnd.ant.react'
    language?: string
  }
  tool_call?: {
    status: 'calling' | 'response' | 'end' | 'error'
    name?: string
    error?: string
  }
}
export const useBlockContent = (props: {
  block: {
    content: string
    status?: 'loading' | 'success' | 'error'
    timestamp: number
  }
}) => {
  // 辅助函数: 从后向前找到满足条件的元素索引
  // function findLastIndex<T>(array: T[], predicate: (value: T) => boolean): number {
  //   for (let i = array.length - 1; i >= 0; i--) {
  //     if (predicate(array[i])) {
  //       return i
  //     }
  //   }
  //   return -1
  // }

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
        content: match[1].trim(),
        loading: false
      })

      // console.log(match[0], '\n\n', match[1])

      lastIndex = match.index + match[0].length
    }
    console.log(lastIndex, hasMatchedClosedThinkingTags)

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
          content: match[1].trim(),
          loading: false
        })

        lastIndex = match.index + match[0].length
      }
    }

    // 处理 antArtifact 标签
    const artifactRegex =
      /<antArtifact\s+(?=.*\btype="([^"]+)")(?=.*\bidentifier="([^"]+)")(?=.*\btitle="([^"]+)")(?:\s+language="([^"]+)")?\s*(?:[^>]*?)>([\s\S]*?)<\/antArtifact>/gs
    content = props.block.content
    lastIndex = 0 // 重置lastIndex，从头开始处理artifacts
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

      // 提取完整的标签内容用于属性匹配
      const fullTag = match[0]
      const typeMatch = fullTag.match(/type="([^"]+)"/)
      const identifierMatch = fullTag.match(/identifier="([^"]+)"/)
      const titleMatch = fullTag.match(/title="([^"]+)"/)
      const languageMatch = fullTag.match(/language="([^"]+)"/)
      // 修复内容匹配，使用非贪婪模式匹配所有内容
      const closedContentMatch = fullTag.match(/<antArtifact[^>]*>([\s\S]*?)<\/antArtifact>/s)
      // 添加 artifact 内容
      parts.push({
        type: 'artifact',
        content: closedContentMatch ? closedContentMatch[1].trim() : '',
        artifact: {
          identifier: identifierMatch ? identifierMatch[1] : '',
          type: typeMatch
            ? (typeMatch[1] as
                | 'application/vnd.ant.code'
                | 'text/markdown'
                | 'text/html'
                | 'image/svg+xml'
                | 'application/vnd.ant.react'
                | 'application/vnd.ant.mermaid')
            : 'text/markdown',
          title: titleMatch ? titleMatch[1] : '',
          language: languageMatch ? languageMatch[1] : undefined
        },
        loading: false
      })

      lastIndex = match.index + match[0].length
    }

    // 如果没有找到闭合的标签，尝试查找未闭合的 antArtifact 标签
    if (!hasMatchedClosedTags) {
      // 重置 lastIndex 以便从头开始搜索
      // 只匹配开始标签的正则表达式
      const unclosedArtifactRegex =
        /<antArtifact\s+(?=.*\btype="([^"]+)")(?=.*\bidentifier="([^"]+)")(?=.*\btitle="([^"]+)")(?:\s+language="([^"]+)")?\s*(?:[^>]*?)>([\s\S]*)/gs

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

        // 提取完整的标签内容用于属性匹配
        const fullTag = match[0]
        const typeMatch = fullTag.match(/type="([^"]+)"/)
        const identifierMatch = fullTag.match(/identifier="([^"]+)"/)
        const titleMatch = fullTag.match(/title="([^"]+)"/)
        const languageMatch = fullTag.match(/language="([^"]+)"/)
        // 提取未闭合标签后的所有内容
        const unclosedContentMatch = fullTag.match(/<antArtifact[^>]*>([\s\S]*)/s)

        // 添加未闭合标签的 artifact 内容
        parts.push({
          type: 'artifact',
          content: unclosedContentMatch ? unclosedContentMatch[1].trim() : '',
          artifact: {
            identifier: identifierMatch ? identifierMatch[1] : '',
            type: typeMatch
              ? (typeMatch[1] as
                  | 'application/vnd.ant.code'
                  | 'text/markdown'
                  | 'application/vnd.ant.react'
                  | 'text/html'
                  | 'image/svg+xml'
                  | 'application/vnd.ant.mermaid')
              : 'text/markdown',
            title: titleMatch ? titleMatch[1] : '',
            language: languageMatch ? languageMatch[1] : undefined
          },
          loading: true
        })

        lastIndex = match.index + match[0].length
      }
    }

    // 添加 artifacts 处理完毕后剩余的文本内容
    if (lastIndex < content.length) {
      const remainingText = content.substring(lastIndex)
      if (remainingText.trim()) {
        parts.push({
          type: 'text',
          content: remainingText.trim()
        })
      }
    }

    // 处理工具调用标签 - 仅处理text类型的parts
    // 辅助函数：解析标签属性
    function parseAttributes(attributesStr?: string): Record<string, string> {
      const attributes: Record<string, string> = {}
      if (!attributesStr) return attributes

      // 匹配所有name="value"形式的属性
      const attributeRegex = /(\w+)="([^"]*)"/g
      let attrMatch: RegExpExecArray | null
      while ((attrMatch = attributeRegex.exec(attributesStr)) !== null) {
        const [, name, value] = attrMatch
        attributes[name] = value
      }
      return attributes
    }

    // 仅处理 text 类型的 parts 中的工具调用标签
    const processedParts: ProcessedPart[] = []

    for (let i = 0; i < parts.length; i++) {
      const part = parts[i]

      if (part.type !== 'text') {
        // 非文本类型直接添加到结果中
        processedParts.push(part)
        continue
      }

      // 只处理文本类型部分中的工具调用标签
      const textContent = part.content

      // 用于存储当前文本部分中的工具调用标签及其位置
      const tagPositions: Array<{
        type: string
        position: number
        attributes?: Record<string, string>
      }> = []

      // 工具调用标签的正则表达式
      const toolCallRegex = /<tool_call(?:\s+([^>]*))?>/g
      const toolCallResponseRegex = /<tool_response(?:\s+([^>]*))?>/g
      const toolCallEndRegex = /<tool_call_end(?:\s+([^>]*))?>/g
      const toolCallErrorRegex = /<tool_call_error(?:\s+([^>]*))?>/g

      // 重置正则表达式的lastIndex
      toolCallRegex.lastIndex = 0
      toolCallResponseRegex.lastIndex = 0
      toolCallEndRegex.lastIndex = 0
      toolCallErrorRegex.lastIndex = 0

      let tagMatch: RegExpExecArray | null

      // 查找所有 tool_call 标签
      while ((tagMatch = toolCallRegex.exec(textContent)) !== null) {
        const attributes = parseAttributes(tagMatch[1])
        tagPositions.push({
          type: 'tool_call',
          position: tagMatch.index,
          attributes
        })
      }

      // 查找所有 tool_response 标签
      while ((tagMatch = toolCallResponseRegex.exec(textContent)) !== null) {
        const attributes = parseAttributes(tagMatch[1])
        tagPositions.push({
          type: 'tool_response',
          position: tagMatch.index,
          attributes
        })
      }

      // 查找所有 tool_call_end 标签
      while ((tagMatch = toolCallEndRegex.exec(textContent)) !== null) {
        const attributes = parseAttributes(tagMatch[1])
        tagPositions.push({
          type: 'tool_call_end',
          position: tagMatch.index,
          attributes
        })
      }

      // 查找所有 tool_call_error 标签
      while ((tagMatch = toolCallErrorRegex.exec(textContent)) !== null) {
        const attributes = parseAttributes(tagMatch[1])
        tagPositions.push({
          type: 'tool_call_error',
          position: tagMatch.index,
          attributes
        })
      }

      // 如果没有找到任何工具调用标签，直接添加原始文本
      if (tagPositions.length === 0) {
        processedParts.push(part)
        continue
      }

      // 按位置排序标签
      tagPositions.sort((a, b) => a.position - b.position)

      // 用于记录上一个处理的标签位置
      let lastProcessedTagPosition = 0
      let currentToolCallIndex = -1

      // 处理按顺序排列的标签
      for (let j = 0; j < tagPositions.length; j++) {
        const tag = tagPositions[j]

        // 只有在处理 tool_call 标签时才处理前面的文本
        if (tag.type === 'tool_call') {
          // 添加 tool_call 标签前的文本
          if (tag.position > lastProcessedTagPosition) {
            const text = textContent.substring(lastProcessedTagPosition, tag.position)
            if (text.trim()) {
              processedParts.push({
                type: 'text',
                content: text
              })
            }
          }

          // 计算标签结束位置
          const tagEndIndex = textContent.indexOf('>', tag.position) + 1

          // 获取 tool_call 标签之后的内容，直到下一个标签或文本结束
          const nextTagPosition =
            j < tagPositions.length - 1 ? tagPositions[j + 1].position : textContent.length

          const toolCallContent = textContent.substring(tagEndIndex, nextTagPosition)

          // 创建新的工具调用部分
          processedParts.push({
            type: 'tool_call',
            content: toolCallContent.trim(),
            loading: true,
            tool_call: {
              status: 'calling',
              name: tag.attributes?.name,
              error: tag.attributes?.error
            }
          })

          // 记录当前工具调用的索引
          currentToolCallIndex = processedParts.length - 1

          // 更新已处理标签位置
          lastProcessedTagPosition = nextTagPosition
        } else if (tag.type === 'tool_response') {
          // 更新最近的工具调用部分
          if (
            currentToolCallIndex !== -1 &&
            processedParts[currentToolCallIndex].type === 'tool_call'
          ) {
            // 计算标签结束位置
            const tagEndIndex = textContent.indexOf('>', tag.position) + 1

            // 获取 tool_response 标签之后的内容，直到下一个标签
            const nextTagPosition =
              j < tagPositions.length - 1 ? tagPositions[j + 1].position : textContent.length

            const responseContent = textContent.substring(tagEndIndex, nextTagPosition)

            // 更新最近的工具调用部分
            processedParts[currentToolCallIndex].content += '\n' + responseContent.trim()
            processedParts[currentToolCallIndex].tool_call!.status = 'response'

            // 如果有新的属性，保留现有属性并添加新属性
            if (tag.attributes) {
              if (tag.attributes.name) {
                processedParts[currentToolCallIndex].tool_call!.name = tag.attributes.name
              }
              if (tag.attributes.error) {
                processedParts[currentToolCallIndex].tool_call!.error = tag.attributes.error
              }
            }

            // 更新已处理标签位置
            lastProcessedTagPosition = nextTagPosition
          }
        } else if (tag.type === 'tool_call_end') {
          // 更新最近的工具调用部分为已完成状态
          if (
            currentToolCallIndex !== -1 &&
            processedParts[currentToolCallIndex].type === 'tool_call'
          ) {
            processedParts[currentToolCallIndex].loading = false
            processedParts[currentToolCallIndex].tool_call!.status = 'end'

            // 如果有新的属性，保留现有属性并添加新属性
            if (tag.attributes) {
              if (tag.attributes.name) {
                processedParts[currentToolCallIndex].tool_call!.name = tag.attributes.name
              }
              if (tag.attributes.error) {
                processedParts[currentToolCallIndex].tool_call!.error = tag.attributes.error
              }
            }
          }

          // 计算标签结束位置
          const tagEndIndex = textContent.indexOf('>', tag.position) + 1

          // 更新已处理标签位置
          lastProcessedTagPosition = tagEndIndex
        } else if (tag.type === 'tool_call_error') {
          // 更新最近的工具调用部分为错误状态
          if (
            currentToolCallIndex !== -1 &&
            processedParts[currentToolCallIndex].type === 'tool_call'
          ) {
            processedParts[currentToolCallIndex].loading = false
            processedParts[currentToolCallIndex].tool_call!.status = 'error'

            // 如果有新的属性，保留现有属性并添加新属性
            if (tag.attributes) {
              if (tag.attributes.name) {
                processedParts[currentToolCallIndex].tool_call!.name = tag.attributes.name
              }
              if (tag.attributes.error) {
                processedParts[currentToolCallIndex].tool_call!.error = tag.attributes.error
              }
            }
          }

          // 计算标签结束位置
          const tagEndIndex = textContent.indexOf('>', tag.position) + 1

          // 更新已处理标签位置
          lastProcessedTagPosition = tagEndIndex
        }
      }

      // 处理剩余的文本
      if (lastProcessedTagPosition < textContent.length) {
        const text = textContent.substring(lastProcessedTagPosition)
        if (text.trim()) {
          processedParts.push({
            type: 'text',
            content: text
          })
        }
      }
    }

    // 如果处理后的部分不为空，则使用处理后的部分
    if (processedParts.length > 0) {
      return processedParts
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

    // console.log(parts)
    return parts
  })
  return {
    processedContent
  }
}
