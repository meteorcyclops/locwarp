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
export const DEFAULT_QUEUE_MAX_AGE_MS = 0

/** Continuous queue retention strategy. */
export type CoordinateQueuePolicy = 'complete' | 'latest'

/** A queued coordinate and the time at which it became queueable. */
export interface CoordinateQueueEntry {
  coordinate: Coordinate
  timestamp: number
}

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

type CoordinateAxis = 'latitude' | 'longitude'
type CoordinateHemisphere = 'N' | 'S' | 'E' | 'W'

interface ParsedCoordinateMatch {
  coordinate: Coordinate
  start: number
  end: number
}

// The screen watcher receives OCR text, not the backend's already-normalized
// Coordinate object.  Keep the grammar explicit for the structured formats so
// a degree/minute/second sequence cannot accidentally be interpreted as two
// unrelated decimal numbers.  DMS/DM are intentionally matched before DD and
// their occupied ranges are excluded from the decimal pass below.
const COORD_UNSIGNED_NUMBER_SOURCE = '(?:\\d+(?:\\.\\d+)?|\\.\\d+)'
const COORD_NUMBER_SOURCE = `[+-]?${COORD_UNSIGNED_NUMBER_SOURCE}`
const COORD_DMS_RE = new RegExp(
  `(?<![\\d.])([+-]?\\d{1,3})\\s*°\\s*(\\d{1,2})\\s*'\\s*(\\d+(?:\\.\\d+)?)\\s*"\\s*([NS])?\\s*([,;\\s]+)\\s*([+-]?\\d{1,3})\\s*°\\s*(\\d{1,2})\\s*'\\s*(\\d+(?:\\.\\d+)?)\\s*"\\s*([EW])?(?![\\d.])`,
  'giu',
)
const COORD_DM_RE = new RegExp(
  `(?<![\\d.])([+-]?\\d{1,3})\\s*°\\s*(${COORD_UNSIGNED_NUMBER_SOURCE})\\s*'\\s*([NS])?\\s*([,;\\s]+)\\s*([+-]?\\d{1,3})\\s*°\\s*(${COORD_UNSIGNED_NUMBER_SOURCE})\\s*'\\s*([EW])?(?![\\d.])`,
  'giu',
)
const COORD_DD_RE = new RegExp(
  `(?<![\\d.])(${COORD_NUMBER_SOURCE})(?:\\s*(°)\\s*)?([NS])?\\s*([,;\\s]+)\\s*(${COORD_NUMBER_SOURCE})(?:\\s*(°)\\s*)?([EW])?(?![\\d.])`,
  'giu',
)

// Decimal is required on both numbers for this deliberately broad fallback.
// It preserves support for OCR labels/newlines/CJK around an ordinary decimal
// pair, while the structured passes above handle symbols and hemispheres.
const COORD_DECIMAL_FALLBACK_RE_SOURCE = '(?<![\\d.])([+-]?\\d+\\.\\d+)(?![\\d.])(?:(?![+-]?\\d+\\.\\d+)[^\\d.])*?([+-]?\\d+\\.\\d+)(?![\\d.])'

function normalizeCoordinateText(raw: string): string {
  // NFKC covers full-width digits/punctuation. The explicit replacements also
  // cover common Vision variants that are not consistently folded by NFKC.
  return raw
    .replace(/[º˚]/g, '°')
    .replace(/[″“”]/g, '"')
    .replace(/[′‘’]/g, "'")
    .normalize('NFKC')
    .replace(/[−﹣－]/g, '-')
    .replace(/[′‘’]/g, "'")
    // NFKC expands U+2033 DOUBLE PRIME into two U+2032 PRIME characters.
    .replace(/'{2}/g, '"')
    .replace(/，/g, ',')
}

function hemisphereIsNegative(hemisphere: CoordinateHemisphere): boolean {
  return hemisphere === 'S' || hemisphere === 'W'
}

function isHemisphereForAxis(
  hemisphere: CoordinateHemisphere | undefined,
  axis: CoordinateAxis,
): boolean {
  if (!hemisphere) return true
  return axis === 'latitude'
    ? hemisphere === 'N' || hemisphere === 'S'
    : hemisphere === 'E' || hemisphere === 'W'
}

function parseAnglePart(
  degreeText: string,
  minutes = 0,
  seconds = 0,
  hemisphere: CoordinateHemisphere | undefined,
  axis: CoordinateAxis,
): number | undefined {
  const degrees = Number(degreeText)
  if (!Number.isInteger(degrees) || !Number.isFinite(minutes) || !Number.isFinite(seconds)) return undefined
  if (minutes < 0 || minutes >= 60 || seconds < 0 || seconds >= 60) return undefined
  if (!isHemisphereForAxis(hemisphere, axis)) return undefined

  const maximum = axis === 'latitude' ? 90 : 180
  const magnitude = Math.abs(degrees) + minutes / 60 + seconds / 3600
  if (Math.abs(degrees) > maximum || (Math.abs(degrees) === maximum && (minutes > 0 || seconds > 0))) {
    return undefined
  }

  // An explicit sign must agree with an explicit hemisphere. An unsigned
  // degree followed by S/W is normal notation and is not a conflict.
  const signToken = degreeText[0]
  if (hemisphere && (signToken === '+' || signToken === '-')) {
    const signIsNegative = signToken === '-'
    if (signIsNegative !== hemisphereIsNegative(hemisphere)) return undefined
  }
  const negative = hemisphere ? hemisphereIsNegative(hemisphere) : degrees < 0
  const value = negative ? -magnitude : magnitude
  return Number.isFinite(value) ? value : undefined
}

function parseDecimalAnglePart(
  valueText: string,
  hemisphere: CoordinateHemisphere | undefined,
  axis: CoordinateAxis,
): number | undefined {
  const value = Number(valueText)
  if (!Number.isFinite(value) || !isHemisphereForAxis(hemisphere, axis)) return undefined
  const maximum = axis === 'latitude' ? 90 : 180
  const magnitude = Math.abs(value)
  if (magnitude > maximum) return undefined

  const signToken = valueText[0]
  if (hemisphere && (signToken === '+' || signToken === '-')) {
    const signIsNegative = signToken === '-'
    if (signIsNegative !== hemisphereIsNegative(hemisphere)) return undefined
  }
  const negative = hemisphere ? hemisphereIsNegative(hemisphere) : value < 0
  const result = negative ? -magnitude : magnitude
  return Number.isFinite(result) ? result : undefined
}

function separatorHasCommaOrSemicolon(separator: string): boolean {
  return separator.includes(',') || separator.includes(';')
}

function parseDmsMatch(match: RegExpMatchArray): Coordinate | undefined {
  const latHemisphere = match[4]?.toUpperCase() as CoordinateHemisphere | undefined
  const lngHemisphere = match[9]?.toUpperCase() as CoordinateHemisphere | undefined
  const separator = match[5] || ''
  // Whitespace-only DMS needs both axis markers; otherwise a comma/semicolon
  // is required to make the conventional lat,lng order explicit.
  if ((!latHemisphere || !lngHemisphere) && !separatorHasCommaOrSemicolon(separator)) return undefined
  const lat = parseAnglePart(
    match[1],
    Number(match[2]),
    Number(match[3]),
    latHemisphere,
    'latitude',
  )
  const lng = parseAnglePart(
    match[6],
    Number(match[7]),
    Number(match[8]),
    lngHemisphere,
    'longitude',
  )
  if (lat === undefined || lng === undefined) return undefined
  const coordinate = { lat, lng }
  return isValidCoordinate(coordinate) ? coordinate : undefined
}

function parseDmMatch(match: RegExpMatchArray): Coordinate | undefined {
  const latHemisphere = match[3]?.toUpperCase() as CoordinateHemisphere | undefined
  const lngHemisphere = match[7]?.toUpperCase() as CoordinateHemisphere | undefined
  const separator = match[4] || ''
  if ((!latHemisphere || !lngHemisphere) && !separatorHasCommaOrSemicolon(separator)) return undefined
  const lat = parseAnglePart(match[1], Number(match[2]), 0, latHemisphere, 'latitude')
  const lng = parseAnglePart(match[5], Number(match[6]), 0, lngHemisphere, 'longitude')
  if (lat === undefined || lng === undefined) return undefined
  const coordinate = { lat, lng }
  return isValidCoordinate(coordinate) ? coordinate : undefined
}

function parseDdMatch(match: RegExpMatchArray): Coordinate | undefined {
  const latHemisphere = match[3]?.toUpperCase() as CoordinateHemisphere | undefined
  const lngHemisphere = match[7]?.toUpperCase() as CoordinateHemisphere | undefined
  const hasLatDegreeSymbol = Boolean(match[2])
  const hasLngDegreeSymbol = Boolean(match[6])
  const latText = match[1]
  const lngText = match[5]
  const hasDecimalPair = latText.includes('.') && lngText.includes('.')

  // Preserve the old false-positive guard for integer-only plain text. An
  // integer is valid when degree symbols or hemispheres make the notation
  // explicit (for example, `39°N 84°W`).
  if (!hasDecimalPair && !(hasLatDegreeSymbol && hasLngDegreeSymbol) && !latHemisphere && !lngHemisphere) {
    return undefined
  }
  const lat = parseDecimalAnglePart(latText, latHemisphere, 'latitude')
  const lng = parseDecimalAnglePart(lngText, lngHemisphere, 'longitude')
  if (lat === undefined || lng === undefined) return undefined
  const coordinate = { lat, lng }
  return isValidCoordinate(coordinate) ? coordinate : undefined
}

function rangeOverlaps(
  start: number,
  end: number,
  occupied: readonly { start: number; end: number }[],
): boolean {
  return occupied.some((range) => start < range.end && end > range.start)
}

function hasStructuredMarker(text: string): boolean {
  // This is only used to suppress the unsafe decimal fallback when a malformed
  // DMS/hemisphere expression was seen. Standalone N/S/E/W markers are enough;
  // ordinary CJK/Latin labels remain compatible with the legacy fallback.
  return text.includes('°') || /(?:^|[^A-Za-z])[NSEW](?:$|[^A-Za-z])/i.test(text)
}

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
  const text = normalizeCoordinateText(raw)
  if (text.length === 0 || !passesConfidence(confidence, options)) return []
  const parsed: ParsedCoordinateMatch[] = []
  const occupied: Array<{ start: number; end: number }> = []

  const collect = (
    matcher: RegExp,
    parser: (match: RegExpMatchArray) => Coordinate | undefined,
    reserveInvalid = true,
  ) => {
    for (const match of text.matchAll(matcher)) {
      const start = match.index ?? -1
      if (start < 0) continue
      const end = start + match[0].length
      if (rangeOverlaps(start, end, occupied)) continue
      const coordinate = parser(match)
      if (coordinate) parsed.push({ coordinate, start, end })
      if (coordinate || reserveInvalid) occupied.push({ start, end })
    }
  }

  // Specific notations win over the decimal pass. Reserving even malformed
  // structured spans prevents their seconds/minutes from becoming a bogus DD
  // pair through the permissive legacy fallback.
  collect(COORD_DMS_RE, parseDmsMatch)
  collect(COORD_DM_RE, parseDmMatch)
  collect(COORD_DD_RE, parseDdMatch)

  const fallback = new RegExp(COORD_DECIMAL_FALLBACK_RE_SOURCE, 'g')
  for (const match of text.matchAll(fallback)) {
    const start = match.index ?? -1
    if (start < 0) continue
    const end = start + match[0].length
    if (rangeOverlaps(start, end, occupied)) continue
    // If a malformed DMS/directional expression was not matched above, do not
    // reinterpret its decimal seconds as a valid latitude/longitude pair.
    if (hasStructuredMarker(match[0])) continue
    const coordinate = { lat: Number(match[1]), lng: Number(match[2]) }
    if (isValidCoordinate(coordinate)) parsed.push({ coordinate, start, end })
  }

  return parsed
    .sort((a, b) => a.start - b.start)
    .map((entry) => entry.coordinate)
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
  /**
   * Let the first stable coordinate become triggerable instead of using the
   * first valid frame as a baseline. Defaults to false so existing callers
   * keep the conservative baseline behavior.
   */
  triggerInitialCandidate?: boolean
  /** Process the first stable coordinate from a multi-coordinate frame. */
  continuous?: boolean
  /** Minimum time between emitted attempts, regardless of success/failure. */
  minIntervalMs?: number
  /** Keep every stable coordinate (`complete`) or coalesce to the newest (`latest`). */
  queuePolicy?: CoordinateQueuePolicy
  /** Maximum age of queued coordinates in milliseconds; <= 0 disables expiry. */
  queueMaxAgeMs?: number
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
    | 'multiple_new_candidates' | 'min_interval' | 'awaiting_result' | 'queue_overflow' | 'queue_expired'
  /** Number of candidates discarded because the continuous FIFO was full. */
  droppedCount: number
  /** Number of queued candidates discarded because their TTL elapsed. */
  expiredCount: number
}

export interface CoordinateDetectorSnapshot {
  initialized: boolean
  seen: Coordinate[]
  pending?: Coordinate
  pendingFrames: number
  inFlight?: { attemptId: number; coordinate: Coordinate }
  /** Existing coordinate-only view kept for adapter compatibility. */
  queued: Coordinate[]
  /** Timestamped queue view for diagnostics and TTL-aware UI. */
  queuedEntries: CoordinateQueueEntry[]
  droppedCount: number
  expiredCount: number
  lastAttemptAtMs?: number
  nextAllowedAtMs?: number
}

/**
 * Cumulative capture/OCR counters reported by the GPS Watch helper.
 *
 * These values intentionally remain separate from CoordinateAutoDetector's
 * queue counters: the helper sees every capture callback, while the detector
 * only sees OCR results that made it back to the renderer.
 */
export interface GpsWatchTelemetrySample {
  /** Renderer receipt time, used only as the denominator for FPS. */
  atMs: number
  /** Helper frame number/cumulative capture callback count. */
  capturedFrameCount?: number
  /** Helper count of frames admitted to Vision OCR. */
  processedFrameCount?: number
  /** Helper cumulative capture-mailbox drops. */
  captureDroppedCount?: number
  /** Helper mailbox occupancy at the time of this sample. */
  queuedFrameCount?: number
  /** Whether the helper was running Vision OCR at this sample. */
  ocrInFlight?: boolean
  /** True once for a frame event containing at least one accepted coordinate. */
  recognized?: boolean
}

/**
 * Session-local GPS Watch telemetry state.
 *
 * `recognizedFrameCount` is a frame count, never a coordinate count. Its
 * success-rate denominator is the helper's `processedFrameCount` (the number
 * of frames admitted to OCR), so OCR failures and frames without coordinates
 * remain in the denominator when the helper supplies that counter.
 */
export interface GpsWatchTelemetryState {
  startedAtMs?: number
  lastSampleAtMs?: number
  capturedFrameCount?: number
  processedFrameCount?: number
  recognizedFrameCount: number
  captureDroppedCount?: number
  queuedFrameCount?: number
  ocrInFlight?: boolean
  rateStartedAtMs?: number
  rateCapturedFrameBase?: number
  rateProcessedFrameBase?: number
}

export interface GpsWatchTelemetryMetrics {
  /** Measured capture callbacks per second, when two timestamped samples exist. */
  captureFps?: number
  /** Measured frames admitted to OCR per second, when two timestamped samples exist. */
  ocrFps?: number
  recognizedFrames: number
  /** Undefined when the helper did not provide processedFrameCount. */
  processedFrames?: number
  /** recognizedFrames / processedFrames; never a candidate/coordinate ratio. */
  recognitionSuccessRate?: number
  captureDroppedCount?: number
  queuedFrameCount?: number
  ocrInFlight?: boolean
}

function normalizedTelemetryCounter(value: number | undefined): number | undefined {
  if (value === undefined || !Number.isFinite(value)) return undefined
  return Math.max(0, Math.floor(value))
}

function normalizedTelemetryTime(value: number): number | undefined {
  return Number.isFinite(value) ? value : undefined
}

/** Create an empty telemetry session; no rate is reported until real samples arrive. */
export function createGpsWatchTelemetry(startedAtMs?: number): GpsWatchTelemetryState {
  return {
    startedAtMs: startedAtMs === undefined ? undefined : normalizedTelemetryTime(startedAtMs),
    recognizedFrameCount: 0,
  }
}

/**
 * Add one helper/status/frame sample without changing detector behaviour.
 * Counter decreases are treated as a helper rebaseline so a restarted helper
 * cannot produce negative or artificially huge FPS values.
 */
export function recordGpsWatchTelemetry(
  previous: GpsWatchTelemetryState,
  sample: GpsWatchTelemetrySample,
): GpsWatchTelemetryState {
  const atMs = normalizedTelemetryTime(sample.atMs)
  if (atMs === undefined) return { ...previous }

  const capturedFrameCount = normalizedTelemetryCounter(sample.capturedFrameCount)
  const processedFrameCount = normalizedTelemetryCounter(sample.processedFrameCount)
  const captureDroppedCount = normalizedTelemetryCounter(sample.captureDroppedCount)
  const queuedFrameCount = normalizedTelemetryCounter(sample.queuedFrameCount)
  const previousCaptured = previous.capturedFrameCount
  const previousProcessed = previous.processedFrameCount
  const countersReset = (
    capturedFrameCount !== undefined
    && previousCaptured !== undefined
    && capturedFrameCount < previousCaptured
  ) || (
    processedFrameCount !== undefined
    && previousProcessed !== undefined
    && processedFrameCount < previousProcessed
  )

  let rateStartedAtMs = previous.rateStartedAtMs
  let rateCapturedFrameBase = previous.rateCapturedFrameBase
  let rateProcessedFrameBase = previous.rateProcessedFrameBase
  if (countersReset) {
    rateStartedAtMs = atMs
    rateCapturedFrameBase = capturedFrameCount
    rateProcessedFrameBase = processedFrameCount
  } else {
    if (capturedFrameCount !== undefined && rateCapturedFrameBase === undefined) {
      rateStartedAtMs = rateStartedAtMs ?? previous.startedAtMs ?? atMs
      rateCapturedFrameBase = previousCaptured ?? 0
    }
    if (processedFrameCount !== undefined && rateProcessedFrameBase === undefined) {
      rateStartedAtMs = rateStartedAtMs ?? previous.startedAtMs ?? atMs
      rateProcessedFrameBase = previousProcessed ?? 0
    }
  }

  const nextStartedAtMs = previous.startedAtMs ?? atMs
  const recognizedFrameCount = previous.recognizedFrameCount + (sample.recognized === true ? 1 : 0)
  return {
    startedAtMs: nextStartedAtMs,
    lastSampleAtMs: atMs,
    capturedFrameCount: capturedFrameCount ?? previousCaptured,
    processedFrameCount: processedFrameCount ?? previousProcessed,
    recognizedFrameCount,
    captureDroppedCount: captureDroppedCount ?? previous.captureDroppedCount,
    queuedFrameCount: queuedFrameCount ?? previous.queuedFrameCount,
    ocrInFlight: sample.ocrInFlight ?? previous.ocrInFlight,
    rateStartedAtMs,
    rateCapturedFrameBase,
    rateProcessedFrameBase,
  }
}

function telemetryRate(
  current: number | undefined,
  base: number | undefined,
  startedAtMs: number | undefined,
  lastSampleAtMs: number | undefined,
): number | undefined {
  if (current === undefined || base === undefined || startedAtMs === undefined || lastSampleAtMs === undefined) {
    return undefined
  }
  const elapsedSeconds = (lastSampleAtMs - startedAtMs) / 1000
  if (!Number.isFinite(elapsedSeconds) || elapsedSeconds <= 0) return undefined
  return Math.max(0, current - base) / elapsedSeconds
}

/** Derive display metrics from real helper counters; missing counters stay undefined. */
export function getGpsWatchTelemetryMetrics(state: GpsWatchTelemetryState): GpsWatchTelemetryMetrics {
  const processedFrames = state.processedFrameCount
  return {
    captureFps: telemetryRate(
      state.capturedFrameCount,
      state.rateCapturedFrameBase,
      state.rateStartedAtMs,
      state.lastSampleAtMs,
    ),
    ocrFps: telemetryRate(
      processedFrames,
      state.rateProcessedFrameBase,
      state.rateStartedAtMs,
      state.lastSampleAtMs,
    ),
    recognizedFrames: state.recognizedFrameCount,
    processedFrames,
    recognitionSuccessRate: processedFrames !== undefined && processedFrames > 0
      ? Math.min(1, state.recognizedFrameCount / processedFrames)
      : undefined,
    captureDroppedCount: state.captureDroppedCount,
    queuedFrameCount: state.queuedFrameCount,
    ocrInFlight: state.ocrInFlight,
  }
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
  readonly options: Required<Pick<CoordinateDetectorOptions, 'stabilityFrames' | 'roundDecimals' | 'distanceMeters' | 'minIntervalMs' | 'minConfidence' | 'requireConfidence' | 'triggerInitialCandidate' | 'continuous' | 'queuePolicy' | 'queueMaxAgeMs'>>

  private readonly clock: () => number
  private initialized = false
  private seen: Coordinate[] = []
  private pending?: Coordinate
  private pendingFrames = 0
  private inFlight?: { attemptId: number; coordinate: Coordinate }
  private continuousPending: Array<{ coordinate: Coordinate; frames: number; lastFrame: number }> = []
  private continuousQueue: CoordinateQueueEntry[] = []
  private continuousFrame = 0
  private continuousDropped = 0
  private continuousExpired = 0
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
    const queuePolicy = options.queuePolicy ?? 'complete'
    const queueMaxAgeMs = options.queueMaxAgeMs ?? DEFAULT_QUEUE_MAX_AGE_MS
    if (!Number.isFinite(minConfidence) || minConfidence < 0 || minConfidence > 1) {
      throw new RangeError('minConfidence must be a number between 0 and 1')
    }
    if (!Number.isFinite(minIntervalMs) || minIntervalMs < 0) {
      throw new RangeError('minIntervalMs must be a finite non-negative number')
    }
    if (!Number.isFinite(distanceMetersOption) || distanceMetersOption < 0) {
      throw new RangeError('distanceMeters must be a finite non-negative number')
    }
    if (queuePolicy !== 'complete' && queuePolicy !== 'latest') {
      throw new RangeError("queuePolicy must be either 'complete' or 'latest'")
    }
    if (!Number.isFinite(queueMaxAgeMs)) {
      throw new RangeError('queueMaxAgeMs must be a finite number')
    }
    this.options = {
      stabilityFrames,
      roundDecimals: normalizeDecimals(options.roundDecimals, DEFAULT_ROUND_DECIMALS),
      distanceMeters: distanceMetersOption,
      minIntervalMs,
      minConfidence,
      requireConfidence: options.requireConfidence ?? false,
      triggerInitialCandidate: options.triggerInitialCandidate ?? false,
      continuous: options.continuous ?? false,
      queuePolicy,
      queueMaxAgeMs: queueMaxAgeMs > 0 ? queueMaxAgeMs : 0,
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
      if (!this.options.triggerInitialCandidate) {
        // Existing on-screen text is the baseline.  Marking it seen also means
        // scrolling it out and back in cannot unexpectedly teleport again.
        this.seen = candidates.map(cloneCoordinate)
        this.clearPending()
        return this.result('baseline', 'baseline', candidates, [], {
          reason: 'initial_baseline',
        })
      }
      // GPS screen-watch opts into this branch: keep the first valid points as
      // pending candidates and let the normal stability gate require two
      // matching frames before anything can be emitted.
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
      // Keep a failed attempt retryable.  It is placed at the front for the
      // complete policy. In latest mode, an already-queued newer coordinate
      // wins over retrying the older failed attempt.
      if (this.options.queuePolicy === 'latest' && this.continuousQueue.length > 0) {
        this.continuousDropped += 1
      } else {
        this.enqueueContinuous(flight.coordinate, now, true)
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
    this.continuousExpired = 0
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
      queued: this.continuousQueue.map((entry) => cloneCoordinate(entry.coordinate)),
      queuedEntries: this.continuousQueue.map((entry) => this.cloneQueueEntry(entry)),
      droppedCount: this.continuousDropped,
      expiredCount: this.continuousExpired,
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
   * Continuous sessions keep stable coordinates in a bounded queue while one
   * teleport is in flight.  The default `complete` policy preserves the
   * existing FIFO behavior; `latest` intentionally coalesces queued work so
   * a fast-scrolling screen does not make the device visit stale points.
   */
  private observeContinuous(
    candidates: readonly Coordinate[],
    now: number,
  ): CoordinateDetectorFrameResult {
    const droppedBefore = this.continuousDropped
    const expiredBefore = this.continuousExpired
    this.expireContinuousQueue(now)
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
      if (this.containsQueuedCoordinate(candidate)) continue

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
      this.enqueueContinuous(entry.coordinate, now)
    }

    const newCandidates = dedupeCoordinates([
      ...this.newCandidates(candidates),
      ...this.continuousPending.map((entry) => entry.coordinate),
      ...this.continuousQueue.map((entry) => entry.coordinate),
    ], this.options)
    const dropped = this.continuousDropped > droppedBefore ? { reason: 'queue_overflow' as const } : {}
    const expired = this.continuousExpired > expiredBefore ? { reason: 'queue_expired' as const } : {}
    const queueChanges = Object.keys(expired).length > 0 ? expired : dropped

    if (this.inFlight) {
      return this.result('none', 'awaiting_result', candidates, newCandidates, {
        coordinate: this.inFlight.coordinate,
        stableFrames: this.pendingFrames,
        attemptId: this.inFlight.attemptId,
        ...queueChanges,
      })
    }

    if (this.continuousQueue.length > 0) {
      const next = this.continuousQueue[0].coordinate
      if (now < this.nextAllowedAtMs) {
        return this.result('throttled', 'throttled', candidates, newCandidates, {
          coordinate: next,
          stableFrames: this.options.stabilityFrames,
          nextAllowedAtMs: this.nextAllowedAtMs,
          ...queueChanges,
        })
      }
      const coordinate = this.continuousQueue.shift()!.coordinate
      const attemptId = this.nextAttemptId++
      this.inFlight = { attemptId, coordinate: cloneCoordinate(coordinate) }
      this.lastAttemptAtMs = now
      this.nextAllowedAtMs = now + this.options.minIntervalMs
      return this.result('candidate', 'ready', candidates, newCandidates, {
        coordinate,
        stableFrames: this.options.stabilityFrames,
        attemptId,
        ...queueChanges,
      })
    }

    if (this.continuousPending.length > 0) {
      const pending = this.continuousPending[0]
      this.pending = cloneCoordinate(pending.coordinate)
      this.pendingFrames = pending.frames
      return this.result('none', 'pending', candidates, newCandidates, {
        coordinate: pending.coordinate,
        stableFrames: pending.frames,
        ...queueChanges,
      })
    }

    this.pending = undefined
    this.pendingFrames = 0
    return this.result('none', candidates.length === 0 ? 'empty' : 'seen', candidates, newCandidates, queueChanges)
  }

  private containsQueuedCoordinate(target: Coordinate): boolean {
    return this.continuousQueue.some((entry) => this.isSame(entry.coordinate, target))
  }

  private enqueueContinuous(coordinate: Coordinate, timestamp: number, atFront = false): void {
    if (this.containsQueuedCoordinate(coordinate)) return

    if (this.options.queuePolicy === 'latest') {
      // `latest` deliberately keeps a single queued coordinate.  Count the
      // replaced entry as dropped so diagnostics still expose how much work
      // was coalesced while the OCR stream was ahead of the teleport API.
      if (this.continuousQueue.length > 0) {
        this.continuousDropped += this.continuousQueue.length
        this.continuousQueue = []
      }
      this.continuousQueue.push({ coordinate: cloneCoordinate(coordinate), timestamp })
      return
    }

    if (this.continuousQueue.length >= CONTINUOUS_QUEUE_LIMIT) {
      this.continuousQueue.shift()
      this.continuousDropped += 1
    }
    const entry = { coordinate: cloneCoordinate(coordinate), timestamp }
    if (atFront) this.continuousQueue.unshift(entry)
    else this.continuousQueue.push(entry)
  }

  private expireContinuousQueue(now: number): void {
    const maxAge = this.options.queueMaxAgeMs
    if (maxAge <= 0 || this.continuousQueue.length === 0) return

    const retained: CoordinateQueueEntry[] = []
    for (const entry of this.continuousQueue) {
      if (now - entry.timestamp >= maxAge) this.continuousExpired += 1
      else retained.push(entry)
    }
    this.continuousQueue = retained
  }

  private cloneQueueEntry(entry: CoordinateQueueEntry): CoordinateQueueEntry {
    return { coordinate: cloneCoordinate(entry.coordinate), timestamp: entry.timestamp }
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
      expiredCount: this.continuousExpired,
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
