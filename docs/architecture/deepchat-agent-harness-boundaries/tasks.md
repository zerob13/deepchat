# DeepChat Agent Harness Boundaries Tasks

## Typed Tool Execution Contract

- [x] Compare Pi and Bub execution semantics with DeepChat's current runtime.
- [x] Record the 156-test dispatch, context-builder, and ToolService baseline.
- [x] Define the trust boundary, capability model, scheduling invariants, and non-goals.
- [x] Review and commit the SDD slice.
- [x] Add the canonical nested execution contract and shared preset catalog.
- [x] Classify every built-in definition and default external MCP definitions conservatively.
- [x] Extract and integrate the fail-closed batch execution policy.
- [x] Preserve provider projection and historical context-reserve behavior.
- [x] Add policy, dispatch, MCP ingress, provider-boundary, and token-boundary coverage.
- [x] Run focused tests and full type checking.
- [x] Run formatting, i18n validation, lint, and the full main-process suite.
- [x] Review the complete implementation diff and fix every finding.
- [x] Commit the implementation without pushing.

## Coordinator Ownership

- [x] Compare Pi and Bub orchestration boundaries with DeepChat's durable runtime semantics.
- [x] Define minimal Session scope and the four distinct lifecycle fence semantics.
- [x] Define owner responsibilities, typed claim disposition, feedback-loop wiring, compatibility,
      and non-goals.
- [x] Remove private coordinator reflection from runtime tests without changing production source.
- [x] Add status-order, settlement, fencing, queue-disposition, return-mapping, and Memory baselines.
- [x] Add minimal runtime scopes and extract status/pre-stream/context-budget policies.
- [x] Make one coordinator own run lifecycle, cancellation, settlement, and queue wakeup.
- [x] Extract pending-input admission and the single queue pump; delete duplicate claim/drain logic.
- [x] Extend the existing compaction owner and reduce the root to composition and compatibility.
- [x] Split owner tests while retaining focused full-runtime integration coverage.
- [x] Update architecture guards and regenerate the layered-runtime baseline.
- [x] Correct the SDD to enumerate all twelve intentional ownership behavior changes.
- [x] Pin the follow-up/drain overlap and verify the four existing ownership regression tests.
- [x] Treat concurrent terminal interaction settlement as clean ownership loss.
- [x] Tighten claim settlement typing and preserve primary settlement errors.
- [x] Cache runtime scopes and share transcript parsing across pending-input gates.
- [x] Replace regex ownership checks with fail-closed TypeScript AST checks.
- [x] Correct claim diagnostics and stale-instance error classification.
- [x] Make pending-input single flight atomic and token-owned before the first asynchronous read.
- [x] Prevent cleanup hydration and terminalize every canceled interaction message.
- [x] Stop terminal persistence from referencing messages removed by retry rollback.
- [x] Standardize recovery logging and remove duplicated lane/project-directory mutation paths.
- [x] Add focused admission, drain-race, cancellation, and rollback regression coverage.
- [x] Run pull-request review validation and inspect the complete follow-up diff.
- [x] Commit the reviewed pull-request follow-up without pushing.
- [x] Run focused and full validation, review the complete diff, and fix every finding.
- [x] Commit every reviewed stage without pushing.

## Future Pull Requests

- [ ] Reduce the remaining composition callback graph (currently approximately 43 callbacks).
- [ ] Narrow `DeepChatLoopRunnerPorts` (currently 32 members) around stable runtime services.
- [ ] Move remaining session hydration, Agent identity, and message-refresh compatibility adapters
      out of the root as part of the facade boundary.
- [ ] Add a thin Harness facade over the stabilized internal services.
- [ ] Add typed deterministic hook/event reduction over the facade event model.
- [ ] Design same-run steering separately if the product semantics are approved.
