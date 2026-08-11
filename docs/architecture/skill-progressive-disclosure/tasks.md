# Skill Progressive Disclosure Tasks

## Specification

- [x] Verify current Skill catalog, tool, activation, context, and Tape paths.
- [x] Define Route / Discover / Activate product semantics and budgets.
- [x] Define Tape materialization, continuation, isolation, and fail-closed boundaries.
- [x] Write `spec.md`, `plan.md`, and `tasks.md`.
- [x] Update maintained Skill and Tape architecture references.
- [x] Review and commit the SDD slice.

## P0a: Route And Discover

- [x] Add canonical whitelisted Skill routing cards and stable normalization.
- [x] Add the 2-percent/2,000-token budget and Unicode-safe description cap.
- [x] Add binary UTF-8 ordering, deterministic shared-cap summaries, name-only, zero-block, and
      omission allocation.
- [x] Add compact system renderer and bounded render report.
- [x] Pass effective context length through prompt assembly without moving final preflight.
- [x] Add prompt provenance degradation for catalog shortening/omission.
- [x] Extend `skill_list` with optional `query`, `cursor`, and `limit`.
- [x] Add deterministic local lexical ranking and catalog-fingerprint-bound pagination.
- [x] Add structured JSON routing-card renderer and response token ceiling.
- [x] Remove arbitrary metadata and unbounded descriptions from provider results.
- [x] Wire Route omission and bounded discovery atomically.
- [x] Add boundedness, determinism, Unicode, tiny-window, ranking, cursor, pagination, whitelist,
      active-state, refresh, and omitted-Skill tests.
- [x] Review and commit the Route/Discover slice.

## P0b: Tape Foundation

- [ ] Add the forward-compatible physical `context` kind and canonical Skill materialization
      payload with per-body, count, and aggregate byte limits.
- [ ] Add narrow materialization writer and runtime reader capabilities.
- [ ] Add transactional strict payload equality and corruption handling for provenance-key reuse.
- [ ] Add ViewManifest schema 6/hash 4 with Skill contexts and optional ExecutionContract.
- [ ] Add Run/request/incarnation binding, independent durable-manifest policy, and runtime reader.
- [ ] Exclude materialization facts from effective views, transcript, search, Tape tools, Memory,
      ordinary renderer projection, and fork merge.
- [ ] Add old-reader compatibility, schema/hash, corruption, reset, isolation, and native SQLite
      tests.
- [ ] Review and commit the Tape Foundation slice.

## P0b: Safe Runtime View

- [ ] Extract the canonical fresh-resolving effective-content builder.
- [ ] Return body plus runtime instructions from root `skill_view`.
- [ ] Add exact result size/context checks, strict Journal outcome validation, and a strictly
      persisted canonical `tool_result` before activation.
- [ ] Make later transcript settlement reuse and verify the same tool-result fact.
- [ ] Add the Run-local projection registry and overlap-aware root-view confirmation.
- [ ] Require a strict schema-6 Skill-bearing manifest before the next provider request.
- [ ] Refresh only tools/allow-list after successful activation.
- [ ] Remove the duplicate leading-system body projection.
- [ ] Preserve supporting-file view and bound repeated root views.
- [ ] Add settlement ordering, manifest failure, all activation-source overlaps, repeat-view, and
      supporting-file tests.
- [ ] Review and commit the runtime-view slice.

## P0b: Message And Session Projection

- [ ] Separate message Skill refs from Session active Skills in runtime APIs.
- [ ] Add count/byte limits, conservative cheap guard, shared dry preflight, and two-phase
      materialization flow.
- [ ] Build active-turn and stable-system projections only from verified facts.
- [ ] Carry exact refs through tool rounds, retries, recovery, and in-process pause/resume; preserve
      existing parked restart behavior.
- [ ] Record Skill-context refs and projection hashes in strict Skill-bearing ViewManifests.
- [ ] Leave bounded historical markers without persisting full bodies in transcript history.
- [ ] Enforce one complete body per Skill per request.
- [ ] Stop first-message selection from becoming Session active state.
- [ ] Remove the dormant persistent mention fallback.
- [ ] Add continuation/new-execution, source drift, deduplication, recovery, and semantic tests.
- [ ] Review and commit the projection slice.

## P0b: Session Compatibility UI

- [ ] Display existing Session active Skills separately from next-message selections.
- [ ] Allow removal through the existing typed route without adding a Pin action.
- [ ] Add i18n strings and renderer tests for visibility, removal, and errors.
- [ ] Review and commit the compatibility UI slice.

## P1: Context Ledger

- [ ] Add ephemeral render reports without changing prompt-section identity.
- [ ] Derive category costs from the exact final projection and preflight.
- [ ] Report approximate, unattributed, and opaque costs honestly.
- [ ] Make overflow diagnostics actionable for Session active Skill removal.
- [ ] Add attribution and projection-mismatch tests.
- [ ] Review and commit the context-ledger slice.

## P2: Provider Overflow Facts

- [ ] Parse structured actual/limit observations from provider errors.
- [ ] Keep configured context, provider limit, Session ceiling, and estimator calibration separate.
- [ ] Retry only when optional context materially changes.
- [ ] Skip doomed protected-only retries and surface model-setting guidance.
- [ ] Add explicit-limit, generic-error, metadata-suspect, and retry-decision tests.
- [ ] Review and commit the overflow-facts slice.

## Final Validation

- [ ] Run format, i18n, lint, Node/web type checks, main/renderer tests, and build.
- [ ] Review generated provider and ACP registry output.
- [ ] Review the complete `dev...HEAD` diff by severity and fix every material finding.
- [ ] Confirm the branch has no unexpected files, no upstream, and no push occurred.
