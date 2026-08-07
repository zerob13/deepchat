# Durable Execution Journal Specification

## Background

DeepChat currently uses Tape for append-only session facts and reconstructs model context through
anchors, effective views, recall, and ViewManifest records. Those Context Tape behaviors are
independent from the execution lifecycle of a physical Agent Run and remain valid.

The execution path has a narrower reliability gap. Tool call and result facts are derived from a
terminal transcript block after execution. A process crash can therefore occur after an external
side effect but before Tape contains evidence that the call was dispatched or what outcome was
observed. Run completion is also projected to transcript, status, and UI without a prior durable
terminal fact. Startup recovery can mark pending transcript messages as interrupted, but it cannot
classify the execution state from authoritative facts.

This architecture adds a durable Execution Journal as a separate fact family in the existing
physical Tape store. It does not replace Context Tape, the DeepChat loop, or runtime ownership of
active Runs.

## Problem Statement

Two contracts are missing from the current execution path:

1. **Authority contract:** native execution facts must be written by the execution path itself.
   Transcript reconciliation may reconstruct legacy context facts, but it must not manufacture
   Execution Journal facts.
2. **Commit contract:** a potentially side-effecting call needs a durable dispatch fact after every
   local refusal gate and immediately before the resolved invocation. A known outcome needs a
   durable outcome fact before it is projected to transcript, model context, status, or UI. A Run
   terminal fact needs to precede terminal projections.

Without these contracts, a restart cannot distinguish a call that was never authorized from a call
that may have reached its target.

## Goals

1. Give every physical DeepChat Run a restart-stable UUID identity.
2. Record native Run and tool boundary facts through a narrow, synchronous, fail-closed capability.
3. Make journal idempotency strict: the same identity and payload is idempotent; the same identity
   and a different payload is corruption.
4. Place dispatch commits after local validation, permission, policy, binding, target, and abort
   gates and immediately before the resolved side-effect boundary.
5. Commit known tool outcomes before downstream transcript, model-context, and UI result
   projections, and terminal Run facts before terminal transcript, status, and UI projections.
6. Classify recovery candidates at startup as `not_dispatched`, `completed`, `indeterminate`, or
   `corruption`, without automatically retrying a tool.
7. Preserve all existing Context Tape behavior and compatibility.

## Fact Model

Execution Journal v1 uses four immutable Tape event names:

| Event | Identity | Meaning |
| --- | --- | --- |
| `execution/run_started` | `runId` | A physical Run passed local construction and entered execution. |
| `execution/dispatch_committed` | operation identity | DeepChat authorized one resolved invocation and durably claimed it immediately before dispatch. |
| `execution/tool_outcome` | operation identity | DeepChat received and prepared a known outcome for that claimed invocation. |
| `execution/run_terminal` | `runId` | The Run selected a terminal outcome before projecting it elsewhere. |

The protocol version is an explicit payload field and is independent from UUID generation.

An operation identity is the structured tuple:

```ts
{
  runId: string
  requestSeq: number
  providerToolCallId: string
}
```

The persisted provenance key is derived from a cryptographic hash of the canonical tuple. It does
not concatenate unescaped fields. Provider tool call IDs are only assumed unique within one
provider response, never across Runs or providers.

Dispatch payloads contain the operation identity, message identity, resolved tool/source/target
metadata, and a canonical argument hash. Raw arguments are not duplicated into the journal.
Outcome payloads contain the operation identity, success/error state, the prepared bounded response
text, its hash, and an optional offload path. Raw structured MCP envelopes, image base64 data, and
unbounded results are excluded. Prepared response text can still contain sensitive user or tool
data; it inherits the Session database's confidentiality and retention requirements and is excluded
from default Context views, search, and recovery diagnostics.

## Required Invariants

- `runId` is a fresh UUID for every physical loop or deferred execution Run and never depends on a
  process-local counter.
- `run_started` is committed before the Run is registered or executed.
- A dispatch producer commits after every known local refusal path and directly before the resolved
  side-effect boundary.
- A dispatch commit returning an existing claim prevents a second physical invocation.
- `tool_outcome` is valid only for an operation with a native `dispatch_committed` fact.
- A known outcome is committed before it mutates downstream transcript, model-context, or UI
  projections.
- `run_terminal` is committed before transcript status, runtime status, terminal hooks, or UI
  completion/failure projection advances.
- Journal persistence failure propagates through the Run. It is never reduced to a warning.
- Same identity plus the same canonical fact is idempotent. Same identity plus a different canonical
  fact throws a typed corruption error.
- Legacy reconciliation and transcript backfill never create an `execution/*` v1 event.
- Recovery never reuses an old `runId` and never automatically retries an indeterminate operation.
- Context Tape facts, search projection, recall, anchors, and ViewManifest retain their current
  fail-open behavior where already specified.

## Failure Semantics

The journal does not provide exactly-once execution for an arbitrary local process, MCP server, or
remote API. A crash can still occur after a target accepted an invocation but before DeepChat
received or committed its result.

The protocol instead preserves a finite evidence state:

| Durable evidence | Recovery meaning |
| --- | --- |
| No dispatch for the Run | `not_dispatched`: no journaled tool invocation crossed its dispatch boundary. |
| Every dispatch has a matching outcome | `completed`: all dispatched operation outcomes are known locally. |
| At least one dispatch has no outcome | `indeterminate`: the remote effect cannot be inferred locally. |
| Malformed, conflicting, orphaned, or unsupported facts | `corruption`: the journal cannot be trusted for automatic action. |

`indeterminate` and `corruption` are parked. The first version may expose the existing interrupted
message projection to users, but it must not turn that projection into evidence or re-execute a
tool. Reconciliation can later be completed only from external evidence or an explicit user action
that starts a new Run.

## Scope

The first version covers:

- normal DeepChat loop Runs;
- MCP calls at the final resolved client boundary;
- built-in Agent tools that can cross a persistent or external side-effect boundary;
- approved deferred tool execution through a fresh physical Run;
- completed, paused, aborted, and error terminal outcomes;
- startup classification and diagnostic reporting;
- native SQLite and crash-boundary tests.

Pure validation, permission prompts, question tools, context reads, ViewManifest writes, and other
operations that never cross a persistent or external side-effect boundary do not create a dispatch
fact. Unknown MCP tools are treated conservatively because their remote behavior cannot be inferred
from local annotations.

## Compatibility

- The existing `deepchat_tape_entries` schema and row format remain compatible. Journal records use
  existing event rows and add only a query index for global event-name recovery reads.
- Existing Context Tape event names and payloads are unchanged.
- Existing transcript backfill remains available for legacy context facts and remains fail-open.
- No renderer or IPC contract changes are required in v1.
- Existing run IDs in historical transcript metadata remain readable. Only new physical Runs use the
  UUID contract and participate in journal recovery.
- No data migration rewrites historical Tape rows.

## Acceptance Criteria

1. Two physical Runs in the same Session receive different UUIDs across process restarts.
2. A strict writer returns the existing row for an identical fact and throws a typed corruption
   error for a conflicting fact under the same identity.
3. A failed dispatch commit prevents the target invocation. An existing dispatch claim also
   prevents a second target invocation.
4. MCP and side-effecting Agent tool tests prove that all local rejection paths occur before T1 and
   that the target call occurs after T1.
5. A failed outcome commit prevents transcript/model-context result projection.
6. A failed terminal commit prevents terminal transcript/status/UI projection.
7. Deferred approval execution uses a new UUID Run and follows the same T1, T2, and terminal order.
8. Startup recovery classifies native v1 facts into the four required states and never invokes a
   tool.
9. Transcript backfill cannot create journal facts and journal classification ignores reconstructed
   context facts.
10. Relevant unit, native SQLite, failpoint, and real process restart tests pass.
11. Existing Context Tape, loop, permission, and deferred execution regression suites remain green.
12. No remote Git operation is performed.

## Constraints

- Journal writes remain synchronous with the existing SQLite transaction model so no asynchronous
  gap is introduced between a fact commit and its local side-effect boundary.
- The tool subsystem receives a per-call commit callback, not a global Tape dependency.
- Fact payloads are canonical, versioned, and bounded. Raw invocation arguments, terminal error
  strings, structured MCP envelopes, and binary data are not duplicated. Prepared outcome text is
  durable recovery data and must be protected as Session transcript data.
- Recovery reads are restricted to journal event names and use a dedicated index.
- Every commit requires an unstaged and staged diff review, severity-ordered findings, relevant
  validation, and correction of identified issues before commit.

## Non-Goals

- Exactly-once execution without target-side idempotency support.
- Automatic retry or automatic reconciliation of indeterminate calls.
- A separate operations table or mutable journal state machine.
- Invocation-attempt identities inside one provider tool call.
- Multi-writer continuation fencing or cross-process Run ownership.
- A TaskRun envelope, graph scheduler, or replacement of the current harness.
- Redesigning Context Tape, effective views, anchors, recall, ViewManifest, transcript storage, or
  provider attempt journaling.
- GitHub issue creation, pull request creation, branch push, or release work.

## Open Questions

None. Any future automatic reconciliation policy requires a separate design because it changes the
current fail-closed recovery contract.
