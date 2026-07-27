# Model Capability Identity Tasks

## Specification

- [x] Trace New API K3 capability matching through route and runtime request construction.
- [x] Verify the installed OpenAI-compatible adapter's provider-option serialization.
- [x] Record the two-phase endpoint/capability dependency and identity precedence.
- [x] Record K3, K2, Grok, unknown-model, renderer, and performance invariants.
- [x] Write the architecture `spec.md`, `plan.md`, and `tasks.md`.
- [x] Update the maintained provider runtime contract.
- [x] Review and commit the SDD slice.

## Capability identity

- [x] Add the main-process two-phase capability identity resolver.
- [x] Rename `capabilityProviderId` route hints to `capabilityFamilyHint`.
- [x] Move transport fallback and ZenMux override out of the shared renderer module.
- [x] Remove the unused BaseProvider capability resolver.
- [x] Resolve RouteDecision capability identity once and pass it through runtime context.
- [x] Add one ProviderSettings capability snapshot and compatibility wrappers.
- [x] Preserve temperature `true`, `false`, and `unknown` states.
- [x] Make a resolved identity select all capability fields from one catalog model.
- [x] Add New API K3, OpenCode Go, ZenMux, ambiguity, and unknown-model tests.
- [x] Review and commit the capability identity slice.

## Model request policy

- [x] Generalize the Kimi policy to pass through, fix, or omit generation parameters.
- [x] Preserve K2 fixed-temperature and thinking behavior.
- [x] Add K3 temperature/top-P omission, required reasoning, and legacy-thinking omission.
- [x] Serialize effective generation parameters once for trace, generate, and stream.
- [x] Preserve stored user settings without migration.
- [x] Add direct, aggregator, qualified-ID, missing-catalog, and K2 regression tests.
- [x] Review and commit the model request policy slice.

## Reasoning and consumers

- [x] Consume K3 effort options `low`, `high`, and `max` with default `max`.
- [x] Restore Grok Mini final-body `reasoning_effort` through the standard AI SDK option.
- [x] Add real-adapter request-capture tests for New API K3 and Grok.
- [x] Extend the typed capability route with identity and generation policy.
- [x] Remove local capability-provider resolution from ChatStatusBar.
- [x] Remove local capability-provider resolution from ModelConfigDialog.
- [x] Update agent generation settings to consume the authoritative snapshot.
- [x] Add the narrow provider-model route metadata getter.
- [x] Ensure each request resolves route, identity, and generation parameters once.
- [x] Add renderer control and complete Moonshot portrait regression tests.
- [x] Review the consumer and de-duplication slice.

## Final validation

- [x] Run focused main, shared, agent, and renderer tests.
- [x] Run `pnpm run format`, `pnpm run i18n`, and `pnpm run lint`.
- [x] Run full type checking, the full test suite, and the production build.
- [x] Review generated provider and ACP registry changes if the build refreshes them.
- [x] Review the complete branch diff by severity and fix every finding.
- [x] Confirm the final worktree is clean, commits are local, and no push occurred.

## Post-implementation review hardening

- [x] Unify canonical model-ID normalization and K3 request/fallback matching.
- [x] Cover coding, free, qualified, and separator-normalized K3 aliases.
- [x] Add deterministic origin identity for authoritative model families without arbitrary mirror
      selection.
- [x] Split request-facing and catalog-facing model IDs in resolved identity.
- [x] Restore the known-provider model-config source boundary.
- [x] Resolve route metadata without deriving full capability defaults first.
- [x] Scope runtime reasoning-effort correction to K3.
- [x] Require explicit request policy and reasoning portrait in provider-option mapping.
- [x] Move Anthropic top-P behavior into the shared main-process request policy.
- [x] Add provider-model reasoning prefilter and readonly internal cache view.
- [x] Separate raw route metadata from derived provider-model cache state.
- [x] Remove the obsolete Moonshot policy re-export.
- [x] Run focused and full validation.
- [x] Complete a new severity-ordered review and commit without pushing.

## Renderer generation-control convergence

- [x] Record stable Aihubmix K3 divergence and renderer lifecycle invariants in the SDD.
- [x] Normalize temperature capability into the wire-effective snapshot policy.
- [x] Make `useModelCapabilities` own atomic snapshot, status, retry, and control projection.
- [x] Migrate ChatConfig, ChatStatusBar, and ModelConfigDialog to the shared projection.
- [x] Replace Kimi-specific fixed temperature UI state with generic fixed policy.
- [x] Add stable loading skeletons and explicit retryable error states.
- [x] Add direct Aihubmix K3, loading, error, stale response, fixed, and effort regressions.
- [x] Add a cross-layer renderer/wire policy matrix test.
- [x] Run focused and full validation.
- [x] Review the complete diff by severity, fix findings, and commit without pushing.

## Validation Result

- Focused provider, agent, shared, contract, and renderer suites passed; the final provider-model
  helper suite passed all 18 tests after the cache-path optimization.
- `pnpm run format`, `pnpm run i18n`, and `pnpm run lint` passed.
- `pnpm run typecheck` passed both node and renderer type checking.
- `pnpm test` passed 636 files with 19 skipped; 6,654 tests passed with 241 skipped.
- `pnpm run build` passed and refreshed the provider and ACP registry resources.
- The refreshed provider database contains 175 providers and 7,728 models. Both Moonshot K3
  records retain `temperature: false` and the complete reasoning portrait required by this
  specification.
- Post-review focused provider, runtime, helper, renderer, agent, contract, and wire suites passed.
  The final K3 wire matrix covers canonical, free, coding, coding-free, and separator-normalized
  aliases.
- The post-review full suite passed 637 files with 19 skipped; 6,674 tests passed with 241 skipped,
  including the expanded seven-case reasoning wire suite.
- Post-review `pnpm run format`, `pnpm run i18n`, `pnpm run lint`, full type checking, and
  `pnpm run build` passed. The build refreshed the expected ACP registry entry for Harn 0.10.41;
  provider-db content remained stable.
- The final severity-ordered review found and fixed a cache-state-dependent route metadata source,
  replacing derived array scans with a compact raw O(1) route index shared by runtime and settings.
  No remaining high, medium, or low-severity findings were identified.
- Renderer convergence focused validation passed 8 files and 204 tests across request policy,
  capability identity, final AI SDK serialization, the shared renderer projection, and all three
  renderer entry points.
- The final full suite passed 638 files with 19 skipped; 6,693 tests passed with 241 skipped.
- Renderer convergence formatting, i18n validation, lint, full type checking, and the production
  build passed. The build refreshed the expected Claude Agent ACP registry entry from 0.62.0 to
  0.63.0; provider-db content remained stable.
- The severity-ordered renderer review found and fixed one medium-severity stale-identity window
  that could enable saving a renamed custom model against the prior capability snapshot, and one
  low-severity overbroad shared-helper name. No remaining findings were identified.
