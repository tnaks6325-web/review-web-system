/**
 * workTabDelete.test.js — 회귀가드: 작업(탭) 통째 삭제 (admin/master 전용)
 * 실행: node tests/workTabDelete.test.js
 *
 * 이 기능은 **되돌릴 수 없다**. 그래서 이 가드가 고정하는 것 다섯.
 *  A. **표 분류 전수** — (sheet_id, tab_name) 을 가진 표는 전부 DELETE_TABLES ∪ MONEY_TABLES 에
 *     있어야 한다. 새 표가 생겼는데 분류가 없으면 여기서 빨개진다("지워야 하는데 남는" 잔재도,
 *     "지우면 안 되는데 지워지는" 사고도 이 자리에서 막는다).
 *  B. **돈 기록은 두 번째 확인으로만 지워진다**(사용자 확정 2026-08-19) — 일반 요청은 **쓰기 0건**으로
 *     거부하고, `forcePayment:true` 일 때만 함께 지운다. 지울 때는 **대조 이력(119, RESTRICT)을
 *     먼저** 지워야 FK 로 튕기지 않고, **회차(payment_batches) 자체는 남긴다**(한 회차가 여러 작업).
 *  C. **확인 없이는 아무것도 안 지운다** — confirm !== true 면 DELETE 쿼리 0.
 *  D. **곁다리 정리의 방향** — 작업오더는 링크만 해제(삭제 금지) · 공고는 보관(삭제 금지) ·
 *     업체 소유는 gid 를 모르면 손대지 않는다 · 시트 등록행은 남은 탭이 없을 때만.
 *  E. **게이트·화면 배선** — 라우터는 adminOrMaster, 화면 버튼은 master/admin 에만, onclick 은 인덱스만.
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const read = p => fs.readFileSync(path.join(__dirname, '..', '..', p), 'utf8');
const readSrv = p => fs.readFileSync(path.join(__dirname, '..', p), 'utf8');

let passed = 0;
const ok = (name, cond, extra) => { assert(cond, name + (extra ? ' — ' + extra : '')); passed++; console.log('  ✓ ' + name); };

const svc = require('../src/services/workTabDelete.service');
const { DELETE_TABLES, MONEY_TABLES } = svc;

/* ── A. 표 분류 전수 ─────────────────────────────────────────────────────── */
console.log('\n[A] (sheet_id, tab_name) 표 전수 분류');
{
  const dir = path.join(__dirname, '..', 'migrations');
  const sql = fs.readdirSync(dir).filter(f => f.endsWith('.sql')).sort()
    .map(f => fs.readFileSync(path.join(dir, f), 'utf8')).join('\n');
  const found = new Set();
  const re = /CREATE TABLE IF NOT EXISTS (\w+)\s*\(([\s\S]*?)\n\);/g;
  let m;
  while ((m = re.exec(sql))) {
    const cols = m[2].split('\n').map(s => s.trim());
    if (cols.some(c => /^sheet_id\b/.test(c)) && cols.some(c => /^tab_name\b/.test(c))) found.add(m[1]);
  }
  ok('마이그레이션에서 표를 찾는다', found.size >= 30, String(found.size));
  const classified = new Set([...DELETE_TABLES, ...MONEY_TABLES.map(x => x.table)]);
  const unclassified = [...found].filter(t => !classified.has(t));
  ok('★ 분류 없는 표가 없다(새 표가 생기면 여기서 잡힌다)', unclassified.length === 0, unclassified.join(','));
  const ghost = [...classified].filter(t => !found.has(t));
  ok('★ 존재하지 않는 표를 지우려 하지 않는다', ghost.length === 0, ghost.join(','));
  ok('삭제 목록에 중복이 없다', new Set(DELETE_TABLES).size === DELETE_TABLES.length);
  ok('★ 등록행(tab_configs)이 마지막(자식 → 부모 순서 계약)',
    DELETE_TABLES[DELETE_TABLES.length - 1] === 'tab_configs');
  ok('★ 돈 표는 삭제 목록에 없다(분류 겹침 금지)',
    !MONEY_TABLES.some(m2 => DELETE_TABLES.includes(m2.table)));
  for (const need of ['payment_batch_items', 'payment_records', 'manual_payment_marks', 'unconfirmed_transfer_reviews']) {
    ok(`돈 표 ${need} 는 보호 목록에 있다(완화 금지)`, MONEY_TABLES.some(x => x.table === need));
  }
}

/* ── 스텁 pool ──────────────────────────────────────────────────────────── */
function stubPool(handler) {
  const log = [];
  const client = {
    query: async (text, params) => { log.push({ text: String(text), params }); return handler(String(text), params) || { rows: [], rowCount: 0 }; },
    release() { this.released = true; },
  };
  const pool = {
    log, client,
    query: (t, p) => client.query(t, p),
    connect: async () => client,
  };
  return pool;
}
const countDeletes = log => log.filter(q => /^\s*DELETE\s+FROM/i.test(q.text)).length;
const countWrites = log => log.filter(q => /^\s*(DELETE|UPDATE|INSERT)\b/i.test(q.text)).length;

/* ── B. 돈 기록이 있으면 쓰기 0 ────────────────────────────────────────── */
console.log('\n[B] 입금 기록 — 기본 거부(쓰기 0건) · 두 번째 확인으로만 삭제');
(async () => {
  {
    const pool = stubPool((text) => {
      if (/FROM payment_batch_items/.test(text)) return { rows: [{ n: 3 }] };
      if (/COUNT\(\*\)::int AS n/.test(text)) return { rows: [{ n: 0 }] };
      return { rows: [], rowCount: 0 };
    });
    const out = await svc.deleteTask({ sheetId: 'S', tabName: 'T', confirm: true, pool });
    ok('★ forcePayment 없으면 payment_locked 로 거부', out.ok === false && out.code === 'payment_locked');
    ok('★ 무엇이 걸렸는지 말한다', Array.isArray(out.money) && out.money[0].count === 3);
    ok('★ DELETE 를 한 번도 실행하지 않았다', countDeletes(pool.log) === 0);
    ok('★ 어떤 쓰기도 없다', countWrites(pool.log) === 0);
    ok('ROLLBACK 으로 끝난다', pool.log.some(q => /ROLLBACK/.test(q.text)));
    ok('커넥션을 반납한다', pool.client.released === true);
  }
  {
    // 두 번째 확인(forcePayment) — 돈 기록까지 함께 지운다
    const pool = stubPool((text) => {
      if (/FROM payment_batch_items WHERE/.test(text) && /COUNT/.test(text)) return { rows: [{ n: 2 }] };
      if (/FROM payment_records WHERE/.test(text) && /COUNT/.test(text)) return { rows: [{ n: 1 }] };
      if (/COUNT\(\*\)::int AS n/.test(text)) return { rows: [{ n: 0 }] };
      if (/COALESCE\(NULLIF\(tc\.tab_gid/.test(text)) return { rows: [{ gid: '9' }] };
      return { rows: [], rowCount: 1 };
    });
    const out = await svc.deleteTask({ sheetId: 'S', tabName: 'T', confirm: true, forcePayment: true, by: '만두', pool });
    ok('★ forcePayment:true 면 삭제된다', out.ok === true, JSON.stringify(out && out.code));
    for (const m of MONEY_TABLES) {
      assert(pool.log.some(q => new RegExp(`DELETE FROM ${m.table} WHERE sheet_id=\\$1 AND tab_name=\\$2`).test(q.text)),
        `돈 표 ${m.table} 를 지우지 않았다`);
    }
    passed++; console.log('  ✓ 돈 표 4종도 (sheet_id, tab_name) 으로 지운다');
    const iRec = pool.log.findIndex(q => /DELETE FROM payment_account_mismatch_reconciliations/.test(q.text));
    const iItem = pool.log.findIndex(q => /DELETE FROM payment_batch_items/.test(q.text));
    ok('★ 대조 이력(119, RESTRICT)을 회차 항목보다 **먼저** 지운다', iRec >= 0 && iRec < iItem, `rec=${iRec} item=${iItem}`);
    ok('★ 입금 회차(payment_batches) 자체는 지우지 않는다(한 회차가 여러 작업에 걸린다)',
      !pool.log.some(q => /DELETE FROM payment_batches/i.test(q.text)));
    ok('무엇을 지웠는지 응답이 말한다', Array.isArray(out.paymentDeleted) && out.paymentDeleted.length === 2);
    ok('COMMIT 으로 끝난다', pool.log.some(q => /COMMIT/.test(q.text)));
  }
  {
    // 돈 기록이 없으면 forcePayment 를 줘도 돈 표를 건드리지 않는다
    const pool = stubPool((text) => {
      if (/COUNT\(\*\)::int AS n/.test(text)) return { rows: [{ n: 0 }] };
      if (/COALESCE\(NULLIF\(tc\.tab_gid/.test(text)) return { rows: [{ gid: '' }] };
      return { rows: [], rowCount: 0 };
    });
    const out = await svc.deleteTask({ sheetId: 'S', tabName: 'T', confirm: true, forcePayment: true, pool });
    ok('★ 걸린 돈 기록이 없으면 돈 표에는 손대지 않는다',
      out.ok === true && !pool.log.some(q => /DELETE FROM payment_(batch_items|records)/.test(q.text))
      && !pool.log.some(q => /DELETE FROM payment_account_mismatch_reconciliations/.test(q.text)));
  }

  /* ── C. 확인 없이는 아무것도 안 지운다 ──────────────────────────────── */
  console.log('\n[C] 확인(confirm) 게이트');
  {
    const pool = stubPool(() => ({ rows: [{ n: 0 }], rowCount: 0 }));
    const out = await svc.deleteTask({ sheetId: 'S', tabName: 'T', pool });
    ok('confirm 없으면 confirm_required', out.ok === false && out.code === 'confirm_required');
    ok('★ 쿼리를 한 번도 안 보낸다', pool.log.length === 0);
    const out2 = await svc.deleteTask({ sheetId: 'S', tabName: 'T', confirm: 'true', pool });
    ok('★ 문자열 "true" 는 확인이 아니다(느슨한 비교 금지)', out2.ok === false && out2.code === 'confirm_required');
  }

  /* ── D. 정상 경로 · 곁다리 정리의 방향 ─────────────────────────────── */
  console.log('\n[D] 정상 삭제 — 표별 DELETE · 링크 해제 · 공고 보관');
  {
    const pool = stubPool((text) => {
      if (/COUNT\(\*\)::int AS n/.test(text)) return { rows: [{ n: 0 }] };
      if (/COALESCE\(NULLIF\(tc\.tab_gid/.test(text)) return { rows: [{ gid: '123' }] };
      if (/^\s*DELETE\s+FROM/i.test(text)) return { rows: [], rowCount: 2 };
      if (/^\s*UPDATE\s+work_orders/i.test(text)) return { rows: [], rowCount: 1 };
      if (/^\s*UPDATE\s+recruit_campaigns/i.test(text)) return { rows: [], rowCount: 1 };
      return { rows: [], rowCount: 0 };
    });
    const out = await svc.deleteTask({ sheetId: 'S', tabName: 'T', confirm: true, by: '만두', pool });
    ok('ok', out.ok === true, JSON.stringify(out));
    for (const tbl of DELETE_TABLES) {
      assert(pool.log.some(q => new RegExp(`DELETE FROM ${tbl} WHERE sheet_id=\\$1 AND tab_name=\\$2`).test(q.text)),
        `표 ${tbl} 를 지우지 않았다`);
    }
    passed++; console.log(`  ✓ 분류된 ${DELETE_TABLES.length}개 표를 모두 (sheet_id, tab_name) 으로 지운다`);
    ok('★ 작업오더는 링크만 해제한다(오더 삭제 금지 — 다시 접수할 수 있어야 한다)',
      pool.log.some(q => /UPDATE work_orders SET linked_tab_sheet_id=''/.test(q.text))
      && !pool.log.some(q => /DELETE FROM work_orders/i.test(q.text)));
    ok('★ 모집공고는 보관 처리한다(공고 삭제 금지 — 참여 이력·리뷰비 스냅샷 보존)',
      pool.log.some(q => /UPDATE recruit_campaigns SET archived_at=NOW\(\)/.test(q.text))
      && !pool.log.some(q => /DELETE FROM recruit_campaigns/i.test(q.text)));
    ok('업체 소유는 탭 지정(gid) 행만', pool.log.some(q => /DELETE FROM advertiser_campaigns[\s\S]*tab_gid=\$2/.test(q.text)));
    ok('★ 시트 등록행(campaigns)은 남은 탭이 없을 때만',
      pool.log.some(q => /DELETE FROM campaigns[\s\S]*NOT EXISTS[\s\S]*tab_configs/.test(q.text)));
    ok('★ 동시 삭제·동시 주문을 잠근다(advisory lock)',
      pool.log.some(q => /pg_advisory_xact_lock/.test(q.text)));
    ok('gid 는 표를 지우기 전에 읽는다(지운 뒤에는 알 수 없다)',
      pool.log.findIndex(q => /COALESCE\(NULLIF\(tc\.tab_gid/.test(q.text)) < pool.log.findIndex(q => /^\s*DELETE FROM/i.test(q.text)));
    ok('COMMIT 으로 끝난다', pool.log.some(q => /COMMIT/.test(q.text)));
    ok('결과가 건수를 사실대로 말한다', out.campaignsArchived === 1 && out.workOrdersUnlinked === 1 && out.totalRows > 0);
  }
  {
    // gid 를 모르면 업체 소유는 건드리지 않는다(빈 값 매칭 = 남의 탭·시트 전체 소유 삭제)
    const pool = stubPool((text) => {
      if (/COUNT\(\*\)::int AS n/.test(text)) return { rows: [{ n: 0 }] };
      if (/COALESCE\(NULLIF\(tc\.tab_gid/.test(text)) return { rows: [{ gid: null }] };
      return { rows: [], rowCount: 0 };
    });
    const out = await svc.deleteTask({ sheetId: 'S', tabName: 'T', confirm: true, pool });
    ok('★ gid 미상이면 advertiser_campaigns 를 건드리지 않는다',
      out.ok === true && !pool.log.some(q => /DELETE FROM advertiser_campaigns/i.test(q.text)));
  }

  /* ── 미리보기는 읽기 전용 ─────────────────────────────────────────── */
  console.log('\n[E] 미리보기 — 쓰기 0건');
  {
    const pool = stubPool((text) => {
      if (/FROM tab_configs tc WHERE/.test(text)) return { rows: [{ sheetId: 'S', tabName: 'T', displayName: 'T', sheetless: true }] };
      if (/COUNT\(\*\)::int AS n/.test(text)) return { rows: [{ n: 1 }] };
      if (/AS "boardRows"/.test(text)) return { rows: [{ boardRows: 0, participants: 0, orders: 0, reviewFiles: 0, roster: 0 }] };
      return { rows: [] };
    });
    const p = await svc.previewTaskDelete({ sheetId: 'S', tabName: 'T', pool });
    ok('ok', p.ok === true);
    ok('★ 쓰기 쿼리 0건', countWrites(pool.log) === 0);
    ok('돈 기록이 있으면 blocked 로 알린다', p.blocked === true && p.money.length === MONEY_TABLES.length);
    ok('지워질 표·행 수를 돌려준다', p.totalRows === DELETE_TABLES.length && p.tables.length === DELETE_TABLES.length);
  }
  {
    const pool = stubPool(() => ({ rows: [] }));
    let threw = null;
    try { await svc.previewTaskDelete({ sheetId: '', tabName: 'T', pool }); } catch (e) { threw = e; }
    ok('빈 인자는 bad_args', threw && threw.code === 'bad_args');
  }

  /* ── F. 구글시트 무접촉 ───────────────────────────────────────────── */
  console.log('\n[F] 시트 무접촉 · 라우터 · 화면 배선');
  {
    const src = readSrv('src/services/workTabDelete.service.js');
    ok('★ 시트 API 를 부르지 않는다(사용자 확정 — 시트 탭 삭제는 이 기능의 일이 아니다)',
      !/sheets\.service|getSpreadsheetMeta|batchUpdate|drive\.service/.test(src));
    ok('★ 큐에 넣지 않는다(시트 쓰기 경로 0)', !/enqueue\(/.test(src));
    ok('돈 집계는 한 함수(_moneyRows) — 미리보기·실행이 같은 판정',
      (src.match(/function _moneyRows/g) || []).length === 1
      && (src.match(/_moneyRows\(/g) || []).length === 3);
  }
  {
    const router = require('../src/routes/trackB.routes');
    for (const [method, p] of [['get', '/work-tab/delete-preview'], ['post', '/work-tab/delete']]) {
      const layer = (router.stack || []).find(l => l.route && l.route.path === p);
      ok(`${method.toUpperCase()} ${p} 등록`, !!layer && !!layer.route.methods[method]);
      const names = layer.route.stack.map(s => s.name);
      ok(`${p} — authMiddleware 를 먼저 탄다`, names[0] === 'authMiddleware', names.join(','));
      ok(`${p} — adminOrMaster 게이트(AE·광고주 차단)`, names.some(n => /adminOrMaster/i.test(n)), names.join(','));
      ok(`${p} — internal/editorOnly 로 넓히지 않았다`, !names.some(n => /^internalMiddleware$|editorOnly/i.test(n)));
    }
    const src = readSrv('src/routes/trackB.routes.js');
    const i = src.indexOf("router.post('/work-tab/delete'");
    const body = src.slice(i, src.indexOf('\nrouter.', i + 10));
    ok('★ confirm 은 엄격 비교로 서버에서 다시 판정한다', /confirm:\s*b\.confirm\s*===\s*true/.test(body));
    ok('거부 사유는 400대로(500 마스킹에 묻히지 않는다)', /payment_locked[\s\S]{0,120}status\(/.test(body));
  }
  {
    const WD = read('frontend/workdesk.html');
    ok('★ 버튼은 master/admin 에만(서버 게이트와 1:1 — 눌러도 403 인 버튼 금지)',
      /function _taskDelAllowed\(\)\{\s*return STATE\.role==='master'\|\|STATE\.role==='admin';/.test(WD));
    ok('[⋯] 셀은 _taskDelAllowed 를 본다', /_taskMoreCell\(i\)\{[\s\S]{0,200}_taskDelAllowed\(\)/.test(WD));
    ok('행에 [⋯] 칸이 붙어 있다', /\$\{tdToday\}\$\{tdFinish\}\$\{_taskMoreCell\(i\)\}/.test(WD));
    ok('★ onclick 은 인덱스만(시트발 탭명 보간 금지)',
      /openTaskMenu\(\$\{i\},this\)/.test(WD) && !/openTaskMenu\('/.test(WD)
      && /openTaskDelete\(\$\{i\}\)/.test(WD) && !/openTaskDelete\('/.test(WD));
    ok('★ 메뉴는 body 직속(표는 가로 스크롤 컨테이너라 안에 그리면 잘린다)',
      /id='tmMenu'[\s\S]{0,200}document\.body\.appendChild\(m\)/.test(WD));
    ok('★ 바깥 클릭 닫기는 캡처 단계(항목 onclick 의 stopPropagation 을 넘어야 한다)',
      /document\.addEventListener\('click',[\s\S]{0,160}_closeTaskMenu\(\);\s*\},true\)/.test(WD));
    ok('★ 전역 리스너는 1회만(열 때마다 걸면 겹쳐 쌓인다)', /_tmBound=true/.test(WD)
      && (WD.match(/_tmBound=true/g) || []).length === 1);
    ok('★ 실행 전 미리보기를 먼저 부른다', /openTaskDelete[\s\S]{0,900}work-tab\/delete-preview/.test(WD));
    ok('★ 확인 체크 전에는 실행 버튼이 잠겨 있다', /id="tdGo" disabled/.test(WD));
    ok('★ 되돌릴 수 없음을 문장으로 말한다', /영구히 삭제/.test(WD) && /되돌릴 수 없습니다/.test(WD));
    ok('★ 입금 기록이 걸리면 사유와 대안([🏁 마감])을 말한다',
      /입금 기록이 걸려 있습니다/.test(WD) && /이중 송금/.test(WD) && /\[🏁 마감\]/.test(WD));
    ok('★ 입금 기록 삭제는 **별도 버튼 + 별도 체크**로만(일반 삭제 버튼으로는 안 열린다)',
      /_tdGo\(true\)/.test(WD) && /입금 기록까지 삭제/.test(WD) && /id="tdOk"[\s\S]{0,400}_tdGo\(true\)/.test(WD));
    ok('★ 일반 경로는 forcePayment 없이 보낸다', /forcePayment:forcePayment===true/.test(WD));
    ok('★ 미리보기 이후 입금이 생기면(TOCTOU) 확인 화면을 다시 그린다',
      /payment_locked[\s\S]{0,160}openTaskDelete\(i\)/.test(WD));
    ok('★ 미리보기 실패는 "삭제 가능"으로 위장하지 않는다',
      /확인하지 못한 상태로는 지우지 않습니다/.test(WD));
    ok('삭제 후 목록을 다시 읽는다', /_tdGo[\s\S]{0,1200}loadTabs\(\)/.test(WD));
    ok('확인창은 바깥 클릭으로 닫히지 않는다(실수 클릭 보호)', /_tdShell[\s\S]{0,600}바깥 클릭으로 닫지 않는다/.test(WD));
  }

  console.log(`\n✅ workTabDelete — ${passed} 케이스 통과`);
  process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });
