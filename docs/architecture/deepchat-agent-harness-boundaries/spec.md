# DeepChat Agent Harness Boundaries

## Context

DeepChat's tool runtime already has a conservative parallel fast path, but the scheduling policy is
encoded in `dispatch.ts` as an Agent tool-name allowlist. That makes execution safety depend on a
string convention instead of the tool catalog that owns tool capabilities. A rename, replacement,
or new read-only tool therefore requires runtime knowledge that does not belong in dispatch.

This architecture goal establishes stable contracts around the DeepChat Agent harness over
multiple short-lived pull requests. The typed tool execution contract is complete. The current
slice defines coordinator ownership boundaries without changing runtime behavior. A Harness
facade, typed hooks, and same-run steering remain separate changes.

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

Production extraction preserves all observable assertions. Tests may move to owner-specific suites
or replace structural mocks with typed ports, but expected status, event order, queue disposition,
terminal persistence, hooks, Tape, Memory, permissions, and public return values must not change.
If extraction exposes an existing behavioral defect, its fix belongs in a separate bug change.

## Coordinator Ownership Goals

- Establish one explicit owner for Session identity, run lifecycle, status projection, pending-input
  admission, queue pumping, turn settlement, and compaction orchestration.
- Replace parent-private callback surfaces with concrete collaborators or narrow typed ports.
- Preserve every public contract and observable runtime ordering while making owner tests
  independently constructible.
- Leave a stable internal ownership model for the later Harness facade and typed hook reducer.

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
- Do not add the Harness facade or typed hook reducer in the coordinator-ownership slice.
- Do not change provider retry, tool scheduling, dispatch internals, public IPC/API contracts,
  persisted formats, Tape semantics, or Memory semantics while extracting runtime owners.
- Do not move durable pending inputs into `DeepChatAgentInstance` or add another source of truth.
- Do not make `SessionRuntimeScope` a dependency container or introduce a generic runtime kernel.
- Do not change same-run steering, visible-turn behavior, abort semantics, or queue ordering.
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
   gates, retry rollback, restart recovery, and per-session single flight remain unchanged.
7. Internal turn completion maps losslessly to the existing `MessageStartResult`, including OCR and
   attachment-preparation outcomes.
8. Manual and automatic compaction retain current abort, stale-instance, status, transcript, Tape,
   and Memory ordering through the existing compaction owner.
9. `DeepChatRuntimeCoordinator` contains composition and public compatibility delegation rather
   than lifecycle, admission, pump, settlement, or compaction implementations. Owner modules do not
   import the concrete root coordinator.
10. Focused owner tests, the full main-process suite, type checks, formatting, i18n validation,
    lint, and architecture guards pass before handoff.
