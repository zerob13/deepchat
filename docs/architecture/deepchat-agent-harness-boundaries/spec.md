# DeepChat Agent Harness Boundaries

## Context

DeepChat's tool runtime already has a conservative parallel fast path, but the scheduling policy is
encoded in `dispatch.ts` as an Agent tool-name allowlist. That makes execution safety depend on a
string convention instead of the tool catalog that owns tool capabilities. A rename, replacement,
or new read-only tool therefore requires runtime knowledge that does not belong in dispatch.

This architecture goal establishes stable contracts around the DeepChat Agent harness over
multiple short-lived pull requests. The typed tool execution contract and the coordinator ownership
slice are complete. The current slice replaces the orchestration root with a thin Harness facade
over a one-directional service graph, and is a strict zero-behavior-change refactor. Typed hooks
and same-run steering remain separate changes.

## Comparative Evidence

Pi places an optional `executionMode` on each Agent tool. Its loop executes a batch in parallel by
default unless global configuration or any tool requests sequential execution. This correctly puts
the capability on the tool, but its default-open policy is too permissive for DeepChat's mixed
built-in/MCP catalog, permission pauses, durable queue, and persisted tool settlement.

Bub's asynchronous executor applies `asyncio.gather` to every tool-call batch. It preserves input
result order and isolates declared tool errors, but it has no side-effect or scheduling contract.
That model cannot safely represent DeepChat tools that mutate files, settings, memory, Tape-visible
state, browser state, processes, or user interactions.

DeepChat will keep its existing fail-closed, all-or-nothing batch behavior while moving the
parallel decision from a name allowlist to an explicit catalog-owned contract.

Pi's useful runtime boundary is not its directory layout but the separation between its pure agent
loop, in-memory Agent lifecycle, persistent Harness, and Session facts. DeepChat already has the
equivalent lower layers in `DeepChatLoopEngine`, `LoopRun`, `DeepChatLoopRunner`,
`DeepChatAgentInstance`, and Session data. The remaining problem is the application orchestration
above them: lifecycle, pending-input admission, queue pumping, compaction, and projection still
route through one coordinator.

Bub likewise separates framework turn processing, Agent execution, and Tape, but its hook-first
pipeline does not model DeepChat's durable pending-input queue, interaction recovery, instance
replacement fencing, or renderer projection. This slice therefore adopts the ownership lesson,
not Bub's hook pipeline or execution semantics.

## Coordinator Ownership Slice

### Problem

`DeepChatRuntimeCoordinator` remains both composition root and implementation owner. Its child
coordinators depend on broad callback surfaces that route back to private methods on the parent.
Pending-input claim and drain mechanics are duplicated between the root and `TurnCoordinator`,
while active-run cleanup, abort settlement, status projection, and queue wakeup are spread across
initial turns, resumed turns, interactions, and manual compaction.

The result is structural rather than cosmetic coupling: changes to one lifecycle invariant usually
require coordinated edits across `DeepChatRuntimeCoordinator`, `TurnCoordinator`, and
`DeepChatLoopRunner`. Tests compound the coupling by reflecting private coordinator members through
type escapes, so moving an owner can fail only at runtime instead of at compile time.

### Ownership Model

`DeepChatAgentRuntime` remains the sole registry of hydrated instances and creates a minimal
`SessionRuntimeScope`. The scope is an identity capability, not a service locator:

```ts
interface SessionRuntimeScope {
  readonly sessionId: AppSessionId
  readonly instance: DeepChatAgentInstance

  state(): DeepChatSessionState | undefined
  isCurrent(): boolean
  assertCurrent(): void
}
```

Project-directory resolution, generation-setting resolution, Agent identity, hooks, stores, and
provider capabilities remain explicit collaborator dependencies. The scope must not cache or
duplicate mutable facts already owned by `DeepChatAgentInstance` or Session data.

Lifecycle ownership has four distinct fence semantics and must not collapse them into one generic
`ownsTurn()` predicate:

1. **instance fence**: the scope's instance is still the registry's current instance;
2. **run fence**: a `runId` still identifies the instance's active `LoopRun`;
3. **operation-controller fence**: a pre-stream or compaction `AbortController` still owns the
   current operation slot;
4. **message association**: an interaction or permission belongs to the expected assistant message
   or run.

One lifecycle owner may implement these predicates, but callers must use the specifically named
fence that matches their operation.

### Runtime Owners

- `RunLifecycleCoordinator` owns pre-stream controllers, active-run registration and cleanup,
  deferred-tool cancellation, explicit cancellation, terminal settlement, stale-run protection,
  pending-interaction projection, status transitions, and post-settlement queue wakeup. Mutable
  state remains on `DeepChatAgentInstance` and `LoopRun`.
- `SessionStatusPublisher` is the single projection path for a status transition. It preserves the
  existing order: `sessions.status.changed`, `sessions.updated`, internal session update, then UI
  refresh.
- `PendingInputAdmissionCoordinator` owns send/steer normalization, attachment acceptance lanes,
  capacity and interaction gates, queue mutation commands, steer promotion, and interrupt
  requests.
- `PendingInputPump` owns steer-before-queue selection, per-session single-flight drain, claim,
  release, consume, recovery, and starting a claimed turn. Durable input records remain owned by
  `SessionPendingInputs`.
- `TurnCoordinator` continues to own the distinct initial and resume preparation algorithms, but
  delegates lifecycle settlement and pending-input disposition instead of mutating those owners
  through parent callbacks.
- `CompactionRuntimeCoordinator` expands to own manual compaction state and operation lifecycle in
  addition to its existing compaction projection; no parallel manual-compaction coordinator is
  introduced.
- `DeepChatRuntimeCoordinator` becomes a compatibility adapter and composition root. Moving wiring
  into a factory is allowed only after the callback graph is reduced; moving the existing callback
  graph unchanged does not satisfy this architecture goal.

### Pending Input Completion

Internal turn execution returns a typed completion that explicitly carries the disposition of a
claimed pending input. The disposition distinguishes consume, release-before-user-fact, and
rollback-after-user-fact semantics. The pump applies queue-state mutations; transcript, compaction,
and Memory rollback remains an ordered turn-settlement operation.

The pump and turn lifecycle form a real feedback loop. They communicate through narrow synchronous
`TurnStarter` and `PendingInputWakeup` interfaces wired by the composition root. An asynchronous
event bus is not used because claim settlement and the next drain must observe a deterministic
order. Public `MessageStartResult`, including `attachmentPreparation`, remains unchanged and is
mapped losslessly from the internal completion.

### Test Boundary

Before production extraction, tests stop reflecting private coordinator members. Existing cases
must assert public behavior or construct the new owner through typed test ports. This test-only
stage changes no production source and must pass the complete main-process suite.

Production extraction preserves all observable assertions except for the twelve corrections listed
in the next section. Tests may move to owner-specific suites or replace structural mocks with typed
ports, but expected status, event order, queue disposition, terminal persistence, hooks, Tape,
Memory, permissions, and public return values outside those corrections must not change. Each
correction requires a regression test that distinguishes its old and new behavior.

### Included Runtime Corrections

This ownership slice contains three explicit bug fixes, five corrections exposed while moving the
owning code, and four additional ownership defects found during full pull-request review. They
remain in this pull request because later extraction rewrote or relocated the same control flow, so
separating them now would require replaying and resolving the complete ownership refactor without
restoring an independently reversible change.

| Correction | Previous behavior | Required behavior and rationale |
| --- | --- | --- |
| Deferred tool progress | A deferred tool resumed from the interaction's pre-execution block snapshot and could overwrite progress or terminal data written while the tool ran. | Re-read the assistant message after deferred execution and continue only while the same pending interaction still exists. This preserves concurrent progress and refuses stale ownership. |
| Follow-up admission | Concurrent direct sends answering a completed tool question could both pass admission before the first turn established its durable claim. | Serialize send acceptance and permit only one immediate follow-up claim; later sends observe the first claim and remain pending. |
| Rejected live-send rollback | Releasing a claimed live send after its user fact was persisted left a visible user message and derived compaction or Memory facts for a turn that never started. | Roll back transcript, compaction, and Memory facts before releasing the claim, so retry never duplicates a visible turn. |
| Steer marker ownership | Adopting any steer claim unconditionally cleared the instance's active steer marker, including a newer marker installed concurrently. | Clear the marker only when its id matches the adopted claim, preserving a newer merge target. |
| Direct-steer ownership | A false drain result caused deletion unless the narrow draining/generating checks happened to be visible at that instant. | Retain the steer whenever its durable state or an active generation, controller, drain, or generating projection proves another owner accepted it. |
| Promoted-steer ownership | A false drain result restored a promoted steer even when another drain had already claimed or consumed it. | Restore only when no durable or runtime owner accepted the promoted steer. |
| Operation-controller ownership | Cleanup without an exact controller reference could clear a replacement operation's controller. | Treat an absent expected controller as a no-op; only the exact current controller may be cleared. |
| Follow-up/drain overlap | A direct follow-up could attempt a second immediate start while another pending-input turn owned the single-flight pump. | Keep the new input pending while another owner holds the instance-scoped drain lease. At every normal asynchronous yield point the draining turn already owns a claimed row, so the claimed-input gate also prevents a second start. The explicit lease check protects defensive or re-entrant observations; once the in-flight turn persists its user fact, transcript ordering removes the old follow-up marker and normal completion wakeup admits the pending input. A regression test constructs that conservative overlap and verifies admission after the transition. |
| Atomic drain ownership | Concurrent `drain()` calls could both pass the Boolean single-flight check before either call marked the instance as draining, claim different rows, and later clear each other's state. A wake arriving while the owner finalized could also be lost. | Acquire an instance-scoped drain lease synchronously before the first asynchronous state read and release it only with the exact owner token. Non-starting paths release locally; a launched turn transfers release ownership to its finalizer. Coalesce transient wake reasons only after the active claim has settled and the resulting Session status admits that reason, then replay them after lease release. Enqueues accepted while a turn is still generating continue to rely on normal completion wakeup, so an error leaves their backlog pending. The durable queue remains the sole input fact. |
| Non-hydrating readiness cleanup | Clearing `firstTurnReady` used `getOrCreateScope`, so cleanup after eviction could recreate a runtime instance with no active operation. | Clear readiness only on an already hydrated scope. Cleanup is a no-op after eviction and cannot resurrect Session runtime state. |
| Multi-message interaction cancel | Canceling recovered pending interactions terminalized only the first assistant message before dropping every interaction reference. | Terminalize every distinct assistant message represented by the pending interaction set, then clear the set and emit one Session terminal projection and queue wakeup. |
| Rolled-back terminal references | A thrown pending-input turn rolled back its user and assistant messages but retained their IDs, then attempted error persistence and emitted stream failure for deleted records. | Clear both IDs immediately after durable transcript rollback, including returned error results, so no terminal write, event, or public result references a deleted message. |

The last rule deliberately does not let ordinary queue-origin inputs bypass the tool-follow-up gate.
`PendingInputEnqueueSource` remains the admission distinction. The production invariant is the
durable claimed row plus the instance's single-flight drain marker, so no additional persisted fact
or second source of truth is introduced.

## Coordinator Ownership Goals

- Establish one explicit owner for Session identity, run lifecycle, status projection, pending-input
  admission, queue pumping, turn settlement, and compaction orchestration.
- Replace parent-private callback surfaces with concrete collaborators or narrow typed ports.
- Preserve every public contract and observable runtime ordering while making owner tests
  independently constructible.
- Leave a stable internal ownership model for the later Harness facade and typed hook reducer.

## Harness Facade Slice

### Problem

The coordinator ownership slice extracted lifecycle, admission, pump, and compaction owners, but
`DeepChatRuntimeCoordinator` remains the composition root, the implementation site for every
remaining cross-cutting session concern, and the only object every owner can reach. Its constructor
contains 72 arrow functions, and the class body still implements session initialization and
destruction, session-state hydration, Agent identity resolution, transcript mutation coordination,
message refresh projection, subagent tool-call progress, system prompt assembly, tool result
normalization, and auto-approve permission review.

Because those implementations live on the root, every extracted owner must accept a callback that
points back into it. The dependency graph is therefore a cycle rather than a layered runtime:
root creates owner, owner holds a closure over a root private method, and that method reaches a
different owner. The consequences are structural:

- Owners are not independently constructible, so runtime coverage concentrates in one 12918-line
  suite instead of owner suites.
- `DeepChatLoopRunnerPorts` (32 members), `TurnCoordinatorPorts` (26 members), and
  `InteractionCoordinatorPorts` (13 members) are wide because they must carry root helpers rather
  than collaborators.
- `DeepChatAgentInstance` holds a `DeepChatAgentInstanceDelegate` that calls back into orchestration,
  so the runtime registry cannot become a pure state owner and the registry hydrator closes the
  largest construction cycle in the module.
- The root is at 1185 of its 1300-line architecture ceiling, so no further owner can be absorbed.

### Service Ownership

Each remaining root implementation moves to exactly one owner. New owners are ordinary classes with
concrete dependencies and no reference to the facade.

| Owner | Responsibility | Replaces |
| --- | --- | --- |
| `SessionIdentityService` | Agent identity resolution with instance cache and persisted fallback; ACP-backed subagent classification | `getSessionAgentId`, `isAcpBackedSubagentSession` |
| `SessionStateResolver` | Runtime-state read and database hydration, including pending-interaction status projection and missing-session eviction | `getResolvedSessionState`, `getSessionState`, `getSessionListState` |
| `SessionLifecycleCoordinator` | Session initialization and destruction ordering across settings, runtime state, compaction, Memory, durable queue, transcript, and tool mappings | `initSession`, `destroySession` |
| `TranscriptMutationCoordinator` | Clear, retry, truncate, and fork coordination against the transcript mutation contract | `prepareClearMessages`, `finishClearMessages`, `prepareRetry`, `cancelForTranscriptMutation`, `invalidateTranscriptFrom`, `finishTranscriptTruncate`, `resetForkTarget` |
| `MessageProjectionService` | Assistant message refresh projection and subagent tool-call progress persistence | `emitMessageRefresh`, `updateSubagentToolCallProgress` |

Three existing domain implementations gain bound entry points instead of moving.
`buildSystemPromptWithSkills` keeps its implementation in `resources/systemPromptBuilder.ts` and
gains a binding that owns `BasePromptAssembler` and `PostCompactionPromptAssembler` construction.
`normalizeToolResultContent` and `reviewAutoApproveToolPermission` stay domain functions and are
bound once through named ports at composition time. Mechanically wrapping a single function in a
class adds indirection without adding an owner.

Instance access and staleness fencing are registry reads, not lifecycle operations. Owners that
only need `getInstance`, `getHydratedInstance`, `getRuntimeState`, or `assertCurrent` take a narrow
`SessionScopeRegistry` (`getOrHydrateScope`, `getHydratedScope`, `scopeFor`) and use
`SessionRuntimeScope` directly. This removes those four callback shapes from every port surface and
deletes an artificial dependency on `RunLifecycleCoordinator`.

### Port Narrowing

Owners depend on concrete collaborators wherever construction order already permits it:
`TurnCoordinator` on `DeepChatLoopRunner`, `InteractionCoordinator` on `TurnCoordinator` and
`DeferredToolExecutor`, `PendingInputPump` on `TurnCoordinator`, and `DeepChatLoopRunner` on
`CompactionRuntimeCoordinator`. Narrow structural interfaces are retained where they express a real
contract, such as `PendingInputTurnStarter`, but they are satisfied directly instead of by anonymous
adapters.

The six Tape capability ports on `DeepChatLoopRunnerPorts` (`tapeReconciliation`,
`tapeViewManifestReader`, `tapeViewManifestWriter`, `tapeProviderAttemptReader`,
`tapeProviderAttemptWriter`, `tapeToolFactWriter`) become one composed domain port. Tape is a single
subsystem, and splitting one collaborator across six fields describes the capability types rather
than the dependency.

### Late Binding

Exactly one runtime cycle is real: run settlement wakes the pending-input pump, and the pump starts
turns through the lifecycle owner. It is expressed as one named binding module rather than an
anonymous closure, and it is the only permitted deferred wiring in the graph.

The `DeepChatAgentRuntime` hydrator cycle is not real and is removed rather than deferred.
`DeepChatAgentInstanceDelegate` exists only to give `DeepChatAgentInstance` the four methods the
manager backend calls. Routing those through the harness port makes the registry a pure state owner,
deletes the hydrator, and removes `dispose()`, which has no production caller.

### Facade Contract

The facade implements only contracts that already exist. It adds no new public vocabulary, no
subscription channel, and no state of its own:

- `DeepChatAgentBackendPort` for the manager backend, extended with one `send` entry point that
  absorbs the queue routing previously performed inside the instance delegate.
- `SessionStatePort` for session state and settings.
- `SessionTranscriptRuntimePort` for transcript mutation coordination.
- The ACP compatibility dependency factory, the tool registry refresh entry point, the Memory
  ingestion observer, and the runtime registry accessor.

The facade owns no phase machine, queue, cache, subscription, or derived fact, and every method
delegates to exactly one owner. Multi-owner sequences belong to `SessionLifecycleCoordinator` or
`TranscriptMutationCoordinator`. The ACP compatibility dependency factory is bound at composition
and reaches the facade as one pre-bound function rather than as raw infrastructure fields.

### Zero-Behavior-Change Constraint

This slice changes no runtime behavior. Any defect found while moving code is recorded and deferred
to a separate branch rather than fixed in place, because a behavior change inside a graph rewrite
cannot be reviewed or reverted independently.

Four sequences are load-bearing and must move verbatim:

1. **State hydration side effects.** `hasPendingInteractions` is read before `setRuntimeState`;
   a missing database row evicts the runtime instance and returns null; Agent identity resolution
   writes back onto the instance; only the full hydration mode warms effective generation settings.
2. **Message refresh order.** `chat.stream.completed` publishes first, then the transcript message is
   read, then the internal session update publishes. A non-assistant or unparsable message returns
   after the first publication.
3. **Status publication order.** `sessions.status.changed`, `sessions.updated`, internal session
   update, then UI refresh.
4. **Destroy ordering.** Memory destroy begins, scope operations cancel, readiness clears, then
   durable pending inputs, transcript, and session settings are deleted, then owned state clears,
   the instance is evicted, Memory destroy finishes, and tool mappings clear.

The durable pending-input queue, Tape, Memory, and permission recovery keep their existing single
sources of truth. No fact is duplicated onto the facade or onto a new service.

### Deferred Findings

Defects observed while moving code are recorded here and fixed on a separate branch.

| Finding | Observation | Current handling |
| --- | --- | --- |
| Steer merge race | Merging two rapid steer inputs into one turn depends on an in-flight `steerActiveTurn` reaching the instance steer marker before a settlement-triggered drain adopts the claim. Nothing serializes the two, so the window is defined only by the async depth of the pump's session-state read. | Behavior preserved by keeping that read behind its own async boundary, with the reason recorded at the wiring site. Closing the race requires holding the steer lane across queue and cancel, which is a behavior change. |
| Duplicated drain logging | `RunLifecycleCoordinator.schedulePendingInputDrain` and `PendingInputPump.schedule` both catch a rejected drain and log the identical `drainPendingQueueIfPossible` message, so one owner is redundant. | Left as is; both paths keep their existing coverage. |

### Test Boundary

The 12918-line root suite splits into owner suites plus one compact full-runtime integration suite
that retains cross-owner ordering cases. Assertions move rather than change; total executed test
count must not drop. Owner suites construct their owner directly through typed dependencies instead
of building the whole runtime.

## Harness Facade Goals

- Give every remaining root implementation exactly one named owner outside the facade.
- Make the runtime dependency graph one-directional, with a single named late binding.
- Make `DeepChatAgentInstance` and `DeepChatAgentRuntime` pure runtime-state owners.
- Reduce the facade to delegation against contracts that already exist.
- Prevent re-accretion with an architecture guard that fails on runtime modules importing the
  harness layer and on protected implementation symbols reappearing in the facade.
- Leave a stable service layer for a later typed hook reducer without exposing that layer as a
  service locator.

## Typed Tool Execution Contract Goals (Completed)

- Define one canonical, typed execution contract for every `MCPToolDefinition`.
- Make a tool's maximum side effect and concurrency permission explicit at its definition site.
- Make `write + parallel` unrepresentable in TypeScript.
- Admit external MCP tools with a conservative contract without trusting server-supplied hints.
- Keep current runtime behavior: only a multi-call batch composed entirely of explicitly parallel
  read tools may run concurrently, and only in `full_access` mode.
- Preserve tool-call result ordering, failure isolation, abort behavior, permission recovery,
  interaction pauses, output fitting, and durable execution-state updates.
- Keep execution-only metadata out of provider payloads, context-window token estimates, and
  provider-view tool-definition hashes.

## Execution Contract

The canonical definition uses a closed discriminated union:

```ts
type ToolExecutionMode = 'sequential' | 'parallel'
type ToolEffect = 'read' | 'write'

type ToolExecutionContract =
  | { effect: 'read'; mode: ToolExecutionMode }
  | { effect: 'write'; mode: 'sequential' }

type MCPToolDefinition = MCPToolDefinitionBase & {
  execution: ToolExecutionContract
}
```

`effect` describes the maximum observable capability of the tool, not the behavior of one selected
argument branch:

- `read` means the tool has no durable, external, user-interaction, or non-idempotent mutation that
  can conflict with another call.
- `write` includes any tool that can mutate state, incur an externally visible action, pause for an
  interaction, or select a mutating operation based on arguments.

`execution.mode` is a positive scheduling grant. A `read` tool may remain sequential because of
resource limits, internal mutable caches, ordering requirements, or because concurrency has not yet
been validated. Only an explicit `read + parallel` contract authorizes parallel execution.

A single deeply frozen `TOOL_EXECUTION` preset catalog represents the three valid contracts.
Definition sites assign one atomic `execution` value, for example `TOOL_EXECUTION.write` or
`TOOL_EXECUTION.read.parallel`, instead of spreading independent fields into the definition. Runtime
freezing prevents one definition from mutating the shared preset used by every other definition.
This keeps execution-only metadata namespaced, makes the classification concise and reviewable, and
lets provider-facing projections remove the complete contract when it evolves. `MCPToolDefinition`
has one canonical declaration under `src/shared/types/core`; the broader shared MCP module aliases
that declaration instead of maintaining a second structural copy.

## Trust And Classification

Built-in Agent definitions declare their contract at the owning definition site. For compatibility
with current behavior, only the filesystem `read` tool is initially `read + parallel`.

- Filesystem `glob` and `grep`, Tape queries, `skill_list`, and `get_browser_status` are
  `read + sequential` until their concurrency behavior is deliberately validated.
- File mutation, commands, processes, questions, plans, settings, image generation, cron jobs,
  subagents, skill activation/management/execution, and browser navigation/CDP are
  `write + sequential`.
- All memory tools are `write + sequential`; recall updates access metadata and is not a pure read.
- Parameter-dependent tools use their maximum capability. A tool that can either inspect or mutate
  is classified as `write`.

External MCP and plugin tools enter the catalog as `write + sequential`. MCP annotations such as
`readOnlyHint` are descriptive hints from an untrusted server and never grant local concurrency.
Supporting trusted per-server overrides would require a separate authenticated policy design.

## Batch Scheduling

A pure runtime policy selects `parallel` only when every condition holds:

1. the Session permission mode is `full_access`;
2. the batch contains at least two calls;
3. every call resolves to exactly one definition;
4. every resolved definition is `read + parallel`.

Missing, malformed, or duplicate definitions fail closed to `sequential`. Mixed batches remain
fully sequential; this change does not introduce segmented scheduling around write calls. Parallel
execution continues to settle independently and commit results in provider call order.

## Compatibility

- The runtime tool-definition shape gains one additive internal `execution` object, so structural
  readers and IPC consumers remain compatible. The contract is intentionally required in
  TypeScript, which is a source-level contract tightening for definition constructors; all
  in-repository constructors are updated atomically. No persisted format or database migration
  changes.
- Provider adapters continue projecting only model-visible function metadata. Legacy XML prompt
  generation also continues reading only function metadata.
- Context reserve estimation excludes the execution object so this internal contract does not
  reduce user-visible context capacity.
- Tape ViewManifest tool-definition hashes exclude the execution object, preserving their existing
  provider-view identity. Future execution-policy replay must use a separate versioned identity.
- Existing external MCP tools remain sequential. Existing built-in behavior remains unchanged:
  only Agent filesystem `read` batches gain the parallel path they already had.
- Permission preflight, auto-grant, post-call permission handling, and interaction semantics remain
  owned by dispatch.

## Non-Goals

- Do not parallelize additional built-in or MCP tools in this slice.
- Do not infer execution policy from MCP annotations, names, schemas, permission results, or call
  arguments.
- Do not add per-call dynamic effect classification or a segmented dependency scheduler.
- Do not rewrite tool dispatch or change durable queue and Tape semantics.
- Do not add the typed hook reducer in the harness facade slice.
- Do not change provider retry, tool scheduling, dispatch internals, public IPC/API contracts,
  persisted formats, Tape semantics, or Memory semantics beyond the corrections explicitly listed
  above while extracting runtime owners.
- Do not add a Pi-style `run`/`steer`/`followUp`/`subscribe` vocabulary or any third event channel;
  the facade implements the existing manager and session contracts only.
- Do not pass the composed service graph to hooks as a container. A later typed hook slice designs
  its own restricted context facades.
- Do not fix defects discovered while moving code in the harness facade slice; record them and open
  a separate branch.
- Do not move durable pending inputs into `DeepChatAgentInstance` or add another source of truth.
- Do not make `SessionRuntimeScope` a dependency container or introduce a generic runtime kernel.
- Do not add same-run steering or change abort semantics, queue ordering, or visible-turn behavior
  beyond rollback of a rejected claimed live send described above.
- Do not create or synchronize a GitHub issue for this architecture work.

## Typed Tool Execution Acceptance Criteria (Completed)

1. The canonical type rejects `write + parallel`, and all production definition ingress paths
   produce an explicit valid contract.
2. Two or more `read + parallel` calls run concurrently only in `full_access`, while result commits
   preserve call order.
3. A sequential read, write, missing definition, malformed contract, duplicate definition, or
   non-`full_access` permission mode makes the complete batch sequential.
4. External MCP definitions remain `write + sequential` even when `readOnlyHint` is true.
5. Parallel failures remain isolated per call; abort and already-returned-result settlement retain
   current behavior.
6. Execution metadata is absent from provider tool schemas and does not change the historical tool
   token reserve or ViewManifest tool-definition hash.
7. Focused tests, type checks, formatting, i18n validation, and lint pass before handoff.

## Coordinator Ownership Acceptance Criteria

1. Tests no longer reflect coordinator private members that move in this slice; owner tests use
   public behavior or typed ports.
2. `DeepChatAgentRuntime` is the only hydrated-instance registry, and the minimal scope exposes no
   project, settings, hook, store, or provider service access.
3. Instance, active-run, operation-controller, and message-association fences remain explicit and
   retain their existing semantics.
4. Status transitions preserve their current four-sink ordering and stale instances/runs cannot
   overwrite a replacement's status.
5. One owner performs terminal settlement and active-run cleanup for initial, resume, interaction,
   cancel, and provider-return paths without duplicate queue wakeups.
6. `PendingInputPump` is the only queue-drain and claim-state owner. Steer priority, blocked-input
   gates, restart recovery, and per-session single flight remain compatible; retry rollback and the
   twelve enumerated corrections follow their explicitly tested semantics.
7. Internal turn completion maps losslessly to the existing `MessageStartResult`, including OCR and
   attachment-preparation outcomes.
8. Manual and automatic compaction retain current abort, stale-instance, status, transcript, Tape,
   and Memory ordering through the existing compaction owner.
9. `DeepChatRuntimeCoordinator` contains composition and public compatibility delegation rather
   than lifecycle, admission, pump, settlement, or compaction implementations. Owner modules do not
   import the concrete root coordinator.
10. Focused owner tests, the full main-process suite, type checks, formatting, i18n validation,
    lint, and architecture guards pass before handoff.

## Harness Facade Acceptance Criteria

1. `deepChatRuntimeCoordinator.ts` no longer exists. Identity, state resolution, session lifecycle,
   transcript mutation, and message projection each have one named owner, and the prompt assembler,
   tool result normalization, and permission review remain domain modules bound at composition.
2. No module under `src/main/agent/deepchat/{runtime,loop,instance,memory,resources}` imports the
   harness layer, enforced by the agent cleanup guard.
3. The composition root is the only module that wires owners, and the graph contains exactly one
   named late binding, from `RunLifecycleCoordinator` to `PendingInputPump`.
4. `DeepChatAgentInstance` exposes runtime state only; `DeepChatAgentInstanceDelegate`, the registry
   hydrator, and `DeepChatAgentRuntime.dispose()` are gone, and the manager backend reaches send,
   cancel, snapshot, and close through the harness port.
5. The facade declares no field other than its owners and the bound ACP compatibility dependency
   factory, and satisfies `DeepChatAgentBackendPort`, `SessionStatePort`, and
   `SessionTranscriptRuntimePort` by explicit `implements` clauses.
6. `DeepChatLoopRunnerPorts`, `TurnCoordinatorPorts`, and `InteractionCoordinatorPorts` shrink, the
   six Tape capabilities are one composed port, and no port member is a closure over the facade.
7. Every owner introduced or narrowed in this slice is constructible in a test without building the
   full runtime, and each has a focused suite.
8. The four load-bearing sequences in the zero-behavior-change constraint are pinned by tests that
   fail if their order changes.
9. No behavior, public contract, persisted format, event payload, or event ordering changes.
   Executed test count does not drop.
10. Focused owner suites, the full main-process suite, type checks, formatting, i18n validation,
    lint, the agent cleanup guard, and a regenerated layered-runtime baseline pass before handoff.
