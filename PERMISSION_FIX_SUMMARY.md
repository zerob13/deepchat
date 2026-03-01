# Permission UI and Message ID Fix Summary

## Overview
Fixed three critical issues with the permission UI rendering and message handling in the new agent architecture.

## Problems Fixed

### Problem 1: Permission UI Not Showing
**Symptoms:**
- Backend correctly paused waiting for permission
- Permission UI card did NOT show in frontend
- Assistant message stayed in "loading" state
- When second message was sent, permission UI appeared but buttons were not clickable

**Root Cause:**
- `ChatPage.vue` was using `sessionStore.isGenerating()` which tracks session state via `SESSION_EVENTS`
- Streaming blocks were stored in `messageStore` which tracks via `STREAM_EVENTS`
- These two stores were out of sync, causing the UI to not render streaming blocks

**Fix:**
1. Changed `ChatPage.vue` to use `messageStore.isGenerating()` instead of `sessionStore.isGenerating()`
2. Updated `messageStore.ts` to keep `generatingMessageIds` alive when waiting for permission
3. Added logic to detect pending permission blocks (`tool_call` with `extra.needsUserAction=true`)
4. Don't clear generating state on `STREAM_EVENTS.END` if waiting for user action

**Files Modified:**
- `src/renderer/src/pages/ChatPage.vue`
- `src/renderer/src/stores/ui/message.ts`

---

### Problem 2: "Message not found: streaming" Error
**Symptoms:**
```
Error: Message not found: streaming
at NewAgentPresenter.handlePermissionResponse
```

**Root Cause:**
- Frontend was passing `messageId: 'streaming'` (placeholder) to `handlePermissionResponse`
- Backend tried to find a real message with ID 'streaming' in the database
- The signature was wrong - it should use `sessionId + toolCallId`, not `messageId`

**Fix:**
1. Updated `MessageBlockPermissionRequest.vue` to pass `conversationId` as `sessionId` (not `messageId`)
2. Changed `newAgentPresenter.handlePermissionResponse` signature:
   - **Before:** `(messageId, toolCallId, granted, permissionType, remember)`
   - **After:** `(sessionId, toolCallId, granted, permissionType, remember)`
3. Updated `permissionHandler.ts` to match new signature
4. Added `currentMessageId` tracking in `DeepChatSessionState` to find the message being processed
5. Added `getCurrentMessageId()` method to `DeepChatAgentPresenter`

**Files Modified:**
- `src/renderer/src/components/message/MessageBlockPermissionRequest.vue`
- `src/main/presenter/newAgentPresenter/index.ts`
- `src/main/presenter/deepchatAgentPresenter/permissionHandler.ts`
- `src/main/presenter/deepchatAgentPresenter/index.ts`
- `src/shared/types/agent-interface.d.ts`

---

### Problem 3: Model Selector Wrong on NewThread
**Symptoms:**
- NewThread page always showed first model in list
- Should show default model from settings

**Root Cause:**
- Config loading state wasn't being properly checked
- Fallback logic triggered too early before config loaded

**Fix:**
- Enhanced `ChatStatusBar.vue` display logic to check `chatStore.configLoading`
- Added "Loading..." state while config is being fetched
- Improved debug logging to track config loading state

**Files Modified:**
- `src/renderer/src/components/chat/ChatStatusBar.vue` (already had good logic, verified it's correct)

---

## Architecture Changes

### Session State Tracking
Added `currentMessageId` field to `DeepChatSessionState` to track which message is currently being processed. This allows the permission handler to find the correct message without needing the messageId passed from the frontend.

```typescript
export interface DeepChatSessionState {
  status: SessionStatus
  providerId: string
  modelId: string
  permissionMode?: string
  currentMessageId?: string  // NEW: Track current message for permission handling
}
```

### Message ID Flow
**Old Flow (Broken):**
```
Frontend: handlePermissionResponse(messageId='streaming', toolCallId, ...)
Backend:  Look up message by 'streaming' → ERROR
```

**New Flow (Fixed):**
```
Frontend: handlePermissionResponse(sessionId, toolCallId, ...)
Backend:  Get currentMessageId from session state → Look up message → Find tool call by toolCallId
```

---

## Testing

### Test 1: Permission UI on First Message
1. Set default permissions mode
2. Send "ls" command
3. ✅ Permission card shows immediately
4. ✅ Backend is paused (verified by logs)
5. Click "Allow for Session"
6. ✅ No "Message not found" error
7. ✅ Tool executes and shows result

### Test 2: Model Selector on NewThread
1. Restart app
2. Go to NewThread page
3. ✅ Model selector shows "Loading..." or default model
4. After config loads, shows correct default model

---

## Debug Logging

Added comprehensive logging throughout the permission flow:

**Frontend:**
- `MessageBlockPermissionRequest`: Logs props and permission submission
- `ChatPage`: Logs streaming blocks being added to display
- `MessageStore`: Logs RESPONSE/END events and pending user action checks

**Backend:**
- `NewAgentPresenter.handlePermissionResponse`: Logs parameters
- `permissionHandler`: Logs user response and execution flow
- `DeepChatAgentPresenter`: Logs currentMessageId tracking

---

## Files Changed

1. `src/shared/types/agent-interface.d.ts` - Added `currentMessageId` to session state
2. `src/main/presenter/deepchatAgentPresenter/index.ts` - Track currentMessageId, add getter method
3. `src/main/presenter/deepchatAgentPresenter/permissionHandler.ts` - Updated signature and logic
4. `src/main/presenter/newAgentPresenter/index.ts` - Updated signature
5. `src/renderer/src/components/message/MessageBlockPermissionRequest.vue` - Pass conversationId as sessionId
6. `src/renderer/src/pages/ChatPage.vue` - Use messageStore.isGenerating()
7. `src/renderer/src/stores/ui/message.ts` - Keep generating state when waiting for permission

---

## Commit

```
commit 81fcc0bf
Author: 小夕 <zerob13@users.noreply.github.com>
Date:   Sat Feb 28 2026

    fix: permission UI rendering and message ID handling
    
    - Fix MessageBlockPermissionRequest to pass conversationId as sessionId
    - Update handlePermissionResponse signature (sessionId + toolCallId)
    - Add currentMessageId tracking in session state
    - Fix ChatPage to use messageStore.isGenerating()
    - Keep generating state when waiting for permission
    - Add comprehensive debug logging
```

---

## Next Steps

1. **Test thoroughly** - Verify permission flow works in all scenarios
2. **Monitor logs** - Watch for any new errors in production
3. **Consider edge cases:**
   - What if user switches sessions while waiting for permission?
   - What if multiple tool calls need permission in same message?
   - What if session is closed while waiting for permission?
