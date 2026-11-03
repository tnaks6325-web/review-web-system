/**
 * qnaWorktableGuards.test.js — Q&A체험단 2단계 회귀가드: 작업표 자동 정리가 날짜별 자리를 흩뜨리지 않는다(결정 321)
 * 실행: node tests/qnaWorktableGuards.test.js
 *
 * 작업표를 스스로 손보는 기능 넷 + 행 삭제·작업 삭제 + 접수 뒤 건수 변경이 대상이다.
 *  ① 빈 줄 날짜 옮기기(relay)       — Q&A 탭이면 아무 줄도 옮기지 않는다.
 *  ② 총 건수 맞추기(slot sync)      — Q&A 탭에서 줄을 늘리거나 줄이려 하면 저장 전체를 거절한다(사용자 확정 1.가).
 *  ③ 번호 겹친 빈 줄 정리           — 자리표에 묶인 줄은 대상에서 뺀다.
 *  ④ 아무 빈 줄에나 주문 끼우기      — Q&A 탭은 자리 번호 없는 주문을 받지 않는다(맨 뒤 덧붙이기도 없음).
 *  ⑤ 행 삭제 보충                   — 같은 날짜로 보충하고 자리표가 새 줄을 가리킨다.
 *  ⑥ 오더 공유 패치(인트라넷)        — 건수·하루 건수 변경 거절 · 상품 더하기/빼기 영구 금지.
 * ★ Q&A 탭이 아니면(자리표 없음) 전부 종전 그대로여야 한다 — 그것도 실제로 돌려 본다.
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');

let pass = 0;
const t = (name, cond) => { assert(cond, name); pass++; console.log('  ✓ ' + name); };
const S = p => fs.readFileSync(path.join(__dirname, '..', p), 'utf8');

const qna = require('../src/services/qnaSlots.service');
const scope = require('../src/utils/sheetlessScope');

(async () => {
  console.log('\n▶ Q&A체험단 2단계 — 작업표 자동 정리 격리\n');

  /* ── 0) Q&A 탭 판정 ─────────────────────────────────────────── */
  console.log('0) Q&A 탭 판정');
  const q1 = { query: async (sql) => (/FROM qna_slots/.test(sql) ? { rows: [{ '?column?': 1 }] } : { rows: [] }) };
  const q0 = { query: async () => ({ rows: [] }) };
  t('자리표가 있으면 Q&A 탭', await qna.isQnaTab(q1, 's', 't') === true);
  t('없으면 아님', await qna.isQnaTab(q0, 's', 't') === false);
  t('★ 조회 실패 = Q&A 탭으로 본다(자동 정리를 쉰다 · fail-closed)', await qna.isQnaTab({ query: async () => { throw new Error('x'); } }, 's', 't') === true);
  t('표가 없는 환경(42P01) = 아님', await qna.isQnaTab({ query: async () => { throw Object.assign(new Error('x'), { code: '42P01' }); } }, 's', 't') === false);
  t('탭 이름이 없으면 아님', await qna.isQnaTab(q1, '', 't') === false);

  /* ── ① 빈 줄 날짜 옮기기 ─────────────────────────────────────── */
  console.log('\n① 빈 줄 날짜 옮기기');
  const daily = require('../src/services/sheetlessDailyPlan.service');
  const relayRun = async (isQna) => {
    const sqls = [];
    const rows = [{ id: 'a', seq: 2, reviewer_name: '', recipient_name: '', phone8: '', order_submission_id: null, row_json: { 번호: '1', 진행일자: '9 / 26 (토)' }, option_text: null }];
    const client = { query: async (sql, params) => {
      sqls.push(String(sql));
      if (/FROM qna_slots/.test(sql)) return { rows: isQna ? [{ x: 1 }] : [] };
      if (/SELECT[\s\S]*FROM campaign_participants/.test(sql)) return { rows };
      if (/UPDATE campaign_participants/.test(sql)) return { rowCount: (params.length - 2) / 2 };
      throw new Error('unexpected sql ' + sql.slice(0, 40));
    } };
    const r = await daily.relayWorktableToProjection({ client, sheetId: 's', tabName: 't', days: [{ date: '2026-09-29', quota: 1 }], today: '2026-09-26' });
    return { r, sqls };
  };
  const rq = await relayRun(true);
  t('★★ Q&A 탭: 건너뛰고 줄을 읽지도 쓰지도 않는다', rq.r.skipped === true && rq.r.reason === 'qna_slot_calendar'
    && !rq.sqls.some(s => /campaign_participants/.test(s)));
  const rr = await relayRun(false);
  t('리뷰 탭: 종전대로 옮긴다', rr.r.ok === true && !rr.r.skipped && rr.sqls.some(s => /UPDATE campaign_participants/.test(s)));

  /* ── ② 총 건수 맞추기 ─────────────────────────────────────────── */
  console.log('\n② 총 건수 맞추기');
  const lrq = require('../src/services/linkedRecruitQuota.service');
  const syncRun = async (isQna, target) => {
    const sqls = [];
    const rows = [1, 2, 3, 4].map(i => ({ id: 'p' + i, seq: i + 1, tab_gid: null, reviewer_name: '', recipient_name: '', phone8: '', order_submission_id: null }));
    const client = { query: async (sql) => {
      sqls.push(String(sql));
      if (/FROM qna_slots/.test(sql)) return { rows: isQna ? [{ x: 1 }] : [] };
      if (/SELECT id, seq, tab_gid, reviewer_name/.test(sql)) return { rows };
      if (/SELECT reviewer_name, recipient_name, phone8, order_submission_id/.test(sql)) return { rows };
      if (/UPDATE campaign_participants|INSERT INTO campaign_participants|SELECT COALESCE\(MAX\(seq\)/.test(sql)) return { rows: [{ max: 5 }], rowCount: 1 };
      return { rows: [] };
    } };
    const before = scope.isSheetless;
    scope.isSheetless = async () => true;
    try { return { out: await lrq.syncWorktableSlotsInTx(client, { linked_sheet_id: 's', linked_tab_name: 't' }, target, 'test'), sqls }; }
    catch (e) { return { err: e, sqls }; }
    finally { scope.isSheetless = before; }
  };
  const down = await syncRun(true, 3);
  t('★★ Q&A 탭에서 줄이기 = 거절(recruit_quota_qna_locked) · 줄을 지우지 않는다', down.err && down.err.code === 'recruit_quota_qna_locked'
    && !down.sqls.some(s => /UPDATE campaign_participants/.test(s)));
  const up = await syncRun(true, 6);
  t('★★ Q&A 탭에서 늘리기 = 거절 · 줄을 덧붙이지 않는다', up.err && up.err.code === 'recruit_quota_qna_locked'
    && !up.sqls.some(s => /INSERT INTO campaign_participants/.test(s)));
  const sameQ = await syncRun(true, 4);
  t('Q&A 탭이라도 건수가 같으면 통과(발행 때 같은 수)', !sameQ.err && sameQ.out.synced === true);
  const rvDown = await syncRun(false, 3);
  t('리뷰 탭은 종전대로 빈 줄을 줄인다', !rvDown.err && rvDown.out.retire === 1);
  t('★ 저장 전 확인(assert)도 같은 규칙을 탄다 — 저장 뒤 실패를 만들지 않는다',
    (S('src/services/linkedRecruitQuota.service.js').match(/await _assertQnaCalendarUnchanged\(client, campaign, delta\);/g) || []).length === 2);
  t('거절 코드는 recruit_quota 계열(공유 패치가 거절로 접는다)', /\/\^recruit_quota\/\.test\(String\(e\.code/.test(S('src/services/sharedPatch.service.js')));

  /* ── ③ 번호 겹친 빈 줄 정리 ─────────────────────────────────────── */
  console.log('\n③ 번호 겹친 빈 줄 정리');
  t('★ 자리표에 묶인 줄은 정리 대상에서 뺀다', /AND NOT \$\{require\('\.\/qnaSlots\.service'\)\.boundRowSql\('p'\)\}/.test(S('src/services/rowNumbering.service.js')));
  t('묶임 판정 SQL = 같은 탭·같은 줄 번호', qna.boundRowSql('p') === "EXISTS (SELECT 1 FROM qna_slots qs WHERE qs.sheet_id = p.sheet_id AND qs.tab_name = p.tab_name AND qs.seq = p.seq)");

  /* ── ④ 주문 끼우기 ───────────────────────────────────────────── */
  console.log('\n④ 아무 빈 줄에나 주문 끼우기');
  const so = S('src/services/sheetlessOrder.service.js');
  const iQ = so.indexOf("reason: 'qna_slot_required'");
  const iPick = so.indexOf('const picked = await _pickOpenSlot(client');
  const iAppend = so.indexOf("require('./participants.service').appendSlot(client");
  t('★★ Q&A 탭은 자리 번호 없는 주문을 빈 줄 고르기·덧붙이기 **전에** 멈춘다', iQ > 0 && iQ < iPick && iQ < iAppend);
  t('멈출 때 트랜잭션을 되돌린다', /isQnaTab\(client, sheetId, tabName\)\) \{\s*await client\.query\('ROLLBACK'\);/.test(so));

  /* ── ⑤ 행 삭제 보충 ─────────────────────────────────────────── */
  console.log('\n⑤ 행 삭제 보충');
  const tb = S('src/services/trackB.service.js');
  t('★ Q&A 탭: 지운 줄과 같은 날로 보충', /const finalDateLabel = _qnaTab \? removedRaw : \(planLabel \|\| lastSheetLabel \|\| removedRaw\);/.test(tb));
  t('★ Q&A 탭: 총 건수와 무관하게 늘 보충', /const shouldReplenish = _qnaTab \|\| !\(boardTarget > 0 && boardAfterDelete >= boardTarget\);/.test(tb));
  t('★★ 자리표가 보충 줄을 가리키게 같은 트랜잭션에서 옮긴다',
    /if \(_qnaTab && replacement\) \{\s*await client\.query\(\s*'UPDATE qna_slots SET seq = \$4, updated_at = NOW\(\) WHERE sheet_id = \$1 AND tab_name = \$2 AND seq = \$3',\s*\[sheetId, tabName, row\.seq, replacement\.rows\[0\]\.seq\]\);/.test(tb));
  t('작업 삭제 때 자리표도 함께 지운다', require('../src/services/workTabDelete.service').DELETE_TABLES.includes('qna_slots'));

  /* ── ⑥ 오더 공유 패치 ─────────────────────────────────────────── */
  console.log('\n⑥ 오더 공유 패치(인트라넷)');
  const sp = require('../src/services/sharedPatch.service');
  t('★ Q&A 오더는 접수 뒤 상품·옵션 더하기·빼기 영구 금지', sp.structurePermanentlyLocked({ work_kind: 'qna', product_options_json: '[]' }) === true
    && sp.structurePermanentlyLocked({ work_kind: 'review', product_options_json: '[]', delivery_type: '실배송' }) === false);
  t('★ 건수·하루 건수 변경은 저장 전체를 거절', /CANON\.workKind\(prev\.work_kind \|\| next\.work_kind\) === 'qna' && \(total !== prevTotal \|\| changed\.length\)\) \{\s*return reject\('qna_calendar_locked'/.test(S('src/services/sharedPatch.service.js')));

  /* ── ⑦ 접수 뒤·발행 전 수정 경로 3곳 ─────────────────────────────── */
  console.log('\n⑦ 접수 뒤(발행 전) 작업오더 수정 — 인트라넷 원본·옛 갱신·리뷰웹 수정 창');
  const orr = S('src/routes/order.routes.js');
  t('★★ 인트라넷 원본 수정: 자리표가 깔린 Q&A 오더는 공고 연결 전이라도 작업표 칸 변경을 409',
    /if \(await _qnaCalendarLocked\(current\)\) \{\s*const locked = _acceptedWorktableLockedFields\(current, b, optionsJson\);/.test(orr));
  const iQnaSrc = orr.indexOf('if (await _qnaCalendarLocked(current))');
  t('★ 그 판정은 양방향·담당자 전용 경로보다 먼저 — 어느 갈래로도 새지 않는다',
    iQnaSrc > 0 && iQnaSrc < orr.indexOf('if (_sourceManagerCapability(b)) {') && iQnaSrc < orr.indexOf("if (current.bidir_state === 'on') {"));
  t('★ 옛 갱신 경로: 접수 잠금 OR Q&A 자리표', /if \(isSourceEditLocked\(cur\[0\]\) \|\| await _qnaCalendarLocked\(cur\[0\]\)\) \{/.test(orr));
  t('★ 리뷰웹 작업오더 수정 창도 막는다', /_handlers\.orderAdminEdit = [\s\S]{0,1600}if \(await _qnaCalendarLocked\(o\)\) \{/.test(orr));
  t('잠금 판정 = Q&A 종류 + 그 오더의 자리표 존재(리뷰·블로그는 항상 아님) · 조회 실패는 잠금',
    /normalizeWorkKind\(o\.work_kind\) !== 'qna' \|\| !o\.id\) return false;/.test(orr) && /logger\.warn\(`\[order\] Q&A 자리표 조회 실패 — 접수 뒤 수정을 잠금\(fail-closed\)/.test(orr));
  t('같은 값 재전송·안내 칸 수정은 통과(작업표 칸 비교 한 곳)', (orr.match(/_acceptedWorktableLockedFields\(/g) || []).length === 4);

  console.log(`\n✅ ${pass}개 통과\n`);
})().catch(e => { console.error(e); process.exit(1); });
