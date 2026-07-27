import { defineComponent } from 'vue'
import { describe, expect, it, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import { INPUT_NODE_ACTIONS, type InputNodeActions } from '@/components/chat/nodes/symbols'

vi.mock('vue-i18n', () => ({
  useI18n: () => ({
    t: (key: string) => key
  })
}))

vi.mock('@iconify/vue', () => ({
  Icon: defineComponent({
    name: 'Icon',
    props: { icon: { type: String, required: true } },
    template: '<span :data-icon="icon" />'
  })
}))

vi.mock('@tiptap/vue-3', () => ({
  NodeViewWrapper: defineComponent({
    name: 'NodeViewWrapper',
    template: '<span><slot /></span>'
  })
}))

vi.mock('@shadcn/components/ui/dropdown-menu', () => {
  const passthrough = (name: string) =>
    defineComponent({
      name,
      template: '<div><slot /></div>'
    })
  return {
    DropdownMenu: passthrough('DropdownMenu'),
    DropdownMenuContent: passthrough('DropdownMenuContent'),
    DropdownMenuTrigger: passthrough('DropdownMenuTrigger'),
    DropdownMenuRadioGroup: defineComponent({
      name: 'DropdownMenuRadioGroup',
      props: { modelValue: { type: String, required: true } },
      emits: ['update:modelValue'],
      template: '<div><slot /></div>'
    }),
    DropdownMenuRadioItem: defineComponent({
      name: 'DropdownMenuRadioItem',
      props: { value: { type: String, required: true } },
      template: '<div :data-value="value"><slot /></div>'
    })
  }
})

import FileAttachmentView from '@/components/chat/nodes/FileAttachmentView.vue'

function mountAttachment(
  attrs: Record<string, unknown>,
  actions: InputNodeActions = {
    prepareCommandFormSubmit: vi.fn(),
    removeSkill: vi.fn(),
    removeFile: vi.fn(),
    setFileRepresentation: vi.fn(),
    submitCommandForm: vi.fn(),
    cancelCommandForm: vi.fn()
  }
) {
  const updateAttributes = vi.fn()
  const deleteNode = vi.fn()
  const wrapper = mount(FileAttachmentView, {
    props: {
      editor: {},
      node: { attrs },
      decorations: [],
      selected: false,
      extension: {},
      getPos: () => 0,
      updateAttributes,
      deleteNode,
      view: {},
      innerDecorations: {},
      HTMLAttributes: {}
    } as never,
    global: {
      provide: {
        [INPUT_NODE_ACTIONS as symbol]: actions
      }
    }
  })
  return { actions, deleteNode, updateAttributes, wrapper }
}

describe('FileAttachmentView', () => {
  it('offers Auto, embedded text, and OCR for PDFs with a compact current label', async () => {
    const { actions, updateAttributes, wrapper } = mountAttachment({
      fileName: 'report.pdf',
      filePath: '/tmp/report.pdf',
      mimeType: 'application/pdf',
      requestedRepresentation: 'embedded_text'
    })

    expect(wrapper.get('[data-testid="attachment-representation-trigger"]').text()).toContain(
      'chat.attachments.embeddedTextBadge'
    )
    expect(
      wrapper.findAll('[data-value]').map((option) => option.attributes('data-value'))
    ).toEqual(['auto', 'embedded_text', 'ocr_text'])
    expect(wrapper.text()).not.toContain('chat.attachments.sendImage')

    wrapper
      .findComponent({ name: 'DropdownMenuRadioGroup' })
      .vm.$emit('update:modelValue', 'ocr_text')
    await wrapper.vm.$nextTick()

    expect(updateAttributes).toHaveBeenCalledWith({ requestedRepresentation: 'ocr_text' })
    expect(actions.setFileRepresentation).toHaveBeenCalledWith('/tmp/report.pdf', 'ocr_text')
  })

  it('keeps image choices contextual and normalizes a stale PDF-only value to Auto', () => {
    const { wrapper } = mountAttachment({
      fileName: 'scan.png',
      filePath: '/tmp/scan.png',
      mimeType: 'image/png',
      requestedRepresentation: 'embedded_text'
    })

    expect(wrapper.get('[data-testid="attachment-representation-trigger"]').text()).toContain(
      'chat.attachments.auto'
    )
    expect(
      wrapper.findAll('[data-value]').map((option) => option.attributes('data-value'))
    ).toEqual(['auto', 'image', 'ocr_text'])
  })

  it('does not add representation controls to unrelated files', () => {
    const { wrapper } = mountAttachment({
      fileName: 'notes.txt',
      filePath: '/tmp/notes.txt',
      mimeType: 'text/plain',
      requestedRepresentation: 'auto'
    })

    expect(wrapper.find('[data-testid="attachment-representation-trigger"]').exists()).toBe(false)
  })
})
