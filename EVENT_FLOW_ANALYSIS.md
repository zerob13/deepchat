# Event Flow and UI Binding Analysis

**Date:** 2026-02-28  
**Branch:** `feat/new-arch-complete`  
**Base Commit:** `0ae0cc80`

## Executive Summary

The new architecture has **implemented session state tracking** (`generating`, `idle`, `error`) in the backend and stores, but the **UI layer is not properly bound to this state**. The critical finding:

> **Session state is already implemented, but UI components don't react to it.** The new input box doesn't change with the state.

---

## Task 1: Old Architecture Event Flow Map

### File: `src/renderer/src/stores/chat.ts`

| Event | Source | Handler | State Updated | UI Reaction |
|-------|--------|---------|---------------|-------------|
| `STREAM_EVENTS.RESPONSE` | backend | `handleStreamResponse()` | `generatingMessagesCache`, `messageCache`, `generatingThreadIds` | Message content updates, typing indicator plays |
| `STREAM_EVENTS.END` | backend | `handleStreamEnd()` | `generatingMessagesCache` (remove), `generatingThreadIds` (delete) | Stop button hides, input enabled, status → completed |
| `STREAM_EVENTS.ERROR` | backend | `handleStreamError()` | `generatingMessagesCache` (remove), `generatingThreadIds` (delete) | Error displayed, input enabled, status → error |
| `SESSION_EVENTS.STATUS_CHANGED` | backend | Direct handler in `setupEventListeners()` | `threadsWorkingStatusMap` | Session list shows status icon (working/completed/error) |
| `CONVERSATION_EVENTS.LIST_UPDATED` | backend | Direct handler | `threads`, `selectedVariantsMap` | Session list refreshes |
| `CONVERSATION_EVENTS.ACTIVATED` | backend | Direct handler | `activeThreadIdMap`, `chatConfig` | Chat page loads messages, config updates |

### Critical State: `generatingThreadIds`

```typescript
// chat.ts line ~100
const generatingThreadIds = ref(new Set<string>())

// Used by UI to disable input and show stop button
// When session is generating:
// 1. generatingThreadIds.add(threadId) on send
// 2. generatingThreadIds.delete(threadId) on end/error
// 3. ChatInputBox reads this to set disabled state
```

### Critical State: `threadsWorkingStatusMap`

```typescript
// chat.ts line ~103
const threadsWorkingStatusMap = ref<Map<number, Map<string, WorkingStatus>>>(new Map())

// WorkingStatus = 'working' | 'error' | 'completed' | 'none'
// Updated by updateThreadWorkingStatus()
// Used by SessionList to show status icons
```

---

## Task 2: New Architecture Event Flow Map

### Files: `src/renderer/src/stores/ui/session.ts`, `src/renderer/src/stores/ui/message.ts`

| Event | Old Architecture | New Architecture | Gap |
|-------|------------------|------------------|-----|
| `STREAM_EVENTS.RESPONSE` | ✅ Updates `generatingMessagesCache`, triggers UI update | ✅ Updates `streamingBlocks`, `isStreaming` | ❌ `isStreaming` not used by UI components |
| `STREAM_EVENTS.END` | ✅ Removes from cache, enables input | ✅ Reloads messages, sets `isStreaming=false` | ❌ No explicit "complete" state in sessionStore |
| `STREAM_EVENTS.ERROR` | ✅ Handles error, enables input | ✅ Reloads messages, sets `isStreaming=false` | ❌ No error state propagation to sessionStore |
| `SESSION_EVENTS.STATUS_CHANGED` | ✅ Updates `threadsWorkingStatusMap` | ✅ Updates `session.status` | ⚠️ Status stored but limited UI usage |
| `CONVERSATION_EVENTS.LIST_UPDATED` | ✅ Refreshes session list | ❌ Not listening | ❌ **Missing** - session list won't auto-refresh |

### New Store State Analysis

#### `messageStore` (`src/renderer/src/stores/ui/message.ts`)

```typescript
const isStreaming = ref(false)           // ✅ Exists but underutilized
const streamingBlocks = ref<AssistantMessageBlock[]>([])
const currentStreamSessionId = ref<string | null>(null)
```

**Problem:** `isStreaming` is a global flag, not session-specific. Cannot track multiple concurrent sessions.

#### `sessionStore` (`src/renderer/src/stores/ui/session.ts`)

```typescript
const sessions = ref<UISession[]>([])
const activeSessionId = ref<string | null>(null)

// UISession has status field:
interface UISession {
  id: string
  title: string
  status: UISessionStatus  // 'completed' | 'working' | 'error' | 'none'
  // ...
}
```

**Problem:** No `generatingSessionIds` set like old architecture. No way to quickly check "is any session generating?"

---

## Task 3: UI Component Binding Analysis

### ChatInputBox (`src/renderer/src/components/chat/ChatInputBox.vue`)

**Current Implementation:**
```vue
<Textarea
  :model-value="modelValue ?? ''"
  @update:model-value="$emit('update:modelValue', $event)"
  @keydown="handleKeydown"
/>
<!-- No disabled prop, no stop button, no state binding -->
```

**Old Architecture Had:**
```typescript
disabled: computed(() => generatingThreadIds.value.has(activeThreadId))
Stop button: v-if="isGenerating" @click="stopGenerating"
```

**Gap:**
- ❌ No `disabled` prop
- ❌ No stop button
- ❌ No state binding whatsoever
- ❌ Pure presentational component

**Fix Required:**
1. Add `disabled` prop
2. Add `showStopButton` prop
3. Add `onStop` emit
4. Parent (ChatPage or ChatInput) must bind to sessionStore state

---

### ChatInput (`src/renderer/src/components/chat-input/ChatInput.vue`)

**Current Implementation:**
```typescript
// Line ~600
const { disabledSend, isStreaming } = sendButtonState

// Send/Stop Button (line ~350)
<Button
  v-if="!isStreaming || variant === 'newThread'"
  @click="emitSend"
>
  <Icon icon="lucide:arrow-up" />
</Button>
<Button
  v-else-if="isStreaming && variant === 'chat'"
  @click="handleCancel"
>
  <Icon icon="lucide:square" />
</Button>
```

**State Source:**
```typescript
// useSendButtonState composable
const disabledSend = computed(() => {
  // Checks rate limits, context length, etc.
  // Does NOT check session generating state
})
```

**Gap:**
- ⚠️ Has stop button but `isStreaming` is from `messageStore`
- ⚠️ `messageStore.isStreaming` is global, not session-specific
- ❌ Doesn't check `sessionStore.activeSession?.status`
- ❌ `handleCancel()` calls `chatStore.cancelGenerating()` (old store!)

**Fix Required:**
1. Import `useSessionStore`
2. Check `sessionStore.activeSession?.status === 'working'`
3. Update `handleCancel()` to call `sessionStore.cancelGenerating()` (needs implementation)

---

### ChatStatusBar (`src/renderer/src/components/chat/ChatStatusBar.vue`)

**Current Implementation:**
```typescript
// Model selector
const displayProviderId = computed(() => {
  if (hasActiveSession.value) {
    return chatStore.chatConfig.providerId  // ❌ Reading from OLD store
  }
  // ...
})

// Permission selector (line ~60)
<Button variant="ghost" ...>
  <Icon icon="lucide:shield" />
  <span>Default permissions</span>  // ❌ Static text, not dropdown
</Button>
```

**Gap:**
- ⚠️ Model selector reads from `chatStore` (old) instead of `sessionStore` (new)
- ❌ Permission selector is static button, should be dropdown
- ❌ No `handlePermissionModeChange()` function
- ❌ Cannot change permission mid-session

**Fix Required:**
1. Bind model selector to `sessionStore.activeSession.modelId`
2. Convert permission button to dropdown
3. Add permission options: "Default", "Full Access"
4. Add API call to update session permission mode

---

### WindowSideBar (`src/renderer/src/components/WindowSideBar.vue`)

**Current Implementation:**
```vue
<!-- Line ~170 -->
<span v-if="session.status === 'working'" class="shrink-0">
  <Icon icon="lucide:loader-2" class="animate-spin" />
</span>
<span v-else-if="session.status === 'completed'" class="shrink-0">
  <Icon icon="lucide:check" />
</span>
<span v-else-if="session.status === 'error'" class="shrink-0">
  <Icon icon="lucide:alert-circle" />
</span>
```

**State Source:**
```typescript
const filteredGroups = computed(() => 
  sessionStore.getFilteredGroups(agentStore.selectedAgentId)
)
// session.status comes from sessionStore.sessions[].status
```

**Status:** ✅ **COMPLETE** - Session list properly shows status icons

**Gap:**
- ⚠️ Status updates depend on `SESSION_EVENTS.STATUS_CHANGED` being received
- ⚠️ No visual distinction for active session beyond background color

---

### ChatPage (`src/renderer/src/pages/ChatPage.vue`)

**Current Implementation:**
```typescript
const displayMessages = computed(() => {
  const msgs = messageStore.messages.map(toDisplayMessage)
  
  if (messageStore.isStreaming && messageStore.streamingBlocks.length > 0) {
    msgs.push(toStreamingMessage(messageStore.streamingBlocks))
  }
  
  return msgs
})
```

**Gap:**
- ⚠️ Uses `messageStore.isStreaming` (global) instead of session-specific state
- ❌ Doesn't react to `sessionStore.activeSession.status`
- ❌ No typing indicator during streaming
- ❌ No visual feedback when session status changes

**Fix Required:**
1. Watch `sessionStore.activeSession.status`
2. Show loading indicator when status === 'working'
3. Display status changes as toast notifications

---

## Task 4: Backend Event Emission Analysis

### Files: `src/main/presenter/deepchatAgentPresenter/`

#### `index.ts` - Event Emission Points

```typescript
// Line ~100 - processMessage()
state.status = 'generating'
eventBus.sendToRenderer(SESSION_EVENTS.STATUS_CHANGED, SendTarget.ALL_WINDOWS, {
  sessionId,
  status: 'generating'  // ✅ Emits on start
})

// Line ~160 - After stream completes
state.status = 'idle'
eventBus.sendToRenderer(SESSION_EVENTS.STATUS_CHANGED, SendTarget.ALL_WINDOWS, {
  sessionId,
  status: 'idle'  // ✅ Emits on completion
})

// Line ~167 - On error
state.status = 'error'
eventBus.sendToRenderer(SESSION_EVENTS.STATUS_CHANGED, SendTarget.ALL_WINDOWS, {
  sessionId,
  status: 'error'  // ✅ Emits on error
})
```

**Status:** ✅ Backend properly emits `STATUS_CHANGED` events

#### `process.ts` - Stream Processing

```typescript
// Line ~50 - On abort
eventBus.sendToRenderer(STREAM_EVENTS.ERROR, SendTarget.ALL_WINDOWS, {
  conversationId: io.sessionId,
  error: 'Generation cancelled'
})

// Line ~95 - finalize()
eventBus.sendToRenderer(STREAM_EVENTS.RESPONSE, SendTarget.ALL_WINDOWS, {
  conversationId: io.sessionId,
  blocks: state.blocks
})
eventBus.sendToRenderer(STREAM_EVENTS.END, SendTarget.ALL_WINDOWS, {
  conversationId: io.sessionId  // ✅ Emits END
})
```

**Status:** ✅ Backend emits all required stream events

#### Missing Event: `CONVERSATION_EVENTS.UPDATED`

**Old Backend:**
```typescript
// After message completion, emits:
eventBus.sendToRenderer(CONVERSATION_EVENTS.UPDATED, ...)
// Triggers session list refresh
```

**New Backend:**
```typescript
// ❌ No CONVERSATION_EVENTS.UPDATED emission
// Session list won't auto-refresh after message completion
```

**Gap:**
- ❌ Missing `CONVERSATION_EVENTS.UPDATED` emission after message completion
- ❌ Session title updates won't propagate to UI

---

## Task 5: State Synchronization Analysis

### Critical Question: How does UI know when session is generating?

#### Old Architecture Flow:
```
Backend: processing 
  → emits STATUS_CHANGED('generating') 
  → chatStore receives 
  → updates generatingThreadIds + threadsWorkingStatusMap
  → UI: ChatInputBox sees generatingThreadIds.has(threadId) 
  → disables input, shows stop button
```

#### New Architecture Flow:
```
Backend: processing 
  → emits STATUS_CHANGED('generating') 
  → sessionStore receives 
  → updates session.status = 'working'
  → UI: ??? (not bound!)
```

### State Mapping Table

| State | Old Architecture | New Architecture | Synchronized? |
|-------|------------------|------------------|---------------|
| Session generating | `generatingThreadIds: Set<string>` | `session.status: 'working'` | ⚠️ Partial |
| Message streaming | `generatingMessagesCache: Map` | `isStreaming: boolean`, `streamingBlocks: []` | ✅ Yes |
| Session completed | `threadsWorkingStatusMap: 'completed'` | `session.status: 'completed'` | ✅ Yes |
| Session error | `threadsWorkingStatusMap: 'error'` | `session.status: 'error'` | ✅ Yes |
| Active session | `activeThreadId: string` | `activeSessionId: string` | ✅ Yes |

### Critical Gaps

1. **`isStreaming` is global, not session-specific**
   - Cannot track multiple concurrent sessions
   - Should be `streamingSessionIds: Set<string>` or per-session flag

2. **No `generatingSessionIds` in sessionStore**
   - Old: `generatingThreadIds` provided O(1) lookup
   - New: Must iterate `sessions.find(s => s.status === 'working')`

3. **UI components read from wrong store**
   - `ChatStatusBar` reads `chatStore.chatConfig` instead of `sessionStore.activeSession`
   - `ChatInput.handleCancel()` calls `chatStore.cancelGenerating()` instead of sessionStore method

4. **Missing cross-store synchronization**
   - `messageStore.isStreaming` should mirror `sessionStore.activeSession?.status === 'working'`
   - Currently independent, can become inconsistent

---

## Task 6: Comprehensive Gap Table

### STREAM_EVENTS.RESPONSE

**Old:**
- Received in: `chatStore.handleStreamResponse()`
- Updates: `generatingMessagesCache.set(eventId, message)`, `generatingThreadIds.add(threadId)`
- UI reacts: MessageList re-renders, typing indicator plays, input disabled

**New:**
- Received in: `messageStore` STREAM_EVENTS.RESPONSE handler
- Updates: `streamingBlocks.value = msg.blocks`, `isStreaming.value = true`
- UI reacts: ChatPage `displayMessages` computed includes streamingBlocks

**Gap:**
- ✅ Event is received
- ✅ Blocks are stored
- ❌ `isStreaming` is global, not session-specific
- ❌ No generating state in sessionStore for quick lookup
- ❌ Typing indicator not implemented

**Fix Required:**
1. Add `generatingSessionIds: Set<string>` to sessionStore
2. Update on STREAM_EVENTS.RESPONSE/END
3. Bind ChatInput disabled state to `generatingSessionIds.has(activeSessionId)`
4. Add typing indicator component

---

### SESSION_EVENTS.STATUS_CHANGED

**Old:**
- Received in: `chatStore`
- Updates: `threadsWorkingStatusMap`
- UI reacts: Session list shows status icon

**New:**
- Received in: `sessionStore`
- Updates: `session.status`
- UI reacts: WindowSideBar shows status icon ✅

**Gap:**
- ✅ Event is received
- ✅ Status is stored
- ✅ Session list displays status
- ❌ ChatPage doesn't react to status changes
- ❌ No toast notifications on status change

**Fix Required:**
1. Watch `sessionStore.activeSession.status` in ChatPage
2. Show loading indicator when status === 'working'
3. Add toast on 'completed' or 'error'

---

### CONVERSATION_EVENTS.LIST_UPDATED

**Old:**
- Received in: `chatStore`
- Updates: `threads` array
- UI reacts: Session list refreshes

**New:**
- ❌ Not listening in sessionStore
- ❌ Session list won't auto-refresh when sessions change

**Gap:**
- ❌ Missing event listener
- ❌ Session list stale after operations

**Fix Required:**
1. Add `CONVERSATION_EVENTS.LIST_UPDATED` listener to sessionStore
2. Call `fetchSessions()` on event
3. Or migrate to using only `SESSION_EVENTS.LIST_UPDATED`

---

### Cancel/Stop Flow

**Old:**
```typescript
// ChatInput.handleCancel()
chatStore.cancelGenerating(threadId)
  → agentP.cancelLoop(messageId)
  → generatingThreadIds.delete(threadId)
  → updateThreadWorkingStatus(threadId, 'completed')
```

**New:**
```typescript
// ChatInput.handleCancel()
chatStore.cancelGenerating(threadId)  // ❌ Still calling old store!
  → sessionStore has no cancelGenerating() method
```

**Gap:**
- ❌ `sessionStore` missing `cancelGenerating()` method
- ❌ Backend `cancelGeneration()` exists but not exposed to UI
- ❌ Stop button calls wrong store

**Fix Required:**
1. Add `cancelGenerating(sessionId)` to sessionStore
2. Call `newAgentPresenter.cancelGeneration(sessionId)`
3. Update ChatInput to use sessionStore
4. Ensure backend emits STATUS_CHANGED('idle') on cancel

---

## Task 7: Component Binding Matrix

| Component | Should Bind To | Currently Binds To | Gap | Priority |
|-----------|----------------|-------------------|-----|----------|
| **ChatInputBox** | `sessionStore.generatingSessionIds` | (nothing) | ❌ Missing disabled/stop props | P0 |
| **ChatInput** | `sessionStore.activeSession.status` | `messageStore.isStreaming` | ⚠️ Partial (global vs session-specific) | P0 |
| **ChatInput.handleCancel** | `sessionStore.cancelGenerating()` | `chatStore.cancelGenerating()` | ❌ Wrong store | P0 |
| **ChatStatusBar.model** | `sessionStore.activeSession.modelId` | `chatStore.chatConfig.modelId` | ❌ Old store | P0 |
| **ChatStatusBar.permission** | `sessionStore.activeSession.permissionMode` | (static text) | ❌ Not implemented | P0 |
| **MessageList** | `messageStore.messages` | `messageStore.messages` | ✅ Complete | - |
| **ChatPage** | `sessionStore.activeSession.status` | `messageStore.isStreaming` | ⚠️ Partial | P1 |
| **WindowSideBar** | `sessionStore.sessions[].status` | `sessionStore.sessions[].status` | ✅ Complete | - |

---

## Prioritized Implementation Plan

### P0: Critical UI Bindings (Must Have)

#### 1. ChatInputBox Disabled State
**File:** `src/renderer/src/components/chat/ChatInputBox.vue`, `src/renderer/src/pages/ChatPage.vue`

**Change:**
```vue
<!-- ChatInputBox.vue -->
<props>
  disabled?: boolean
  showStopButton?: boolean
  onStop?: () => void
</props>

<!-- ChatPage.vue -->
<ChatInputBox
  :disabled="sessionStore.activeSession?.status === 'working'"
  :showStopButton="sessionStore.activeSession?.status === 'working'"
  @stop="sessionStore.cancelGenerating(sessionId)"
/>
```

**Expected:** Input disabled during generation, stop button visible

---

#### 2. Stop Button Implementation
**File:** `src/renderer/src/stores/ui/session.ts`

**Change:**
```typescript
async function cancelGenerating(sessionId: string): Promise<void> {
  await newAgentPresenter.cancelGeneration(sessionId)
  // Status update will come from backend STATUS_CHANGED event
}
```

**Expected:** Stop button cancels generation, status updates to 'idle'

---

#### 3. Model Selector Binding
**File:** `src/renderer/src/components/chat/ChatStatusBar.vue`

**Change:**
```typescript
const displayModelId = computed(() => {
  return sessionStore.activeSession?.modelId ?? ''
})

async function selectModel(providerId: string, modelId: string) {
  // Need to add updateSessionConfig to sessionStore
  await sessionStore.updateSessionConfig({ providerId, modelId })
}
```

**Expected:** Model selector reflects session's model, changes persist

---

#### 4. Permission Selector Dropdown
**File:** `src/renderer/src/components/chat/ChatStatusBar.vue`

**Change:**
```vue
<DropdownMenu>
  <DropdownMenuTrigger>
    <Button variant="ghost">
      <Icon icon="lucide:shield" />
      <span>{{ permissionLabel }}</span>
    </Button>
  </DropdownMenuTrigger>
  <DropdownMenuContent>
    <DropdownMenuItem @click="setPermission('default')">Default</DropdownMenuItem>
    <DropdownMenuItem @click="setPermission('full')">Full Access</DropdownMenuItem>
  </DropdownMenuContent>
</DropdownMenu>
```

**Expected:** User can change permission mode mid-session

---

### P1: Event Flow Completion (Should Have)

#### 1. Add CONVERSATION_EVENTS.LIST_UPDATED Listener
**File:** `src/renderer/src/stores/ui/session.ts`

**Change:**
```typescript
window.electron.ipcRenderer.on(CONVERSATION_EVENTS.LIST_UPDATED, () => {
  fetchSessions()
})
```

**Expected:** Session list auto-refreshes after operations

---

#### 2. Synchronize isStreaming with Session Status
**File:** `src/renderer/src/stores/ui/message.ts`

**Change:**
```typescript
// Watch sessionStore for status changes
watch(() => sessionStore.activeSession?.status, (status) => {
  isStreaming.value = status === 'working'
})
```

**Expected:** `messageStore.isStreaming` always matches session status

---

#### 3. Add Generating SessionIds Set
**File:** `src/renderer/src/stores/ui/session.ts`

**Change:**
```typescript
const generatingSessionIds = ref<Set<string>>(new Set())

// Update on STATUS_CHANGED event
window.electron.ipcRenderer.on(SESSION_EVENTS.STATUS_CHANGED, (_, msg) => {
  const session = sessions.value.find(s => s.id === msg.sessionId)
  if (session) {
    session.status = mapSessionStatus(msg.status)
    if (msg.status === 'generating') {
      generatingSessionIds.value.add(msg.sessionId)
    } else {
      generatingSessionIds.value.delete(msg.sessionId)
    }
  }
})
```

**Expected:** O(1) lookup for "is session generating?"

---

### P2: Polish (Nice to Have)

#### 1. Typing Indicator
**File:** `src/renderer/src/components/chat/MessageList.vue`

**Change:**
```vue
<div v-if="sessionStore.activeSession?.status === 'working'" class="typing-indicator">
  <span class="dot"></span>
  <span class="dot"></span>
  <span class="dot"></span>
</div>
```

**Expected:** Visual feedback during generation

---

#### 2. Toast Notifications
**File:** `src/renderer/src/pages/ChatPage.vue`

**Change:**
```typescript
watch(() => sessionStore.activeSession?.status, (status) => {
  if (status === 'completed') {
    toast.success('Generation complete')
  } else if (status === 'error') {
    toast.error('Generation failed')
  }
})
```

**Expected:** User notified of completion/errors

---

#### 3. Progress Indicator for Long Operations
**File:** `src/renderer/src/components/chat/ChatTopBar.vue`

**Change:**
```vue
<ProgressBar v-if="sessionStore.activeSession?.status === 'working'" />
```

**Expected:** Visual progress indicator

---

## Verification Checklist

### Code Inspection (Can Verify Now)
- [ ] `sessionStore` has `generatingSessionIds` set
- [ ] `sessionStore` has `cancelGenerating()` method
- [ ] `ChatInputBox` has `disabled` and `showStopButton` props
- [ ] `ChatStatusBar` permission selector is dropdown
- [ ] `sessionStore` listens to `CONVERSATION_EVENTS.LIST_UPDATED`

### Runtime Testing (Requires Build)
- [ ] Input box disables during generation
- [ ] Stop button appears and cancels generation
- [ ] Session list shows status icons (working/completed/error)
- [ ] Model selector reflects session model
- [ ] Permission dropdown changes permission mode
- [ ] Session list auto-refreshes after operations
- [ ] Toast notifications on completion/error

---

## Architecture Recommendations

### 1. Single Source of Truth
**Problem:** State split between `chatStore` (old) and `sessionStore`/`messageStore` (new)

**Recommendation:** 
- Migrate all session state to `sessionStore`
- Migrate all message state to `messageStore`
- Deprecate `chatStore` for new architecture components

### 2. Session-Specific Streaming State
**Problem:** `messageStore.isStreaming` is global

**Recommendation:**
```typescript
// Replace
const isStreaming = ref(false)

// With
const streamingSessionIds = ref<Set<string>>(new Set())

const isSessionStreaming = (sessionId: string) => 
  streamingSessionIds.value.has(sessionId)
```

### 3. Unified Event Bus
**Problem:** Components must listen to multiple event types

**Recommendation:**
```typescript
// Create session lifecycle events
const SESSION_LIFECYCLE = {
  STARTED: 'session:started',      // generating → working
  MESSAGE_SENT: 'session:message',  // message added
  COMPLETED: 'session:completed',   // working → completed
  ERROR: 'session:error'           // working → error
}
```

### 4. Type-Safe Store Actions
**Problem:** Store methods don't enforce session state transitions

**Recommendation:**
```typescript
type SessionStatus = 'idle' | 'working' | 'error' | 'completed'

function transitionStatus(sessionId: string, to: SessionStatus) {
  const validTransitions = {
    'idle': ['working'],
    'working': ['completed', 'error', 'idle'],
    'error': ['idle', 'working'],
    'completed': ['idle', 'working']
  }
  
  const from = getSession(sessionId).status
  if (!validTransitions[from].includes(to)) {
    throw new Error(`Invalid transition: ${from} → ${to}`)
  }
  
  // Update status
}
```

---

## Conclusion

The new architecture has **solid foundation** with proper backend event emission and store structure. The critical gaps are:

1. **UI bindings incomplete** - Components not connected to session state
2. **Cross-store inconsistency** - Old and new stores used interchangeably
3. **Missing session-specific tracking** - Global `isStreaming` vs per-session state
4. **Incomplete event flow** - Missing `CONVERSATION_EVENTS.UPDATED` listener

**Estimated effort:** 4-6 hours for P0 items, 2-3 hours for P1, 2-3 hours for P2

**Risk:** Low - all changes are additive, no breaking changes to backend

**Next step:** Implement P0 items first, test, then proceed to P1/P2
