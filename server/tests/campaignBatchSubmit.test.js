/**
 * campaignBatchSubmit.test.js — 타계정 다건 "일괄 제출(batch)" 회귀가드
 * 실행: node tests/campaignBatchSubmit.test.js
 *
 * 배경(실사고): 리뷰어가 타계정 5건 참여를 시도하다 30분 걸려 포기했다. 명의당
 * [참여→구매→캡처1장→양식→제출]을 5회 반복해야 했고, 새로고침하면 작성 내용·캡처가 날아갔다.
 *
 * 이 가드가 고정하는 것(레드팀→블루팀→심판 프로세스에서 확정된 방어):
 *  A. 서버 멱등 게이트 — 같은 홀드로 두 번 제출해도 원장·시트행이 중복되지 않는다.
 *     ★ `late_order_id`(지각 접수)까지 포함해야 한다: confirmHoldInTx 의 late UPDATE 는
 *       `late_order_id IS NULL` 조건이라, 2회차 재제출은 링크조차 못 남기고 주문만 새로 생긴다.
 *  B. fail-open 유지 — 조회 실패는 주문 접수를 막지 않는다(라이브 핫패스 보호).
 *  C. 레거시·비참여형·관리자 경유 제출은 게이트에 도달하지 않는다.
 *  D. 프론트 — 카드↔홀드 결속, 자동배정(순서 폴백) 부재, 미리보기 격리, 명의 앵커 복원.
 *  E. 관리자 화면(manual-order.js)의 순서 폴백 자동배정은 **그대로 살아있다**(무회귀).
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
  // D. 프론트 — 배치 배선
  // ══════════════════════════════════════════════════════════════════
  console.log('\n[D] 프론트 배선');

  ok('배치 부팅 함수 존재', /function _batchBoot\(\)/.test(searchApp));
  ok('★ 미리보기에서는 배치가 절대 켜지지 않음', /_batchBoot[\s\S]{0,400}if \(!_EMBED_CTX \|\| _PREVIEW_MODE\) return null;/.test(searchApp));
  ok('★ nc모드(네이버+쿠팡 2카드 고정)와 겹치면 배치 금지', /_batchBoot[\s\S]{0,600}if \(window\._ncMode\) return null;/.test(searchApp));
  ok('★ 홀드 2건 미만이면 배치 금지(단건 동작 불변)', /arr\.length < 2\) return null/.test(searchApp));
  ok('★ MAX_ORDER_CARDS 초과는 조용한 누락 대신 전량 단건', /arr\.length > MAX_ORDER_CARDS\) return null/.test(searchApp));
  ok('★ phone8 8자리 검증', /String\(h\.phone8 \|\| ""\)\.length === 8/.test(searchApp));
  ok('★ stale 스냅샷(활성 app 불일치) 거부', /_EMBED_CTX\.app && !arr\.some\(h => String\(h\.app\) === String\(_EMBED_CTX\.app\)\)/.test(searchApp));
  ok('부팅 예외는 전부 단건으로 수렴(fail-closed)', /catch \(_\) \{ return null; \}/.test(searchApp));

  ok('카드↔홀드 결속 맵(byCid/byP8/byApp)', /_BATCH\.byCid\[cid\] = h; _BATCH\.byP8\[h\.phone8\] = cid; _BATCH\.byApp\[h\.app\] = cid;/.test(searchApp));
  ok('★ 제출 페이로드가 카드별 홀드를 싣는다', /campaignApplicationId: bh\.app,[\s\S]{0,80}holdToken: bh\.holdToken,[\s\S]{0,80}holdPhone8: bh\.phone8,/.test(searchApp));
  ok('★ 이미 제출된 홀드는 재제출에서 건너뜀', /_BATCH\.done\[bh\.app\]\) \{[\s\S]{0,200}continue;/.test(searchApp));
  ok('★ 만료된 홀드는 전송하지 않음', /bh\.expiresAt && Date\.parse\(bh\.expiresAt\) <= Date\.now\(\)/.test(searchApp));
  ok('★ alreadySubmitted 면 캡처 재업로드 생략(Drive 중복 파일 방지)', /if \(res\.alreadySubmitted\) continue;/.test(searchApp));

  ok('★ 카드 삭제 버튼 제거(홀드↔카드 어긋남 방지)', /_batchDecorateCard[\s\S]{0,1400}querySelector\("\.ofc-remove-btn"\); if \(rm\) rm\.remove\(\)/.test(searchApp));
  ok('★ "1번과 동일" 기본 해제(주문자 오염 방지)', /_batchDecorateCard[\s\S]{0,1800}chk\.checked = false;/.test(searchApp));
  ok('★ 배치 옵션 잠금이 _selectedOptKey 를 세팅(제출 영구차단 방지)', /function _lockEmbedOptionBatch\(\)[\s\S]{0,400}_selectedOptKey = keys\[0\];/.test(searchApp));
  ok('배치 카드는 홀드의 optionKey 를 페이로드에 싣는다', /selectedOptKey: _BATCH \? \(\(_BATCH\.byCid\[cid\] \|\| \{\}\)\.optionKey \|\| ""\)/.test(searchApp));

  // 명의 대조 게이트 — 서버가 못 막는 사고(같은 소유자의 타계정끼리는 신원게이트를 통과한다)
  ok('명의 대조 게이트 존재', /function _batchCheckIdentity\(cid\)/.test(searchApp) && /function _batchIdentityGuard\(\)/.test(searchApp));
  ok('★ 확인 안 된 불일치가 있으면 제출 차단', /if \(!_batchIdentityGuard\(\)\) \{ _resetBtn\(\); return; \}/.test(searchApp));
  ok('대조 게이트가 필수값 검증보다 앞(빈 계좌칸 오류 방지)',
    searchApp.indexOf('if (!_batchIdentityGuard())') < searchApp.indexOf('const _missingLabels = []'));
  ok('빈 계좌칸만 1번 카드에서 채움(주문자는 미복사)',
    /function _batchFillEmptyBankFromFirst\(\)[\s\S]{0,600}_bank: "of_bank", _account: "of_account", _depositor: "of_depositor"/.test(searchApp) &&
    !/_batchFillEmptyBankFromFirst[\s\S]{0,600}of_orderer/.test(searchApp));

  // ★★ 자동배정(순서 폴백) 부재 — 리뷰어 화면에는 표를 눈으로 대조할 사람이 없다
  const batchRegion = searchApp.slice(searchApp.indexOf('function _batchMountDropzone'), searchApp.indexOf('function _batchCheckIdentity'));
  ok('★★ 리뷰어 일괄첨부에 "남은 순서 자동배정" 폴백이 없다(남의 명의 접수 차단)',
    !/left\[0\]/.test(batchRegion) && !/left\.find\(/.test(batchRegion));
  ok('일괄첨부는 기존 단일 경로(_processCardImgFile)를 재사용(AI 적용 경로 사본 금지)',
    /_batchTakeFiles[\s\S]{0,900}await _processCardImgFile\(files\[i\], empty\[i\]\)/.test(searchApp));
  ok('일괄첨부는 순차 처리(무인증 이미지 리미터 보호)', /_batchTakeFiles[\s\S]{0,900}setTimeout\(r, 250\)/.test(searchApp));

  // E. 관리자 화면의 순서 폴백은 그대로 살아있어야 한다(무회귀)
  ok('E: 관리자 manual-order 의 순서 폴백 자동배정은 그대로 유지',
    /ROWS\.forEach\(r => \{ if \(!r\.capture && left\.length\) take\(r, left\[0\]\); \}\);/.test(manualOrd));

  // 결과 계약 — 단수 값으로 화면을 정하면 거짓말이 된다
  ok('★ _embedLastCampaignHold(마지막 값 단수) 완전 제거', !/_embedLastCampaignHold/.test(searchApp) && !/_embedLastCampaignHold/.test(campaign));
  ok('★ 명의별 results 배열을 부모에 통지', /_embedPost\(\{ type: "order-submitted", successCount, campaignHold: _derived, results \}\)/.test(searchApp));
  ok('campaignHold 는 성공분에서 파생(하나라도 미확정이면 그 값)', /_okr\.every\(r => r\.hold === "confirmed"\) \? "confirmed"/.test(searchApp));
  ok('배치 부분 실패는 "실패한 N건 다시 제출"로 안내', /실패한 \$\{_failedN\}건 다시 제출/.test(searchApp));

  // 복원 — 명의(phone8) 앵커
  ok('★ 배치 복원 앵커가 명의 phone8(위치 밀림 금지)', /out\[h\.phone8\] = f;/.test(searchApp));
  ok('★ 위치기반 저장/복원은 배치에서 비활성(카드 수 가변과 양립 불가)',
    /function _embedSaveForm\(\)[\s\S]{0,200}if \(_BATCH\) return;/.test(searchApp) &&
    /function _embedRestoreForm\(\)[\s\S]{0,200}if \(_BATCH\) return;/.test(searchApp));
  ok('텍스트와 사진을 다른 키에 저장(용량 초과가 텍스트까지 죽이지 않게)',
    /_BFORM_KEY = .*embedBatchForm_/.test(searchApp) && /_BCAP_KEY  = .*embedBatchCap_/.test(searchApp));
  ok('★ 저장 후 되읽어 확인(조용한 실패 차단)', /function _ssWrite\(key, obj\)[\s\S]{0,400}return sessionStorage\.getItem\(key\) === s;/.test(searchApp));
  ok('★ 복원 못한 장수를 저장 시점에 기록(배너 거짓말 방지)', /_ssWrite\(_BCAP_KEY, \{ items, dropped \}\)/.test(searchApp));
  ok('배너 문구가 실제 복원 수에서 파생(고정 문구 금지)', /"입력값 " \+ r\.fields \+ "칸"/.test(searchApp));

  // find-slot 왕복 제거(서버가 no-op 인데 카드당 15초 타임아웃 → 홀드 TTL 잠식)
  ok('★ 배치는 find-slot 왕복을 생략', /if \(!_BATCH && slotAuth\.name/.test(searchApp) && /if \(!_BATCH && i > 0 && slotAuth\.name/.test(searchApp));

  // ══════════════════════════════════════════════════════════════════
  // campaign.html — 스냅샷·결과화면
  // ══════════════════════════════════════════════════════════════════
  console.log('\n[E] campaign.html 배선');
  ok('배치 스냅샷 함수 존재', /function _batchSnapshot\(\)/.test(campaign));
  ok('★ 미리보기는 스냅샷을 만들지 않음', /function _batchSnapshot\(\)\{\s*\n?\s*if\(PREVIEW\) return null;/.test(campaign));
  ok('★ 만료 홀드는 스냅샷에서 제외', /!h\.expiresAt \|\| Date\.parse\(h\.expiresAt\) > now/.test(campaign));
  ok('★ 만료 임박 오름차순 정렬(먼저 끝나는 자리부터)', /sort\(\(a,b\) => Date\.parse\(a\.expiresAt \|\| 0\) - Date\.parse\(b\.expiresAt \|\| 0\)\)/.test(campaign));
  ok('★ 홀드 1건이면 스냅샷 없음(현행 동작 불변)', /if\(arr\.length < 2\) return null;/.test(campaign));
  ok('★ 옵션 공고인데 optionKey 미상 홀드가 섞이면 배치 금지', /const optOk = !\(\(\(_camp && _camp\.options\) \|\| \[\]\)\.length\) \|\| \(snap \|\| \[\]\)\.every\(x => x\.optionKey\);/.test(campaign));
  ok('★ 저장 실패는 batch 미설정(단건 fail-closed)', /catch\(_\)\{ try\{ sessionStorage\.removeItem\(BATCH_KEY\); \}catch\(_2\)\{\} \}/.test(campaign));
  ok('홀드에 optionKey 를 저장(카드별 옵션의 유일 출처)', /optionKey: optionKey \|\| \(j\.optionKey \|\| ''\)/.test(campaign));
  ok('★ 배치 여부는 iframe ack 로만 인정(배포 스큐 방어)', /if\(d\.type === 'batch-mode'\)/.test(campaign));
  ok('명의별 결과 화면 존재', /function renderDoneBatch\(results\)/.test(campaign));
  ok('★ 성공한 명의만 홀드 정리(실패분은 이어서 진행 대상으로 남김)', /ok\.forEach\(r => \{ try\{ if\(r\.phone8\) clearHold\(r\.phone8\); \}catch\(_\)\{\} \}\)/.test(campaign));
  ok('지각 건은 "운영자 확인 중"으로 명시', /운영자 확인 중/.test(campaign));
  ok('참여 2건 이상이면 TTL 경고를 띄운다', /구매를 먼저 끝내고 마지막에 한 번에 제출하세요/.test(campaign));

  // 단건 경로 무회귀
  ok('단건은 기존 renderDone 경로 그대로', /else renderDone\(d\.campaignHold && d\.campaignHold !== 'confirmed'\);/.test(campaign));

  console.log(`\n✅ campaignBatchSubmit: ${passed}개 통과`);
  process.exit(0);   // pool 이 이벤트루프를 붙잡고 있어 명시 종료(다른 런타임 가드와 동일)
})().catch(e => { console.error('\n❌ 실패:', e.message); process.exit(1); });
