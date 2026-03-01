# Implementation Tasks - Event Flow and UI Bindings

**Date:** 2026-02-28  
**Branch:** `feat/new-arch-complete`  
**Priority:** P0 (Critical) → P1 (Should Have) → P2 (Nice to Have)

## Architecture Decisions

### User Decisions (2026-02-28)

1. **Permission Timeout:** ❌ NO TIMEOUT — Permission request pauses loop indefinitely until user explicitly approves/denies
2. **Multi-window Support:** ❌ NOT NEEDED — Single window, single activeSessionId is correct (no multi-tab)
3. **Concurrent Session Generation:** ✅ YES — Add `generatingSessionIds: Set<string>` for power users
4. **Retry Behavior:** ✅ MANUAL RETRY — User reviews/edits before retrying, no auto-retry

**Core Principle:** Don't simplify away essential complexity, but don't add unnecessary automation. User control and clarity first.

---

## P0: Critical UI Bindings

### Task P0-1: Add generatingSessionIds to sessionStore

**File:** `src/renderer/src/stores/ui/session.ts`

**Current State:**
```typescript
const sessions = ref<UISession[]>([])
const activeSessionId = ref<string | null>(null)
```

**Required Change:**
```typescript
// Add new state
const generatingSessionIds = ref<Set<string>>(new Set())

// Update STATUS_CHANGED handler
window.electron.ipcRenderer.on(
  SESSION_EVENTS.STATUS_CHANGED,
  (_, msg: { sessionId: string; status: string }) => {
    const session = sessions.value.find((s) => s.id === msg.sessionId)
    if (session) {
      session.status = mapSessionStatus(msg.status)
      // Track generating sessions
      if (msg.status === 'generating') {
        generatingSessionIds.value.add(msg.sessionId)
      } else {
        generatingSessionIds.value.delete(msg.sessionId)
      }
    }
  }
)

// Export in return statement
return {
  // ...existing
  generatingSessionIds,
  isSessionGenerating: (sessionId: string) => generatingSessionIds.value.has(sessionId)
}
```

**Expected Behavior:**
- O(1) lookup to check if session is generating
- `generatingSessionIds` stays in sync with backend status

**Test Case:**
```typescript
// In component
const sessionStore = useSessionStore()
const isGenerating = sessionStore.isSessionGenerating(activeSessionId.value)
// Should return true when backend emits STATUS_CHANGED('generating')
```

---

### Task P0-2: Add cancelGenerating method to sessionStore

**File:** `src/renderer/src/stores/ui/session.ts`

**Current State:**
No cancel method exists.

**Required Change:**
```typescript
async function cancelGenerating(sessionId: string): Promise<void> {
  try {
    await newAgentPresenter.cancelGeneration(sessionId)
    // Backend will emit STATUS_CHANGED('idle'), which will update generatingSessionIds
  } catch (e) {
    error.value = `Failed to cancel generation: ${e}`
    throw e
  }
}

// Add to return
return {
  // ...existing
  cancelGenerating
}
```

**Expected Behavior:**
- Calls backend to cancel generation
- Backend emits STATUS_CHANGED('idle')
- generatingSessionIds automatically updated via event listener

**Test Case:**
```typescript
await sessionStore.cancelGenerating(sessionId)
// Session status should change to 'idle'
// generatingSessionIds should not contain sessionId
```

---

### Task P0-3: Update ChatInput to use sessionStore

**File:** `src/renderer/src/components/chat-input/ChatInput.vue`

**Current State:**
```typescript
import { useChatStore } from '@/stores/chat'
const chatStore = useChatStore()

const handleCancel = () => {
  if (!chatStore.getActiveThreadId()) return
  chatStore.cancelGenerating(chatStore.getActiveThreadId()!)
}
```

**Required Change:**
```typescript
// Add import
import { useSessionStore } from '@/stores/ui/session'
const sessionStore = useSessionStore()

// Update handleCancel
const handleCancel = () => {
  if (!sessionStore.activeSessionId) return
  sessionStore.cancelGenerating(sessionStore.activeSessionId)
}

// Update disabledSend computation to check session status
const isGenerating = computed(() => {
  if (!sessionStore.activeSessionId) return false
  return sessionStore.generatingSessionIds.has(sessionStore.activeSessionId)
})

const disabledSend = computed(() => {
  // Existing checks...
  || isGenerating.value
})
```

**Expected Behavior:**
- Stop button calls correct store
- Input disabled when session is generating

**Test Case:**
1. Start generation
2. Input should become disabled
3. Click stop button
4. Generation should cancel
5. Input should become enabled

---

### Task P0-4: Add disabled and stop props to ChatInputBox

**File:** `src/renderer/src/components/chat/ChatInputBox.vue`

**Current State:**
```vue
<template>
  <div class="w-full max-w-2xl rounded-xl border bg-card/30 backdrop-blur-lg shadow-sm overflow-hidden">
    <Textarea
      :placeholder="placeholder"
      :model-value="modelValue ?? ''"
      @update:model-value="$emit('update:modelValue', $event)"
      @keydown="handleKeydown"
    />
    <slot name="toolbar" />
  </div>
</template>

<script setup lang="ts">
defineProps<{
  modelValue?: string
  placeholder?: string
}>()
</script>
```

**Required Change:**
```vue
<template>
  <div class="w-full max-w-2xl rounded-xl border bg-card/30 backdrop-blur-lg shadow-sm overflow-hidden">
    <Textarea
      :placeholder="placeholder"
      :model-value="modelValue ?? ''"
      :disabled="disabled"
      @update:model-value="$emit('update:modelValue', $event)"
      @keydown="handleKeydown"
    />
    
    <slot name="toolbar" />
    
    <!-- Stop button overlay -->
    <div v-if="showStopButton" class="absolute top-2 right-2">
      <Button
        variant="outline"
        size="sm"
        @click="$emit('stop')"
      >
        <Icon icon="lucide:square" class="w-4 h-4 text-red-500" />
        Stop
      </Button>
    </div>
  </div>
</template>

<script setup lang="ts">
defineProps<{
  modelValue?: string
  placeholder?: string
  disabled?: boolean
  showStopButton?: boolean
}>()

defineEmits<{
  'update:modelValue': [value: string]
  submit: []
  stop: []
}>()
</script>
```

**Expected Behavior:**
- Textarea disabled when `disabled` prop is true
- Stop button appears when `showStopButton` is true
- Stop button emits 'stop' event when clicked

**Test Case:**
```vue
<ChatInputBox
  :disabled="sessionStore.generatingSessionIds.has(sessionId)"
  :showStopButton="sessionStore.generatingSessionIds.has(sessionId)"
  @stop="sessionStore.cancelGenerating(sessionId)"
/>
```

---

### Task P0-5: Update ChatStatusBar to use sessionStore

**File:** `src/renderer/src/components/chat/ChatStatusBar.vue`

**Current State:**
```typescript
import { useChatStore } from '@/stores/chat'
const chatStore = useChatStore()

const displayProviderId = computed(() => {
  if (hasActiveSession.value) {
    return chatStore.chatConfig.providerId
  }
  // ...
})

const displayModelName = computed(() => {
  if (hasActiveSession.value) {
    const modelId = chatStore.chatConfig.modelId
    // ...
  }
  // ...
})
```

**Required Change:**
```typescript
// Add import
import { useSessionStore } from '@/stores/ui/session'
const sessionStore = useSessionStore()

// Update computed properties
const displayProviderId = computed(() => {
  if (hasActiveSession.value) {
    return sessionStore.activeSession?.providerId || 'anthropic'
  }
  // ...existing fallback logic
})

const displayModelName = computed(() => {
  if (hasActiveSession.value) {
    const modelId = sessionStore.activeSession?.modelId
    if (modelId) {
      const found = modelStore.findModelByIdOrName(modelId)
      if (found) return found.model.name
      return modelId
    }
    return 'Select model'
  }
  // ...existing fallback logic
})

// Update selectModel to use sessionStore
async function selectModel(providerId: string, modelId: string) {
  // Need to add updateSessionConfig to sessionStore
  await sessionStore.updateSessionConfig({ providerId, modelId })
}
```

**Expected Behavior:**
- Model selector shows session's model
- Model changes update session config

**Test Case:**
1. Select different model from dropdown
2. Session's modelId should update
3. Display should reflect new model

---

### Task P0-6: Add permission selector dropdown to ChatStatusBar

**File:** `src/renderer/src/components/chat/ChatStatusBar.vue`

**Current State:**
```vue
<!-- Permissions (read-only indicator) -->
<Button
  variant="ghost"
  size="sm"
  class="h-6 px-2 gap-1.5 text-xs text-muted-foreground hover:text-foreground backdrop-blur-lg"
>
  <Icon icon="lucide:shield" class="w-3.5 h-3.5" />
  <span>Default permissions</span>
</Button>
```

**Required Change:**
```vue
<!-- Permissions (dropdown) -->
<DropdownMenu>
  <DropdownMenuTrigger as-child>
    <Button
      variant="ghost"
      size="sm"
      class="h-6 px-2 gap-1.5 text-xs text-muted-foreground hover:text-foreground backdrop-blur-lg"
    >
      <Icon icon="lucide:shield" class="w-3.5 h-3.5" />
      <span>{{ permissionLabel }}</span>
      <Icon icon="lucide:chevron-down" class="w-3 h-3" />
    </Button>
  </DropdownMenuTrigger>
  <DropdownMenuContent align="end" class="min-w-0">
    <DropdownMenuItem
      class="text-xs py-1.5 px-2"
      @click="setPermission('default')"
    >
      Default
    </DropdownMenuItem>
    <DropdownMenuItem
      class="text-xs py-1.5 px-2"
      @click="setPermission('full')"
    >
      Full Access
    </DropdownMenuItem>
  </DropdownMenuContent>
</DropdownMenu>
```

```typescript
// Add to script
const permissionLabel = computed(() => {
  const mode = sessionStore.activeSession?.permissionMode ?? 'default'
  return mode === 'default' ? 'Default permissions' : 'Full access'
})

async function setPermission(mode: 'default' | 'full') {
  if (!sessionStore.activeSessionId) return
  // Need to add updateSessionPermission to sessionStore
  await sessionStore.updateSessionPermission(sessionStore.activeSessionId, mode)
}
```

**Expected Behavior:**
- Dropdown shows current permission mode
- Can switch between Default and Full Access
- Change persists to backend

**Test Case:**
1. Click permission button
2. Select "Full Access"
3. Session permission should update
4. Label should show "Full access"

---

### Task P0-7: Add updateSessionConfig to sessionStore

**File:** `src/renderer/src/stores/ui/session.ts`

**Required Change:**
```typescript
async function updateSessionConfig(config: {
  providerId?: string
  modelId?: string
  permissionMode?: 'default' | 'full'
}): Promise<void> {
  if (!activeSessionId.value) return
  
  try {
    await newAgentPresenter.updateSessionConfig(activeSessionId.value, config)
    // Update local state
    const session = sessions.value.find(s => s.id === activeSessionId.value)
    if (session) {
      if (config.providerId) session.providerId = config.providerId
      if (config.modelId) session.modelId = config.modelId
      if (config.permissionMode) session.permissionMode = config.permissionMode
    }
  } catch (e) {
    error.value = `Failed to update session config: ${e}`
    throw e
  }
}

// Add alias for permission update
async function updateSessionPermission(sessionId: string, mode: 'default' | 'full'): Promise<void> {
  const prevActiveId = activeSessionId.value
  activeSessionId.value = sessionId
  await updateSessionConfig({ permissionMode: mode })
  activeSessionId.value = prevActiveId
}

// Add to return
return {
  // ...existing
  updateSessionConfig,
  updateSessionPermission
}
```

**Expected Behavior:**
- Updates session configuration
- Backend persists changes
- Local state stays in sync

**Note:** Requires backend method `newAgentPresenter.updateSessionConfig()` to be implemented.

---

## P1: Event Flow Completion

### Task P1-1: Add CONVERSATION_EVENTS.LIST_UPDATED listener

**File:** `src/renderer/src/stores/ui/session.ts`

**Required Change:**
```typescript
import { SESSION_EVENTS, CONVERSATION_EVENTS } from '@/events'

// Add listener alongside existing ones
window.electron.ipcRenderer.on(CONVERSATION_EVENTS.LIST_UPDATED, () => {
  fetchSessions()
})
```

**Expected Behavior:**
- Session list refreshes when conversations change
- Titles, deletions, and other changes reflected immediately

**Test Case:**
1. Rename session in another tab
2. Session list should update automatically
3. New session created elsewhere should appear

---

### Task P1-2: Sync messageStore.isStreaming with session status

**File:** `src/renderer/src/stores/ui/message.ts`

**Current State:**
```typescript
window.electron.ipcRenderer.on(
  STREAM_EVENTS.RESPONSE,
  (_, msg: { conversationId: string; blocks: AssistantMessageBlock[] }) => {
    const sessionStore = useSessionStore()
    if (msg.conversationId === sessionStore.activeSessionId) {
      isStreaming.value = true
      // ...
    }
  }
)
```

**Required Change:**
```typescript
import { useSessionStore } from './session'
import { watch } from 'vue'

const sessionStore = useSessionStore()

// Add watcher to sync with session status
watch(
  () => sessionStore.activeSession?.status,
  (status) => {
    isStreaming.value = status === 'working'
  },
  { immediate: true }
)
```

**Expected Behavior:**
- `messageStore.isStreaming` always matches session status
- No inconsistency between stores

**Test Case:**
1. Check messageStore.isStreaming when session starts
2. Should be true when session.status === 'working'
3. Should be false when session.status === 'completed'

---

### Task P1-3: Add session-specific streaming state

**File:** `src/renderer/src/stores/ui/message.ts`

**Current State:**
```typescript
const isStreaming = ref(false)  // Global flag
const streamingBlocks = ref<AssistantMessageBlock[]>([])
const currentStreamSessionId = ref<string | null>(null)
```

**Required Change:**
```typescript
// Replace global flag with session-specific tracking
const streamingSessionIds = ref<Set<string>>(new Set())

// Update RESPONSE handler
window.electron.ipcRenderer.on(
  STREAM_EVENTS.RESPONSE,
  (_, msg: { conversationId: string; blocks: AssistantMessageBlock[] }) => {
    streamingSessionIds.value.add(msg.conversationId)
    if (msg.conversationId === sessionStore.activeSessionId) {
      streamingBlocks.value = msg.blocks
    }
  }
)

// Update END handler
window.electron.ipcRenderer.on(
  STREAM_EVENTS.END,
  (_, msg: { conversationId: string }) => {
    streamingSessionIds.value.delete(msg.conversationId)
    if (msg.conversationId === sessionStore.activeSessionId) {
      streamingBlocks.value = []
      loadMessages(msg.conversationId)
    }
  }
)

// Add getter
const isSessionStreaming = (sessionId: string) => streamingSessionIds.value.has(sessionId)

// Keep isStreaming for backward compatibility (computed from active session)
const isStreaming = computed(() => 
  sessionStore.activeSessionId ? isSessionStreaming(sessionStore.activeSessionId) : false
)

// Add to return
return {
  // ...existing
  streamingSessionIds,
  isSessionStreaming,
  isStreaming  // Keep for compatibility
}
```

**Expected Behavior:**
- Can track multiple concurrent streaming sessions
- Backward compatible with existing code

**Test Case:**
1. Start generation in session A
2. Start generation in session B
3. Both should be tracked independently
4. Switch between sessions, streaming state correct for each

---

### Task P1-4: Add loading indicator to ChatPage

**File:** `src/renderer/src/pages/ChatPage.vue`

**Required Change:**
```vue
<template>
  <div ref="scrollContainer" class="h-full overflow-y-auto" @scroll="onScroll">
    <ChatTopBar :title="sessionTitle" :project="sessionProject" />
    
    <!-- Loading indicator -->
    <div v-if="isLoading" class="flex items-center justify-center py-4">
      <Icon icon="lucide:loader-2" class="w-6 h-6 text-primary animate-spin" />
      <span class="ml-2 text-sm text-muted-foreground">Generating response...</span>
    </div>
    
    <MessageList :messages="displayMessages" />
    <!-- ...rest of template -->
  </div>
</template>

<script setup lang="ts">
// Add computed
const isLoading = computed(() => {
  return sessionStore.activeSession?.status === 'working'
})

// Add watcher for toast notifications
watch(() => sessionStore.activeSession?.status, (status) => {
  if (status === 'completed') {
    // toast.success('Generation complete')
  } else if (status === 'error') {
    // toast.error('Generation failed')
  }
})
</script>
```

**Expected Behavior:**
- Loading indicator visible during generation
- Toast notification on completion/error

**Test Case:**
1. Send message
2. Loading indicator should appear
3. On completion, indicator disappears
4. Toast notification shows

---

## P2: Polish

### Task P2-1: Add typing indicator to MessageList

**File:** `src/renderer/src/components/chat/MessageList.vue`

**Required Change:**
```vue
<template>
  <div class="flex-1 overflow-y-auto">
    <div class="max-w-3xl mx-auto px-4 py-6 space-y-1">
      <template v-for="msg in messages" :key="msg.id">
        <MessageItemUser v-if="msg.role === 'user'" :message="msg" />
        <MessageItemAssistant v-else-if="msg.role === 'assistant'" :message="msg" />
      </template>
      
      <!-- Typing indicator -->
      <div v-if="isStreaming" class="flex items-center gap-2 pl-12">
        <div class="typing-indicator">
          <span class="dot"></span>
          <span class="dot"></span>
          <span class="dot"></span>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { useMessageStore } from '@/stores/ui/message'
const messageStore = useMessageStore()

const isStreaming = computed(() => messageStore.isStreaming)
</script>

<style scoped>
.typing-indicator {
  display: flex;
  gap: 4px;
  padding: 8px 12px;
  background: rgba(0, 0, 0, 0.05);
  border-radius: 8px;
}

.dot {
  width: 8px;
  height: 8px;
  background: #999;
  border-radius: 50%;
  animation: bounce 1.4s infinite ease-in-out both;
}

.dot:nth-child(1) { animation-delay: -0.32s; }
.dot:nth-child(2) { animation-delay: -0.16s; }

@keyframes bounce {
  0%, 80%, 100% { transform: scale(0); }
  40% { transform: scale(1); }
}
</style>
```

**Expected Behavior:**
- Animated dots appear during streaming
- Disappears when streaming ends

---

### Task P2-2: Add progress indicator to ChatTopBar

**File:** `src/renderer/src/components/chat/ChatTopBar.vue`

**Required Change:**
```vue
<template>
  <div class="h-12 border-b flex items-center justify-between px-4">
    <div class="flex-1">
      <h2 class="text-sm font-medium">{{ title }}</h2>
      <p v-if="project" class="text-xs text-muted-foreground truncate">{{ project }}</p>
      
      <!-- Progress bar -->
      <div v-if="isLoading" class="mt-2">
        <ProgressBar :indeterminate="true" />
      </div>
    </div>
    <!-- ...rest of template -->
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue'
import { useSessionStore } from '@/stores/ui/session'
import ProgressBar from '@shadcn/components/ui/progress-bar.vue'

const sessionStore = useSessionStore()

const isLoading = computed(() => {
  return sessionStore.activeSession?.status === 'working'
})
</script>
```

**Expected Behavior:**
- Progress bar appears during generation
- Indeterminate animation shows activity

---

### Task P2-3: Add toast notifications

**File:** `src/renderer/src/pages/ChatPage.vue`

**Required Change:**
```typescript
import { watch } from 'vue'
import { useToast } from '@shadcn/components/ui/toast'

const { toast } = useToast()

watch(() => sessionStore.activeSession?.status, (newStatus, oldStatus) => {
  if (oldStatus === 'working') {
    if (newStatus === 'completed') {
      toast({
        title: 'Generation Complete',
        description: 'Your response is ready',
        variant: 'default'
      })
    } else if (newStatus === 'error') {
      toast({
        title: 'Generation Failed',
        description: 'An error occurred while generating',
        variant: 'destructive'
      })
    }
  }
})
```

**Expected Behavior:**
- Success toast on completion
- Error toast on failure
- Toasts dismissible

---

## Backend Tasks

### Task B-1: Add updateSessionConfig to newAgentPresenter

**File:** `src/main/presenter/newAgentPresenter/index.ts` (or equivalent)

**Required Change:**
```typescript
async updateSessionConfig(
  sessionId: string,
  config: {
    providerId?: string
    modelId?: string
    permissionMode?: 'default' | 'full'
  }
): Promise<void> {
  const session = this.sessionStore.get(sessionId)
  if (!session) throw new Error(`Session ${sessionId} not found`)
  
  // Update session config
  if (config.providerId || config.modelId) {
    await this.sessionStore.update(sessionId, {
      provider_id: config.providerId ?? session.provider_id,
      model_id: config.modelId ?? session.model_id
    })
  }
  
  if (config.permissionMode) {
    // Store permission mode in session metadata or separate table
    await this.sessionStore.updatePermissionMode(sessionId, config.permissionMode)
  }
  
  // Emit update event
  eventBus.sendToRenderer(SESSION_EVENTS.CONFIG_UPDATED, SendTarget.ALL_WINDOWS, {
    sessionId,
    config
  })
}
```

**Expected Behavior:**
- Updates session configuration
- Persists to database
- Notifies frontend of change

---

### Task B-2: Emit CONVERSATION_EVENTS.UPDATED after message completion

**File:** `src/main/presenter/deepchatAgentPresenter/index.ts`

**Required Change:**
```typescript
// In processMessage(), after stream completes
state.status = 'idle'
this.abortControllers.delete(sessionId)

// Emit status change
eventBus.sendToRenderer(SESSION_EVENTS.STATUS_CHANGED, SendTarget.ALL_WINDOWS, {
  sessionId,
  status: 'idle'
})

// Also emit conversation updated
eventBus.sendToRenderer(CONVERSATION_EVENTS.UPDATED, SendTarget.ALL_WINDOWS, {
  sessionId
})
```

**Expected Behavior:**
- Session list refreshes after message completion
- Title updates reflected immediately

---

## Testing Checklist

### Unit Tests
- [ ] sessionStore.generatingSessionIds tracks status changes
- [ ] sessionStore.cancelGenerating() calls backend
- [ ] messageStore.isStreaming syncs with session status
- [ ] ChatInput disabled state updates correctly

### Integration Tests
- [ ] Send message → input disables → stop button appears
- [ ] Click stop → generation cancels → input enables
- [ ] Change model → session updates → display reflects change
- [ ] Change permission → persists → survives reload

### E2E Tests
- [ ] Complete generation flow
- [ ] Cancel generation flow
- [ ] Multi-session concurrent generation
- [ ] Session list auto-refresh

---

## Implementation Order

1. **P0-1** → P0-2 → P0-3 → P0-4 (Core cancel flow)
2. **P0-5** → P0-6 → P0-7 (Config bindings)
3. **P1-1** → P1-2 → P1-3 (Event flow)
4. **P1-4** → P2-1 → P2-2 → P2-3 (Polish)
5. **B-1** → B-2 (Backend support)

---

## Definition of Done

- [ ] All P0 tasks implemented and tested
- [ ] All P1 tasks implemented and tested
- [ ] P2 tasks implemented as time permits
- [ ] Backend tasks completed
- [ ] No console errors
- [ ] No TypeScript errors
- [ ] All existing tests pass
- [ ] New tests added for critical paths
- [ ] Documentation updated
