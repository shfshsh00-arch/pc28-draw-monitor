import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { retentionMs, retentionHours, pollIntervalSeconds, timeToleranceMs } from './config.js';
import { calculatePc28, parseRawNumbers } from './normalize.js';

const timestamps = value => Number.isFinite(value) ? new Date(value).toISOString() : null;
const parseNumbers = value => value ? JSON.parse(value) : null;
const dayMs = 24 * 60 * 60 * 1000;
const clockAgreementMs = 8_000;
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

function issueViews(rows) {
  const anomalies = [];
  const timing = [];
  for (const row of rows) {
    (row.type === 'numbers_mismatch' ? anomalies : timing).push(anomalyView(row));
  }
  return { anomalies, timing };
}

function compareTimes(official, observed) {
  const elapsed = observed.draw_at - official.draw_at;
  const clockOnly = observed.time_kind === 'clock';
  const offset = clockOnly ? elapsed - Math.round(elapsed / dayMs) * dayMs : elapsed;
  const tolerance = Math.max(timeToleranceMs, observed.precision_ms, official.precision_ms);
  return { offset, outsideTolerance: Math.abs(offset) > tolerance, clockOnly };
}

export function openStore(path, sources) {
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
      status TEXT NOT NULL DEFAULT 'pending', last_ok_at INTEGER,
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
      first_seen_at INTEGER NOT NULL, last_seen_at INTEGER NOT NULL, clock TEXT,
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
  if (!db.prepare('PRAGMA table_info(observations)').all().some(column => column.name === 'clock')) {
    db.exec('ALTER TABLE observations ADD COLUMN clock TEXT');
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
  const saveObservation = db.prepare(`INSERT INTO observations (draw_id, source_id, numbers, raw, draw_at, time_label,
    time_kind, precision_ms, first_seen_at, last_seen_at, clock) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(draw_id, source_id) DO UPDATE SET numbers=excluded.numbers, raw=excluded.raw,
      draw_at=excluded.draw_at, time_label=excluded.time_label, time_kind=excluded.time_kind,
      precision_ms=excluded.precision_ms, last_seen_at=excluded.last_seen_at, clock=excluded.clock`);
  const refreshOk = db.prepare(`UPDATE sources SET status='ok', last_ok_at=?, last_error=NULL,
    latest_draw_id=?, latest_draw_at=? WHERE id=?`);
  const refreshStale = db.prepare(`UPDATE sources SET status='stale', last_ok_at=?, last_error=NULL,
    latest_draw_id=NULL, latest_draw_at=NULL WHERE id=?`);
  const refreshError = db.prepare(`UPDATE sources SET status='error', last_error_at=?, last_error=? WHERE id=?`);
  const latestObservation = db.prepare(`SELECT o.draw_id, o.draw_at, o.clock FROM observations o JOIN draws d ON d.id=o.draw_id
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
  const currentAnomalies = db.prepare(`SELECT * FROM anomalies WHERE draw_id=?
    AND type IN ('numbers_mismatch','reference_clock','source_clock') ORDER BY status, type, source_id`);
  const latestTimePair = db.prepare(`SELECT a.draw_id, a.draw_at, a.time_kind, a.precision_ms,
    b.draw_at AS official_at, b.precision_ms AS official_precision FROM observations a
    JOIN observations b ON a.draw_id=b.draw_id JOIN draws d ON a.draw_id=d.id
    WHERE a.source_id=? AND b.source_id=? AND d.retention_at>? AND b.clock IS NOT NULL
      AND a.time_kind IN ('draw','clock') AND a.draw_at IS NOT NULL AND b.draw_at IS NOT NULL
    ORDER BY a.draw_id DESC LIMIT 1`);
  const upsertAnomaly = db.prepare(`INSERT INTO anomalies (draw_id, source_id, type, status, first_seen_at, last_seen_at,
    detail, official_numbers, source_numbers, official_at, source_at, evidence) VALUES (?, ?, ?, 'open', ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(draw_id, source_id, type) DO UPDATE SET status='open', last_seen_at=excluded.last_seen_at,
      detail=excluded.detail, official_numbers=excluded.official_numbers, source_numbers=excluded.source_numbers,
      official_at=excluded.official_at, source_at=excluded.source_at, evidence=excluded.evidence`);
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
    (SELECT COUNT(*) FROM anomalies f WHERE f.draw_id=d.id AND f.type='numbers_mismatch') AS number_error_count,
    (SELECT COUNT(*) FROM anomalies f WHERE f.draw_id=d.id AND f.type='numbers_mismatch' AND f.status='open') AS open_number_error_count
    FROM draws d LEFT JOIN observations o ON d.id=o.draw_id AND o.source_id=?
    WHERE d.retention_at>? ORDER BY d.id DESC`);
  const listAnomalies = db.prepare(`SELECT a.* FROM anomalies a JOIN draws d ON d.id=a.draw_id
    WHERE d.retention_at>? AND a.type IN ('numbers_mismatch','reference_clock','source_clock')
    ORDER BY (a.status='open') DESC, a.draw_id DESC, a.last_seen_at DESC`);

  function setAnomaly(drawId, sourceId, type, detail, official, observation, now, evidence = null) {
    upsertAnomaly.run(drawId, sourceId, type, now, now, detail, official.numbers,
      observation.numbers, official.draw_at, observation.draw_at, evidence);
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
        Math.abs(observed.draw_at - official.draw_at) > timeToleranceMs) {
      const margin = Math.max(1000, observed.precision_ms);
      priorDrawId = earlierOfficialTimeAndNumbers.get(officialId, official.draw_id, observed.numbers,
        observed.draw_at - margin, observed.draw_at + margin, observed.draw_at)?.draw_id ?? null;
      if (priorDrawId !== null) priorMatch = 'time_and_numbers';
    }
    const detail = wrongNumbers ? '同一期三位数与 BCLC 原始号码复算结果不同。' : '三位数相同，但来源提供的 Keno 20 码与 BCLC 不同。';
    const evidence = JSON.stringify({
      officialRaw: parseNumbers(official.raw), sourceRaw: parseNumbers(observed.raw), rawMismatch, priorDrawId, priorMatch,
    });
    setAnomaly(official.draw_id, observed.source_id, 'numbers_mismatch', detail, official, observed, now, evidence);
    return true;
  }

  function reconcile(drawId, now) {
    const observations = rowsForDraw.all(drawId);
    const official = observations.find(row => row.source_id === officialId);
    if (!official) return;
    for (const replaced of pendingNumberEvidence.all(drawId)) flagNumberError(official, replaced, now);
    clearPendingNumberEvidence.run(drawId);
    const clock = official.clock ? JSON.parse(official.clock) : null;
    if (clock && Number.isFinite(clock.offsetSeconds)) {
      if (Math.abs(clock.offsetSeconds) > clockAgreementMs / 1000) {
        const detail = `BCLC 标注时间比核验后的基准${clock.offsetSeconds > 0 ? '晚' : '早'} ${Math.abs(clock.offsetSeconds)} 秒，已校正本站基准。`;
        setAnomaly(drawId, officialId, 'reference_clock', detail, official,
          { ...official, draw_at: Date.parse(clock.reportedAt) }, now);
      } else resolveAnomaly.run(now, drawId, officialId, 'reference_clock');
    }
    for (const observed of observations) {
      if (observed.source_id === officialId) continue;
      if (!flagNumberError(official, observed, now)) {
        resolveNumberError.run(now, drawId, observed.source_id, Number(Boolean(observed.raw)));
      }

      if (clock && ['draw', 'clock'].includes(observed.time_kind) &&
          official.draw_at !== null && observed.draw_at !== null) {
        const { offset, outsideTolerance, clockOnly } = compareTimes(official, observed);
        if (outsideTolerance) {
          const duration = Math.round(Math.abs(offset) / 1000);
          const estimate = clockOnly ? '来源仅提供时分，按最接近官方时刻的日期比较。' : '';
          const detail = `来源标注的开奖时间比核验后的 BCLC 基准${offset > 0 ? '晚' : '早'} ${duration} 秒。${estimate}`;
          setAnomaly(drawId, observed.source_id, 'source_clock', detail, official, { ...observed, draw_at: official.draw_at + offset }, now);
        } else resolveAnomaly.run(now, drawId, observed.source_id, 'source_clock');
      }
    }
  }

  function officialClock(cutoff) {
    const current = latestObservation.get(officialId, cutoff);
    const clock = current?.clock ? JSON.parse(current.clock) : null;
    const corrected = clock && (clock.offsetSeconds === null || Math.abs(clock.offsetSeconds) > clockAgreementMs / 1000);
    return {
      status: corrected ? 'corrected' : clock ? 'verified' : 'unverified',
      drawId: current?.draw_id ?? null, referenceAt: clock ? timestamps(current.draw_at) : null,
      reportedAt: clock ? clock.reportedAt : timestamps(current?.draw_at),
      checkedAt: clock?.checkedAt ?? null, offsetSeconds: clock?.offsetSeconds ?? null,
    };
  }

  function sourceTimes(states, cutoff) {
    const times = [];
    for (const source of states) {
      if (source.id === officialId) continue;
      const pair = latestTimePair.get(source.id, officialId, cutoff);
      if (!pair) continue;
      const { offset, outsideTolerance } = compareTimes({ draw_at: pair.official_at, precision_ms: pair.official_precision }, pair);
      times.push({
        sourceId: source.id, drawId: pair.draw_id, officialAt: timestamps(pair.official_at), sourceAt: timestamps(pair.official_at + offset),
        offsetSeconds: Math.round(offset / 1000), status: outsideTolerance ? 'offset' : 'aligned',
      });
    }
    return times;
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
          let drawAt = Number.isFinite(parsedDate) ? parsedDate : null;
          let timeKind = row.timeKind ?? null;
          let precision = Number.isFinite(row.precisionMs) ? Math.max(0, row.precisionMs) : 0;
          const previousOfficial = source.kind === 'official' ? observationAt.get(row.drawId, officialId) : null;
          let clock = source.kind === 'official' && drawAt !== null ? row.clock : null;
          if (!clock && previousOfficial?.clock) {
            clock = JSON.parse(previousOfficial.clock);
            if (row.timeOrigin === 'archive' && drawAt !== null) {
              clock.reportedAt = timestamps(drawAt);
              clock.offsetSeconds = Math.round((drawAt - previousOfficial.draw_at) / 1000);
            }
            drawAt = previousOfficial.draw_at;
            timeKind = previousOfficial.time_kind;
            precision = previousOfficial.precision_ms;
          }
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
            if (!previousOfficial) newBaselines.add(row.drawId);
            latestOfficialId = Math.max(latestOfficialId ?? 0, row.drawId);
            updateRetention.run(retentionAt, row.drawId);
          } else {
            rememberReplacedNumbers.run(row.drawId, source.id, numbersJson, rawJson,
              Number(newBaselines.has(row.drawId)), row.drawId, officialId);
          }
          saveObservation.run(row.drawId, source.id, numbersJson, rawJson,
            drawAt, typeof row.timeLabel === 'string' ? row.timeLabel.slice(0, 64) : null, timeKind,
            precision, seenAt, seenAt, clock ? JSON.stringify(clock) : null);
          affected.add(row.drawId);
        }
        if (valid === 0) {
          refreshError.run(now, '数据源没有返回可验证的开奖记录。', source.id);
        } else {
          const latest = latestObservation.get(source.id, cutoff);
          if (latest) refreshOk.run(seenAt, latest.draw_id, latest.draw_at, source.id);
          else refreshStale.run(seenAt, source.id);
        }
      }
      markRetired.run(retired);
      const removed = prune.run(cutoff).changes;
      keepSourceLatest.run();
      for (const drawId of affected) reconcile(drawId, now);
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
      const states = sourceRows.all();
      return {
        generatedAt: timestamps(now), retentionHours, pollIntervalSeconds,
        sources: states.map(sourceState), referenceClock: officialClock(cutoff), timeSources: sourceTimes(states, cutoff),
        draws: listDraws.all(officialId, officialId, officialId, cutoff).map(row => ({
          drawId: row.id, officialAt: timestamps(row.draw_at), officialNumbers: parseNumbers(row.numbers),
          firstSeenAt: timestamps(row.first_seen_at), total: row.total, matched: row.matched, anomalyCount: row.number_error_count,
          numberErrorCount: row.number_error_count, openNumberErrorCount: row.open_number_error_count,
        })),
        ...issueViews(listAnomalies.all(cutoff)),
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
        ...issueViews(currentAnomalies.all(drawId)),
      };
    },
    health() {
      const official = getSource.get(officialId);
      return { ok: true, official: sourceState(official), sources: sourceRows.all().length };
    },
    close() { db.close(); },
  };
}
