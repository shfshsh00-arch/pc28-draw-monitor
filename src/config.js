import { join } from 'node:path';

function integer(name, fallback, { min, max }) {
  const value = process.env[name];
  if (value === undefined || value === '') return fallback;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < min || parsed > max) {
    throw new Error(`${name} must be an integer from ${min} to ${max}`);
  }
  return parsed;
}

export const retentionHours = 24;
export const retentionMs = retentionHours * 60 * 60 * 1000;
export const pollIntervalSeconds = integer('POLL_INTERVAL_SECONDS', 30, { min: 15, max: 900 });
export const pollConcurrency = integer('POLL_CONCURRENCY', 6, { min: 1, max: 12 });
export const fetchTimeoutMs = integer('FETCH_TIMEOUT_SECONDS', 9, { min: 3, max: 30 }) * 1000;
export const timeToleranceMs = integer('TIME_TOLERANCE_SECONDS', 90, { min: 60, max: 900 }) * 1000;
export const port = integer('PORT', 3000, { min: 1, max: 65535 });
export const dbPath = process.env.DB_PATH || join(process.env.RAILWAY_VOLUME_MOUNT_PATH || '.data', 'monitor.sqlite');
