<script setup lang="ts">
// 保持原有的script部分不变
import { ref, onMounted, computed, watch } from 'vue'
import { Icon } from '@iconify/vue'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger
} from '@/components/ui/dialog'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip'
import { usePresenter } from '@/composables/usePresenter'
import { MCPConfig, MCPServerConfig, MCPToolDefinition } from '@shared/presenter'
import McpServerForm from './mcpServerForm.vue'

const mcpPresenter = usePresenter('mcpPresenter')

// 状态
const mcpConfig = ref<MCPConfig>({
  mcpServers: {},
  defaultServer: ''
})
const activeTab = ref<'servers' | 'tools'>('servers')
const isAddServerDialogOpen = ref(false)
const isEditServerDialogOpen = ref(false)
const selectedServer = ref<string>('')
const serverStatuses = ref<Record<string, boolean>>({})
const serverLoadingStates = ref<Record<string, boolean>>({})
const isLoading = ref(false)

// 工具相关状态
const tools = ref<MCPToolDefinition[]>([])
const isToolsLoading = ref(false)
const isToolLoading = ref<Record<string, boolean>>({})
const toolInputs = ref<Record<string, Record<string, string>>>({})
const toolResults = ref<Record<string, string>>({})
const selectedTool = ref<MCPToolDefinition | null>(null)

// 选择工具
const selectTool = (tool: MCPToolDefinition) => {
  selectedTool.value = tool
  if (!toolInputs.value[tool.function.name]) {
    // 初始化默认输入
    toolInputs.value[tool.function.name] = { path: '' }

    // 为 search_files 工具设置默认值
    if (tool.function.name === 'search_files') {
      toolInputs.value[tool.function.name] = {
        path: '',
        regex: '\\.md$', // 简单的 MD 文件搜索表达式
        file_pattern: '*.md'
      }
    }
  }
}

// 计算属性
const serverList = computed(() => {
  return Object.entries(mcpConfig.value.mcpServers).map(([name, config]) => ({
    name,
    ...config,
    isRunning: serverStatuses.value[name] || false,
    isDefault: name === mcpConfig.value.defaultServer
  }))
})

// 方法
const loadMcpConfig = async () => {
  try {
    isLoading.value = true
    mcpConfig.value = await mcpPresenter.getMcpConfig()

    // 获取服务器运行状态
    for (const serverName of Object.keys(mcpConfig.value.mcpServers)) {
      serverStatuses.value[serverName] = await mcpPresenter.isServerRunning(serverName)
    }
  } catch (error) {
    console.error('Failed to load MCP config:', error)
  } finally {
    isLoading.value = false
  }
}

const handleAddServer = async (serverName: string, serverConfig: MCPServerConfig) => {
  try {
    isLoading.value = true
    await mcpPresenter.addMcpServer(serverName, serverConfig)
    isAddServerDialogOpen.value = false
    await loadMcpConfig()
  } catch (error) {
    console.error('Failed to add MCP server:', error)
  } finally {
    isLoading.value = false
  }
}

const handleEditServer = async (serverName: string, serverConfig: Partial<MCPServerConfig>) => {
  try {
    isLoading.value = true
    await mcpPresenter.updateMcpServer(serverName, serverConfig)
    isEditServerDialogOpen.value = false
    selectedServer.value = ''
    await loadMcpConfig()
  } catch (error) {
    console.error('Failed to update MCP server:', error)
  } finally {
    isLoading.value = false
  }
}

const handleRemoveServer = async (serverName: string) => {
  if (!confirm(`确定要删除服务器 ${serverName} 吗？此操作无法撤销。`)) {
    return
  }

  try {
    isLoading.value = true
    await mcpPresenter.removeMcpServer(serverName)
    await loadMcpConfig()
  } catch (error) {
    console.error('Failed to remove MCP server:', error)
  } finally {
    isLoading.value = false
  }
}

const handleSetDefaultServer = async (serverName: string) => {
  try {
    isLoading.value = true
    await mcpPresenter.setDefaultServer(serverName)
    await loadMcpConfig()
  } catch (error) {
    console.error('Failed to set default MCP server:', error)
  } finally {
    isLoading.value = false
  }
}

const handleToggleServer = async (serverName: string) => {
  try {
    // 只设置当前服务器的加载状态，而不是整个页面
    const currentServerStatus = serverStatuses.value[serverName] || false

    // 设置当前服务器的加载状态
    serverLoadingStates.value[serverName] = true

    if (currentServerStatus) {
      await mcpPresenter.stopServer(serverName)
    } else {
      await mcpPresenter.startServer(serverName)
    }

    // 更新服务器状态
    serverStatuses.value[serverName] = await mcpPresenter.isServerRunning(serverName)
  } catch (error) {
    console.error(`Failed to toggle MCP server ${serverName}:`, error)
    // 显示错误提示
    alert(`${serverName} ${serverStatuses.value[serverName] ? '停止' : '启动'}失败: ${error}`)
  } finally {
    // 无论成功还是失败，都清除加载状态
    serverLoadingStates.value[serverName] = false
  }
}

const openEditServerDialog = (serverName: string) => {
  selectedServer.value = serverName
  isEditServerDialogOpen.value = true
}

// 工具相关方法
const loadTools = async () => {
  try {
    isToolsLoading.value = true
    tools.value = await mcpPresenter.getAllToolDefinitions()

    // 初始化每个工具的输入状态
    tools.value.forEach((tool) => {
      toolInputs.value[tool.function.name] = {}
      Object.keys(tool.function.parameters.properties || {}).forEach((paramName) => {
        toolInputs.value[tool.function.name][paramName] = ''
      })
    })
  } catch (error) {
    console.error('Failed to load tools:', error)
  } finally {
    isToolsLoading.value = false
  }
}

const callTool = async (toolName: string) => {
  try {
    isToolLoading.value[toolName] = true

    // 确保必需参数都已提供
    const toolInputData = toolInputs.value[toolName]

    // 特殊处理 search_files 工具
    if (toolName === 'search_files') {
      // 如果没有提供正则表达式，使用默认值
      if (!toolInputData.regex) {
        toolInputData.regex = '.md$'
      }

      // 如果路径为空，默认使用当前目录
      if (!toolInputData.path) {
        toolInputData.path = '.'
      }

      // 如果没有提供文件类型过滤，根据正则表达式推断
      if (!toolInputData.file_pattern) {
        const match = toolInputData.regex.match(/\.(\w+)\$/)
        if (match) {
          toolInputData.file_pattern = `*.${match[1]}`
        }
      }
    }

    const result = await mcpPresenter.callTool({
      id: Math.floor(Date.now()).toString(),
      type: 'function',
      function: {
        name: toolName,
        arguments: JSON.stringify(toolInputData)
      }
    })
    toolResults.value[toolName] = result.content
  } catch (error) {
    console.error(`Failed to call tool ${toolName}:`, error)
    toolResults.value[toolName] = `错误: ${error}`
  } finally {
    isToolLoading.value[toolName] = false
  }
}

// 监听标签切换
watch(activeTab, async (newTab) => {
  if (newTab === 'tools') {
    await loadTools()
  }
})

// 生命周期钩子
onMounted(async () => {
  await loadMcpConfig()
  if (activeTab.value === 'tools') {
    await loadTools()
  }
})
</script>

<template>
  <div class="h-full flex flex-col overflow-hidden">
    <!-- 选项卡 -->
    <div class="flex border-b mb-4 px-4">
      <button
        class="px-4 py-2 text-sm"
        :class="
          activeTab === 'servers'
            ? 'border-b-2 border-primary font-medium text-primary'
            : 'text-muted-foreground'
        "
        @click="activeTab = 'servers'"
      >
        服务器
      </button>
      <button
        class="px-4 py-2 text-sm ml-4"
        :class="
          activeTab === 'tools'
            ? 'border-b-2 border-primary font-medium text-primary'
            : 'text-muted-foreground'
        "
        @click="activeTab = 'tools'"
      >
        工具
      </button>
    </div>

    <div class="flex-1 overflow-hidden px-4">
      <!-- 服务器配置选项卡 -->
      <div v-if="activeTab === 'servers'" class="h-full overflow-y-auto">
        <div class="flex justify-between items-center mb-4">
          <h3 class="text-base font-medium">服务器列表</h3>
          <Dialog v-model:open="isAddServerDialogOpen">
            <DialogTrigger asChild>
              <Button variant="outline" size="sm">
                <Icon icon="lucide:plus" class="mr-2 h-4 w-4" />
                添加服务器
              </Button>
            </DialogTrigger>
            <DialogContent class="sm:max-w-[425px]">
              <DialogHeader>
                <DialogTitle>添加服务器</DialogTitle>
                <DialogDescription> 配置新的MCP服务器 </DialogDescription>
              </DialogHeader>
              <McpServerForm @submit="handleAddServer" />
            </DialogContent>
          </Dialog>
        </div>

        <div v-if="isLoading" class="flex justify-center py-8">
          <Icon icon="lucide:loader" class="h-8 w-8 animate-spin" />
        </div>

        <div
          v-else-if="serverList.length === 0"
          class="text-center py-8 text-muted-foreground text-lg"
        >
          未找到服务器
        </div>

        <div v-else class="space-y-6">
          <div
            v-for="server in serverList"
            :key="server.name"
            class="border rounded-lg overflow-hidden"
          >
            <div class="flex items-center p-8">
              <div class="flex-1">
                <div>
                  <div class="flex items-center">
                    <span class="text-2xl mr-3">{{ server.icons }}</span>
                    <h4 class="text-xl font-medium">{{ server.name }}</h4>
                    <span
                      :class="[
                        'ml-3 px-3 py-1 text-sm rounded-full',
                        server.isRunning
                          ? 'bg-green-100 text-green-800 dark:bg-green-800 dark:text-green-100'
                          : 'bg-gray-100 text-gray-800 dark:bg-gray-800 dark:text-gray-100'
                      ]"
                    >
                      {{ server.isRunning ? '运行中' : '已停止' }}
                    </span>
                  </div>
                  <p class="text-base text-muted-foreground mt-2">{{ server.descriptions }}</p>
                </div>
              </div>
              <div class="flex items-center space-x-6">
                <TooltipProvider>
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <Button
                        variant="outline"
                        size="sm"
                        :disabled="isLoading"
                        @click="handleToggleServer(server.name)"
                      >
                        <Icon
                          v-if="serverLoadingStates[server.name]"
                          icon="lucide:loader"
                          class="h-4 w-4 animate-spin"
                        />
                        <Icon
                          v-else
                          :icon="server.isRunning ? 'lucide:square' : 'lucide:play'"
                          class="h-4 w-4"
                        />
                      </Button>
                    </TooltipTrigger>
                    <TooltipContent>
                      <p>{{ server.isRunning ? '停止服务器' : '启动服务器' }}</p>
                    </TooltipContent>
                  </Tooltip>
                </TooltipProvider>

                <TooltipProvider>
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <Button
                        variant="outline"
                        size="sm"
                        :disabled="server.isDefault || isLoading"
                        @click="handleSetDefaultServer(server.name)"
                      >
                        <Icon icon="lucide:check-circle" class="h-4 w-4" />
                      </Button>
                    </TooltipTrigger>
                    <TooltipContent>
                      <p>设置为默认服务器</p>
                    </TooltipContent>
                  </Tooltip>
                </TooltipProvider>

                <TooltipProvider>
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <Button
                        variant="outline"
                        size="sm"
                        :disabled="isLoading"
                        @click="openEditServerDialog(server.name)"
                      >
                        <Icon icon="lucide:edit" class="h-4 w-4" />
                      </Button>
                    </TooltipTrigger>
                    <TooltipContent>
                      <p>编辑服务器</p>
                    </TooltipContent>
                  </Tooltip>
                </TooltipProvider>

                <TooltipProvider>
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <Button
                        variant="outline"
                        size="sm"
                        :disabled="isLoading"
                        @click="handleRemoveServer(server.name)"
                      >
                        <Icon icon="lucide:trash" class="h-4 w-4" />
                      </Button>
                    </TooltipTrigger>
                    <TooltipContent>
                      <p>删除服务器</p>
                    </TooltipContent>
                  </Tooltip>
                </TooltipProvider>
              </div>
            </div>
            <div class="bg-muted px-8 py-4">
              <div class="flex justify-between items-center">
                <div class="text-sm font-mono overflow-x-auto whitespace-nowrap">
                  {{ server.command }} {{ server.args.join(' ') }}
                </div>
                <span
                  v-if="server.isDefault"
                  class="ml-3 px-3 py-1 text-sm bg-primary text-primary-foreground rounded-full shrink-0"
                >
                  默认
                </span>
              </div>
            </div>
          </div>
        </div>
      </div>

      <!-- 调试工具选项卡 -->
      <div
        v-if="activeTab === 'tools'"
        class="h-full overflow-hidden grid grid-cols-[240px_1fr] gap-4"
      >
        <!-- 左侧工具列表 -->
        <div class="h-full overflow-y-auto border-r pr-4">
          <input
            type="text"
            class="w-full h-8 px-2 text-sm rounded-md border mb-3"
            placeholder="搜索工具..."
          />

          <div v-if="isToolsLoading" class="flex justify-center py-4">
            <Icon icon="lucide:loader" class="h-6 w-6 animate-spin" />
          </div>

          <div
            v-else-if="tools.length === 0"
            class="text-center py-4 text-sm text-muted-foreground"
          >
            暂无可用工具
          </div>

          <div v-else class="space-y-1">
            <div
              v-for="tool in tools"
              :key="tool.function.name"
              class="p-2 rounded-md cursor-pointer hover:bg-accent text-sm"
              :class="{ 'bg-accent': selectedTool?.function.name === tool.function.name }"
              @click="selectTool(tool)"
            >
              <div class="font-medium">{{ tool.function.name }}</div>
              <div class="text-xs text-muted-foreground line-clamp-2 mt-1">
                {{ tool.function.description }}
              </div>
            </div>
          </div>
        </div>

        <!-- 右侧操作区域 -->
        <div class="h-full overflow-y-auto px-2">
          <div v-if="!selectedTool" class="text-center text-sm text-muted-foreground py-8">
            请从左侧选择要调试的工具
          </div>

          <div v-else>
            <div class="mb-4">
              <h3 class="text-base font-medium mb-1">{{ selectedTool.function.name }}</h3>
              <p class="text-sm text-muted-foreground">{{ selectedTool.function.description }}</p>
            </div>

            <!-- 工具参数输入 -->
            <div class="space-y-4 mb-4">
              <!-- 路径输入 -->
              <div class="space-y-1.5">
                <label class="text-sm font-medium">
                  路径
                  <span class="text-red-500">*</span>
                </label>
                <input
                  v-model="toolInputs[selectedTool.function.name].path"
                  type="text"
                  class="flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-2 text-sm shadow-sm transition-colors file:border-0 file:bg-transparent file:text-sm file:font-medium placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50"
                  placeholder="输入文件路径"
                />
              </div>

              <!-- search_files 工具的额外参数 -->
              <template v-if="selectedTool.function.name === 'search_files'">
                <div class="space-y-1.5">
                  <label class="text-sm font-medium">
                    搜索模式
                    <span class="text-red-500">*</span>
                  </label>
                  <input
                    v-model="toolInputs[selectedTool.function.name].regex"
                    type="text"
                    class="flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-2 text-sm shadow-sm transition-colors file:border-0 file:bg-transparent file:text-sm file:font-medium placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50"
                    placeholder="输入正则表达式"
                  />
                </div>

                <div class="space-y-1.5">
                  <label class="text-sm font-medium"> 文件模式 </label>
                  <input
                    v-model="toolInputs[selectedTool.function.name].file_pattern"
                    type="text"
                    class="flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-2 text-sm shadow-sm transition-colors file:border-0 file:bg-transparent file:text-sm file:font-medium placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50"
                    placeholder="输入文件模式，例如: *.md"
                  />
                </div>
              </template>
            </div>

            <!-- 调用按钮和结果显示 -->
            <div class="space-y-3">
              <Button
                class="w-full"
                :disabled="isToolLoading[selectedTool.function.name]"
                @click="callTool(selectedTool.function.name)"
              >
                <Icon
                  v-if="isToolLoading[selectedTool.function.name]"
                  icon="lucide:loader"
                  class="mr-2 h-4 w-4 animate-spin"
                />
                {{ isToolLoading[selectedTool.function.name] ? '正在执行工具' : '执行工具' }}
              </Button>

              <div v-if="toolResults[selectedTool.function.name]" class="mt-3">
                <div class="text-sm font-medium mb-1">执行结果</div>
                <pre class="bg-muted p-3 rounded-md text-sm overflow-auto">{{
                  toolResults[selectedTool.function.name]
                }}</pre>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  </div>

  <!-- 编辑服务器对话框 -->
  <Dialog v-model:open="isEditServerDialogOpen">
    <DialogContent class="sm:max-w-[425px]">
      <DialogHeader>
        <DialogTitle>编辑服务器</DialogTitle>
        <DialogDescription> 编辑MCP服务器配置 </DialogDescription>
      </DialogHeader>
      <McpServerForm
        v-if="selectedServer && mcpConfig.mcpServers[selectedServer]"
        :server-name="selectedServer"
        :initial-config="mcpConfig.mcpServers[selectedServer]"
        :edit-mode="true"
        @submit="(name, config) => handleEditServer(name, config)"
      />
    </DialogContent>
  </Dialog>
</template>
