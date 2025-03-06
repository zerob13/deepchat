/* eslint-disable @typescript-eslint/no-explicit-any */
import MarkdownIt from 'markdown-it'
import mathjax3 from 'markdown-it-mathjax3'

// export const initReference = ({
//   onClick,
//   onHover
// }: {
//   msgId: string;
//   onClick: (id: string, rect: DOMRect) => void;
//   onHover: (id: string, isHover: boolean, rect: DOMRect) => void;
//   }) => {
//   if (!(window as any).handleReferenceClick) {
//         (window as any).handleReferenceClick = (id: string, event: MouseEvent) => {
//           const rect = (event.target as HTMLElement).getBoundingClientRect();
//           onClick(id, rect);
//         };
//   }
//   if (!(window as any).handleReferenceHover) {
//   (window as any).handleReferenceHover = (
//     id: string,
//     isHover: boolean,
//     event: MouseEvent
//   ) => {
//     const rect = (event.target as HTMLElement).getBoundingClientRect();
//       onHover(id, isHover, rect);
//     };
//   }
// };

export const getMarkdown = (msgId: string, t: (key: string) => string) => {
  // import footnote from 'markdown-it-footnote'
  // Create markdown-it instance with configuration
  const md = new MarkdownIt({
    html: true,
    linkify: true,
    typographer: true,
    breaks: false
  })

  // Custom math inline rule
  const mathInline = (state: any, silent: boolean) => {
    const delimiters: [string, string, boolean][] = [
      ['\\(', '\\)', true],
      ['\\[', '\\]', false],
      ['$$', '$$', true]
    ]

    for (const [open, close, isInline] of delimiters) {
      const start = state.pos
      if (state.src.slice(start, start + open.length) !== open) continue

      const end = state.src.indexOf(close, start + open.length)
      if (end === -1) continue

      if (!silent) {
        const token = state.push(isInline ? 'math_inline' : 'math_block', 'math', 0)
        token.content = state.src.slice(start + open.length, end)
        token.markup = isInline ? '\\(\\)' : open === '$$' ? '$$' : '\\[\\]'
      }

      state.pos = end + close.length
      return true
    }
    return false
  }

  // Register custom rules
  md.inline.ruler.before('escape', 'math', mathInline)

  // Add rendering rules
  md.renderer.rules.math_inline = (tokens, idx) => tokens[idx].content
  md.renderer.rules.math_block = (tokens, idx) => tokens[idx].content
  md.renderer.rules.code_block = (tokens, idx) => tokens[idx].content

  // Configure MathJax
  md.use(mathjax3, {
    tex: {
      inlineMath: [['\\(', '\\)']],
      displayMath: [
        ['$$', '$$'],
        ['\\[', '\\]']
      ],
      processEscapes: true,
      processEnvironments: true,
      processRefs: true,
      digits: /^(?:[0-9]+(?:\{,\}[0-9]{3})*(?:\.[0-9]*)?|\.[0-9]+)/
    }
  })

  // Disable default code highlighting
  md.options.highlight = null

  // Custom code block rendering
  md.renderer.rules.fence = (tokens, idx) => {
    const token = tokens[idx]
    const info = token.info ? token.info.trim() : ''
    const str = token.content

    const encodedCode = btoa(unescape(encodeURIComponent(str)))
    const language = info || 'text'
    const uniqueId = `editor-${Math.random().toString(36).substr(2, 9)}`

    // 为了确保代码块的本意被保留，添加一个额外的属性，方便后续处理
    const codeOriginal = btoa(unescape(encodeURIComponent(`\`\`\`${language}\n${str}\n\`\`\``)))

    return `<div class="code-block" data-code="${encodedCode}" data-lang="${language}" data-original="${codeOriginal}" id="${uniqueId}">
      <div class="code-header">
        <span class="code-lang">${language.toUpperCase()}</span>
        <button class="copy-button" data-code="${encodedCode}">${t('common.copyCode')}</button>
      </div>
      <div class="code-editor"></div>
    </div>`
  }

  // Custom reference inline rule
  const referenceInline = (state: any, silent: boolean) => {
    if (state.src[state.pos] !== '[') return false

    const match = /^\[(\d+)\]/.exec(state.src.slice(state.pos))
    if (!match) return false

    if (!silent) {
      const id = match[1]
      const token = state.push('reference', 'span', 0)
      token.content = id
      token.markup = match[0]
    }

    state.pos += match[0].length
    return true
  }

  // Add rendering rule for references
  md.renderer.rules.reference = (tokens, idx) => {
    const id = tokens[idx].content
    return `<span class="reference-link" 
    data-reference-id="${id}" 
    role="button" 
    tabindex="0"
    title="Click to view reference"
    onclick="window.dispatchEvent(new CustomEvent('reference-click',{detail:{msgId:'${msgId}',refId:'${id}', event: event}}))"
    onmouseover="window.dispatchEvent(new CustomEvent('reference-hover',{detail:{msgId:'${msgId}',refId:'${id}',isHover:true, event: event}}))"
    onmouseout="window.dispatchEvent(new CustomEvent('reference-hover',{detail:{msgId:'${msgId}',refId:'${id}',isHover:false, event: event}}))">${id}</span>`
  }

  // Register custom rule
  md.inline.ruler.before('escape', 'reference', referenceInline)

  // 创建一个新的div来渲染Mermaid图表
  const mermaidContainer = document.createElement('div')
  mermaidContainer.className = 'mermaid-container my-2'
  mermaidContainer.style.width = '100%'

  return md
}

export const getCommonMarkdown = () => {
  const md = new MarkdownIt({
    html: true,
    linkify: true,
    typographer: true,
    breaks: false
  })
  return md
}

export const renderMarkdown = (md: MarkdownIt, content: string) => md.render(content)

export const initMermaidInMarkdown = (container: HTMLElement): void => {
  if (!container) return
  
  // 查找所有mermaid代码块
  const mermaidBlocks = container.querySelectorAll('pre code.language-mermaid')
  
  if (mermaidBlocks.length === 0) return
  
  // 处理每个mermaid代码块
  mermaidBlocks.forEach(async (block) => {
    try {
      const mermaidCode = block.textContent || ''
      if (!mermaidCode.trim()) return
      
      // 创建一个新的div来渲染Mermaid图表
      const mermaidContainer = document.createElement('div')
      mermaidContainer.className = 'mermaid-container my-1'
      mermaidContainer.style.width = '100%'
      
      // 生成唯一ID
      const id = `mermaid-${Date.now()}-${Math.random().toString(36).substring(2, 9)}`
      mermaidContainer.id = id
      
      // 替换原始代码块
      const preElement = block.closest('pre')
      if (preElement && preElement.parentNode) {
        preElement.parentNode.replaceChild(mermaidContainer, preElement)
        
        // 渲染Mermaid图表
        try {
          // @ts-ignore - window.mermaid类型在全局声明中不完整
          const { svg } = await window.mermaid.render(id, mermaidCode)
          mermaidContainer.innerHTML = svg
        } catch (error: any) {
          console.error('Mermaid渲染错误:', error)
          mermaidContainer.innerHTML = `<div class="error-message p-2 bg-red-100 dark:bg-red-900 text-red-800 dark:text-red-200 rounded">Mermaid图表渲染失败: ${error.message || '未知错误'}</div>`
        }
      }
    } catch (err) {
      console.error('处理Mermaid图表时出错:', err)
    }
  })
}
