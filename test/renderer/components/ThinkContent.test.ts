import { flushPromises, mount } from '@vue/test-utils'
import { defineComponent, h } from 'vue'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const { ensureMarkdownWorkersMock, setCustomComponentsMock } = vi.hoisted(() => ({
  ensureMarkdownWorkersMock: vi.fn().mockResolvedValue(undefined),
  setCustomComponentsMock: vi.fn()
}))

vi.mock('@/lib/markdownWorkerLifecycle', () => ({
  ensureMarkdownWorkers: ensureMarkdownWorkersMock
}))

vi.mock('@/stores/theme', () => ({
  useThemeStore: () => ({
    isDark: false
  })
}))

vi.mock('@iconify/vue', () => ({
  Icon: defineComponent({
    name: 'Icon',
    props: {
      icon: {
        type: String,
        required: true
      }
    },
    setup(props) {
      return () => h('span', { 'data-icon': props.icon })
    }
  })
}))

vi.mock('markstream-vue', () => {
  const NodeRenderer = defineComponent({
    name: 'NodeRenderer',
    props: {
      content: {
        type: String,
        default: ''
      }
    },
    setup(props) {
      return () => h('div', { 'data-testid': 'node-renderer' }, props.content)
    }
  })

  const CodeBlockNode = defineComponent({
    name: 'CodeBlockNode',
    render() {
      return h('div')
    }
  })
  const PreCodeNode = defineComponent({
    name: 'PreCodeNode',
    render() {
      return h('pre')
    }
  })

  return {
    default: NodeRenderer,
    NodeRenderer,
    CodeBlockNode,
    PreCodeNode,
    setCustomComponents: setCustomComponentsMock
  }
})

const mountThinkContent = async () => {
  vi.resetModules()
  const ThinkContent = (await import('@/components/think-content/ThinkContent.vue')).default
  const wrapper = mount(ThinkContent, {
    props: {
      label: 'Thinking',
      expanded: true,
      thinking: false,
      content: 'reasoning content'
    }
  })

  await flushPromises()

  return wrapper
}

describe('ThinkContent', () => {
  beforeEach(() => {
    ensureMarkdownWorkersMock.mockReset()
    ensureMarkdownWorkersMock.mockResolvedValue(undefined)
    setCustomComponentsMock.mockReset()
  })

  it('initializes markdown workers lazily when mounted', async () => {
    await mountThinkContent()

    expect(ensureMarkdownWorkersMock).toHaveBeenCalledTimes(1)
  })

  it('registers the Markstream 2 code block components directly', async () => {
    await mountThinkContent()

    expect(setCustomComponentsMock).toHaveBeenCalledTimes(1)
    const [customId, components] = setCustomComponentsMock.mock.calls[0]
    const preCode = components.code_block({ node: { language: 'mermaid' } })
    const codeBlock = components.code_block({ node: { language: 'typescript' } })
    const mermaid = components.mermaid({ node: { language: 'mermaid' } })

    expect(customId).toBe('thinking-content')
    expect(preCode.type.name).toBe('PreCodeNode')
    expect(mermaid.type.name).toBe('PreCodeNode')
    expect(codeBlock.type.name).toBe('CodeBlockNode')
    expect(codeBlock.props).toMatchObject({
      isShowPreview: false,
      showCopyButton: false,
      showExpandButton: false,
      showPreviewButton: false,
      showFontSizeButtons: false
    })
  })
})
