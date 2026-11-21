const LOCAL_TIME = /^(\d{4})[-/](\d{2})[-/](\d{2})[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,3}))?)?$/;
const ENGLISH_TIME = /^([A-Za-z]{3}) (\d{1,2}), (\d{4}) (\d{1,2}):(\d{2}):(\d{2}) (AM|PM)$/i;
const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 86_400_000;

export function parseRawNumbers(value) {
  if (!Array.isArray(value) || value.length !== 20) return undefined;
  const numbers = value.map(Number);
  if (numbers.some((number) => !Number.isInteger(number) || number < 1 || number > 80)) return undefined;
  if (new Set(numbers).size !== 20) return undefined;
  return numbers.sort((a, b) => a - b);
}

export function calculatePc28(value) {
  const raw = parseRawNumbers(value);
  if (!raw) return undefined;
  return [1, 2, 3].map((start) => {
    let total = 0;
    for (let index = start; index < 19; index += 3) total += raw[index];
    return total % 10;
  });
}

export function parsePc28(value) {
  if (Array.isArray(value)) {
    if (value.length !== 3 || value.some((digit) => !/^\d$/.test(String(digit)))) return undefined;
    return value.map(Number);
  }

  const match = String(value ?? '').trim().match(/^(\d)\s*(?:[+,，＋]|\s)\s*(\d)\s*(?:[+,，＋]|\s)\s*(\d)(?:\s*=\s*\d{1,2})?$/);
  return match ? match.slice(1, 4).map(Number) : undefined;
}

function wallTime(text) {
  const parts = new Array(7).fill(0);
  const numeric = LOCAL_TIME.exec(text);
  const english = ENGLISH_TIME.exec(text);
  if (numeric) {
    for (let index = 0; index < 6; index += 1) parts[index] = Number(numeric[index + 1] ?? 0);
    parts[6] = Number((numeric[7] || '').padEnd(3, '0'));
  } else if (english) {
    parts[0] = Number(english[3]);
    parts[1] = MONTHS.indexOf(english[1].toLowerCase()) + 1;
    parts[2] = Number(english[2]);
    parts[3] = Number(english[4]) % 12 + (english[7].toUpperCase() === 'PM' ? 12 : 0);
    parts[4] = Number(english[5]);
    parts[5] = Number(english[6]);
    if (Number(english[4]) < 1 || Number(english[4]) > 12) return undefined;
  } else {
    return undefined;
  }

  const [year, month, day, hour, minute, second, ms] = parts;
  const utc = Date.UTC(year, month - 1, day, hour, minute, second, ms);
  const check = new Date(utc);
  if (check.getUTCFullYear() !== year || check.getUTCMonth() !== month - 1 || check.getUTCDate() !== day ||
      check.getUTCHours() !== hour || check.getUTCMinutes() !== minute || check.getUTCSeconds() !== second) return undefined;
  return { utc, year, month, day, hour, precisionMs: numeric && !numeric[6] ? MINUTE : 1000 };
}

function sunday(year, month, count) {
  const weekday = new Date(Date.UTC(year, month - 1, 1)).getUTCDay();
  return 1 + ((7 - weekday) % 7) + (count - 1) * 7;
}

export function officialTime(value) {
  const timeLabel = String(value ?? '').trim();
  const local = wallTime(timeLabel);
  if (!local) return timeLabel ? { timeLabel, timeKind: 'uncertain' } : {};

  const { utc, year, month, day, hour, precisionMs } = local;
  const spring = sunday(year, 3, 2);
  const autumn = sunday(year, 11, 1);
  const skippedHour = year <= 2026 && month === 3 && day === spring && hour === 2;
  const repeatedHour = year < 2026 && month === 11 && day === autumn && hour === 1;
  if (skippedHour || repeatedHour) return { timeLabel, timeKind: 'uncertain' };

  // B.C. remains on UTC−07:00 after its last spring-forward in March 2026.
  const permanentPacific = utc >= Date.UTC(2026, 2, 8, 3);
  const historicalSummer = (month > 3 || (month === 3 && (day > spring || (day === spring && hour >= 3)))) &&
    (month < 11 || (month === 11 && (day < autumn || (day === autumn && hour < 2))));
  const offsetHours = permanentPacific || historicalSummer ? 7 : 8;
  return { drawAt: new Date(utc + offsetHours * 60 * MINUTE).toISOString(), timeLabel, timeKind: 'draw', precisionMs };
}

export function calibrateOfficialClock({ requestStartedAt, responseReceivedAt, serverDate, age,
  elapsedMs, liveTime, archiveTime, observedArchive = archiveTime !== undefined }) {
  const origin = Date.parse(serverDate ?? '');
  if (!Number.isFinite(origin) || !Number.isFinite(requestStartedAt) || !Number.isFinite(responseReceivedAt) ||
      responseReceivedAt < requestStartedAt || responseReceivedAt - requestStartedAt > 15_000 ||
      origin < requestStartedAt - 5000 || origin > responseReceivedAt + 5000 ||
      (age != null && String(age).trim() !== '0') ||
      !Number.isFinite(elapsedMs) || elapsedMs < 0 || elapsedMs > 215_000) return undefined;

  const live = officialTime(liveTime);
  const archive = officialTime(archiveTime);
  const candidates = [live, archive].map((entry) => ({ entry, epoch: Date.parse(entry.drawAt ?? '') }))
    .filter((entry) => Number.isFinite(entry.epoch));
  const elapsedEstimate = origin - elapsedMs;
  const fitted = candidates.map(({ epoch }) => {
    const hours = Math.round((epoch - elapsedEstimate) / HOUR);
    return { hours, epoch: epoch - hours * HOUR };
  }).filter(({ hours, epoch }) => Math.abs(hours) <= 2 && Math.abs(epoch - elapsedEstimate) <= 4000)
    .sort((a, b) => Math.abs(a.hours) - Math.abs(b.hours));

  let canonical = fitted[0]?.epoch;
  if (canonical === undefined && candidates.length === 0) {
    // The server Date header only has second precision. Use a nearby Keno slot when the wall times are unusable.
    const slot = Math.round(elapsedEstimate / 30_000) * 30_000;
    if (Math.abs(slot - elapsedEstimate) <= 4000) canonical = slot;
  }
  if (canonical === undefined) return undefined;

  const archiveAt = Date.parse(archive.drawAt ?? '');
  const liveAt = Date.parse(live.drawAt ?? '');
  const offsetArchive = Number.isFinite(archiveAt) && Math.abs(archiveAt - canonical) > 8000;
  const offsetLive = Number.isFinite(liveAt) && Math.abs(liveAt - canonical) > 8000;
  const reported = offsetArchive ? archive : offsetLive ? live : archive.drawAt ? archive : live;
  const reportedAt = reported.drawAt ?? null;
  return {
    drawAt: new Date(canonical).toISOString(), timeKind: 'draw', precisionMs: 1000,
    timeLabel: reported.timeLabel ?? live.timeLabel ?? archive.timeLabel,
    clock: {
      checkedAt: new Date(responseReceivedAt).toISOString(), reportedAt,
      offsetSeconds: reportedAt === null ? null : Math.round((Date.parse(reportedAt) - canonical) / 1000),
      observedArchive,
    },
  };
}

export function reportedTime(value, { kind = 'draw', now = Date.now() } = {}) {
  const timeLabel = String(value ?? '').trim();
  if (!timeLabel) return {};

  const local = wallTime(timeLabel);
  if (local) {
    return {
      timeLabel, timeKind: kind, precisionMs: local.precisionMs,
      drawAt: new Date(local.utc - 8 * 60 * MINUTE).toISOString(),
    };
  }

  const explicitOffset = /\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})$/i.test(timeLabel);
  if (explicitOffset && Number.isFinite(Date.parse(timeLabel))) {
    return { timeLabel, timeKind: kind, drawAt: new Date(timeLabel).toISOString(), precisionMs: 1000 };
  }

  const short = /^(\d{2}):(\d{2})(?::(\d{2}))?$/.exec(timeLabel);
  if (short && Number(short[1]) < 24 && Number(short[2]) < 60 && Number(short[3] ?? 0) < 60) {
    const midnight = Math.floor((now + 8 * 60 * MINUTE) / DAY) * DAY - 8 * 60 * MINUTE;
    const today = midnight + Number(short[1]) * 60 * MINUTE + Number(short[2]) * MINUTE + Number(short[3] ?? 0) * 1000;
    const estimate = [today, today - DAY, today + DAY].sort((a, b) => Math.abs(a - now) - Math.abs(b - now))[0];
    return {
      timeLabel, timeKind: kind === 'draw' ? 'clock' : kind, precisionMs: short[3] ? 1000 : MINUTE,
      drawAt: new Date(estimate).toISOString(),
    };
  }
  return { timeLabel, timeKind: 'uncertain' };
}

export function createRow(drawId, values, rawValues, time = {}) {
  const id = Number(drawId);
  if (!Number.isSafeInteger(id) || id < 1) return undefined;
  const raw = parseRawNumbers(rawValues);
  const numbers = parsePc28(values) ?? calculatePc28(raw);
  if (!numbers) return undefined;
  return { drawId: id, numbers, ...(raw ? { raw } : {}), ...time };
}
