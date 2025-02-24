import MarkdownIt from 'markdown-it'
import mathjax3 from 'markdown-it-mathjax3'

// Create markdown-it instance with configuration
const md = new MarkdownIt({
  html: true,
  linkify: true,
  typographer: true,
  breaks: false
})

// Custom math inline rule
// eslint-disable-next-line @typescript-eslint/no-explicit-any
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

// Custom paragraph rendering rules
md.renderer.rules.paragraph_open = () => ''
md.renderer.rules.paragraph_close = () => ''

// Custom code block rendering
export const createCodeBlockRenderer = (t: (key: string) => string) => {
  md.renderer.rules.fence = (tokens, idx) => {
    const token = tokens[idx]
    const info = token.info ? token.info.trim() : ''
    const str = token.content

    const encodedCode = btoa(unescape(encodeURIComponent(str)))
    const language = info || 'text'
    const uniqueId = `editor-${Math.random().toString(36).substr(2, 9)}`

    return `<div class="code-block" data-code="${encodedCode}" data-lang="${language}" id="${uniqueId}">
      <div class="code-header">
        <span class="code-lang">${language.toUpperCase()}</span>
        <button class="copy-button" data-code="${encodedCode}">${t('common.copyCode')}</button>
      </div>
      <div class="code-editor"></div>
    </div>`
  }
}

// Debug rendering if needed
export const enableDebugRendering = () => {
  const originalRender = md.render
  md.render = function (src) {
    console.log('=== Start Markdown Rendering ===')
    console.log('Raw input:', src)
    console.log('Input with escaped chars shown:', src.replace(/\\/g, '\\\\'))

    const result = originalRender.call(this, src)

    console.log('Final HTML output:', result)
    console.log('=== End Markdown Rendering ===')
    return result
  }
}

export const renderMarkdown = (content: string) => md.render(content)
