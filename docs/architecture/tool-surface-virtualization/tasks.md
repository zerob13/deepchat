# Tool Surface Virtualization Tasks

## Architecture SDD

- [x] Decide to virtualize exposure while preserving native target identity.
- [x] Define Run ceiling, per-View eligibility, Active Surface, candidate, and retry semantics.
- [x] Define ToolSearch, budget, Skill activation, anti-oracle, definition drift, and ACP
      boundaries.
- [x] Define View facts, strict/fail-open persistence, recovery, and compatibility rules.
- [x] Define prompt-cache measurement and default-enable Go/No-Go gates.
- [x] Review and commit the SDD slice.

## P0-A: Canonical Domain And Shadow Measurement

- [x] Add canonical bounded Tool Surface domain types and deterministic hash recipes.
- [x] Build the Run owned definition universe across current Agent, MCP, Plugin, and valid enabled
      Skill capabilities.
- [x] Resolve Skill requirements through execution source mapping and cover absent, ambiguous,
      unresolved, disabled, reserved, and Plugin-unavailable cases.
- [x] Add provider ordering and candidate merge utilities with focused tests.
- [x] Bound canonicalization bytes/depth and prohibit hash caching without proven immutable
      definition revision.
- [x] Compute Run-level shadow decisions without changing provider payloads or Tape.
- [x] Add bounded content-free diagnostics for schema tokens, triggers, static overlap, and
      available baseline cache fields.
- [x] Add a main-process-only aggregate diagnostics read path without renderer or public IPC
      exposure.
- [x] Review and commit the P0-A slice.

## P0-B: Run And View Surface

- [ ] Freeze the Run Tool Ceiling and virtualization mode.
- [ ] Build one immutable ToolSurfaceSnapshot per requestSeq and reuse it for physical retries.
- [ ] Preserve active order, append accepted candidates, and shrink on current revocation.
- [ ] Keep ordinary V4 without ExecutionContract and bind V5 ceilings to active tools only.
- [ ] Cover small/full, large/virtualized, retry, recovery, revocation, and ACP behavior.
- [ ] Review and commit the Run/View slice.

## P0-B: ToolSearch And Native Activation

- [ ] Reserve and register `tool_search` as a conditional `system-model` read tool.
- [ ] Search only the originating frozen eligible catalog and return bounded metadata without schema
      or internal stable/server identifiers.
- [ ] Release candidates after durable outcome and merge by requestSeq, tool-call ordinal, result
      rank, and stable target.
- [ ] Discard pre-admission candidates across process restart and require a new search in the new
      Run.
- [ ] Activate accepted targets only in the next View under their native identities.
- [ ] Enforce reserve, batch, Run, provider, and V5 budgets without silent eviction or full
      fallback.
- [ ] Return a bounded Skill activation error when required tools cannot fit mid-Run.
- [ ] Stage a serialized no-I/O Skill resource bundle before committing a successful activation
      outcome.
- [ ] Review and commit the ToolSearch/activation slice.

## P0-B: Dispatch And Tape Provenance

- [ ] Reject non-active guessed calls with a generic anti-oracle response before target resolution.
- [ ] Compare the originating per-target canonical Tool definition hash before target
      `dispatch_committed`.
- [ ] Add bounded, independently hash-valid `view/tool_catalog` and `view/tool_surface` facts with
      canonical conflict checks and complete active target/hash pairs.
- [ ] Exclude surface facts from effective View, Memory ingestion, and ordinary Tape search.
- [ ] Atomically write strict V5 manifest/catalog/surface before request and keep ordinary V4
      fail-open with bounded diagnostics.
- [ ] Recover strict deferred dispatch only from unique hash-valid manifest and surface evidence.
- [ ] Review and commit the dispatch/Tape slice.

## Canary And Documentation

- [ ] Freeze privacy-preserving canary/holdout assignment per Run and roll back without mutating an
      active Run.
- [ ] Measure actual cache read/write, uncached input, effective billed input cost, extra rounds,
      latency, success, repeated search, and budget failures by provider cohort.
- [ ] Update maintained Tool, Tape, and cache-aware architecture references.
- [ ] Evaluate the seven default-enable Go/No-Go gates and record the decision.
- [ ] Review and commit the canary/documentation slice.

## Final Validation

- [ ] Run `pnpm run format`, `pnpm run i18n`, and `pnpm run lint`.
- [ ] Run `pnpm run typecheck` and all focused Agent, ToolService, Tape, and provider-cache suites.
- [ ] Run the broadest relevant main-process suite and record any reproduced baseline failures.
- [ ] Review the complete merge-base-to-HEAD diff by severity and fix every finding.
- [ ] Confirm `index.js` and all unrelated worktree changes remain unmodified and uncommitted.
- [ ] Confirm no push occurred.
