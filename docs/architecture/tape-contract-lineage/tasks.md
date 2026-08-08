# Tape Contract Lineage Tasks

## SDD

- [x] Record the two-level contract decision and three-field ExecutionContract model.
- [x] Define authority, transaction, inheritance, compatibility, and strictness boundaries.
- [x] Define P0/P1 scope and keep repair, retry, override, and deterministic replay out of V1.
- [x] Review and commit the SDD slice.

## P0: Contract Domains And Prompt Provenance

- [ ] Add canonical contract schemas, builders, hash versions, and domain tests.
- [ ] Return structured prompt sections without changing provider-visible prompt text.
- [ ] Record AGENTS.md freshness/degradation and pinned-skill/tooling omissions.
- [ ] Thread prompt provenance through turn and loop assembly.
- [ ] Review and commit the prompt/contract-domain slice.

## P0: ViewManifest V5 And Enforcement

- [ ] Embed ExecutionContract in ViewManifest schema 5 and preserve v1-v4 reads.
- [ ] Keep interactive manifest persistence fail-open and require contract-bearing child manifests.
- [ ] Carry the exact View contract to tool dispatch without Session-global mutable state.
- [ ] Enforce stable tool target, effect, workspace, and nesting ceilings with current authority.
- [ ] Cover retries, tool rounds, revocation, expansion, and contract mismatch.
- [ ] Review and commit the View/enforcement slice.

## P1: Strict Contract Persistence

- [ ] Reserve `contract/*` and add a transaction-aware strict Tape capability.
- [ ] Add complete Tape identity and canonical conflict validation.
- [ ] Add nullable live-delegation contract/evaluation projection columns and migration coverage.
- [ ] Atomically freeze parent TaskContract with initial and follow-up turn creation.
- [ ] Re-anchor hash-verified runtime projections after parent Tape reset.
- [ ] Review and commit the parent-freeze/storage slice.

## P1: Child Inheritance

- [ ] Strictly append the inherited TaskContract to child Tape before Handoff dispatch.
- [ ] Persist child-local reference and expose active contract context through a narrow port.
- [ ] Re-inherit the contract after child Tape reset before the next provider request.
- [ ] Reconcile legacy active turns with an explicit compatibility contract.
- [ ] Cover restart, repeated inheritance, reset/incarnation conflict, and missing child Tape.
- [ ] Review and commit the child-inheritance slice.

## P1: Evaluation And Parent Visibility

- [ ] Implement bounded required-section and result-schema evaluation.
- [ ] Commit evaluation fact, projection, terminal state, and mailbox event atomically.
- [ ] Ensure every contract-bearing terminal path produces evaluation or remains recoverable.
- [ ] Surface evaluation through inspect, wait, read_result, and the untrusted result envelope.
- [ ] Preserve orthogonal execution status, verdict, and disposition semantics.
- [ ] Cover no answer, malformed result, cancellation, interruption, evaluator failure, and
      settlement retry/recovery.
- [ ] Review and commit the evaluation/settlement slice.

## Documentation And Final Validation

- [ ] Update retained Tape and proactive multi-Agent architecture references.
- [ ] Run format, i18n, lint, Node/web typecheck, focused tests, and relevant main suites.
- [ ] Review the complete `dev...HEAD` diff and fix findings by severity.
- [ ] Confirm every task and acceptance criterion is represented in code or documented as deferred.
- [ ] Confirm the branch has not been pushed.
