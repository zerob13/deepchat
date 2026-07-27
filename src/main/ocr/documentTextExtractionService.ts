import { createHash } from 'node:crypto'
import { open } from 'node:fs/promises'
import { performance } from 'node:perf_hooks'

import runtimeVersions from '../../../resources/runtime-versions.json'
import {
  DocumentOcrTextAssembler,
  PDF_OCR_ARTIFACT_REVISION,
  PDF_OCR_GENERATION_MAX_TOKENS,
  PDF_OCR_STRATEGY,
  isDocumentOcrBudgetCompatible,
  isValidDocumentOcrArtifact,
  truncateDocumentOcrArtifact,
  type DocumentOcrArtifact,
  type DocumentOcrArtifactIdentity,
  type DocumentOcrArtifactValue
} from './documentOcrArtifact'
import type { DocumentOcrArtifactStorePort } from './ocrArtifactStore'
import {
  OcrExtractionScheduler,
  OcrSchedulerError,
  type OcrExtractionPriority
} from './ocrExtractionScheduler'
import {
  LIGHT_OCR_DOCUMENT_MAX_PAGES,
  LIGHT_OCR_DOCUMENT_MAX_PAGE_PIXELS,
  LIGHT_OCR_DOCUMENT_MAX_TOTAL_PIXELS,
  LIGHT_OCR_HELPER_MAX_INPUT_BYTES,
  type LightOcrBackendPreference,
  type LightOcrDocumentOptions,
  type LightOcrEngineStatus
} from './lightOcrProtocol'
import {
  LightOcrProcessHostError,
  type LightOcrPrepareInput,
  type LightOcrRecognizeDocumentInput,
  type LightOcrDocumentRecognitionOutcome
} from './lightOcrProcessHost'
import { OcrSourceSnapshotBudget, OcrSourceSnapshotBudgetError } from './ocrSourceSnapshotBudget'

const PDF_OCR_DPI = 150
const PDF_OCR_PAGE_RANGE = { start: 1, end: LIGHT_OCR_DOCUMENT_MAX_PAGES } as const
const SNAPSHOT_READ_CHUNK_BYTES = 1024 * 1024
const MAX_SOURCE_PAGE_COUNT_HINT = 1_000_000

export type DocumentTextExtractionErrorCode =
  | 'cancelled'
  | 'empty_input'
  | 'input_too_large'
  | 'invalid_input'
  | 'queue_full'
  | 'runtime_failure'
  | 'runtime_identity_mismatch'

export class DocumentTextExtractionError extends Error {
  constructor(
    readonly code: DocumentTextExtractionErrorCode,
    message: string,
    options?: ErrorOptions
  ) {
    super(message, options)
    this.name = 'DocumentTextExtractionError'
  }
}

export interface ImmutablePdfSnapshot {
  readonly bytes: Buffer
  readonly sourceSha256: string
}

export interface DocumentTextExtractionInput {
  readonly filePath: string
  readonly maxFileSize: number
  readonly backend: LightOcrBackendPreference
  readonly sourcePageCountHint?: number
  readonly generationTokenLimit?: number
  readonly priority?: OcrExtractionPriority
  readonly signal?: AbortSignal
}

export interface DocumentTextExtractionResult extends DocumentOcrArtifactValue {
  readonly cacheHit: boolean
  readonly timingMs: {
    readonly snapshot: number
    readonly recognition: number
    readonly total: number
  }
}

export interface DocumentTextExtractionPort {
  extractDocument(input: DocumentTextExtractionInput): Promise<DocumentTextExtractionResult>
}

export interface LightOcrDocumentRecognitionPort {
  prepare(input: LightOcrPrepareInput): Promise<LightOcrEngineStatus>
  recognizeDocument(
    input: LightOcrRecognizeDocumentInput
  ): Promise<LightOcrDocumentRecognitionOutcome>
}

export interface DocumentTextExtractionServiceOptions {
  readonly processHost: LightOcrDocumentRecognitionPort
  readonly artifactStore: DocumentOcrArtifactStorePort
  readonly scheduler?: OcrExtractionScheduler
  readonly closeSchedulerOnClose?: boolean
  readonly snapshotBudget?: OcrSourceSnapshotBudget
  readonly facadeVersion?: string
  readonly runtimeVersion?: string
  readonly nativeVersion?: string
  readonly modelVersion?: string
  readonly bundleId?: string
  readonly artifactRevision?: string
  readonly snapshotReader?: typeof readImmutablePdfSnapshot
  readonly onDiagnostic?: (event: { code: 'cache_read_failed' | 'cache_write_failed' }) => void
}

interface SharedDocumentExtractionFlight {
  readonly controller: AbortController
  readonly promise: Promise<DocumentTextExtractionResult>
  owners: number
  settled: boolean
}

export class DocumentTextExtractionService implements DocumentTextExtractionPort {
  private readonly scheduler: OcrExtractionScheduler
  private readonly closeSchedulerOnClose: boolean
  private readonly snapshotBudget: OcrSourceSnapshotBudget
  private readonly facadeVersion: string
  private readonly runtimeVersion: string
  private readonly nativeVersion: string
  private readonly modelVersion: string
  private readonly bundleId: string
  private readonly artifactRevision: string
  private readonly snapshotReader: typeof readImmutablePdfSnapshot
  private readonly flights = new Map<string, SharedDocumentExtractionFlight>()
  private closed = false

  constructor(private readonly options: DocumentTextExtractionServiceOptions) {
    this.scheduler = options.scheduler ?? new OcrExtractionScheduler()
    this.closeSchedulerOnClose = options.closeSchedulerOnClose ?? true
    this.snapshotBudget = options.snapshotBudget ?? new OcrSourceSnapshotBudget()
    this.facadeVersion = options.facadeVersion ?? runtimeVersions.lightOcr.facadeVersion
    this.runtimeVersion = options.runtimeVersion ?? runtimeVersions.lightOcr.runtimeVersion
    this.nativeVersion = options.nativeVersion ?? runtimeVersions.lightOcr.nativeVersion
    this.modelVersion = options.modelVersion ?? runtimeVersions.lightOcr.modelVersion
    this.bundleId = options.bundleId ?? runtimeVersions.lightOcr.bundleId
    this.artifactRevision = options.artifactRevision ?? PDF_OCR_ARTIFACT_REVISION
    this.snapshotReader = options.snapshotReader ?? readImmutablePdfSnapshot
  }

  async extractDocument(input: DocumentTextExtractionInput): Promise<DocumentTextExtractionResult> {
    this.assertOpen()
    const generationTokenLimit = normalizeGenerationTokenLimit(input.generationTokenLimit)
    const sourcePageCountHint = normalizeSourcePageCountHint(input.sourcePageCountHint)
    const effectiveMaxFileBytes = normalizeDocumentSourceByteLimit(input.maxFileSize)
    const startedAt = performance.now()
    const snapshotStartedAt = performance.now()
    const snapshot = await this.snapshotReader({
      filePath: input.filePath,
      maxFileSize: effectiveMaxFileBytes,
      signal: input.signal
    })
    const snapshotMs = performance.now() - snapshotStartedAt
    this.assertOpen()
    this.reserveSnapshot(snapshot)
    try {
      const result = await this.extractSnapshot(snapshot, {
        ...input,
        sourcePageCountHint,
        generationTokenLimit,
        maxFileBytes: effectiveMaxFileBytes
      })
      return {
        ...result,
        timingMs: {
          ...result.timingMs,
          snapshot: snapshotMs,
          total: performance.now() - startedAt
        }
      }
    } finally {
      this.snapshotBudget.release(snapshot.bytes.byteLength)
    }
  }

  close(): void {
    if (this.closed) return
    this.closed = true
    for (const flight of this.flights.values()) flight.controller.abort()
    if (this.closeSchedulerOnClose) this.scheduler.close()
  }

  hasActiveExtractions(): boolean {
    return this.flights.size > 0
  }

  private extractSnapshot(
    snapshot: ImmutablePdfSnapshot,
    input: DocumentTextExtractionInput & {
      generationTokenLimit: number
      maxFileBytes: number
    }
  ): Promise<DocumentTextExtractionResult> {
    if (input.signal?.aborted) return Promise.reject(cancelledError())
    const flightKey = JSON.stringify([
      snapshot.sourceSha256,
      this.facadeVersion,
      this.runtimeVersion,
      this.nativeVersion,
      this.modelVersion,
      this.bundleId,
      this.artifactRevision,
      input.backend,
      input.maxFileBytes,
      input.generationTokenLimit,
      input.sourcePageCountHint
    ])
    let flight = this.flights.get(flightKey)
    if (!flight) {
      const controller = new AbortController()
      const promise = this.scheduler.schedule(
        () =>
          this.runExtraction(
            snapshot,
            input.backend,
            input.maxFileBytes,
            input.generationTokenLimit,
            input.sourcePageCountHint,
            controller.signal
          ),
        input.priority ?? 'interactive',
        controller.signal
      )
      flight = { controller, promise, owners: 0, settled: false }
      this.flights.set(flightKey, flight)
      promise.then(
        () => this.finishFlight(flightKey, flight!),
        () => this.finishFlight(flightKey, flight!)
      )
    }
    return this.joinFlight(flightKey, flight, input.signal)
  }

  private async runExtraction(
    snapshot: ImmutablePdfSnapshot,
    backend: LightOcrBackendPreference,
    maxFileBytes: number,
    generationTokenLimit: number,
    sourcePageCountHint: number | undefined,
    signal: AbortSignal
  ): Promise<DocumentTextExtractionResult> {
    const startedAt = performance.now()
    const recognitionStartedAt = performance.now()
    let preparedEngine: LightOcrEngineStatus
    try {
      preparedEngine = await this.options.processHost.prepare({
        backend,
        strategy: PDF_OCR_STRATEGY,
        signal
      })
    } catch (error) {
      throw normalizeRuntimeError(error)
    }
    assertEngineIdentity(preparedEngine, {
      bundleId: this.bundleId,
      backend,
      strategy: PDF_OCR_STRATEGY
    })

    const documentOptions = createDocumentOptions(maxFileBytes)
    const identity = createDocumentArtifactIdentity(
      snapshot.sourceSha256,
      preparedEngine,
      documentOptions,
      {
        facadeVersion: this.facadeVersion,
        runtimeVersion: this.runtimeVersion,
        nativeVersion: this.nativeVersion,
        modelVersion: this.modelVersion,
        bundleId: this.bundleId,
        artifactRevision: this.artifactRevision,
        backend
      }
    )
    const cached = await this.findCachedArtifact(identity)
    if (cached && isDocumentOcrBudgetCompatible(cached, generationTokenLimit)) {
      const bounded = withSourcePageCountHint(
        truncateDocumentOcrArtifact(cached, generationTokenLimit),
        sourcePageCountHint
      )
      if (!isValidDocumentOcrArtifact(bounded, identity)) {
        throw new DocumentTextExtractionError(
          'runtime_identity_mismatch',
          'Cached document OCR coverage is invalid after budget application'
        )
      }
      return resultFromArtifact(bounded, true, {
        recognition: performance.now() - recognitionStartedAt,
        total: performance.now() - startedAt
      })
    }

    const assembler = new DocumentOcrTextAssembler(
      documentOptions.pageRange.start,
      generationTokenLimit
    )
    let outcome: LightOcrDocumentRecognitionOutcome
    try {
      outcome = await this.options.processHost.recognizeDocument({
        encoded: snapshot.bytes,
        backend,
        strategy: PDF_OCR_STRATEGY,
        options: documentOptions,
        signal,
        onPage: (page) => assembler.append(page)
      })
    } catch (error) {
      throw normalizeRuntimeError(error)
    }
    assertEngineIdentity(outcome.engine, {
      bundleId: this.bundleId,
      backend,
      strategy: PDF_OCR_STRATEGY
    })
    if (!hasSameExecutionIdentity(preparedEngine, outcome.engine)) {
      throw new DocumentTextExtractionError(
        'runtime_identity_mismatch',
        'Document OCR execution identity changed after cache lookup'
      )
    }

    const assembled = assembler.snapshot()
    if (
      assembled.truncated !== outcome.generationOutputLimitReached ||
      outcome.emittedPages < assembled.pageSpans.length ||
      (!outcome.generationOutputLimitReached && outcome.emittedPages !== assembled.pageSpans.length)
    ) {
      throw new DocumentTextExtractionError(
        'runtime_identity_mismatch',
        'Document OCR stream coverage does not match its terminal accounting'
      )
    }

    const value: DocumentOcrArtifactValue = {
      text: assembled.text,
      tokenCount: assembled.tokenCount,
      pageSpans: assembled.pageSpans,
      artifactTermination: outcome.artifactTermination,
      generationOutputLimitReached: outcome.generationOutputLimitReached,
      generationTokenLimit,
      emittedPages: outcome.emittedPages,
      ...(sourcePageCountHint ? { sourcePageCountHint } : {}),
      ...(outcome.resourceLimit ? { resourceLimit: { ...outcome.resourceLimit } } : {}),
      engine: structuredClone(outcome.engine)
    }
    if (!isValidDocumentOcrArtifact(value, identity)) {
      throw new DocumentTextExtractionError(
        'runtime_identity_mismatch',
        'Document OCR produced an invalid cache artifact'
      )
    }
    await this.storeArtifact(identity, value)
    return resultFromArtifact(value, false, {
      recognition: performance.now() - recognitionStartedAt,
      total: performance.now() - startedAt
    })
  }

  private async findCachedArtifact(
    identity: DocumentOcrArtifactIdentity
  ): Promise<DocumentOcrArtifact | null> {
    try {
      return await this.options.artifactStore.findDocument(identity)
    } catch {
      this.emitDiagnostic('cache_read_failed')
      return null
    }
  }

  private async storeArtifact(
    identity: DocumentOcrArtifactIdentity,
    value: DocumentOcrArtifactValue
  ): Promise<void> {
    try {
      await this.options.artifactStore.putDocument(identity, value)
    } catch {
      this.emitDiagnostic('cache_write_failed')
    }
  }

  private joinFlight(
    flightKey: string,
    flight: SharedDocumentExtractionFlight,
    signal?: AbortSignal
  ): Promise<DocumentTextExtractionResult> {
    flight.owners += 1
    return new Promise<DocumentTextExtractionResult>((resolve, reject) => {
      let finished = false
      const finish = () => {
        if (finished) return
        finished = true
        if (signal) signal.removeEventListener('abort', onAbort)
        flight.owners -= 1
        if (flight.owners === 0 && !flight.settled) {
          flight.controller.abort()
          if (this.flights.get(flightKey) === flight) this.flights.delete(flightKey)
        }
      }
      const onAbort = () => {
        finish()
        reject(cancelledError())
      }
      if (signal) signal.addEventListener('abort', onAbort, { once: true })
      if (signal?.aborted) {
        onAbort()
        return
      }
      flight.promise.then(
        (value) => {
          if (!finished) resolve(cloneExtractionResult(value))
          finish()
        },
        (error) => {
          if (!finished) reject(normalizeRuntimeError(error))
          finish()
        }
      )
    })
  }

  private finishFlight(key: string, flight: SharedDocumentExtractionFlight): void {
    flight.settled = true
    if (this.flights.get(key) === flight) this.flights.delete(key)
  }

  private emitDiagnostic(code: 'cache_read_failed' | 'cache_write_failed'): void {
    try {
      this.options.onDiagnostic?.({ code })
    } catch {
      // Diagnostics are best-effort and must not change attachment preparation semantics.
    }
  }

  private reserveSnapshot(snapshot: ImmutablePdfSnapshot): void {
    try {
      this.snapshotBudget.reserve(snapshot.bytes.byteLength)
    } catch (error) {
      if (!(error instanceof OcrSourceSnapshotBudgetError)) throw error
      throw new DocumentTextExtractionError(
        'queue_full',
        'OCR extraction queue has reached its source snapshot limit'
      )
    }
  }

  private assertOpen(): void {
    if (this.closed) throw new Error('Document text extraction service is closed')
  }
}

export async function readImmutablePdfSnapshot(input: {
  readonly filePath: string
  readonly maxFileSize: number
  readonly signal?: AbortSignal
}): Promise<ImmutablePdfSnapshot> {
  const byteLimit = normalizeDocumentSourceByteLimit(input.maxFileSize)
  throwIfAborted(input.signal)
  let handle
  try {
    handle = await open(input.filePath, 'r')
  } catch (error) {
    throw new DocumentTextExtractionError('invalid_input', 'Unable to open PDF OCR input', {
      cause: error
    })
  }

  try {
    const fileStat = await handle.stat()
    if (!fileStat.isFile()) {
      throw new DocumentTextExtractionError('invalid_input', 'PDF OCR input must be a regular file')
    }
    if (fileStat.size > byteLimit) throwInputTooLarge()

    const chunks: Buffer[] = []
    let bytesReadTotal = 0
    while (true) {
      throwIfAborted(input.signal)
      const readSize = Math.min(SNAPSHOT_READ_CHUNK_BYTES, byteLimit + 1 - bytesReadTotal)
      const chunk = Buffer.allocUnsafe(readSize)
      const { bytesRead } = await handle.read(chunk, 0, readSize, bytesReadTotal)
      if (bytesRead === 0) break
      bytesReadTotal += bytesRead
      if (bytesReadTotal > byteLimit) throwInputTooLarge()
      chunks.push(chunk.subarray(0, bytesRead))
    }

    if (bytesReadTotal === 0) {
      throw new DocumentTextExtractionError('empty_input', 'PDF OCR input is empty')
    }
    const bytes = Buffer.concat(chunks, bytesReadTotal)
    return {
      bytes,
      sourceSha256: createHash('sha256').update(bytes).digest('hex')
    }
  } finally {
    await handle.close()
  }
}

export function normalizeDocumentSourceByteLimit(maxFileSize: number): number {
  if (!Number.isFinite(maxFileSize) || maxFileSize <= 0) {
    throw new DocumentTextExtractionError('input_too_large', 'PDF OCR source byte limit is invalid')
  }
  return Math.min(Math.floor(maxFileSize), LIGHT_OCR_HELPER_MAX_INPUT_BYTES)
}

function createDocumentOptions(maxFileBytes: number): LightOcrDocumentOptions {
  return {
    dpi: PDF_OCR_DPI,
    pageRange: { ...PDF_OCR_PAGE_RANGE },
    maxPages: LIGHT_OCR_DOCUMENT_MAX_PAGES,
    maxFileBytes,
    maxPagePixels: LIGHT_OCR_DOCUMENT_MAX_PAGE_PIXELS,
    maxTotalPixels: LIGHT_OCR_DOCUMENT_MAX_TOTAL_PIXELS
  }
}

function createDocumentArtifactIdentity(
  sourceSha256: string,
  engine: LightOcrEngineStatus,
  documentOptions: LightOcrDocumentOptions,
  versions: {
    facadeVersion: string
    runtimeVersion: string
    nativeVersion: string
    modelVersion: string
    bundleId: string
    artifactRevision: string
    backend: LightOcrBackendPreference
  }
): DocumentOcrArtifactIdentity {
  return {
    sourceSha256,
    facadeVersion: versions.facadeVersion,
    runtimeVersion: versions.runtimeVersion,
    nativeVersion: versions.nativeVersion,
    modelVersion: versions.modelVersion,
    bundleId: versions.bundleId,
    artifactRevision: versions.artifactRevision,
    strategy: PDF_OCR_STRATEGY,
    requestedBackend: versions.backend,
    detectionProviderChain: [...engine.detection.actualProviderChain],
    detectionPrecision: engine.detection.precision,
    recognitionProviderChain: [...engine.recognition.actualProviderChain],
    recognitionPrecision: engine.recognition.precision,
    dpi: documentOptions.dpi,
    pageRangeStart: documentOptions.pageRange.start,
    pageRangeEnd: documentOptions.pageRange.end,
    maxPages: documentOptions.maxPages,
    maxFileBytes: documentOptions.maxFileBytes,
    maxPagePixels: documentOptions.maxPagePixels,
    maxTotalPixels: documentOptions.maxTotalPixels
  }
}

function resultFromArtifact(
  artifact: DocumentOcrArtifactValue,
  cacheHit: boolean,
  timing: Omit<DocumentTextExtractionResult['timingMs'], 'snapshot'>
): DocumentTextExtractionResult {
  return {
    ...structuredClone(artifact),
    cacheHit,
    timingMs: { snapshot: 0, ...timing }
  }
}

function withSourcePageCountHint(
  artifact: DocumentOcrArtifactValue,
  sourcePageCountHint: number | undefined
): DocumentOcrArtifactValue {
  const { sourcePageCountHint: _cachedHint, ...withoutHint } = artifact
  return {
    ...withoutHint,
    ...(sourcePageCountHint ? { sourcePageCountHint } : {})
  }
}

function assertEngineIdentity(
  engine: LightOcrEngineStatus,
  expected: {
    bundleId: string
    backend: LightOcrBackendPreference
    strategy: typeof PDF_OCR_STRATEGY
  }
): void {
  if (
    engine.modelBundleId !== expected.bundleId ||
    engine.requestedProvider !== expected.backend ||
    engine.strategy !== expected.strategy
  ) {
    throw new DocumentTextExtractionError(
      'runtime_identity_mismatch',
      'Document OCR runtime configuration does not match the requested identity'
    )
  }
}

function hasSameExecutionIdentity(
  left: LightOcrEngineStatus,
  right: LightOcrEngineStatus
): boolean {
  return (
    sameStringArray(left.detection.actualProviderChain, right.detection.actualProviderChain) &&
    left.detection.precision === right.detection.precision &&
    sameStringArray(left.recognition.actualProviderChain, right.recognition.actualProviderChain) &&
    left.recognition.precision === right.recognition.precision
  )
}

function normalizeRuntimeError(error: unknown): Error {
  if (error instanceof DocumentTextExtractionError) return error
  if (error instanceof LightOcrProcessHostError) {
    return error.code === 'cancelled' ? cancelledError() : error
  }
  if (error instanceof OcrSchedulerError && error.code === 'cancelled') return cancelledError()
  if (error instanceof OcrSchedulerError && error.code === 'queue_full') {
    return new DocumentTextExtractionError('queue_full', 'OCR extraction queue is full')
  }
  return new DocumentTextExtractionError('runtime_failure', 'Document OCR extraction failed', {
    cause: error
  })
}

function normalizeGenerationTokenLimit(value: number | undefined): number {
  const limit = value ?? PDF_OCR_GENERATION_MAX_TOKENS
  if (!Number.isSafeInteger(limit) || limit <= 0 || limit > PDF_OCR_GENERATION_MAX_TOKENS) {
    throw new DocumentTextExtractionError(
      'runtime_identity_mismatch',
      'Document OCR generation token limit is invalid'
    )
  }
  return limit
}

function normalizeSourcePageCountHint(value: number | undefined): number | undefined {
  if (value === undefined) return undefined
  if (!Number.isSafeInteger(value) || value <= 0 || value > MAX_SOURCE_PAGE_COUNT_HINT) {
    throw new DocumentTextExtractionError('invalid_input', 'PDF source page count hint is invalid')
  }
  return value
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw cancelledError()
}

function throwInputTooLarge(): never {
  throw new DocumentTextExtractionError(
    'input_too_large',
    'PDF OCR input exceeds the source byte limit'
  )
}

function cancelledError(): DocumentTextExtractionError {
  return new DocumentTextExtractionError('cancelled', 'Document OCR extraction was cancelled')
}

function cloneExtractionResult(result: DocumentTextExtractionResult): DocumentTextExtractionResult {
  return structuredClone(result)
}

function sameStringArray(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index])
}
