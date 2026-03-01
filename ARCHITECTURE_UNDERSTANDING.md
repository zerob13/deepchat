# Architecture Understanding

**Date:** 2026-02-28  
**Branch:** `feat/new-arch-complete`  
**Author:** Subagent (Deep Architecture Analysis)

---

## Executive Summary

The old architecture's complexity is **not accidental** — it solves real problems:

1. **UX Responsiveness:** Network latency requires optimistic updates
2. **Progressive Rendering:** LLM generation takes seconds, users need feedback
3. **Vue Reactivity:** Map changes don't trigger re-renders without version bumping
4. **Separation of Concerns:** Different events for creation, streaming, completion, state
5. **Multi-Session Concurrency:** Power users need parallel work
6. **Multi-Window Sync:** Backend is source of truth, all windows must sync

**Key Insight:** The new architecture can simplify SOME complexity, but must preserve the ESSENTIAL patterns that solve real user problems.

---

## Why Old Architecture Is Complex

### 1. Optimistic User Messages

**Problem:** Network latency makes UX feel slow. User sends message → waits 200-500ms → message appears.

**Old Solution:**
```typescript
function addOptimisticUserMessage(threadId: string, text: string) {
  const message = {
    id: `optimistic_${Date.now()}`,
    role: 'user',
    content: text,
    status: 'pending'
  }
  messageCache.set(message.id, message)  // Show immediately
  // Then send to backend...
  // Backend creates real message → REPLACE optimistic with real
}
```

**Complexity:**
- Message ID mapping (optimistic → real)
- Content synchronization
- Error handling (what if backend fails?)

**Decision:** ✅ **KEEP** — Essential for responsive UX

**Why:**
- 200-500ms delay feels broken to users
- Industry standard (Slack, Discord, iMessage all do this)
- New architecture already has `addOptimisticUserMessage()` in messageStore

**Migration:**
- New architecture has this in `messageStore.addOptimisticUserMessage()`
- Ensure it's actually used by the send flow
- Handle optimistic → real merge properly

---

### 2. Assistant Message Skeleton

**Problem:** LLM generation takes 5-30 seconds. User needs to see SOMETHING before completion.

**Old Solution:**
```typescript
if (msg.stream_kind === 'init') {
  const skeleton = {
    id: msg.eventId,
    role: 'assistant',
    content: '',  // Empty initially
    status: 'pending'
  }
  messageCache.set(skeleton.id, skeleton)
}
// Subsequent RESPONSE events fill in content
// END event marks as complete
```

**Complexity:**
- Manage "incomplete" state
- Handle streaming updates
- Distinguish skeleton → filled → complete

**Decision:** ✅ **KEEP (but evolved)** — Progressive rendering is essential

**Why:**
- Users need feedback that generation started
- Allows "stop generation" button to appear immediately
- Industry standard (ChatGPT, Claude, etc.)

**New Architecture Approach:**
- Uses `streamingBlocks` instead of skeleton message
- **Better:** Separates streaming state from message state
- **Trade-off:** Need to ensure UI shows "thinking" indicator

**Migration:**
- Ensure ChatInputBox shows "generating" state when `messageStore.isStreaming === true`
- Show stop button during streaming
- Ensure session list shows status icon

---

### 3. Message Cache Version Bumping

**Problem:** Vue 3 reactivity with Maps is tricky. `messageCache.set()` doesn't trigger re-render.

**Old Solution:**
```typescript
const messageCacheVersion = ref(0)

function bumpMessageCacheVersion() {
  messageCacheVersion.value += 1  // Triggers re-render
}

// Called on:
// - STREAM_EVENTS.RESPONSE (new tokens)
// - STREAM_EVENTS.END (completion)
// - Permission approved (resume execution)
```

**Complexity:**
- Extra state to manage
- Must remember to bump on every change

**Decision:** ✅ **KEEP** — Required for Vue reactivity

**Why:**
- Vue's reactivity system doesn't detect Map.set() changes
- Version number is a "reactivity trigger"
- Forces MessageList to re-compute `displayMessages`

**New Architecture:**
- Has `messageVersion = ref(0)` pattern (similar)
- **Question:** Is this actually implemented? Check messageStore

**Migration:**
- Verify messageStore has version bumping
- Ensure MessageList component reads version to trigger re-render
- Consider using `reactive()` instead of `ref(Map)` for better reactivity

---

### 4. Many Events (Separation of Concerns)

**Problem:** Different concerns need independent handling:
- Message creation (can fail independently)
- Content streaming (can be interrupted)
- Completion (enables input)
- Session state (independent of messages)

**Old Event Sequence:**
```
1. User clicks send
2. addOptimisticUserMessage() → UI shows immediately
3. Backend: sendMessage() → creates user message in DB
4. Backend: STREAM_EVENTS.RESPONSE (user message created)
5. Frontend: handleStreamResponse → replace optimistic with real
6. Backend: processStream() → starts generation
7. Backend: STREAM_EVENTS.RESPONSE (tokens streaming)
8. Frontend: handleStreamResponse → update assistant content
9. Backend: STREAM_EVENTS.END
10. Frontend: handleStreamEnd → mark complete, enable input
11. Backend: SESSION_EVENTS.STATUS_CHANGED('idle')
12. Frontend: update session status in UI
```

**Why So Many Events?**
- **Message creation** (step 4-5): Can fail independently
- **Content streaming** (step 7-8): Can be interrupted
- **Completion** (step 9-10): Enables input
- **Session state** (step 11-12): Independent of messages

**Decision:** ✅ **KEEP** — Separation allows robust error handling

**Why:**
- Message creation can fail without affecting session state
- Streaming can be interrupted without losing message
- Session can be idle while messages still stream
- Each concern has independent recovery path

**New Architecture:**
- Emits same events: `STREAM_EVENTS.RESPONSE`, `STREAM_EVENTS.END`, `SESSION_EVENTS.STATUS_CHANGED`
- **Gap:** Need to verify all events are actually emitted

**Migration:**
- Verify newAgentPresenter emits all necessary events
- Ensure frontend listens to all events
- Test error scenarios (network failure, timeout, permission wait)

---

### 5. Permission Flow Complexity

**Problem:** Tool calls may require user approval. Session must wait without timing out.

**Old Flow:**
```
1. Tool call detected
2. Backend: Check permission → requires approval
3. Backend: Send permission request to frontend
4. Frontend: Show permission UI
5. User clicks "Allow"
6. Frontend: handlePermissionResponse()
7. Backend: Resume tool execution
8. Backend: STREAM_EVENTS.RESPONSE (tool result)
9. Backend: STREAM_EVENTS.END
```

**Critical: What Events Are NOT Emitted During Permission Wait?**
- ❌ No `STATUS_CHANGED` (session stays 'generating')
- ❌ No `END` (stream not complete)
- ❌ Input stays disabled

**Why?**
- Session is still "generating" — just waiting for user input
- Don't want user to send another message while waiting
- Don't want session to appear "complete"

**Decision:** ✅ **KEEP** — Correct behavior

**Why:**
- Prevents race conditions (user sends message while permission pending)
- Clear UX: user knows something is waiting
- Backend maintains control flow

**New Architecture:**
- Old code has `presenter.sessionManager.setStatus(state.conversationId, 'waiting_permission')`
- **Question:** Does new architecture have this?

**Migration:**
- Verify newAgentPresenter handles permission flow
- Ensure session stays 'generating' during permission wait
- Add permission timeout (see below)

---

### 6. Permission Timeout

**Problem:** What if user walks away during permission wait? Session blocks forever.

**Old Architecture:**
- ❌ **No timeout logic found** — potential bug!

**Decision:** ✅ **ADD** — Essential for robustness

**Why:**
- User might close window, crash, or walk away
- Session should not block indefinitely
- Prevents resource leaks

**Recommendation:**
```typescript
// In backend permission handler
const PERMISSION_TIMEOUT = 5 * 60 * 1000  // 5 minutes

setTimeout(() => {
  if (permissionStillPending(sessionId)) {
    // Auto-deny and continue
    denyPermission(sessionId)
    emit STREAM_EVENTS.ERROR({ error: 'Permission timeout' })
    emit SESSION_EVENTS.STATUS_CHANGED('idle')
  }
}, PERMISSION_TIMEOUT)
```

**Migration:**
- Add timeout to newAgentPresenter
- Default: 5 minutes
- Emit error event on timeout
- Allow user to retry

---

### 7. Multi-Session Concurrency

**Problem:** Power users want parallel work on different topics.

**Old Architecture:**
```typescript
// generatingThreadIds is a Set<string>
// Can contain multiple thread IDs simultaneously

// User can:
// - Open window 1 → Session A → send message → generating
// - Open window 2 → Session B → send message → generating
// - Both sessions generate concurrently
```

**Why?**
- Power users might have multiple research threads
- Different sessions = different topics
- Don't want one slow LLM to block all work

**Decision:** ⚠️ **MAYBE** — Depends on product requirements

**Why Keep:**
- Power user feature
- Increases productivity
- Modern LLM apps support this (ChatGPT tabs, etc.)

**Why Drop:**
- Adds complexity (per-session state vs global boolean)
- Most users only use one session at a time
- Can be added later if needed

**New Architecture:**
- `messageStore.isStreaming` is a **boolean** (not session-specific)
- `sessionStore.sessions` has per-session status
- **Gap:** Cannot track "which session is generating?"

**Recommendation:**
- Add `generatingSessionIds: Set<string>` to sessionStore
- Keep `isStreaming` for quick "any session generating?" check
- Support concurrent generation but don't optimize for it yet

**Migration:**
- See TASKS.md Task P0-1: Add `generatingSessionIds` to sessionStore

---

### 8. Session Switching During Generation

**Problem:** User is in Session A (generating). User clicks Session B. What happens?

**Old Architecture:**
```
- Session A continues generating in background
- Window switches to Session B
- Session B's input is enabled (not generating)
- User can work on Session B
- Session A completion will:
  - Update session list status icon
  - But won't switch back automatically
```

**Why?**
- User autonomy: User controls which session to view
- Background completion: Other sessions can finish
- Non-blocking: One slow session doesn't block others

**Decision:** ✅ **KEEP** — Correct UX

**Why:**
- Users hate being "locked in" to a session
- Background completion is expected behavior
- Session list status icon provides notification

**New Architecture:**
- Session switching works via `sessionStore.selectSession()`
- **Question:** Does generation continue in background?

**Migration:**
- Verify backend generation is session-scoped (not window-scoped)
- Ensure session switching doesn't cancel generation
- Test: Start generation in Session A → switch to Session B → verify A completes

---

### 9. Multi-Window Session Tracking

**Problem:** Multiple windows can modify sessions. Backend is source of truth.

**Old Architecture:**
```typescript
// Active session tracking
const activeThreadIdMap = ref<Map<number, string | null>>(new Map())
// webContentsId → threadId

window.electron.ipcRenderer.on(
  CONVERSATION_EVENTS.ACTIVATED,
  (_, msg: { webContentsId: number; threadId: string }) => {
    activeThreadIdMap.value.set(msg.webContentsId, msg.threadId)
    
    // If this is MY window, load the session
    if (msg.webContentsId === window.api.getWebContentsId()) {
      loadMessages(msg.threadId)
      loadChatConfig(msg.threadId)
    }
  }
)
```

**Why?**
- Multiple windows can have different active sessions
- Each window tracks its own active session
- ACTIVATED event coordinates which window shows which session

**Decision:** ⚠️ **MAYBE** — Depends on multi-window support

**Why Keep:**
- Power users might have multiple windows
- Consistent with Electron app patterns
- Prevents race conditions

**Why Drop:**
- Adds significant complexity
- Most users use single window
- Can be added later if needed

**New Architecture:**
- Has `activeSessionId` (single, not Map)
- Has `SESSION_EVENTS.ACTIVATED` listener
- **Gap:** Doesn't track other windows' active sessions

**Recommendation:**
- Keep current single-window approach for MVP
- Document limitation: "Multi-window not supported yet"
- Add multi-window support in v2 if needed

**Migration:**
- Current implementation is sufficient for single-window
- No action needed for MVP

---

### 10. Session List Auto-Refresh

**Problem:** Backend is source of truth. When session is modified (any window), all windows must sync.

**Old Architecture:**
```typescript
window.electron.ipcRenderer.on(
  CONVERSATION_EVENTS.LIST_UPDATED,
  () => {
    loadThreads()  // Reload entire session list from backend
  }
)

// Backend emits LIST_UPDATED when:
// - New session created
// - Session deleted
// - Session renamed
// - Session pinned/unpinned
// - Session moved (parent/child relationship)
```

**Why?**
- Multiple windows can modify sessions
- Backend is source of truth
- Frontend must sync when backend changes

**Decision:** ✅ **KEEP** — Essential for data consistency

**Why:**
- Prevents stale data
- Multi-window sync (even if not supported yet, good architecture)
- User expects session list to be accurate

**New Architecture:**
- Has `SESSION_EVENTS.LIST_UPDATED` defined
- sessionStore listens to it: `window.electron.ipcRenderer.on(SESSION_EVENTS.LIST_UPDATED, () => { fetchSessions() })`
- ✅ **Already implemented!**

**Migration:**
- Verify backend emits `LIST_UPDATED` on all session changes
- Test: Create session in window A → verify window B sees it

---

### 11. Error Handling and Recovery

**Problem:** Network can fail, LLM can timeout, user needs clear error state and recovery path.

**Old Architecture:**
```typescript
async function handleStreamError(msg: { 
  threadId: string, 
  error: string,
  messageId?: string 
}) {
  // 1. Remove from generating cache
  generatingMessagesCache.value.delete(msg.threadId)
  
  // 2. Mark message as error
  const message = messageCache.value.get(msg.messageId)
  if (message) {
    message.status = 'error'
    message.error = msg.error
  }
  
  // 3. Update thread status
  updateThreadWorkingStatus(msg.threadId, 'error')
  
  // 4. Enable input again
  generatingThreadIds.value.delete(msg.threadId)
  
  // 5. Show error UI
  toast.error(`Generation failed: ${msg.error}`)
  
  // 6. Allow retry
  // User can click "Retry" button which:
  // - Re-sends same message
  // - Creates new assistant message
  // - Doesn't duplicate user message
}
```

**Why So Complex?**
- Network can fail mid-stream
- LLM can timeout
- User needs clear error state
- User needs recovery path (retry)

**Decision:** ✅ **KEEP** — Essential for reliability

**Why:**
- Errors WILL happen (network, LLM, bugs)
- User needs to know what went wrong
- User needs to recover without losing work
- Retry is essential (don't make user re-type message)

**New Architecture:**
- Has `STREAM_EVENTS.ERROR` listener in messageStore
- Reloads messages on error
- **Question:** Is there a retry mechanism?

**Migration:**
- Verify error handling in messageStore
- Add retry button to MessageItemAssistant
- Implement retry logic (re-send same content, create new assistant message)

---

## What New Architecture Can Simplify

### 1. Unified Agent Interface

**Old:** Complex coupling between chatStore, agentPresenter, sessionPresenter

**New:** Clean agent interface pattern
```typescript
interface IAgentImplementation {
  initSession(sessionId: string, config: {...}): Promise<void>
  destroySession(sessionId: string): Promise<void>
  processMessage(sessionId: string, content: string): Promise<void>
  getMessages(sessionId: string): Promise<ChatMessageRecord[]>
  // ...
}
```

**Trade-off:** None — this is purely better

**Benefit:**
- Easier to add new agents (ACP, custom, etc.)
- Clear separation of concerns
- Testable interfaces

---

### 2. Separate Message and Session Stores

**Old:** chatStore handles everything (sessions, messages, config, UI state)

**New:** Focused stores
- `sessionStore`: Session list, active session, session state
- `messageStore`: Messages, streaming state
- `modelConfigStore`: Provider/model configuration
- `uiSettingsStore`: UI preferences

**Trade-off:** More files to navigate

**Benefit:**
- Better separation of concerns
- Smaller, more focused stores
- Easier to test and reason about

---

### 3. Streaming Blocks vs Skeleton Message

**Old:** Create empty assistant message, fill progressively

**New:** `streamingBlocks` separate from message cache

**Trade-off:** Slightly more complex mental model

**Benefit:**
- Clearer separation: streaming state vs persisted state
- Easier to handle streaming errors
- Better support for rich content (tool calls, images, etc.)

---

## What Must Be Preserved

### 1. Optimistic User Messages

**Why:** UX responsiveness is non-negotiable

**Implementation:**
- Keep `messageStore.addOptimisticUserMessage()`
- Ensure send flow uses it
- Handle optimistic → real merge

---

### 2. Progressive Rendering

**Why:** Users need feedback during long generation

**Implementation:**
- Keep `streamingBlocks` pattern
- Show "thinking" indicator
- Enable stop button immediately

---

### 3. Event Separation

**Why:** Different concerns need independent handling

**Implementation:**
- Keep `STREAM_EVENTS.RESPONSE`, `STREAM_EVENTS.END`, `SESSION_EVENTS.STATUS_CHANGED`
- Ensure all are emitted by backend
- Ensure all are handled by frontend

---

### 4. Session List Auto-Refresh

**Why:** Data consistency across windows

**Implementation:**
- Keep `SESSION_EVENTS.LIST_UPDATED` listener
- Verify backend emits on all changes
- Test multi-window scenarios

---

### 5. Error Recovery with Retry

**Why:** Errors will happen; users need recovery

**Implementation:**
- Keep error handling in messageStore
- Add retry button to UI
- Implement retry logic (re-send, new assistant message)

---

### 6. Permission Flow (Session Stays Generating)

**Why:** Prevents race conditions, clear UX

**Implementation:**
- Session stays 'generating' during permission wait
- Input stays disabled
- Add timeout (5 minutes) to prevent indefinite blocking

---

## Feature Necessity Matrix

| Feature | Old Has? | New Has? | Essential? | Why? | Decision |
|---------|----------|----------|------------|------|----------|
| Optimistic user messages | ✅ | ✅ | **Yes** | UX: no network delay visible | ✅ Keep |
| Assistant skeleton/streaming | ✅ | ✅ (streamingBlocks) | **Yes** | Progressive rendering essential | ✅ Keep (evolved) |
| Message cache version bumping | ✅ | ⚠️ (needs verification) | **Yes** | Vue reactivity requirement | ✅ Keep |
| Many events (separation) | ✅ | ✅ | **Yes** | Different concerns, independent error handling | ✅ Keep |
| Multi-session concurrency | ✅ | ⚠️ (partial) | **Maybe** | Power user feature | ⚠️ Add `generatingSessionIds` |
| Multi-window tracking | ✅ | ⚠️ (partial) | **Maybe** | Depends on product requirements | ⚠️ Defer to v2 |
| Permission timeout | ❌ | ❌ | **Yes** | Prevents indefinite blocking | ✅ Add |
| Retry on error | ✅ | ❌ | **Yes** | Essential for reliability | ✅ Add |
| Session list auto-refresh | ✅ | ✅ | **Yes** | Data consistency | ✅ Keep |
| Session switching during generation | ✅ | ⚠️ (needs verification) | **Yes** | User autonomy | ✅ Verify & keep |

---

## Updated Gap Analysis

### Critical Gaps (Must Fill)

1. **`generatingSessionIds` in sessionStore**
   - **Why:** Track which sessions are generating (per-session, not global boolean)
   - **Impact:** Cannot show per-session status in UI
   - **Task:** P0-1 in TASKS.md

2. **`cancelGenerating` method in sessionStore**
   - **Why:** Users need to stop generation
   - **Impact:** No way to cancel long-running generation
   - **Task:** P0-2 in TASKS.md

3. **Permission timeout**
   - **Why:** Prevent indefinite blocking
   - **Impact:** Session can block forever if user walks away
   - **Task:** Add to newAgentPresenter

4. **Retry mechanism**
   - **Why:** Users need to recover from errors
   - **Impact:** User must re-type message on error
   - **Task:** Add retry button + logic

5. **ChatInputBox binding to generating state**
   - **Why:** Input must be disabled during generation
   - **Impact:** User can send message while generating (breaks flow)
   - **Task:** P0-3 in TASKS.md

6. **Stop button binding to cancelGenerating**
   - **Why:** Users need to stop generation
   - **Impact:** No way to cancel
   - **Task:** P0-4 in TASKS.md

### Optional Gaps (Can Fill Later)

1. **Multi-window active session tracking**
   - **Why:** Power users might have multiple windows
   - **Impact:** Limited to single window for now
   - **Decision:** Defer to v2

2. **Concurrent session generation optimization**
   - **Why:** Power users might generate in multiple sessions
   - **Impact:** Can track but not optimize UI for it
   - **Decision:** Add basic support, optimize later

### Unnecessary Complexity (Don't Migrate)

1. **Complex message cache versioning for every change**
   - **Why:** Can use Vue 3 `reactive()` for better reactivity
   - **Decision:** Simplify with modern Vue patterns

2. **Over-engineered multi-window coordination**
   - **Why:** Not a requirement for MVP
   - **Decision:** Keep simple single-window approach

---

## Questions for User

### 1. Do we need multi-window support?

**Context:** Old architecture tracks active session per window (`activeThreadIdMap: Map<webContentsId, threadId>`). New architecture has single `activeSessionId`.

**Options:**
- **A:** Keep single-window (simpler, MVP focus)
- **B:** Add multi-window support (more complex, power users)

**Recommendation:** **A** — Single-window for MVP, add in v2 if needed

---

### 2. Do we need concurrent session generation?

**Context:** Old architecture supports multiple sessions generating simultaneously (`generatingThreadIds: Set<string>`). New architecture has global `isStreaming: boolean`.

**Options:**
- **A:** Add `generatingSessionIds: Set<string>` (supports concurrency)
- **B:** Keep global `isStreaming` (single generation at a time)

**Recommendation:** **A** — Add basic support, minimal complexity

---

### 3. Is optimistic messaging essential?

**Context:** Shows user message immediately before backend confirms. Adds complexity (merge logic).

**Options:**
- **A:** Keep optimistic messages (better UX)
- **B:** Wait for backend confirmation (simpler, slower UX)

**Recommendation:** **A** — Industry standard, expected UX

---

### 4. What should permission timeout be?

**Context:** Prevents indefinite blocking if user walks away.

**Options:**
- **A:** 2 minutes (aggressive)
- **B:** 5 minutes (reasonable)
- **C:** 10 minutes (conservative)
- **D:** No timeout (user must always respond)

**Recommendation:** **B** — 5 minutes balances UX and resource usage

---

### 5. Should retry auto-resend or require confirmation?

**Context:** User clicks "Retry" after error.

**Options:**
- **A:** Auto-resend same content (faster)
- **B:** Show confirmation dialog (safer)
- **C:** Open input with pre-filled content (user edits before sending)

**Recommendation:** **C** — User can review/edit before retry

---

## Recommendations

### Keep from Old

1. ✅ Optimistic user messages
2. ✅ Progressive rendering (streaming blocks)
3. ✅ Event separation (RESPONSE, END, STATUS_CHANGED)
4. ✅ Session list auto-refresh (LIST_UPDATED)
5. ✅ Error handling with retry
6. ✅ Permission flow (session stays generating)
7. ✅ Session switching during generation

### Drop from Old

1. ❌ Over-engineered multi-window tracking (defer to v2)
2. ❌ Complex message cache versioning (use Vue 3 reactive)
3. ❌ No permission timeout (add timeout)

### New Patterns

1. ✅ Unified agent interface (cleaner architecture)
2. ✅ Separate message/session stores (better separation)
3. ✅ Streaming blocks vs skeleton message (clearer state)
4. ✅ TypeScript-first design (better type safety)

---

## Implementation Priority

### Phase 1: Critical UI Bindings (P0)

1. Add `generatingSessionIds` to sessionStore
2. Add `cancelGenerating` method
3. Bind ChatInputBox to generating state
4. Bind StopButton to cancelGenerating
5. Verify all events are emitted and handled

### Phase 2: Error Handling (P1)

1. Add retry mechanism
2. Add permission timeout
3. Improve error messages
4. Test error scenarios

### Phase 3: Polish (P2)

1. Add multi-session concurrency support
2. Optimize UI for concurrent generation
3. Add keyboard shortcuts (Escape to cancel)
4. Improve loading states

---

## Conclusion

The old architecture's complexity is **mostly justified** — it solves real problems:

- **Optimistic messages** → UX responsiveness
- **Streaming blocks** → Progressive rendering
- **Event separation** → Robust error handling
- **Session tracking** → Multi-window sync
- **Permission flow** → Correct tool call handling

**The new architecture can simplify:**

- Cleaner agent interface
- Better separation of concerns
- Modern Vue 3 patterns

**But must preserve:**

- Optimistic updates
- Progressive rendering
- Event-driven architecture
- Error recovery
- Permission handling

**Key decisions needed:**

1. Multi-window support? → **Defer to v2**
2. Concurrent generation? → **Add basic support**
3. Permission timeout? → **5 minutes**
4. Retry behavior? → **Pre-fill input, user confirms**

With these decisions, the new architecture will be **simpler but not weaker** — removing accidental complexity while preserving essential patterns.
