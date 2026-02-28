# New Architecture UI Alignment Fix Plan

## Problem Summary

The new `deepchatAgentPresenter` architecture is **not aligned** with the frontend UI:

1. **Backend sends:** `{ conversationId, blocks: AssistantMessageBlock[] }`
2. **Frontend expects:** Old stream format with `seq`, `content`, `tool_call_*` fields
3. **Result:** UI state is completely wrong - no loading state, no permission UI, no message updates

## Root Cause Analysis

### Current Flow (Broken)
```
Backend (deepchatAgentPresenter)
  ↓ sends { blocks }
STREAM_EVENTS.RESPONSE
  ↓ Frontend (chatStore.handleStreamResponse)
Expects old format → Cannot parse → UI broken
```

### Missing Pieces

1. **New UI stores don't listen to stream events**
   - `stores/ui/session.ts` - only calls `sendMessage()`, no event listening
   - `stores/ui/message.ts` - only fetches messages, no real-time updates

2. **Event format mismatch**
   - Backend: `blocks: AssistantMessageBlock[]`
   - Frontend: expects `content`, `seq`, `tool_call_*` fields

3. **State management gap**
   - No `generating` state in new architecture
   - No message cache for in-progress messages
   - No permission UI trigger mechanism

## Solution Architecture

### Option 1: Update Frontend to Match New Backend (RECOMMENDED)

**Pros:**
- Clean architecture
- Blocks-based rendering is more flexible
- Aligns with new UI components

**Cons:**
- Requires significant frontend changes

**Implementation:**

#### 1. Create new stream handler in `stores/ui/message.ts`

```typescript
// Add stream event listeners
export function useMessageStream() {
  const { updateMessage, addMessageBlock } = useMessageStore()
  
  onMounted(() => {
    window.electron.ipcRenderer.on(STREAM_EVENTS.RESPONSE, (_, payload) => {
      const { conversationId, blocks } = payload
      
      // Update message with new blocks
      updateMessageBlocks(conversationId, blocks)
    })
    
    window.electron.ipcRenderer.on(STREAM_EVENTS.END, (_, payload) => {
      const { conversationId } = payload
      
      // Mark message as completed
      markMessageCompleted(conversationId)
    })
    
    window.electron.ipcRenderer.on(STREAM_EVENTS.ERROR, (_, payload) => {
      const { conversationId, error } = payload
      
      // Mark message as error
      markMessageError(conversationId, error)
    })
  })
}
```

#### 2. Add blocks-based message update

```typescript
// stores/ui/message.ts
async function updateMessageBlocks(
  sessionId: string, 
  blocks: AssistantMessageBlock[]
): Promise<void> {
  // Find the latest assistant message for this session
  const messages = await getMessages(sessionId)
  const assistantMessage = messages.filter(m => m.role === 'assistant').pop()
  
  if (assistantMessage) {
    // Update message content with blocks
    await newAgentPresenter.updateMessage(assistantMessage.id, {
      content: JSON.stringify(blocks),
      blocks: blocks // Store raw blocks if supported
    })
    
    // Trigger UI refresh
    messageVersion.value++
  }
}
```

#### 3. Add generating state

```typescript
// stores/ui/session.ts
const generatingSessionIds = ref<Set<string>>(new Set())

async function sendMessage(sessionId: string, content: string): Promise<void> {
  generatingSessionIds.value.add(sessionId)
  
  try {
    await newAgentPresenter.sendMessage(sessionId, content)
  } finally {
    // Will be removed when STREAM_EVENTS.END received
  }
}

function markSessionCompleted(sessionId: string) {
  generatingSessionIds.value.delete(sessionId)
}
```

#### 4. Update ChatPage to use new stores

```vue
<!-- ChatPage.vue -->
<script setup>
import { useSessionStore } from '@/stores/ui/session'
import { useMessageStore } from '@/stores/ui/message'
import { useMessageStream } from '@/stores/ui/message'

const sessionStore = useSessionStore()
const messageStore = useMessageStore()
useMessageStream() // Set up stream listeners

const isGenerating = computed(() => 
  sessionStore.activeSessionId && 
  sessionStore.generatingSessionIds.has(sessionStore.activeSessionId)
)
</script>
```

### Option 2: Make Backend Send Old Format

**Pros:**
- Minimal frontend changes

**Cons:**
- Breaks new architecture design
- Temporary workaround, not a real solution

**NOT RECOMMENDED**

## Implementation Priority

### Phase 1: Critical (Make it work)
1. Add stream event listeners to `stores/ui/message.ts`
2. Implement `updateMessageBlocks()` 
3. Add generating state to `stores/ui/session.ts`
4. Test basic message flow

### Phase 2: Permission UI (Make it complete)
1. Handle `block.extra.needsUserAction` in frontend
2. Show permission approval UI
3. Implement `handlePermissionResponse` call from UI
4. Test permission flow

### Phase 3: Polish (Make it nice)
1. Add loading indicators
2. Add stop generation button
3. Add message status indicators
4. Optimize re-renders

## Testing Checklist

- [ ] Send message → see "generating" state
- [ ] Stream response → see message updating in real-time
- [ ] Tool call → see permission UI
- [ ] Approve → see tool execution result
- [ ] Complete → see "completed" state
- [ ] Send another message → works correctly

## Estimated Time

- Phase 1: 2-3 hours
- Phase 2: 1-2 hours
- Phase 3: 1-2 hours
- **Total: 4-7 hours**

## Next Steps

1. **Confirm architecture decision** (Option 1 vs Option 2)
2. **Implement Phase 1** - Basic stream handling
3. **Test and iterate**
4. **Implement Phase 2** - Permission UI
5. **Final testing**
