const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const test = require('node:test');

const moduleUnderTest = import(pathToFileURL(path.join(__dirname, '../src/utils/coordinateDetector.ts')));

test('parseAllCoordinates extracts every decimal lat/lng pair from joined OCR lines', async () => {
  const { parseAllCoordinates, parseCoordinateCandidates } = await moduleUnderTest;
  const ocrLines = [
    '28.647615,77.189494 一般毒菇',
    '41.8243328138, -71.4662015811',
    '49.346681,9.129642',
  ];
  assert.deepEqual(parseAllCoordinates(ocrLines), [
    { lat: 28.647615, lng: 77.189494 },
    { lat: 41.8243328138, lng: -71.4662015811 },
    { lat: 49.346681, lng: 9.129642 },
  ]);
  // The low-level parser exposes every valid match before de-duplication.
  assert.equal(parseCoordinateCandidates('25.12300,121.45600\n25.12301,121.45601').length, 2);
});

test('parser rejects out-of-range and integer-only false positives', async () => {
  const { parseAllCoordinates } = await moduleUnderTest;
  assert.deepEqual(parseAllCoordinates([
    '91.000, 121.000',
    '25, 121',
    '25.033, 121.565',
    '190.2, 20.1',
  ]), [{ lat: 25.033, lng: 121.565 }]);
});

test('parser converts DD direction suffixes, DM, and DMS into signed decimals', async () => {
  const { parseCoordinateCandidates } = await moduleUnderTest;

  assert.deepEqual(parseCoordinateCandidates('39.005472°N, 84.606083°W'), [
    { lat: 39.005472, lng: -84.606083 },
  ]);
  assert.deepEqual(parseCoordinateCandidates('25.033N 121.565W'), [
    { lat: 25.033, lng: -121.565 },
  ]);
  assert.deepEqual(parseCoordinateCandidates('−25.033，121.565'), [
    { lat: -25.033, lng: 121.565 },
  ]);

  const dms = parseCoordinateCandidates('39°00\'19.7"N 84°36\'21.9"W');
  assert.equal(dms.length, 1);
  assert.ok(Math.abs(dms[0].lat - 39.00547222222222) < 1e-12);
  assert.ok(Math.abs(dms[0].lng + 84.60608333333333) < 1e-12);

  const unicodeDms = parseCoordinateCandidates('39°00′19.7″N 84°36′21.9″W');
  assert.equal(unicodeDms.length, 1);
  assert.ok(Math.abs(unicodeDms[0].lat - dms[0].lat) < 1e-12);
  assert.ok(Math.abs(unicodeDms[0].lng - dms[0].lng) < 1e-12);

  const curlyQuoteDms = parseCoordinateCandidates('39°00‘19.7“N 84°36‘21.9“W');
  assert.equal(curlyQuoteDms.length, 1);
  assert.ok(Math.abs(curlyQuoteDms[0].lat - dms[0].lat) < 1e-12);
  assert.ok(Math.abs(curlyQuoteDms[0].lng - dms[0].lng) < 1e-12);

  const structured = parseCoordinateCandidates([{
    text: '39°00′19.7″N，84°36′21.9″W',
    confidence: 0.98,
  }], { minConfidence: 0.9, requireConfidence: true });
  assert.equal(structured.length, 1);
  assert.ok(Math.abs(structured[0].lat - dms[0].lat) < 1e-12);
  assert.ok(Math.abs(structured[0].lng - dms[0].lng) < 1e-12);

  const dm = parseCoordinateCandidates('39°00.3283\'N 84°36.365\'W');
  assert.equal(dm.length, 1);
  assert.ok(Math.abs(dm[0].lat - 39.00547166666667) < 1e-12);
  assert.ok(Math.abs(dm[0].lng + 84.60608333333333) < 1e-12);
});

test('directional coordinate parser rejects invalid components and sign conflicts', async () => {
  const { parseCoordinateCandidates } = await moduleUnderTest;
  const invalid = [
    '39°60\'0"N 84°36\'21.9"W',
    '39°00\'60"N 84°36\'21.9"W',
    '91°00\'0"N 84°36\'21.9"W',
    '39°00\'19.7"E 84°36\'21.9"N',
    '-39°00\'19.7"N 84°36\'21.9"W',
    '+39.005472°S, 84.606083°W',
    '-39.005472°N, 84.606083°W',
    '39.005472°N, -84.606083°E',
  ];
  for (const text of invalid) assert.deepEqual(parseCoordinateCandidates(text), [], text);
});

test('rounding and distance de-duplicate OCR jitter while retaining far points', async () => {
  const { dedupeCoordinates, coordinateKey, distanceMeters } = await moduleUnderTest;
  const close = { lat: 25.03300, lng: 121.56500 };
  const jitter = { lat: 25.03301, lng: 121.56501 };
  const far = { lat: 25.03400, lng: 121.56600 };
  assert.equal(coordinateKey(close, 5), '25.03300,121.56500');
  assert.ok(distanceMeters(close, jitter) < 20);
  assert.deepEqual(dedupeCoordinates([close, jitter, far]), [close, far]);
});

test('first frame establishes a baseline and never triggers it', async () => {
  const { CoordinateAutoDetector } = await moduleUnderTest;
  const detector = new CoordinateAutoDetector({ minIntervalMs: 100 });
  const first = detector.observe('25.033,121.565', 0);
  assert.equal(first.status, 'baseline');
  assert.equal(first.ready, false);
  assert.equal(detector.observe('25.033,121.565', 50).status, 'none');
  assert.equal(detector.getSeenCoordinates().length, 1);
});

test('triggerInitialCandidate keeps the default baseline opt-in and emits after two stable frames', async () => {
  const { CoordinateAutoDetector } = await moduleUnderTest;
  const detector = new CoordinateAutoDetector({
    continuous: true,
    triggerInitialCandidate: true,
    minIntervalMs: 0,
  });

  const first = detector.observe('39°00\'19.7"N 84°36\'21.9"W', 0);
  assert.equal(first.phase, 'pending');
  assert.equal(first.ready, false);
  assert.equal(first.stableFrames, 1);

  const second = detector.observe('39°00′19.7″N 84°36′21.9″W', 10);
  assert.equal(second.phase, 'ready');
  assert.equal(second.ready, true);
  assert.ok(Math.abs(second.coordinate.lat - 39.00547222222222) < 1e-12);
  assert.ok(Math.abs(second.coordinate.lng + 84.60608333333333) < 1e-12);
});

test('triggerInitialCandidate still waits for a useful frame after OCR warm-up empties', async () => {
  const { CoordinateAutoDetector } = await moduleUnderTest;
  const detector = new CoordinateAutoDetector({
    continuous: true,
    triggerInitialCandidate: true,
    minIntervalMs: 0,
  });

  assert.equal(detector.observe([], 0).phase, 'empty');
  assert.equal(detector.observe('25.033N 121.565E', 10).phase, 'pending');
  const ready = detector.observe('25.033N 121.565E', 20);
  assert.equal(ready.ready, true);
  assert.deepEqual(ready.coordinate, { lat: 25.033, lng: 121.565 });
});

test('empty first frames do not finish baseline; first valid frame is baseline and later repeats stay inert', async () => {
  const { CoordinateAutoDetector } = await moduleUnderTest;
  const detector = new CoordinateAutoDetector({ minIntervalMs: 0 });
  const empty = detector.observe([], 0);
  assert.equal(empty.status, 'none');
  assert.equal(empty.phase, 'empty');
  assert.equal(detector.getSnapshot().initialized, false);

  const firstValid = detector.observe(['25.033,121.565'], 10);
  assert.equal(firstValid.status, 'baseline');
  assert.equal(firstValid.ready, false);
  assert.equal(detector.getSnapshot().initialized, true);

  const existing = detector.observe(['25.033,121.565'], 20);
  assert.equal(existing.status, 'none');
  assert.equal(existing.phase, 'seen');
  assert.equal(existing.ready, false);
});

test('new coordinate needs two consecutive matching frames before candidate is ready', async () => {
  const { CoordinateAutoDetector } = await moduleUnderTest;
  const detector = new CoordinateAutoDetector({ minIntervalMs: 100 });
  detector.observe('25.033,121.565', 0);
  const first = detector.observe('25.034,121.566', 10);
  assert.equal(first.status, 'none');
  assert.equal(first.phase, 'pending');
  assert.equal(first.ready, false);
  assert.equal(first.stableFrames, 1);
  const second = detector.observe('25.034,121.566', 20);
  assert.equal(second.status, 'candidate');
  assert.equal(second.phase, 'ready');
  assert.equal(second.ready, true);
  assert.equal(second.stableFrames, 2);
  assert.deepEqual(second.coordinate, { lat: 25.034, lng: 121.566 });
  assert.equal(typeof second.attemptId, 'number');
});

test('multiple simultaneous unseen coordinates are reported as ambiguous', async () => {
  const { CoordinateAutoDetector } = await moduleUnderTest;
  const detector = new CoordinateAutoDetector();
  detector.observe('25.033,121.565', 0);
  const result = detector.observe('25.034,121.566\n25.035,121.567', 10);
  assert.equal(result.status, 'ambiguous');
  assert.equal(result.phase, 'ambiguous');
  assert.equal(result.ready, false);
  assert.equal(result.newCandidates.length, 2);
});

test('continuous mode drains multiple stable coordinates without entering ambiguous state', async () => {
  const { CoordinateAutoDetector } = await moduleUnderTest;
  const detector = new CoordinateAutoDetector({ continuous: true, minIntervalMs: 0 });
  detector.observe('25.033,121.565', 0);

  const firstPending = detector.observe('25.034,121.566\n25.035,121.567', 10);
  assert.equal(firstPending.phase, 'pending');
  assert.deepEqual(firstPending.coordinate, { lat: 25.034, lng: 121.566 });
  const firstReady = detector.observe('25.034,121.566\n25.035,121.567', 20);
  assert.equal(firstReady.phase, 'ready');
  assert.deepEqual(firstReady.coordinate, { lat: 25.034, lng: 121.566 });
  assert.equal(detector.markSucceeded(firstReady.attemptId, 21), true);

  const secondReady = detector.observe('25.034,121.566\n25.035,121.567', 30);
  assert.equal(secondReady.phase, 'ready');
  assert.deepEqual(secondReady.coordinate, { lat: 25.035, lng: 121.567 });
});

test('continuous mode queues a short-lived candidate while another teleport is in flight', async () => {
  const { CoordinateAutoDetector } = await moduleUnderTest;
  const detector = new CoordinateAutoDetector({ continuous: true, minIntervalMs: 0 });
  detector.observe('25.033,121.565', 0);

  const first = detector.observe('25.034,121.566\n25.035,121.567', 10);
  assert.equal(first.phase, 'pending');
  const ready = detector.observe('25.034,121.566\n25.035,121.567', 20);
  assert.equal(ready.ready, true);
  assert.deepEqual(ready.coordinate, { lat: 25.034, lng: 121.566 });

  // The second coordinate is still visible for only one more frame. It is
  // already stable, so it must remain queued even when it disappears later.
  detector.observe('25.034,121.566\n25.035,121.567', 30);
  detector.observe('25.034,121.566', 40);
  assert.equal(detector.getSnapshot().queued.length, 1);
  assert.equal(detector.markSucceeded(ready.attemptId, 50), true);

  const queuedReady = detector.observe('25.034,121.566', 60);
  assert.equal(queuedReady.ready, true);
  assert.deepEqual(queuedReady.coordinate, { lat: 25.035, lng: 121.567 });
});

test('continuous FIFO is bounded and reports discarded oldest candidates', async () => {
  const { CoordinateAutoDetector, CONTINUOUS_QUEUE_LIMIT } = await moduleUnderTest;
  const detector = new CoordinateAutoDetector({ continuous: true, minIntervalMs: 0 });
  detector.observe('25.033,121.565', 0);
  const points = Array.from({ length: CONTINUOUS_QUEUE_LIMIT + 6 }, (_, index) =>
    `${(30 + index * 0.01).toFixed(5)},${(120 + index * 0.01).toFixed(5)}`,
  ).join('\n');
  detector.observe(points, 10);
  const first = detector.observe(points, 20);
  assert.equal(first.ready, true);
  assert.equal(first.droppedCount, 6);
  assert.equal(detector.getSnapshot().queued.length, CONTINUOUS_QUEUE_LIMIT - 1);
  assert.equal(detector.getSnapshot().droppedCount, 6);
});

test('continuous complete policy preserves FIFO order for several queued stable candidates', async () => {
  const { CoordinateAutoDetector } = await moduleUnderTest;
  const detector = new CoordinateAutoDetector({ continuous: true, minIntervalMs: 0 });
  assert.equal(detector.options.queuePolicy, 'complete');
  detector.observe('25.033,121.565', 0);

  detector.observe('25.034,121.566', 10);
  const first = detector.observe('25.034,121.566', 20);
  assert.equal(first.ready, true);

  detector.observe('25.035,121.567', 30);
  detector.observe('25.035,121.567', 40);
  detector.observe('25.036,121.568', 50);
  const queued = detector.observe('25.036,121.568', 60);
  assert.equal(queued.phase, 'awaiting_result');
  assert.deepEqual(detector.getSnapshot().queued, [
    { lat: 25.035, lng: 121.567 },
    { lat: 25.036, lng: 121.568 },
  ]);

  assert.equal(detector.markSucceeded(first.attemptId, 61), true);
  const second = detector.observe('25.033,121.565', 62);
  assert.deepEqual(second.coordinate, { lat: 25.035, lng: 121.567 });
  assert.equal(second.ready, true);
  assert.equal(detector.markSucceeded(second.attemptId, 63), true);
  const third = detector.observe('25.033,121.565', 64);
  assert.deepEqual(third.coordinate, { lat: 25.036, lng: 121.568 });
  assert.equal(third.ready, true);
});

test('continuous queue entries expire by TTL and report cumulative expiredCount', async () => {
  const { CoordinateAutoDetector } = await moduleUnderTest;
  const detector = new CoordinateAutoDetector({ continuous: true, minIntervalMs: 0, queueMaxAgeMs: 50 });
  detector.observe('25.033,121.565', 0);
  detector.observe('25.034,121.566', 10);
  const first = detector.observe('25.034,121.566', 20);
  assert.equal(first.ready, true);

  detector.observe('25.034,121.566\n25.035,121.567', 30);
  detector.observe('25.034,121.566\n25.035,121.567', 40);
  assert.deepEqual(detector.getSnapshot().queuedEntries, [{
    coordinate: { lat: 25.035, lng: 121.567 },
    timestamp: 40,
  }]);

  const expired = detector.observe('25.033,121.565', 90);
  assert.equal(expired.phase, 'awaiting_result');
  assert.equal(expired.reason, 'queue_expired');
  assert.equal(expired.expiredCount, 1);
  assert.deepEqual(detector.getSnapshot().queued, []);
  assert.equal(detector.getSnapshot().expiredCount, 1);
  assert.equal(detector.markSucceeded(first.attemptId, 91), true);
});

test('queueMaxAgeMs <= 0 keeps queued candidates indefinitely', async () => {
  const { CoordinateAutoDetector } = await moduleUnderTest;
  const detector = new CoordinateAutoDetector({ continuous: true, minIntervalMs: 0, queueMaxAgeMs: -1 });
  detector.observe('25.033,121.565', 0);
  const first = detector.observe('25.034,121.566', 10);
  const ready = detector.observe('25.034,121.566', 20);
  assert.equal(ready.ready, true);
  assert.equal(first.ready, false);

  detector.observe('25.034,121.566\n25.035,121.567', 30);
  detector.observe('25.034,121.566\n25.035,121.567', 40);
  const later = detector.observe('25.033,121.565', 10000);
  assert.equal(later.expiredCount, 0);
  assert.deepEqual(detector.getSnapshot().queued, [{ lat: 25.035, lng: 121.567 }]);
  assert.equal(detector.markSucceeded(ready.attemptId, 10001), true);
});

test('continuous latest policy replaces an older queued candidate without an in-flight attempt', async () => {
  const { CoordinateAutoDetector } = await moduleUnderTest;
  const detector = new CoordinateAutoDetector({
    continuous: true,
    minIntervalMs: 100,
    queuePolicy: 'latest',
  });
  detector.observe('25.033,121.565', 0);
  detector.observe('25.034,121.566', 10);
  const first = detector.observe('25.034,121.566', 20);
  assert.equal(first.ready, true);
  assert.equal(detector.markSucceeded(first.attemptId, 21), true);

  detector.observe('25.035,121.567', 30);
  const older = detector.observe('25.035,121.567', 40);
  assert.equal(older.phase, 'throttled');
  assert.deepEqual(detector.getSnapshot().queued, [{ lat: 25.035, lng: 121.567 }]);

  detector.observe('25.036,121.568', 50);
  const latest = detector.observe('25.036,121.568', 60);
  assert.equal(latest.phase, 'throttled');
  assert.deepEqual(latest.coordinate, { lat: 25.036, lng: 121.568 });
  assert.deepEqual(detector.getSnapshot().queued, [{ lat: 25.036, lng: 121.568 }]);
  assert.equal(detector.getSnapshot().droppedCount, 1);
  assert.equal(detector.getSnapshot().queuedEntries[0].timestamp, 60);
});

test('continuous latest policy keeps only the newest queued candidate during in-flight work', async () => {
  const { CoordinateAutoDetector } = await moduleUnderTest;
  const detector = new CoordinateAutoDetector({ continuous: true, minIntervalMs: 0, queuePolicy: 'latest' });
  detector.observe('25.033,121.565', 0);
  detector.observe('25.034,121.566', 10);
  const first = detector.observe('25.034,121.566', 20);
  assert.equal(first.ready, true);

  detector.observe('25.034,121.566\n25.035,121.567', 30);
  const older = detector.observe('25.034,121.566\n25.035,121.567', 40);
  assert.equal(older.phase, 'awaiting_result');
  assert.deepEqual(detector.getSnapshot().queued, [{ lat: 25.035, lng: 121.567 }]);

  detector.observe('25.034,121.566\n25.036,121.568', 50);
  const latest = detector.observe('25.034,121.566\n25.036,121.568', 60);
  assert.equal(latest.phase, 'awaiting_result');
  assert.deepEqual(latest.coordinate, { lat: 25.034, lng: 121.566 });
  assert.deepEqual(detector.getSnapshot().inFlight.coordinate, { lat: 25.034, lng: 121.566 });
  assert.deepEqual(detector.getSnapshot().queued, [{ lat: 25.036, lng: 121.568 }]);
  assert.equal(detector.getSnapshot().droppedCount, 1);

  assert.equal(detector.markSucceeded(first.attemptId, 61), true);
  const next = detector.observe('25.033,121.565', 62);
  assert.equal(next.ready, true);
  assert.deepEqual(next.coordinate, { lat: 25.036, lng: 121.568 });
});

test('continuous latest policy keeps newer queued work ahead of a failed older attempt', async () => {
  const { CoordinateAutoDetector } = await moduleUnderTest;
  const detector = new CoordinateAutoDetector({ continuous: true, minIntervalMs: 0, queuePolicy: 'latest' });
  detector.observe('25.033,121.565', 0);
  detector.observe('25.034,121.566', 10);
  const first = detector.observe('25.034,121.566', 20);
  assert.equal(first.ready, true);

  detector.observe('25.034,121.566\n25.035,121.567', 30);
  detector.observe('25.034,121.566\n25.035,121.567', 40);
  assert.deepEqual(detector.getSnapshot().queued, [{ lat: 25.035, lng: 121.567 }]);

  assert.equal(detector.markFailed(first.attemptId, 41), true);
  assert.deepEqual(detector.getSnapshot().queued, [{ lat: 25.035, lng: 121.567 }]);
  assert.equal(detector.getSnapshot().droppedCount, 1);
});

test('continuous reset invalidates in-flight work and clears the FIFO', async () => {
  const { CoordinateAutoDetector } = await moduleUnderTest;
  const detector = new CoordinateAutoDetector({ continuous: true, minIntervalMs: 0 });
  detector.observe('25.033,121.565', 0);
  detector.observe('25.034,121.566\n25.035,121.567', 10);
  const ready = detector.observe('25.034,121.566\n25.035,121.567', 20);
  assert.equal(ready.ready, true);
  detector.observe('25.034,121.566\n25.035,121.567', 30);
  assert.equal(detector.getSnapshot().queued.length, 1);

  detector.reset();
  assert.deepEqual(detector.getSnapshot(), {
    initialized: false,
    seen: [],
    pending: undefined,
    pendingFrames: 0,
    inFlight: undefined,
    queued: [],
    queuedEntries: [],
    droppedCount: 0,
    expiredCount: 0,
    lastAttemptAtMs: undefined,
    nextAllowedAtMs: undefined,
  });
  assert.equal(detector.markSucceeded(ready.attemptId, 40), false);
});

test('structured OCR candidates require a conservative confidence threshold when enabled', async () => {
  const { CoordinateAutoDetector, parseAllCoordinates } = await moduleUnderTest;
  const baseline = { latitude: 25.033, longitude: 121.565, confidence: 0.99, text: '25.033,121.565' };
  const low = { latitude: 25.034, longitude: 121.566, confidence: 0.89, text: '25.034,121.566' };
  const missing = { latitude: 25.035, longitude: 121.567, text: '25.035,121.567' };
  const high = { latitude: 25.036, longitude: 121.568, confidence: 0.95, text: '25.036,121.568' };

  assert.deepEqual(
    parseAllCoordinates([baseline, low, missing, high], { minConfidence: 0.9, requireConfidence: true }),
    [
      { lat: 25.033, lng: 121.565 },
      { lat: 25.036, lng: 121.568 },
    ],
  );

  const detector = new CoordinateAutoDetector({ minConfidence: 0.9, requireConfidence: true, minIntervalMs: 0 });
  assert.equal(detector.observe([baseline], 0).status, 'baseline');
  assert.equal(detector.observe([low], 10).phase, 'empty');
  assert.equal(detector.observe([low], 20).phase, 'empty');
  assert.equal(detector.observe([high], 30).phase, 'pending');
  assert.equal(detector.observe([high], 40).ready, true);
});

test('success marks a coordinate seen and prevents a repeated trigger', async () => {
  const { CoordinateAutoDetector } = await moduleUnderTest;
  const detector = new CoordinateAutoDetector({ minIntervalMs: 100 });
  detector.observe('25.033,121.565', 0);
  detector.observe('25.034,121.566', 10);
  const ready = detector.observe('25.034,121.566', 20);
  assert.equal(detector.markSucceeded(ready.attemptId, 20), true);
  const repeated = detector.observe('25.034,121.566', 200);
  assert.equal(repeated.status, 'none');
  assert.equal(repeated.phase, 'seen');
  assert.equal(detector.markSucceeded(ready.attemptId, 200), false);
});

test('failure leaves coordinate retryable, but only after minimum interval', async () => {
  const { CoordinateAutoDetector } = await moduleUnderTest;
  const detector = new CoordinateAutoDetector({ minIntervalMs: 100 });
  detector.observe('25.033,121.565', 0);
  detector.observe('25.034,121.566', 10);
  const first = detector.observe('25.034,121.566', 20);
  assert.equal(detector.markFailed(first.attemptId, 20), true);
  assert.equal(detector.observe('25.034,121.566', 50).status, 'throttled');
  const retry = detector.observe('25.034,121.566', 120);
  assert.equal(retry.status, 'candidate');
  assert.equal(retry.phase, 'ready');
  assert.equal(retry.ready, true);
  assert.notEqual(retry.attemptId, first.attemptId);
});

test('minimum interval throttles a different stable candidate after success', async () => {
  const { CoordinateAutoDetector } = await moduleUnderTest;
  const detector = new CoordinateAutoDetector({ minIntervalMs: 100 });
  detector.observe('25.033,121.565', 0);
  detector.observe('25.034,121.566', 10);
  const first = detector.observe('25.034,121.566', 20);
  detector.markSucceeded(first.attemptId, 20);
  detector.observe('25.035,121.567', 50);
  const throttled = detector.observe('25.035,121.567', 60);
  assert.equal(throttled.status, 'throttled');
  assert.equal(throttled.nextAllowedAtMs, 120);
  const allowed = detector.observe('25.035,121.567', 120);
  assert.equal(allowed.phase, 'ready');
  assert.equal(allowed.ready, true);
});

test('OCR arrays and reset are supported by the same detector contract', async () => {
  const { CoordinateAutoDetector } = await moduleUnderTest;
  const detector = new CoordinateAutoDetector({ minIntervalMs: 0 });
  assert.equal(detector.processFrame(['25.033,121.565'], 0).status, 'baseline');
  detector.reset();
  assert.equal(detector.processFrame(['25.034,121.566'], 0).status, 'baseline');
  assert.equal(detector.getSnapshot().initialized, true);
});
