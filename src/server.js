import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { dbPath, port } from './config.js';
import { sources } from './sources.js';
import { openStore } from './store.js';
import { startPolling } from './poller.js';

const store = openStore(dbPath, sources);
store.record([]);
const files = new Map([
  ['/', ['index.html', 'text/html; charset=utf-8']],
  ['/styles.css', ['styles.css', 'text/css; charset=utf-8']],
  ['/dashboard.js', ['dashboard.js', 'text/javascript; charset=utf-8']],
].map(([route, [file, contentType]]) => [route, { contentType, content: readFileSync(new URL(`../public/${file}`, import.meta.url)) }]));

function send(response, method, code, contentType, content, cache) {
  response.writeHead(code, {
    'Content-Type': contentType,
    'Content-Length': Buffer.byteLength(content),
    'Cache-Control': cache,
  });
  response.end(method === 'HEAD' ? undefined : content);
}

function json(response, method, code, value) {
  send(response, method, code, 'application/json; charset=utf-8', JSON.stringify(value), 'no-store');
}

const server = createServer((request, response) => {
  const method = request.method;
  response.setHeader('X-Content-Type-Options', 'nosniff');
  response.setHeader('Referrer-Policy', 'no-referrer');
  response.setHeader('Content-Security-Policy', "default-src 'self'; style-src 'self' 'unsafe-inline'; object-src 'none'; frame-ancestors 'none'; base-uri 'none'");
  if (method !== 'GET' && method !== 'HEAD') {
    response.setHeader('Allow', 'GET, HEAD');
    json(response, method, 405, { error: '仅支持读取。' });
    return;
  }
  try {
    const { pathname } = new URL(request.url, 'http://localhost');
    const page = files.get(pathname);
    if (page) {
      send(response, method, 200, page.contentType, page.content, pathname === '/' ? 'no-cache' : 'public, max-age=300');
      return;
    }
    if (pathname === '/health') return json(response, method, 200, { ok: true });
    if (pathname === '/api/health') return json(response, method, 200, store.health());
    if (pathname === '/api/dashboard') return json(response, method, 200, store.dashboard());
    const match = /^\/api\/draws\/(\d{1,12})$/.exec(pathname);
    if (match) {
      const draw = store.drawDetails(Number(match[1]));
      if (draw) return json(response, method, 200, draw);
    }
    return json(response, method, 404, { error: '未找到对应记录。' });
  } catch (error) {
    console.error('请求处理失败:', error.message);
    return json(response, method, 500, { error: '暂时无法读取记录。' });
  }
});
server.requestTimeout = 15_000;
server.listen(port, '0.0.0.0', () => console.log(`开奖源对账台已启动，端口 ${port}，共 ${sources.length} 个来源。`));
const stopPolling = process.env.POLL_DISABLED === '1' ? async () => {} : startPolling(sources, store);

async function shutdown() {
  await stopPolling();
  server.close(() => store.close());
}
process.once('SIGTERM', shutdown);
process.once('SIGINT', shutdown);
