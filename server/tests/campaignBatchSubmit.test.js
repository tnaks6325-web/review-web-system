/**
 * campaignBatchSubmit.test.js — 타계정별 독립 제출 회귀가드
 * 실행: node tests/campaignBatchSubmit.test.js
 *
 * 배경: 다계정 참여 후 한 명의 구매양식을 열면 모든 명의의 카드가 함께 열려,
 * 이미 제출한 건을 포함해 한 번에 제출해야 하는 것처럼 보였다.
 *
 * 이 가드가 고정하는 것(레드팀→블루팀→심판 프로세스에서 확정된 방어):
 *  A. 서버 멱등 게이트 — 같은 홀드로 두 번 제출해도 원장·시트행이 중복되지 않는다.
 *     ★ `late_order_id`(지각 접수)까지 포함해야 한다: confirmHoldInTx 의 late UPDATE 는
 *       `late_order_id IS NULL` 조건이라, 2회차 재제출은 링크조차 못 남기고 주문만 새로 생긴다.
 *  B. fail-open 유지 — 조회 실패는 주문 접수를 막지 않는다(라이브 핫패스 보호).
 *  C. 레거시·비참여형·관리자 경유 제출은 게이트에 도달하지 않는다.
 *  D. 프론트 — 선택한 application 하나만 iframe에 전달하고, 과거 batch URL/세션도 단건으로 강등한다.
 *  E. 다른 명의 홀드는 남겨두고, 제출 완료 뒤 계정 전환으로 이어서 제출한다.
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const read = (p) => fs.readFileSync(path.join(__dirname, '..', p), 'utf8');

const submitSrc = read('src/routes/submit.routes.js');
const searchApp = read('../frontend/js/search-app.js');
const campaign  = read('../frontend/campaign.html');
const manualOrd = read('../frontend/js/manual-order.js');

let passed = 0;
function ok(name, cond, extra) {
  assert(cond, name + (extra !== undefined ? ' → ' + JSON.stringify(extra) : ''));
  passed++; console.log('  ✓ ' + name);
}

// ══════════════════════════════════════════════════════════════════════
// A. 서버 멱등 게이트 — 스텁 pool 로 실제 라우트를 호출한다.
//    ★ SQL 문자열 grep 만으로는 "게이트가 실제로 반환하는지"를 못 본다.
// ══════════════════════════════════════════════════════════════════════
const pool = require('../src/db/pool');
const submitRouter = require('../src/routes/submit.routes');

function handlerFor(method, routePath) {
  const layer = submitRouter.stack.find(l => l.route && l.route.path === routePath && l.route.methods[method]);
  assert(layer, `라우트 없음: ${method.toUpperCase()} ${routePath}`);
  const st = layer.route.stack;
  return st[st.length - 1].handle;
}
async function callOrder(body) {
  const handler = handlerFor('post', '/order');
  return await new Promise((resolve) => {
    const res = {
      statusCode: 200,
      status(c) { this.statusCode = c; return this; },
      json(b) { resolve({ statusCode: this.statusCode, body: b }); return this; },
    };
    Promise.resolve(handler({ body }, res, (err) => resolve({ next: true, err })))
      .catch((err) => resolve({ threw: true, err }));
  });
}

const HOLD_BODY = {
  sheetId: 'SHEET1', tabName: '탭A', recipient: '김미희', phone: '010-3333-4444',
  address: '서울 어딘가', price: '31400', orderer: '최영순', userId: 'uid',
  bank: '국민', account: '1', depositor: '최영순',
  campaignId: 'C1', campaignApplicationId: '102', holdToken: 'tok-bbb', holdPhone8: '33334444',
};

(async () => {
  console.log('\n[A] 서버 멱등 게이트 (스텁 pool + 실제 라우트 실행)');

  // 원장 생성이 불려서는 안 된다 — 불리면 즉시 실패하도록 스파이를 건다.
  const ledger = require('../src/services/orderLedger.service');
  const realCreate = ledger.createOrderLedgerEntry;
  let ledgerCalls = 0;
  ledger.createOrderLedgerEntry = async (...a) => { ledgerCalls++; return realCreate.apply(null, a); };

  const realQuery = pool.query;

  // ⓐ 확정 완료된 홀드(status='submitted' + 주문 생존) → 멱등 통과
  ledgerCalls = 0;
  pool.query = async (sql) => {
    if (/FROM campaign_applications ca/.test(sql)) {
      return { rows: [{ phone8: '33334444', option_key: null, status: 'submitted',
                        order_submission_id: 'os-1', late_order_id: null, sub_alive: true, late_alive: false }] };
    }
    return { rows: [] };
  };
  let r = await callOrder(HOLD_BODY);
  ok('ⓐ 확정된 홀드 재제출 → ok:true + alreadySubmitted', r.body && r.body.ok === true && r.body.alreadySubmitted === true, r.body);
  ok('ⓐ campaignHold=confirmed (부모 화면이 거짓말하지 않게)', r.body.campaignHold === 'confirmed', r.body.campaignHold);
  ok('ⓐ 기존 주문 id 를 그대로 돌려줌', r.body.orderSubmissionId === 'os-1', r.body.orderSubmissionId);
  ok('★ⓐ 원장 신규 생성이 일어나지 않음(중복 원장·중복 시트행 차단)', ledgerCalls === 0, ledgerCalls);

  // ⓑ 지각 접수(late_order_id 생존) → 멱등 통과 + late 표기  ★블루팀이 놓쳤던 경로
  ledgerCalls = 0;
  pool.query = async (sql) => {
    if (/FROM campaign_applications ca/.test(sql)) {
      return { rows: [{ phone8: '33334444', option_key: null, status: 'expired',
                        order_submission_id: null, late_order_id: 'os-late', sub_alive: false, late_alive: true }] };
    }
    return { rows: [] };
  };
  r = await callOrder(HOLD_BODY);
  ok('★ⓑ 지각(late) 접수 홀드 재제출도 멱등 통과', r.body && r.body.ok === true && r.body.alreadySubmitted === true, r.body);
  ok('ⓑ campaignHold=late (운영자 확인 중으로 안내)', r.body.campaignHold === 'late', r.body.campaignHold);
  ok('★ⓑ 원장 신규 생성 없음(고아 주문 차단)', ledgerCalls === 0, ledgerCalls);

  // ⓒ 주문이 soft-delete 되었으면 게이트를 통과시키지 않는다(정상 재제출 허용)
  pool.query = async (sql) => {
    if (/FROM campaign_applications ca/.test(sql)) {
      return { rows: [{ phone8: '33334444', option_key: null, status: 'submitted',
                        order_submission_id: 'os-x', late_order_id: null, sub_alive: false, late_alive: false }] };
    }
    throw new Error('stop-after-gate');   // 게이트를 지났음을 증명하고 즉시 중단
  };
  r = await callOrder(HOLD_BODY);
  ok('ⓒ 주문이 soft-delete 면 멱등 게이트를 타지 않음', !(r.body && r.body.alreadySubmitted), r.body);

  // ⓓ 아직 applied 인 홀드(정상 최초 제출) → 게이트 미적용
  pool.query = async (sql) => {
    if (/FROM campaign_applications ca/.test(sql)) {
      return { rows: [{ phone8: '33334444', option_key: null, status: 'applied',
                        order_submission_id: null, late_order_id: null, sub_alive: false, late_alive: false }] };
    }
    throw new Error('stop-after-gate');
  };
  r = await callOrder(HOLD_BODY);
  ok('ⓓ applied 홀드(최초 제출)는 게이트 미적용', !(r.body && r.body.alreadySubmitted), r.body);

  // ⓔ 조회 자체가 실패해도 접수를 막지 않는다(fail-open)
  pool.query = async () => { throw new Error('db down'); };
  r = await callOrder(HOLD_BODY);
  ok('★ⓔ 홀드 조회 실패는 fail-open (주문 접수를 막지 않음)', !(r.body && r.body.alreadySubmitted), r.body);

  // ⓕ 레거시(홀드 문맥 없음) → 게이트에 도달조차 하지 않는다
  pool.query = async (sql) => {
    if (/FROM campaign_applications ca/.test(sql)) throw new Error('레거시 제출이 홀드 조회를 하면 안 됨');
    throw new Error('stop-after-gate');
  };
  r = await callOrder({ sheetId: 'S', tabName: 'T', recipient: 'x' });
  ok('ⓕ 레거시·비참여형 제출은 홀드 조회/게이트에 도달하지 않음', !(r.body && r.body.alreadySubmitted), r.body);

  pool.query = realQuery;
  ledger.createOrderLedgerEntry = realCreate;

  // ── 정적: 게이트가 신원게이트보다 앞에 있어야 한다(불필요한 대조·Gemini 호출 방지) ──
  const gateIdx = submitSrc.indexOf('홀드 멱등 게이트');
  const idIdx = submitSrc.indexOf('신원 게이트: 내정보');
  ok('게이트가 holdCtx 계산 직후에 위치', gateIdx > 0 && gateIdx > submitSrc.indexOf('const holdCtx = await _authoritativeHold'));
  ok('게이트가 신원게이트보다 뒤(=신원게이트는 그대로 유지)', idIdx > 0 && gateIdx > idIdx);
  ok('멱등 판정에 late_order_id 가 포함됨', /late_alive/.test(submitSrc) && /doneKind = 'late'/.test(submitSrc));
  ok('soft-delete 된 주문은 생존으로 치지 않음', /so\.deleted_at IS NULL/.test(submitSrc) && /lo\.deleted_at IS NULL/.test(submitSrc));

  // ══════════════════════════════════════════════════════════════════
  // D. 프론트 — 다계정도 application별 단건 제출
  // ══════════════════════════════════════════════════════════════════
  console.log('\n[D] 프론트 독립 제출 배선');

  ok('과거 batch URL/세션도 항상 단건으로 강등', /function _batchBoot\(\)\s*\{\s*return null;\s*\}/.test(searchApp));
  ok('iframe에는 현재 선택 application의 컨텍스트만 전달',
    /qp\.set\('app', String\(j\.application\.id\)\); qp\.set\('holdToken', h\.holdToken\); qp\.set\('holdPhone8', h\.phone8\);/.test(campaign));
  ok('부모가 batch 파라미터/스냅샷을 만들지 않음',
    !/function _batchSnapshot\(/.test(campaign) && !/qp\.set\('batch'/.test(campaign));
  ok('남은 구 batch 세션은 iframe 진입 전 제거', /sessionStorage\.removeItem\(BATCH_KEY\)/.test(campaign));
  ok('독립 제출 폼은 카드 하나만 생성', /if \(_BATCH\) \{[\s\S]{0,900}\} else \{\s*addOrderCard\(\);/.test(searchApp));
  ok('현재 명의의 단건 application/hold를 제출 페이로드에 사용',
    /campaignId: _EMBED_CTX\.campId,[\s\S]{0,160}campaignApplicationId: _EMBED_CTX\.app,[\s\S]{0,160}holdToken: _EMBED_CTX\.holdToken,[\s\S]{0,160}holdPhone8: _EMBED_CTX\.holdPhone8/.test(searchApp));

  // E. 한 명의 제출 완료가 다른 명의의 홀드를 지우지 않아야 한다.
  console.log('\n[E] 계정별 이어서 제출');
  ok('제출 완료 시 현재 활성 명의의 홀드만 정리', /const done = getHold\(\);[\s\S]{0,100}clearHold\(done\.phone8\)/.test(campaign));
  ok('남은 명의는 계정 전환 후 별도 구매양식으로 이동', /setActiveP8\(rest\[0\]\); await enterJoined\(\);/.test(campaign));
  ok('계정 전환은 활성 명의만 바꾼 뒤 iframe을 다시 연다', /function switchAcct\(p8\)[\s\S]{0,220}setActiveP8\(p8\);[\s\S]{0,120}await enterJoined\(\);/.test(campaign));
  ok('제출 결과는 단건 완료 화면으로 처리', /else renderDone\(d\.campaignHold && d\.campaignHold !== 'confirmed'\);/.test(campaign));

  console.log(`\n✅ campaignBatchSubmit: ${passed}개 통과`);
  process.exit(0);   // pool 이 이벤트루프를 붙잡고 있어 명시 종료(다른 런타임 가드와 동일)
})().catch(e => { console.error('\n❌ 실패:', e.message); process.exit(1); });
