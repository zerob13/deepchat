<template>
  <div class="h-full flex flex-col bg-background">
    <!-- Header -->
    <div class="border-b px-6 py-4">
      <div class="flex items-center justify-between">
        <div class="flex items-center gap-3">
          <Icon icon="lucide:shield" class="w-5 h-5 text-muted-foreground" />
          <h2 class="text-lg font-semibold">{{ t('pages.sessionPermissions.title') }}</h2>
        </div>
        <Button variant="ghost" size="sm" @click="closePage">
          <Icon icon="lucide:x" class="w-4 h-4" />
        </Button>
      </div>
    </div>

    <!-- Content -->
    <div class="flex-1 overflow-auto p-6">
      <!-- Session Info -->
      <div v-if="session" class="mb-6 p-4 rounded-lg border bg-card">
        <div class="flex items-center justify-between mb-2">
          <h3 class="text-sm font-medium">{{ t('pages.sessionPermissions.currentSession') }}</h3>
          <Badge :variant="session.permissionMode === 'full' ? 'default' : 'secondary'">
            {{
              session.permissionMode === 'full'
                ? t('pages.sessionPermissions.fullAccess')
                : t('pages.sessionPermissions.defaultPermissions')
            }}
          </Badge>
        </div>
        <div class="text-xs text-muted-foreground">
          <div class="flex items-center gap-2 mb-1">
            <Icon icon="lucide:message-square" class="w-3 h-3" />
            <span>{{ session.title }}</span>
          </div>
          <div v-if="session.projectDir" class="flex items-center gap-2">
            <Icon icon="lucide:folder" class="w-3 h-3" />
            <span class="truncate">{{ session.projectDir }}</span>
          </div>
        </div>
      </div>

      <!-- Add New Rule -->
      <div class="mb-6 p-4 rounded-lg border bg-card">
        <h3 class="text-sm font-medium mb-3">{{ t('pages.sessionPermissions.addRule') }}</h3>
        <div class="grid gap-3">
          <div class="grid gap-2">
            <Label for="toolName">{{ t('pages.sessionPermissions.toolName') }}</Label>
            <Input
              id="toolName"
              v-model="newRule.toolName"
              :placeholder="t('pages.sessionPermissions.toolNamePlaceholder')"
            />
          </div>
          <div class="grid gap-2">
            <Label for="pathPattern">{{ t('pages.sessionPermissions.pathPattern') }}</Label>
            <Input
              id="pathPattern"
              v-model="newRule.pathPattern"
              :placeholder="t('pages.sessionPermissions.pathPatternPlaceholder')"
            />
            <p class="text-xs text-muted-foreground">
              {{ t('pages.sessionPermissions.patternHelp') }}
            </p>
          </div>
          <Button class="w-fit" :disabled="!canAddRule" @click="addRule">
            <Icon icon="lucide:plus" class="w-4 h-4 mr-2" />
            {{ t('pages.sessionPermissions.addRule') }}
          </Button>
        </div>
      </div>

      <!-- Whitelist Rules -->
      <div>
        <div class="flex items-center justify-between mb-3">
          <h3 class="text-sm font-medium">
            {{ t('pages.sessionPermissions.whitelistRules') }}
            <span class="text-xs text-muted-foreground ml-2">({{ whitelistRules.length }})</span>
          </h3>
        </div>

        <div v-if="whitelistRules.length === 0" class="text-center py-8 text-muted-foreground">
          <Icon icon="lucide:shield-off" class="w-8 h-8 mx-auto mb-2 opacity-50" />
          <p class="text-sm">{{ t('pages.sessionPermissions.noRules') }}</p>
        </div>

        <div v-else class="space-y-2">
          <div
            v-for="rule in whitelistRules"
            :key="rule.id"
            class="flex items-center justify-between p-3 rounded-md border bg-card hover:bg-accent/50 transition-colors"
          >
            <div class="flex-1 min-w-0">
              <div class="flex items-center gap-2 mb-1">
                <Badge variant="outline" class="text-xs">
                  {{ rule.toolName }}
                </Badge>
              </div>
              <div class="text-xs text-muted-foreground font-mono truncate">
                {{ rule.pathPattern }}
              </div>
            </div>
            <div class="flex items-center gap-2">
              <span class="text-xs text-muted-foreground">
                {{ formatTime(rule.createdAt) }}
              </span>
              <Button variant="ghost" size="sm" @click="removeRule(rule.id)">
                <Icon icon="lucide:trash-2" class="w-4 h-4" />
              </Button>
            </div>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, onMounted } from 'vue'
import { useI18n } from 'vue-i18n'
import { Icon } from '@iconify/vue'
import { Button } from '@shadcn/components/ui/button'
import { Input } from '@shadcn/components/ui/input'
import { Label } from '@shadcn/components/ui/label'
import { Badge } from '@shadcn/components/ui/badge'
import { usePresenter } from '@/composables/usePresenter'
import { useSessionStore } from '@/stores/ui/session'
import type { SessionWithState } from '@shared/types/agent-interface'

const { t } = useI18n()
const newAgentPresenter = usePresenter('newAgentPresenter')
const sessionStore = useSessionStore()

const session = ref<SessionWithState | null>(null)
const whitelistRules = ref<
  Array<{
    id: string
    sessionId: string
    toolName: string
    pathPattern: string
    createdAt: number
  }>
>([])

const newRule = ref({
  toolName: '',
  pathPattern: ''
})

const canAddRule = computed(() => {
  return newRule.value.toolName.trim() && newRule.value.pathPattern.trim()
})

onMounted(async () => {
  // Get active session
  session.value = sessionStore.activeSession

  if (session.value) {
    await loadWhitelistRules()
  }
})

async function loadWhitelistRules() {
  if (!session.value) return

  try {
    whitelistRules.value = await newAgentPresenter.getWhitelist(session.value.id)
  } catch (error) {
    console.error('Failed to load whitelist rules:', error)
  }
}

async function addRule() {
  if (!session.value || !canAddRule.value) return

  try {
    await newAgentPresenter.addToWhitelist(
      session.value.id,
      newRule.value.toolName.trim(),
      newRule.value.pathPattern.trim()
    )
    newRule.value = { toolName: '', pathPattern: '' }
    await loadWhitelistRules()
  } catch (error) {
    console.error('Failed to add whitelist rule:', error)
  }
}

async function removeRule(ruleId: string) {
  if (!session.value) return

  try {
    await newAgentPresenter.removeFromWhitelist(session.value.id, ruleId)
    await loadWhitelistRules()
  } catch (error) {
    console.error('Failed to remove whitelist rule:', error)
  }
}

function formatTime(timestamp: number): string {
  const date = new Date(timestamp)
  const now = new Date()
  const diff = now.getTime() - date.getTime()

  // Less than 1 minute
  if (diff < 60000) {
    return t('common.time.justNow')
  }

  // Less than 1 hour
  if (diff < 3600000) {
    return t('common.time.minutesAgo', { minutes: Math.floor(diff / 60000) })
  }

  // Less than 24 hours
  if (diff < 86400000) {
    return t('common.time.hoursAgo', { hours: Math.floor(diff / 3600000) })
  }

  // Otherwise show date
  return date.toLocaleDateString()
}

function closePage() {
  // Navigate back or close modal
  window.history.back()
}
</script>
