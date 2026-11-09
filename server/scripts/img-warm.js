#!/usr/bin/env node
/**
 * 결정 354 「미리 만들기(2026-11-09)」 — 최근 사진의 화면용 작은 사진(t)을 한꺼번에 R2 에 만들어 둔다.
 *
 *   DATABASE_URL=… IMG_SIGNING_KEY=… node scripts/img-warm.js [--days 60] [--limit 50000] [--concurrency 4] [--dry-run]
 *
 *   1) DB(★ 읽기 전용 트랜잭션)에서 허용 목록 출처 칸의 최근 N일 사진 번호를 모은다(중복 제거·최신순,
 *      이체결과 보관 파일·삭제된 주문 제외 — imageWarm.collectRecentIds 단일 출처).
 *   2) 번호마다 서버와 같은 서명 주소(PUBLIC_ORIGIN, 없으면 https://review-web-system.pages.dev 의 /img/t/…)를 GET
 *      → Pages Function 이 R2 에 없으면 원본 서버에서 받아 담는다. 응답 X-Img-Src 로
 *      「이미 있음(r2·edge)」/「새로 만듦(origin)」/「건너뜀(404 — 사진 아님·허용 밖)」/「실패」를 센다.
 *   ★ 동시 수 기본 4 · 상한 6 — 원본 서버 내부 입구의 동시 생성 12(초과 시 503) 안쪽, 화면 첫 조회 몫을 남긴다.
 *   ★ 출력은 개수만 — 파일 번호·이름·개인정보를 찍지 않는다.
 *   ★ 다시 돌려도 안전 — 이미 있는 것은 R2/엣지에서 바로 나오고 세기만 한다.
 */
'use strict';
const path = require('path');
const warm = require(path.join(__dirname, '..', 'src', 'services', 'imageWarm.service'));

const MAX_CONCURRENCY = 6;

function parseArgs(argv) {
  const o = { days: 60, limit: 50000, concurrency: 4, dryRun: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const num = () => Number(argv[++i]);
    if (a === '--dry-run') o.dryRun = true;
    else if (a === '--days') o.days = num();
    else if (a === '--limit') o.limit = num();
    else if (a === '--concurrency') o.concurrency = num();
    else if (a === '--help' || a === '-h') o.help = true;
    else throw new Error(`알 수 없는 인자: ${a}`);
  }
  o.days = Math.max(1, Math.min(3650, Math.floor(o.days) || 60));
  o.limit = Math.max(1, Math.min(500000, Math.floor(o.limit) || 50000));
  o.concurrency = Math.max(1, Math.min(MAX_CONCURRENCY, Math.floor(o.concurrency) || 4));
  return o;
}

async function _readIds(db, opts) {
  await db.query('SET default_transaction_read_only = on');
  await db.query("SET statement_timeout = '120s'");
  await db.query('BEGIN READ ONLY');
  try {
    return await warm.collectRecentIds(db, opts);
  } finally {
    try { await db.query('ROLLBACK'); } catch (_) { /* 읽기만 했다 */ }
  }
}

/**
 * @param {string[]} argv
 * @param {{db?:{query:Function}, fetch?:Function, log?:Function, env?:object}} deps  db 를 안 주면 DATABASE_URL 로 연결
 * @returns {Promise<{total:number, hit:number, made:number, skip:number, fail:number, dryRun:boolean}>}
 */
async function main(argv, deps = {}) {
  const opts = parseArgs(argv || []);
  const log = deps.log || ((...a) => console.log(...a));
  const env = deps.env || process.env;
  if (opts.help) { log('사용법: node scripts/img-warm.js [--days 60] [--limit 50000] [--concurrency 4] [--dry-run]'); return null; }
  if (!opts.dryRun && String(env.IMG_SIGNING_KEY || '').length < 32) {
    throw new Error('IMG_SIGNING_KEY(32자 이상)가 필요합니다 — 서버와 같은 서명 열쇠. (--dry-run 은 없어도 된다)');
  }

  let ids;
  if (deps.db) ids = await _readIds(deps.db, opts);
  else {
    if (!env.DATABASE_URL) throw new Error('DATABASE_URL 이 필요합니다.');
    const { Client } = require('pg');
    const client = new Client({ connectionString: env.DATABASE_URL });
    await client.connect();
    try { ids = await _readIds(client, opts); } finally { await client.end(); }
  }

  const res = { total: ids.length, hit: 0, made: 0, skip: 0, fail: 0, dryRun: opts.dryRun };
  log(`[img-warm] 최근 ${opts.days}일 사진 ${ids.length}장${ids.length >= opts.limit ? ` (상한 ${opts.limit} 에서 끊음)` : ''}`);
  if (opts.dryRun || !ids.length) {
    if (opts.dryRun) log('[img-warm] --dry-run — 호출하지 않고 세기만 했습니다.');
    return res;
  }

  // 서명은 서버 단일 출처(imageEdge.signImage)를 그대로 쓴다 — 이 프로세스의 환경을 잠시 맞춘다.
  const prevKey = process.env.IMG_SIGNING_KEY, prevOrigin = process.env.PUBLIC_ORIGIN;
  process.env.IMG_SIGNING_KEY = env.IMG_SIGNING_KEY;
  if (env.PUBLIC_ORIGIN) process.env.PUBLIC_ORIGIN = env.PUBLIC_ORIGIN; else delete process.env.PUBLIC_ORIGIN;
  const started = Date.now();
  const step = Math.max(1, Math.ceil(ids.length / 20));
  let done = 0, at = 0;
  try {
    async function worker() {
      while (at < ids.length) {
        const id = ids[at++];
        const r = await warm.warmOne(id, { fetch: deps.fetch });
        if (r === 'hit') res.hit++;
        else if (r === 'made') res.made++;
        else if (r === 'skip') res.skip++;
        else res.fail++;
        done++;
        if (done % step === 0 || done === ids.length) {
          const sec = ((Date.now() - started) / 1000).toFixed(0);
          log(`[img-warm] ${done}/${ids.length} (${Math.round(done * 100 / ids.length)}%) · 이미 있음 ${res.hit} · 새로 만듦 ${res.made} · 건너뜀 ${res.skip} · 실패 ${res.fail} · ${sec}초`);
        }
      }
    }
    await Promise.all(Array.from({ length: Math.min(opts.concurrency, ids.length) }, worker));
  } finally {
    if (prevKey === undefined) delete process.env.IMG_SIGNING_KEY; else process.env.IMG_SIGNING_KEY = prevKey;
    if (prevOrigin === undefined) delete process.env.PUBLIC_ORIGIN; else process.env.PUBLIC_ORIGIN = prevOrigin;
  }
  log(`[img-warm] 끝 — 전체 ${res.total} · 이미 있음 ${res.hit} · 새로 만듦 ${res.made} · 건너뜀(사진 아님·허용 밖) ${res.skip} · 실패 ${res.fail}`);
  return res;
}

if (require.main === module) {
  main(process.argv.slice(2))
    .then((r) => { process.exit(r && r.fail ? 1 : 0); })
    .catch((e) => { console.error('[img-warm]', e.message); process.exit(2); });
}

module.exports = { main, parseArgs, MAX_CONCURRENCY };
