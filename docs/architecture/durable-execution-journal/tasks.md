# Durable Execution Journal Tasks

## 1. Architecture Contract

- [x] Record the DeepChat failure model, authority boundary, commit contract, and non-goals.
- [x] Define v1 fact names, structured identities, failure semantics, and compatibility constraints.
- [x] Define implementation order, recovery policy, test strategy, and commit review requirements.
- [x] Review the SDD before source implementation.
- [ ] Commit the reviewed SDD before source implementation.

## 2. Journal Domain And Persistence

- [ ] Add protocol constants, fact types, identity validation, parsers, errors, and classifier.
- [ ] Add collision-safe provenance derivation and canonical payload hashing.
- [ ] Add strict same-payload idempotency and conflicting-payload corruption detection.
- [ ] Add the journal event query and supporting SQLite index.
- [ ] Expose narrow writer and recovery-reader capabilities through `SessionTape`.
- [ ] Add pure and native SQLite tests.
- [ ] Review and commit the persistence slice.

## 3. Normal Run Lifecycle

- [ ] Replace process-local loop Run IDs with UUIDs.
- [ ] Commit `run_started` before Run registration.
- [ ] Pass structured operation identity into each tool execution.
- [ ] Commit T2 before staged result projection for known success and failure outcomes.
- [ ] Commit all terminal outcomes before transcript, status, hooks, and UI projection.
- [ ] Prevent a post-terminal projection failure from attempting a conflicting terminal fact.
- [ ] Add loop ordering and failure tests.
- [ ] Review and commit the lifecycle slice.

## 4. Resolved Tool Boundaries

- [ ] Add the per-call dispatch commit callback without introducing a Tape dependency in tools.
- [ ] Commit MCP T1 after final policy, binding, target, argument, and abort checks.
- [ ] Commit Agent T1 at each persistent or external side-effect boundary.
- [ ] Ensure local refusal and permission paths produce no T1.
- [ ] Ensure duplicate claims and journal failures prevent physical invocation.
- [ ] Add MCP and representative Agent boundary tests.
- [ ] Review and commit the tool-boundary slice.

## 5. Deferred Execution And Recovery

- [ ] Give deferred approval execution a fresh UUID Run and request sequence `1`.
- [ ] Apply run start, T1, T2, and terminal ordering to deferred execution.
- [ ] Classify native v1 journal facts before pending transcript recovery at startup.
- [ ] Keep `indeterminate` and `corruption` parked with no automatic tool retry.
- [ ] Add failpoints and restart/crash tests around T1, T2, and terminal boundaries.
- [ ] Update maintained architecture documentation for the final implemented contract.
- [ ] Review and commit the recovery slice.

## 6. Final Validation

- [ ] Run formatting and i18n checks.
- [ ] Run lint and typecheck.
- [ ] Run relevant unit, integration, native SQLite, and platform-supported crash tests.
- [ ] Perform a final severity-ordered review of the complete branch diff.
- [ ] Fix findings and rerun affected validation.
- [ ] Confirm no remote Git operation was performed.
