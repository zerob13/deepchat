# Event Flow Diagrams

**Date:** 2026-02-28  
**Purpose:** Visual representation of event flows in old vs new architecture

---

## Diagram 1: Old Architecture - Complete Event Flow

```
┌─────────────────────────────────────────────────────────────────────────┐
│                         BACKEND (Main Process)                          │
│                                                                         │
│  agentPresenter.sendMessage()                                           │
│         │                                                               │
│         ▼                                                               │
│  ┌─────────────────┐                                                   │
│  │ Set status:     │                                                   │
│  │ 'generating'    │                                                   │
│  └────────┬────────┘                                                   │
│           │                                                            │
│           │ SESSION_EVENTS.STATUS_CHANGED                              │
│           ├────────────────────────────────────────────────────┐       │
│           ▼                                                    │       │
│  ┌─────────────────┐                                           │       │
│  │ Stream LLM      │                                           │       │
│  │ Response        │                                           │       │
│  └────────┬────────┘                                           │       │
│           │                                                    │       │
│           │ STREAM_EVENTS.RESPONSE (tokens)                    │       │
│           ├────────────────────────────────────────────────────┤       │
│           │                                                    │       │
│           │ STREAM_EVENTS.END                                  │       │
│           ├────────────────────────────────────────────────────┤       │
│           │                                                    │       │
│           │ SESSION_EVENTS.STATUS_CHANGED ('idle')             │       │
│           ├────────────────────────────────────────────────────┤       │
│           ▼                                                    │       │
│  ┌─────────────────┐                                           │       │
│  │ Set status:     │                                           │       │
│  │ 'idle'          │                                           │       │
│  └─────────────────┘                                           │       │
└───────────┬────────────────────────────────────────────────────┼───────┘
            │                                                    │
            │ IPC                                                │ IPC
            ▼                                                    ▼
┌─────────────────────────────────────────────────────────────────────────┐
│                    FRONTEND (Renderer Process)                          │
│                                                                         │
│  ┌────────────────────────────────────────────────────────────────┐    │
│  │ chatStore Event Listeners                                      │    │
│  │                                                                 │    │
│  │  SESSION_EVENTS.STATUS_CHANGED  ──► updateThreadWorkingStatus()│    │
│  │                                    threadsWorkingStatusMap     │    │
│  │                                                                 │    │
│  │  STREAM_EVENTS.RESPONSE  ──► handleStreamResponse()            │    │
│  │                              generatingMessagesCache.set()     │    │
│  │                              generatingThreadIds.add()         │    │
│  │                              messageCache.set()                │    │
│  │                                                                 │    │
│  │  STREAM_EVENTS.END  ──► handleStreamEnd()                      │    │
│  │                           generatingMessagesCache.delete()     │    │
│  │                           generatingThreadIds.delete()         │    │
│  │                           updateThreadWorkingStatus()          │    │
│  └────────────────────────────────────────────────────────────────┘    │
│                     │                        │                          │
│                     ▼                        ▼                          │
│         ┌────────────────────┐   ┌────────────────────┐                │
│         │ generatingThreadIds│   │ threadsWorking     │                │
│         │ Set<string>        │   │ StatusMap          │                │
│         │                    │   │                    │                │
│         │ Contains active    │   │ Per-session status │                │
│         │ generating thread  │   │ (working/completed/│                │
│         │ IDs                │   │  error)            │                │
│         └────────┬───────────┘   └─────────┬──────────┘                │
│                  │                         │                            │
│                  ▼                         ▼                            │
│         ┌────────────────────┐   ┌────────────────────┐                │
│         │ ChatInputBox       │   │ WindowSideBar      │                │
│         │                    │   │                    │                │
│         │ disabled:          │   │ Session status     │                │
│         │ generatingThreadIds│   │ icons:             │                │
│         │ .has(activeId)     │   │  - loader (working)│                │
│         │                    │   │  - check (complete)│                │
│         │ stop button:       │   │  - error (error)   │                │
│         │ v-if="generating"  │   │                    │                │
│         └────────────────────┘   └────────────────────┘                │
└─────────────────────────────────────────────────────────────────────────┘
```

### Key Characteristics of Old Architecture

1. **Single Store:** `chatStore` handles everything (sessions + messages)
2. **Direct Binding:** UI components read directly from `chatStore` state
3. **Explicit Generating State:** `generatingThreadIds` Set for O(1) lookup
4. **Comprehensive Event Handling:** All lifecycle events captured

---

## Diagram 2: New Architecture - Current State (WITH GAPS)

```
┌─────────────────────────────────────────────────────────────────────────┐
│                         BACKEND (Main Process)                          │
│                                                                         │
│  deepchatAgentPresenter.processMessage()                                │
│         │                                                               │
│         ▼                                                               │
│  ┌─────────────────┐                                                   │
│  │ Set status:     │                                                   │
│  │ 'generating'    │                                                   │
│  └────────┬────────┘                                                   │
│           │                                                            │
│           │ SESSION_EVENTS.STATUS_CHANGED ✅                            │
│           ├────────────────────────────────────────────────────┐       │
│           ▼                                                    │       │
│  ┌─────────────────┐                                           │       │
│  │ processStream() │                                           │       │
│  │                 │                                           │       │
│  │ STREAM_EVENTS.  │                                           │       │
│  │ RESPONSE ✅     │                                           │       │
│  ├─────────────────┤                                           │       │
│  │ STREAM_EVENTS.  │                                           │       │
│  │ END ✅          │                                           │       │
│  └────────┬────────┘                                           │       │
│           │                                                    │       │
│           │ SESSION_EVENTS.STATUS_CHANGED ✅                    │       │
│           ├────────────────────────────────────────────────────┤       │
│           ▼                                                    │       │
│  ┌─────────────────┐                                           │       │
│  │ Set status:     │                                           │       │
│  │ 'idle'          │                                           │       │
│  └─────────────────┘                                           │       │
└───────────┬────────────────────────────────────────────────────┼───────┘
            │                                                    │
            │ IPC                                                │ IPC
            ▼                                                    ▼
┌─────────────────────────────────────────────────────────────────────────┐
│                    FRONTEND (Renderer Process)                          │
│                                                                         │
│  ┌────────────────────────┐    ┌────────────────────────┐              │
│  │ sessionStore           │    │ messageStore           │              │
│  │                        │    │                        │              │
│  │ SESSION_EVENTS.        │    │ STREAM_EVENTS.         │              │
│  │ STATUS_CHANGED ✅      │    │ RESPONSE ✅            │              │
│  │   → session.status     │    │   → streamingBlocks    │              │
│  │                        │    │   → isStreaming ✅     │              │
│  │ sessions[] with status │    │                        │              │
│  └───────────┬────────────┘    └───────────┬────────────┘              │
│              │                             │                            │
│              │ status stored               │ isStreaming = true         │
│              │ but... ❌                   │ but... ❌                  │
│              │                             │                            │
│              ▼                             ▼                            │
│    ┌─────────────────────┐      ┌─────────────────────┐                │
│    │ WindowSideBar ✅    │      │ ChatPage ⚠️         │                │
│    │                     │      │                     │                │
│    │ Reads session.status│      │ Reads messageStore. │                │
│    │ Shows status icons  │      │ isStreaming (global)│                │
│    │                     │      │                     │                │
│    │ ✅ WORKING          │      │ ⚠️ Global flag, not │                │
│    │                     │      │    session-specific │                │
│    └─────────────────────┘      └──────────┬──────────┘                │
│                                            │                            │
│                                            ▼                            │
│                                   ┌─────────────────────┐              │
│                                   │ ChatInput ❌        │              │
│                                   │                     │              │
│                                   │ ❌ No binding to    │              │
│                                   │    session status   │              │
│                                   │ ❌ Uses old         │              │
│                                   │    chatStore        │              │
│                                   │ ❌ Stop button calls│              │
│                                   │    wrong store      │              │
│                                   └─────────────────────┘              │
│                                                                         │
│  ┌────────────────────────────────────────────────────────────────┐    │
│  │ ❌ MISSING: CONVERSATION_EVENTS.LIST_UPDATED listener          │    │
│  │    → Session list won't auto-refresh                           │    │
│  │                                                                 │    │
│  │ ❌ MISSING: generatingSessionIds set in sessionStore           │    │
│  │    → No O(1) lookup for "is generating?"                       │    │
│  │                                                                 │    │
│  │ ❌ MISSING: sessionStore.cancelGenerating() method             │    │
│  │    → Stop button can't cancel                                  │    │
│  └────────────────────────────────────────────────────────────────┘    │
└─────────────────────────────────────────────────────────────────────────┘
```

### Critical Gaps Highlighted

1. **❌ ChatInput Not Bound:** Input box doesn't disable during generation
2. **❌ Wrong Store:** Components still read from old `chatStore`
3. **❌ Missing Cancel:** No `cancelGenerating()` in sessionStore
4. **❌ Global State:** `isStreaming` is not session-specific
5. **❌ Missing Event:** No `CONVERSATION_EVENTS.LIST_UPDATED` listener

---

## Diagram 3: New Architecture - Target State (AFTER FIXES)

```
┌─────────────────────────────────────────────────────────────────────────┐
│                         BACKEND (Main Process)                          │
│                                                                         │
│  deepchatAgentPresenter.processMessage()                                │
│         │                                                               │
│         ▼                                                               │
│  ┌─────────────────┐                                                   │
│  │ status:         │                                                   │
│  │ 'generating'    │                                                   │
│  └────────┬────────┘                                                   │
│           │                                                            │
│           │ SESSION_EVENTS.STATUS_CHANGED ✅                            │
│           ├────────────────────────────────────────────────────┐       │
│           ▼                                                    │       │
│  ┌─────────────────┐                                           │       │
│  │ processStream() │                                           │       │
│  │                 │                                           │       │
│  │ + EMIT:         │                                           │       │
│  │ CONVERSATION_   │                                           │       │
│  │ EVENTS.UPDATED  │                                           │       │
│  │                 │                                           │       │
│  │ STREAM_EVENTS.  │                                           │       │
│  │ RESPONSE ✅     │                                           │       │
│  ├─────────────────┤                                           │       │
│  │ STREAM_EVENTS.  │                                           │       │
│  │ END ✅          │                                           │       │
│  └────────┬────────┘                                           │       │
│           │                                                    │       │
│           │ SESSION_EVENTS.STATUS_CHANGED ✅                    │       │
│           ├────────────────────────────────────────────────────┤       │
│           ▼                                                    │       │
│  ┌─────────────────┐                                           │       │
│  │ status: 'idle'  │                                           │       │
│  └─────────────────┘                                           │       │
└───────────┬────────────────────────────────────────────────────┼───────┘
            │                                                    │
            │ IPC                                                │ IPC
            ▼                                                    ▼
┌─────────────────────────────────────────────────────────────────────────┐
│                    FRONTEND (Renderer Process)                          │
│                                                                         │
│  ┌────────────────────────┐    ┌────────────────────────┐              │
│  │ sessionStore ✅        │    │ messageStore ✅        │              │
│  │                        │    │                        │              │
│  │ + generatingSessionIds │    │ STREAM_EVENTS.         │              │
│  │   Set<string>          │    │ RESPONSE ✅            │              │
│  │                        │    │   → streamingBlocks    │              │
│  │ SESSION_EVENTS.        │    │   → sync with session  │              │
│  │ STATUS_CHANGED ✅      │    │     status             │              │
│  │   → session.status     │    │                        │              │
│  │   → generatingSession  │    │ STREAM_EVENTS.END ✅   │              │
│  │     IDs.add/delete     │    │   → clear streaming    │              │
│  │                        │    │                        │              │
│  │ + cancelGenerating()   │    │ + watch session status │              │
│  │   → call backend       │    │                        │              │
│  │                        │    │                        │              │
│  │ + CONVERSATION_EVENTS  │    │                        │              │
│  │   .LIST_UPDATED ✅     │    │                        │              │
│  │   → fetchSessions()    │    │                        │              │
│  └───────────┬────────────┘    └───────────┬────────────┘              │
│              │                             │                            │
│              │ generatingSessionIds        │ isStreaming synced         │
│              │ has(activeSessionId)        │ with session status        │
│              │                             │                            │
│              ▼                             ▼                            │
│    ┌─────────────────────┐      ┌─────────────────────┐                │
│    │ WindowSideBar ✅    │      │ ChatPage ✅         │                │
│    │                     │      │                     │                │
│    │ Reads session.status│      │ Watches session     │                │
│    │ Shows status icons  │      │ status changes      │                │
│    │                     │      │                     │                │
│    │ ✅ WORKING          │      │ ✅ Shows loading    │                │
│    │                     │      │ ✅ Toast on complete│                │
│    └─────────────────────┘      └──────────┬──────────┘                │
│                                            │                            │
│                                            ▼                            │
│                                   ┌─────────────────────┐              │
│                                   │ ChatInput ✅        │              │
│                                   │                     │              │
│                                   │ disabled: session   │              │
│                                   │ .status === 'work'  │              │
│                                   │                     │              │
│                                   │ stop button:        │              │
│                                   │ v-if="status==='wk' │                │
│                                   │ @click="cancelGen() │              │
│                                   │                     │              │
│                                   │ ✅ PROPERLY BOUND   │              │
│                                   └─────────────────────┘              │
│                                                                         │
│  ┌────────────────────────────────────────────────────────────────┐    │
│  │ ✅ ADDED: CONVERSATION_EVENTS.LIST_UPDATED listener            │    │
│  │    → Session list auto-refreshes                               │    │
│  │                                                                 │    │
│  │ ✅ ADDED: generatingSessionIds set in sessionStore             │    │
│  │    → O(1) lookup for "is generating?"                          │    │
│  │                                                                 │    │
│  │ ✅ ADDED: sessionStore.cancelGenerating() method               │    │
│  │    → Stop button works correctly                               │    │
│  │                                                                 │    │
│  │ ✅ MIGRATED: ChatStatusBar reads from sessionStore             │    │
│  │    → Model selector shows session model                        │    │
│  │                                                                 │    │
│  │ ✅ ADDED: Permission dropdown in ChatStatusBar                 │    │
│  │    → Can change permission mid-session                         │    │
│  └────────────────────────────────────────────────────────────────┘    │
└─────────────────────────────────────────────────────────────────────────┘
```

---

## Diagram 4: State Synchronization Flow

```
┌──────────────────────────────────────────────────────────────────────────┐
│                    SESSION STATUS SYNCHRONIZATION                        │
└──────────────────────────────────────────────────────────────────────────┘

Backend                    sessionStore              messageStore
   │                           │                          │
   │ processMessage()          │                          │
   │ status = 'generating'     │                          │
   │                           │                          │
   │ SESSION_EVENTS.           │                          │
   │ STATUS_CHANGED ──────────►│                          │
   │   {sessionId, status}     │                          │
   │                           │                          │
   │                           │ session.status =         │
   │                           │ 'working'                │
   │                           │                          │
   │                           │ generatingSessionIds     │
   │                           │ .add(sessionId)          │
   │                           │                          │
   │                           │ SESSION_EVENTS.          │
   │                           │ STATUS_CHANGED ────────► │
   │                           │ (shared event bus)       │
   │                           │                          │
   │                           │                          │ isStreaming = true
   │                           │                          │ (via watch)
   │                           │                          │
   │ processStream()           │                          │
   │                           │                          │
   │ STREAM_EVENTS.            │                          │
   │ RESPONSE ────────────────┼─────────────────────────►│
   │   {conversationId,        │                          │ streamingBlocks =
   │    blocks}                │                          │ blocks
   │                           │                          │
   │                           │                          │
   │ STREAM_EVENTS.            │                          │
   │ END ─────────────────────┼─────────────────────────►│
   │   {conversationId}        │                          │ isStreaming = false
   │                           │                          │ streamingBlocks = []
   │                           │                          │
   │ status = 'idle'           │                          │
   │                           │                          │
   │ SESSION_EVENTS.           │                          │
   │ STATUS_CHANGED ──────────►│                          │
   │   {sessionId, status}     │                          │
   │                           │                          │
   │                           │ session.status =         │
   │                           │ 'completed'              │
   │                           │                          │
   │                           │ generatingSessionIds     │
   │                           │ .delete(sessionId)       │
   │                           │                          │
```

---

## Diagram 5: Component State Dependencies

```
┌─────────────────────────────────────────────────────────────────────────┐
│                    UI COMPONENT STATE DEPENDENCIES                      │
└─────────────────────────────────────────────────────────────────────────┘

Component               Current State Source        Target State Source
─────────────────────────────────────────────────────────────────────────

ChatInputBox
  - disabled            ❌ (none)                   ✅ sessionStore.generatingSessionIds
  - showStopButton      ❌ (none)                   ✅ sessionStore.generatingSessionIds
  - onStop              ❌ (none)                   ✅ sessionStore.cancelGenerating()

ChatInput
  - isStreaming         ⚠️ messageStore.isStreaming ✅ sessionStore.activeSession.status
  - handleCancel        ❌ chatStore.cancelGenerating ✅ sessionStore.cancelGenerating()

ChatStatusBar
  - modelId             ⚠️ chatStore.chatConfig     ✅ sessionStore.activeSession.modelId
  - permissionMode      ❌ (static)                  ✅ sessionStore.activeSession.permissionMode

ChatPage
  - displayMessages     ✅ messageStore.messages    ✅ (no change needed)
  - loading indicator   ❌ (none)                   ✅ sessionStore.activeSession.status

WindowSideBar
  - session.status      ✅ sessionStore.sessions    ✅ (no change needed)
  - status icons        ✅ sessionStore.sessions    ✅ (no change needed)

MessageList
  - messages            ✅ messageStore.messages    ✅ (no change needed)
  - streaming message   ✅ messageStore.streaming   ✅ (no change needed)
```

---

## Diagram 6: Event Flow Comparison Matrix

```
┌─────────────────────────────────────────────────────────────────────────┐
│                         EVENT FLOW COMPARISON                           │
└─────────────────────────────────────────────────────────────────────────┘

Event: STREAM_EVENTS.RESPONSE
─────────────────────────────────────────────────────────────────────────
Old Architecture:
  Backend → chatStore.handleStreamResponse()
              ├─► generatingMessagesCache.set()
              ├─► generatingThreadIds.add()
              └─► messageCache.set()
                  └─► UI: MessageList updates

New Architecture (Current):
  Backend → messageStore handler
              ├─► streamingBlocks = blocks
              └─► isStreaming = true
                  └─► UI: ChatPage displayMessages includes streaming

New Architecture (Target):
  Backend → messageStore handler
              ├─► streamingBlocks = blocks
              ├─► isStreaming = true
              └─► sessionStore.generatingSessionIds.add()
                  └─► UI: ChatInput disabled
                  └─► UI: ChatPage shows loading
                  └─► UI: WindowSideBar shows spinner

─────────────────────────────────────────────────────────────────────────

Event: SESSION_EVENTS.STATUS_CHANGED
─────────────────────────────────────────────────────────────────────────
Old Architecture:
  Backend → chatStore handler
              ├─► threadsWorkingStatusMap.set()
              └─► UI: WindowSideBar shows status icon

New Architecture (Current):
  Backend → sessionStore handler
              ├─► session.status = mapped_status
              └─► UI: WindowSideBar shows status icon ✅

New Architecture (Target):
  Backend → sessionStore handler
              ├─► session.status = mapped_status
              ├─► generatingSessionIds.add/delete()
              └─► UI: WindowSideBar shows status icon ✅
              └─► UI: ChatInput disabled state updates ✅
              └─► UI: ChatPage shows loading/toast ✅

─────────────────────────────────────────────────────────────────────────

Event: STREAM_EVENTS.END
─────────────────────────────────────────────────────────────────────────
Old Architecture:
  Backend → chatStore.handleStreamEnd()
              ├─► generatingMessagesCache.delete()
              ├─► generatingThreadIds.delete()
              ├─► updateThreadWorkingStatus('completed')
              └─► UI: Input enabled, stop button hidden

New Architecture (Current):
  Backend → messageStore handler
              ├─► isStreaming = false
              ├─► streamingBlocks = []
              └─► loadMessages()
                  └─► UI: MessageList updates

New Architecture (Target):
  Backend → messageStore handler
              ├─► isStreaming = false
              ├─► streamingBlocks = []
              └─► loadMessages()
                  └─► UI: MessageList updates ✅
              └─► sessionStore.generatingSessionIds.delete()
                  └─► UI: ChatInput enabled ✅
                  └─► UI: Stop button hidden ✅
```

---

## Summary: Key Differences

| Aspect | Old Architecture | New Architecture (Current) | New Architecture (Target) |
|--------|------------------|---------------------------|--------------------------|
| **Store Structure** | Monolithic `chatStore` | Split: `sessionStore` + `messageStore` | Same, with better sync |
| **Generating State** | `generatingThreadIds: Set` | ❌ Missing | `generatingSessionIds: Set` |
| **UI Binding** | Direct from `chatStore` | Mixed (old + new) | All from new stores |
| **Stop/Cancel** | `chatStore.cancelGenerating()` | ❌ Broken | `sessionStore.cancelGenerating()` |
| **Event Coverage** | Complete | Missing `CONVERSATION_EVENTS` | Complete |
| **Session Status** | `threadsWorkingStatusMap` | `session.status` (underutilized) | `session.status` + UI bound |
| **Scalability** | Single session focus | Multi-session ready | Multi-session with per-session state |

---

## Migration Path

```
Phase 1 (P0): Critical UI Bindings
  ├─ Add generatingSessionIds to sessionStore
  ├─ Add cancelGenerating() to sessionStore
  ├─ Bind ChatInput to sessionStore
  └─ Fix ChatStatusBar bindings

Phase 2 (P1): Event Flow Completion
  ├─ Add CONVERSATION_EVENTS listener
  ├─ Sync messageStore.isStreaming with session status
  └─ Add session-specific streaming state

Phase 3 (P2): Polish
  ├─ Typing indicator
  ├─ Toast notifications
  └─ Progress indicators

Phase 4 (Future): Deprecation
  ├─ Remove chatStore usage from new components
  └─ Migrate old components to new stores
```
