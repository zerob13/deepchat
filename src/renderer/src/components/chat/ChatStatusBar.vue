<template>
  <div class="w-full max-w-2xl flex items-center justify-between px-1 py-2">
    <div class="flex items-center gap-1">
      <!-- Model selector -->
      <DropdownMenu>
        <DropdownMenuTrigger as-child>
          <Button
            variant="ghost"
            size="sm"
            class="h-6 px-2 gap-1 text-xs text-muted-foreground hover:text-foreground backdrop-blur-lg"
          >
            <ModelIcon
              :model-id="displayProviderId"
              custom-class="w-3.5 h-3.5"
              :is-dark="themeStore.isDark"
            />
            <span>{{ displayModelName }}</span>
            <Icon icon="lucide:chevron-down" class="w-3 h-3" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" class="min-w-0 max-h-64 overflow-y-auto">
          <template v-for="group in flatModels" :key="group.providerId + '/' + group.model.id">
            <DropdownMenuItem
              class="gap-2 text-xs py-1.5 px-2"
              @click="selectModel(group.providerId, group.model.id)"
            >
              <ModelIcon
                :model-id="group.providerId"
                custom-class="w-3.5 h-3.5"
                :is-dark="themeStore.isDark"
              />
              <span>{{ group.model.name }}</span>
            </DropdownMenuItem>
          </template>
        </DropdownMenuContent>
      </DropdownMenu>

      <!-- Effort selector (hide for ACP agents — they don't have effort settings) -->
      <DropdownMenu v-if="!isAcpAgent">
        <DropdownMenuTrigger as-child>
          <Button
            variant="ghost"
            size="sm"
            class="h-6 px-2 gap-1 text-xs text-muted-foreground hover:text-foreground backdrop-blur-lg"
          >
            <Icon icon="lucide:gauge" class="w-3.5 h-3.5" />
            <span>{{ currentEffortLabel }}</span>
            <Icon icon="lucide:chevron-down" class="w-3 h-3" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" class="min-w-0">
          <DropdownMenuItem
            v-for="option in effortOptions"
            :key="option.value"
            class="text-xs py-1.5 px-2"
            @click="selectEffort(option.value)"
          >
            {{ option.label }}
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>

    <!-- Permissions (interactive selector) -->
    <DropdownMenu>
      <DropdownMenuTrigger as-child>
        <Button
          variant="ghost"
          size="sm"
          class="h-6 px-2 gap-1.5 text-xs text-muted-foreground hover:text-foreground backdrop-blur-lg"
          :disabled="!hasActiveSession"
        >
          <Icon icon="lucide:shield" class="w-3.5 h-3.5" />
          <span>{{ permissionModeLabel }}</span>
          <Icon icon="lucide:chevron-down" class="w-3 h-3" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" class="min-w-0">
        <DropdownMenuItem class="text-xs py-1.5 px-2" @click="selectPermissionMode('default')">
          Default
        </DropdownMenuItem>
        <DropdownMenuItem
          class="text-xs py-1.5 px-2"
          @click="selectPermissionMode('full')"
          :disabled="!canEnableFullAccess"
        >
          Full access
          <span v-if="!canEnableFullAccess" class="ml-2 text-muted-foreground"
            >(Bind workspace first)</span
          >
        </DropdownMenuItem>
        <DropdownMenuSeparator v-if="!canEnableFullAccess" />
        <DropdownMenuItem
          v-if="!canEnableFullAccess"
          class="text-xs py-1.5 px-2"
          @click="bindWorkspace"
        >
          <Icon icon="lucide:folder" class="w-3 h-3 mr-2" />
          {{ t('components.chatStatusBar.bindWorkspace') }}
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem
          class="text-xs py-1.5 px-2"
          @click="openPermissionManagement"
          :disabled="!hasActiveSession"
        >
          <Icon icon="lucide:settings" class="w-3 h-3 mr-2" />
          {{ t('components.chatStatusBar.managePermissions') }}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue'
import { useRouter } from 'vue-router'
import { useI18n } from 'vue-i18n'
import { Button } from '@shadcn/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger
} from '@shadcn/components/ui/dropdown-menu'
import { Icon } from '@iconify/vue'
import ModelIcon from '../icons/ModelIcon.vue'
import { useThemeStore } from '@/stores/theme'
import { useChatStore } from '@/stores/chat'
import { useModelStore } from '@/stores/modelStore'
import { useAgentStore } from '@/stores/ui/agent'
import { useSessionStore } from '@/stores/ui/session'
import type { RENDERER_MODEL_META } from '@shared/presenter'
import type { PermissionMode } from '@shared/types/agent-interface'
import { usePresenter } from '@/composables/usePresenter'

const { t } = useI18n()
const router = useRouter()

const themeStore = useThemeStore()
const chatStore = useChatStore()
const modelStore = useModelStore()
const agentStore = useAgentStore()
const sessionStore = useSessionStore()
const newAgentPresenter = usePresenter('newAgentPresenter')

// Determine if we're in an active session or on NewThreadPage
const hasActiveSession = computed(() => sessionStore.hasActiveSession)

// Determine the effective agent context
const isAcpAgent = computed(() => {
  if (hasActiveSession.value) {
    // In active session: check the session's chatMode
    return chatStore.chatConfig.chatMode === 'acp agent'
  }
  // On NewThreadPage: check sidebar agent selection
  const agentId = agentStore.selectedAgentId
  return agentId !== null && agentId !== 'deepchat'
})

// Resolve display provider ID
const displayProviderId = computed(() => {
  console.log('[ChatStatusBar] Config state:', {
    hasActiveSession: hasActiveSession.value,
    chatConfigLoaded: !!chatStore.chatConfig.modelId,
    configLoading: chatStore.configLoading,
    modelId: chatStore.chatConfig.modelId,
    providerId: chatStore.chatConfig.providerId
  })

  // Priority 1: Use session's provider when in active session
  if (hasActiveSession.value) {
    const session = sessionStore.activeSession
    if (session?.providerId) {
      console.log('[ChatStatusBar] displayProviderId: using session provider', session.providerId)
      return session.providerId
    }
  }

  // Priority 2: Use chatConfig provider (from settings or user selection)
  if (chatStore.chatConfig.providerId && chatStore.chatConfig.providerId.trim()) {
    console.log(
      '[ChatStatusBar] displayProviderId: using chatConfig provider',
      chatStore.chatConfig.providerId
    )
    return chatStore.chatConfig.providerId
  }

  // Priority 3: Fallback to first available
  const firstProvider = modelStore.enabledModels[0]?.providerId
  console.log('[ChatStatusBar] displayProviderId: fallback to first provider', firstProvider)
  return firstProvider || 'anthropic'
})

// Resolve display model name
const displayModelName = computed(() => {
  // Priority 1: Use session's model when in active session
  if (hasActiveSession.value) {
    const session = sessionStore.activeSession
    if (session?.modelId) {
      const found = modelStore.findModelByIdOrName(session.modelId)
      console.log('[ChatStatusBar] displayModelName: using session model', {
        sessionModelId: session.modelId,
        found: found?.model.name
      })
      if (found) return found.model.name
      return session.modelId // Return ID if model not found (might be disabled)
    }
  }

  // Priority 2: Use chatConfig model (from settings)
  const modelId = chatStore.chatConfig.modelId
  console.log('[ChatStatusBar] displayModelName: chatConfig.modelId:', modelId)

  if (modelId && modelId.trim()) {
    const found = modelStore.findModelByIdOrName(modelId)
    console.log('[ChatStatusBar] displayModelName: using chatConfig model', {
      chatConfigModelId: modelId,
      found: found?.model.name
    })
    if (found) return found.model.name
    return modelId
  }

  // Priority 3: Check if config is still loading
  if (chatStore.configLoading) {
    console.log('[ChatStatusBar] displayModelName: config still loading, showing Loading...')
    return 'Loading...'
  }

  // Priority 4: Fallback to first available (only after config is loaded)
  const firstModel = modelStore.enabledModels[0]?.models[0]
  console.log('[ChatStatusBar] displayModelName: fallback to first model', firstModel?.name)
  if (firstModel) return firstModel.name
  return 'Select model'
})

const flatModels = computed(() => {
  const result: { providerId: string; model: RENDERER_MODEL_META }[] = []
  for (const group of modelStore.enabledModels) {
    for (const model of group.models) {
      result.push({ providerId: group.providerId, model })
    }
  }
  return result
})

async function selectModel(providerId: string, modelId: string) {
  await chatStore.updateChatConfig({ providerId, modelId })
}

// Effort
const effortOptions = [
  { label: 'Low', value: 'low' as const },
  { label: 'Medium', value: 'medium' as const },
  { label: 'High', value: 'high' as const }
]

const currentEffortLabel = computed(() => {
  const config = chatStore.chatConfig
  const effort = config.reasoningEffort ?? config.verbosity ?? 'high'
  const option = effortOptions.find((o) => o.value === effort)
  return option?.label ?? effort.charAt(0).toUpperCase() + effort.slice(1)
})

async function selectEffort(value: 'low' | 'medium' | 'high') {
  await chatStore.updateChatConfig({ reasoningEffort: value })
}

// Permission mode
const permissionModeLabel = computed(() => {
  if (!hasActiveSession.value) return 'Default permissions'
  const session = sessionStore.activeSession
  if (!session) return 'Default permissions'
  return session.permissionMode === 'full' ? 'Full access' : 'Default permissions'
})

const canEnableFullAccess = computed(() => {
  if (!hasActiveSession.value) return false
  const session = sessionStore.activeSession
  return !!session?.projectDir
})

async function selectPermissionMode(mode: PermissionMode) {
  if (!hasActiveSession.value) return
  const session = sessionStore.activeSession
  if (!session) return

  // Update session in presenter
  await newAgentPresenter.setSessionPermissionMode(session.id, mode)

  // Update local session store
  sessionStore.updateSession(session.id, { permissionMode: mode })
}

async function openPermissionManagement() {
  if (!hasActiveSession.value) return
  await router.push('/session-permissions')
}

async function bindWorkspace() {
  if (!hasActiveSession.value) return
  const session = sessionStore.activeSession
  if (!session) return

  try {
    console.log('[ChatStatusBar] Binding workspace for session:', session.id)
    const selectedPath = await newAgentPresenter.bindWorkspace(session.id)
    console.log('[ChatStatusBar] Selected path:', selectedPath)

    if (selectedPath) {
      // Update local session store
      sessionStore.updateSession(session.id, { projectDir: selectedPath })
      console.log('[ChatStatusBar] Updated session projectDir:', selectedPath)

      // Auto-enable Full access after binding
      await newAgentPresenter.setSessionPermissionMode(session.id, 'full')
      sessionStore.updateSession(session.id, { permissionMode: 'full' })
      console.log('[ChatStatusBar] Set permission mode to full')
    }
  } catch (error) {
    console.error('[ChatStatusBar] Failed to bind workspace:', error)
  }
}
</script>
