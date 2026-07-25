# DeepChat Agent Harness Boundaries Plan

## Current Slice

Extract coordinator ownership boundaries as an independently reviewable refactor. Preserve runtime
behavior except for the twelve corrections enumerated in `spec.md`, each of which must have focused
regression coverage. The typed tool execution contract below is complete and remains a retained
record.

## Coordinator Ownership Plan

### Stage 0: Remove Private Test Reflection

Inventory every `as any` or `as unknown as` access to a private coordinator member. Replace tests
with one of these seams, in priority order:

1. existing public runtime behavior;
2. observable event, persisted fact, or Session state;
3. a focused production owner constructed through typed ports once that owner exists;
4. a typed test dependency supplied through an existing constructor port.

Do not add public production methods solely for tests. This stage changes no production source and
must pass the full main-process suite before runtime extraction begins.

### Stage 1: Freeze Behavior

Add characterization coverage for:

- the exact four-sink status publication sequence;
- initial and resume returned/thrown/aborted settlement;
- stale instance, stale run, and replacement-controller fencing;
- steer-before-queue selection and every claim disposition;
- blocked attachments and OCR `attachmentPreparation` return mapping;
- pending interaction resume and cancellation;
- Memory callback ordering and exactly-once settlement.

### Stage 2: Scope And Stateless Policies

Add minimal scope creation to `DeepChatAgentRuntime`. Extract status publication, pre-stream
watchdog behavior, and pure provider context-budget decisions. Keep project resolution, effective
generation settings, Agent identity, hooks, and storage access as explicit ports.

### Stage 3: Run Lifecycle

Introduce `RunLifecycleCoordinator` as the only public owner for operation controllers, active runs,
cancellation, status/terminal projection, and queue wakeup. Preserve separate named predicates for
instance, run, controller, and message ownership. Route initial, resume, interaction, provider
permission, loop-ready, and manual-compaction fences through the matching predicate without
changing their conditions.

This is the highest-risk stage and remains its own commit and rollback point.

### Stage 4: Admission And Pump

Move input acceptance and mutation commands into `PendingInputAdmissionCoordinator`. Move queue
selection, single-flight, claim operations, failure recovery, and turn starting into
`PendingInputPump`.

Define an internal discriminated `TurnCompletion` / claimed-input disposition contract. Apply
transcript, compaction, and Memory rollback before releasing a retryable claim. Wire the real
turn/pump feedback loop through narrow synchronous interfaces rather than concrete imports or an
event bus. Delete both existing copies of claim release and drain scheduling helpers.

### Stage 5: Compaction And Composition

Extend `CompactionRuntimeCoordinator` with manual state and lifecycle entry points. Reduce
`DeepChatRuntimeCoordinator` to the existing public compatibility surface and composition. Extract
factory wiring only when it passes concrete owners or narrow ports rather than recreating the old
parent callback graph.

Split owner-specific tests out of the monolithic coordinator suite while retaining a compact
full-runtime integration suite.

### Stage 6: Architecture Enforcement

Replace the line-count-only signal with ownership checks that prevent owner modules from importing
the concrete coordinator and prevent lifecycle, pending-input drain, and manual compaction logic
from returning to the root. Keep an appropriate coordinator size ceiling as a secondary guard.
Regenerate the layered-runtime architecture baseline after the final source layout stabilizes.

### Stage 7: Review Corrections

Audit the complete branch diff against `dev`. Document the three explicit fixes and five ownership
corrections in the specification, then pin each changed invariant with focused coverage. Treat loss
of a pending interaction during concurrent terminal settlement as ownership loss rather than a new
resume failure, preserve the original claim-settlement error when durable verification also fails,
and keep diagnostic stages aligned with their actual owner.

Cache the minimal runtime scope by instance and share one parsed transcript snapshot between
question-follow-up and pending-interaction admission checks. Replace regex ownership checks with
TypeScript AST checks whose protected symbols are verified against their owner files, so comments
do not trigger false positives and symbol renames fail closed.

### Stage 8: Pull-Request Review Hardening

Replace the pending-input Boolean single-flight marker with an atomic, token-owned drain lease that
is acquired before the first asynchronous state read. Coalesce wake reasons that arrive after the
launched claim has settled and its resulting Session status admits the reason, then replay them
after exact-owner release without duplicating durable queue state. Continue to leave ordinary
enqueues pending when the active turn ends in error.
Keep cleanup non-hydrating, terminalize every assistant message represented by recovered pending
interactions, and stop terminal persistence from referencing messages removed by retry rollback.
Pin each path with focused owner or full-runtime coverage.

Standardize recovery logging through the redacting logger, centralize attachment-lane keys and
project-directory mutation, and replace fixed microtask waits with observable async completion.
Retain explicit typed Memory test delegation rather than hiding interface drift behind a Proxy.

## Coordinator Ownership Validation

Run validation in increasing scope after every stage:

```bash
pnpm exec vitest run --config vitest.config.ts \
  test/main/agent/deepchat/instance/deepChatAgentRuntime.test.ts \
  test/main/agent/deepchat/runtime/deepChatRuntimeCoordinator.test.ts \
  test/main/session/runtimeIntegration.test.ts
pnpm run typecheck:node
pnpm run test:main
pnpm run format
pnpm run i18n
pnpm run lint
pnpm run build
```

Focused owner suites replace or supplement the first command as they are introduced. Run the
architecture guard and regenerate its baseline in the final stage. If an environment-gated failure
occurs, reproduce it on `dev` before classifying it as unrelated.

## Completed Typed Tool Execution Contract

### Type Model

1. Add `ToolEffect`, `ToolExecutionMode`, and the discriminated `ToolExecutionContract` union to the
   canonical core MCP types.
2. Add one required `execution` object to `MCPToolDefinition` so capability metadata remains atomic
   and namespaced from model-visible definition fields.
3. Export one deeply frozen `TOOL_EXECUTION` preset catalog for parallel read, sequential read, and
   sequential write contracts so shared preset references cannot be mutated at runtime.
4. Replace the duplicate `MCPToolDefinition` declaration in the broad shared MCP module with a type
   alias and re-exports from the canonical module.

This keeps one source of truth while preserving both existing import paths.

### Catalog Classification

Add an explicit contract at every production definition boundary:

- filesystem `read`: parallel read;
- filesystem `glob` and `grep`, Tape query tools, `skill_list`, and browser status: sequential read;
- every other built-in Agent tool: sequential write;
- MCP and plugin definitions: sequential write at the MCP discovery boundary, independent of MCP
  annotations.

Use a tool's maximum capability when its effect depends on arguments. Keep these classifications
close to definition construction rather than introducing a second name-to-policy registry.
Prompt-only fallback descriptors remain base definitions and do not fabricate execution metadata.

### Runtime Policy

Create a small pure module in the DeepChat runtime that selects a batch execution mode from:

- Session permission mode;
- ordered completed tool calls;
- current tool definitions.

Build a definition-name index once per decision. Treat duplicate names as ambiguous and fail closed.
Return `parallel` only for a multi-call, `full_access`, all-parallel-read batch. Integrate this
selector at the existing parallel branch in `dispatch.ts` without changing execution or commit
mechanics.

### Provider And Context Boundaries

Keep provider mapping explicit: AI SDK and legacy prompt paths consume function metadata only.
Change the DeepChat token estimator to measure the historical definition projection without
the complete `execution` object. Use the same projection for Tape ViewManifest tool-definition hashes
so execution policy does not redefine provider-view identity. Add regression coverage proving
execution metadata neither reaches the AI SDK tool schema nor changes the existing reserve or hash.

### Tests

Add a focused pure-policy suite for:

- homogeneous parallel reads;
- sequential reads and mixed effects;
- non-`full_access` modes;
- missing, malformed, and duplicate definitions;
- single-call batches.

Extend dispatch coverage to prove the policy drives real concurrency and serialization without
changing result order or failure isolation. Extend MCP catalog coverage to prove `readOnlyHint`
does not grant concurrency. Update production and test definition fixtures to satisfy the canonical
type.

### Validation

Run in increasing scope:

```bash
pnpm exec vitest run --config vitest.config.ts \
  test/main/agent/deepchat/runtime/toolExecutionPolicy.test.ts \
  test/main/agent/deepchat/runtime/dispatch.test.ts \
  test/main/agent/deepchat/runtime/contextBuilder.test.ts \
  test/main/provider/aiSdkToolMapper.test.ts \
  test/main/mcp/toolManager.test.ts \
  test/main/tool/toolService.test.ts \
  test/main/session/data/tapeViewManifest.test.ts
pnpm run typecheck
pnpm run format
pnpm run i18n
pnpm run lint
pnpm run test:main
```

If the full main suite has unrelated environment-gated failures, reproduce them on `dev` and report
the distinction rather than weakening coverage.

## Commit And Review Strategy

Use independently reviewable local commits for the ownership slice:

1. `docs(agent): specify runtime ownership`
2. `test(agent): remove runtime private coupling`
3. `test(agent): freeze runtime ownership behavior`
4. `refactor(agent): scope runtime identity`
5. `refactor(agent): own run lifecycle`
6. `refactor(agent): own pending input flow`
7. `refactor(agent): complete runtime ownership`

Before each commit, inspect both staged and unstaged changes for hidden side effects, compatibility,
edge cases, performance, security, misleading names, missing tests, and future maintenance cost.
Fix all findings and repeat the relevant validation before committing. Do not push these commits.

The final build may refresh `resources/acp-registry/registry.json`; this is the repository's expected
build preflight maintenance and must be identified as such in pull-request handoff rather than
silently reverted.

## Later Slices

After coordinator ownership lands in `dev`, later branches may extend this architecture record for
a thin Harness facade and typed hook reduction. Those changes must not be implemented or coupled to
the current branch. The facade slice also owns the remaining composition callbacks, the still-wide
`DeepChatLoopRunnerPorts`, and root compatibility adapters for session hydration, Agent identity,
and message refresh. Same-run steering remains a separate feature design.
