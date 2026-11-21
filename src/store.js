import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { retentionMs, retentionHours, pollIntervalSeconds, lateAfterMs, timeToleranceMs } from './config.js';
import { calculatePc28, parseRawNumbers } from './normalize.js';

const timestamps = value => Number.isFinite(value) ? new Date(value).toISOString() : null;
const parseNumbers = value => value ? JSON.parse(value) : null;
const dayMs = 24 * 60 * 60 * 1000;
const validNumbers = values => Array.isArray(values) && values.length === 3 &&
  values.every(value => Number.isInteger(value) && value >= 0 && value <= 9);

export function deriveNumbers(raw) {
  return calculatePc28(raw) ?? null;
}

function sourceState(row) {
  return {
    id: row.id, name: row.name, kind: row.kind, url: row.url, group: row.group_name,
    status: row.status, lastOkAt: timestamps(row.last_ok_at), lastErrorAt: timestamps(row.last_error_at),
    lastError: row.last_error, latestDrawId: row.latest_draw_id, latestDrawAt: timestamps(row.latest_draw_at),
  };
}

function anomalyView(row) {
  return {
    drawId: row.draw_id, sourceId: row.source_id, type: row.type, status: row.status,
    firstSeenAt: timestamps(row.first_seen_at), lastSeenAt: timestamps(row.last_seen_at), detail: row.detail,
    officialNumbers: parseNumbers(row.official_numbers), sourceNumbers: parseNumbers(row.source_numbers),
    officialAt: timestamps(row.official_at), sourceAt: timestamps(row.source_at),
    evidence: row.evidence ? JSON.parse(row.evidence) : null,
  };
}

export function openStore(path, sources, options = {}) {
  const lateAfter = options.lateAfterMs ?? lateAfterMs;
  const timeTolerance = options.timeToleranceMs ?? timeToleranceMs;
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec(`
    PRAGMA auto_vacuum = INCREMENTAL;
    PRAGMA journal_mode = WAL;
    PRAGMA synchronous = NORMAL;
    PRAGMA foreign_keys = ON;
    PRAGMA secure_delete = ON;
    PRAGMA wal_autocheckpoint = 128;
    CREATE TABLE IF NOT EXISTS sources (
      id TEXT PRIMARY KEY, name TEXT NOT NULL, kind TEXT NOT NULL, url TEXT NOT NULL, group_name TEXT,
      status TEXT NOT NULL DEFAULT 'pending', first_ok_at INTEGER, last_ok_at INTEGER,
      last_error_at INTEGER, last_error TEXT, latest_draw_id INTEGER, latest_draw_at INTEGER
    );
    CREATE TABLE IF NOT EXISTS draws (
      id INTEGER PRIMARY KEY, first_seen_at INTEGER NOT NULL, retention_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS retention_state (
      id INTEGER PRIMARY KEY CHECK (id = 1), retired_through INTEGER NOT NULL
    );
    INSERT INTO retention_state(id, retired_through) VALUES(1, 0) ON CONFLICT(id) DO NOTHING;
    CREATE INDEX IF NOT EXISTS draws_retention ON draws(retention_at);
    CREATE TABLE IF NOT EXISTS observations (
      draw_id INTEGER NOT NULL REFERENCES draws(id) ON DELETE CASCADE,
      source_id TEXT NOT NULL REFERENCES sources(id) ON DELETE CASCADE,
      numbers TEXT NOT NULL, raw TEXT, draw_at INTEGER, time_label TEXT, time_kind TEXT, precision_ms INTEGER NOT NULL,
      first_seen_at INTEGER NOT NULL, last_seen_at INTEGER NOT NULL,
      PRIMARY KEY(draw_id, source_id)
    );
    CREATE INDEX IF NOT EXISTS observations_by_source ON observations(source_id, draw_id DESC);
    CREATE TABLE IF NOT EXISTS anomalies (
      draw_id INTEGER NOT NULL REFERENCES draws(id) ON DELETE CASCADE,
      source_id TEXT NOT NULL REFERENCES sources(id) ON DELETE CASCADE, type TEXT NOT NULL,
      status TEXT NOT NULL, first_seen_at INTEGER NOT NULL, last_seen_at INTEGER NOT NULL, detail TEXT NOT NULL,
      official_numbers TEXT NOT NULL, source_numbers TEXT, official_at INTEGER, source_at INTEGER,
      evidence TEXT,
      PRIMARY KEY(draw_id, source_id, type)
    );
    CREATE INDEX IF NOT EXISTS anomalies_latest ON anomalies(status, draw_id DESC);
    CREATE TABLE IF NOT EXISTS pending_number_evidence (
      draw_id INTEGER NOT NULL REFERENCES draws(id) ON DELETE CASCADE,
      source_id TEXT NOT NULL REFERENCES sources(id) ON DELETE CASCADE,
      numbers TEXT NOT NULL, raw TEXT, draw_at INTEGER, time_kind TEXT, precision_ms INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS pending_number_evidence_by_draw ON pending_number_evidence(draw_id);
  `);
  if (!db.prepare('PRAGMA table_info(anomalies)').all().some(column => column.name === 'evidence')) {
    db.exec('ALTER TABLE anomalies ADD COLUMN evidence TEXT');
  }

  const byId = new Map(sources.map(source => [source.id, source]));
  const officialId = sources.find(source => source.kind === 'official')?.id;
  if (!officialId) throw new Error('A BCLC official source is required');

  const register = db.prepare(`INSERT INTO sources (id, name, kind, url, group_name) VALUES (?, ?, ?, ?, ?)
    ON CONFLICT (id) DO UPDATE SET name=excluded.name, kind=excluded.kind, url=excluded.url, group_name=excluded.group_name`);
  for (const source of sources) register.run(source.id, source.name, source.kind, source.url, source.group ?? null);
  const removeSource = db.prepare('DELETE FROM sources WHERE id = ?');
  for (const row of db.prepare('SELECT id FROM sources').all()) if (!byId.has(row.id)) removeSource.run(row.id);

  const sourceRows = db.prepare('SELECT * FROM sources ORDER BY (kind = \'official\') DESC, rowid');
  const getSource = db.prepare('SELECT * FROM sources WHERE id = ?');
  const getDraw = db.prepare('SELECT * FROM draws WHERE id = ?');
  const addDraw = db.prepare('INSERT INTO draws VALUES (?, ?, ?) ON CONFLICT(id) DO NOTHING');
  const updateRetention = db.prepare('UPDATE draws SET retention_at = ? WHERE id = ?');
  const saveObservation = db.prepare(`INSERT INTO observations VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(draw_id, source_id) DO UPDATE SET numbers=excluded.numbers, raw=excluded.raw,
      draw_at=excluded.draw_at, time_label=excluded.time_label, time_kind=excluded.time_kind,
      precision_ms=excluded.precision_ms, last_seen_at=excluded.last_seen_at`);
  const refreshOk = db.prepare(`UPDATE sources SET status='ok', first_ok_at=COALESCE(first_ok_at, ?), last_ok_at=?, last_error=NULL,
    latest_draw_id=?, latest_draw_at=? WHERE id=?`);
  const refreshStale = db.prepare(`UPDATE sources SET status='stale', last_ok_at=?, last_error=NULL,
    latest_draw_id=NULL, latest_draw_at=NULL WHERE id=?`);
  const refreshError = db.prepare(`UPDATE sources SET status='error', last_error_at=?, last_error=? WHERE id=?`);
  const latestObservation = db.prepare(`SELECT o.draw_id, o.draw_at FROM observations o JOIN draws d ON d.id=o.draw_id
    WHERE o.source_id=? AND d.retention_at>? ORDER BY o.draw_id DESC LIMIT 1`);
  const observationAt = db.prepare('SELECT * FROM observations WHERE draw_id=? AND source_id=?');
  const rememberReplacedNumbers = db.prepare(`INSERT INTO pending_number_evidence
    SELECT draw_id, source_id, numbers, raw, draw_at, time_kind, precision_ms FROM observations
    WHERE draw_id=? AND source_id=? AND (numbers<>? OR raw IS NOT ?)
      AND (? OR NOT EXISTS (SELECT 1 FROM observations WHERE draw_id=? AND source_id=?))`);
  const pendingNumberEvidence = db.prepare('SELECT * FROM pending_number_evidence WHERE draw_id=? ORDER BY rowid');
  const clearPendingNumberEvidence = db.prepare('DELETE FROM pending_number_evidence WHERE draw_id=?');
  const earlierOfficialRaw = db.prepare(`SELECT draw_id FROM observations
    WHERE source_id=? AND draw_id<? AND raw=? ORDER BY draw_id DESC LIMIT 1`);
  const earlierOfficialTimeAndNumbers = db.prepare(`SELECT draw_id FROM observations
    WHERE source_id=? AND draw_id<? AND numbers=? AND time_kind='draw' AND draw_at BETWEEN ? AND ?
    ORDER BY ABS(draw_at - ?), draw_id DESC LIMIT 1`);
  const rowsForDraw = db.prepare(`SELECT observations.*, sources.name, sources.kind FROM observations
    JOIN sources ON sources.id = observations.source_id WHERE draw_id=? ORDER BY (kind='official') DESC, sources.rowid`);
  const currentAnomalies = db.prepare('SELECT * FROM anomalies WHERE draw_id=? ORDER BY status, type, source_id');
  const examineDraws = db.prepare(`SELECT draws.id FROM draws INNER JOIN observations AS baseline
    ON baseline.draw_id=draws.id AND baseline.source_id=? WHERE draws.retention_at > ?`);
  const upsertAnomaly = db.prepare(`INSERT INTO anomalies (draw_id, source_id, type, status, first_seen_at, last_seen_at,
    detail, official_numbers, source_numbers, official_at, source_at, evidence) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(draw_id, source_id, type) DO UPDATE SET status=excluded.status, last_seen_at=excluded.last_seen_at,
      detail=excluded.detail, official_numbers=excluded.official_numbers, source_numbers=excluded.source_numbers,
      official_at=excluded.official_at, source_at=excluded.source_at, evidence=excluded.evidence
      WHERE excluded.status='open' OR anomalies.status<>excluded.status OR anomalies.detail<>excluded.detail`);
  const resolveAnomaly = db.prepare(`UPDATE anomalies SET status='resolved', last_seen_at=? WHERE draw_id=? AND source_id=? AND type=? AND status='open'`);
  const resolveNumberError = db.prepare(`UPDATE anomalies SET status='resolved', last_seen_at=?
    WHERE draw_id=? AND source_id=? AND type='numbers_mismatch' AND status='open'
      AND (? OR COALESCE(json_extract(evidence, '$.rawMismatch'), 0)=0)`);
  const retiredThrough = db.prepare('SELECT retired_through FROM retention_state WHERE id=1');
  const markRetired = db.prepare('UPDATE retention_state SET retired_through=MAX(retired_through, ?) WHERE id=1');
  const retiringNow = db.prepare(`SELECT MAX(d.id) AS id FROM draws d JOIN observations o ON o.draw_id=d.id
    WHERE o.source_id=? AND d.retention_at<=?`);
  const prune = db.prepare('DELETE FROM draws WHERE retention_at <= ?');
  const keepSourceLatest = db.prepare(`UPDATE sources SET latest_draw_id=NULL, latest_draw_at=NULL
    WHERE latest_draw_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM observations
      WHERE observations.source_id=sources.id AND observations.draw_id=sources.latest_draw_id)`);
  const listDraws = db.prepare(`SELECT d.id, d.first_seen_at, o.draw_at, o.numbers,
    (SELECT COUNT(*) FROM observations a WHERE a.draw_id=d.id AND a.source_id<>?) AS total,
    CASE WHEN o.numbers IS NULL THEN 0 ELSE (SELECT COUNT(*) FROM observations a
      WHERE a.draw_id=d.id AND a.source_id<>? AND a.numbers=o.numbers
       AND (a.raw IS NULL OR o.raw IS NULL OR a.raw=o.raw)) END AS matched,
    (SELECT COUNT(*) FROM anomalies f WHERE f.draw_id=d.id) AS anomaly_count,
    (SELECT COUNT(*) FROM anomalies f WHERE f.draw_id=d.id AND f.type='numbers_mismatch') AS number_error_count,
    (SELECT COUNT(*) FROM anomalies f WHERE f.draw_id=d.id AND f.type='numbers_mismatch' AND f.status='open') AS open_number_error_count
    FROM draws d LEFT JOIN observations o ON d.id=o.draw_id AND o.source_id=?
    WHERE d.retention_at>? ORDER BY d.id DESC`);
  const listAnomalies = db.prepare(`SELECT a.* FROM anomalies a JOIN draws d ON d.id=a.draw_id
    WHERE d.retention_at>? ORDER BY (a.status='open') DESC, a.draw_id DESC, a.last_seen_at DESC`);

  function setAnomaly(drawId, sourceId, type, detail, official, observation, now, status = 'open', evidence = null) {
    upsertAnomaly.run(drawId, sourceId, type, status, now, now, detail, official.numbers,
      observation?.numbers ?? null, official.draw_at, observation?.draw_at ?? null, evidence);
  }

  function flagNumberError(official, observed, now) {
    const wrongNumbers = observed.numbers !== official.numbers;
    const rawMismatch = Boolean(observed.raw && observed.raw !== official.raw);
    if (!wrongNumbers && !rawMismatch) return false;

    let priorDrawId = null;
    let priorMatch = null;
    if (rawMismatch) {
      priorDrawId = earlierOfficialRaw.get(officialId, official.draw_id, observed.raw)?.draw_id ?? null;
      if (priorDrawId !== null) priorMatch = 'raw';
    } else if (observed.time_kind === 'draw' && observed.draw_at !== null && official.draw_at !== null &&
        Math.abs(observed.draw_at - official.draw_at) > timeTolerance) {
      const margin = Math.max(1000, observed.precision_ms);
      priorDrawId = earlierOfficialTimeAndNumbers.get(officialId, official.draw_id, observed.numbers,
        observed.draw_at - margin, observed.draw_at + margin, observed.draw_at)?.draw_id ?? null;
      if (priorDrawId !== null) priorMatch = 'time_and_numbers';
    }
    const detail = wrongNumbers ? '同一期三位数与 BCLC 原始号码复算结果不同。' : '三位数相同，但来源提供的 Keno 20 码与 BCLC 不同。';
    const evidence = JSON.stringify({
      officialRaw: parseNumbers(official.raw), sourceRaw: parseNumbers(observed.raw), rawMismatch, priorDrawId, priorMatch,
    });
    setAnomaly(official.draw_id, observed.source_id, 'numbers_mismatch', detail, official, observed, now, 'open', evidence);
    return true;
  }

  function reconcile(drawId, activeSources, now) {
    const observations = new Map(rowsForDraw.all(drawId).map(row => [row.source_id, row]));
    const official = observations.get(officialId);
    if (!official) return;
    for (const replaced of pendingNumberEvidence.all(drawId)) flagNumberError(official, replaced, now);
    clearPendingNumberEvidence.run(drawId);
    const previous = observationAt.get(drawId - 1, officialId);
    const officialClockReversed = official.time_kind === 'draw' && previous?.time_kind === 'draw' &&
      official.draw_at !== null && previous.draw_at !== null && official.draw_at < previous.draw_at;
    if (officialClockReversed) {
      const seconds = Math.round((previous.draw_at - official.draw_at) / 1000);
      setAnomaly(drawId, officialId, 'time_mismatch', `BCLC 本期的档案时间比上一期早 ${seconds} 秒。`, previous, official, now);
    } else if (previous) resolveAnomaly.run(now, drawId, officialId, 'time_mismatch');
    for (const source of activeSources) {
      if (source.id === officialId) continue;
      const observed = observations.get(source.id);
      if (!observed) {
        const observedLive = official.draw_at === null || Math.abs(official.first_seen_at - official.draw_at) <= lateAfter;
        if (observedLive && source.status === 'ok' && source.first_ok_at <= official.first_seen_at &&
            source.last_ok_at >= official.first_seen_at + lateAfter &&
            drawId - (source.latest_draw_id ?? 0) < 100) {
          setAnomaly(drawId, source.id, 'missing_result', '官方结果已采集，该来源在等待阈值内未返回同一期。', official, null, now);
        }
        continue;
      }

      resolveAnomaly.run(now, drawId, source.id, 'missing_result');
      if (!flagNumberError(official, observed, now)) {
        resolveNumberError.run(now, drawId, source.id, Number(Boolean(observed.raw)));
      }

      if (!officialClockReversed && official.time_kind === 'draw' && ['draw', 'clock'].includes(observed.time_kind) &&
          official.draw_at !== null && observed.draw_at !== null) {
        const clockOnly = observed.time_kind === 'clock';
        const elapsed = observed.draw_at - official.draw_at;
        const difference = clockOnly ? elapsed - Math.round(elapsed / dayMs) * dayMs : elapsed;
        if (Math.abs(difference) > Math.max(timeTolerance, observed.precision_ms, official.precision_ms)) {
          const duration = Math.round(Math.abs(difference) / 1000);
          const estimate = clockOnly ? '来源仅提供时分，按最接近官方时刻的日期比较。' : '';
          const detail = `来源标注的开奖时间比 BCLC ${difference > 0 ? '晚' : '早'} ${duration} 秒。${estimate}`;
          setAnomaly(drawId, source.id, 'time_mismatch', detail, official, { ...observed, draw_at: official.draw_at + difference }, now);
        } else resolveAnomaly.run(now, drawId, source.id, 'time_mismatch');
      }

      const lag = observed.first_seen_at - official.first_seen_at;
      if (lag > lateAfter && source.first_ok_at <= official.first_seen_at &&
          (official.draw_at === null || Math.abs(official.first_seen_at - official.draw_at) <= lateAfter)) {
        const detail = `本站第一次读到该来源结果，比第一次读到 BCLC 结果晚 ${Math.round(lag / 1000)} 秒。`;
        setAnomaly(drawId, source.id, 'late_source', detail, official, observed, now, 'resolved');
      }
    }
  }

  function record(outcomes, now = Date.now()) {
    const cutoff = now - retentionMs;
    db.exec('BEGIN');
    try {
      const affected = new Set();
      const newBaselines = new Set();
      let latestOfficialId = latestObservation.get(officialId, cutoff)?.draw_id;
      let retired = Math.max(retiredThrough.get().retired_through, retiringNow.get(officialId, cutoff).id ?? 0);
      const ordered = [...outcomes].sort((a, b) => Number(b.sourceId === officialId) - Number(a.sourceId === officialId));
      for (const outcome of ordered) {
        const source = byId.get(outcome.sourceId);
        if (!source) continue;
        if (outcome.error) {
          refreshError.run(now, String(outcome.error).slice(0, 180), source.id);
          continue;
        }
        const seenAt = Math.min(outcome.seenAt ?? now, now);
        let valid = 0;
        for (const row of outcome.rows ?? []) {
          if (!Number.isSafeInteger(row.drawId) || row.drawId < 1) continue;
          const parsedDate = typeof row.drawAt === 'string' ? Date.parse(row.drawAt) : NaN;
          const drawAt = Number.isFinite(parsedDate) ? parsedDate : null;
          const raw = parseRawNumbers(row.raw);
          const numbers = source.kind === 'official' ? deriveNumbers(raw) : (validNumbers(row.numbers) ? row.numbers : deriveNumbers(raw));
          if (!numbers) continue;
          valid++;
          if (drawAt !== null && drawAt <= cutoff) {
            if (source.kind === 'official') {
              retired = Math.max(retired, row.drawId);
              updateRetention.run(drawAt, row.drawId);
              continue;
            }
            if (!getDraw.get(row.drawId) && row.drawId !== latestOfficialId + 1) continue;
          }
          if (row.drawId <= retired) continue;
          const retentionAt = drawAt !== null && drawAt > cutoff && drawAt <= seenAt ? drawAt : seenAt;
          const numbersJson = JSON.stringify(numbers);
          const rawJson = raw ? JSON.stringify(raw) : null;
          addDraw.run(row.drawId, seenAt, retentionAt);
          if (source.kind === 'official') {
            if (!observationAt.get(row.drawId, officialId)) newBaselines.add(row.drawId);
            latestOfficialId = Math.max(latestOfficialId ?? 0, row.drawId);
            updateRetention.run(retentionAt, row.drawId);
          } else {
            rememberReplacedNumbers.run(row.drawId, source.id, numbersJson, rawJson,
              Number(newBaselines.has(row.drawId)), row.drawId, officialId);
          }
          saveObservation.run(row.drawId, source.id, numbersJson, rawJson,
            drawAt, typeof row.timeLabel === 'string' ? row.timeLabel.slice(0, 64) : null, row.timeKind ?? null,
            Number.isFinite(row.precisionMs) ? Math.max(0, row.precisionMs) : 0, seenAt, seenAt);
          affected.add(row.drawId);
          if (source.kind === 'official') affected.add(row.drawId + 1);
        }
        if (valid === 0) {
          refreshError.run(now, '数据源没有返回可验证的开奖记录。', source.id);
        } else {
          const latest = latestObservation.get(source.id, cutoff);
          if (latest) refreshOk.run(seenAt, seenAt, latest.draw_id, latest.draw_at, source.id);
          else refreshStale.run(seenAt, source.id);
        }
      }
      markRetired.run(retired);
      const removed = prune.run(cutoff).changes;
      keepSourceLatest.run();
      const states = sourceRows.all();
      for (const draw of examineDraws.all(officialId, Math.max(cutoff, now - lateAfter * 5))) affected.add(draw.id);
      for (const drawId of affected) if (getDraw.get(drawId)) reconcile(drawId, states, now);
      db.exec('COMMIT');
      if (removed) db.exec('PRAGMA incremental_vacuum(32); PRAGMA wal_checkpoint(TRUNCATE);');
    } catch (error) {
      if (db.isTransaction) db.exec('ROLLBACK');
      throw error;
    }
  }

  return {
    record,
    dashboard(now = Date.now()) {
      const cutoff = now - retentionMs;
      return {
        generatedAt: timestamps(now), retentionHours, pollIntervalSeconds,
        sources: sourceRows.all().map(sourceState),
        draws: listDraws.all(officialId, officialId, officialId, cutoff).map(row => ({
          drawId: row.id, officialAt: timestamps(row.draw_at), officialNumbers: parseNumbers(row.numbers),
          firstSeenAt: timestamps(row.first_seen_at), total: row.total, matched: row.matched, anomalyCount: row.anomaly_count,
          numberErrorCount: row.number_error_count, openNumberErrorCount: row.open_number_error_count,
        })),
        anomalies: listAnomalies.all(cutoff).map(anomalyView),
      };
    },
    drawDetails(drawId, now = Date.now()) {
      const draw = getDraw.get(drawId);
      if (!draw || draw.retention_at <= now - retentionMs) return null;
      return {
        drawId,
        observations: rowsForDraw.all(drawId).map(row => ({
          sourceId: row.source_id, sourceName: row.name, kind: row.kind, numbers: parseNumbers(row.numbers),
          raw: parseNumbers(row.raw), drawAt: timestamps(row.draw_at), timeLabel: row.time_label, timeKind: row.time_kind,
          firstSeenAt: timestamps(row.first_seen_at), lastSeenAt: timestamps(row.last_seen_at),
        })),
        anomalies: currentAnomalies.all(drawId).map(anomalyView),
      };
    },
    health() {
      const official = getSource.get(officialId);
      return { ok: true, official: sourceState(official), sources: sourceRows.all().length };
    },
    close() { db.close(); },
  };
}
