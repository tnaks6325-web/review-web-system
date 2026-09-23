/**
 * sheetlessOrphanCleanup.test.js — 회귀가드: 무시트 접수 잔재(빈 가상 탭) 정리
 * 실행: node tests/sheetlessOrphanCleanup.test.js
 *
 * 배경(2026-08-19 실사고 「8/19)유일기획_쿠팡_암막커튼 20건」 작업바 11줄):
 *   랜덤 가상 시트ID 시절, 접수가 링크 기록(마지막 단계) 전에 실패하면 tab_configs 줄만 남았고
 *   재시도마다 시트ID가 달라 탭이 하나씩 늘었다. 재발은 결정적 ID 파생이 막았고, 이 서비스는
 *   **이미 만들어진 잔재**를 사람이 화면에서 치우는 창구다.
 *
 * 고정하는 것:
 *  A. 조작은 `tab_configs.is_closed` 한 칸 — 데이터 삭제 0(다른 테이블 쓰기 0)
 *  B. 판정 fail-closed — 가상 ID · 줄/명단/주문 0 · 오더/공고/계약 미연결 · 유예시간
 *  C. 미리보기는 쓰기 0 / 실행은 서버가 후보를 다시 골라 **교집합만** 닫는다
 *  D. UPDATE 에도 조건을 다시 건다(TOCTOU)
 *  E. 라우트(adminOrMaster · dryRun 기본) · 화면 배선(2단계 · 부분결과 고지)
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const read = p => fs.readFileSync(path.join(__dirname, '..', p), 'utf8');
const readFe = p => fs.readFileSync(path.join(__dirname, '..', '..', 'frontend', p), 'utf8');
const noLineComments = s => s.split('\n').filter(l => !l.trim().startsWith('//')).join('\n');

let passed = 0;
const ok = (name, cond, extra) => { assert(cond, name + (extra ? ' — ' + extra : '')); passed++; console.log('  ✓ ' + name); };

const SRC = 'src/services/sheetlessOrphanCleanup.service.js';
const svc = require('../' + SRC);
const src = noLineComments(read(SRC));

function makePool(handler) {
  const calls = [];
  return { calls, query: async (sql, params) => { calls.push({ sql: String(sql).replace(/\s+/g, ' ').trim(), params }); return handler(String(sql), params) || { rows: [], rowCount: 0 }; } };
}
const ORPHANS = [
  { sheetId: 'wt_aaaa', tabName: '8/19)유일기획_쿠팡_암막커튼 20건', tabGid: '1', displayName: 'x', updatedAt: new Date(), siblings: '10' },
  { sheetId: 'wt_bbbb', tabName: '8/19)유일기획_쿠팡_암막커튼 20건', tabGid: '2', displayName: 'x', updatedAt: new Date(), siblings: '10' },
];

(async () => {
  /* ══════════════ A. 쓰기 표면 ══════════════ */
  console.log('\n[A] 쓰기 표면 — is_closed 한 칸뿐(데이터 삭제 0)');
  {
    const writes = (src.match(/\b(INSERT INTO|DELETE FROM|UPDATE)\s+[a-z_]+/gi) || []).map(x => x.replace(/\s+/g, ' '));
    ok('★ 쓰기는 tab_configs UPDATE 하나뿐', writes.length === 1 && /UPDATE tab_configs/i.test(writes[0]), writes.join(' | '));
    ok('★ DELETE·TRUNCATE 없음(되돌릴 수 있는 조작만)', !/\bDELETE\b|\bTRUNCATE\b|\bDROP\b/i.test(src));
    ok('★ 작업표·장부·주문·campaigns 에 쓰지 않는다',
      !/(INSERT INTO|UPDATE|DELETE FROM)\s+(campaign_participants|review_index|raw_sheet_|order_submissions|campaigns)/i.test(src));
    ok('★ 사람이 부를 때만 — 크론·부팅 잡에 배선되지 않았다', (() => {
      const files = ['src/index.js', 'src/services/smartBuild.service.js', 'src/services/rawMirror.service.js'];
      return files.every(f => { try { return !/sheetlessOrphanCleanup/.test(read(f)); } catch (_) { return true; } });
    })());
  }

  /* ══════════════ B. 판정 fail-closed ══════════════ */
  console.log('\n[B] 후보 판정 — "어디에도 쓰이지 않는 빈 가상 탭"만');
  {
    let sql = '';
    svc.__setPoolForTest(makePool(s => { sql = s; return { rows: ORPHANS }; }));
    const out = await svc.findOrphanTabs({});
    const q = sql.replace(/\s+/g, ' ');
    ok('무시트 표식 + 미마감만', /COALESCE\(tc\.sheetless, FALSE\) = TRUE/.test(q) && /COALESCE\(tc\.is_closed, FALSE\) = FALSE/.test(q));
    ok('★ 가상 시트ID 만 — 진짜 구글시트 탭은 대상 아님', /tc\.sheet_id LIKE \$1/.test(q));
    ok('★ 접두는 서버 단일 출처에서 온다(사본 금지)', /VIRTUAL_SHEET_PREFIX/.test(src) && !/'wt_'/.test(src));
    ok('★ 작업표 활성 줄 0', /NOT EXISTS \(SELECT 1 FROM campaign_participants p[\s\S]*?p\.deleted_at IS NULL\)/.test(q));
    ok('★ 검색 명단 0', /NOT EXISTS \(SELECT 1 FROM review_index ri/.test(q));
    ok('★ 주문 0', /NOT EXISTS \(SELECT 1 FROM order_submissions os/.test(q));
    ok('★ 작업오더 미연결(접수 성공한 진짜 탭 보호)', /NOT EXISTS \(SELECT 1 FROM work_orders wo[\s\S]*?wo\.linked_tab_sheet_id = tc\.sheet_id/.test(q));
    ok('★ 모집공고 미연결', /NOT EXISTS \(SELECT 1 FROM recruit_campaigns rc[\s\S]*?rc\.linked_sheet_id = tc\.sheet_id/.test(q));
    ok('★ 정산 계약 미연결(사람이 매칭한 탭 보호)', /NOT EXISTS \(SELECT 1 FROM trackb_settlement_links sl/.test(q));
    ok('★ 등록부 활성 행 없음 — 닫아도 목록에 남는 탭은 후보 아님(조용한 no-op 금지)',
      /NOT EXISTS \(SELECT 1 FROM index_master im[\s\S]*?im\.status = 'active'\)/.test(q));
    ok('★ 유예시간 — 진행 중 접수와 경합 차단', /tc\.updated_at < NOW\(\) - \(\$2/.test(q) && svc.GRACE_MINUTES >= 30);
    ok('후보를 그대로 돌려준다(같은 이름 형제 수 포함)',
      out.ok && out.total === 2 && out.items[0].sheetId === 'wt_aaaa' && out.items[0].siblings === 10);
  }

  /* ══════════════ C. 미리보기 / 실행 ══════════════ */
  console.log('\n[C] 미리보기는 쓰기 0 · 실행은 후보 교집합만');
  {
    let pool = makePool(s => /FROM tab_configs\s*$|SELECT tc\.sheet_id/.test(s) || /^\s*SELECT/.test(s) ? { rows: ORPHANS } : { rowCount: 1 });
    svc.__setPoolForTest(pool);
    const dry = await svc.closeOrphanTabs({});
    ok('★ 기본은 미리보기(dryRun 기본값 true)', dry.dryRun === true && dry.total === 2);
    ok('★ 미리보기는 UPDATE 를 한 번도 하지 않는다', !pool.calls.some(c => /^UPDATE /i.test(c.sql)));

    pool = makePool(s => /^\s*SELECT/.test(s) ? { rows: ORPHANS } : { rowCount: 1 });
    svc.__setPoolForTest(pool);
    const run = await svc.closeOrphanTabs({ dryRun: false, by: '테스트' });
    ok('실행하면 후보 수만큼 닫는다', run.dryRun === false && run.closed === 2 && run.total === 2);
    ok('닫는 대상은 그 (시트, 탭)', pool.calls.filter(c => /UPDATE tab_configs/i.test(c.sql))
      .every(c => c.params[0].startsWith('wt_') && c.params[1]));

    pool = makePool(s => /^\s*SELECT/.test(s) ? { rows: ORPHANS } : { rowCount: 1 });
    svc.__setPoolForTest(pool);
    const pick = await svc.closeOrphanTabs({ dryRun: false, sheetIds: ['wt_aaaa', 'wt_NOT_A_CANDIDATE'] });
    ok('★★ 화면이 보낸 목록을 믿지 않는다 — 후보 교집합만 닫는다',
      pick.closed === 1 && pool.calls.filter(c => /UPDATE tab_configs/i.test(c.sql)).length === 1
      && !JSON.stringify(pool.calls).includes('wt_NOT_A_CANDIDATE'));

    pool = makePool(s => /^\s*SELECT/.test(s) ? { rows: [] } : { rowCount: 1 });
    svc.__setPoolForTest(pool);
    const none = await svc.closeOrphanTabs({ dryRun: false });
    ok('후보 0이면 아무것도 하지 않는다', none.closed === 0 && !pool.calls.some(c => /^UPDATE /i.test(c.sql)));

    // 그 사이 사용이 시작돼 UPDATE 가 0행이면 "정리했다"로 세지 않는다
    pool = makePool(s => /^\s*SELECT/.test(s) ? { rows: ORPHANS } : { rowCount: 0 });
    svc.__setPoolForTest(pool);
    const race = await svc.closeOrphanTabs({ dryRun: false });
    ok('★ UPDATE 0행은 성공으로 꾸미지 않는다(부분 결과 그대로)', race.closed === 0 && race.total === 2);
  }

  /* ══════════════ D. TOCTOU ══════════════ */
  console.log('\n[D] UPDATE 에도 조건을 다시 건다');
  {
    const upd = src.slice(src.indexOf('UPDATE tab_configs SET is_closed'));
    ok('★ 무시트·미마감 재확인', /COALESCE\(sheetless, FALSE\) = TRUE/.test(upd) && /COALESCE\(is_closed, FALSE\) = FALSE/.test(upd));
    ok('★ 그 사이 줄이 생겼으면 닫지 않는다', /NOT EXISTS \(SELECT 1 FROM campaign_participants p/.test(upd));
    ok('★ 그 사이 오더가 연결됐으면 닫지 않는다', /NOT EXISTS \(SELECT 1 FROM work_orders wo/.test(upd));
  }

  /* ══════════════ E. 라우트·화면 ══════════════ */
  console.log('\n[E] 라우트(adminOrMaster · dryRun 기본) · 화면 2단계');
  {
    const router = require('../src/routes/trackB.routes');
    const stack = router.stack.filter(l => l.route).map(l => ({
      path: l.route.path, methods: Object.keys(l.route.methods),
      names: l.route.stack.map(h => h.name),
    }));
    const g = stack.find(r => r.path === '/sheetless/orphan-tabs' && r.methods.includes('get'));
    const p = stack.find(r => r.path === '/sheetless/orphan-tabs/close' && r.methods.includes('post'));
    ok('미리보기 GET 존재', !!g);
    ok('실행 POST 존재', !!p);
    ok('★ 둘 다 authMiddleware + adminOrMaster 게이트 뒤',
      [g, p].every(r => r.names.indexOf('authMiddleware') === 0 && r.names.includes('adminOrMasterMiddleware')));
    const rt = noLineComments(read('src/routes/trackB.routes.js'));
    const body = rt.slice(rt.indexOf("router.post('/sheetless/orphan-tabs/close'"));
    ok('★ 라우트도 dryRun 기본(값이 빠진 요청이 실행되지 않는다)', /dryRun: b\.dryRun !== false/.test(body.slice(0, 600)));
    ok('42P01 은 not_ready 로 말한다(마스킹 방지)', /_cutoverErr\(err, res, next\)/.test(body.slice(0, 900)));

    const wd = noLineComments(readFe('workdesk.html'));
    ok('탈시트 전환 헤더에 정리 버튼', /onclick="_coOrphans\(\)">🧹 중복 잔재 정리/.test(wd));
    ok('★ 미리보기 → confirm → 실행 2단계', /_coOrphansGo\(\)/.test(wd) && /confirm\(`빈 시스템 작업/.test(wd));
    ok('★ 실행은 dryRun:false 를 명시해 보낸다', /dryRun:false, sheetIds: items\.map\(t=>t\.sheetId\)/.test(wd));
    ok('★ 프론트 재판정 0 — 서버 items 를 그대로 그린다', !/deleted_at|sheetless\s*===\s*true\s*&&/.test(wd.slice(wd.indexOf('async function _coOrphans('), wd.indexOf('async function _coOrphansGo('))));
    ok('★ 부분 결과를 "완료"로 꾸미지 않는다', /일부만 정리됨/.test(wd));
    ok('★ 조회 실패는 화면을 종결시킨다(무한 로딩 금지)', /잔재 조회 실패[\s\S]{0,200}다시 시도/.test(wd));
    ok('★ 잔재 0건도 사실대로 말한다', /정리할 잔재가 없습니다/.test(wd));
  }

  console.log(`\n✅ sheetlessOrphanCleanup: ${passed} cases passed`);
  process.exit(0);
})().catch(e => { console.error('\n❌ ' + e.message); process.exit(1); });
