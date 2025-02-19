<template>
  <div class="w-full h-full relative min-h-0">
    <div
      ref="messagesContainer"
      class="relative flex-1 overflow-y-auto scroll-smooth w-full h-full"
    >
      <div
        ref="messageList"
        class="w-full max-w-full xl:max-w-4xl mx-auto transition-opacity duration-300"
        :class="{ 'opacity-0': !visible }"
      >
        <template v-for="(msg, index) in messages" :key="index">
          <MessageItemAssistant v-if="msg.role === 'assistant'" :key="index" :message="msg" />
          <MessageItemUser v-if="msg.role === 'user'" :key="index" :message="msg" />
        </template>
      </div>
      <div ref="scrollAnchor" class="h-4" />
    </div>
    <div v-if="showCancelButton" class="absolute bottom-4 left-1/2 -translate-x-1/2">
      <Button variant="outline" size="sm" class="rounded-lg" @click="handleCancel">
        <!-- <Icon
          icon="lucide:loader-circle"
          class="w-6 h-6 bg-primary p-0.5 text-primary-foreground rounded-full animate-spin group-hover:hidden"
        /> -->
        <Icon
          icon="lucide:square"
          class="w-6 h-6 bg-red-500 p-1 text-primary-foreground rounded-full"
        />
        <!-- <span class="block group-hover:hidden">正在生成...</span> -->
        <span class="">取消生成</span>
      </Button>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, onMounted, nextTick, watch, computed } from 'vue'
import MessageItemAssistant from './MessageItemAssistant.vue'
import MessageItemUser from './MessageItemUser.vue'
import { AssistantMessage, UserMessage } from '@shared/chat'
import { useElementBounding } from '@vueuse/core'
import { Button } from '@/components/ui/button'
import { Icon } from '@iconify/vue'
import { useChatStore } from '@/stores/chat'
const props = defineProps<{
  messages: UserMessage[] | AssistantMessage[]
}>()

const messagesContainer = ref<HTMLDivElement>()
const messageList = ref<HTMLDivElement>()
const scrollAnchor = ref<HTMLDivElement>()
const visible = ref(false)
const chatStore = useChatStore()
const scrollToBottom = (smooth = true) => {
  nextTick(() => {
    scrollAnchor.value?.scrollIntoView({
      behavior: smooth ? 'instant' : 'instant',
      block: 'end'
    })
  })
}

const showCancelButton = computed(() => {
  return chatStore.generatingThreadIds.has(chatStore.activeThreadId ?? '')
})

const handleCancel = () => {
  if (!chatStore.activeThreadId) return
  chatStore.cancelGenerating(chatStore.activeThreadId)
}

defineExpose({
  scrollToBottom
})

onMounted(() => {
  nextTick(() => {
    setTimeout(() => {
      scrollToBottom(false)
      nextTick(() => {
        visible.value = true
      })
    }, 10)
    const { height } = useElementBounding(messageList.value)
    watch(
      () => height.value,
      () => {
        const lastMessage = props.messages[props.messages.length - 1]
        if (lastMessage?.status === 'pending') {
          scrollToBottom(true)
        }
      }
    )
  })
})
</script>
