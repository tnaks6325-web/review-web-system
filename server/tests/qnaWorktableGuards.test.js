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
  const q1 = { query: async (sql) => (/FROM qna_slots/.test(sql) ? { rows: [{ q: true }] } : { rows: [] }) };
  const q0 = { query: async () => ({ rows: [] }) };
  t('자리표가 있으면 Q&A 탭', await qna.isQnaTab(q1, 's', 't') === true);
  t('없으면 아님', await qna.isQnaTab(q0, 's', 't') === false);
  t('★ 조회 실패 = Q&A 탭으로 본다(자동 정리를 쉰다 · fail-closed)', await qna.isQnaTab({ query: async () => { throw new Error('x'); } }, 's', 't') === true);
  t('★ 표가 없는 환경(42P01)도 Q&A 탭으로 본다 — 표 존재는 기동 필수 표 검사가 보장(조용히 리뷰 탭처럼 정리하지 않는다)',
    await qna.isQnaTab({ query: async () => { throw Object.assign(new Error('x'), { code: '42P01' }); } }, 's', 't') === true);
  t('기동 필수 표 목록에 qna_slots', /REQUIRED_TABLES\s*=\s*\[[\s\S]{0,200}'qna_slots'/.test(S('index.js')));
  t('★ 탭 종류가 Q&A(tab_configs.work_kind)면 자리표가 없어도 Q&A 탭', /tab_configs WHERE sheet_id = \$1 AND tab_name = \$2 AND work_kind = 'qna'/.test(S('src/services/qnaSlots.service.js')));
  // 트랜잭션 연결(release 있음)에서는 SAVEPOINT 로 감싸 실패가 바깥 트랜잭션을 죽이지 않는다
  const spLog = [];
  const txc = { release() {}, query: async (sql) => { spLog.push(sql); if (/SELECT \(EXISTS/.test(sql)) throw new Error('boom'); return { rows: [] }; } };
  t('★ 트랜잭션 안: 실패하면 SAVEPOINT 로 되돌리고 Q&A 탭으로 본다', await qna.isQnaTab(txc, 's', 't') === true
    && spLog[0] === 'SAVEPOINT qna_tab_probe' && spLog.includes('ROLLBACK TO SAVEPOINT qna_tab_probe'));
  const okLog = [];
  const txo = { release() {}, query: async (sql) => { okLog.push(sql); return /SELECT \(EXISTS/.test(sql) ? { rows: [{ q: false }] } : { rows: [] }; } };
  t('트랜잭션 안: 성공하면 SAVEPOINT 를 풀고 결과 그대로', await qna.isQnaTab(txo, 's', 't') === false && okLog.includes('RELEASE SAVEPOINT qna_tab_probe'));
  t('탭 이름이 없으면 아님', await qna.isQnaTab(q1, '', 't') === false);

  /* ── ① 빈 줄 날짜 옮기기 ─────────────────────────────────────── */
  console.log('\n① 빈 줄 날짜 옮기기');
  const daily = require('../src/services/sheetlessDailyPlan.service');
  const relayRun = async (isQna) => {
    const sqls = [];
    const rows = [{ id: 'a', seq: 2, reviewer_name: '', recipient_name: '', phone8: '', order_submission_id: null, row_json: { 번호: '1', 진행일자: '9 / 26 (토)' }, option_text: null }];
    const client = { query: async (sql, params) => {
      sqls.push(String(sql));
      if (/FROM qna_slots/.test(sql)) return { rows: isQna ? [{ q: true, x: 1 }] : [] };
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
      if (/FROM qna_slots/.test(sql)) return { rows: isQna ? [{ q: true, x: 1 }] : [] };
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
  t('★ 지운 줄이 자리표의 자리인지 같은 트랜잭션에서 본다', /const _qnaBound = _qnaTab && await require\('\.\/qnaSlots\.service'\)\.isBoundRow\(client, sheetId, tabName, row\.seq\);/.test(tb));
  t('★ Q&A 탭: 자리 줄은 늘 보충 · 자리 없는 줄은 보충 안 함 / 리뷰 탭은 종전 규칙', /const shouldReplenish = _qnaTab \? _qnaBound : !\(boardTarget > 0 && boardAfterDelete >= boardTarget\);/.test(tb));
  t('보충 자리 줄은 지운 줄의 진행일 칸 표기를 그대로 잇는다', /\(_qnaBound && row\.start_date\) \|\| finalDateLabel \|\| null/.test(tb));
  {
    const bl = [];
    const okc = { release() {}, query: async (sql) => { bl.push(sql); return /FROM qna_slots/.test(sql) ? { rows: [{ x: 1 }] } : { rows: [] }; } };
    const noc = { release() {}, query: async (sql) => (/FROM qna_slots/.test(sql) ? { rows: [] } : { rows: [] }) };
    const bad = { release() {}, query: async (sql) => { if (/FROM qna_slots/.test(sql)) throw new Error('down'); return { rows: [] }; } };
    t('묶인 줄 판정: 있으면 참 · SAVEPOINT 로 감싼다', await qna.isBoundRow(okc, 's', 't', 5) === true && bl[0] === 'SAVEPOINT qna_bound_probe');
    t('묶인 줄 판정: 없으면 거짓(손으로 더한 줄)', await qna.isBoundRow(noc, 's', 't', 5) === false);
    t('★ 묶인 줄 판정 실패 = 묶인 것으로 본다(보충 쪽 — 자리가 사라지지 않게)', await qna.isBoundRow(bad, 's', 't', 5) === true);
  }
  t('★★ 자리표가 보충 줄을 가리키게 같은 트랜잭션에서 옮긴다',
    /if \(_qnaBound && replacement\) \{\s*await client\.query\(\s*'UPDATE qna_slots SET seq = \$4, updated_at = NOW\(\) WHERE sheet_id = \$1 AND tab_name = \$2 AND seq = \$3',\s*\[sheetId, tabName, row\.seq, replacement\.rows\[0\]\.seq\]\);/.test(tb));
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
  t('★★ 인트라넷 원본 수정: 자리표가 깔린 Q&A 오더는 공고 연결 전이라도 자리표 칸 변경을 409',
    /if \(await _qnaCalendarLocked\(current\)\) \{\s*const locked = _qnaLockedFields\(current, b, optionsJson\);/.test(orr));
  const iQnaSrc = orr.indexOf('if (await _qnaCalendarLocked(current))');
  t('★ 그 판정은 양방향·담당자 전용 경로보다 먼저 — 어느 갈래로도 새지 않는다',
    iQnaSrc > 0 && iQnaSrc < orr.indexOf('if (_sourceManagerCapability(b)) {') && iQnaSrc < orr.indexOf("if (current.bidir_state === 'on') {"));
  t('★ 옛 갱신 경로: 접수 잠금 OR Q&A 자리표', /if \(isSourceEditLocked\(cur\[0\]\) \|\| await _qnaCalendarLocked\(cur\[0\]\)\) \{/.test(orr));
  t('★ 옛 갱신 경로: 종전 잠금이면 종전 비교, Q&A 자리표 잠금만이면 자리표 칸 비교',
    /const locked = isSourceEditLocked\(cur\[0\]\)\s*\? _acceptedWorktableLockedFields\(cur\[0\], b, _legacyOptions\)\s*: _qnaLockedFields\(cur\[0\], b, _legacyOptions\);/.test(orr));
  t('★ 리뷰웹 작업오더 수정 창도 막는다', /_handlers\.orderAdminEdit = [\s\S]{0,1600}if \(await _qnaCalendarLocked\(o\)\) \{\s*const locked = _qnaLockedFields\(o, /.test(orr));
  t('잠금 판정 = Q&A 종류 + (작업표 연결 또는 자리표 존재) · 리뷰·블로그는 항상 아님 · 조회 실패는 잠금',
    /normalizeWorkKind\(o\.work_kind\) !== 'qna' \|\| !o\.id\) return false;\s*[^\n]*\n\s*if \(o\.linked_tab_name\) return true;/.test(orr)
    && /logger\.warn\(`\[order\] Q&A 자리표 조회 실패 — 접수 뒤 수정을 잠금\(fail-closed\)/.test(orr));
  t('옛 갱신 경로가 작업표 연결 칸을 읽는다(잠금 판정 재료)', /recall_courier, recall_product, work_kind, product_distribution_mode, start_date, product_options_json, linked_tab_name/.test(orr));

  /* ── ⑧ Q&A 잠금 비교 — 실제로 돌린다(운영과 같은 값 모양) ─────────────── */
  console.log('\n⑧ Q&A 잠금 비교 — 같은 값은 표기가 달라도 통과, 다른 값만 막는다');
  {
    const vm = require('vm');
    const pick = (name) => {
      const i = orr.indexOf(`function ${name}(`);
      let depth = 0, j = orr.indexOf('{', i);
      for (; j < orr.length; j++) { if (orr[j] === '{') depth++; else if (orr[j] === '}' && --depth === 0) break; }
      return orr.slice(i, j + 1);
    };
    const keysLine = orr.match(/const PRODUCT_OPTION_EDITABLE_KEYS = new Set\([^)]*\);/)[0];
    const box = { require: (m) => require(path.join(__dirname, '..', 'src/routes', m)) };
    vm.createContext(box);
    vm.runInContext([keysLine, pick('_sourceCanonicalJson'), pick('_productOptionsLockedShape'), pick('_productOptionsLockedChanged'), pick('_qnaLockedFields'),
      'this.f = _qnaLockedFields;'].join('\n'), box);
    const f = box.f;
    const opts = JSON.stringify([{ name: '토프 가방', product_mode: 'single', base: { count: 20, daily: 2, url: 'https://a', qna: { public_count: 5, public_texts: ['a', 'b', 'c', 'd', 'e'], public_gap_days: 2 } } }]);
    // 운영 DB 행 모양: start_date = Date(UTC 자정 — 서버 UTC), skip_weekends = NULL(안 보냄), holidays = JSON 글자
    const cur = { recruit_count: 20, daily_count: 2, start_date: new Date(Date.UTC(2026, 10, 4)), skip_weekends: null,
      holidays: '["2026-11-20","2026-11-10"]', work_kind: 'qna', review_type: '', delivery_type: '실배송', product_options_json: opts };
    const same = { recruit_count: '20', daily_count: '2', start_date: '2026-11-04', skip_weekends: true,
      holidays: ['2026-11-10', '2026-11-20', '2026-11-10'], work_kind: 'Q&A체험단', review_type: '포토', delivery_type: '빈박스',
      product_options_json: JSON.parse(opts).map(p => ({ ...p, base: { ...p.base, url: 'https://changed' } })) };
    t('★★ 같은 값(표기만 다름: 글자 숫자·날짜 글자·주말 true↔빈 값·제외일 순서·중복)·안내 칸(url) 변경은 통과',
      JSON.stringify(f(cur, same, JSON.stringify(same.product_options_json))) === '[]');
    t('★ 리뷰타입·배송유형은 Q&A 자리표와 무관 — 잠그지 않는다', f(cur, { review_type: '텍스트', delivery_type: '택배대행' }, undefined).length === 0);
    t('총 건수 변경 → 막음', JSON.stringify(f(cur, { recruit_count: 21 }, undefined)) === '["recruit_count"]');
    t('시작일 변경 → 막음', JSON.stringify(f(cur, { start_date: '2026-11-05' }, undefined)) === '["start_date"]');
    t('주말 제외 끄기 → 막음', JSON.stringify(f(cur, { skip_weekends: false }, undefined)) === '["skip_weekends"]');
    t('제외일 추가 → 막음', JSON.stringify(f(cur, { holidays: ['2026-11-10', '2026-11-20', '2026-11-11'] }, undefined)) === '["holidays"]');
    const moreText = JSON.parse(opts); moreText[0].base.qna.public_texts[4] = '다른 문구';
    t('공개 문구 변경 → 막음(상품 구성)', JSON.stringify(f(cur, {}, JSON.stringify(moreText))) === '["product_options_json"]');
    t('종류를 리뷰로 → 막음', JSON.stringify(f(cur, { work_kind: 'review' }, undefined)) === '["work_kind"]');
  }

  /* ── ⑨ 재접수 자리표 복구 — 실제로 돌린다 ─────────────────────────── */
  console.log('\n⑨ 재접수 — 자리표 저장만 실패한 탭을 되살린다(줄과 같을 때만)');
  {
    const planRows = [
      { seq: 2, optionText: '토프 가방', startDate: '11/4 (수)', rowJson: { 공개여부: '공개', 문의문구: '지금 구매했어요' } },
      { seq: 3, optionText: '토프 가방', startDate: '11/4 (수)', rowJson: { 공개여부: '비공개', 문의문구: '배송 문의 자유 (비공개)' } },
    ];
    const dbOf = (rows) => ({ query: async () => ({ rows }) });
    const match = await qna.verifyRowsMatchPlan({ db: dbOf([
      { seq: 2, option_text: '토프 가방', start_date: '11/4 (수)', row_json: { 공개여부: '공개', 문의문구: '지금 구매했어요', 번호: '1' } },
      { seq: 3, option_text: '토프 가방', start_date: '11/4 (수)', row_json: { 공개여부: '비공개', 문의문구: '배송 문의 자유 (비공개)' } },
    ]), sheetId: 's', tabName: 't', planRows });
    t('깔린 줄과 계획이 같으면 붙여도 된다(다른 칸 값은 상관없음)', match.ok === true && match.mismatches.length === 0);
    const diff = await qna.verifyRowsMatchPlan({ db: dbOf([
      { seq: 2, option_text: '토프 가방', start_date: '11/5 (목)', row_json: { 공개여부: '공개', 문의문구: '지금 구매했어요' } },
    ]), sheetId: 's', tabName: 't', planRows });
    t('★ 날짜가 다르거나 줄이 없으면 붙이지 않는다(어긋난 자리표 금지)', diff.ok === false && JSON.stringify(diff.mismatches) === '[2,3]');
    const acc = S('src/services/sheetlessAccept.service.js');
    t('계획이 자리표(줄 번호 포함)를 돌려준다 — 복구가 같은 생성기를 쓴다', /\n\s*qnaSlots,\s*\/\/ Q&A 자리표/.test(acc));
    const iAbort = orr.indexOf("code: 'qna_calendar_failed'");
    t('★★ 첫 접수에서 자리표 저장이 실패하면 상태를 바꾸기 전에 멈춘다(접수하기 버튼이 남아 다시 누르면 복구 — 막다른 길 금지)',
      iAbort > 0 && iAbort < orr.indexOf('// 8) 상태 전이 reviewing + 링크 기록'));
    t('★ 재접수(이미 만든 작업표) 경로가 Q&A면 복구를 부르고, 실패는 던져 멈춘다',
      /repairCalendarIfMissing\(\{ workOrder: o, sheetId, tabName, by: [^}]*\}\);\s*if \(!qnaRepair\.ok\) throw new Error/.test(orr));
  }

  /* ── ⑩ 나머지 경로 — 차수·줄 정리·주문 행 삭제·날짜 고치기·신청 줄 덧붙이기·이름 바꾸기 ── */
  console.log('\n⑩ 나머지 경로');
  const tbr = S('src/routes/trackB.routes.js');
  t('★ 차수 추가·삭제: Q&A 공고는 409(두 경로 모두)', (tbr.match(/isQnaCampaign\(campaignId\)\) \{\s*return res\.status\(409\)\.json\(\{ ok: false, code: 'rounds_qna_locked'/g) || []).length === 2);
  t('정원 동기화의 Q&A 거절은 409 로(500 위장 금지)', /recruit_quota_qna_locked: 409/.test(tbr));
  {
    const ledger = require('../src/services/sheetlessLedger.service');
    const mk = (bound) => ({ query: async (sql) => {
      if (/SELECT \(EXISTS/.test(sql)) return { rows: [{ q: true }] };
      if (/SELECT seq FROM qna_slots/.test(sql)) return { rows: bound.map(seq => ({ seq })) };
      if (/sheetless/.test(sql)) return { rows: [{ sheetless: true }] };
      return { rows: [] };
    } });
    const before = scope.isSheetless; scope.isSheetless = async () => true;
    const pool = require('../src/db/pool');
    const origQ = pool.query;
    let err = null;
    try { pool.query = mk([4]).query; await ledger.retireRows({ sheetId: 's', tabName: 't', seqs: [4, 9], dryRun: true }); }
    catch (e) { err = e; } finally { pool.query = origQ; scope.isSheetless = before; }
    t('★★ 줄 정리(중복 정리·짝 빈 줄 포함): 자리 줄이 섞이면 미리보기부터 거절', err && err.code === 'qna_slot_rows');
  }
  t('주문 행 삭제: 자리 줄은 「줄 삭제」로 안내(409)', /code: 'qna_slot_row'/.test(S('src/services/workdeskOrderDelete.service.js')) && /out\.code === 'qna_slot_row' \? 409/.test(tbr));
  t('구매일자 달력: 자리 줄의 진행일자는 못 바꾼다', /error: 'qna_slot_date_locked'/.test(tb));
  t('번호 없는 주문 옮기기: Q&A 탭은 거절', /isQnaTab\(client, sheetId, tabName\)\) \{ await client\.query\('ROLLBACK'\); return \{ ok: false, error: 'qna_slot_required' \}; \}/.test(tb));
  t('옛 신청 줄 덧붙이기: Q&A 탭은 던진다(시트로도 넘기지 않음)', /Q&A 작업표에는 신청자 줄을 덧붙이지 않습니다/.test(S('src/services/sheetlessApplicant.service.js')));
  t('★ 작업 이름 바꾸기: 자리표도 같은 트랜잭션에서 따라간다', /UPDATE qna_slots SET tab_name = \$1, updated_at = NOW\(\) WHERE sheet_id = \$2 AND tab_name = \$3/.test(S('src/services/tabRename.service.js')));
  {
    const ren = require('../src/services/campaignOptionRename.service');
    const log = [];
    const client = { query: async (sql, params) => {
      log.push({ sql: String(sql), params });
      if (/FROM recruit_campaigns WHERE id = \$1/.test(sql)) return { rows: [{ linked_sheet_id: 's', linked_tab_name: 't' }] };
      if (/is_sheetless|sheetless/.test(sql)) return { rows: [{ sheetless: true }] };
      return { rows: [] };
    } };
    const before = scope.isSheetless; scope.isSheetless = async () => true;
    try { await ren.relabelEmptySlotsInTx(client, 'c1', [{ from: '가방 · 토프', to: '가방 · 토프색' }], [{ from: '가방', to: '토프 가방' }]); }
    finally { scope.isSheetless = before; }
    const kq = log.find(x => /UPDATE qna_slots SET unit_key = \$4/.test(x.sql));
    const pq = log.find(x => /UPDATE qna_slots SET product_name = \$4/.test(x.sql));
    t('★ 선택지 이름 바꾸기: 자리표의 선택지 키·값도 바꾼다', kq && JSON.stringify(kq.params) === JSON.stringify(['s', 't', '가방 · 토프', '가방 · 토프색', '가방', '토프색', '']));
    t('★ 상품 이름 바꾸기: 자리표의 상품 이름도 바꾼다', pq && JSON.stringify(pq.params) === JSON.stringify(['s', 't', '가방', '토프 가방']));
  }

  console.log(`\n✅ ${pass}개 통과\n`);
})().catch(e => { console.error(e); process.exit(1); });
