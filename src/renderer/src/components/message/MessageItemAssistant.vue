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

// 计算当前消息的所有变体（包括缓存中的）
const allVariants = computed(() => {
  const messageVariants = props.message.variants || []
  const combinedVariants = messageVariants.map((variant) => {
    const cachedVariant = Array.from(chatStore.generatingMessagesCache.values()).find((cached) => {
      const msg = cached.message as AssistantMessage
      return msg.is_variant && msg.id === variant.id
    })
    return cachedVariant ? cachedVariant.message : variant
  })
  return combinedVariants
})

// 计算变体总数
const totalVariants = computed(() => {
  return allVariants.value.length > 0 ? allVariants.value.length + 1 : 1
})

// 获取当前显示的内容
const currentContent = computed(() => {
  if (currentVariantIndex.value === 0) {
    return props.message.content
  }

  // 从合并后的变体列表中获取内容
  const variant = allVariants.value[currentVariantIndex.value - 1]
  return variant?.content || props.message.content
})

// 监听变体变化
watch(
  () => allVariants.value.length,
  (newLenth) => {
    if (newLenth > 0) {
      // 如果当前没有选中任何变体，自动切换到最新的变体
      if (currentVariantIndex.value === 0) {
        currentVariantIndex.value = newLenth - 1
      }
      // 如果当前选中的变体超出范围，调整到最后一个变体
      else if (currentVariantIndex.value > newLenth) {
        currentVariantIndex.value = newLenth - 1
      }
    } else {
      currentVariantIndex.value = 0
    }
  },
  { immediate: true }
)

// 监听消息本身的变化
watch(
  () => props.message,
  () => {
    // 当消息发生变化时，检查是否需要更新当前显示的变体
    const variants = allVariants.value
    if (variants.length > 0 && currentVariantIndex.value === 0) {
      currentVariantIndex.value = variants.length
    }
  },
  { deep: true }
)

onMounted(() => {
  // 默认显示最后一个变体
  const variants = allVariants.value
  if (variants.length > 0) {
    currentVariantIndex.value = variants.length
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
