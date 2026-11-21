import { fetchTimeoutMs, pollConcurrency, pollIntervalSeconds } from './config.js';

async function pollSources(sources, stopSignal) {
  const outcomes = new Array(sources.length);
  let index = 0;
  async function worker() {
    while (!stopSignal.aborted && index < sources.length) {
      const slot = index++;
      const source = sources[slot];
      const signal = AbortSignal.any([stopSignal, AbortSignal.timeout(fetchTimeoutMs)]);
      try {
        const rows = await source.fetchRows({ signal });
        if (!Array.isArray(rows)) throw new Error('数据格式不符。');
        outcomes[slot] = { sourceId: source.id, rows, seenAt: Date.now() };
      } catch (error) {
        const message = signal.aborted ? '采集请求超时。' : (error?.message || '采集失败。');
        outcomes[slot] = { sourceId: source.id, error: message };
      }
    }
  }
  const workers = Array.from({ length: Math.min(sources.length, pollConcurrency) }, () => worker());
  await Promise.all(workers);
  return outcomes.filter(Boolean);
}

export function startPolling(sources, store) {
  const control = new AbortController();
  let timer;
  let active;
  function schedule(delay) {
    if (control.signal.aborted) return;
    timer = setTimeout(() => { active = tick(); }, delay);
  }
  async function tick() {
    const started = Date.now();
    try {
      const results = await pollSources(sources, control.signal);
      if (!control.signal.aborted) store.record(results);
    } catch (error) {
      console.error('采集周期写入失败:', error.message);
    } finally {
      schedule(Math.max(1000, pollIntervalSeconds * 1000 - (Date.now() - started)));
    }
  }
  schedule(0);
  return async function stop() {
    clearTimeout(timer);
    control.abort();
    await active;
  };
}
