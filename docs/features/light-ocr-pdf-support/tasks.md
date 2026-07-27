# Light OCR 0.5.5 PDF Support Tasks

## Specification

- [x] Verify the upstream 0.5.5 release, npm facade/runtime/native tarballs, public document API, and
  PDFium manifests.
- [x] Resolve Auto routing, page range, pixel limits, streaming termination, partial-result,
  cancellation, retry, cache identity, compatibility, and replacement semantics.
- [x] Write the feature specification and implementation plan.
- [x] Complete the pre-commit specification review and commit the SDD slice.

## Dependency And Packaging

- [x] Pin facade 0.5.5, runtime 0.1.5, model 0.3.4, and native 0.5.5 independently.
- [x] Copy and verify the runtime package in supported packaged layouts.
- [x] Add shared script artifact classification and drift tests.
- [x] Encode and smoke-validate macOS PDFium Mach-O artifacts.
- [x] Materialize verified PDFium files with the `@loader_path` same-directory contract.
- [x] Resolve development native packages through runtime ownership.
- [x] Advance and validate packaged OCR manifest schema v3.
- [x] Update size accounting for the PDFium payload.
- [x] Complete the pre-commit packaging review, focused tests, and commit.

## Streaming Document OCR

- [x] Add protocol-v2 document request/page/completion/stop contracts.
- [x] Add helper document-engine reuse, structured errors, PDF capability validation, and separate
  output-stop/user-cancel behavior.
- [x] Add host streaming pending state with idle and total timeouts.
- [x] Add queue accounting, cancellation cleanup, monotonic page validation, and crash behavior.
- [x] Add protocol/helper/host tests for every legal and illegal terminal combination.

## Document Artifacts

- [x] Add immutable bounded PDF snapshots and shared scheduler ownership.
- [x] Add page-aware prefix assembly and lower-budget truncation.
- [x] Add exact document identity and schema-v2 storage.
- [x] Add persisted `generationOutputLimitReached` compatibility logic.
- [x] Add retained-text coverage dominance replacement.
- [x] Cover empty, complete, output-limited, resource-limited, cancel, timeout, and invalid-cache
  outcomes.

## Routing And Persistence

- [x] Add PDF attachment detection and contextual representation normalization.
- [x] Add bounded embedded-page coverage from `PdfFileAdapter`.
- [x] Add the 64-code-point / 90-percent Auto classifier and routing revision.
- [x] Route embedded, explicit OCR, and automatic OCR PDFs.
- [x] Enforce one PDF OCR candidate per preparation without reducing the image OCR allowance.
- [x] Preserve document coverage in normalized message snapshots.
- [x] Apply page-aware turn packing without modifying cache artifacts.
- [x] Exclude embedded PDF content when an OCR snapshot is selected.
- [x] Keep PDF OCR blocks escaped and guarded as untrusted user data.
- [x] Remove `ocr_empty` from retryable reasons and keep cancellation non-emitted.

## Renderer And i18n

- [ ] Add PDF Auto/embedded/OCR choices to attachment chips.
- [ ] Show embedded, OCR, truncated, resource-limited, and unavailable PDF states.
- [ ] Show included-page coverage in the OCR preview.
- [ ] Keep default chip/control copy compact and move secondary PDF detail behind preview/expand.
- [ ] Generalize image-only preparation copy.
- [ ] Translate and validate every shipped locale.

## Validation

- [ ] Preserve existing image OCR unit, integration, and packaged smoke behavior.
- [ ] Add textual, scanned, mixed-coverage, empty, over-100-page, output-limit, resource-limit, and
  cancellation PDF tests.
- [ ] Add deterministic packaged PDF OCR smoke.
- [ ] Run focused main and renderer tests after each slice.
- [ ] Run format, i18n, lint, typecheck, full tests, and production build.
- [ ] Run current-platform packaged smoke when prerequisites are available.
- [ ] Complete the final cross-module review and resolve findings.
- [ ] Update this checklist and the retained historical OCR specification.
- [ ] Commit the validated implementation and documentation locally.
- [ ] Do not push.
