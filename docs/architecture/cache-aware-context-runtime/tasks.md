# Cache-Aware Context Runtime Tasks

## Specification

- [x] Inspect DeepChat, Bub, Pi, and the installed AI SDK provider adapters.
- [x] Record the prompt trust, cache transport, compaction, compatibility, and telemetry contracts.
- [x] Write the English architecture `spec.md`, `plan.md`, and `tasks.md`.
- [x] Update the maintained Tape and Memory architecture references.
- [x] Review and commit the SDD slice.

## Provider Cache Transport

- [x] Add conversation and isolated cache intent at the AI SDK runtime boundary.
- [x] Preserve structured system instructions when provider metadata is present.
- [x] Correct official OpenAI, Anthropic, and Bedrock cache metadata.
- [x] Add OpenRouter and Zenmux final-body cache transforms with marker stripping.
- [x] Add real-adapter wire-capture and one-shot isolation tests.
- [x] Review and commit the provider slice.

## Context Trust and Prefix Stability

- [ ] Return structured summary, reconstruction, and Memory contributions.
- [ ] Project checkpoint data as synthetic user context.
- [ ] Inject Memory into the current or resume-owner user message.
- [ ] Preserve contributions across system refresh and context-pressure recovery.
- [ ] Remove the composed system-prompt memo and obsolete invalidation paths.
- [ ] Register the cache-aware default policy and ViewManifest schema 3 provenance.
- [ ] Add trust-boundary, prefix-stability, resume, refresh, recovery, and compatibility tests.
- [ ] Review and commit the context slice.

## Model-Aware Compaction

- [ ] Select complete retained turns using the configured floor and model-aware token target.
- [ ] Preserve the resume target and preceding configured turns.
- [ ] Keep manual compaction behavior and avoid persisted retained-tail copies.
- [ ] Persist retained-tail diagnostic counts in summary anchors.
- [ ] Add token target, cap, oversized turn, tool-group, and manual/resume tests.
- [ ] Review and commit the compaction slice.

## Provider Attempt Telemetry

- [ ] Add the narrow Tape provider-attempt writer capability.
- [ ] Record one idempotent outcome per actual provider request sequence.
- [ ] Handle cumulative usage, overflow retry, abort, error, and no-usage outcomes.
- [ ] Expose the latest nullable cache metrics through Tape info.
- [ ] Verify new events do not enter Memory ingestion projection.
- [ ] Review and commit the telemetry slice.

## Final Validation

- [ ] Run `pnpm run format`, `pnpm run i18n`, and `pnpm run lint`.
- [ ] Run `pnpm run typecheck`, `pnpm test`, and `pnpm run build`.
- [ ] Review any expected generated registry refresh.
- [ ] Review the complete `dev...HEAD` diff by severity and fix every finding.
- [ ] Confirm the working tree contains no unexpected files and no push occurred.
