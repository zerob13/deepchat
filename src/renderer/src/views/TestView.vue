<!-- <template>
  <ScrollArea class="p-4 w-full h-full mx-auto space-y-4">
    <div class="grid grid-cols-1 lg:grid-cols-3 gap-4 h-full">
      <!-- 左侧对话列表和设置 -->
      <div class="space-y-4">
        <h2 class="text-xl font-bold">对话列表</h2>
        <div class="flex flex-wrap gap-2">
          <Button @click="createConversation"
            >新建对话
            <img src="@/assets/test.svg" class="w-4 h-4" />
          </Button>
          <Button @click="loadConversations" variant="outline">刷新列表</Button>
        </div>

        <!-- 对话列表 -->
        <ScrollArea class="h-[400px]">
          <div class="space-y-2">
            <Card
              v-for="conversation in conversations"
              :key="conversation.id"
              :class="{ 'border-primary': conversation.id === currentConversationId }"
              class="hover:shadow-lg transition-shadow cursor-pointer"
              @click="selectConversation(conversation)"
            >
              <CardHeader>
                <CardTitle>{{ conversation.title }}</CardTitle>
                <CardDescription>
                  创建时间: {{ new Date(conversation.createdAt).toLocaleString() }}
                </CardDescription>
              </CardHeader>
            </Card>
          </div>
          <div v-if="conversations.length === 0" class="text-center text-gray-500 py-4">
            暂无对话
          </div>
        </ScrollArea>

        <!-- 对话设置 -->
        <div class="space-y-2 bg-gray-50 p-4 rounded-lg">
          <h3 class="text-lg font-semibold">对话设置</h3>
          <div class="space-y-2">
            <label class="text-sm font-medium">系统提示词</label>
            <Textarea
              v-model="currentSettings.systemPrompt"
              placeholder="输入系统提示词"
              :rows="3"
            />
          </div>
          <div class="space-y-2">
            <label class="text-sm font-medium">温度 (0-1)</label>
            <Input
              v-model.number="currentSettings.temperature"
              type="number"
              min="0"
              max="1"
              step="0.1"
            />
          </div>
          <div class="space-y-2">
            <label class="text-sm font-medium">上下文长度</label>
            <Input v-model.number="currentSettings.contextLength" type="number" min="1" max="100" />
          </div>
          <div class="space-y-2">
            <label class="text-sm font-medium">最大Token数</label>
            <Input v-model.number="currentSettings.maxTokens" type="number" min="100" max="10000" />
          </div>
          <Button
            @click="updateSettings"
            variant="secondary"
            :disabled="!currentConversationId"
            class="mt-2"
          >
            更新设置
          </Button>
        </div>
      </div>

      <!-- 中间聊天区域 -->
      <div class="lg:col-span-2 space-y-4">
        <div class="flex items-center gap-2">
          <h2 class="text-xl font-bold">聊天测试</h2>
          <div v-if="currentConversationId" class="text-sm text-gray-500">
            (当前对话: {{ currentConversationId }})
          </div>
        </div>

        <!-- 模型选择 -->
        <div class="flex gap-2 items-center">
          <Select v-model="selectedProvider">
            <SelectTrigger><SelectValue></SelectValue></SelectTrigger>
            <SelectContent>
              <SelectItem v-for="provider in providers" :key="provider.id" :value="provider.id">
                {{ provider.name }}
              </SelectItem>
            </SelectContent>
          </Select>
          <Select v-if="selectedProvider" v-model="selectedModelId" :disabled="!models.length">
            <SelectTrigger><SelectValue></SelectValue></SelectTrigger>
            <SelectContent>
              <SelectItem v-for="model in models" :key="model.id" :value="model.id">
                {{ model.name }}
              </SelectItem>
            </SelectContent>
          </Select>
          <Button
            @click="fetchProviderModels(selectedProvider)"
            variant="outline"
            :disabled="!selectedProvider"
          >
            获取模型列表
          </Button>
        </div>
        <div class="flex gap-2">
          <Input v-model="currentProviderApiKey" placeholder="输入API Key" type="text" />
          <Button @click="saveProviderSetting">更新设置</Button>
        </div>

        <!-- 消息列表 -->
        <ScrollArea class="h-[500px] bg-gray-50 rounded-lg p-4">
          <div class="space-y-4">
            <div v-for="message in messages" :key="message.id" class="space-y-2">
              <div
                :class="{
                  'ml-auto max-w-[80%]': message.role === 'user',
                  'mr-auto max-w-[80%]': message.role !== 'user'
                }"
              >
                <div
                  :class="{
                    'bg-primary text-primary-foreground': message.role === 'user',
                    'bg-muted': message.role !== 'user'
                  }"
                  class="rounded-lg p-3"
                >
                  <VueMarkdown
                    :source="message.content[0].content"
                    :options="{
                      html: true,
                      linkify: true,
                      typographer: true
                    }"
                  />
                </div>
                <div class="text-xs text-gray-500 mt-1">
                  {{ new Date(message.createdAt).toLocaleString() }}
                  <template v-if="message.metadata.model">
                    · {{ message.metadata.model }}
                  </template>
                  <template v-if="message.metadata.generationTime">
                    · {{ (message.metadata.generationTime / 1000).toFixed(2) }}s
                  </template>
                </div>
              </div>
              <div class="flex gap-2" v-if="message.role === 'assistant'">
                <Button size="sm" variant="outline" @click="retryMessage(message.id)">
                  重试
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  @click="markMessageAsContextEdge(message.id, !message.isContextEdge)"
                >
                  {{ message.isContextEdge ? '取消上下文' : '设为上下文' }}
                </Button>
              </div>
            </div>
          </div>
        </ScrollArea>

        <!-- 输入区域 -->
        <div class="flex gap-2">
          <Textarea
            v-model="currentMessage"
            placeholder="输入消息..."
            :rows="3"
            class="flex-1"
            @keydown.enter.exact.prevent="sendMessage"
          />
          <Button
            @click="sendMessage"
            :disabled="!currentConversationId || !selectedModelId || isGenerating"
            class="self-end"
          >
            发送
          </Button>
        </div>
      </div>
    </div>
  </ScrollArea>
</template>

<script setup lang="ts">
import { ref, onMounted, onUnmounted, watch } from 'vue'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import {
  Select,
  SelectItem,
  SelectTrigger,
  SelectValue,
  SelectContent
} from '@/components/ui/select'
import { Card, CardHeader, CardTitle, CardDescription } from '@/components/ui/card'
import { usePresenter } from '@/composables/usePresenter'
import { LLM_PROVIDER, MODEL_META, CONVERSATION, CONVERSATION_SETTINGS } from '@shared/presenter'
import { ScrollArea } from '@/components/ui/scroll-area'
import VueMarkdown from 'vue-markdown-render'
import { Textarea } from '@/components/ui/textarea'
import { Message } from '@shared/chat'

const configP = usePresenter('configPresenter')
const llmProviderP = usePresenter('llmproviderPresenter')
const threadP = usePresenter('threadPresenter')

const providers = ref<LLM_PROVIDER[]>([])
const selectedProvider = ref('')
const models = ref<MODEL_META[]>([])
const conversations = ref<CONVERSATION[]>([])
const currentPage = ref(1)
const pageSize = ref(10)
const totalConversations = ref(0)
const currentSettings = ref<CONVERSATION_SETTINGS>({
  systemPrompt: '',
  temperature: 0.7,
  contextLength: 1000,
  maxTokens: 2000,
  providerId: '',
  modelId: ''
})

const currentMessage = ref('')
const messages = ref<Message[]>([])
const selectedModelId = ref('')
const isGenerating = ref(false)
let currentConversationId: string | null = null
const currentProviderApiKey = ref('')

// 修改事件处理函数
const handleResponse = async (_, msg) => {
  if (currentConversationId) {
    // currentMessage.value += msg.chunk
    const curMsg = messages.value.find((m) => m.id === msg.eventId)
    if (!curMsg) {
      return
    }
    if (curMsg) {
      curMsg.content += msg.chunk
    }
  }
  console.info('handleResponse', msg)
}

const handleError = (_, msg) => {
  showAlert(`生成失败: ${msg}`)
  isGenerating.value = false
}

const handleEnd = () => {
  isGenerating.value = false
  loadMessages() // 刷新消息列表
}

// 初始化加载供应商列表
onMounted(async () => {
  providers.value = await configP.getProviders()
  selectedProvider.value = providers.value[0]?.id || ''

  // 加载对话列表
  await loadConversations()
  // 添加事件监听器
  window.electron.ipcRenderer.on(`stream-response`, handleResponse)
  window.electron.ipcRenderer.on(`stream-error`, handleError)
  window.electron.ipcRenderer.on(`stream-end`, handleEnd)
})

// 获取供应商模型列表
const fetchProviderModels = async (providerId: string) => {
  try {
    const provider = await configP.getProviderById(providerId)
    if (!provider?.apiKey) {
      // showAlert('请先设置API Key')
      return
    }

    models.value = await llmProviderP.getModelList(providerId)
    showAlert(`成功获取 ${models.value.length} 个模型`)
  } catch (error) {
    showAlert(`获取失败: ${String(error)}`)
  }
}
const saveProviderSetting = () => {
  const currentProvider = providers.value.find((p) => p.id === selectedProvider.value)
  if (!currentProvider) {
    showAlert('请先选择供应商')
    return
  }
  configP.setProviderById(selectedProvider.value, {
    ...currentProvider,
    apiKey: currentProviderApiKey.value,
    enable: true
  })
}

// 组件卸载时清理所有事件监听器
onUnmounted(() => {
  window.electron.ipcRenderer.removeAllListeners(`stream-response`)
  window.electron.ipcRenderer.removeAllListeners(`stream-error`)
  window.electron.ipcRenderer.removeAllListeners(`stream-end`)
})

const showAlert = (message: string) => {
  alert(`操作结果: ${message}`)
}

const createConversation = async () => {
  try {
    // 确保设置了 provider 和 model
    // if (!selectedProvider.value || !selectedModelId.value) {
    //   showAlert('请先选择服务商和模型')
    //   return
    // }

    const settings = {
      ...currentSettings.value,
      providerId: selectedProvider.value,
      modelName: selectedModelId.value
    }
    currentConversationId = await threadP.createConversation('测试对话', settings)
    showAlert(`对话创建成功，ID: ${currentConversationId}`)
    await loadConversations()
  } catch (error: unknown) {
    showAlert(`对话创建失败: ${error}`)
  }
}

const loadConversations = async () => {
  try {
    const result = await threadP.getConversationList(currentPage.value, pageSize.value)
    conversations.value = result.list
    totalConversations.value = result.total
  } catch (error) {
    showAlert(`加载对话列表失败: ${error}`)
  }
}

const selectConversation = async (conversation: CONVERSATION) => {
  try {
    currentConversationId = conversation.id
    currentSettings.value = { ...conversation.settings }
    // 同步更新选择器的值
    selectedProvider.value = conversation.settings.providerId
    selectedModelId.value = conversation.settings.modelName
    // 加载该 provider 的模型列表
    await fetchProviderModels(selectedProvider.value)
    await threadP.setActiveConversation(conversation.id)
    await loadMessages()
    showAlert(`已选择对话: ${conversation.title}`)
  } catch (error) {
    showAlert(`选择对话失败: ${error}`)
  }
}

const updateSettings = async () => {
  if (!currentConversationId) {
    showAlert('请先选择对话')
    return
  }

  try {
    await threadP.updateConversationSettings(currentConversationId, currentSettings.value)
    showAlert('设置更新成功')
    await loadConversations()
  } catch (error) {
    showAlert(`设置更新失败: ${error}`)
  }
}

// 监听 provider 和 model 的变化
const handleProviderModelChange = async () => {
  if (!currentConversationId) return

  try {
    const newSettings = {
      ...currentSettings.value,
      providerId: selectedProvider.value,
      modelName: selectedModelId.value
    }
    await threadP.updateConversationSettings(currentConversationId, newSettings)
    currentSettings.value = newSettings
  } catch (error) {
    showAlert(`更新设置失败: ${error}`)
  }
}

watch([selectedProvider, selectedModelId], handleProviderModelChange)

const sendMessage = async () => {
  if (!currentMessage.value.trim() || !currentConversationId) {
    return
  }

  try {
    isGenerating.value = true
    // const eventId = nanoid()

    // 发送用户消息
    await threadP.sendMessage(
      currentConversationId,
      [{ content: currentMessage.value, type: 'text' }],
      'user'
    )

    // 清空输入
    currentMessage.value = ''
    // 刷新消息列表
    await loadMessages()
    threadP.startStreamCompletion(currentConversationId)
  } catch (error) {
    showAlert(`发送失败: ${error}`)
  } finally {
    isGenerating.value = false
  }
}

const loadMessages = async () => {
  if (!currentConversationId) return

  try {
    const result = await threadP.getMessages(currentConversationId, 1, 100)
    messages.value = result.list
  } catch (error) {
    showAlert(`加载消息失败: ${error}`)
  }
}

const retryMessage = async (messageId: string) => {
  if (!selectedModelId.value) {
    showAlert('请先选择模型')
    return
  }

  try {
    isGenerating.value = true
    await threadP.retryMessage(messageId, selectedModelId.value)
    await loadMessages()
  } catch (error) {
    showAlert(`重试失败: ${error}`)
  } finally {
    isGenerating.value = false
  }
}

const markMessageAsContextEdge = async (messageId: string, isEdge: boolean) => {
  try {
    await threadP.markMessageAsContextEdge(messageId, isEdge)
    await loadMessages()
  } catch (error) {
    showAlert(`设置上下文失败: ${error}`)
  }
}
</script> -->
