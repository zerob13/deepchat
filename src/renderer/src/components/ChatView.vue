<template>
  <div class="h-full flex flex-col overflow-hidden">
    <!-- 消息列表区域 -->
    <MessageList
      :key="chatStore.activeThreadId ?? 'default'"
      ref="messageList"
      :messages="chatStore.messages"
      @scroll-bottom="scrollToBottom"
    />

    <!-- 输入框区域 -->
    <div class="flex-none p-2">
      <ChatInput
        @send="handleSend"
        @file-upload="handleFileUpload"
        :disabled="!chatStore.activeThreadId || chatStore.isGenerating"
      />
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, onMounted, onUnmounted, watch } from 'vue'
import MessageList from './message/MesasgeList.vue'
import ChatInput from './ChatInput.vue'
import { useRoute } from 'vue-router'
const route = useRoute()

const messageList = ref()

import { useChatStore } from '@/stores/chat'

const chatStore = useChatStore()

const scrollToBottom = (smooth = true) => {
  messageList.value?.scrollToBottom(smooth)
}

const handleSend = async (text: string) => {
  if (!text.trim()) return
  await chatStore.sendMessage({
    files: [],
    links: [],
    think: false,
    search: false,
    text: text
  })
  scrollToBottom()
}

const handleFileUpload = (files: FileList) => {
  console.log('files', files)
  // const fileList = Array.from(files).map((file) => ({
  //   name: file.name,
  //   type: file.type
  // }))

  // messages.value.push({
  //   type: 'file',
  //   content: '',
  //   files: fileList,
  //   role: 'user',
  //   timestamp: Date.now()
  // })
  const fileList = Array.from(files).map((file) => ({
    name: file.name,
    type: file.type,
    size: file.size,
    token: 0,
    path: ''
  }))

  // TODO: 实现文件上传逻辑
  console.log('文件上传:', fileList)
  scrollToBottom()
}

// 监听流式响应
onMounted(async () => {
  window.electron.ipcRenderer.on('stream-response', (_, msg) => {
    chatStore.handleStreamResponse(msg)
  })

  window.electron.ipcRenderer.on('stream-end', (_, msg) => {
    chatStore.handleStreamEnd(msg)
  })

  window.electron.ipcRenderer.on('stream-error', (_, msg) => {
    chatStore.handleStreamError(msg)
  })

  if (route.query.modelId && route.query.providerId) {
    const threadId = await chatStore.createThread('新会话', {
      modelId: route.query.modelId as string,
      providerId: route.query.providerId as string
    })
    chatStore.setActiveThread(threadId)
  }
})

watch(
  () => route.query,
  async () => {
    if (route.query.modelId && route.query.providerId) {
      const threadId = await chatStore.createThread('新会话', {
        modelId: route.query.modelId as string,
        providerId: route.query.providerId as string
      })
      chatStore.setActiveThread(threadId)
    }
  }
)

// 清理事件监听
onUnmounted(async () => {
  window.electron.ipcRenderer.removeAllListeners('stream-response')
  window.electron.ipcRenderer.removeAllListeners('stream-end')
  window.electron.ipcRenderer.removeAllListeners('stream-error')
})
</script>
