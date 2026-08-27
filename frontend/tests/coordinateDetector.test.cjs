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
    droppedCount: 0,
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
