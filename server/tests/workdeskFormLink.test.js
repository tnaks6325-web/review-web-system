/**
 * 회귀가드 — 작업보드 [🛒 구매양식 링크] · 새 작업오더 도착 알림 (결정 268 · 사용자 확정 2026-10-21)
 *
 * 배경: 옛 관리자 대시보드를 없애기(결정 267) 전에, 거기에만 있던 두 가지를 리뷰웹시스템[3버전]으로 옮겼다.
 *   ① 리뷰어용 구매양식 단축링크 만들기 — 최근 한 달 11개 · 마지막 10/20 (운영 실측)
 *   ② "새 작업오더 도착" 실시간 카드(결정 006)
 *
 * 고정하는 것:
 *   §1 코드 규칙 단일 출처 — /api/short/create 와 /api/trackb/form-link 가 같은 서비스(shortLink.service)를 쓴다
 *      · 같은 (s|g|t|d|round) 면 기존 코드를 재사용(옛 대시보드에서 만든 링크와 갈리지 않는다)
 *      · 작업보드 경로의 재료는 서버가 tab_configs 에서 읽는다(화면 값 불신) · 없는 작업은 404
 *   §2 게이트 — form-link 는 internalMiddleware + _ensureEditScope(작업보드 본문과 같은 판정)
 *   §3 새 작업오더 알림 대상 — 관리자 연결 + 작업보드 연결 중 master/admin 만(AE·리뷰어·업체 제외)
 *   §4 화면 배선 — 버튼(내부 역할·보관 작업 제외) · /r/<코드> · SSE 수신 · 카드 #app 안 · 권한 창 안 띄움
 *
 * 실행: node tests/workdeskFormLink.test.js
 */
'use strict';
const assert = require('assert');
const fs = require('fs');
const path = require('path');

let pass = 0, fail = 0;
async function ta(name, fn) {
  try { await fn(); console.log('  ✓ ' + name); pass++; }
  catch (e) { console.log('  ✗ ' + name + '\n      ' + (e && e.stack || e)); fail++; }
}
const ROOT = path.join(__dirname, '..');
const read = p => fs.readFileSync(path.join(ROOT, p), 'utf8');

// ── 가짜 pool: short_links · tab_configs 두 표만 흉내 + 조합별 잠금(pg_advisory_xact_lock) 흉내 ──
function makePool() {
  const links = [];   // {code, sheet_id, gid, tab_name, display_name, option_list, composite_key, round}
  const tabs = [{ sheet_id: 'wt_a', tab_name: '작업A', tab_gid: '123', display_name: '작업A 표시' }];
  const calls = [];
  const locks = new Map();   // key → Promise(현재 보유자가 끝나면 풀림)
  const exec = async (sql, params = []) => {
    calls.push(sql);
    if (/FROM tab_configs/.test(sql)) return { rows: tabs.filter(t => t.sheet_id === params[0] && t.tab_name === params[1]).slice(0, 1) };
    if (/SELECT code, option_list FROM short_links WHERE composite_key/.test(sql)) { await new Promise(r => setTimeout(r, 5)); return { rows: links.filter(l => l.composite_key === params[0]).slice(0, 1) }; }
    if (/INSERT INTO short_links/.test(sql)) {
      if (links.some(l => l.code === params[0])) { const e = new Error('dup'); e.code = '23505'; throw e; }
      links.push({ code: params[0], sheet_id: params[1], gid: params[2], tab_name: params[3], display_name: params[4], option_list: params[5], composite_key: params[6], round: params[7] });
      return { rows: [] };
    }
    if (/UPDATE short_links/.test(sql)) return { rows: [] };
    throw new Error('예상 밖 쿼리: ' + sql);
  };
  return {
    links, tabs, calls,
    query: exec,
    async connect() {
      let release = null;
      return {
        async query(sql, params) {
          if (/^(BEGIN|SAVEPOINT|ROLLBACK TO SAVEPOINT)/.test(sql)) { calls.push(sql); return { rows: [] }; }
          if (/^(COMMIT|ROLLBACK)$/.test(sql)) { calls.push(sql); if (release) { const f = release; release = null; f(); } return { rows: [] }; }
          if (/pg_advisory_xact_lock/.test(sql)) {
            calls.push(sql);
            const key = params[0];
            while (locks.has(key)) await locks.get(key);
            let done; locks.set(key, new Promise(r => { done = r; }));
            release = () => { locks.delete(key); done(); };
            return { rows: [] };
          }
          return exec(sql, params);
        },
        release() {},
      };
    },
  };
}
function loadSvc(pool) {
  const poolPath = require.resolve(path.join(ROOT, 'src/db/pool'));
  const svcPath = require.resolve(path.join(ROOT, 'src/services/shortLink.service'));
  require.cache[poolPath] = { id: poolPath, filename: poolPath, loaded: true, exports: pool };
  delete require.cache[svcPath];
  return require(svcPath);
}

(async () => {
  console.log('§1 코드 규칙 단일 출처');
  await ta('옛 경로(/api/short/create)도 같은 서비스를 쓴다 — 라우트 안에 INSERT 사본 없음', () => {
    const r = read('src/routes/shortlink.routes.js');
    assert.match(r, /require\('\.\.\/services\/shortLink\.service'\)/);
    assert.match(r, /ensureShortLink\(\{ s, g, t, d, round, options: options \|\| optionList \|\| \[\] \}\)/);
    assert.doesNotMatch(r, /INSERT INTO short_links/);
  });
  await ta('작업보드 경로: 재료는 tab_configs 값(s·tab_gid·tab_name·display_name · 차수 없음)', async () => {
    const pool = makePool(); const svc = loadSvc(pool);
    const out = await svc.ensureTabFormLink({ sheetId: 'wt_a', tabName: '작업A' });
    assert.strictEqual(out.ok, true); assert.strictEqual(out.reused, false);
    assert.strictEqual(pool.links.length, 1);
    const l = pool.links[0];
    assert.deepStrictEqual([l.sheet_id, l.gid, l.tab_name, l.display_name, l.round], ['wt_a', '123', '작업A', '작업A 표시', '']);
    assert.strictEqual(l.composite_key, 'wt_a|123|작업A|작업A 표시|');
    assert.match(out.code, /^[a-z2-9]{6}$/);
  });
  await ta('옛 대시보드가 같은 재료로 만든 코드가 있으면 그 코드를 그대로 돌려준다(새로 만들지 않음)', async () => {
    const pool = makePool(); const svc = loadSvc(pool);
    // 옛 copyShortLink 의 요청 본문 = { s, g, t, d, rd:'' }
    const old = await svc.ensureShortLink({ s: 'wt_a', g: '123', t: '작업A', d: '작업A 표시', round: '' });
    const now = await svc.ensureTabFormLink({ sheetId: 'wt_a', tabName: '작업A' });
    assert.strictEqual(now.code, old.code); assert.strictEqual(now.reused, true);
    assert.strictEqual(pool.links.length, 1);
  });
  await ta('같은 작업을 동시에 두 번(버튼 연타·두 사람) 눌러도 코드는 하나 — 조합별 트랜잭션 잠금', async () => {
    const pool = makePool(); const svc = loadSvc(pool);
    const [a, b] = await Promise.all([svc.ensureTabFormLink({ sheetId: 'wt_a', tabName: '작업A' }), svc.ensureTabFormLink({ sheetId: 'wt_a', tabName: '작업A' })]);
    assert.strictEqual(a.code, b.code);
    assert.strictEqual(pool.links.length, 1);
    assert.ok(pool.calls.some(c => /pg_advisory_xact_lock\(hashtext\(\$1\)\)/.test(c)), '잠금을 건다');
    const src = read('src/services/shortLink.service.js');
    assert.match(src, /SELECT pg_advisory_xact_lock\(hashtext\(\$1\)\)', \['short_links:' \+ compositeKey\]/);
  });
  await ta('없는 작업은 404 · 빈 값은 400 (조용히 아무 링크나 만들지 않는다)', async () => {
    const pool = makePool(); const svc = loadSvc(pool);
    const nf = await svc.ensureTabFormLink({ sheetId: 'wt_a', tabName: '없는작업' });
    assert.deepStrictEqual([nf.ok, nf.code], [false, 404]);
    const bad = await svc.ensureTabFormLink({ sheetId: '', tabName: '작업A' });
    assert.deepStrictEqual([bad.ok, bad.code], [false, 400]);
    assert.strictEqual(pool.links.length, 0);
  });
  await ta('코드 충돌(23505)은 다시 뽑는다', async () => {
    const pool = makePool(); const svc = loadSvc(pool);
    pool.links.push({ code: 'aaaaaa', composite_key: 'x' });
    const rnd = Math.random; let n = 0;
    Math.random = () => (n++ < 6 ? 0 : rnd());   // 첫 코드 = 'aaaaaa'(충돌)
    try { const out = await svc.ensureShortLink({ s: 'wt_a', t: '작업A' }); assert.strictEqual(out.ok, true); assert.notStrictEqual(out.code, 'aaaaaa'); }
    finally { Math.random = rnd; }
  });

  console.log('§2 게이트');
  await ta('POST /api/trackb/form-link = authMiddleware + internalMiddleware + _ensureEditScope', () => {
    const r = read('src/routes/trackB.routes.js');
    const i = r.indexOf("router.post('/form-link'");
    assert.ok(i > 0, 'form-link 라우트 없음');
    const body = r.slice(i, i + 700);
    assert.match(body, /authMiddleware, internalMiddleware/);
    assert.match(body, /_ensureEditScope\(req, sheetId, tabName\)/);
    assert.match(body, /shortLinkSvc\.ensureTabFormLink\(\{ sheetId, tabName \}\)/);
  });

  console.log('§3 새 작업오더 알림 대상');
  await ta('관리자 연결 + 작업보드 master/admin 만 받는다', () => {
    const sse = require(path.join(ROOT, 'src/utils/sse'));
    const t = sse.workOrderNewTarget;
    assert.strictEqual(typeof t, 'function');
    assert.strictEqual(t({ meta: { role: 'admin' } }), true);
    assert.strictEqual(t({ meta: { role: 'workdesk', userRole: 'master' } }), true);
    assert.strictEqual(t({ meta: { role: 'workdesk', userRole: 'admin' } }), true);
    assert.strictEqual(t({ meta: { role: 'workdesk', userRole: 'staff' } }), false);
    assert.strictEqual(t({ meta: { role: 'workdesk' } }), false);
    assert.strictEqual(t({ meta: { role: 'reviewer', phone8: '12345678' } }), false);
    const src = read('src/utils/sse.js');
    assert.match(src, /broadcast\('work_order_new', \{[\s\S]*?\}, workOrderNewTarget\);/);
  });
  await ta('작업보드 SSE 연결이 로그인 등급(userRole)을 싣는다', () => {
    const r = read('src/routes/trackB.routes.js');
    assert.match(r, /addSseClient\(req, res, \{ role: 'workdesk', userRole: _role\(req\),/);
  });

  console.log('§4 화면 배선');
  const wd = fs.readFileSync(path.join(ROOT, '..', 'frontend', 'workdesk.html'), 'utf8');
  await ta('[🛒 구매양식 링크] 버튼 — 내부 역할만 · 보관(마감) 작업에서는 숨김', () => {
    assert.match(wd, /const formLinkBtn=_isInternalRole\(\)\?`<button class="btn" type="button" onclick="copyFormLink\(\)"/);
    assert.match(wd, /\$\{wd\.archived\?'':formLinkBtn\}/);
  });
  await ta('copyFormLink — 서버 경로 하나 · 주소는 API/r/<코드> · 복사 실패 시 주소 창', () => {
    const i = wd.indexOf('async function copyFormLink(){');
    assert.ok(i > 0);
    const f = wd.slice(i, i + 1200);
    assert.match(f, /api\('\/api\/trackb\/form-link',\{method:'POST',body:JSON\.stringify\(\{sheetId:t\.sheetId,tabName:t\.tabName\}\)\}\)/);
    assert.match(f, /const url=API_BASE\+'\/r\/'\+encodeURIComponent\(r\.code\);/);
    assert.match(f, /_shareLinkPopup\(/);
  });
  await ta('새 작업오더: SSE 수신 → 카드는 #app 안 · master/admin 만 · 권한 창 안 띄움 · 배지는 단일 출처', () => {
    assert.match(wd, /_wbOrderLiveSource\.addEventListener\('work_order_new',ev=>\{\s*try\{ _woNewAlert\(JSON\.parse\(ev\.data\|\|'\{\}'\)\); \}catch\(_\)\{ \}/);
    const i = wd.indexOf('function _woNewAlert(d){');
    assert.ok(i > 0);
    const f = wd.slice(i, i + 2200);
    assert.match(f, /if\(!\['master','admin'\]\.includes\(STATE\.role\)\) return;/);
    assert.match(f, /const app=\$\('#app'\);/);
    assert.match(f, /app\.appendChild\(box\)/);
    assert.match(f, /Notification\.permission==='granted'/);
    assert.doesNotMatch(f, /requestPermission/);
    assert.match(f, /esc\(title\)/); assert.match(f, /esc\(who\)/);
    assert.match(f, /_woSyncNavBadge\(\)/);
  });
  await ta('인트라넷 원본 수정(event 있음)은 "새 작업오더" 카드가 아니라 조용히 갱신만 — 보완 재제출은 카드', () => {
    const i = wd.indexOf('function _woNewAlert(d){');
    const f = wd.slice(i, i + 800);
    assert.match(f, /if\(d\.event&&!d\.resubmitted\)\{ _woRefreshQuiet\(\); return; \}/);
    const srv = read('src/routes/order.routes.js');
    for (const ev of ['source_contract_match', 'source_partial_edit', 'source_revision']) assert.ok(srv.includes(ev), ev + ' 이벤트가 서버에 있다(이름이 바뀌면 이 거름이 깨진다)');
  });
  await ta('작업오더 목록·배지 갱신은 마지막 요청만 반영(_woReqSeq) · 버튼 연타 방지', () => {
    assert.match(wd, /const seq=STATE\._woReqSeq=\(STATE\._woReqSeq\|\|0\)\+1;\s*const r=await api\('\/api\/trackb\/work-orders\/list'/);
    assert.match(wd, /if\(seq!==STATE\._woReqSeq\) return;/);
    assert.match(wd, /if\(copyFormLink\._busy\) return;/);
  });
  await ta('작업오더 목록 응답이 늦게 와도(다른 화면·로그아웃) 표를 그리지 않는다', () => {
    assert.match(wd, /if\(!\$\('#wohead'\)\|\|!\$\('#wobody'\)\)\{ _woSyncNavBadge\(\); return; \}\s*_renderWoHead\(\); _renderWoBody\(\);/);
  });

  console.log(`\n결과: ${pass} 통과 / ${fail} 실패`);
  if (fail) process.exit(1);
})().catch(e => { console.error(e); process.exit(1); });
