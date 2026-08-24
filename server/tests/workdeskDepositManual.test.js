/**
 * workdeskDepositManual.test.js — 관리자 수동 입금처리 + 셀 편집기록 회귀가드 (2026-08-24)
 *
 * 배경: 입금 칸은 직접 편집이 잠긴 상태 칸이라 값을 고칠 창구가 없었다(이체 자동반영이 닿지
 * 못한 건은 영영 틀린 채로 남았다). 우클릭 [💰 입금수정] = 달력 확정/비우기 단일 창구.
 * 동시에 ↩ 되돌리기 버튼을 없애고, 그 자리를 **셀 편집기록**(구글시트식 인라인 팝업)이 대신한다.
 *
 * 고정하는 것:
 *   A. setWorkdeskDepositDate — 작업표 칸 **치환**(병합 아님) + 장부 재생성 + 물리 토글
 *   B. 비우기 — 빈 값이 그대로 칸에 써지고 is_paid=false(입금관리 대상으로 복귀)
 *   C. fail-closed — 시트 기반 · 중복 앵커 · 입금 열 없음 · 잘못된 날짜 = 쓰기 0건
 *   D. 감사 로그 — 셀 편집과 **같은 표**(participant_edits)에 append-only 로 남는다
 *   E. listCellEdits — 그 칸의 기록만(되돌림 포함) · 앵커는 읽는 쪽과 같은 규칙
 *   F. 라우트 — deposit-date(adminOrMaster) · cell-edits(셀 편집 스코프)
 *   G. 프론트 — ↩ 버튼 부재 · 입금 칸 메뉴 = [💰 입금수정] · 편집기록 마크/팝업 배선
 *   H. 리뷰어 화면 — 관리자 확정 입금일이 페이백 날짜로 나간다(이체 원장이 있으면 그쪽 우선)
 *
 * 실행: node tests/workdeskDepositManual.test.js
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const svc = require('../src/services/trackB.service');
const ledger = require('../src/services/sheetlessLedger.service');

const ROOT = path.join(__dirname, '..');
const FRONT = path.join(ROOT, '..', 'frontend');

function makePool(sc) {
  const q = [];
  const client = {
    async query(sql, params) {
      const s = String(sql).replace(/\s+/g, ' ').trim();
      q.push({ s, params });
      if (/^BEGIN|^ROLLBACK|^COMMIT/.test(s)) return { rows: [] };
      if (/FROM campaign_participants WHERE id=\$1 .* FOR UPDATE/.test(s)) {
        return { rows: sc.noRow ? [] : [Object.assign({
          id: 'row-1', seq: 169, source: 'import', order_submission_id: 'os-1', identity_key: 'phone8:82589293',
          phone8: '82589293', recipient_name: '손성락', option_text: '', submit_col: '리뷰', submit_col2: '입금',
          row_json: { 번호: '169', 입금: sc.prev == null ? '' : sc.prev },
        }, sc.row || {})] };
      }
      if (/COUNT\(\*\)::int AS n FROM campaign_participants/.test(s)) return { rows: [{ n: sc.dupCount || 1 }] };
      if (/SELECT submit_col2 AS h FROM review_index/.test(s)) {
        return { rows: sc.noDepositCol ? [] : [{ h: '입금' }] };
      }
      if (/COALESCE\(detected_headers, headers\) AS h FROM raw_sheet_tabs/.test(s)) return { rows: [] };
      if (/UPDATE campaign_participants SET row_json/.test(s)) return { rowCount: 1, rows: [] };
      if (/UPDATE payment_batch_items/.test(s)) return { rowCount: sc.releaseCount == null ? 1 : sc.releaseCount, rows: [] };
      if (/UPDATE participant_edits SET reverted_at/.test(s)) return { rowCount: 1, rows: [] };
      if (/INSERT INTO participant_edits/.test(s)) return { rows: [{ id: 7 }] };
      return { rows: [], rowCount: 0 };
    },
    release() {},
  };
  return {
    q, client,
    async connect() { return client; },
    async query(sql, params) {
      const s = String(sql).replace(/\s+/g, ' ').trim();
      q.push({ s, params });
      if (/COALESCE\(sheetless, FALSE\) AS s FROM tab_configs/.test(s)) return { rows: [{ s: sc.sheetless !== false }] };
      if (/FROM payment_batch_items/.test(s)) return { rows: sc.batchLocked ? [{ '?column?': 1 }] : [] };
      if (/FROM campaign_participants WHERE id=\$1 AND sheet_id=\$2 AND tab_name=\$3 AND deleted_at IS NULL LIMIT 1/.test(s)) {
        return { rows: sc.noRow ? [] : [{ id: 'row-1', source: 'import', order_submission_id: 'os-1', identity_key: 'phone8:82589293', phone8: '82589293', recipient_name: '손성락', option_text: '', row_json: {} }] };
      }
      if (/FROM participant_edits pe WHERE pe\.sheet_id=\$1/.test(s)) return { rows: sc.editRows || [] };
      return { rows: [], rowCount: 0 };
    },
  };
}
const writes = (pool) => pool.q.filter(x => /^(UPDATE|INSERT|DELETE)/.test(x.s));

async function run() {
  const realRebuild = ledger.rebuildLedgers;
  let rebuilds = [];
  ledger.rebuildLedgers = async (a) => { rebuilds.push(a); return { ok: true }; };
  try {
    // ── A. 확정 — 칸 치환 + 장부 재생성 + 물리 토글 ──
    let pool = makePool({ prev: '' });
    svc.__setPoolForTest(pool); rebuilds = [];
    let r = await svc.setWorkdeskDepositDate({ sheetId: 'S', tabName: 'T', rowId: 'row-1', date: '2026-08-21', by: '망고' });
    assert.equal(r.ok, true);
    assert.equal(r.value, '8/21', "표기는 입금 칸 단일 출처('M/D') — 자동 반영과 같은 형식");
    assert.equal(r.column, '입금', '칸 판정 = 그 탭이 실제로 쓰는 상태 열(submit_col2)');
    const up = pool.q.find(x => /UPDATE campaign_participants SET row_json/.test(x.s));
    assert.ok(up, '작업표 칸(row_json)에 쓴다 — 그 값이 장부·리뷰어 화면·입금관리 대상의 단일 근거다');
    assert.equal(up.params[4], '8/21');
    assert.equal(up.params[5], true, 'is_paid 물리 토글도 같은 tx에서 맞춘다(카운트 즉시 일치)');
    assert.ok(!/mergeDepositStamps|\|\| ' , '/.test(up.s), '병합이 아니라 치환 — 관리자 창구는 고치고 비우는 자리다');
    assert.equal(rebuilds.length, 1, '장부 재생성 1회(입금관리 대상 제외·리뷰어 표시가 이 파생을 읽는다)');
    console.log('  A. 입금일 확정(치환·재생성·토글) 통과');

    // ── B. 비우기 — 빈 값 기록 + is_paid=false ──
    pool = makePool({ prev: '8/21', batchLocked: true });
    svc.__setPoolForTest(pool); rebuilds = [];
    r = await svc.setWorkdeskDepositDate({ sheetId: 'S', tabName: 'T', rowId: 'row-1', date: '', by: '망고' });
    assert.equal(r.ok, true); assert.equal(r.cleared, true); assert.equal(r.value, '');
    assert.equal(r.prev, '8/21', '지운 값이 무엇이었는지 응답이 말한다');
    const cl = pool.q.find(x => /UPDATE campaign_participants SET row_json/.test(x.s));
    assert.equal(cl.params[4], '', '칸을 빈 값으로 갈아끼운다(= 미입금으로 되돌아간다)');
    assert.equal(cl.params[5], false, 'is_paid 해제');
    assert.equal(r.batchLocked, true, '이체 회차에 잡힌 줄은 비워도 목록에 안 돌아온다는 사실을 말한다');
    assert.equal(rebuilds.length, 1);
    console.log('  B. 입금일 비우기 통과');

    // ── B′. 비우기는 그 사람의 이체 회차 항목만 푼다(회차 전체 취소 아님, 사용자 확정 2026-08-24) ──
    pool = makePool({ prev: '8/21', releaseCount: 1 }); svc.__setPoolForTest(pool);
    r = await svc.setWorkdeskDepositDate({ sheetId: 'S', tabName: 'T', rowId: 'row-1', date: '', by: '망고' });
    assert.equal(r.releasedBatchItems, 1, '풀린 항목 수를 응답이 말한다(화면 토스트 재료)');
    const rel = pool.q.find(x => /UPDATE payment_batch_items/.test(x.s));
    assert.ok(rel, '비울 때만 이체 회차 항목도 함께 정리한다');
    assert.ok(/SET status='failed', fail_reason=\$4, paid_at=NULL/.test(rel.s),
      '새 상태값을 만들지 않는다 — 기존 failed(이체 실패)를 그대로 쓴다(uq_payment_items_active 는 pending/paid 만 잠그므로 즉시 해제)');
    assert.ok(/WHERE sheet_id=\$1 AND tab_name=\$2 AND row_index=\$3 AND status IN \('pending','paid'\)/.test(rel.s),
      '이 사람(row_index) 항목만 — 같은 batch_id 의 다른 사람 항목·회차 상태는 무접촉');
    assert.equal(rel.params[2], 169, '이 줄의 seq 로만 스코프');
    assert.match(rel.params[3], /관리자\(망고\)가 작업표 입금 기록을 비워/, '왜 실패 처리됐는지 사유가 남는다(관리자 화면에 노출)');
    // 채운 값을 다시 확정할 때는 이체 회차를 건드리지 않는다(입금 확정은 "됐다"는 뜻이라 회차와 무관).
    pool = makePool({ prev: '' }); svc.__setPoolForTest(pool);
    r = await svc.setWorkdeskDepositDate({ sheetId: 'S', tabName: 'T', rowId: 'row-1', date: '2026-08-21', by: '망고' });
    assert.equal(r.releasedBatchItems, 0);
    assert.ok(!pool.q.some(x => /UPDATE payment_batch_items/.test(x.s)), '확정(비우기 아님)은 회차 항목을 건드리지 않는다');
    console.log("  B′. 이체 회차 부분 해제(그 사람만) 통과");

    // ── C. fail-closed ──
    pool = makePool({ sheetless: false }); svc.__setPoolForTest(pool);
    r = await svc.setWorkdeskDepositDate({ sheetId: 'S', tabName: 'T', rowId: 'row-1', date: '2026-08-21' });
    assert.equal(r.error, 'not_sheetless'); assert.equal(writes(pool).length, 0, '시트 기반 = 쓰기 0건');
    pool = makePool({}); svc.__setPoolForTest(pool);
    r = await svc.setWorkdeskDepositDate({ sheetId: 'S', tabName: 'T', rowId: 'row-1', date: '8/21' });
    assert.equal(r.error, 'bad_date'); assert.equal(pool.q.length, 0, '형식 밖 날짜 = 쿼리 0');
    pool = makePool({ dupCount: 2 }); svc.__setPoolForTest(pool);
    r = await svc.setWorkdeskDepositDate({ sheetId: 'S', tabName: 'T', rowId: 'row-1', date: '2026-08-21' });
    assert.equal(r.error, 'ambiguous_order', '중복 앵커 = 어느 줄의 입금인지 모른다 → 어느 줄에도 안 쓴다');
    assert.equal(writes(pool).length, 0);
    pool = makePool({ noDepositCol: true }); svc.__setPoolForTest(pool);
    r = await svc.setWorkdeskDepositDate({ sheetId: 'S', tabName: 'T', rowId: 'row-1', date: '2026-08-21' });
    assert.equal(r.error, 'no_status_column', '입금 열이 없는 표는 거부(아무 칸에나 쓰지 않는다)');
    assert.equal(writes(pool).length, 0);
    pool = makePool({ prev: '8/21' }); svc.__setPoolForTest(pool); rebuilds = [];
    r = await svc.setWorkdeskDepositDate({ sheetId: 'S', tabName: 'T', rowId: 'row-1', date: '2026-08-21' });
    assert.equal(r.unchanged, true, '같은 값 = 무동작(저장 왕복·로그 도배 방지)');
    assert.equal(writes(pool).length, 0); assert.equal(rebuilds.length, 0);
    console.log('  C. fail-closed 통과');

    // ── D. 감사 로그 = participant_edits(셀 편집과 같은 표) ──
    pool = makePool({ prev: '' }); svc.__setPoolForTest(pool);
    await svc.setWorkdeskDepositDate({ sheetId: 'S', tabName: 'T', rowId: 'row-1', date: '2026-08-21', by: '망고' });
    const ins = pool.q.filter(x => /INSERT INTO participant_edits/.test(x.s));
    assert.equal(ins.length, 2, '입금 칸 기록 + 연동 토글(is_paid) 두 줄');
    const colIns = ins.find(x => String(x.params[4]) === 'col:입금');
    assert.ok(colIns, '필드명은 셀 편집과 같은 col:<헤더> — 편집기록 팝업이 한 곳에서 읽는다');
    assert.equal(colIns.params[5], '8/21'); assert.equal(colIns.params[6], '망고', '누가 고쳤는지 남는다');
    assert.ok(pool.q.some(x => /UPDATE participant_edits SET reverted_at/.test(x.s)), '이전 활성 기록은 접는다(append-only)');
    console.log('  D. 감사 로그 통과');

    // ── E. listCellEdits — 그 칸의 기록만, 되돌림 포함 ──
    pool = makePool({ editRows: [
      { id: 2, field: 'col:입금', kind: 'text', valueText: '', createdBy: '망고', createdAt: '2026-08-24T01:00:00Z', revertedBy: null, revertedAt: null },
      { id: 1, field: 'col:입금', kind: 'text', valueText: '8/21', createdBy: '만두', createdAt: '2026-08-21T09:00:00Z', revertedBy: '망고', revertedAt: '2026-08-24T01:00:00Z' },
    ] });
    svc.__setPoolForTest(pool);
    const h = await svc.listCellEdits({ sheetId: 'S', tabName: 'T', rowId: 'row-1', field: 'col:입금' });
    assert.equal(h.ok, true); assert.equal(h.items.length, 2);
    assert.equal(h.items[0].cleared, true, '빈 값은 "지움"으로 읽힌다(빈 칸으로 그리면 무슨 일이 있었는지 안 보인다)');
    assert.equal(h.items[1].value, '8/21'); assert.equal(h.items[1].by, '만두');
    assert.equal(h.items[1].reverted, true, '되돌림 기록도 지우지 않고 그대로 보여 준다');
    const sel = pool.q.find(x => /FROM participant_edits pe WHERE pe\.sheet_id=\$1/.test(x.s));
    assert.equal(sel.params[2], 'col:입금', '그 칸만 조회(다른 열 이력 노출 금지)');
    assert.ok(/ORDER BY pe\.created_at DESC/.test(sel.s), '최신이 위');
    console.log('  E. listCellEdits 통과');

    // ── F. 라우트 배선 ──
    const routes = fs.readFileSync(path.join(ROOT, 'src', 'routes', 'trackB.routes.js'), 'utf8');
    assert.ok(/deposit-date', authMiddleware, adminOrMasterMiddleware/.test(routes), '입금 수정 = adminOrMaster(정산·리뷰어 화면까지 바꾼다)');
    const ce = routes.indexOf("router.get('/workdesk/cell-edits'");
    assert.ok(ce >= 0, 'cell-edits 라우트 존재');
    const ceBody = routes.slice(ce, routes.indexOf('router.', ce + 10));
    assert.ok(/_ensureWorkdeskCellEditScope\(req, \{ sheetId, tabName, field \}\)/.test(ceBody),
      '편집기록 조회 스코프 = 셀 편집과 동일(업체는 자기 송장 칸만)');
    console.log('  F. 라우트 배선 통과');

    // ── G. 프론트 배선 ──
    const html = fs.readFileSync(path.join(FRONT, 'workdesk.html'), 'utf8');
    assert.ok(!/class="revb"/.test(html), '↩ 되돌리기 버튼은 제거됐다(버튼으로 되돌릴 수 없다)');
    assert.ok(!/편집 되돌리기/.test(html), '우클릭 메뉴의 되돌리기 항목도 없다');
    assert.ok(!/function revertCell\(/.test(html) && !/function _revertSelection\(/.test(html), '되돌리기 실행부도 남기지 않는다');
    assert.ok(/row\('💰','입금수정',"openDepositEdit\(\)"/.test(html), '입금 칸의 주 행동 = [💰 입금수정]');
    assert.ok(/const isPayCell = one && statusKind==='payment';/.test(html), '입금 칸 판정(한 칸 선택일 때)');
    assert.ok(/api\('\/api\/trackb\/workdesk\/deposit-date'/.test(html), '저장 경로는 전용 API 하나');
    assert.ok(/onclick="_wdDpClearDeposit\(\)"/.test(html), '달력에 [입금일 비우기]');
    assert.ok(/if\(r\.releasedBatchItems\) setTimeout\(\(\)=>toast\('이체 회차 잠금도 이 사람 몫만 함께 풀렸습니다/.test(html),
      '비우면 이체 회차도 그 사람 몫만 풀렸다고 말한다(회차 전체 취소와 다름을 명시)');
    assert.ok(/if\(S\.mode==='deposit'\)\{ _wdDpSaveDeposit\(iso\); return; \}/.test(html), '입금 모드는 구매일자 경로를 타지 않는다');
    assert.ok(/_depositMenuBlockReason/.test(html), '못 누르는 사유를 숨기지 않는다(흐린 항목 + 툴팁)');
    assert.ok(/function _ehistMark\(/.test(html) && /class="ehist"/.test(html), '편집기록이 있는 칸에 코너마크');
    assert.ok(/api\('\/api\/trackb\/workdesk\/cell-edits\?'/.test(html), '편집기록 팝업이 전용 API 를 읽는다');
    assert.ok(/#chPop \.ch-box\{position:absolute/.test(html) && /#chPop\{position:fixed/.test(html), '팝업은 body 직속(표 안에 그리면 잘린다)');
    assert.ok(/document\.getElementById\('chPop'\)\) _chClose\(\); \}, true\)/.test(html), '스크롤/Esc 로 닫는다(앵커를 잃은 팝오버는 남기지 않는다)');
    assert.ok(/row\('🕘','편집기록','_menuCellHistory\(\)'/.test(html), '기록이 없는 칸에서도 볼 수 있는 메뉴 창구');
    console.log('  G. 프론트 배선 통과');

    // ── G′. 화면 함수 vm 실행 — 렌더가 실제로 돌고, 시트발 문자열이 속성을 깨지 않는다 ──
    const vm = require('vm');
    const sandbox = {
      esc: (x) => String(x == null ? '' : x).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])),
      STATE: { role: 'master', wd: { meta: { sheetless: true } } },
      _isInternalRole: () => true,
    };
    vm.createContext(sandbox);
    vm.runInContext(html.match(/function _ehistMark\(rowId, field\)\{[\s\S]*?\n\}/)[0], sandbox);
    vm.runInContext(html.match(/function _depositMenuBlockReason\(td, row\)\{[\s\S]*?\n\}/)[0], sandbox);
    const mark = vm.runInContext('_ehistMark', sandbox)('r1', 'col:입금"><img src=x onerror=alert(1)>');
    assert.ok(!/<img/.test(mark), '시트 헤더가 그대로 태그가 되면 안 된다(속성 escape)');
    assert.ok(/data-field="col:입금&quot;&gt;/.test(mark), '따옴표·꺾쇠는 엔티티로');
    const reason = vm.runInContext('_depositMenuBlockReason', sandbox);
    assert.equal(reason({}, { id: 'r1' }), '', 'master + 무시트 + 단일 앵커 = 실행 가능');
    assert.match(reason({}, { id: 'r1', ambiguous: true }), /중복 줄/, '중복 줄은 사유를 말한다');
    sandbox.STATE = { role: 'staff', wd: { meta: { sheetless: true } } };
    assert.match(reason({}, { id: 'r1' }), /관리자\(master\/admin\)/, 'AE 는 사유와 함께 흐리게(서버 adminOrMaster 와 1:1)');
    sandbox.STATE = { role: 'master', wd: { meta: { sheetless: false } } };
    assert.match(reason({}, { id: 'r1' }), /시트에서 고쳐야/, '시트 기반 탭은 화면도 서버와 같은 말을 한다');
    console.log("  G′. 화면 함수 vm 실행 통과");

    // ── H. 리뷰어 화면 — 관리자 확정 입금일이 페이백 날짜로 ──
    const re = fs.readFileSync(path.join(ROOT, 'src', 'routes', 'reviewEdit.routes.js'), 'utf8');
    const brief = re.slice(re.indexOf("router.get('/participation-brief'"), re.indexOf('POST /api/review-edit/order-cancel'));
    const batchAt = brief.indexOf('FROM payment_batch_items');
    const cellAt = brief.indexOf('AS "depositCell"');
    assert.ok(batchAt >= 0 && cellAt > batchAt, '이체 원장이 먼저 — 자동 반영이 있으면 그 값이 이긴다');
    assert.ok(/if \(!payment\) \{/.test(brief), '원장이 없을 때만 작업표 입금 칸을 본다(사본 0)');
    assert.ok(/ri\.submit_col2/.test(brief), '입금 칸 판정은 파서가 고른 헤더(submit_col2) 단일 출처');
    const idx = fs.readFileSync(path.join(FRONT, 'index.html'), 'utf8');
    assert.ok(/pay\.paidDate \? escHtml\(_partInfoPaidDate\(pay\.paidDate\)\)/.test(idx), '리뷰어 카드가 그 날짜를 그린다');
    console.log('  H. 리뷰어 페이백 날짜 통과');
  } finally {
    ledger.rebuildLedgers = realRebuild;
    svc.__setPoolForTest(null);
  }
  console.log('✅ workdeskDepositManual: 전부 통과');
  process.exit(0);
}
run().catch(e => { console.error('❌', e); process.exit(1); });
