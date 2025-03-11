<script setup lang="ts">
import { ref, computed } from 'vue'
import { useI18n } from 'vue-i18n'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import { Checkbox } from '@/components/ui/checkbox'
import { MCPServerConfig } from '@shared/presenter'

const { t } = useI18n()

const props = defineProps<{
  serverName?: string
  initialConfig?: MCPServerConfig
  editMode?: boolean
}>()

const emit = defineEmits<{
  submit: [serverName: string, config: MCPServerConfig]
}>()

// 表单状态
const name = ref(props.serverName || '')
const command = ref(props.initialConfig?.command || 'npx')
const args = ref(props.initialConfig?.args?.join(' ') || '')
const env = ref(JSON.stringify(props.initialConfig?.env || {}, null, 2))
const descriptions = ref(props.initialConfig?.descriptions || '')
const icons = ref(props.initialConfig?.icons || '📁')

// 权限设置
const autoApproveAll = ref(props.initialConfig?.autoApprove?.includes('all') || false)
const autoApproveRead = ref(props.initialConfig?.autoApprove?.includes('read') || false)
const autoApproveWrite = ref(props.initialConfig?.autoApprove?.includes('write') || false)

// 当选择 all 时，自动选中其他权限
const handleAutoApproveAllChange = (checked: boolean) => {
  if (checked) {
    autoApproveRead.value = true
    autoApproveWrite.value = true
  }
}

// 验证
const isNameValid = computed(() => name.value.trim().length > 0)
const isCommandValid = computed(() => command.value.trim().length > 0)
const isArgsValid = computed(() => args.value.trim().length > 0)
const isEnvValid = computed(() => {
  try {
    JSON.parse(env.value)
    return true
  } catch (error) {
    return false
  }
})

const isFormValid = computed(() => 
  isNameValid.value && 
  isCommandValid.value && 
  isArgsValid.value && 
  isEnvValid.value
)

// 提交表单
const handleSubmit = () => {
  if (!isFormValid.value) return
  
  // 处理自动授权设置
  const autoApprove: string[] = []
  if (autoApproveAll.value) {
    autoApprove.push('all')
  } else {
    if (autoApproveRead.value) autoApprove.push('read')
    if (autoApproveWrite.value) autoApprove.push('write')
  }
  
  const serverConfig: MCPServerConfig = {
    command: command.value.trim(),
    args: args.value.split(/\s+/).filter(Boolean),
    env: JSON.parse(env.value),
    descriptions: descriptions.value.trim(),
    icons: icons.value.trim(),
    autoApprove
  }
  
  emit('submit', name.value.trim(), serverConfig)
}
</script>

<template>
  <form @submit.prevent="handleSubmit" class="space-y-4">
    <!-- 服务器名称 -->
    <div class="space-y-2">
      <Label for="server-name">{{ t('mcp.serverForm.name') }}</Label>
      <Input 
        id="server-name" 
        v-model="name" 
        :placeholder="t('mcp.serverForm.namePlaceholder')"
        :disabled="editMode"
        required
      />
      <p v-if="!isNameValid && name.length > 0" class="text-sm text-red-500">
        {{ t('mcp.serverForm.nameRequired') }}
      </p>
    </div>
    
    <!-- 命令 -->
    <div class="space-y-2">
      <Label for="server-command">{{ t('mcp.serverForm.command') }}</Label>
      <Input 
        id="server-command" 
        v-model="command" 
        :placeholder="t('mcp.serverForm.commandPlaceholder')"
        required
      />
      <p v-if="!isCommandValid && command.length > 0" class="text-sm text-red-500">
        {{ t('mcp.serverForm.commandRequired') }}
      </p>
    </div>
    
    <!-- 参数 -->
    <div class="space-y-2">
      <Label for="server-args">{{ t('mcp.serverForm.args') }}</Label>
      <Input 
        id="server-args" 
        v-model="args" 
        :placeholder="t('mcp.serverForm.argsPlaceholder')"
        required
      />
      <p v-if="!isArgsValid && args.length > 0" class="text-sm text-red-500">
        {{ t('mcp.serverForm.argsRequired') }}
      </p>
    </div>
    
    <!-- 环境变量 -->
    <div class="space-y-2">
      <Label for="server-env">{{ t('mcp.serverForm.env') }}</Label>
      <Textarea 
        id="server-env" 
        v-model="env" 
        :placeholder="t('mcp.serverForm.envPlaceholder')"
        rows="4"
        class="font-mono text-xs"
        required
      />
      <p v-if="!isEnvValid && env.length > 0" class="text-sm text-red-500">
        {{ t('mcp.serverForm.envInvalid') }}
      </p>
    </div>
    
    <!-- 描述 -->
    <div class="space-y-2">
      <Label for="server-description">{{ t('mcp.serverForm.description') }}</Label>
      <Input 
        id="server-description" 
        v-model="descriptions" 
        :placeholder="t('mcp.serverForm.descriptionPlaceholder')"
      />
    </div>
    
    <!-- 图标 -->
    <div class="space-y-2">
      <Label for="server-icon">{{ t('mcp.serverForm.icon') }}</Label>
      <Input 
        id="server-icon" 
        v-model="icons" 
        :placeholder="t('mcp.serverForm.iconPlaceholder')"
      />
    </div>
    
    <!-- 自动授权设置 -->
    <div class="space-y-2">
      <Label>{{ t('mcp.serverForm.autoApprove') || '自动授权设置' }}</Label>
      <div class="space-y-2">
        <div class="flex items-center space-x-2">
          <Checkbox 
            id="auto-approve-all" 
            v-model:checked="autoApproveAll"
            @update:checked="handleAutoApproveAllChange"
          />
          <Label for="auto-approve-all" class="cursor-pointer">
            {{ t('mcp.serverForm.autoApproveAll') || '所有操作 (all)' }}
          </Label>
        </div>
        
        <div class="flex items-center space-x-2">
          <Checkbox 
            id="auto-approve-read" 
            v-model:checked="autoApproveRead"
            :disabled="autoApproveAll"
          />
          <Label for="auto-approve-read" class="cursor-pointer">
            {{ t('mcp.serverForm.autoApproveRead') || '读取操作 (read)' }}
          </Label>
        </div>
        
        <div class="flex items-center space-x-2">
          <Checkbox 
            id="auto-approve-write" 
            v-model:checked="autoApproveWrite"
            :disabled="autoApproveAll"
          />
          <Label for="auto-approve-write" class="cursor-pointer">
            {{ t('mcp.serverForm.autoApproveWrite') || '写入操作 (write)' }}
          </Label>
        </div>
      </div>
      <p class="text-xs text-muted-foreground">
        {{ t('mcp.serverForm.autoApproveHelp') || '选择需要自动授权的操作类型，无需用户确认即可执行' }}
      </p>
    </div>
    
    <!-- 提交按钮 -->
    <div class="flex justify-end">
      <Button type="submit" :disabled="!isFormValid">
        {{ editMode ? t('mcp.serverForm.update') : t('mcp.serverForm.add') }}
      </Button>
    </div>
  </form>
</template>
