import { createRow, officialTime, parseRawNumbers, reportedTime } from './normalize.js';

const BCLC = 'https://www.bclc.com/services2/keno';
const MAX_BODY_BYTES = 2_000_000;
const ROW_LIMIT = 24;
const ISO_PART = /\b\d{4}[-/]\d{2}[-/]\d{2}[ T]\d{2}:\d{2}(?::\d{2})?(?:Z|[+-]\d{2}:\d{2})?/;
const CLOCK_PART = /\b\d{2}:\d{2}(?::\d{2})?\b/;

async function read(url, signal, accept) {
  const response = await fetch(url, { signal, ...(accept ? { headers: { Accept: accept } } : {}) });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  if (!response.body || Number(response.headers.get('content-length')) > MAX_BODY_BYTES) {
    await response.body?.cancel();
    throw new Error('响应为空或过大');
  }

  const decoder = new TextDecoder();
  let total = 0;
  const parts = [];
  for await (const chunk of response.body) {
    total += chunk.byteLength;
    if (total > MAX_BODY_BYTES) throw new Error('响应过大');
    parts.push(decoder.decode(chunk, { stream: true }));
  }
  parts.push(decoder.decode());
  return parts.join('');
}

async function readJson(url, signal) {
  const body = await read(url, signal, 'application/json');
  try {
    return JSON.parse(body);
  } catch {
    throw new Error('数据接口未返回有效 JSON');
  }
}

function finish(input) {
  const rows = new Map();
  for (const row of input ?? []) {
    if (row && !rows.has(row.drawId)) rows.set(row.drawId, row);
  }
  if (!rows.size) throw new Error('未找到可核对的开奖号码');
  return [...rows.values()].sort((a, b) => b.drawId - a.drawId).slice(0, ROW_LIMIT);
}

function jsonSource(meta, endpoint, parse) {
  return {
    ...meta, kind: 'third_party',
    fetchRows: async ({ signal } = {}) => finish(parse(await readJson(endpoint, signal))),
  };
}

function stripHtml(text) {
  return text.replace(/<!--[\s\S]*?-->/g, '').replace(/<[^>]+>/g, ' ')
    .replace(/&(?:nbsp|#160);/gi, ' ').replace(/&amp;/gi, '&').replace(/\s+/g, ' ').trim();
}

function parseTables(html, { timeKind = 'draw', preferVisibleTime = false } = {}) {
  const rows = [];
  for (const row of html.matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/gi)) {
    const cells = [...row[1].matchAll(/<t[dh]\b[^>]*>([\s\S]*?)<\/t[dh]>/gi)].map((cell) => ({
      markup: cell[0], text: stripHtml(cell[1]),
    }));
    const draw = cells.findIndex((cell) => /^\d{7}$/.test(cell.text));
    let compositeTime;
    if (draw < 0) {
      const compositeId = cells[0]?.text.match(/^(\d{7}) \d{2}:\d{2}(?::\d{2})?$/);
      if (!compositeId) continue;
      compositeTime = cells[0].text.match(CLOCK_PART)?.[0];
      cells[0] = { ...cells[0], text: compositeId[1] };
    }

    const id = cells[Math.max(0, draw)].text;
    const visibleTime = cells.map((cell) => cell.text.match(ISO_PART)?.[0] ?? cell.text.match(CLOCK_PART)?.[0]).find(Boolean) ?? compositeTime;
    const time = preferVisibleTime ? visibleTime : row[1].match(ISO_PART)?.[0] ?? visibleTime;
    for (const cell of cells.slice(Math.max(0, draw) + 1)) {
      const equation = cell.markup.match(/\baria-label=["'](\d\s*\+\s*\d\s*\+\s*\d(?:\s*=\s*\d{1,2})?)["']/)?.[1];
      const cleaned = cell.text.match(/^\d\s*[+＋]\s*\d\s*[+＋]\s*\d(?:\s*=\s*\d{1,2})?\b/)?.[0] ?? cell.text;
      const result = createRow(id, equation ?? cleaned, undefined, reportedTime(time, { kind: timeKind }));
      if (result) {
        rows.push(result);
        break;
      }
    }
    if (rows.length >= ROW_LIMIT) break;
  }
  return rows;
}

function pageSource(meta, getUrl = () => meta.url, parse = parseTables) {
  return {
    ...meta, kind: 'third_party',
    fetchRows: async ({ signal } = {}) => finish(parse(await read(getUrl(), signal))),
  };
}

function beijingDay(now = Date.now()) {
  return new Date(now + 8 * 60 * 60 * 1000).toISOString().slice(0, 10);
}

function ed28Rows(html) {
  return [...html.matchAll(/\bdata-draw-result-bar\s+data-period="(\d{7})"[^>]*>[\s\S]*?\bdata-drb-a[^>]*>\s*(\d)\s*<\/span>[\s\S]*?\bdata-drb-b[^>]*>\s*(\d)\s*<\/span>[\s\S]*?\bdata-drb-c[^>]*>\s*(\d)\s*<\/span>/gi)]
    .map((row) => createRow(row[1], row.slice(2, 5)));
}

function pc2868History(data) {
  return (data.data ?? []).map((row) => createRow(row.expect, row.opencode, undefined, reportedTime(row.opentime)));
}

const official = {
  id: 'bclc', name: 'BCLC Keno', kind: 'official', group: 'BCLC 官方',
  url: 'https://www.playnow.com/keno/winning-numbers/',
  async fetchRows({ signal } = {}) {
    const stamp = Date.now();
    const [history, live] = await Promise.allSettled([
      readJson(`${BCLC}/draw/latest/20/0?_=${stamp}`, signal),
      readJson(`${BCLC}/nextdraw/?_=${stamp}`, signal),
    ]);
    if (history.status === 'rejected' && live.status === 'rejected') throw history.reason;
    const rows = Array.isArray(history.value) ? history.value.map((item) => createRow(
      item.drawNbr, undefined, item.drawNbrs, officialTime(`${item.drawDate} ${item.drawTime}`),
    )) : [];
    if (parseRawNumbers(live.value?.num)) rows.push(createRow(
      live.value.draw, undefined, live.value.num, officialTime(live.value.drawDate),
    ));
    return finish(rows);
  },
};

export const sources = [
  official,
  jsonSource({ id: 'pangu', name: '盘古 28.run', group: '盘古', url: 'https://www.28.run/' },
    'https://www.28.run/api/draws?type=6&page=1&pageSize=10',
    (data) => (data.records ?? []).map((row) => createRow(row.issue, row.numbers, row.rawNumbers, reportedTime(row.drawTime)))),
  jsonSource({ id: 'pc28-world', name: 'PC28.world', group: 'PC28.world', url: 'https://pc28.world/' },
    'https://pc28.world/api/v1/draws?limit=12',
    (data) => (data.data?.items ?? []).map((row) => createRow(row.nbr, [row.n1, row.n2, row.n3], row.keno, reportedTime(row.time)))),
  jsonSource({ id: 'kk8sss', name: 'KK8SSS', group: 'KK8SSS', url: 'https://kk8sss.com/' },
    'https://kk8sss.com/api/v1/draws?limit=12',
    (data) => (data.items ?? []).map((row) => createRow(row.draw_nbr, row.result, row.source_numbers, reportedTime(row.draw_datetime)))),
  jsonSource({ id: 'pc2868', name: 'PC2868', group: 'PC2868', url: 'https://pc2868.com/' },
    'https://pc2868.com/api.php?act=status',
    (data) => [createRow(data.last_expect, data.last_opencode, data.official_numbers, reportedTime(data.draw_time))]),
  jsonSource({ id: 'yu28', name: '与28', group: '与28', url: 'https://yu28.top/' },
    'https://pc28.help/api/kj.json?nbr=12',
    (data) => (data.data ?? []).map((row) => createRow(row.nbr, row.number, undefined, reportedTime(`${row.date} ${row.time}`)))),
  pageSource({ id: 'dake28', name: '大客28', group: '大客28', url: 'https://www.dake28.com/jnd28/kj.html' }),
  pageSource({ id: 'tianhao', name: '天豪', group: 'PC2868', url: 'https://pcjnd28.com/archive.php' }),
  pageSource({ id: 'feiji28', name: '飞机28', group: '飞机28', url: 'https://www.feiji28.com/' }),
  pageSource({ id: 'canpc28', name: 'CANPC28', group: 'CANPC28', url: 'https://canpc28.net/' }),
  pageSource({ id: '711', name: '711开奖', group: '711开奖', url: 'https://711kc.com/lottery/CA28?panel=history' }),
  pageSource({ id: 'boyi', name: '博易', group: '博易', url: 'https://www.byw.bet/lottery/canada-pc28.html' }, undefined,
    (html) => parseTables(html, { timeKind: 'observed' })),
  pageSource({ id: 'ed28', name: 'ED28', group: 'ED28', url: 'https://ed28.cn/' }, undefined, ed28Rows),
  pageSource({ id: 'jnd28-best', name: 'JND28.best', group: 'JND28.best', url: 'https://jnd28.best/' },
    () => `https://jnd28.best/pc28/day/${beijingDay()}`),
  pageSource({ id: 'kpay', name: 'KPAY', group: 'KPAY', url: 'https://www.pc28.work/' }),
  pageSource({ id: 'pc28pc', name: 'PC28PC', group: 'PC2868', url: 'https://pc28pc.net/live/' }),
  jsonSource({ id: 'zhanshen', name: '战神28', group: 'PC2868', url: 'https://pc6628.com/' },
    'https://pc6628.com/api/history?limit=20', pc2868History),
  jsonSource({ id: 'pc28pro', name: 'PC28Pro', group: 'PC2868', url: 'https://pc28pro.com/' },
    'https://pc28pro.com/api/history?limit=20', pc2868History),
  pageSource({ id: '28zx', name: '28数据站', group: 'pc28.ai', url: 'https://28zx.com/' }, undefined,
    (html) => parseTables(html, { timeKind: 'observed', preferVisibleTime: true })),
];
