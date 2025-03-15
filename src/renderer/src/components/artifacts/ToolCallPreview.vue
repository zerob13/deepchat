<template>
  <div>
    <div
      class="flex w-64 max-w-full shadow-sm my-2 items-center gap-2 rounded-lg border bg-card text-card-foreground hover:bg-accent/50"
      :class="{ 'cursor-pointer': !props.block.loading }"
      @click="handleClick"
    >
      <div
        class="flex-shrink-0 w-10 h-10 rounded-lg rounded-r-none inline-flex flex-row justify-center items-center bg-muted border-r"
      >
        <Icon icon="lucide:hammer" class="w-5 h-5 text-muted-foreground" />
      </div>
      <div class="flex-grow w-0">
        <p class="text-xs text-muted-foreground mt-0.5">{{ getToolCallStatus() }}</p>
      </div>
      <div
        class="flex-shrink-0 px-3 h-10 rounded-lg rounded-l-none flex justify-center items-center"
      >
        <Icon
          v-if="props.block.loading"
          icon="lucide:loader-2"
          class="w-5 h-5 animate-spin text-muted-foreground"
        />
        <Icon v-else icon="lucide:chevron-right" class="w-5 h-5 text-muted-foreground" />
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { Icon } from '@iconify/vue'
import { useI18n } from 'vue-i18n'
import type { ProcessedPart } from '@/composables/useArtifacts'

// 创建一个安全的翻译函数
const t = (() => {
  try {
    const { t } = useI18n()
    return t
  } catch (e) {
    // 如果 i18n 未初始化，提供默认翻译
    return (key: string) => {
      if (key === 'toolCall.calling') return '工具调用中'
      if (key === 'toolCall.response') return '工具响应中'
      if (key === 'toolCall.end') return '工具调用完成'
      if (key === 'toolCall.error') return '工具调用错误'
      if (key === 'toolCall.title') return '工具调用'
      if (key === 'toolCall.clickToView') return '点击查看详情'
      if (key === 'toolCall.functionName') return '函数名称'
      return key
    }
  }
})()

const props = defineProps<{
  block: ProcessedPart
}>()

// const getToolCallTitle = () => {
//   // 尝试从内容中提取工具名称
//   const content = props.block.content
//   const functionMatch = content.match(/function\s*:\s*([a-zA-Z_][a-zA-Z0-9_]*)/i)

//   if (functionMatch && functionMatch[1]) {
//     // 返回提取的函数名称，这是一个动态值，不需要翻译
//     return functionMatch[1]
//   }

//   // 返回默认的工具调用标题
//   return t('toolCall.title')
// }

const getToolCallStatus = () => {
  if (!props.block.tool_call) return ''

  switch (props.block.tool_call.status) {
    case 'calling':
      return t('toolCall.calling')
    case 'response':
      return t('toolCall.response')
    case 'end':
      return t('toolCall.end')
    case 'error':
      return t('toolCall.error')
    default:
      return ''
  }
}

const handleClick = () => {
  if (!props.block.loading) {
    // 这里可以添加点击后的逻辑，比如展示详细内容
    console.log(t('toolCall.clickToView'), props.block)
  }
}
</script>
