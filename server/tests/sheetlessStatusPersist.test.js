/**
 * sheetlessStatusPersist.test.js — 탈 구글시트 W3 회귀가드
 * 실행: node tests/sheetlessStatusPersist.test.js
 *
 * ★★ 고정하는 사고: **장부 재생성이 시스템 기록을 지운다**
 *   무시트 탭의 `review_index` 는 지우고 작업표에서 다시 만들어지므로,
 *   시스템이 그 표에 직접 쓴 값은 **주문 한 건만 더 들어와도 증발**한다.
 *   · 시트에도 칸이 있는 값(리뷰제출·입금) → **작업표 칸에 쓴다**(진실원본 일원화)
 *   · 시트에 칸이 없는 값(대표 리뷰 캡처) → **재생성 시 보존한다**
 */
'use strict';
const fs = require('fs');
const path = require('path');
const assert = require('assert');

let pass = 0, fail = 0;
function ok(name, cond) {
  if (cond) { console.log('  ✓ ' + name); pass++; }
  else { console.log('  ✗ ' + name); fail++; }
}
const ROOT = path.join(__dirname, '..');
const srv = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8').replace(/\r\n/g, '\n');
/** ⚠ 줄 주석만 지운다 — 블록 주석 정규식은 이 레포의 정규식 리터럴을 물어 코드를 통째로 먹는다(실측) */
const noLineComments = (s) => s.split('\n').filter(l => !/^\s*\/\//.test(l)).join('\n');

const status = require('../src/services/sheetlessStatus.service');
const ledger = require('../src/services/sheetlessLedger.service');

(async () => {

/* ══════════════ A. 작업표 칸 기록 (제출·입금) ══════════════ */
console.log('\n[A] 무시트 상태 표시는 작업표 칸에 쓴다');
{
  // 시트 기반 탭이면 손대지 않는다 = 종전 동작 100%
  status.__setPoolForTest({ query: async (sql) => {
    if (/FROM tab_configs/.test(sql)) return { rows: [] };          // 무시트 아님
    return { rows: [], rowCount: 0 };
  } });
  const r = await status.markStatusCell({ sheetId: 'S1', tabName: 'T', rowIndex: 5, kind: 'paid', value: '2026-08-07 14:00' });
  ok('시트 기반 탭은 handled:false (호출부가 종전 시트 경로 유지)', r.handled === false);
}
{
  const calls = { upd: null, rebuild: 0 };
  status.__setPoolForTest({ query: async (sql, params) => {
    if (/FROM tab_configs/.test(sql)) return { rows: [{ s: true }] };
    if (/submit_col2 AS h/.test(sql)) return { rows: [{ h: '입금일자' }] };
    if (/UPDATE campaign_participants/.test(sql)) { calls.upd = { sql, params }; return { rowCount: 1 }; }
    return { rows: [], rowCount: 0 };
  } });
  const realRebuild = ledger.rebuildLedgers;
  ledger.rebuildLedgers = async () => { calls.rebuild++; return { ok: true }; };
  const r = await status.markStatusCell({ sheetId: 'wt_a', tabName: 'T', rowIndex: 7, kind: 'paid', value: '2026-08-07 14:00' });
  ledger.rebuildLedgers = realRebuild;

  ok('무시트 탭은 handled:true + 성공', r.handled === true && r.ok === true);
  ok('쓰는 대상은 작업표(campaign_participants)', !!calls.upd && /campaign_participants/.test(calls.upd.sql));
  ok('★ review_index 를 직접 쓰지 않는다(재생성에 지워지는 자리)', !!calls.upd && !/review_index/.test(calls.upd.sql));
  ok('입금 칸 헤더명은 파서가 감지한 submit_col2 (판정 사본 0)',
    calls.upd.params[3] === '입금일자' && r.column === '입금일자');
  ok('값은 호출부가 준 이체 시각 그대로', calls.upd.params[4] === '2026-08-07 14:00');
  ok('기록 뒤 장부를 다시 만든다(안 하면 화면에 반영 안 됨)', calls.rebuild === 1);
  ok('row_json 은 병합(||)이라 다른 칸을 지우지 않는다', /row_json = COALESCE\(row_json[^)]*\) \|\| jsonb_build_object/.test(calls.upd.sql));
}
{
  // 리뷰 제출 표시 = submit_col + Track B write-back 과 같은 표기('O')
  let header = null, val = null;
  status.__setPoolForTest({ query: async (sql, params) => {
    if (/FROM tab_configs/.test(sql)) return { rows: [{ s: true }] };
    if (/submit_col AS h/.test(sql)) return { rows: [{ h: '리뷰제출' }] };
    if (/UPDATE campaign_participants/.test(sql)) { header = params[3]; val = params[4]; return { rowCount: 1 }; }
    return { rows: [], rowCount: 0 };
  } });
  const realRebuild = ledger.rebuildLedgers;
  ledger.rebuildLedgers = async () => ({ ok: true });
  await status.markStatusCell({ sheetId: 'wt_a', tabName: 'T', rowIndex: 3, kind: 'submit' });
  ledger.rebuildLedgers = realRebuild;
  ok('리뷰제출은 submit_col 칸에 기록', header === '리뷰제출');
  ok("표기는 write-back 과 같은 'O'", val === status.SUBMIT_MARK && val === 'O');
}
{
  // 조용한 성공 위장 금지
  status.__setPoolForTest({ query: async (sql) => {
    if (/FROM tab_configs/.test(sql)) return { rows: [{ s: true }] };
    if (/AS h/.test(sql)) return { rows: [] };                       // 상태 칸 없음
    return { rows: [], rowCount: 0 };
  } });
  const r = await status.markStatusCell({ sheetId: 'wt_a', tabName: 'T', rowIndex: 1, kind: 'paid', value: 'x' });
  ok('상태 칸이 없으면 사유를 말한다(성공으로 접지 않음)', r.handled === true && r.ok === false && r.reason === 'no_status_column');

  status.__setPoolForTest({ query: async (sql) => {
    if (/FROM tab_configs/.test(sql)) return { rows: [{ s: true }] };
    if (/AS h/.test(sql)) return { rows: [{ h: '입금' }] };
    return { rows: [], rowCount: 0 };                                // UPDATE 0행
  } });
  const r2 = await status.markStatusCell({ sheetId: 'wt_a', tabName: 'T', rowIndex: 99, kind: 'paid', value: 'x' });
  ok('작업표에 그 줄이 없으면 사유를 말한다', r2.ok === false && r2.reason === 'row_not_found');

  status.__setPoolForTest({ query: async () => { throw new Error('db down'); } });
  const r3 = await status.markStatusCell({ sheetId: 'wt_a', tabName: 'T', rowIndex: 1, kind: 'paid', value: 'x' });
  ok('★ 무시트 판정 실패는 handled:false (시트 기반 입금 기록이 조용히 사라지지 않게)', r3.handled === false);
  /* ★ 위 실행은 `isSheetless` 가 스스로 catch 해 false 를 돌려주는 경로만 탄다.
     모듈 로드 실패 등으로 **바깥 catch** 가 열릴 때도 같아야 하는데, 그 갈래는 실행으로 못 만든다
     → 코드 모양을 고정한다(변이시험 M7: 여기를 handled:true 로 바꾸면 시트 탭 입금 기록이 통째로 소실). */
  const stSrc = noLineComments(srv('src/services/sheetlessStatus.service.js'));
  const outer = stSrc.slice(stSrc.indexOf('sheetless = await require'), stSrc.indexOf('if (!sheetless)'));
  ok('★ 판정 예외 갈래도 handled:false (종전 시트 경로로 보낸다)',
    /catch \(_\) \{[\s\S]*?return \{ handled: false \};[\s\S]*?\}/.test(outer));
}
{
  // 장부 재생성이 실패해도 값은 작업표에 남았다 → 다음 재생성에 자동 반영
  status.__setPoolForTest({ query: async (sql) => {
    if (/FROM tab_configs/.test(sql)) return { rows: [{ s: true }] };
    if (/AS h/.test(sql)) return { rows: [{ h: '입금' }] };
    return { rows: [], rowCount: 1 };
  } });
  const realRebuild = ledger.rebuildLedgers;
  ledger.rebuildLedgers = async () => { throw new Error('boom'); };
  const r = await status.markStatusCell({ sheetId: 'wt_a', tabName: 'T', rowIndex: 1, kind: 'paid', value: 'x' });
  ledger.rebuildLedgers = realRebuild;
  ok('장부 재생성 실패는 ok:true + deferred (값 유실 아님)', r.ok === true && r.deferred === true);
}

/* ══════════════ B. 재생성 시 시스템 전용 값 보존 ══════════════ */
console.log('\n[B] 대표 리뷰 캡처는 재생성에도 살아남는다');
{
  const src = noLineComments(srv('src/services/sheetlessLedger.service.js'));
  const cols = ['review_file_id', 'review_file_url', 'review_file_name', 'review_file_count', 'review_file_at'];

  ok('DELETE 전에 스냅샷을 뜬다',
    src.indexOf('SELECT row_index, review_file_id') < src.indexOf('DELETE FROM review_index'));
  cols.forEach(c => ok(`스냅샷·복원에 ${c} 포함`, (src.match(new RegExp(c, 'g')) || []).length >= 2));
  ok('복원은 재INSERT 뒤에 온다',
    src.indexOf('UPDATE review_index\n            SET review_file_id') > src.indexOf('INSERT INTO review_index'));
  ok('복원 앵커는 row_index (작업표 seq = 시트 실제 행번호)',
    /WHERE sheet_id = \$1 AND tab_name = \$2 AND row_index = \$8/.test(src));
  ok('보존 결과를 반환한다(조용한 소실 감지)', /filesKept, filesSeen/.test(src));

  // ★★ 제출·입금은 보존 대상이 아니다 — 보존하면 작업표에서 지워도 장부만 남아 갈라진다
  const snap = src.slice(src.indexOf('SELECT row_index, review_file_id'), src.indexOf('DELETE FROM review_index'));
  ok('★ 스냅샷에 is_submitted 없음(작업표가 진실원본)', !/is_submitted/.test(snap));
  ok('★ 스냅샷에 is_submitted2 없음', !/is_submitted2/.test(snap));
}

/* ══════════════ C. 호출부 배선 ══════════════ */
console.log('\n[C] 두 기록 경로가 무시트 분기를 탄다');
{
  const sub = noLineComments(srv('src/routes/submit.routes.js'));
  ok('sheetless reviewer submission passes its timestamp to the worktable',
    /markStatusCell\(\{ sheetId, tabName, rowIndex, kind: 'submit', value: submitValue/.test(sub));
  ok('리뷰 제출 완료에서 상태 기록 호출', /sheetlessStatus\.service'\)\s*\n?\s*\.markStatusCell\(\{ sheetId, tabName, rowIndex, kind: 'submit'/.test(sub));
  ok('제출 성공을 막지 않는다(fail-soft)',
    /markStatusCell[\s\S]{0,600}?catch \(e\) \{[\s\S]{0,200}?logger\.warn/.test(sub));
  // 위치: is_submitted UPDATE 직후여야 한다(완료 판정 밖이면 미제출 행에도 표시가 남는다)
  const i1 = sub.indexOf("UPDATE review_index SET is_submitted = TRUE");
  const i2 = sub.indexOf("kind: 'submit'");
  ok('완료 분기 안에서 호출(미제출 행 오표시 방지)', i1 > 0 && i2 > i1 && (i2 - i1) < 1400);

  /* ⚠ 입금 기록은 입금 M2(이체결과 반영)에서 `paymentApply.service` 로 **단일 출처 이관**됐다
     (수동 처리·자동 반영이 같은 순서를 타게). 검사 의미는 그대로 — 읽는 파일만 따라간다. */
  const pay = noLineComments(srv('src/services/paymentApply.service.js'));
  ok('입금 완료에서 상태 기록 호출', /markStatusCell\(\{[\s\S]{0,200}?kind: 'paid', value: stamp/.test(pay));
  ok('★ 무시트면 시트 쓰기·deposit_mark 큐로 내려가지 않는다', /if \(st\.handled\) \{[\s\S]{0,400}?continue;/.test(pay));
  ok('입금 처리에는 시트 기반 경로가 없다', !/writeSheet\(/.test(pay));
  ok('입금 처리에는 deposit_mark 큐가 없다', !/enqueue\('deposit_mark'/.test(pay));
}

/* ══════════════ F. Existing O → submission-time backfill ══════════════ */
console.log('\n[F] recent uploaded reviews with O are backfilled safely');
{
  const stSrc = noLineComments(srv('src/services/sheetlessStatus.service.js'));
  const tbRoutes = noLineComments(srv('src/routes/trackB.routes.js'));

  ok('backfill limits candidates to sheetless tabs', /COALESCE\(tc\.sheetless, FALSE\) = TRUE/.test(stSrc));
  ok('backfill limits candidates to cells currently equal to O', /COALESCE\(cp\.row_json ->> ri\.submit_col, ''\) = 'O'/.test(stSrc));
  ok('backfill uses the latest recorded review-upload timestamp', /MAX\(COALESCE\(rs\.uploaded_at, rs\.created_at\)\)/.test(stSrc));
  ok('backfill formats the timestamp in Korea time', /AT TIME ZONE 'Asia\/Seoul'/.test(stSrc) && /FMMM\/FMDD HH24:MI/.test(stSrc));
  ok('backfill rechecks O immediately before update', /AND COALESCE\(cp\.row_json ->> c\.submit_col, ''\) = 'O'/.test(stSrc));
  ok('backfill rebuilds ledgers only for changed tabs', /rebuildLedgers\(\{ sheetId: tab\.sheetId, tabName: tab\.tabName/.test(stSrc));
  ok('backfill endpoint is master-only and dry-run by default',
    /review-submit-time-backfill', authMiddleware, masterOnlyMiddleware/.test(tbRoutes)
    && /const dryRun = req\.body\?\.dryRun !== false/.test(tbRoutes));
  ok('backfill requires an explicit confirmation to apply', /confirm !== 'replace-o-with-submission-time'/.test(tbRoutes));
}
{
  const calls = [];
  const candidate = {
    sheetId: 'sheetless-1', tabName: 'campaign', rowIndex: 12, reviewerName: 'reviewer',
    submitCol: '리뷰제출', sourceAt: '2026-08-10T09:13:00.000Z', submitValue: '8/10 18:13',
  };
  status.__setPoolForTest({ query: async (sql, params) => {
    calls.push({ sql, params });
    if (/MAX\(COALESCE\(rs\.uploaded_at, rs\.created_at\)\)/.test(sql)) return { rows: [candidate] };
    if (/jsonb_to_recordset/.test(sql)) return { rows: [{ sheetId: 'sheetless-1', tabName: 'campaign', rowIndex: 12 }] };
    return { rows: [] };
  } });
  const preview = await status.backfillReviewSubmitTimes({ dryRun: true });
  ok('backfill preview reports candidates without writing', preview.dryRun === true && preview.candidateCount === 1 && calls.length === 1);

  const realRebuild = ledger.rebuildLedgers;
  const rebuilt = [];
  ledger.rebuildLedgers = async (arg) => { rebuilt.push(arg); return { ok: true }; };
  const applied = await status.backfillReviewSubmitTimes({ dryRun: false, by: 'master' });
  ledger.rebuildLedgers = realRebuild;
  status.__setPoolForTest(null);
  const update = calls.find(x => /jsonb_to_recordset/.test(x.sql));
  const plan = update ? JSON.parse(update.params[0]) : [];
  ok('backfill apply writes only the previewed row and timestamp',
    applied.updated === 1 && plan.length === 1 && plan[0].submit_value === '8/10 18:13' && plan[0].submit_col === '리뷰제출');
  ok('backfill rebuilds the one changed tab after writing', rebuilt.length === 1 && rebuilt[0].sheetId === 'sheetless-1' && rebuilt[0].tabName === 'campaign');
}

/* ══════════════ D. Track B write-back 무시트 분기 ══════════════ */
console.log('\n[D] cutover 된 무시트 탭은 시트를 읽지 않는다');
{
  const tb = noLineComments(srv('src/services/trackB.service.js'));
  ok('executeWriteback 이 무시트를 분기', /if \(sheetless\) return _writebackSheetless\(/.test(tb));
  ok('판정 실패는 종전 엔진(fail-open)', /catch \(_\) \{ sheetless = false; \}/.test(tb));
  const fn = tb.slice(tb.indexOf('async function _writebackSheetless'), tb.indexOf('async function writebackSweep'));
  ok('★ 무시트 분기는 readSheet 를 부르지 않는다', !/readSheet\(/.test(fn));
  ok('★ 무시트 분기는 시트 쓰기를 하지 않는다', !/batchUpdateSheet\(|writeSheet\(/.test(fn));
  ok('기록은 markStatusCell 단일 경로', /markStatusCell\(\{/.test(fn));
  ok('해제(false)는 held — 두 경로 의미가 갈리지 않게', /value_bool !== true[\s\S]{0,80}?'held'/.test(fn));
  ok('행 앵커 없으면 blocked(자가치유 재시도)', /!e\.row_index[\s\S]{0,80}?'blocked'/.test(fn));
  ok('앵커 3종을 모두 해석(order·manual·identity)',
    /anchor_type = 'order'/.test(fn) && /anchor_type = 'manual'/.test(fn) && /anchor_type = 'identity'/.test(fn));
  ok('★ 모호한 identity 는 쓰지 않는다(엉뚱한 줄 기록 차단)', /cur\.row_index = null/.test(fn));
}

/* ══════════════ E. 무회귀 — 시트 기반 경로 ══════════════ */
console.log('\n[E] 시트 기반 탭은 한 줄도 안 바뀐다');
{
  const tb = noLineComments(srv('src/services/trackB.service.js'));
  ok('시트 엔진 진입은 그대로', /return _writebackEngine\(\{ sheetId, tabName, tier: 'base' \}\);/.test(tb));
  const sub = noLineComments(srv('src/routes/submit.routes.js'));
  ok('기존 review_index UPDATE 는 유지(시트 탭이 쓰는 경로)',
    /UPDATE review_index SET is_submitted = TRUE, built_at = NOW\(\)/.test(sub));
  ok('index_master 카운트 증가도 유지', /submitted_count = submitted_count \+ 1/.test(sub));
}

console.log(`\n총 ${pass}개 통과${fail ? ` · ${fail}개 실패` : ''}`);
if (fail) process.exit(1);
process.exit(0);
})();
