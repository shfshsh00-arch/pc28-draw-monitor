import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { deriveNumbers, openStore } from '../src/store.js';
import { calibrateOfficialClock, officialTime } from '../src/normalize.js';

const official = { id: 'bclc', name: 'BCLC', kind: 'official', url: 'https://example.com/bclc' };
const source = { id: 'peer', name: 'Peer', kind: 'third_party', url: 'https://example.com/peer' };
const raw = [1, 4, 5, 11, 14, 32, 36, 38, 39, 41, 43, 44, 45, 57, 58, 62, 66, 73, 77, 80];
const timestamp = Date.parse('2026-11-21T10:00:00Z');
const toIso = value => new Date(value).toISOString();
const report = (feed, now, rows) => ({ sourceId: feed.id, seenAt: now, rows });
const checked = (drawId, at = timestamp, reported = at) => ({
  drawId, raw, drawAt: toIso(at), timeKind: 'draw', precisionMs: 1000,
  clock: { checkedAt: toIso(at), reportedAt: toIso(reported), offsetSeconds: (reported - at) / 1000, observedArchive: true },
});

test('derives the reference from 20 unique Keno balls', () => {
  assert.deepEqual(deriveNumbers(raw.toReversed()), [2, 1, 2]);
  assert.equal(deriveNumbers(Array(20).fill(1)), null);
});

test('flags data and timestamp differences separately, then records recovery', t => {
  const store = openStore(':memory:', [official, source]);
  t.after(() => store.close());
  store.record([
    report(official, timestamp, [checked(123)]),
    report(source, timestamp, [{ drawId: 123, numbers: [9, 8, 1], drawAt: toIso(timestamp + 3600000), timeKind: 'draw' }]),
  ], timestamp);
  assert.deepEqual(store.dashboard(timestamp).anomalies.map(row => row.type), ['numbers_mismatch']);
  assert.deepEqual(store.dashboard(timestamp).timing.map(row => row.type), ['source_clock']);
  store.record([report(source, timestamp + 1000, [{ drawId: 123, numbers: [2, 1, 2], drawAt: toIso(timestamp), timeKind: 'draw' }])], timestamp + 1000);
  assert.equal(store.dashboard(timestamp + 1000).draws[0].matched, 1);
  assert.ok(store.drawDetails(123, timestamp + 1000).anomalies.every(row => row.status === 'resolved'));
  assert.equal(store.drawDetails(123, timestamp + 1000).timing[0].status, 'resolved');
  const issue = store.drawDetails(123, timestamp + 1000).anomalies.find(row => row.type === 'numbers_mismatch');
  assert.deepEqual(issue.officialNumbers, [2, 1, 2]);
  assert.deepEqual(issue.sourceNumbers, [9, 8, 1]);
  assert.equal(store.dashboard(timestamp + 1000).draws[0].numberErrorCount, 1);
  assert.equal(store.dashboard(timestamp + 1000).draws[0].openNumberErrorCount, 0);
});

test('finds reused prior raw numbers even when the three digits match, and retains the evidence after correction', t => {
  const store = openStore(':memory:', [official, source]);
  t.after(() => store.close());
  const priorRaw = [...raw.slice(0, -1), 79];
  store.record([
    report(official, timestamp, [{ drawId: 120, raw: priorRaw }, { drawId: 123, raw }]),
    report(source, timestamp, [{ drawId: 123, raw: priorRaw }]),
  ], timestamp);
  assert.deepEqual(deriveNumbers(priorRaw), deriveNumbers(raw));
  assert.equal(store.dashboard(timestamp).draws[0].openNumberErrorCount, 1);
  store.record([report(source, timestamp + 1, [{ drawId: 123, numbers: [2, 1, 2] }])], timestamp + 1);
  assert.equal(store.drawDetails(123, timestamp + 1).anomalies[0].status, 'open');
  store.record([report(source, timestamp + 2, [{ drawId: 123, raw }])], timestamp + 2);
  const [issue] = store.drawDetails(123, timestamp + 2).anomalies;
  assert.equal(issue.status, 'resolved');
  assert.equal(issue.firstSeenAt, toIso(timestamp));
  assert.deepEqual(issue.evidence, { officialRaw: raw, sourceRaw: priorRaw, rawMismatch: true, priorDrawId: 120, priorMatch: 'raw' });
});

test('suggests a prior issue only when both its digits and its published time match', t => {
  const store = openStore(':memory:', [official, source]);
  t.after(() => store.close());
  const priorAt = toIso(timestamp - 210000);
  const before = [2, ...raw.slice(1)];
  before[1] = 3;
  const priorNumbers = deriveNumbers(before);
  store.record([
    report(official, timestamp, [
      { drawId: 122, raw: before, drawAt: priorAt, timeKind: 'draw' },
      { drawId: 123, raw, drawAt: toIso(timestamp), timeKind: 'draw' },
    ]),
    report(source, timestamp, [{ drawId: 123, numbers: priorNumbers, drawAt: toIso(timestamp), timeKind: 'draw' }]),
  ], timestamp);
  assert.equal(store.drawDetails(123, timestamp).anomalies[0].evidence.priorDrawId, null);
  store.record([report(source, timestamp + 1, [{ drawId: 123, numbers: priorNumbers, drawAt: priorAt, timeKind: 'draw' }])], timestamp + 1);
  const issue = store.drawDetails(123, timestamp + 1).anomalies.find(row => row.type === 'numbers_mismatch');
  assert.equal(issue.evidence.priorDrawId, 122);
  assert.equal(issue.evidence.priorMatch, 'time_and_numbers');
});

test('checks earlier source reports when they were corrected before the official result arrived', t => {
  const store = openStore(':memory:', [official, source]);
  t.after(() => store.close());
  const oldTimestamp = toIso(timestamp - 25 * 3600000);
  store.record([report(official, timestamp, [{ drawId: 122, raw }])], timestamp);
  store.record([report(source, timestamp + 1, [{ drawId: 123, numbers: [9, 8, 1], drawAt: oldTimestamp, timeKind: 'draw' }])], timestamp + 1);
  assert.deepEqual(store.drawDetails(123, timestamp + 1).observations[0].numbers, [9, 8, 1]);
  store.record([report(source, timestamp + 2, [{ drawId: 123, numbers: [2, 1, 2] }])], timestamp + 2);
  store.record([
    report(official, timestamp + 3, [{ drawId: 123, raw }]),
    report(source, timestamp + 3, [{ drawId: 123, numbers: [2, 1, 2] }]),
  ], timestamp + 3);
  const [issue] = store.drawDetails(123, timestamp + 3).anomalies;
  assert.deepEqual(issue.sourceNumbers, [9, 8, 1]);
  assert.equal(issue.sourceAt, oldTimestamp);
  assert.equal(issue.status, 'resolved');
});

test('loads existing anomaly records when opening a database from before raw snapshots', t => {
  const directory = mkdtempSync(join(tmpdir(), 'draw-monitor-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const path = join(directory, 'monitor.sqlite');
  const original = openStore(path, [official, source]);
  original.record([
    report(official, timestamp, [{ drawId: 123, raw }]),
    report(source, timestamp, [{ drawId: 123, numbers: [9, 8, 1] }]),
  ], timestamp);
  original.close();
  const legacy = new DatabaseSync(path);
  legacy.exec(`ALTER TABLE anomalies DROP COLUMN evidence;
    ALTER TABLE observations DROP COLUMN clock;
    INSERT INTO anomalies SELECT draw_id, source_id, 'missing_result', status, first_seen_at, last_seen_at,
      detail, official_numbers, source_numbers, official_at, source_at FROM anomalies WHERE type='numbers_mismatch';`);
  legacy.close();
  const reopened = openStore(path, [official, source]);
  try {
    const detail = reopened.drawDetails(123, timestamp);
    assert.equal(detail.anomalies.length, 1);
    assert.deepEqual(detail.timing, []);
    const [issue] = detail.anomalies;
    assert.deepEqual(issue.sourceNumbers, [9, 8, 1]);
    assert.equal(issue.evidence, null);
  } finally {
    reopened.close();
  }
});

test('uses the checked BCLC clock and keeps the validated time after subsequent archive reads', t => {
  const store = openStore(':memory:', [official, source]);
  t.after(() => store.close());
  const early = timestamp - 3600000;
  store.record([
    report(official, timestamp, [checked(123, timestamp, early)]),
    report(source, timestamp, [{ drawId: 123, numbers: [2, 1, 2], drawAt: toIso(early), timeKind: 'draw' }]),
  ], timestamp);
  const start = store.dashboard(timestamp);
  assert.equal(start.referenceClock.status, 'corrected');
  assert.equal(start.referenceClock.offsetSeconds, -3600);
  assert.equal(start.timeSources[0].status, 'offset');
  assert.equal(start.draws[0].officialAt, toIso(timestamp));
  assert.equal(start.draws[0].anomalyCount, 0);
  assert.deepEqual(start.timing.map(row => row.type).sort(), ['reference_clock', 'source_clock']);

  const next = timestamp + 210000;
  store.record([
    report(official, next, [checked(124, next), { drawId: 123, raw, drawAt: toIso(early), timeOrigin: 'archive', timeKind: 'draw' }]),
    report(source, next, [{ drawId: 124, numbers: [2, 1, 2], drawAt: toIso(next), timeKind: 'draw' }]),
  ], next);
  const continuing = store.dashboard(next);
  assert.equal(continuing.timeSources[0].drawId, 124);
  assert.equal(continuing.timeSources[0].status, 'aligned');
  assert.equal(continuing.draws.find(row => row.drawId === 123).officialAt, toIso(timestamp));
  assert.ok(continuing.timing.every(row => row.status === 'open'));

  store.record([
    report(official, next + 1000, [{ drawId: 123, raw, drawAt: toIso(timestamp), timeOrigin: 'archive', timeKind: 'draw' }]),
    report(source, next + 1000, [{ drawId: 123, numbers: [2, 1, 2], drawAt: toIso(timestamp), timeKind: 'draw' }]),
  ], next + 1000);
  const restored = store.drawDetails(123, next + 1000);
  assert.deepEqual(restored.anomalies, []);
  assert.ok(restored.timing.every(row => row.status === 'resolved' && row.sourceAt === toIso(early)));
});

test('uses the nearest day when a source only publishes a clock time', t => {
  const store = openStore(':memory:', [official, source]);
  t.after(() => store.close());
  store.record([
    report(official, timestamp, [checked(123)]),
    report(source, timestamp, [{ drawId: 123, numbers: [2, 1, 2], drawAt: toIso(timestamp - 23 * 3600000),
      timeLabel: '19:00', timeKind: 'clock', precisionMs: 60000 }]),
  ], timestamp);
  const [anomaly] = store.drawDetails(123, timestamp).timing;
  assert.equal(anomaly.type, 'source_clock');
  assert.equal(anomaly.sourceAt, toIso(timestamp + 3600000));
});

test('keeps missing and late results out of the anomaly list and waits for verified time', t => {
  const store = openStore(':memory:', [official, source]);
  t.after(() => store.close());
  const previous = { drawId: 122, numbers: [1, 1, 1], drawAt: toIso(timestamp - 210000) };
  store.record([report(source, timestamp - 1000, [previous])], timestamp - 1000);
  store.record([report(official, timestamp, [{ drawId: 123, raw, drawAt: toIso(timestamp), timeKind: 'draw' }])], timestamp);
  store.record([report(source, timestamp + 190000, [previous])], timestamp + 190000);
  assert.deepEqual(store.drawDetails(123, timestamp + 190000).anomalies, []);
  store.record([report(source, timestamp + 250000, [{ drawId: 123, numbers: [2, 1, 2],
    drawAt: toIso(timestamp - 3600000), timeKind: 'draw' }])], timestamp + 250000);
  const snapshot = store.dashboard(timestamp + 250000);
  assert.equal(snapshot.referenceClock.status, 'unverified');
  assert.equal(snapshot.draws[0].matched, 1);
  assert.equal(snapshot.draws[0].anomalyCount, 0);
  assert.deepEqual(snapshot.timing, []);
  assert.deepEqual(snapshot.timeSources, []);
});

test('checks a BCLC one-hour shift from fresh elapsed-time evidence and keeps permanent Pacific time in March', () => {
  const canonical = Date.parse('2026-11-21T17:44:00Z');
  const serverAt = canonical + 54000;
  const input = {
    requestStartedAt: serverAt - 500, responseReceivedAt: serverAt + 400, serverDate: new Date(serverAt).toUTCString(),
    age: null, elapsedMs: 53999, liveTime: '2026-11-21T09:44:00.000', archiveTime: 'Nov 21, 2026 9:44:00 AM', observedArchive: true,
  };
  const verified = calibrateOfficialClock(input);
  assert.equal(verified.drawAt, toIso(canonical));
  assert.equal(verified.clock.offsetSeconds, -3600);
  assert.equal(verified.clock.reportedAt, toIso(canonical - 3600000));
  assert.equal(calibrateOfficialClock({ ...input, age: '60' }), undefined);
  assert.equal(officialTime('2027-03-14T02:00:00').drawAt, '2027-03-14T09:00:00.000Z');
});

test('prunes observations and flags at 24 hours and ignores an old replay', t => {
  const store = openStore(':memory:', [official, source]);
  t.after(() => store.close());
  const old = [
    report(official, timestamp, [{ drawId: 123, raw, drawAt: toIso(timestamp) }]),
    report(source, timestamp, [{ drawId: 123, numbers: [1, 2, 3], drawAt: toIso(timestamp) }]),
  ];
  store.record(old, timestamp);
  assert.equal(store.dashboard(timestamp).anomalies.length, 1);
  const expired = timestamp + 24 * 60 * 60 * 1000;
  store.record(old.map(row => ({ ...row, seenAt: expired })), expired);
  assert.equal(store.drawDetails(123, expired), null);
  assert.equal(store.dashboard(expired).anomalies.length, 0);
  assert.ok(store.dashboard(expired).sources.every(row => row.latestDrawId === null));
  assert.ok(store.dashboard(expired).sources.every(row => row.status === 'stale'));
  store.record([report(source, expired + 1, [{ drawId: 123, numbers: [1, 2, 3] }])], expired + 1);
  assert.equal(store.drawDetails(123, expired + 1), null);
  store.record([report(source, expired + 2, [{ drawId: 124, numbers: [2, 1, 2], drawAt: toIso(expired + 2) }])], expired + 2);
  assert.equal(store.dashboard(expired + 2).sources.find(row => row.id === source.id).status, 'ok');
});
