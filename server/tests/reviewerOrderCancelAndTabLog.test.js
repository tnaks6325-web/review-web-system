/**
 * reviewerOrderCancelAndTabLog.test.js — 리뷰어 주문취소 + 작업 로그 (2026-08-23 사용자 확정)
 *
 * 고정하는 것
 *   ① 파괴 실행부 사본 0 — 작업보드 [행 삭제]와 **같은 함수**를 부른다
 *   ② fail-closed 4종(제출완료·입금·시트기반·판정실패) — 쓰기 0건으로 거부
 *   ③ 주문 번호는 **서버가 좌표로 다시 찾는다**(요청 본문 불신)
 *   ④ 로그는 **읽기 전용**(쓰기 문장 0) · 소스 실패를 0건으로 꾸미지 않는다
 *   ⑤ 화면 게이트 = 서버 판정(사본 0) · 리뷰 제출 완료면 **버튼 자체 미노출**
 *
 * 실행: node tests/reviewerOrderCancelAndTabLog.test.js
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

let pass = 0, fail = 0;
function ok(name, cond) { if (cond) { console.log('  ✓ ' + name); pass++; } else { console.log('  ✗ ' + name); fail++; } }
function t(name, fn) { try { fn(); console.log('  ✓ ' + name); pass++; } catch (e) { console.log('  ✗ ' + name + '\n      ' + e.message); fail++; } }

const R = (p) => fs.readFileSync(path.join(__dirname, '..', p), 'utf8');
const SVC = R('src/services/reviewerOrderCancel.service.js');
const LOGSVC = R('src/services/tabActivityLog.service.js');
const ROUTE = R('src/routes/reviewEdit.routes.js');
const TBROUTE = R('src/routes/trackB.routes.js');
const IDX = fs.readFileSync(path.join(__dirname, '..', '..', 'frontend', 'index.html'), 'utf8');
const WD = fs.readFileSync(path.join(__dirname, '..', '..', 'frontend', 'workdesk.html'), 'utf8');

/* 주석을 지우고 본다 — "제거했다"고 적어 둔 설명문이 검사를 통과시키면 안 된다. */
const noComment = (s) => s.replace(/^\s*(\/\/|\*|\/\*).*$/gm, '');

console.log('\n[1] 파괴 실행부 사본 0');
ok('★★ 작업보드 [행 삭제]와 같은 함수를 부른다', /trackB\.hideWorkdeskRow\(/.test(SVC));
ok('★ 자체 DELETE/UPDATE 로 줄을 지우지 않는다',
  !/DELETE\s+FROM\s+campaign_participants|UPDATE\s+campaign_participants/i.test(SVC));
ok('★ 주문 취소도 직접 하지 않는다(공유 실행부가 한다)',
  !/UPDATE\s+order_submissions/i.test(SVC) && !/cancelOrderSubmission\(/.test(SVC));
ok('★ actorRole 을 넘기지 않는다(본인 것 — 관리자 역할 게이트 대상 아님)',
  !/actorRole/.test(noComment(SVC)));

console.log('\n[2] fail-closed');
const KEYS = ['no_row', 'no_order', 'review_submitted', 'paid', 'sheet_based', 'unknown'];
t('★ 사유 6종이 모두 정의돼 있다', () => {
  const roc = require('../src/services/reviewerOrderCancel.service');
  KEYS.forEach(k => assert.ok(roc.CANCEL_BLOCK_REASONS[k], k + ' 문구 없음'));
});
ok('★★ 리뷰 제출은 두 곳을 본다(작업표 · 검색 명단)',
  /cp_submitted === true \|\| riSubmitted/.test(SVC));
ok('★★ 입금은 작업표 플래그와 회차 항목을 함께 본다',
  /cp_paid === true \|\| row\.pay_paid === true/.test(SVC) && /payment_batch_items[\s\S]{0,160}status='paid'/.test(SVC));
ok("★★ 시트 기반이면 거부(`not_sheetless` 가 최종 방어지만 여기서 먼저 막는다)",
  /if \(!sheetless\) return deny\('sheet_based'\)/.test(SVC));
ok('★★ 판정 조회 실패는 거부 — 모르는 채로 지우지 않는다',
  /catch[\s\S]{0,220}return deny\('unknown'\)/.test(SVC));
/* ★ `deleted_at`·`updated_at` 이 있어 낱말 검사는 못 쓴다 — **문장 형태**로 본다. */
ok('★ 거부는 읽기 전용 — assess 에 쓰기 문장이 없다',
  !/\b(INSERT\s+INTO|UPDATE\s+\w+\s+SET|DELETE\s+FROM)\b/i.test(
    SVC.slice(SVC.indexOf('async function assessReviewerCancel'), SVC.indexOf('async function cancelOrderByReviewer'))));

t('★★ 게이트 판정을 실제로 실행한다 — 6갈래', async () => {
  const roc = require('../src/services/reviewerOrderCancel.service');
  const row = (over) => ({ rows: [Object.assign({
    id: 'row-1', oid: 'ord-1', cp_submitted: false, cp_paid: false,
    sheetless: true, ri_submitted: false, pay_paid: false }, over)] });
  const db = (res) => ({ query: async () => (typeof res === 'function' ? res() : res) });
  const args = { sheetId: 's', tabName: 't', rowIndex: 3 };
  const run = async (res) => roc.assessReviewerCancel(db(res), args);
  const cases = [
    [row({}), true, null],
    [row({ oid: null }), false, 'no_order'],
    [row({ cp_submitted: true }), false, 'review_submitted'],
    [row({ ri_submitted: true }), false, 'review_submitted'],
    [row({ pay_paid: true }), false, 'paid'],
    [row({ sheetless: false }), false, 'sheet_based'],
    [{ rows: [] }, false, 'no_row'],
  ];
  return (async () => {
    for (const [res, want, reason] of cases) {
      const g = await run(res);
      assert.strictEqual(g.cancelable, want, JSON.stringify(res).slice(0, 60));
      if (reason) assert.strictEqual(g.reason, reason);
    }
    const boom = await run(() => { throw new Error('42P01'); });
    assert.strictEqual(boom.reason, 'unknown', '조회 실패는 unknown');
  })();
});

console.log('\n[3] 라우트 — 인증 표면 0 · 좌표 불신');
ok('★★ 이 파일의 강한-키 소유권을 그대로 쓴다',
  /router\.post\('\/order-cancel'[\s\S]{0,900}_verifyRowOwnership\(phoneList, sheetId, tabName, rowIndex\)/.test(ROUTE));
ok('★★ 주문 번호를 요청 본문에서 받지 않는다',
  !/b\.orderSubmissionId|body\.orderSubmissionId/.test(ROUTE));
ok('★ 사유는 필수(선택지 밖 값 거부)',
  /cancelReasonLabel\(b\.reasonKey\)[\s\S]{0,200}reason_required/.test(ROUTE));
ok('★ 연타 방지가 걸려 있다', /router\.post\('\/order-cancel', imageApiLimiter/.test(ROUTE));

console.log('\n[4] 작업 로그 — 읽기 전용 · 조용한 0건 금지');
ok('★★ 쓰기 문장이 한 줄도 없다',
  !/\b(INSERT\s+INTO|UPDATE\s+\w+\s+SET|DELETE\s+FROM)\b/i.test(LOGSVC));
ok('★ 소스 실패를 빈 배열로 접지 않고 failed 로 말한다',
  /failed\.push\(s\.key\)/.test(LOGSVC) && /failed,/.test(LOGSVC));
ok('★ 모든 소스 쿼리에 LIMIT 이 있다',
  (LOGSVC.match(/db\.query\(/g) || []).length === (LOGSVC.match(/LIMIT \$/g) || []).length);
ok('★ 빈 gid 는 절을 켜지 않는다', /\$3 <> ''[\s\S]{0,40}linked_tab_gid=\$3/.test(LOGSVC));
t('★★ 유형 목록이 화면 탭의 단일 출처', () => {
  const m = require('../src/services/tabActivityLog.service');
  assert.deepStrictEqual(m.LOG_KIND_KEYS, ['order', 'cancel', 'review', 'edit', 'quota', 'money', 'sys']);
  m.LOG_KINDS.forEach(k => assert.ok(k.label, k.key + ' 라벨 없음'));
});
t('★★ 병합·정렬·자르기를 실제로 실행한다', async () => {
  const m = require('../src/services/tabActivityLog.service');
  const db = { query: async (sql) => {
    if (/order_submissions/.test(sql)) return { rows: [{ id: 1, sheet_row: 3, name: '홍길동', price: '13,900',
      submitted_at: new Date('2026-08-20T01:00:00Z'), deleted_at: new Date('2026-08-22T01:00:00Z'), canceled_by: 'reviewer:1234' }] };
    if (/reviewer_event_logs/.test(sql)) throw new Error('boom');   // 한 소스 실패
    return { rows: [] };
  } };
  return m.tabActivityLog({ sheetId: 's', tabName: 't', pool: db }).then(r => {
    assert.strictEqual(r.ok, true);
    assert.ok(r.failed.includes('reviewer_events'), '실패한 소스를 말해야 한다');
    assert.strictEqual(r.items.length, 2, '접수 + 취소 두 줄');
    assert.strictEqual(r.items[0].kind, 'cancel', '최신이 먼저');
    assert.ok(/리뷰어 본인/.test(r.items[0].who), '누가 취소했는지 말한다');
  });
});

console.log('\n[5] 라우터 스택 실검사');
t('★★ /workdesk/activity-log 가 라우터 스택에 실제로 있다', () => {
  const r = require('../src/routes/trackB.routes');
  const hit = r.stack.filter(l => l.route && l.route.path === '/workdesk/activity-log');
  assert.strictEqual(hit.length, 1, '라우트 1개');
  assert.ok(hit[0].route.methods.get, 'GET');
});
ok('★ 게이트는 편집 이력과 같은 _ensureEditScope',
  /router\.get\('\/workdesk\/activity-log'[\s\S]{0,700}_ensureEditScope\(req, sheetId, tabName\)/.test(TBROUTE));
ok('★★ gid 는 서버가 tab_configs 에서 다시 구한다',
  /activity-log'[\s\S]{0,900}SELECT tab_gid FROM tab_configs/.test(TBROUTE));

console.log('\n[6] 리뷰어 화면 — 판정 사본 0');
ok('★★ 게이트는 서버가 준 brief.cancelable 만 쓴다',
  /_partInfoCancelable = \(brief && brief\.cancelable\) \|\| null/.test(IDX));
ok('★★ 리뷰 제출 완료면 버튼 자체를 그리지 않는다',
  /function _partInfoCancelBtnHtml\(done\)\{\s*\n\s*if \(done \|\| !_partInfoCoord\) return '';/.test(IDX));
ok('★ 게이트가 없으면(구버전 백엔드·조회 실패) 그리지 않는다',
  /const g = _partInfoCancelable;\s*\n\s*if \(!g\) return '';/.test(IDX));
ok('★ 못 누를 때는 숨기지 않고 흐리게 + 사유',
  /cursor:not-allowed">🚫 주문취소<\/button>'[\s\S]{0,220}escHtml\(g\.message/.test(IDX));
ok('★★ 2단 확인 — 사유 AND 체크', /const ok = !!_pcReason && !!\(chk && chk\.checked\)/.test(IDX));
ok('★ 화면에 사유 문구 사본이 없다(서버 목록을 그린다)',
  !/품절이라 구매하지 못했어요/.test(IDX) && /g\.reasons \|\| \[\]/.test(IDX));
ok('★ 실패해도 입력한 사유를 지우지 않는다', /_pcBusy = false;[\s\S]{0,140}showToast/.test(IDX));
ok('★ Esc 리스너는 최상위 1회만', /window\._pcKeyBound/.test(IDX));
ok('★★ 바깥 클릭으로 닫지 않는다(입력 보호)',
  !/pcOvl[\s\S]{0,400}addEventListener\('click'/.test(IDX));
ok('★ 여러 건 묶인 팝업에는 취소를 그리지 않는다', /list\.length === 1 && it && it\.sheetId/.test(IDX));

console.log('\n[7] 작업보드 화면');
ok('★ [🗒 로그] 버튼이 주 줄에 있다', /onclick="openTabLog\(\)"/.test(WD));
ok('★ 광고주에게는 그리지 않는다', /const logBtn=STATE\.role==='advertiser'\?''/.test(WD));
ok('★★ 옛 [편집 이력] 버튼·모달은 흡수됐다(창구 둘 금지)',
  !/showEditHistory/.test(noComment(WD)));
ok('★ 유형 탭은 서버가 준 kinds 를 그린다(라벨 사본 0)',
  /\(_tlData&&_tlData\.kinds\)\|\|\[\]/.test(WD) && !/'정산'\]/.test(WD.slice(WD.indexOf('function _tlPaintTabs'), WD.indexOf('function _tlPaintBody'))));
ok('★★ 못 받은 소스를 말한다(0건으로 꾸미지 않는다)', /_tlData\.failed\|\|\[\]\)\.length/.test(WD));
ok('★★ 자리표시자를 깐 함수는 예외에도 화면을 종결시킨다',
  /onclick="_tlLoad\(\)">다시 시도<\/button>/.test(WD));
ok('★ flex 스크롤 함정 방어(min-height:0)', /\.tlbd\{flex:1;min-height:0;overflow:auto/.test(WD));
ok('★ 클래스는 tl 접두(맨몸 이름 금지)', !/^\s*\.tabs\{/m.test(WD.slice(WD.indexOf('.tlbox{'), WD.indexOf('.tlwho{'))));

setTimeout(() => {
  console.log(`\n결과: ${pass} 통과 / ${fail} 실패`);
  process.exit(fail ? 1 : 0);
}, 400);
