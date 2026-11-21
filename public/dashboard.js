const byId = id => document.getElementById(id);
const emptyValue = '—';
const displayDate = new Intl.DateTimeFormat('zh-CN', {
  timeZone: 'Asia/Shanghai', month: '2-digit', day: '2-digit',
  hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
});
const anomalyLabels = {
  numbers_mismatch: ['号码不一致', 'error'],
  time_mismatch: ['开奖时间偏差', 'warning'],
  late_source: ['来源延迟', 'warning'],
  missing_result: ['来源缺期', 'error'],
};
const sourceLabels = { ok: ['在线', 'ok'], error: ['采集异常', 'error'], stale: ['数据过期', 'warning'], pending: ['等待采集', 'pending'] };
const viewLabels = { overview: '监控总览', anomalies: '异常记录', sources: '数据源' };
const timeLabels = { draw: '开奖时间', clock: '来源仅提供时分', observed: '记录时间', uncertain: '时间口径待确认' };
const pageSize = 12;
const pages = { draw: 1, anomaly: 1 };
let dashboard = null;
let refreshTimer;
let loadingDashboard = false;
let detailRequest = 0;

function escapeText(value) {
  return String(value ?? '').replace(/[&<>"']/g, char => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  })[char]);
}

function availableUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' ? url.href : null;
  } catch {
    return null;
  }
}

function displayTime(value) {
  if (!value) return emptyValue;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? emptyValue : displayDate.format(date);
}

function timeMarkup(value) {
  return escapeText(displayTime(value));
}

function numbersMarkup(numbers, fallback = emptyValue) {
  if (!Array.isArray(numbers) || numbers.length !== 3 || !numbers.every(number => Number.isInteger(number) && number >= 0 && number <= 9)) {
    return '<span class="quiet">' + escapeText(fallback) + '</span>';
  }
  const sum = numbers.reduce((total, number) => total + number, 0);
  return '<span class="numbers" aria-label="' + escapeText(numbers.join('加') + '等于' + sum) + '">' +
    numbers.map(number => '<b>' + number + '</b>').join('<span aria-hidden="true">+</span>') +
    '<span class="sum">= ' + sum + '</span></span>';
}

function setText(id, value) {
  byId(id).textContent = value;
}

function badge(label, color) {
  return '<span class="badge badge-' + color + '">' + escapeText(label) + '</span>';
}

function rowState(draw) {
  if (draw.anomalyCount) return ['anomaly', '有异常记录', 'warning'];
  if (draw.officialNumbers && draw.total && draw.matched === draw.total) return ['matched', '号码一致', 'ok'];
  return ['pending', '待对账', 'pending'];
}

function drawButton(drawId) {
  if (!Number.isSafeInteger(drawId)) return emptyValue;
  return '<button type="button" class="draw-link" data-draw="' + drawId + '" aria-label="查看第 ' + drawId + ' 期详情">' + drawId + '</button>';
}

function setEmpty(id, show, title, subtitle = '') {
  const node = byId(id);
  node.hidden = !show;
  if (show) {
    node.innerHTML = '<i class="empty-icon" aria-hidden="true"></i><strong>' +
      escapeText(title) + '</strong>' + (subtitle ? '<span>' + escapeText(subtitle) + '</span>' : '');
  }
}

function paginate(type, items) {
  const totalPages = Math.max(1, Math.ceil(items.length / pageSize));
  pages[type] = Math.max(1, Math.min(pages[type], totalPages));
  byId(type + '-pages').hidden = items.length <= pageSize;
  setText(type + '-page-label', '第 ' + pages[type] + ' / ' + totalPages + ' 页 · 共 ' + items.length + ' 条');
  byId(type + '-prev').disabled = pages[type] <= 1;
  byId(type + '-next').disabled = pages[type] >= totalPages;
  const start = (pages[type] - 1) * pageSize;
  return items.slice(start, start + pageSize);
}

function sourceName(sourceId) {
  return dashboard?.sources.find(source => source.id === sourceId)?.name || sourceId;
}

function renderDraws() {
  if (!dashboard) return;
  const search = byId('draw-query').value.trim().replace(/^#/, '');
  const filter = byId('draw-filter').value;
  const filtered = dashboard.draws.filter(draw => String(draw.drawId).includes(search) &&
    (filter === 'all' || rowState(draw)[0] === filter));
  byId('draw-rows').innerHTML = paginate('draw', filtered).map(draw => {
    const [status, label, color] = rowState(draw);
    const comparison = draw.officialNumbers && draw.matched !== null && draw.matched !== undefined
      ? '<strong>' + escapeText(draw.matched) + '</strong> / ' + escapeText(draw.total)
      : emptyValue + ' / ' + escapeText(draw.total);
    return '<tr' + (status === 'anomaly' ? ' class="row-anomaly"' : '') + '><td>' + drawButton(draw.drawId) +
      '</td><td>' + numbersMarkup(draw.officialNumbers, '等候官方') +
      '</td><td class="date-cell">' + timeMarkup(draw.officialAt) +
      '</td><td class="count-cell">' + comparison + '</td><td>' + badge(label, color) + '</td></tr>';
  }).join('');
  setEmpty('draw-empty', !filtered.length, search || filter !== 'all' ? '没有符合筛选条件的期号' : '还没有采集到开奖记录',
    search || filter !== 'all' ? '可修改搜索词或选择全部状态。' : '采集成功后，期号会自动出现在这里。');
}

function anomalyComparison(issue) {
  if (issue.type === 'numbers_mismatch') {
    const format = values => Array.isArray(values) ? escapeText(values.join(' + ')) : emptyValue;
    return '<span class="compare-line">官方 ' + format(issue.officialNumbers) + '</span><span class="compare-line">来源 ' + format(issue.sourceNumbers) + '</span>';
  }
  if (issue.type === 'time_mismatch') {
    return '<span class="compare-line">官方 ' + timeMarkup(issue.officialAt) + '</span><span class="compare-line">来源 ' + timeMarkup(issue.sourceAt) + '</span>';
  }
  return '';
}

function renderAnomalies() {
  if (!dashboard) return;
  const search = byId('anomaly-query').value.trim().toLocaleLowerCase();
  const type = byId('anomaly-type').value;
  const status = byId('anomaly-status').value;
  const items = dashboard.anomalies.filter(issue =>
    (type === 'all' || issue.type === type) && (status === 'all' || issue.status === status) &&
    (String(issue.drawId).includes(search) || String(sourceName(issue.sourceId)).toLocaleLowerCase().includes(search)));
  byId('anomaly-rows').innerHTML = paginate('anomaly', items).map(issue => {
    const [label, color] = anomalyLabels[issue.type] || ['数据异常', 'warning'];
    return '<tr><td>' + drawButton(issue.drawId) + '</td><td>' + escapeText(sourceName(issue.sourceId)) +
      '</td><td>' + badge(label, color) + '</td><td class="issue-detail">' + escapeText(issue.detail) +
      anomalyComparison(issue) + '</td><td class="date-cell">' + timeMarkup(issue.firstSeenAt) +
      '</td><td>' + (issue.status === 'resolved' ? badge('已恢复', 'ok') : badge('待核查', 'warning')) + '</td></tr>';
  }).join('');
  const filtering = search || type !== 'all' || status !== 'all';
  setEmpty('anomaly-empty', !items.length, filtering ? '没有符合筛选条件的异常' : '近 24 小时暂无异常记录',
    filtering ? '可修改搜索词或筛选条件。' : '检测出差异后会自动标记。');
}

function renderSources() {
  const sources = dashboard.sources;
  const statusOrder = { error: 1, stale: 2, pending: 3, ok: 4 };
  const previewOrder = [...sources].sort((a, b) => {
    const weight = source => source.kind === 'official' ? 0 : (statusOrder[source.status] ?? 3);
    return weight(a) - weight(b);
  });
  byId('source-preview').innerHTML = previewOrder.slice(0, 7).map(source => {
    const [label, color] = sourceLabels[source.status] || sourceLabels.pending;
    const subtitle = source.kind === 'official' ? '官方开奖 · ' : '';
    return '<div class="source-item"><div class="source-identity"><i class="status-dot status-' + color +
      '" aria-hidden="true"></i><div><div class="source-name">' + escapeText(source.name) +
      '</div><div class="source-id">' + subtitle +
      (source.latestDrawId ? '第 ' + escapeText(source.latestDrawId) + ' 期' : '暂无期号') +
      '</div></div></div>' + badge(label, color) + '</div>';
  }).join('');
  byId('source-preview-empty').hidden = sources.length > 0;
  setText('source-count-label', '共 ' + sources.length + ' 个');
  byId('source-rows').innerHTML = sources.map(source => {
    const [label, color] = sourceLabels[source.status] || sourceLabels.pending;
    const url = availableUrl(source.url);
    const title = url ? '<a class="source-name" href="' + escapeText(url) + '" target="_blank" rel="noopener noreferrer">' +
      escapeText(source.name) + '</a>' : '<span class="source-name">' + escapeText(source.name) + '</span>';
    const group = source.kind === 'official' ? '官方基准' : (source.group || '第三方');
    const problem = source.status === 'error' ? (source.lastError || '采集请求失败') :
      source.status === 'stale' ? '接口有响应，暂无近 24 小时内的有效开奖' : emptyValue;
    return '<tr><td>' + title + '<span class="section-label">' + escapeText(group) + '</span></td><td>' +
      badge(label, color) + '</td><td>' + (source.latestDrawId ? drawButton(source.latestDrawId) : emptyValue) +
      '</td><td class="date-cell">' + timeMarkup(source.lastOkAt) + '</td><td class="source-error">' +
      escapeText(problem) + '</td></tr>';
  }).join('');
  setEmpty('source-empty', !sources.length, '暂无配置的数据源');
}

function renderDashboard() {
  const { sources, anomalies, draws } = dashboard;
  const online = sources.filter(source => source.status === 'ok').length;
  const offline = sources.filter(source => source.status === 'error').length;
  const stale = sources.filter(source => source.status === 'stale').length;
  const pending = sources.filter(source => source.status === 'pending').length;
  const open = anomalies.filter(issue => issue.status === 'open').length;
  const official = sources.find(source => source.kind === 'official');
  const reference = draws.find(draw => draw.officialNumbers);
  const referenceId = official?.latestDrawId || reference?.drawId;
  const referenceMatch = draws.find(draw => draw.drawId === referenceId);
  setText('last-update', displayTime(dashboard.generatedAt));
  setText('reference-draw', referenceId ?? emptyValue);
  setText('reference-time', displayTime(referenceMatch?.officialAt || official?.latestDrawAt));
  byId('reference-numbers').innerHTML = numbersMarkup(referenceMatch?.officialNumbers, '等待官方数据');
  setText('metric-sources', online + ' / ' + sources.length);
  const problems = [offline && offline + ' 个采集异常', stale && stale + ' 个数据过期', pending && pending + ' 个等待采集'].filter(Boolean);
  setText('metric-source-detail', problems.join(' · ') || (sources.length ? '暂无采集异常' : '等待配置数据源'));
  setText('metric-draws', draws.length);
  setText('retention-copy', '最近 ' + (dashboard.retentionHours || 24) + ' 小时');
  setText('metric-alerts', open);
  byId('metric-alerts').classList.toggle('has-alerts', open > 0);
  setText('nav-anomaly-count', open);
  byId('nav-anomaly-count').hidden = open === 0;
  const state = offline ? 'error' : stale ? 'warning' : online ? 'ok' : 'pending';
  byId('sidebar-dot').className = 'status-dot status-' + state;
  setText('sidebar-status', offline || stale ? '部分来源采集异常' : online ? '采集服务运行中' : '等待首次采集');
  setText('sidebar-cadence', '采集间隔 ' + (dashboard.pollIntervalSeconds || 30) + ' 秒');
  const notice = byId('notice');
  if (!official || official.status !== 'ok') {
    notice.hidden = false;
    notice.textContent = official?.status === 'stale' ? 'BCLC 官方源尚未返回近 24 小时内的开奖。' : official?.status === 'error'
      ? 'BCLC 官方源最近一次采集失败。已有记录仍可查看，尚未取得官方号码的期次会保留为待对账。'
      : '正在等待 BCLC 官方基准。';
  } else {
    notice.hidden = true;
  }
  renderDraws();
  renderAnomalies();
  renderSources();
}

async function fetchJson(url) {
  const response = await fetch(url, { headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(12_000) });
  const body = await response.json();
  if (!response.ok) throw new Error(body.error || '无法读取记录');
  return body;
}

async function refreshDashboard() {
  if (loadingDashboard) return;
  clearTimeout(refreshTimer);
  loadingDashboard = true;
  byId('refresh-button').setAttribute('aria-busy', 'true');
  try {
    dashboard = await fetchJson('/api/dashboard');
    renderDashboard();
  } catch {
    const notice = byId('notice');
    notice.hidden = false;
    notice.textContent = dashboard ? '本次刷新失败，页面暂时保留上一次成功读取的内容。' : '暂时无法连接监控服务。可以点击刷新重试。';
    if (!dashboard) {
      setEmpty('draw-empty', true, '未能读取对账记录');
      setEmpty('anomaly-empty', true, '未能读取异常记录');
      setEmpty('source-empty', true, '未能读取数据源');
    }
  } finally {
    loadingDashboard = false;
    byId('refresh-button').removeAttribute('aria-busy');
    refreshTimer = setTimeout(refreshDashboard, Math.max(5, dashboard?.pollIntervalSeconds || 30) * 1000);
  }
}

function changeView(view, updateHash = true) {
  if (!Object.hasOwn(viewLabels, view)) view = 'overview';
  for (const name of Object.keys(viewLabels)) {
    byId('view-' + name).hidden = name !== view;
  }
  document.querySelectorAll('.navigation [data-view]').forEach(button => {
    if (button.dataset.view === view) button.setAttribute('aria-current', 'page');
    else button.removeAttribute('aria-current');
  });
  setText('view-title', viewLabels[view]);
  if (updateHash && window.location.hash !== '#' + view) {
    window.location.hash = view;
    window.scrollTo(0, 0);
  }
}

function detailTable(data) {
  const issues = data.anomalies.map(issue => {
    const [label] = anomalyLabels[issue.type] || ['数据异常'];
    return '<div><strong>' + escapeText(label) + ' · ' + escapeText(sourceName(issue.sourceId)) + '</strong><span>' +
      escapeText(issue.detail) + '</span></div>';
  }).join('');
  const official = data.observations.find(source => source.kind === 'official');
  const rows = data.observations.map(source => {
    const sourceIssues = data.anomalies.filter(issue => issue.sourceId === source.sourceId);
    const comparison = source.kind === 'official' ? badge('官方基准', 'info') : sourceIssues.some(issue => issue.status === 'open')
      ? badge('待核查', 'warning') : sourceIssues.length ? badge('有异常记录', 'info') : official
        ? badge('号码一致', 'ok') : badge('待官方', 'pending');
    const raw = Array.isArray(source.raw) && source.raw.length === 20
      ? '<details class="section-label"><summary>Keno 原始 20 码</summary>' + escapeText(source.raw.join('、')) + '</details>'
      : '';
    const shownTime = source.drawAt ? timeMarkup(source.drawAt) : escapeText(source.timeLabel || emptyValue);
    const timeKind = timeLabels[source.timeKind] || '';
    return '<tr><td>' + escapeText(source.sourceName || source.sourceId) + '</td><td>' +
      numbersMarkup(source.numbers) + raw + '</td><td class="date-cell">' + shownTime +
      (timeKind ? '<span class="section-label">' + escapeText(timeKind) + '</span>' : '') + '</td><td class="date-cell">' +
      timeMarkup(source.firstSeenAt) + '</td><td>' + comparison + '</td></tr>';
  }).join('');
  return (issues ? '<div class="dialog-alerts">' + issues + '</div>' : '') +
    '<div class="table-wrap"><table class="table" aria-label="逐源核对结果"><thead><tr><th scope="col">数据源</th>' +
    '<th scope="col">开奖号码</th><th scope="col">来源时间</th><th scope="col">首次采集</th><th scope="col">状态</th></tr></thead>' +
    '<tbody>' + rows + '</tbody></table></div>';
}

async function showDraw(drawId) {
  const request = ++detailRequest;
  const dialog = byId('draw-dialog');
  setText('detail-title', '第 ' + drawId + ' 期');
  byId('detail-content').innerHTML = '<div class="empty"><strong>正在读取各来源结果</strong></div>';
  if (!dialog.open) dialog.showModal();
  try {
    const data = await fetchJson('/api/draws/' + encodeURIComponent(drawId));
    if (request === detailRequest && dialog.open) byId('detail-content').innerHTML = detailTable(data);
  } catch {
    if (request === detailRequest && dialog.open) {
      byId('detail-content').innerHTML = '<div class="empty"><strong>找不到该期详情</strong><span>记录可能已超出 24 小时，或服务暂时不可用。</span></div>';
    }
  }
}

document.addEventListener('click', event => {
  const navigation = event.target.closest('[data-view]');
  if (navigation) changeView(navigation.dataset.view);
  const draw = event.target.closest('[data-draw]');
  if (draw) showDraw(draw.dataset.draw);
});
byId('refresh-button').addEventListener('click', refreshDashboard);
byId('detail-close').addEventListener('click', () => byId('draw-dialog').close());
byId('draw-dialog').addEventListener('click', event => {
  if (event.target === byId('draw-dialog')) byId('draw-dialog').close();
});
window.addEventListener('hashchange', () => changeView(window.location.hash.slice(1), false));

for (const [type, render, controlIds] of [
  ['draw', renderDraws, ['draw-query', 'draw-filter']],
  ['anomaly', renderAnomalies, ['anomaly-query', 'anomaly-type', 'anomaly-status']],
]) {
  for (const id of controlIds) {
    const control = byId(id);
    control.addEventListener(control.tagName === 'INPUT' ? 'input' : 'change', () => {
      pages[type] = 1;
      render();
    });
  }
  byId(type + '-prev').addEventListener('click', () => { pages[type] -= 1; render(); });
  byId(type + '-next').addEventListener('click', () => { pages[type] += 1; render(); });
}

changeView(window.location.hash.slice(1), false);
refreshDashboard();
