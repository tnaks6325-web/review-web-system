#!/usr/bin/env node
/**
 * 결정 354 「미리 만들기(2026-11-09)」 — 사진 빠른 길의 사진을 한꺼번에 R2 에 만들어 둔다.
 *   「모든 사진 미리 만들기(2026-11-09 사용자 확정)」 — 기본 = **전체 사진 · t → m → o 세 가지**.
 *
 *   DATABASE_URL=… IMG_SIGNING_KEY=… node scripts/img-warm.js [--kinds t,m,o] [--days N] [--limit 200000] [--concurrency 4] [--dry-run]
 *
 *   1) DB(★ 읽기 전용 트랜잭션)에서 허용 목록 출처 칸의 사진 번호를 모은다(--days 없으면 전체 · 중복 제거·최신순,
 *      가이드 사진(guide_image_files) 포함 · 이체결과 보관 파일·삭제된 주문·쓰지 않는 사진 제외 — imageWarm.collectRecentIds 단일 출처).
 *   2) 번호마다 kind 를 t → m → o 차례로(같은 번호의 세 가지는 동시에 보내지 않는다 — 원본 서버의 원본 캐시가
 *      드라이브 1회를 나눠 쓴다), 서버와 같은 서명 주소(PUBLIC_ORIGIN, 없으면 https://review-web-system.pages.dev 의 /img/<kind>/…)를 HEAD
 *      → Pages Function 이 R2 에 없으면 원본 서버에서 받아 담는다. 응답 X-Img-Src 로
 *      「이미 있음(r2·edge)」/「새로 만듦(origin)」/「건너뜀(404 — 사진 아님·허용 밖)」/「실패」를 센다.
 *   ★ 동시 수 기본 4 · 상한 6 — 원본 서버 내부 입구의 동시 생성 12(초과 시 503) 안쪽, 화면 첫 조회 몫을 남긴다.
 *   ★ 출력은 개수만 — 파일 번호·이름·개인정보를 찍지 않는다.
 *   ★ 다시 돌려도 안전 · 끊겨도 이어서 — 이미 있는 것은 R2 head 만 보고 「이미 있음」으로 센다(몸통 전송 0).
 *     최신순이라 다시 돌리면 앞쪽(이미 만든 것)을 빠르게 지나 끊긴 자리부터 새로 만든다.
 */
'use strict';
const path = require('path');
const warm = require(path.join(__dirname, '..', 'src', 'services', 'imageWarm.service'));

const MAX_CONCURRENCY = 6;
const ALL_KINDS = warm.WARM_KINDS;   // ['t','m','o'] — 순서도 단일 출처

function _parseKinds(v) {
  const want = String(v || '').split(',').map(x => x.trim()).filter(Boolean);
  const bad = want.filter(k => !ALL_KINDS.includes(k));
  if (!want.length || bad.length) throw new Error(`알 수 없는 kind: ${bad.join(',') || '(비어 있음)'} — t,m,o 중에서 고르세요`);
  return ALL_KINDS.filter(k => want.includes(k));   // 언제나 t → m → o 순서
}

function parseArgs(argv) {
  const o = { days: null, limit: 200000, concurrency: 4, dryRun: false, kinds: ALL_KINDS.slice() };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const num = () => Number(argv[++i]);
    if (a === '--dry-run') o.dryRun = true;
    else if (a === '--kinds') o.kinds = _parseKinds(argv[++i]);
    else if (a === '--days') o.days = num();
    else if (a === '--limit') o.limit = num();
    else if (a === '--concurrency') o.concurrency = num();
    else if (a === '--help' || a === '-h') o.help = true;
    else throw new Error(`알 수 없는 인자: ${a}`);
  }
  o.days = o.days === null ? null : Math.max(1, Math.min(3650, Math.floor(o.days) || 60));
  o.limit = Math.max(1, Math.min(500000, Math.floor(o.limit) || 200000));
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
  if (opts.help) { log('사용법: node scripts/img-warm.js [--kinds t,m,o] [--days N(없으면 전체)] [--limit 200000] [--concurrency 4] [--dry-run]'); return null; }
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

  const res = { total: ids.length, hit: 0, made: 0, skip: 0, fail: 0, dryRun: opts.dryRun, kinds: opts.kinds, byKind: {} };
  for (const k of opts.kinds) res.byKind[k] = { hit: 0, made: 0, skip: 0, fail: 0 };
  log(`[img-warm] ${opts.days === null ? '전체 기간' : `최근 ${opts.days}일`} 사진 ${ids.length}장 · 종류 ${opts.kinds.join('→')}${ids.length >= opts.limit ? ` (상한 ${opts.limit} 에서 끊음)` : ''}`);
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
        let worst = 'hit';
        for (const kind of opts.kinds) {
          const r = await warm.warmOne(id, { fetch: deps.fetch, kind });
          const b = res.byKind[kind];
          const key = r === 'hit' || r === 'made' || r === 'skip' ? r : 'fail';
          b[key]++;
          if (key === 'fail') worst = 'fail';
          else if (key === 'skip' && worst !== 'fail') worst = 'skip';
          else if (key === 'made' && worst === 'hit') worst = 'made';
          if (key === 'skip' && kind === 't') break;   // 사진 아님·허용 밖 — 나머지 종류도 같은 답
        }
        res[worst]++;            // 장 단위: 하나라도 실패 = 실패 · 새로 만든 종류가 있으면 새로 만듦 · 전부 있으면 이미 있음
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
  log(`[img-warm] 끝 — 전체 ${res.total}장 · 이미 있음 ${res.hit} · 새로 만듦 ${res.made} · 건너뜀(사진 아님·허용 밖) ${res.skip} · 실패 ${res.fail}`);
  for (const k of opts.kinds) {
    const b = res.byKind[k];
    log(`[img-warm]   ${k}: 이미 있음 ${b.hit} · 새로 만듦 ${b.made} · 건너뜀 ${b.skip} · 실패 ${b.fail}`);
  }
  return res;
}

if (require.main === module) {
  main(process.argv.slice(2))
    .then((r) => { process.exit(r && r.fail ? 1 : 0); })
    .catch((e) => { console.error('[img-warm]', e.message); process.exit(2); });
}

module.exports = { main, parseArgs, MAX_CONCURRENCY, ALL_KINDS };
