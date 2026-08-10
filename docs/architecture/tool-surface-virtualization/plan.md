# Tool Surface Virtualization Implementation Plan

## 1. Establish Canonical Tool Surface Domains

- Add bounded domain types for stable target entries, canonical Tool definition hashes, Run Tool
  Ceiling, activation candidates, Active Surface, and ToolSurfaceSnapshot.
- Reuse the existing provider-visible tool-definition canonicalization layer without changing
  ViewManifest or ExecutionContract hash recipes.
- Build the owned definition universe from current Agent/MCP/Plugin policy and every currently valid
  enabled Skill before freezing the Run ceiling.
- Resolve Skill requirements through the execution source-mapping rules; fail initially mandatory
  ambiguity and mark an inactive affected Skill non-activatable with bounded degradation.
- Add deterministic catalog ordering and catalog hashing independently from canary provider-visible
  append ordering.
- Add focused tests for canonical ordering, hash stability, bounds, deep immutability, active
  append order, revocation/re-enable projection, and candidate merge by tool-call ordinal.
- Add byte/depth adversarial cases and cache canonical hashes only by a proven immutable source
  revision.

## 2. Add P0-A Shadow Measurement

- Compute the Run owned definition universe, initial eligibility, and versioned shadow selection
  while leaving the current provider payload untouched.
- Reuse `estimateToolDefinitionTokens` for full and simulated Active Surface estimates, including
  ToolSearch overhead.
- Record only bounded content-free process diagnostics: counts, tokens, trigger decision, static
  hypothetical surface overlap, and available baseline cache fields.
- Isolate collector errors from generation and do not write P0-A shadow decisions to Tape, traces,
  Agent configuration, or request payloads.
- Add a development-only read path for aggregate diagnostics without exposing a public setting.

## 3. Freeze Run Ceiling And Per-View Snapshot

- Store the frozen Run Tool Ceiling and Run-level virtualization decision in `LoopRun.resources`.
- Derive a new immutable ToolSurfaceSnapshot before each provider request sequence and retain the
  exact value through all physical retries.
- Keep the current Active Surface stable within the Run, append accepted candidates at the next
  View, and remove currently revoked entries without adding capabilities outside the ceiling.
- Pass the same snapshot to provider tools construction, V5 contract construction, View fact
  persistence, and tool dispatch.
- Keep ACP on its existing empty/external DeepChat tool resolver path.

## 4. Add Native `tool_search`

- Reserve `tool_search` and register it as a read-effect `system-model` Agent tool.
- Inject it only when the Run-level virtualization decision is active.
- Statically register the handler and pass the originating frozen catalog plus a batch-owned
  candidate sink through typed execution options; never register a per-View closure or read a
  mutable latest catalog.
- Return bounded model-visible name, reviewed source label, description, effect, tags, and pending
  candidate state without a full JSON Schema or internal stable/server IDs.
- Release candidates only after durable outcome and complete batch settlement, merge by requestSeq,
  tool-call ordinal, result rank, and stable target, then commit accepted activation at provider
  admission.
- Discard candidates on a pre-admission process crash; a new Run must search again rather than
  reconstructing candidates from Tape or a mutable catalog.
- Keep ToolSearch's own dispatch/outcome facts on the normal read-tool path.

## 5. Enforce Active Membership And Definition Identity

- Bind the originating ToolSurfaceSnapshot to each tool batch alongside the existing
  ExecutionContract binding.
- Reject calls outside active membership with the existing generic unavailable response before
  resolving a hidden target.
- Carry per-target canonical Tool definition hashes to ToolService and compare them with the current
  stable target before target `dispatch_committed`.
- Retain the existing specific live-authority, permission, approval, contract, target, and MCP drift
  errors for tools that were legitimately active.
- Keep the ExecutionContract schema unchanged and make V5 ceilings describe only active tools.

## 6. Enforce Budgets And Skill Activation Semantics

- Define the versioned initial budget, activation reserve, search result cap, batch append cap, Run
  append cap, provider cap, and contract-bearing V5 limit.
- Fail closed at Run admission if the initial mandatory set cannot fit.
- Record a bounded rejection in next-surface provenance when a pending candidate cannot fit; never
  evict active tools or expose the full catalog.
- Atomically preflight Skill ceiling membership and budget before changing Skill/prompt state; fail
  that Skill call, not the following provider request, when required tools cannot fit.
- Replace warning-only post-outcome Skill refresh with a serialized immutable resource bundle that
  is fully computed before success outcome and applied without I/O before the next View.
- Add cross-Run enter/exit hysteresis as a bounded selection hint that is always intersected with
  current eligibility.

## 7. Persist View Tool Facts

- Add bounded schemas, independently verifiable projection/surface hash recipes, canonical conflict
  validation, and a dedicated application capability for `view/tool_catalog` and
  `view/tool_surface`.
- Reserve the two event names from generic Tape writers and exclude them from effective conversation
  View, Memory ingestion, and normal search.
- Deduplicate catalog facts by full catalog hash within one Tape incarnation and key surface facts
  by the complete provider request identity.
- Validate and persist manifest, catalog fact, and surface fact in one transaction before provider
  admission; make the transaction strict for contract-bearing V5 and fail-open with bounded
  diagnostics for ordinary V4.
- Do not change old ViewManifest schemas or hash recipes.

## 8. Recover Deferred Dispatch Safely

- Keep process-live dispatch on the request-scoped snapshot with no Tape read.
- Store ordered active target/hash pairs and a surface hash in `view/tool_surface`. On strict V5
  restart recovery, require one hash-valid surface fact and exact active-target hash in addition to
  the existing V5 manifest binding.
- Treat missing, duplicate, malformed, conflicting, or stale strict recovery evidence as
  fail-closed.
- Persist a surface/target/hash binding on every new canary V4 paused action and enforce it after
  restart; retain legacy behavior only for historical actions without that binding.

## 9. Canary Measurement And Rollback

- Assign and freeze P0-B canary/holdout cohort before Run construction using a privacy-preserving
  stable bucket; do not add a public setting or silently enable it for all Sessions.
- Compare deterministic canary and contemporaneous holdout cohorts by provider, model, policy, and
  catalog-size band. Correlate surface diagnostics with existing provider attempt cache read/write
  usage, provider rounds, latency, stop classification, and versioned provider pricing.
- Split providers without cache metrics or pricing into separate cohorts.
- Roll back by preventing new canary Runs; never mutate an existing Run's frozen mode or facts, and
  require a new Run identity after an emergency cancellation.
- Decide default enablement only from trigger rate, effective input cost, non-inferior success rate,
  p95 latency/round budget, repeated-search rate, and zero authority/drift violations.

## 10. Documentation And Validation

- Update `tool-system.md` with Run ceiling, Eligible Catalog, Active Surface, and native activation
  ownership after the behavior lands.
- Update `tape-system.md` with the two View fact write disciplines and recovery-only read exception.
- Update cache-aware architecture text with deterministic tools ordering and measured tools-array
  churn.
- Add focused domain, ToolService, loop, retry/recovery, Tape replay, Agent harness, ACP exclusion,
  and prompt-cache telemetry tests for each owning slice.
- Before every commit, review the staged and merge-base diff for hidden side effects,
  compatibility, edge cases, performance, security, misleading names, test gaps, and maintenance
  cost; fix findings before committing.
- Before handoff, run format, i18n, lint, Node/web typecheck, focused main-process suites, and the
  broadest relevant Agent/Tape suites.
