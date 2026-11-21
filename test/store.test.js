import test from 'node:test';
import assert from 'node:assert/strict';
import { deriveNumbers, openStore } from '../src/store.js';

const official = { id: 'bclc', name: 'BCLC', kind: 'official', url: 'https://example.com/bclc' };
const source = { id: 'peer', name: 'Peer', kind: 'third_party', url: 'https://example.com/peer' };
const raw = [1, 4, 5, 11, 14, 32, 36, 38, 39, 41, 43, 44, 45, 57, 58, 62, 66, 73, 77, 80];
const timestamp = Date.parse('2026-11-21T10:00:00Z');
const toIso = value => new Date(value).toISOString();
const report = (feed, now, rows) => ({ sourceId: feed.id, seenAt: now, rows });

test('derives the reference from 20 unique Keno balls', () => {
  assert.deepEqual(deriveNumbers(raw.toReversed()), [2, 1, 2]);
  assert.equal(deriveNumbers(Array(20).fill(1)), null);
});

test('flags data and timestamp differences separately, then records recovery', t => {
  const store = openStore(':memory:', [official, source]);
  t.after(() => store.close());
  store.record([
    report(official, timestamp, [{ drawId: 123, raw, drawAt: toIso(timestamp), timeKind: 'draw' }]),
    report(source, timestamp, [{ drawId: 123, numbers: [9, 8, 1], drawAt: toIso(timestamp + 3600000), timeKind: 'draw' }]),
  ], timestamp);
  assert.deepEqual(store.dashboard(timestamp).anomalies.map(row => row.type).sort(), ['numbers_mismatch', 'time_mismatch']);
  store.record([report(source, timestamp + 1000, [{ drawId: 123, numbers: [2, 1, 2], drawAt: toIso(timestamp), timeKind: 'draw' }])], timestamp + 1000);
  assert.equal(store.dashboard(timestamp + 1000).draws[0].matched, 1);
  assert.ok(store.drawDetails(123, timestamp + 1000).anomalies.every(row => row.status === 'resolved'));
});

test('reports a backward BCLC clock separately from a third-party clock', t => {
  const store = openStore(':memory:', [official, source]);
  t.after(() => store.close());
  store.record([
    report(official, timestamp, [
      { drawId: 122, raw, drawAt: toIso(timestamp - 210000), timeKind: 'draw' },
      { drawId: 123, raw, drawAt: toIso(timestamp - 3600000), timeKind: 'draw' },
    ]),
    report(source, timestamp, [{ drawId: 123, numbers: [2, 1, 2], drawAt: toIso(timestamp), timeKind: 'draw' }]),
  ], timestamp);
  const anomalies = store.drawDetails(123, timestamp).anomalies;
  assert.deepEqual(anomalies.map(row => [row.sourceId, row.type]), [['bclc', 'time_mismatch']]);
});

test('uses the nearest day when a source only publishes a clock time', t => {
  const store = openStore(':memory:', [official, source]);
  t.after(() => store.close());
  store.record([
    report(official, timestamp, [{ drawId: 123, raw, drawAt: toIso(timestamp), timeKind: 'draw' }]),
    report(source, timestamp, [{ drawId: 123, numbers: [2, 1, 2], drawAt: toIso(timestamp - 23 * 3600000),
      timeLabel: '19:00', timeKind: 'clock', precisionMs: 60000 }]),
  ], timestamp);
  const [anomaly] = store.drawDetails(123, timestamp).anomalies;
  assert.equal(anomaly.type, 'time_mismatch');
  assert.equal(anomaly.sourceAt, toIso(timestamp + 3600000));
});

test('tracks missing and late results when they are observed live', t => {
  const store = openStore(':memory:', [official, source], { lateAfterMs: 60000 });
  t.after(() => store.close());
  const previous = { drawId: 122, numbers: [1, 1, 1], drawAt: toIso(timestamp - 210000) };
  store.record([report(source, timestamp - 1000, [previous])], timestamp - 1000);
  store.record([report(official, timestamp, [{ drawId: 123, raw, drawAt: toIso(timestamp), timeKind: 'draw' }])], timestamp);
  store.record([report(source, timestamp + 61000, [previous])], timestamp + 61000);
  assert.equal(store.drawDetails(123, timestamp + 61000).anomalies[0].type, 'missing_result');
  store.record([report(source, timestamp + 90000, [{ drawId: 123, numbers: [2, 1, 2] }])], timestamp + 90000);
  assert.deepEqual(store.drawDetails(123, timestamp + 90000).anomalies.map(row => [row.type, row.status]),
    [['late_source', 'resolved'], ['missing_result', 'resolved']]);
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
  store.record([report(source, expired + 1, [{ drawId: 123, numbers: [1, 2, 3] }])], expired + 1);
  assert.equal(store.drawDetails(123, expired + 1), null);
});
