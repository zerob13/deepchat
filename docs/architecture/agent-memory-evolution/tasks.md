# Agent Memory Evolution — Tasks

## 0. Specification and baseline

- [x] Record the non-versioned architecture goal and invariants.
- [x] Define temporal, directive, lineage, forgetting, projection, and scope contracts.
- [x] Add deterministic four-axis behavioral fixtures and a CI test harness.
- [x] Add a domain clock without coupling scheduler/performance time to business time.

## 1. Temporal claims

- [x] Add temporal domain types and normalization helpers.
- [x] Add additive SQLite columns, migration, repair, and fresh-schema constraints.
- [x] Extend insert/read/management/route DTO contracts.
- [x] Extend extraction prompt/parser with clock context and legacy response compatibility.
- [x] Preserve temporal metadata across update, supersede, conflict, merge, and manual-edit paths.
- [x] Apply temporal eligibility, ranking, annotations, and trace data before access accounting.
- [x] Cover atemporal, current, expired, future, uncertain, plan, event, and recurring cases.

## 2. Exact forgetting

- [ ] Add hash-only tombstone persistence and indexes.
- [ ] Tombstone and delete selectively in one transaction.
- [ ] Tombstone claims during clear and preserve tombstones until Agent retirement.
- [ ] Suppress exact provenance/content recreation inside the insert transaction.
- [ ] Keep clear/Agent retirement semantics explicit.
- [ ] Cover replay, concurrent mutation, privacy, and independent-source behavior.

## 3. Durable lineage and dirty consolidation

- [ ] Add durable derivation relations and idempotent inserts.
- [ ] Write merge/reflection/supersede/manual-edit edges transactionally.
- [ ] Add the persistent bounded dirty-work queue.
- [ ] Mark dirty work on committed claim mutations.
- [ ] Consolidate bounded dirty clusters and settle only successful seeds.
- [ ] Remove dependence on operational audit retention for lineage.
- [ ] Cover retries, stale IDs, budget exhaustion, and audit pruning.

## 4. Directive plane

- [ ] Add directive types, persistence, state transitions, and owner indexes.
- [ ] Add explicit/manual creation and derived draft suggestions.
- [ ] Add approve/reject/delete management routes and typed client methods.
- [ ] Gate retrieval with active suppression directives before access accounting.
- [ ] Render a separate bounded user-role directive contribution.
- [ ] Reuse the inbox approval interaction without mixing directives into persona state.
- [ ] Cover trust transitions, prompt separation, injection safety, and suppression false positives.

## 5. Projection and budget

- [ ] Build deterministic structured working projections from claims.
- [ ] Annotate state/event/plan/recurring claims without changing claim content.
- [ ] Add one total-budget allocator with floors, ceilings, reservation, and borrowing.
- [ ] Extend manifests/diagnostics with allocation decisions.
- [ ] Cover determinism, starvation, truncation, CJK density, and hard ceilings.

## 6. Scope applicability

- [ ] Add scope fields and backfill `user_scope`.
- [ ] Keep the `user_scope` compatibility shadow synchronized.
- [ ] Extend write and query contexts with typed scopes.
- [ ] Apply identical owner-and-scope predicates to FTS and vector results.
- [ ] Surface scope metadata through additive DTO fields.
- [ ] Cover missing, mismatched, and matching user/project/session contexts.

## 7. Documentation and validation

- [ ] Update `docs/architecture/memory-system.md` as the maintained contract.
- [ ] Run formatting and i18n maintenance.
- [ ] Run lint and full typecheck.
- [ ] Run focused Memory suites and maintained behavior/retrieval gates.
- [ ] Run broader main-process tests when runtime permits.
- [ ] Complete a final severity-ordered review and resolve every actionable finding.
