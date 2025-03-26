<template>
  <div class="my-1">
    <div
      @click="toggleExpanded"
      class="flex h-[40px] w-[360px] break-all shadow-sm my-2 items-center gap-2 rounded-lg border bg-card text-card-foreground cursor-pointer hover:bg-accent/10 transition-colors duration-200"
    >
      <div class="flex-grow w-0 pl-2">
        <h4
          class="text-xs font-medium leading-none text-accent-foreground flex flex-row gap-2 items-center"
        >
          <Icon icon="lucide:hammer" class="w-4 h-4 text-muted-foreground" />
          {{ block.tool_call?.name ?? '' }}
        </h4>
      </div>
      <div class="text-xs text-muted-foreground">{{ getToolCallStatus() }}</div>
      <div class="flex-shrink-0 px-2 rounded-lg rounded-l-none flex justify-center items-center">
        <Icon
          v-if="block.status === 'loading'"
          icon="lucide:loader-2"
          class="w-4 h-4 animate-spin text-muted-foreground"
        />
        <Icon
          v-else-if="block.status === 'success'"
          icon="lucide:check"
          class="w-4 h-4 bg-green-500 rounded-full text-white p-0.5 dark:bg-green-800"
        />
        <Icon
          v-else-if="block.status === 'error'"
          icon="lucide:x"
          class="w-4 h-4 text-white p-0.5 bg-red-500 rounded-full dark:bg-red-800"
        />
        <Icon
          v-else-if="showPermissionIcon()"
          icon="lucide:hand"
          class="w-4 h-4 p-0.5 bg-yellow-500 text-white rounded-full dark:bg-yellow-800"
        />
        <Icon
          v-else
          :icon="isExpanded ? 'lucide:chevron-up' : 'lucide:chevron-down'"
          class="w-4 h-4 text-muted-foreground"
        />
      </div>
    </div>

    <!-- 详细内容区域 -->
    <div v-if="isExpanded" class="rounded-lg border bg-card text-card-foreground p-4 mt-2 mb-4">
      <div class="space-y-4">
        <!-- 函数名称 -->
        <div class="space-y-1">
          <h5 class="text-xs font-medium text-accent-foreground">
            {{ t('toolCall.functionName') }}
          </h5>
          <div class="text-sm text-primary p-2 bg-muted rounded-md">
            {{ block.tool_call?.name ?? '' }}
          </div>
        </div>

        <!-- 参数 -->
        <div v-if="block.tool_call?.params" class="space-y-1">
          <h5 class="text-xs font-medium text-accent-foreground">{{ t('toolCall.params') }}</h5>
          <div class="text-sm text-primary p-2 bg-muted rounded-md overflow-auto max-h-48">
            <pre class="whitespace-pre-wrap break-all">{{
              formatJson(block.tool_call.params)
            }}</pre>
          </div>
        </div>

        <!-- 响应 -->
        <div v-if="block.tool_call?.response" class="space-y-1">
          <h5 class="text-xs font-medium text-accent-foreground">
            {{ t('toolCall.responseData') }}
          </h5>
          <div class="text-sm text-primary p-2 bg-muted rounded-md overflow-auto max-h-48">
            <pre class="whitespace-pre-wrap break-all">{{
              formatJson(block.tool_call.response)
            }}</pre>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { Icon } from '@iconify/vue'
import { useI18n } from 'vue-i18n'
import { AssistantMessageBlock } from '@shared/chat'
import { ref } from 'vue'

// 创建一个安全的翻译函数
const t = (() => {
  try {
    const { t } = useI18n()
    return t
  } catch (e) {
    // 如果 i18n 未初始化，提供默认翻译
    return (key: string) => {
      if (key === 'toolCall.calling') return '工具调用中'
      if (key === 'toolCall.response') return '工具响应'
      if (key === 'toolCall.end') return '工具调用完成'
      if (key === 'toolCall.error') return '工具调用错误'
      if (key === 'toolCall.title') return '工具调用'
      if (key === 'toolCall.clickToView') return '点击查看详情'
      if (key === 'toolCall.functionName') return '函数名称'
      if (key === 'toolCall.params') return '参数'
      return key
    }
  }
})()

const props = defineProps<{
  block: AssistantMessageBlock
  messageId?: string
  threadId?: string
}>()

const isExpanded = ref(false)

const toggleExpanded = () => {
  isExpanded.value = !isExpanded.value
}

const getToolCallStatus = () => {
  if (!props.block.tool_call) return ''

  if (props.block.status === 'error') {
    return t('toolCall.error')
  }

  if (props.block.status === 'loading') {
    return props.block.tool_call.response ? t('toolCall.response') : t('toolCall.calling')
  }

  if (props.block.status === 'success') {
    return t('toolCall.end')
  }

  return t('toolCall.title')
}

// 辅助函数，用于判断是否显示权限图标
const showPermissionIcon = () => {
  // 这里保留原有逻辑，暂时默认不显示
  return false
}

// 辅助函数，美化JSON显示
const formatJson = (jsonStr: string) => {
  try {
    // 尝试解析JSON字符串
    const obj = JSON.parse(jsonStr)
    return JSON.stringify(obj, null, 2)
  } catch (e) {
    // 如果解析失败，直接返回原字符串
    return jsonStr
  }
}
</script>

<style scoped>
pre {
  font-family:
    ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, 'Liberation Mono', 'Courier New',
    monospace;
  font-size: 0.85em;
}
</style>
