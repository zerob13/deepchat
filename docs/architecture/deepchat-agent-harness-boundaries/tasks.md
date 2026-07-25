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
- [ ] Extend the existing compaction owner and reduce the root to composition and compatibility.
- [ ] Split owner tests while retaining focused full-runtime integration coverage.
- [ ] Update architecture guards and regenerate the layered-runtime baseline.
- [ ] Run focused and full validation, review the complete diff, and fix every finding.
- [ ] Commit every reviewed stage without pushing.

## Future Pull Requests

- [ ] Add a thin Harness facade over the stabilized internal services.
- [ ] Add typed deterministic hook/event reduction over the facade event model.
- [ ] Design same-run steering separately if the product semantics are approved.
