/**
 * Pure OCR coordinate extraction and trigger-state helpers.
 *
 * This module deliberately knows nothing about Electron, the screen capture
 * source, or the location API.  A caller can feed it one OCR frame at a time
 * and decide what to do with a `candidate` result whose `ready` flag is true.
 * The caller must acknowledge an attempted teleport with `markSucceeded` or
 * `markFailed`; until then the detector will not emit the same attempt again.
 */

export interface Coordinate {
  lat: number
  lng: number
}

export type CoordinateCandidate = Coordinate

export interface CoordinateDedupeOptions {
  /** Decimal places used for the inexpensive canonical-key comparison. */
  roundDecimals?: number
  /** Coordinates this close are considered the same GPS point. */
  distanceMeters?: number
}

export interface CoordinateConfidenceOptions {
  /** Minimum Vision/OCR confidence when a frame supplies confidence data. */
  minConfidence?: number
  /** Reject structured OCR entries that do not carry confidence metadata. */
  requireConfidence?: boolean
}

export const DEFAULT_ROUND_DECIMALS = 5
export const DEFAULT_DEDUPE_DISTANCE_METERS = 20
export const DEFAULT_STABILITY_FRAMES = 2
export const DEFAULT_MIN_INTERVAL_MS = 500
export const DEFAULT_MIN_CONFIDENCE = 0.9
export const CONTINUOUS_QUEUE_LIMIT = 24

/** True only for finite GPS coordinates in the usual lat/lng order. */
export function isValidCoordinate(coordinate: Coordinate | null | undefined): coordinate is Coordinate {
  if (!coordinate) return false
  return Number.isFinite(coordinate.lat) && coordinate.lat >= -90 && coordinate.lat <= 90
    && Number.isFinite(coordinate.lng) && coordinate.lng >= -180 && coordinate.lng <= 180
}

function normalizeDecimals(value: number | undefined, fallback: number): number {
  if (value === undefined) return fallback
  if (!Number.isFinite(value)) return fallback
  return Math.max(0, Math.min(12, Math.floor(value)))
}

function roundNumber(value: number, decimals: number): number {
  if (!Number.isFinite(value)) return value
  const factor = 10 ** decimals
  const rounded = Math.round(value * factor) / factor
  // Avoid carrying negative zero into keys, JSON, or the UI.
  return Object.is(rounded, -0) ? 0 : rounded
}

/** Return a stable, display-safe rounded copy of a coordinate. */
export function roundCoordinate(coordinate: Coordinate, decimals = DEFAULT_ROUND_DECIMALS): Coordinate {
  const places = normalizeDecimals(decimals, DEFAULT_ROUND_DECIMALS)
  return {
    lat: roundNumber(coordinate.lat, places),
    lng: roundNumber(coordinate.lng, places),
  }
}

/** Return the rounded coordinate key used for fast duplicate checks. */
export function coordinateKey(coordinate: Coordinate, decimals = DEFAULT_ROUND_DECIMALS): string {
  const rounded = roundCoordinate(coordinate, decimals)
  return `${rounded.lat.toFixed(normalizeDecimals(decimals, DEFAULT_ROUND_DECIMALS))},${rounded.lng.toFixed(normalizeDecimals(decimals, DEFAULT_ROUND_DECIMALS))}`
}

/**
 * Great-circle distance in metres.  Longitude deltas are wrapped so points
 * either side of the +/-180 meridian compare correctly.
 */
export function distanceMeters(a: Coordinate, b: Coordinate): number {
  const radians = Math.PI / 180
  const lat1 = a.lat * radians
  const lat2 = b.lat * radians
  const dLat = (b.lat - a.lat) * radians
  const rawLngDelta = b.lng - a.lng
  const wrappedLngDelta = ((rawLngDelta + 540) % 360) - 180
  const dLng = wrappedLngDelta * radians
  const sinLat = Math.sin(dLat / 2)
  const sinLng = Math.sin(dLng / 2)
  const h = sinLat * sinLat + Math.cos(lat1) * Math.cos(lat2) * sinLng * sinLng
  return 2 * 6371008.8 * Math.asin(Math.min(1, Math.sqrt(h)))
}

/** Alias that reads naturally at call sites and in tests. */
export const haversineDistanceMeters = distanceMeters

export function coordinatesWithinDistance(a: Coordinate, b: Coordinate, meters: number): boolean {
  if (!isValidCoordinate(a) || !isValidCoordinate(b)) return false
  if (!Number.isFinite(meters) || meters < 0) return false
  return distanceMeters(a, b) <= meters
}

/** Alias for consumers that want a semantic equality check. */
export function coordinatesEqual(
  a: Coordinate,
  b: Coordinate,
  options: CoordinateDedupeOptions = {},
): boolean {
  if (!isValidCoordinate(a) || !isValidCoordinate(b)) return false
  const decimals = normalizeDecimals(options.roundDecimals, DEFAULT_ROUND_DECIMALS)
  const distance = options.distanceMeters ?? DEFAULT_DEDUPE_DISTANCE_METERS
  return coordinateKey(a, decimals) === coordinateKey(b, decimals)
    || coordinatesWithinDistance(a, b, distance)
}

/**
 * Stable, order-preserving coordinate de-duplication.
 *
 * Rounding handles OCR's tiny last-digit variations cheaply; the distance
 * check also collapses nearby variants that happen to cross a rounding
 * boundary.  The first occurrence is retained so a caller gets deterministic
 * values to send to the location backend.
 */
export function dedupeCoordinates(
  coordinates: readonly Coordinate[],
  options: CoordinateDedupeOptions = {},
): Coordinate[] {
  const decimals = normalizeDecimals(options.roundDecimals, DEFAULT_ROUND_DECIMALS)
  const distance = options.distanceMeters ?? DEFAULT_DEDUPE_DISTANCE_METERS
  const result: Coordinate[] = []
  const keys = new Set<string>()

  for (const coordinate of coordinates) {
    if (!isValidCoordinate(coordinate)) continue
    const key = coordinateKey(coordinate, decimals)
    if (keys.has(key)) continue
    if (result.some((existing) => coordinatesWithinDistance(existing, coordinate, distance))) continue
    keys.add(key)
    result.push({ lat: coordinate.lat, lng: coordinate.lng })
  }
  return result
}

// Decimal is required on both numbers.  The separator deliberately permits
// labels/newlines/CJK and signs that are not part of a number, while stopping
// before the next decimal token.  Using a fresh RegExp in the function keeps
// parsing free of shared `lastIndex` state and therefore safe for concurrent
// OCR calls.
const COORD_DECIMAL_RE_SOURCE = '(?<![\\d.])([+-]?\\d+\\.\\d+)(?![\\d.])(?:(?![+-]?\\d+\\.\\d+)[^\\d.])*?([+-]?\\d+\\.\\d+)(?![\\d.])'

/**
 * Extract every decimal lat,lng pair from arbitrary OCR text.
 *
 * Integer-only pairs are intentionally ignored: OCR labels and list numbers
 * otherwise create too many false positives for an automatic trigger.  Each
 * pair is range-checked independently; an invalid pair does not prevent later
 * valid pairs in the same OCR frame from being returned.
 */
export interface OcrCoordinateCandidate extends Partial<Coordinate> {
  latitude?: number
  longitude?: number
  text?: string
  confidence?: number
  boundingBox?: number[]
}

export interface OcrTextLine {
  text: string
  confidence?: number
  boundingBox?: number[]
}

export type OcrTextPart = string | OcrTextLine | OcrCoordinateCandidate
export type OcrText = string | readonly (OcrTextPart | null | undefined)[] | null | undefined

function normalizeConfidence(value: number | undefined, fallback: number): number {
  if (value === undefined) return fallback
  if (!Number.isFinite(value)) return fallback
  return Math.max(0, Math.min(1, value))
}

function passesConfidence(
  confidence: number | undefined,
  options: CoordinateConfidenceOptions,
): boolean {
  if (confidence === undefined) return options.requireConfidence !== true
  return Number.isFinite(confidence) && confidence >= 0 && confidence <= 1
    && confidence >= normalizeConfidence(options.minConfidence, DEFAULT_MIN_CONFIDENCE)
}

function parseCoordinateText(
  raw: string,
  options: CoordinateConfidenceOptions = {},
  confidence?: number,
): Coordinate[] {
  // NFKC covers full-width OCR digits/punctuation; the explicit replacements
  // cover common Vision outputs for a Unicode minus sign.
  const text = raw.normalize('NFKC').replace(/[−﹣－]/g, '-')
  if (text.length === 0 || !passesConfidence(confidence, options)) return []
  const matcher = new RegExp(COORD_DECIMAL_RE_SOURCE, 'g')
  const candidates: Coordinate[] = []
  let match: RegExpExecArray | null
  while ((match = matcher.exec(text)) !== null) {
    const coordinate = { lat: Number(match[1]), lng: Number(match[2]) }
    if (isValidCoordinate(coordinate)) candidates.push(coordinate)
  }
  return candidates
}

function coordinateFromOcrCandidate(part: OcrCoordinateCandidate): Coordinate | undefined {
  const lat = typeof part.lat === 'number' ? part.lat : part.latitude
  const lng = typeof part.lng === 'number' ? part.lng : part.longitude
  if (lat === undefined || lng === undefined) return undefined
  const coordinate = { lat, lng }
  return isValidCoordinate(coordinate) ? coordinate : undefined
}

export function parseCoordinateCandidates(
  raw: OcrText,
  options: CoordinateConfidenceOptions = {},
): Coordinate[] {
  if (typeof raw === 'string') return parseCoordinateText(raw, options)
  if (!Array.isArray(raw)) return []

  const candidates: Coordinate[] = []
  const plainTextParts: string[] = []
  for (const part of raw) {
    if (typeof part === 'string') {
      plainTextParts.push(part)
      continue
    }
    if (!part || typeof part !== 'object') continue
    const ocrPart = part as OcrCoordinateCandidate
    const direct = coordinateFromOcrCandidate(ocrPart)
    if (direct) {
      if (passesConfidence(ocrPart.confidence, options)) candidates.push(direct)
      continue
    }
    if (typeof ocrPart.text === 'string') {
      candidates.push(...parseCoordinateText(ocrPart.text, options, ocrPart.confidence))
    }
  }

  // Arrays of plain OCR lines are joined so a pair split by a line break is
  // still recognized; structured lines are parsed individually so their
  // confidence scores cannot leak into neighbouring text.
  if (plainTextParts.length > 0) {
    candidates.push(...parseCoordinateText(plainTextParts.join('\n'), options))
  }
  return candidates
}

/**
 * Parse and de-duplicate all candidates in one call.  The lower-level
 * `parseCoordinateCandidates` export intentionally keeps duplicate OCR hits;
 * this convenience API is what frame-based integrations normally want.
 */
export function parseAllCoordinates(
  raw: OcrText,
  options: CoordinateDedupeOptions & CoordinateConfidenceOptions = {},
): Coordinate[] {
  return dedupeCoordinates(parseCoordinateCandidates(raw, options), options)
}

// These aliases keep the small core convenient for both browser code and
// Electron-side adapters without making callers depend on one naming style.
export const parseCoordinates = parseAllCoordinates
export const parseGpsCandidates = parseAllCoordinates

export interface CoordinateDetectorOptions extends CoordinateDedupeOptions, CoordinateConfidenceOptions {
  /** Number of consecutive matching frames needed before an attempt. */
  stabilityFrames?: number
  /** Process the first stable coordinate from a multi-coordinate frame. */
  continuous?: boolean
  /** Minimum time between emitted attempts, regardless of success/failure. */
  minIntervalMs?: number
  /** Optional clock used only when `observe` receives no timestamp. */
  clock?: () => number
}

export type CoordinateDetectorStatus = 'baseline' | 'none' | 'candidate' | 'ambiguous' | 'throttled'

export type CoordinateDetectorPhase = 'baseline' | 'empty' | 'pending' | 'ready'
  | 'awaiting_result' | 'seen' | 'ambiguous' | 'throttled'

export interface CoordinateDetectorFrameResult {
  /**
   * Small adapter-facing status set: `candidate` is emitted only after the
   * required consecutive frames and is safe to hand to the teleport adapter.
   * `none` includes empty, pending, already-seen, and awaiting-result frames.
   */
  status: CoordinateDetectorStatus
  /** More detailed state; `status` stays within the small UI adapter contract. */
  phase: CoordinateDetectorPhase
  /** All valid, distance/round de-duplicated coordinates in this frame. */
  candidates: Coordinate[]
  /** Candidates not already seen or awaiting a result. */
  newCandidates: Coordinate[]
  /** Stable candidate when phase is pending/ready/awaiting_result. */
  coordinate?: Coordinate
  /** Number of consecutive frames matching `coordinate`. */
  stableFrames: number
  /** True only when this frame may be sent to the teleport adapter. */
  ready: boolean
  /** Present when `ready` is true; pass it to markSucceeded/markFailed. */
  attemptId?: number
  /** Present on `throttled`; useful for a countdown in UI. */
  nextAllowedAtMs?: number
  /** Human-readable-free machine reason for adapters/logging. */
  reason?: 'initial_baseline' | 'no_candidates' | 'already_seen' | 'candidate_pending'
    | 'multiple_new_candidates' | 'min_interval' | 'awaiting_result' | 'queue_overflow'
  /** Number of candidates discarded because the continuous FIFO was full. */
  droppedCount: number
}

export interface CoordinateDetectorSnapshot {
  initialized: boolean
  seen: Coordinate[]
  pending?: Coordinate
  pendingFrames: number
  inFlight?: { attemptId: number; coordinate: Coordinate }
  queued: Coordinate[]
  droppedCount: number
  lastAttemptAtMs?: number
  nextAllowedAtMs?: number
}

function finiteTimestamp(value: number, label: string): number {
  if (!Number.isFinite(value)) throw new RangeError(`${label} must be a finite number`)
  return value
}

function cloneCoordinate(coordinate: Coordinate): Coordinate {
  return { lat: coordinate.lat, lng: coordinate.lng }
}

/**
 * Stateful, side-effect-free detector.  It only mutates its private state;
 * it never reads the clipboard, captures a screen, calls an API, or writes
 * storage.  Those effects stay in the UI/Electron integration layer.
 */
export class CoordinateAutoDetector {
  readonly options: Required<Pick<CoordinateDetectorOptions, 'stabilityFrames' | 'roundDecimals' | 'distanceMeters' | 'minIntervalMs' | 'minConfidence' | 'requireConfidence' | 'continuous'>>

  private readonly clock: () => number
  private initialized = false
  private seen: Coordinate[] = []
  private pending?: Coordinate
  private pendingFrames = 0
  private inFlight?: { attemptId: number; coordinate: Coordinate }
  private continuousPending: Array<{ coordinate: Coordinate; frames: number; lastFrame: number }> = []
  private continuousQueue: Coordinate[] = []
  private continuousFrame = 0
  private continuousDropped = 0
  private nextAttemptId = 1
  private lastAttemptAtMs?: number
  private nextAllowedAtMs = Number.NEGATIVE_INFINITY

  constructor(options: CoordinateDetectorOptions = {}) {
    const requestedStabilityFrames = options.stabilityFrames ?? DEFAULT_STABILITY_FRAMES
    if (!Number.isFinite(requestedStabilityFrames) || requestedStabilityFrames < 2) {
      throw new RangeError('stabilityFrames must be a finite number >= 2')
    }
    const stabilityFrames = Math.floor(requestedStabilityFrames)
    const minIntervalMs = options.minIntervalMs ?? DEFAULT_MIN_INTERVAL_MS
    const distanceMetersOption = options.distanceMeters ?? DEFAULT_DEDUPE_DISTANCE_METERS
    const minConfidence = options.minConfidence ?? DEFAULT_MIN_CONFIDENCE
    if (!Number.isFinite(minConfidence) || minConfidence < 0 || minConfidence > 1) {
      throw new RangeError('minConfidence must be a number between 0 and 1')
    }
    if (!Number.isFinite(minIntervalMs) || minIntervalMs < 0) {
      throw new RangeError('minIntervalMs must be a finite non-negative number')
    }
    if (!Number.isFinite(distanceMetersOption) || distanceMetersOption < 0) {
      throw new RangeError('distanceMeters must be a finite non-negative number')
    }
    this.options = {
      stabilityFrames,
      roundDecimals: normalizeDecimals(options.roundDecimals, DEFAULT_ROUND_DECIMALS),
      distanceMeters: distanceMetersOption,
      minIntervalMs,
      minConfidence,
      requireConfidence: options.requireConfidence ?? false,
      continuous: options.continuous ?? false,
    }
    this.clock = options.clock ?? (() => Date.now())
  }

  /** Feed one OCR frame and get a pure decision object. */
  observe(raw: OcrText, nowMs?: number): CoordinateDetectorFrameResult {
    const now = finiteTimestamp(nowMs ?? this.clock(), 'nowMs')
    const candidates = parseAllCoordinates(raw, this.options)

    if (!this.initialized) {
      // An empty OCR frame is not a baseline: the first useful frame may be
      // delayed while ScreenCaptureKit/Vision warms up.  Establishing the
      // baseline only once candidates are present prevents those first visible
      // coordinates from being mistaken for newly scrolled-in coordinates.
      if (candidates.length === 0) {
        return this.result('none', 'empty', candidates, [], {
          reason: 'no_candidates',
        })
      }
      this.initialized = true
      // Existing on-screen text is the baseline.  Marking it seen also means
      // scrolling it out and back in cannot unexpectedly teleport again.
      this.seen = candidates.map(cloneCoordinate)
      this.clearPending()
      return this.result('baseline', 'baseline', candidates, [], {
        reason: 'initial_baseline',
      })
    }

    if (this.options.continuous) {
      return this.observeContinuous(candidates, now)
    }

    if (this.inFlight) {
      const current = this.inFlight.coordinate
      const matching = candidates.find((candidate) => this.isSame(candidate, current))
      return this.result('none', 'awaiting_result', candidates, this.newCandidates(candidates), {
        coordinate: matching ?? current,
        stableFrames: this.pendingFrames,
        attemptId: this.inFlight.attemptId,
        reason: 'awaiting_result',
      })
    }

    const newCandidates = this.newCandidates(candidates)
    if (newCandidates.length > 1 && !this.options.continuous) {
      this.clearPending()
      return this.result('ambiguous', 'ambiguous', candidates, newCandidates, {
        reason: 'multiple_new_candidates',
      })
    }

    if (newCandidates.length === 0) {
      this.clearPending()
      return this.result('none', candidates.length === 0 ? 'empty' : 'seen', candidates, [], {
        reason: candidates.length === 0 ? 'no_candidates' : 'already_seen',
      })
    }

    const candidate = newCandidates[0]
    if (!this.pending || !this.isSame(this.pending, candidate)) {
      this.pending = cloneCoordinate(candidate)
      this.pendingFrames = 1
    } else {
      this.pendingFrames += 1
    }

    if (this.pendingFrames < this.options.stabilityFrames) {
      return this.result('none', 'pending', candidates, newCandidates, {
        coordinate: this.pending,
        stableFrames: this.pendingFrames,
        reason: 'candidate_pending',
      })
    }

    if (now < this.nextAllowedAtMs) {
      return this.result('throttled', 'throttled', candidates, newCandidates, {
        coordinate: this.pending,
        stableFrames: this.pendingFrames,
        nextAllowedAtMs: this.nextAllowedAtMs,
        reason: 'min_interval',
      })
    }

    const attemptId = this.nextAttemptId++
    const coordinate = cloneCoordinate(this.pending)
    this.inFlight = { attemptId, coordinate }
    this.lastAttemptAtMs = now
    this.nextAllowedAtMs = now + this.options.minIntervalMs
    return this.result('candidate', 'ready', candidates, newCandidates, {
      coordinate,
      stableFrames: this.pendingFrames,
      attemptId,
    })
  }

  /** Alias for adapters that call each OCR sample a frame. */
  processFrame(raw: OcrText, nowMs?: number): CoordinateDetectorFrameResult {
    return this.observe(raw, nowMs)
  }

  /** Additional neutral names for browser/Electron frame adapters. */
  ingestFrame(raw: OcrText, nowMs?: number): CoordinateDetectorFrameResult {
    return this.observe(raw, nowMs)
  }

  feed(raw: OcrText, nowMs?: number): CoordinateDetectorFrameResult {
    return this.observe(raw, nowMs)
  }

  /** Mark an emitted attempt as delivered; successful coordinates become seen. */
  recordSuccess(attempt: number | Coordinate, nowMs?: number): boolean {
    const now = finiteTimestamp(nowMs ?? this.clock(), 'nowMs')
    const flight = this.matchFlight(attempt)
    if (!flight) return false
    this.seen = this.mergeSeen(this.seen, flight.coordinate)
    this.inFlight = undefined
    if (this.options.continuous) {
      this.pending = undefined
      this.pendingFrames = 0
    } else {
      this.clearPending()
    }
    // Keep the attempt interval anchored to the emission timestamp.  `now` is
    // intentionally consumed/validated so callers can pass the same clock to
    // success and failure without surprising timestamp errors.
    void now
    return true
  }

  /** Contract-friendly name for the successful teleport acknowledgement. */
  markSucceeded(attempt: number | Coordinate, nowMs?: number): boolean {
    return this.recordSuccess(attempt, nowMs)
  }

  markSuccess(attempt: number | Coordinate, nowMs?: number): boolean {
    return this.recordSuccess(attempt, nowMs)
  }

  /**
   * Mark an emitted attempt as failed.  It is deliberately not added to
   * `seen`, so the same coordinate can be retried after the minimum interval.
   */
  recordFailure(attempt: number | Coordinate, nowMs?: number): boolean {
    const now = finiteTimestamp(nowMs ?? this.clock(), 'nowMs')
    const flight = this.matchFlight(attempt)
    if (!flight) return false
    this.inFlight = undefined
    if (this.options.continuous) {
      if (!this.containsCoordinate(this.continuousQueue, flight.coordinate)) {
        if (this.continuousQueue.length >= CONTINUOUS_QUEUE_LIMIT) {
          this.continuousQueue.shift()
          this.continuousDropped += 1
        }
        this.continuousQueue.unshift(cloneCoordinate(flight.coordinate))
      }
    }
    // Keep the already-established stability count.  Once the interval has
    // elapsed, the next matching frame can retry without a needless second
    // visual confirmation cycle; a changed/disappeared candidate resets it.
    this.pending = cloneCoordinate(flight.coordinate)
    this.pendingFrames = this.options.stabilityFrames
    this.nextAllowedAtMs = Math.max(this.nextAllowedAtMs, now + this.options.minIntervalMs)
    return true
  }

  /** Contract-friendly name for a failed teleport acknowledgement. */
  markFailed(attempt: number | Coordinate, nowMs?: number): boolean {
    return this.recordFailure(attempt, nowMs)
  }

  markFailure(attempt: number | Coordinate, nowMs?: number): boolean {
    return this.recordFailure(attempt, nowMs)
  }

  // Friendly aliases for callers using acknowledgement terminology.
  acknowledgeSuccess(attempt: number | Coordinate, nowMs?: number): boolean {
    return this.recordSuccess(attempt, nowMs)
  }

  acknowledgeFailure(attempt: number | Coordinate, nowMs?: number): boolean {
    return this.recordFailure(attempt, nowMs)
  }

  /** Clear baseline, seen, pending, and in-flight state for a new session. */
  reset(): void {
    this.initialized = false
    this.seen = []
    this.clearPending()
    this.inFlight = undefined
    this.continuousPending = []
    this.continuousQueue = []
    this.continuousFrame = 0
    this.continuousDropped = 0
    // Keep attempt IDs monotonic across sessions so a late promise from the
    // previous session cannot accidentally acknowledge a new attempt #1.
    this.lastAttemptAtMs = undefined
    this.nextAllowedAtMs = Number.NEGATIVE_INFINITY
  }

  getSeenCoordinates(): Coordinate[] {
    return this.seen.map(cloneCoordinate)
  }

  getSnapshot(): CoordinateDetectorSnapshot {
    return {
      initialized: this.initialized,
      seen: this.getSeenCoordinates(),
      pending: this.pending ? cloneCoordinate(this.pending) : undefined,
      pendingFrames: this.pendingFrames,
      inFlight: this.inFlight
        ? { attemptId: this.inFlight.attemptId, coordinate: cloneCoordinate(this.inFlight.coordinate) }
        : undefined,
      queued: this.continuousQueue.map(cloneCoordinate),
      droppedCount: this.continuousDropped,
      lastAttemptAtMs: this.lastAttemptAtMs,
      nextAllowedAtMs: Number.isFinite(this.nextAllowedAtMs) ? this.nextAllowedAtMs : undefined,
    }
  }

  private clearPending(): void {
    this.pending = undefined
    this.pendingFrames = 0
    this.continuousPending = []
    this.continuousQueue = []
  }

  /**
   * Continuous sessions keep a bounded FIFO while one teleport is in flight.
   * Each coordinate gets its own consecutive-frame counter, so a short-lived
   * second/third candidate is not lost just because the first API call is
   * still completing.
   */
  private observeContinuous(
    candidates: readonly Coordinate[],
    now: number,
  ): CoordinateDetectorFrameResult {
    const frame = ++this.continuousFrame

    for (let index = this.continuousPending.length - 1; index >= 0; index -= 1) {
      const entry = this.continuousPending[index]
      if (!candidates.some((candidate) => this.isSame(candidate, entry.coordinate))) {
        this.continuousPending.splice(index, 1)
      }
    }

    for (const candidate of candidates) {
      if (this.seen.some((existing) => this.isSame(existing, candidate))) continue
      if (this.inFlight && this.isSame(this.inFlight.coordinate, candidate)) continue
      if (this.containsCoordinate(this.continuousQueue, candidate)) continue

      const existingIndex = this.continuousPending.findIndex((entry) => this.isSame(entry.coordinate, candidate))
      if (existingIndex < 0) {
        this.continuousPending.push({ coordinate: cloneCoordinate(candidate), frames: 1, lastFrame: frame })
        continue
      }

      const entry = this.continuousPending[existingIndex]
      entry.frames = entry.lastFrame === frame - 1 ? entry.frames + 1 : 1
      entry.lastFrame = frame
      if (entry.frames < this.options.stabilityFrames) continue

      this.continuousPending.splice(existingIndex, 1)
      if (this.containsCoordinate(this.continuousQueue, entry.coordinate)) continue
      if (this.continuousQueue.length >= CONTINUOUS_QUEUE_LIMIT) {
        this.continuousQueue.shift()
        this.continuousDropped += 1
      }
      this.continuousQueue.push(cloneCoordinate(entry.coordinate))
    }

    const newCandidates = dedupeCoordinates([
      ...this.newCandidates(candidates),
      ...this.continuousPending.map((entry) => entry.coordinate),
      ...this.continuousQueue,
    ], this.options)
    const dropped = this.continuousDropped > 0 ? { reason: 'queue_overflow' as const } : {}

    if (this.inFlight) {
      return this.result('none', 'awaiting_result', candidates, newCandidates, {
        coordinate: this.inFlight.coordinate,
        stableFrames: this.pendingFrames,
        attemptId: this.inFlight.attemptId,
        ...dropped,
      })
    }

    if (this.continuousQueue.length > 0) {
      const next = this.continuousQueue[0]
      if (now < this.nextAllowedAtMs) {
        return this.result('throttled', 'throttled', candidates, newCandidates, {
          coordinate: next,
          stableFrames: this.options.stabilityFrames,
          nextAllowedAtMs: this.nextAllowedAtMs,
          ...dropped,
        })
      }
      const coordinate = this.continuousQueue.shift()!
      const attemptId = this.nextAttemptId++
      this.inFlight = { attemptId, coordinate: cloneCoordinate(coordinate) }
      this.lastAttemptAtMs = now
      this.nextAllowedAtMs = now + this.options.minIntervalMs
      return this.result('candidate', 'ready', candidates, newCandidates, {
        coordinate,
        stableFrames: this.options.stabilityFrames,
        attemptId,
        ...dropped,
      })
    }

    if (this.continuousPending.length > 0) {
      const pending = this.continuousPending[0]
      this.pending = cloneCoordinate(pending.coordinate)
      this.pendingFrames = pending.frames
      return this.result('none', 'pending', candidates, newCandidates, {
        coordinate: pending.coordinate,
        stableFrames: pending.frames,
        ...dropped,
      })
    }

    this.pending = undefined
    this.pendingFrames = 0
    return this.result('none', candidates.length === 0 ? 'empty' : 'seen', candidates, newCandidates, dropped)
  }

  private containsCoordinate(coordinates: readonly Coordinate[], target: Coordinate): boolean {
    return coordinates.some((coordinate) => this.isSame(coordinate, target))
  }

  private isSame(a: Coordinate, b: Coordinate): boolean {
    return coordinatesEqual(a, b, this.options)
  }

  private newCandidates(candidates: readonly Coordinate[]): Coordinate[] {
    return candidates.filter((candidate) => !this.seen.some((existing) => this.isSame(existing, candidate)))
      .filter((candidate, index, list) => list.findIndex((other) => this.isSame(other, candidate)) === index)
      .map(cloneCoordinate)
  }

  private mergeSeen(seen: readonly Coordinate[], coordinate: Coordinate): Coordinate[] {
    if (seen.some((existing) => this.isSame(existing, coordinate))) return seen.map(cloneCoordinate)
    return [...seen.map(cloneCoordinate), cloneCoordinate(coordinate)]
  }

  private matchFlight(attempt: number | Coordinate | null | undefined): { attemptId: number; coordinate: Coordinate } | undefined {
    if (!this.inFlight) return undefined
    if (attempt === null || attempt === undefined) return undefined
    if (typeof attempt === 'number') {
      return attempt === this.inFlight.attemptId ? this.inFlight : undefined
    }
    return this.isSame(attempt, this.inFlight.coordinate) ? this.inFlight : undefined
  }

  private result(
    status: CoordinateDetectorStatus,
    phase: CoordinateDetectorPhase,
    candidates: readonly Coordinate[],
    newCandidates: readonly Coordinate[],
    details: Partial<Omit<CoordinateDetectorFrameResult, 'status' | 'candidates' | 'newCandidates'>> = {},
  ): CoordinateDetectorFrameResult {
    return {
      status,
      phase,
      candidates: candidates.map(cloneCoordinate),
      newCandidates: newCandidates.map(cloneCoordinate),
      stableFrames: details.stableFrames ?? this.pendingFrames,
      ready: phase === 'ready',
      droppedCount: this.continuousDropped,
      ...(details.coordinate ? { coordinate: cloneCoordinate(details.coordinate) } : {}),
      ...(details.attemptId !== undefined ? { attemptId: details.attemptId } : {}),
      ...(details.nextAllowedAtMs !== undefined ? { nextAllowedAtMs: details.nextAllowedAtMs } : {}),
      ...(details.reason ? { reason: details.reason } : {}),
    }
  }
}

export function createCoordinateDetector(options: CoordinateDetectorOptions = {}): CoordinateAutoDetector {
  return new CoordinateAutoDetector(options)
}

// Short class name for integrations that prefer `new CoordinateDetector(...)`.
export const CoordinateDetector = CoordinateAutoDetector
