# Tool Surface Virtualization Tasks

## Architecture SDD

- [x] Decide to virtualize exposure while preserving native target identity.
- [x] Define Run ceiling, per-View eligibility, Active Surface, candidate, and retry semantics.
- [x] Define ToolSearch, budget, Skill activation, anti-oracle, definition drift, and ACP boundaries.
- [x] Define View facts, strict/fail-open persistence, recovery, and compatibility rules.
- [x] Define prompt-cache measurement and default-enable Go/No-Go gates.
- [x] Review and commit the SDD slice.
- [x] Approve dual disjoint surfaces, three frozen adapters, Agent CLI protocol, nested Journal v2,
      Batch v1, Tape provenance, failure matrix, cache evaluation, and security boundaries.
- [x] Preserve V1 compatibility and resolve all architecture clarifications.

## P0-A: Canonical Domain And Shadow Measurement

- [x] Add canonical bounded Tool Surface domain types and deterministic hash recipes.
- [x] Build the Run owned definition universe across Agent, MCP, Plugin, and valid enabled Skills.
- [x] Resolve Skill requirements through execution source mapping and cover absent, ambiguous,
      unresolved, disabled, reserved, and Plugin-unavailable cases.
- [x] Add provider ordering and candidate merge utilities with focused tests.
- [x] Bound canonicalization bytes/depth and prohibit hash caching without proven immutable revision.
- [x] Compute Run-level shadow decisions without changing provider payloads or Tape.
- [x] Add bounded content-free diagnostics for tokens, triggers, overlap, and available cache fields.
- [x] Add a main-process-only aggregate diagnostics read path without public IPC exposure.
- [x] Review and commit the P0-A slice.

## P0-B: Native Activation (Retained HEAD Work)

- [ ] Freeze the Run Tool Ceiling and virtualization mode.
- [ ] Build one immutable ToolSurfaceSnapshot per requestSeq and reuse it for physical retries.
- [ ] Preserve active order, append accepted candidates, and shrink on current revocation.
- [ ] Keep V4 without ExecutionContract and bind V5 ceilings to active tools only.
- [ ] Reserve/register native `tool_search` and search only its originating frozen catalog.
- [ ] Return bounded metadata without schema or internal identifiers.
- [ ] Release after durable outcome; ordinal-merge and deduplicate after complete batch settlement.
- [ ] Discard pre-admission candidates across restart and activate only in the next View.
- [ ] Enforce reserve, batch, Run, provider, and V5 budgets without eviction/full fallback.
- [ ] Return bounded Skill activation failure and stage serialized no-I/O resource bundles.
- [ ] Reject guessed inactive calls before target resolution and compare canonical definition hash
      before target T1.
- [ ] Add bounded hash-valid catalog/provider surface facts and exclude them from View/Memory/search.
- [ ] Atomically write strict V5 facts, keep honest V4 fail-open diagnostics, and recover strict
      deferred dispatch only from unique exact evidence.
- [ ] Cover small/full, large/virtualized, retry, recovery, revocation, Skill, crash, and ACP cases.
- [ ] Review and commit each Native Activation slice; do not push.

## Dual Surface

- [ ] Freeze the Run Tool Ceiling and one adapter mode per Run.
- [ ] Build one immutable snapshot per `requestSeq` and reuse it for physical retries.
- [ ] Assemble mutually exclusive Provider Active and Programmatic surfaces with all exclusions.
- [ ] Add `ProgrammaticToolCapabilityV1` with exact identity, hashes, projection, ceilings, quotas,
      and versions.
- [ ] Keep the complete live Programmatic target/hash set within hard bounds; allow truncation only
      in the durable projection, and use the frozen Run ceiling to reject oversized sets before
      adapter admission so a later View cannot overflow.
- [ ] Keep V5 ExecutionContract ceilings provider-visible only and ACP excluded.
- [ ] Cover revocation, definition drift, recovery, and no-within-Run-adapter-switch behavior.
- [ ] Perform a severity review before commit; do not push.

## CLI Programmatic and Three Adapters

- [ ] Implement Direct Native, CLI Programmatic, and Native Activation route selection.
- [ ] Add cross-Run sticky/hysteresis policy and measured model CLI capability.
- [ ] Add Agent-only `deepchat tool search|describe|call|batch` routes.
- [ ] Add version-negotiated `CLI_SURFACE_V2` as a strict V1 superset and prove V1 cannot reach the
      new routes.
- [ ] Mint exact outer-operation invocation tokens only for CLI Programmatic Runs.
- [ ] Construct the per-View capability without `providerToolCallId`, then derive an exact
      provider-operation grant after the outer exec call exists.
- [ ] Add bounded owned stdin for call/batch bodies and reject background/detached/yielded
      Programmatic commands before outer T1.
- [ ] Keep prepared tokens inert until a new outer T1 receipt arms the grant; revoke on failure and
      prevent process spawn.
- [ ] Bind route plus canonical stdin/scalar arguments, atomically consume once, and reject changed
      body/route, replay, expiry/revocation, and wrong principal/conversation.
- [ ] Keep search/describe read-only with no authorization, activation, seen ledger, or target Journal
      fact.
- [ ] Return only bounded invocation names, reviewed metadata, signatures/schemas, and copyable
      examples without internal stable IDs, server UUIDs, hashes, MCP metadata, or secrets.
- [ ] Enforce direct call without search and one bounded anti-oracle unavailable shape.
- [ ] Add fixed Skill-to-CLI adapter guidance without dynamic prefix churn.
- [ ] Perform a severity review before commit; do not push.

## Journal v2

- [ ] Add discriminated provider/nested operation identities with v1/v2 coexistence.
- [ ] Persist only canonical hashes, status, and bounded provenance; reject conflicting payloads.
- [ ] Add process-live parent controller and settlement receipts across the CLI boundary.
- [ ] Bind receipts to canonical outer-result hashes instead of trusting stdout for settlement.
- [ ] Before opening any Agent tool route, make the process-live controller the sole production
      Programmatic outer-T2 path and call its terminal fence from the real Run terminal path without
      reading Tape.
- [ ] Enforce parent/child T1/T2/terminal causality, including rejection of outer T2 and
      `run_terminal` while any Programmatic T1 is unmatched, and Run-fatal Journal failures.
- [ ] Implement independent per-child preflight and default per-child approval.
- [ ] Cover cancellation, crash, parking, explicit retry, and missing outer T2 failure states.
- [ ] Perform a severity review before commit; do not push.

## Batch v1

- [ ] Implement bounded fixed-count sequential fail-fast Batch v1 with controller-assigned contiguous
      plan-index ordinals and one-child `call`.
- [ ] Support only bounded RFC 6901 bindings from existing argument destinations to prior immutable
      results; reject duplicate/overlapping destinations, interpolation, dynamic expansion,
      parallel/DAG, retry, recursion, sandboxing, and restart recovery.
- [ ] Reapply per-child and aggregate byte/depth/entry/retention quotas after materialization.
- [ ] Cover malformed/missing/type-mismatched references, amplification, and fail-fast
      `not_started` behavior.
- [ ] Cover the complete cancellation/crash/parking/explicit-retry failure matrix.
- [ ] Perform a severity review before commit; do not push.

## Tape, Context, and Canary

- [ ] Add bounded `view/programmatic_tool_surface` with strict canonical conflict checking.
- [ ] Bind strict V5 facts before provider admission; retain honest V4 fail-open provenance.
- [ ] Keep normal dispatch free of Tape reads.
- [ ] Preserve outer exec only in provider Context and project real nested target truth through
      Journal/UI.
- [ ] Measure provider-specific billed cost, cache metrics, schema churn, rounds, latency, and
      quality by cohort.
- [ ] Evaluate adapter routing without claiming whole-prefix stability or Native Activation
      completion percentages.
- [ ] Perform a severity review before commit; do not push.

## Final Validation

- [ ] Run `pnpm run format`, `pnpm run i18n`, and `pnpm run lint`.
- [ ] Run `pnpm run typecheck` and focused ToolService, Agent, CLI, Tape, Journal, provider-cache,
      retry, and supported crash suites when implementation lands.
- [ ] Run the broadest relevant main-process suite and record reproduced baseline failures.
- [ ] Review the complete diff by severity and fix all findings.
- [ ] Confirm `index.js` and all unrelated worktree changes remain unmodified and uncommitted.
- [ ] Confirm no push occurred.
