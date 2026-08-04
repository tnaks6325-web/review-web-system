/**
 * captureSlotVerify.test.js — 현금영수증 2·3단계 회귀가드.
 *
 * 2단계: 현영 탭은 capture_slots 설정 없이도 리뷰+현금영수증 2슬롯이 자동 적용된다.
 *   ★ 슬롯 판정은 utils/captureSlots **하나**가 내야 한다 — 검색 응답(그릴 슬롯)·완료 판정
 *     (필요 슬롯 ⊆ 제출 슬롯)·업로드 폴더 라벨이 어긋나면 "슬롯 2개인데 1장에 완료" 같은
 *     제출 파손이 난다.
 * 3단계: 슬롯 형식 AI 검수. ★★ fail-open — AI 장애·저확신은 제출을 막지 않는다.
 * 실행: node tests/captureSlotVerify.test.js
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const Module = require('module');
const readF = (p) => fs.readFileSync(path.join(__dirname, '..', '..', 'frontend', p), 'utf8');
const readS = (p) => fs.readFileSync(path.join(__dirname, '..', 'src', p), 'utf8');

let n = 0;
const ok = (name, cond) => { assert(cond, name); n++; console.log('  ✓ ' + name); };

/* ═══ 2단계: 슬롯 파생(순수함수) ═══ */
const cs = require('../src/utils/captureSlots');
const keys = (v) => (v ? v.map(s => s.key) : null);

ok('일반 탭은 단일 슬롯 — 기존 동작 불변', cs.effectiveCaptureSlots(null, '일반') === null);
ok('현영 탭은 리뷰+현금영수증 2슬롯 자동',
  JSON.stringify(keys(cs.effectiveCaptureSlots(null, '사업자현영'))) === JSON.stringify(['review', 'receipt']));
ok('관리자 명시 설정(capture_slots)이 최우선',
  JSON.stringify(keys(cs.effectiveCaptureSlots([{ key: 'a', label: 'A' }], '사업자현영'))) === JSON.stringify(['a']));
ok('★ 완료 판정이 화면과 같은 답을 낸다(현영)',
  JSON.stringify(cs.requiredSlotKeys(null, '현영')) === JSON.stringify(['review', 'receipt']));
ok('★ 완료 판정이 화면과 같은 답을 낸다(일반)',
  JSON.stringify(cs.requiredSlotKeys(null, '')) === JSON.stringify(['review']));
ok('업로드 폴더 라벨도 같은 출처', cs.slotLabel(null, '사업자현영', 'receipt') === '현금영수증');
ok('key만 있는 잘못된 설정은 걸러낸다', cs.effectiveCaptureSlots([{ label: '라벨만' }], '') === null);
ok('현영 판정 규칙은 한 곳',
  cs.isCashReceiptIncome('사업자현영') && !cs.isCashReceiptIncome('일반') && !cs.isCashReceiptIncome(null));

/* ═══ 2단계: 소비처가 전부 공용 유틸을 쓰는가(사본 금지) ═══ */
const submit = readS('routes/submit.routes.js');
const search = readS('services/search.service.js');
const diag = readS('routes/diag.routes.js');
const revEdit = readS('routes/reviewEdit.routes.js');

ok('완료 판정(submit)이 공용 유틸 사용 — 자체 구현 없음',
  /require\('\.\.\/utils\/captureSlots'\)/.test(submit)
  && !/function requiredSlotKeys\(captureSlots\) \{/.test(submit));
ok('완료 판정이 income_type을 함께 읽는다(안 읽으면 현영 자동 슬롯을 못 봄)',
  /tc\.income_type AS income_type/.test(submit)
  && /requiredSlotKeys\(ctxRows\[0\]\?\.capture_slots, ctxRows\[0\]\?\.income_type\)/.test(submit));
ok('검색 응답이 파생 슬롯을 내려준다',
  /effectiveCaptureSlots\(row\.captureSlots, row\.incomeType\)/.test(search)
  && /tc\.income_type\s+AS "incomeType"/.test(search));
ok('업로드 폴더 라벨이 공용 유틸 사용',
  /slotLabelOf\(tabRows\[0\]\?\.capture_slots, tabRows\[0\]\?\.income_type, slot\)/.test(diag));
ok('리뷰 교체요청도 같은 라벨 규칙(파일이 다른 폴더로 흩어지지 않게)',
  /slotLabelOf\(cfg\.capture_slots, cfg\.income_type, slot\)/.test(revEdit)
  && /slotLabelOf\(tc\[0\]\?\.capture_slots, tc\[0\]\?\.income_type, k\)/.test(revEdit));

/* ═══ 3단계: 검수 정책(실제 핸들러 · Gemini 스텁) ═══ */
const orig = Module.prototype.require;
let mode = 'ok';
Module.prototype.require = function (p) {
  if (p === './gemini.service') {
    return {
      classifySubmissionImage: async () => {
        if (mode === 'throw') throw new Error('Gemini 장애');
        if (mode === 'low') return { kind: 'other', confidence: 0.3, businessNo: '', amount: 0 };
        if (mode === 'receipt') return { kind: 'receipt', confidence: 0.95, businessNo: '1234567890', amount: 0 };
        if (mode === 'bizmismatch') return { kind: 'receipt', confidence: 0.95, businessNo: '9998887777', amount: 0 };
        return { kind: 'review', confidence: 0.95, businessNo: '', amount: 0 };
      },
    };
  }
  return orig.apply(this, arguments);
};
const cv = require('../src/services/captureVerify.service');

(async () => {
  const t = async (name, m, args, expect) => {
    mode = m;
    const r = await cv.verifyCapture(args);
    ok(name + ' → ' + r.status, r.status === expect);
  };

  await t('★★ AI 장애는 제출을 막지 않는다(fail-open)', 'throw', { base64: 'x', slotKey: 'review' }, 'skipped');
  await t('★★ 저확신도 통과 — 모호한 캡처로 리뷰어를 붙잡지 않는다', 'low', { base64: 'x', slotKey: 'review' }, 'skipped');
  await t('리뷰 슬롯 + 리뷰 이미지 = 통과', 'ok', { base64: 'x', slotKey: 'review' }, 'ok');
  await t('리뷰 슬롯에 영수증이 오면 경고', 'receipt', { base64: 'x', slotKey: 'review' }, 'mismatch');
  await t('영수증 슬롯 + 영수증 = 통과', 'receipt', { base64: 'x', slotKey: 'receipt' }, 'ok');
  await t('영수증 사업자번호가 회사와 다르면 경고', 'bizmismatch',
    { base64: 'x', slotKey: 'receipt', companyBusinessNo: '123-45-67890' }, 'mismatch');
  await t('모르는 슬롯은 검수 대상 아님', 'ok', { base64: 'x', slotKey: 'zzz' }, 'skipped');
  await t('파일이 없으면 검수 안 함', 'ok', { slotKey: 'review' }, 'skipped');

  Module.prototype.require = orig;

  /* ═══ 배선 ═══ */
  const gem = readS('services/gemini.service.js');
  const app = readF('js/search-app.js');
  // ★ 캐시 접두는 **버전이 올라갈 수 있다**(응답에 필드를 추가하면 옛 캐시가 히트하면 안 되므로
  //   classify: → classify2: 처럼 올린다). 검사의 의도는 "extract 와 다른 용도 접두를 쓴다"이지
  //   특정 문자열이 아니므로, 숫자 접미를 허용해 고정한다.
  ok('Gemini에 이미지 형식 판별 함수 추가(기존 캐시·타임아웃 골격 재사용)',
    /async function classifySubmissionImage/.test(gem) && /_getCacheKey\('classify\d*:'/.test(gem)
    && /classifySubmissionImage,/.test(gem));
  ok('업로드 경로가 검수를 호출하되 결과가 업로드를 뒤집지 않는다',
    /verdict = await verifyCapture\(/.test(diag)
    && /catch \(_\) \{ verdict = null; \}/.test(diag));
  ok('불일치는 관리자 알림으로 남긴다([그대로 제출]해도 사람이 봄)',
    /logCaptureMismatch\(/.test(diag) && /capture_mismatch/.test(readS('services/captureVerify.service.js')));
  ok('알림 기록 실패가 업로드를 깨지 않는다',
    /\[captureVerify\] 알림 기록 실패\(무시\)/.test(readS('services/captureVerify.service.js')));
  ok('리뷰어 화면이 슬롯 자리에 경고를 띄운다(제출은 계속 가능)',
    /function _csShowVerdict/.test(app) && /다시 첨부하면 교체됩니다/.test(app)
    && /upRes\.files \|\| \[\]/.test(app));
  ok('검수는 env로 끌 수 있다(CAPTURE_VERIFY=0)',
    /process\.env\.CAPTURE_VERIFY !== '0'/.test(readS('services/captureVerify.service.js')));

  console.log(`\n✅ captureSlotVerify: ${n}개 통과`);
})();
