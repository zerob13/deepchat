# Architecture Analysis Summary

**Date:** 2026-02-28  
**Task:** Deep Architecture Understanding - Why Old Design Is Complex

---

## Key Findings

### ✅ Old Architecture Complexity Is Mostly Justified

The old architecture isn't over-engineered — it solves **real problems**:

1. **Optimistic Messages** → Network latency makes UX feel broken without them
2. **Streaming Blocks** → LLM generation takes 5-30s, users need feedback
3. **Event Separation** → Different concerns (creation, streaming, completion, state) need independent error handling
4. **Session Tracking** → Multi-window sync requires backend-as-source-of-truth
5. **Permission Flow** → Tool calls need user approval without breaking generation flow

### ⚠️ New Architecture Gaps (Critical)

| Gap | Impact | Priority |
|-----|--------|----------|
| No `generatingSessionIds` set | Cannot track which session is generating | P0 |
| No `cancelGenerating` method | Users cannot stop generation | P0 |
| ChatInputBox not bound to state | Input not disabled during generation | P0 |
| No retry mechanism | User must re-type message on error | P1 |
| No permission timeout | Session can block forever | P1 |

### ✅ New Architecture Improvements

1. **Cleaner agent interface** — Easy to add new agents (ACP, custom)
2. **Separate stores** — Better separation of concerns (session vs message vs config)
3. **Streaming blocks** — Clearer separation of streaming vs persisted state
4. **TypeScript-first** — Better type safety and IDE support

---

## Feature Necessity Matrix

| Feature | Essential? | Decision |
|---------|------------|----------|
| Optimistic user messages | **Yes** | ✅ Keep (already in new arch) |
| Progressive rendering | **Yes** | ✅ Keep (streamingBlocks pattern) |
| Event separation | **Yes** | ✅ Keep (RESPONSE, END, STATUS_CHANGED) |
| Session list auto-refresh | **Yes** | ✅ Keep (LIST_UPDATED listener) |
| Error recovery with retry | **Yes** | ✅ Add (missing in new arch) |
| Permission timeout | **Yes** | ✅ Add (missing in both!) |
| Multi-session concurrency | Maybe | ⚠️ Add basic support |
| Multi-window tracking | Maybe | ⚠️ Defer to v2 |

---

## Questions for User

### 1. Multi-window support?

**Current:** New architecture has single `activeSessionId` (not per-window Map)

**Recommendation:** **Single-window for MVP** — Add in v2 if needed

---

### 2. Concurrent session generation?

**Current:** `messageStore.isStreaming` is boolean (not session-specific)

**Recommendation:** **Add `generatingSessionIds: Set<string>`** — Minimal complexity, supports power users

---

### 3. Permission timeout duration?

**User Decision:** ❌ **NO TIMEOUT** — Permission request should pause the loop indefinitely until user explicitly approves/denies. This is the correct interaction design.

**Rationale:** Auto-timeout would be confusing. User control is more important than resource cleanup.

---

### 4. Retry behavior?

**User Decision:** ✅ **Manual retry with user review** — User should review/edit message before retrying. No auto-retry.

**Rationale:** User intervention ensures they understand what failed and can fix the input if needed.

---

## Implementation Priority

### Phase 1: Critical UI Bindings (This Week)

- [ ] Add `generatingSessionIds` to sessionStore
- [ ] Add `cancelGenerating` method
- [ ] Bind ChatInputBox to generating state
- [ ] Bind StopButton to cancelGenerating
- [ ] Verify all events emitted and handled

### Phase 2: Error Handling (Next Week)

- [ ] Add retry mechanism
- [ ] Add permission timeout (5 min)
- [ ] Improve error messages
- [ ] Test error scenarios

### Phase 3: Polish (Later)

- [ ] Multi-session concurrency optimization
- [ ] Keyboard shortcuts (Escape to cancel)
- [ ] Improve loading states

---

## Deliverables

1. ✅ **ARCHITECTURE_UNDERSTANDING.md** — Deep dive (25KB)
2. ✅ **This summary** — Quick reference
3. ✅ **Updated TASKS.md** — Already has P0/P1 tasks defined

---

## Next Steps

1. **Review ARCHITECTURE_UNDERSTANDING.md** — Verify analysis matches your understanding
2. **Answer questions above** — Especially multi-window and concurrency
3. **Approve implementation priority** — Start with P0 tasks
4. **Update TASKS.md** — Based on decisions

---

## Key Insight

> **Don't simplify away essential complexity.** The old architecture's patterns exist for good reasons. The new architecture should preserve what matters (UX responsiveness, error recovery, progressive rendering) while simplifying what doesn't (over-engineered multi-window, complex cache versioning).

**Goal:** Simpler but not weaker.
