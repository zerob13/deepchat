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
    </div>
    
    <!-- 环境变量 -->
    <div class="space-y-2">
      <Label for="server-env">{{ t('mcp.serverForm.env') }}</Label>
      <Textarea 
        id="server-env" 
        v-model="env" 
        rows="5" 
        :placeholder="t('mcp.serverForm.envPlaceholder')"
        :class="{ 'border-red-500': !isEnvValid }"
        required
      />
    </div>
    
    <!-- 描述 -->
    <div class="space-y-2">
      <Label for="server-description">{{ t('mcp.serverForm.descriptions') }}</Label>
      <Input 
        id="server-description" 
        v-model="descriptions" 
        :placeholder="t('mcp.serverForm.descriptionsPlaceholder')"
      />
    </div>
    
    <!-- 图标 -->
    <div class="space-y-2">
      <Label for="server-icon">{{ t('mcp.serverForm.icons') }}</Label>
      <Input 
        id="server-icon" 
        v-model="icons" 
        :placeholder="t('mcp.serverForm.iconsPlaceholder')"
      />
    </div>
    
    <!-- 自动授权选项 -->
    <div class="space-y-2">
      <Label>{{ t('mcp.serverForm.autoApprove') }}</Label>
      <div class="flex flex-col space-y-2">
        <div class="flex items-center space-x-2">
          <Checkbox 
            id="auto-approve-all"
            v-model:checked="autoApproveAll"
            @update:checked="handleAutoApproveAllChange"
          />
          <label 
            for="auto-approve-all" 
            class="text-sm font-medium leading-none peer-disabled:cursor-not-allowed peer-disabled:opacity-70"
          >
            {{ t('mcp.serverForm.autoApproveAll') }}
          </label>
        </div>
        
        <div class="flex items-center space-x-2">
          <Checkbox 
            id="auto-approve-read"
            v-model:checked="autoApproveRead"
          />
          <label 
            for="auto-approve-read" 
            class="text-sm font-medium leading-none peer-disabled:cursor-not-allowed peer-disabled:opacity-70"
          >
            {{ t('mcp.serverForm.autoApproveRead') }}
          </label>
        </div>
        
        <div class="flex items-center space-x-2">
          <Checkbox 
            id="auto-approve-write"
            v-model:checked="autoApproveWrite"
          />
          <label 
            for="auto-approve-write" 
            class="text-sm font-medium leading-none peer-disabled:cursor-not-allowed peer-disabled:opacity-70"
          >
            {{ t('mcp.serverForm.autoApproveWrite') }}
          </label>
        </div>
      </div>
    </div>
    
    <!-- 提交按钮 -->
    <div class="flex justify-end pt-2">
      <Button 
        type="submit" 
        :disabled="!isFormValid"
      >
        {{ t('mcp.serverForm.submit') }}
      </Button>
    </div>
  </form>
</template> 