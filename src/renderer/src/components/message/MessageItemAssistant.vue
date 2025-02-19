<template>
  <div :class="['flex flex-row py-4 pl-4 pr-11 group gap-2 w-full', 'justify-start']">
    <ModelIcon
      :model-id="message.model_id"
      custom-class="flex-shrink-0 w-5 h-5 block rounded-md bg-background"
      :alt="message.role"
    />
    <div class="flex flex-col w-full space-y-1.5">
      <MessageInfo :name="message.model_name" :timestamp="message.timestamp" />
      <!-- 消息内容 -->
      <div
        v-if="currentContent.length === 0"
        class="flex flex-row items-center gap-2 text-xs text-muted-foreground"
      >
        <Icon icon="lucide:loader-circle" class="w-4 h-4 animate-spin" />
        正在思考...
      </div>
      <div v-else class="flex flex-col w-full space-y-2">
        <div v-for="block in currentContent" :key="block.id" class="w-full">
          <MessageBlockContent v-if="block.type === 'content'" :block="block" />
          <MessageBlockThink
            v-else-if="block.type === 'reasoning_content'"
            :block="block"
            :usage="message.usage"
          />
          <MessageBlockSearch v-else-if="block.type === 'search'" :block="block" />
          <MessageBlockError v-else-if="block.type === 'error'" :block="block" />
        </div>
      </div>
      <MessageToolbar
        :loading="message.status === 'pending'"
        :usage="message.usage"
        :is-assistant="true"
        :current-variant-index="currentVariantIndex"
        :total-variants="totalVariants"
        @retry="handleAction('retry')"
        @delete="handleAction('delete')"
        @copy="handleAction('copy')"
        @prev="handleAction('prev')"
        @next="handleAction('next')"
      />
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, onMounted, watch } from 'vue'
import { AssistantMessage } from '@shared/chat'
import MessageBlockContent from './MessageBlockContent.vue'
import MessageBlockThink from './MessageBlockThink.vue'
import MessageBlockSearch from './MessageBlockSearch.vue'
import MessageBlockError from './MessageBlockError.vue'
import MessageToolbar from './MessageToolbar.vue'
import MessageInfo from './MessageInfo.vue'
import { useChatStore } from '@/stores/chat'
import ModelIcon from '@/components/icons/ModelIcon.vue'
import { Icon } from '@iconify/vue'

const props = defineProps<{
  message: AssistantMessage
}>()

const chatStore = useChatStore()
const currentVariantIndex = ref(0)

const totalVariants = computed(() => {
  if (!props.message.variants || props.message.variants.length === 0) {
    return 1
  }
  return props.message.variants.length + 1
})

const currentContent = computed(() => {
  if (currentVariantIndex.value === 0) {
    return props.message.content
  }
  return props.message.variants?.[currentVariantIndex.value - 1]?.content || props.message.content
})
watch(
  () => props.message.variants,
  (newVariants) => {
    if (newVariants && newVariants.length > 0) {
      currentVariantIndex.value = newVariants.length
    } else {
      currentVariantIndex.value = 0 // 如果没有变体，重置索引
    }
  }
)

onMounted(() => {
  // 默认显示最后一个变体
  if (props.message.variants && props.message.variants.length > 0) {
    currentVariantIndex.value = props.message.variants.length
  }
})

const handleAction = (action: 'retry' | 'delete' | 'copy' | 'prev' | 'next') => {
  if (action === 'retry') {
    chatStore.retryMessage(props.message.id)
  } else if (action === 'delete') {
    chatStore.deleteMessage(props.message.id)
  } else if (action === 'copy') {
    window.api.copyText(
      currentContent.value
        .map((block) => {
          return block.type === 'reasoning_content'
            ? `<think>${block.content}</think>`
            : block.content
        })
        .join('\n')
    )
  } else if (action === 'prev') {
    if (currentVariantIndex.value > 0) {
      currentVariantIndex.value--
    }
  } else if (action === 'next') {
    if (currentVariantIndex.value < totalVariants.value - 1) {
      currentVariantIndex.value++
    }
  }
}
</script>
