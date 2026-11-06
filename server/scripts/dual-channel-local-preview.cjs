'use strict';

/**
 * LOCAL FAKE DATA ONLY. No application startup, production routes, PG pool, dotenv or senders.
 * Run: node server/scripts/dual-channel-local-preview.cjs --port 41932
 * POST /__dual-preview/drafts; PUT/GET /__dual-preview/drafts/:id
 * Body: {title,status:'draft',channel:'네이버+쿠팡',recruit_total,daily_limit,work_detail:{dualChannelProduct}}
 * Success: {ok:true,data:<persisted campaign>}; errors: {ok:false,code,error}.
 * PUT is a partial merge: omitted work_detail keys survive; explicit invalid/null values fail.
 * Database is in memory and is discarded on exit. This is NOT production save readiness.
 */
const http = require('node:http');
const fs = require('node:fs/promises');
const path = require('node:path');
const { createDraftStore, DraftError } = require('./lib/dual-channel-draft-store.cjs');
const FRONTEND = path.resolve(__dirname, '../../frontend');
const BODY_LIMIT = 256 * 1024;
const STATUS = Object.freeze({ ok: true, localOnly: true, storage: 'pglite', ephemeral: true, productionReady: false });
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.gif': 'image/gif', '.webp': 'image/webp', '.ico': 'image/x-icon',
  '.woff': 'font/woff', '.woff2': 'font/woff2', '.txt': 'text/plain; charset=utf-8' };

function json(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(body));
}
function guardRequest(req) {
  const host = req.headers.host;
  const port = req.socket.localPort;
  if (![ `127.0.0.1:${port}`, `localhost:${port}` ].includes(host)) {
    throw new DraftError(403, 'local_origin_required', '이 서버는 같은 컴퓨터의 주소로만 열 수 있습니다.');
  }
  const origin = 'http://' + host;
  if ((req.headers.origin && req.headers.origin !== origin)
    || (['POST', 'PUT'].includes(req.method) && req.headers.origin !== origin)
    || req.headers['sec-fetch-site'] === 'cross-site') {
    throw new DraftError(403, 'local_origin_required', '같은 로컬 화면에서만 요청할 수 있습니다.');
  }
}
async function bodyJson(req) {
  if (!/^application\/json(?:\s*;.*)?$/i.test(req.headers['content-type'] || '')) {
    throw new DraftError(415, 'json_required', 'JSON 형식으로 보내 주세요.');
  }
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > BODY_LIMIT) throw new DraftError(413, 'body_too_large', '요청 내용이 너무 큽니다.');
    chunks.push(chunk);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch (_) { throw new DraftError(400, 'invalid_json', 'JSON 내용을 읽을 수 없습니다.'); }
}
async function staticFile(req, res, pathname) {
  if (!['GET', 'HEAD'].includes(req.method)) throw new DraftError(405, 'method_not_allowed', '허용되지 않은 요청입니다.');
  const relative = pathname === '/' ? '/docs/dual-channel-editor-preview.html' : pathname;
  const pieces = relative.split('/');
  if (relative.includes('\\') || relative.includes('\0') || pieces.some(p => p.startsWith('.')) || relative.includes('//')) {
    throw new DraftError(403, 'static_path_forbidden', '허용되지 않은 파일 경로입니다.');
  }
  const target = path.resolve(FRONTEND, '.' + relative);
  if (!target.startsWith(FRONTEND + path.sep) || !TYPES[path.extname(target)]) {
    throw new DraftError(404, 'not_found', '파일을 찾을 수 없습니다.');
  }
  let real, data;
  try {
    real = await fs.realpath(target);
    if (!real.startsWith(FRONTEND + path.sep)) throw new DraftError(403, 'static_path_forbidden', '허용되지 않은 파일 경로입니다.');
    data = await fs.readFile(real);
  } catch (error) {
    if (error instanceof DraftError) throw error;
    throw new DraftError(404, 'not_found', '파일을 찾을 수 없습니다.');
  }
  res.writeHead(200, { 'Content-Type': TYPES[path.extname(target)] });
  res.end(req.method === 'HEAD' ? undefined : data);
}
async function startLocalPreview({ port = 41932 } = {}) {
  if (process.env.NODE_ENV === 'production') throw new Error('Local preview must not run in production.');
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error('Invalid local port.');
  const store = await createDraftStore();
  const server = http.createServer(async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; connect-src 'self'; frame-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'");
    try {
      guardRequest(req);
      if (!req.url.startsWith('/')) throw new DraftError(400, 'invalid_path', '주소 형식이 올바르지 않습니다.');
      let pathname;
      try { pathname = decodeURIComponent(req.url.split('?')[0]); }
      catch (_) { throw new DraftError(400, 'invalid_path', '주소 형식이 올바르지 않습니다.'); }
      if (pathname === '/__dual-preview/status' && req.method === 'GET') return json(res, 200, STATUS);
      const match = /^\/__dual-preview\/drafts(?:\/(local-dual-[a-f0-9-]+))?$/.exec(pathname);
      if (match) {
        const id = match[1];
        if (id && req.method === 'GET') return json(res, 200, { ok: true, data: await store.read(id) });
        if ((!id && req.method === 'POST') || (id && req.method === 'PUT')) {
          return json(res, id ? 200 : 201, { ok: true, data: await store.save(await bodyJson(req), id) });
        }
        throw new DraftError(405, 'method_not_allowed', '허용되지 않은 요청입니다.');
      }
      if (pathname === '/api' || pathname.startsWith('/api/') || pathname.startsWith('/__dual-preview')) {
        throw new DraftError(404, 'route_disabled', '운영 API는 이 로컬 서버에서 사용할 수 없습니다.');
      }
      await staticFile(req, res, pathname);
    } catch (error) {
      const known = error instanceof DraftError || error.code === 'invalid_dual_channel';
      if (!res.headersSent && !res.destroyed) json(res, known ? (error.status || 400) : 500, {
        ok: false, code: known ? error.code : 'local_storage_failed',
        error: known ? error.message : '로컬 시험 저장에 실패했습니다. 변경은 되돌렸습니다.',
      });
    }
  });
  server.requestTimeout = 10000;
  server.headersTimeout = 10000;
  try {
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', resolve); });
  } catch (error) { await store.close(); throw error; }
  const origin = 'http://127.0.0.1:' + server.address().port;
  let closing;
  return { server, store, origin, close: () => closing ||= (async () => {
    await new Promise((resolve, reject) => {
      server.close(error => error ? reject(error) : resolve());
      server.closeAllConnections();
    });
    await store.close();
  })() };
}

if (require.main === module) {
  const args = process.argv.slice(2);
  if (args.length && !(args.length === 2 && args[0] === '--port' && /^\d+$/.test(args[1]))) {
    console.error('Usage: node dual-channel-local-preview.cjs [--port 41932]');
    process.exitCode = 1;
  } else startLocalPreview({ port: args.length ? Number(args[1]) : 41932 }).then(app => {
    console.log(JSON.stringify({ ...STATUS, origin: app.origin,
      preview: app.origin + '/docs/dual-channel-editor-preview.html?local_server=1' }));
    const stop = () => app.close().catch(() => { process.exitCode = 1; });
    process.once('SIGINT', stop);
    process.once('SIGTERM', stop);
  }).catch(error => { console.error(error.message); process.exitCode = 1; });
}
module.exports = { startLocalPreview, BODY_LIMIT };
