/**
 * reviewType.test.js — 리뷰타입(구매확정) 정합 회귀가드 · 1차(스키마 + 어휘 통일 + 안전핀)
 * 실행: node tests/reviewType.test.js
 *
 * 이 변경의 위험은 넷이다.
 *  ① **참여 소각** — 구매확정건 리뷰어는 리뷰 화면이 아니라 구매확정 완료 화면을 올린다.
 *     AI 는 아직 그 종류를 몰라 `kind='other'` 로 판정하고 1차 필터가 확신 0.9 이상에서
 *     첨부를 **잠근다**. 안전핀(`purchase_confirm_tab` skip)이 풀리면 정상 제출이 전면 차단된다.
 *  ② **판정 사본** — 문자열 → 표준 key 규칙을 화면마다 만들면 "공고는 구매확정인데 검수는 리뷰"로
 *     갈라진다. 서버 단일 출처 + 프론트 프리필용 최소 표의 **라벨 일치**를 고정한다.
 *  ③ **조용한 해제** — 리뷰타입 UI 가 없는 화면이 저장할 때 값이 지워지면 안 된다
 *     (미전송=유지 / ''=해제 의 CASE 센티널).
 *  ④ **권한 상승** — 리뷰어앱 스코프 토큰(`via:'reviewer_campaign'`)이 검수 정책을 바꾸면 안 된다.
 *
 * ★ 순수함수는 **실제로 실행**해 검증한다(문자열 존재만 보는 grep 은 스코프·실행경로를 못 본다).
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const S = p => fs.readFileSync(path.join(__dirname, '..', p), 'utf8');
const F = p => fs.readFileSync(path.join(__dirname, '..', '..', 'frontend', p), 'utf8');

let pass = 0;
const t = (name, cond) => { assert(cond, name); pass++; console.log('  ✓ ' + name); };

console.log('\n▶ 리뷰타입(구매확정) 회귀가드\n');

const RT = require('../src/utils/reviewType');

/* ── 1) 문자열 → 표준 key (순수함수 실행) ───────────────────── */
console.log('1) normalizeReviewType — 실측 입력값');

t('인트라넷 단일값 5종', RT.normalizeReviewType('포토') === 'photo'
  && RT.normalizeReviewType('텍스트') === 'text'
  && RT.normalizeReviewType('구매확정') === 'confirm'
  && RT.normalizeReviewType('별점') === 'star'
  && RT.normalizeReviewType('혼합') === 'mixed');

t('★★ 혼합 문자열이 포토로 오판되지 않는다(혼합 판정이 먼저)',
  RT.normalizeReviewType('혼합(포토 10건, 텍스트 20건, 구매확정 0건, 별점 0건)') === 'mixed');

t('옛 표기 믹스 = 혼합', RT.normalizeReviewType('믹스') === 'mixed');

t('★ 실배송·빈박스는 배송유형이지 리뷰타입이 아니다 → null',
  RT.normalizeReviewType('실배송') === null && RT.normalizeReviewType('빈박스') === null);

t('시트 작업옵션 칸 표기(포토리뷰)도 읽는다', RT.normalizeReviewType('포토리뷰') === 'photo');

t('공백·null·모르는 값 = null (fail-open)',
  RT.normalizeReviewType('') === null && RT.normalizeReviewType(null) === null
  && RT.normalizeReviewType(undefined) === null && RT.normalizeReviewType('알수없음') === null);

t('이미 표준 key 인 값은 그대로 통과(공고 컬럼 왕복)',
  RT.REVIEW_TYPE_KEYS.every(k => RT.normalizeReviewType(k) === k));

t('배송유형 오분류 판별기', RT.isLegacyDeliveryValue('실배송') === true
  && RT.isLegacyDeliveryValue('빈박스') === true
  && RT.isLegacyDeliveryValue('구매확정') === false);

/* ── 2) 작업오더 파싱 ────────────────────────────────────── */
console.log('\n2) parseWorkOrderReviewType — 인트라넷 조립 문자열');
{
  const r = RT.parseWorkOrderReviewType('혼합(포토 10건, 텍스트 20건, 구매확정 5건, 별점 0건)');
  t('혼합 + 유형별 건수', r.type === 'mixed' && r.mixed === true
    && r.counts.photo === 10 && r.counts.text === 20 && r.counts.confirm === 5 && r.counts.star === 0);
  const s = RT.parseWorkOrderReviewType('구매확정');
  t('단일값은 counts 없음', s.type === 'confirm' && s.mixed === false
    && Object.keys(s.counts).length === 0);
  t('★ 0건도 0으로 읽는다(빈 값과 구분 — Number("")===0 함정)',
    r.counts.star === 0 && !('mixed' in r.counts));
}

/* ── 3) 행별 우선순위 (사용자 확정: 시트 작업옵션 칸이 진실) ── */
console.log('\n3) resolveReviewType — 행 > 공고 > 탭');

t('① 행 작업옵션이 최우선',
  RT.resolveReviewType({ rowOption: '구매확정', campaignType: 'photo', tabReviewType: 'text' }) === 'confirm');
t('② 행이 비면 공고',
  RT.resolveReviewType({ rowOption: '', campaignType: 'confirm', tabReviewType: 'text' }) === 'confirm');
t('③ 공고도 비면 탭',
  RT.resolveReviewType({ campaignType: '', tabReviewType: '구매확정' }) === 'confirm');
t('★★ 혼합뿐이면 행을 결정하지 못한다 → null (혼합 오더 전원이 같은 유형이 되는 것 차단)',
  RT.resolveReviewType({ campaignType: 'mixed', tabReviewType: 'mixed' }) === null);
t('★ 공고가 혼합이어도 행 값이 있으면 그 행은 결정된다',
  RT.resolveReviewType({ rowOption: '구매확정', campaignType: 'mixed' }) === 'confirm');
t('전부 미지정 = null = 오늘 동작 그대로', RT.resolveReviewType({}) === null);
t('isPurchaseConfirm 는 resolveReviewType 과 같은 답',
  RT.isPurchaseConfirm({ rowOption: '구매확정' }) === true
  && RT.isPurchaseConfirm({ rowOption: '포토' }) === false
  && RT.isPurchaseConfirm({}) === false);

/* ── 4) ★★ 안전핀 — 구매확정 탭은 1차 필터를 돌리지 않는다 ── */
console.log('\n4) 1차 필터 안전핀 (precheckPolicy 실행)');
const inspect = require('../src/services/reviewInspect.service');
// 구매확정 완료 화면이 오늘 받는 판정: kind='other' + 높은 확신
const CONFIRM_SHOT = { kind: 'other', confidence: 0.95, channel: '' };

/* ★★ 불변식은 "skip 이냐"가 아니라 **"절대 잠그지 않느냐"** 다.
   1차에서는 판정 층이 없어 skip 이었고 2차에서 pass/warn 으로 올렸다 —
   구현이 어느 쪽이든 **block 이 나오면 정상 제출 전면 차단(참여 소각)** 이라는 점이 핵심이다.
   그래서 코드 형태가 아니라 결과를 고정한다(테스트를 통과시키려고 코드를 되돌리는 일 방지). */
t('★★ 구매확정 탭은 어떤 판정에도 잠기지 않는다 — 이 불변식이 풀리면 정상 제출이 전면 차단된다', (() => {
  const shots = [
    CONFIRM_SHOT,                                              // other 0.95
    { kind: 'review', confidence: 0.99, channel: 'coupang' },  // 리뷰 화면 오첨부
    { kind: 'purchase_confirm', confidence: 0.95 },            // 정상
    { kind: 'other', confidence: 0.30 },                       // 저확신
    null,                                                       // AI 장애
  ];
  return shots.every(c => {
    const v = inspect.precheckPolicy({ classified: c, expectedChannel: 'coupang',
                                       slotKey: 'review', reviewType: 'confirm' });
    return v.verdict !== 'block' && v.blockable === false;
  });
})());

t('★ 리뷰타입 미지정(null)이면 종전 그대로 차단된다 = 무회귀', (() => {
  const v = inspect.precheckPolicy({ classified: CONFIRM_SHOT, expectedChannel: 'coupang',
                                     slotKey: 'review', reviewType: null });
  return v.verdict === 'block' && v.code === 'not_review';
})());

t('★ reviewType 인자를 아예 안 넘겨도 종전 동작(기본값 null)', (() => {
  const v = inspect.precheckPolicy({ classified: CONFIRM_SHOT, expectedChannel: 'coupang', slotKey: 'review' });
  return v.verdict === 'block';
})());

t('구매확정 아닌 유형(포토)은 안전핀에 안 걸린다', (() => {
  const v = inspect.precheckPolicy({ classified: CONFIRM_SHOT, expectedChannel: 'coupang',
                                     slotKey: 'review', reviewType: 'photo' });
  return v.verdict === 'block';
})());

t('정상 리뷰 판정은 구매확정 탭이 아니면 그대로 통과', (() => {
  const v = inspect.precheckPolicy({ classified: { kind: 'review', confidence: 0.95, channel: 'coupang' },
                                     expectedChannel: 'coupang', slotKey: 'review', reviewType: null });
  return v.verdict === 'pass';
})());

/* ── 5) 배선 ─────────────────────────────────────────────── */
console.log('\n5) 배선');
const INSPECT_SRC = S('src/services/reviewInspect.service.js');
const DIAG = S('src/routes/diag.routes.js');
const CAMP = S('src/routes/campaign.routes.js');
const IDX = S('index.js');

t('loadTabExpectations 가 리뷰타입을 같은 LATERAL 행에서 읽는다(다른 공고 값 섞임 방지)',
  /rc\.review_type AS camp_review_type/.test(INSPECT_SRC)
  && /c\.review_type AS tab_review_type/.test(INSPECT_SRC));
t('판정은 utils/reviewType 단일 출처 — 서비스가 정규식을 다시 만들지 않는다',
  /require\('\.\.\/utils\/reviewType'\)/.test(INSPECT_SRC)
  && !/구매\s*확정\|purchase/.test(INSPECT_SRC.replace(/require\([^)]*\)/g, '')));
t('review-precheck 라우트가 reviewType 을 실제로 넘긴다(안 넘기면 핀이 죽은 코드)',
  /reviewType = exp\.reviewType/.test(DIAG) && /precheckPolicy\(\{[^}]*reviewType[^}]*\}\)/.test(DIAG));

t('공고 create INSERT 에 review_type 이 있다',
  /transfer_bank, transfer_memo, review_type\)/.test(CAMP)
  && /normalizeReviewType\(review_type\)/.test(CAMP));
t('★ 공고 update 는 CASE 센티널 — null=유지 / \'\'=해제(조용한 해제 차단)',
  /review_type = CASE WHEN \$39::text IS NULL THEN review_type[\s\S]{0,120}WHEN \$39::text = '' THEN NULL/.test(CAMP));
t('★ create·update 양쪽이 req.body 에서 review_type 을 구조분해한다(누락=500)',
  (CAMP.match(/review_type, \/\/ ★ 087/g) || []).length === 2);
t('★ REQUIRED_SCHEMA 에 등록(컬럼 누락 = 공고 발행·수정 전면 42703)',
  /\['recruit_campaigns', 'review_type'\]/.test(IDX));

/* ── 6) 권한 — 스코프 토큰은 리뷰타입을 못 바꾼다 ─────────── */
console.log('\n6) 권한 경계');
{
  const scoped = (CAMP.match(/UPDATE recruit_campaigns SET\s+title=\$2[\s\S]*?WHERE id=\$1 RETURNING \*/) || [''])[0];
  t('★ _scopedCampaignEdit(리뷰어앱 토큰) SET 절에 review_type 없음 — 검수 정책 변조 차단',
    scoped.length > 0 && !/review_type/.test(scoped));
}

/* ── 7) 마이그레이션 ─────────────────────────────────────── */
console.log('\n7) migration 087');
const MIG = S('migrations/087_campaign_review_type.sql');
t('recruit_campaigns.review_type 추가(IF NOT EXISTS = 재실행 안전)',
  /ALTER TABLE recruit_campaigns\s+ADD COLUMN IF NOT EXISTS review_type TEXT/.test(MIG));
t('★ TEXT 타입 — 082 의 42804(타입 불일치로 파일 전체 롤백) 계열 함정 회피',
  /review_type TEXT/.test(MIG) && !/review_type\s+UUID/i.test(MIG));
t('★ 기존 행 백필 없음 = 기존 공고 동작 불변', !/\bUPDATE\b/i.test(MIG));
t('★ 판정을 DB CHECK 로 이중화하지 않는다(어휘 확장 시 저장 실패 방지)', !/CHECK\s*\(/i.test(MIG));

t('옛 값 정리는 자동이 아니라 dryRun 기본 엔드포인트',
  /router\.post\('\/review-type-cleanup', authMiddleware, adminOrMasterMiddleware/.test(DIAG)
  && /dryRun = req\.body\?\.dryRun !== false/.test(DIAG));
t("★★ 배송유형 이관은 blank-only — 접수가 채운 값을 덮지 않는다",
  /COALESCE\(delivery_type, ''\) = '' THEN review_type/.test(DIAG));

/* ── 8) 프론트 ───────────────────────────────────────────── */
console.log('\n8) 프론트 배선');
const MODAL = F('js/recruit-modal.js');
const REC = F('js/index-recruit.js');
const WOD = F('js/work-order-detail.js');
const APP = F('js/index-app.js');

t('공고 모달에 리뷰타입 버튼군(표준 key 5종 + 미지정)',
  /id="rf_review_type_btns"/.test(MODAL)
  && RT.REVIEW_TYPE_KEYS.every(k => new RegExp(`data-val="${k}"`).test(MODAL))
  && /<input id="rf_review_type" type="hidden">/.test(MODAL));
t('★ 참여형 전용 섹션 밖 — 레거시 공고도 지정할 수 있어야 한다',
  MODAL.indexOf('id="rf_review_type_btns"') < MODAL.indexOf('rf_participation'));
t('selectRfBtn 이 리뷰타입 그룹을 안다(컨테이너 + 분기)',
  /#rf_review_type_btns/.test(REC) && /group === 'review_type'/.test(REC));
t('★ _rfPickBtn 이 그룹명으로 hidden 을 찾는다(삼항 하드코딩이면 새 그룹이 조용히 빠진다)',
  /getElementById\("rf_" \+ group\)/.test(REC));
t('편집 프리필·작업오더 프리필 양쪽에서 버튼을 고른다',
  /_rfPickBtn\("review_type", _rfReviewTypeKey\(c\.review_type/.test(REC)
  && /_rfPickBtn\("review_type", _rfReviewTypeKey\(prefill\.review_type\)\)/.test(REC));
t('★ 저장은 버튼군 UI 있는 화면에서만 전송(미전송=유지)',
  /if \(document\.getElementById\("rf_review_type_btns"\)\) \{[\s\S]{0,160}payload\.review_type/.test(REC));
t('작업오더 프리필이 review_type 을 넘긴다(공유 모듈 1벌)',
  /review_type:\s+o\.review_type \|\| ""/.test(WOD));

t('★★ 프론트 프리필 표의 라벨이 서버 REVIEW_TYPES 와 일치(사본 드리프트 차단)', (() => {
  const m = REC.match(/const RF_REVIEW_TYPE_LABELS = \[([\s\S]*?)\];/);
  if (!m) return false;
  const pairs = [...m[1].matchAll(/\['(\w+)',\s*'([^']+)'\]/g)].map(x => [x[1], x[2]]);
  const server = RT.REVIEW_TYPES.map(x => [x.key, x.label]);
  return JSON.stringify(pairs) === JSON.stringify(server);
})());

t('탭 설정 팝오버 선택지가 새 목록(두 화면 모두)', ['admin.html', 'search.html'].every(f => {
  const s = F(f);
  const block = (s.match(/<div class="tc-option-row" id="tcOptReview">([\s\S]*?)<\/div>/) || [, ''])[1];
  return RT.REVIEW_TYPE_LABELS.every(l => block.includes(`data-val="${l}"`))
      && !/data-val="실배송"/.test(block) && !/data-val="믹스"/.test(block);
}));
t('★ 옛 값 배지는 화면에서 사라지지 않는다(색 맵·CSS 유지)',
  /'실배송': 'tc-review-실배송'/.test(APP) && /'믹스': 'tc-review-믹스'/.test(APP)
  && ['css/index.css', 'css/search.css'].every(f => /\.tc-review-실배송\{/.test(F(f))));
t('★ 라벨 어휘 통일 — 화면에 "리뷰유형" 표기가 남아 있지 않다',
  ['admin.html', 'admin-siand.html', 'staff.html', 'workdesk.html',
   'js/index-app.js', 'js/work-order-detail.js'].every(f => !F(f).includes('리뷰유형')));

/* ── 9) 정리 화면 — 리뷰웹시스템[3버전]에서 부를 수 있어야 한다 ── */
console.log('\n9) 리뷰타입 정리 화면');
const SET = F('js/admin-settings.js');
{
  // 라우터 스택 실검사 — 인트라넷 SSO 토큰은 /api/diag/* 에 도달 자체가 불가하므로 프록시가 필요하다
  process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgres://u:p@127.0.0.1:1/none';
  const tb = require('../src/routes/trackB.routes');
  const hit = tb.stack.filter(l => l.route && l.route.path === '/settings/review-type-cleanup');
  t('Track B 프록시 등록 + 원본과 같은 권한(admin/master)',
    hit.length === 1 && hit[0].route.stack.map(s => s.name).slice(0, 2)
      .join(',') === 'authMiddleware,adminOrMasterMiddleware');
}
const TBS = S('src/routes/trackB.routes.js');
t('★ 로직 복제 0 — 기존 diag 핸들러를 위임한다',
  /_delegate\(require\('\.\/diag\.routes'\), 'post', '\/review-type-cleanup'\)/.test(TBS));
t('설정 패널·목차·로더가 같은 키로 등록된다',
  /reviewtype: _reviewTypeHtml/.test(SET) && /reviewtype: loadReviewTypeCleanup/.test(SET)
  && /reviewtype: \{ ic: '✅'/.test(SET));
t('★ 경로를 재기준하지 않는다 — 양쪽 호스트가 같은 경로로 같은 결과를 본다(작업표와 같은 판단)',
  /RTC_EP = '\/api\/trackb\/settings\/review-type-cleanup'/.test(SET)
  && !/reviewTypeCleanup:/.test(SET.slice(0, SET.indexOf('function _ep('))));
t('★ 미리보기를 본 뒤에만 적용 버튼이 보인다(숫자 확인 없이 실행 불가)',
  /id="rtcApplyBtn" style="display:none"/.test(SET)
  && /reviewTypeCleanupRun\(true\)/.test(SET) && /reviewTypeCleanupRun\(false\)/.test(SET));
t('적용은 confirm 뒤에만', /if \(!dryRun && !confirm\(/.test(SET));
t('★ 펼칠 때 자동 실행하지 않는다(설정 화면 열 때마다 전 탭 훑기 금지)',
  /function loadReviewTypeCleanup\(\) \{ _setNavBadge/.test(SET));

/* ══ 2차: 슬롯 파생 + AI 판별 ══════════════════════════════ */

/* ── 10) 슬롯 파생 (순수함수 실행) ─────────────────────────── */
console.log('\n10) 캡처 슬롯 파생');
const CS = require('../src/utils/captureSlots');

t('★★ 구매확정 단독은 슬롯을 만들지 않는다 — 길이 1을 돌려주면 완료 판정이 영영 안 된다', (() => {
  // 프론트는 length>1 일 때만 슬롯 UI 를 그리고, 단일 첨부는 slotKey 를 안 보내 'review' 가 된다.
  // 여기서 ['confirm'] 을 요구하면 필요 슬롯 ⊄ 제출 슬롯 → 구매확정 제출 전멸.
  return CS.effectiveCaptureSlots(null, '', 'confirm') === null
      && JSON.stringify(CS.requiredSlotKeys(null, '', 'confirm')) === '["review"]';
})());

t('구매확정 + 현영 = 2슬롯, 리뷰 자리가 구매확정으로 치환된다', (() => {
  const eff = CS.effectiveCaptureSlots(null, '사업자현영', 'confirm');
  // ★ 현금영수증 슬롯은 선택(required:false, 사용자 확정 2026-08-05) — 완료 판정에선 confirm만
  return eff.length === 2 && eff[0].key === 'confirm' && eff[1].key === 'receipt'
      && JSON.stringify(CS.requiredSlotKeys(null, '사업자현영', 'confirm')) === '["confirm"]';
})());

t('★ 리뷰타입 없음/포토 = 종전 동작 완전 동일(무회귀)', (() => {
  const a = JSON.stringify(CS.effectiveCaptureSlots(null, '', null));
  const b = JSON.stringify(CS.effectiveCaptureSlots(null, '', 'photo'));
  const c = JSON.stringify(CS.effectiveCaptureSlots(null, '사업자현영', null));
  const d = JSON.stringify(CS.effectiveCaptureSlots(null, '사업자현영', 'photo'));
  return a === 'null' && b === 'null' && c === d
      && CS.effectiveCaptureSlots(null, '사업자현영', null)[0].key === 'review';
})());

t('★ 관리자가 capture_slots 를 명시했으면 리뷰타입보다 우선(종전 계약)', (() => {
  const mine = [{ key: 'a', label: 'A' }, { key: 'b', label: 'B' }];
  return JSON.stringify(CS.effectiveCaptureSlots(mine, '사업자현영', 'confirm')) === JSON.stringify(mine);
})());

t('슬롯 라벨도 리뷰타입을 본다', CS.slotLabel(null, '사업자현영', 'confirm', 'confirm') === '구매확정');

/* ── 11) AI 기대 화면 종류 ───────────────────────────────── */
console.log('\n11) 기대 화면 종류 (_expectedKind)');
const CV = require('../src/services/captureVerify.service');
{
  /* ★ 동기 호출로 검증한다. verifyCapture(async)의 `expected` 로 간접 확인하면
     단언이 `process.exit(0)` 뒤로 밀려 **조용히 실행되지 않는다**(변이시험으로 실측). */
  const kindOf = CV._expectedKind;
  t('★ 구매확정 작업의 리뷰 자리는 구매확정 화면을 기대한다(단일 첨부 경로 = slotKey "review")',
    kindOf('review', 'confirm') === 'purchase_confirm');
  t('★ 리뷰타입 없으면 종전 그대로 review',
    kindOf('review', null) === 'review' && kindOf('review', 'photo') === 'review');
  t('영수증 자리는 리뷰타입과 무관하게 receipt', kindOf('receipt', 'confirm') === 'receipt');
  t('confirm 슬롯(현영 2슬롯)도 구매확정 화면', kindOf('confirm', null) === 'purchase_confirm');
  t('모르는 슬롯은 검수 대상 아님', kindOf('nope', 'confirm') === null);
}

const GEM = S('src/services/gemini.service.js');
t('★★ kind 판정 기준 3줄은 한 글자도 안 바뀌었다(오래 검증된 슬롯 검수가 그대로 쓴다)',
  GEM.includes('- "review": 쇼핑몰 리뷰 화면. 별점(★), 리뷰 본문, 상품평 목록, "리뷰 작성 완료" 같은 UI가 보임.')
  && GEM.includes('- "receipt": 현금영수증/결제 영수증. 국세청, 현금영수증, 승인번호, 사업자등록번호, 지출증빙, 거래일시 중 하나 이상이 보임.')
  && GEM.includes('- "other": 둘 다 아님(상품 사진, 주문내역, 빈 화면 등).'));
t('purchase_confirm 종류 추가 + 화이트리스트 + JSON 형식',
  /- "purchase_confirm": 구매확정 완료 화면/.test(GEM)
  // 자동 분류(파일 라우팅)에서 order_capture 가 추가됐다 — purchase_confirm 생존 검사는 그대로
  && /\['review', 'receipt', 'purchase_confirm', 'order_capture', 'other'\]\.includes\(p\.kind\)/.test(GEM)
  && /"kind":"review\|receipt\|purchase_confirm\|order_capture\|other"/.test(GEM));
t('★★ 캐시 접두 상향 — 옛 캐시가 새 종류를 모른 채 히트하는 것 차단',
  /_getCacheKey\('classify[4-9]\d*:'/.test(GEM) && !/_getCacheKey\('classify[23]:'/.test(GEM));

/* ── 12) ★★ 잠금 범위 — 넓히지 않는다 ──────────────────── */
console.log('\n12) 1차 필터 — 구매확정 갈래는 절대 잠그지 않는다');
const CONFIRM_SHOT2 = { kind: 'purchase_confirm', confidence: 0.95, channel: '' };

t('구매확정 작업 + 구매확정 화면 = pass', (() => {
  const v = inspect.precheckPolicy({ classified: CONFIRM_SHOT2, slotKey: 'review', reviewType: 'confirm' });
  return v.verdict === 'pass' && v.code === 'confirm_ok';
})());
t('★★ 구매확정 작업에 리뷰 화면을 올려도 **차단하지 않는다**(경고까지)', (() => {
  const v = inspect.precheckPolicy({ classified: { kind: 'review', confidence: 0.99, channel: 'coupang' },
                                     slotKey: 'review', reviewType: 'confirm' });
  return v.verdict === 'warn' && v.blockable === false && /구매확정/.test(v.message);
})());
t('★★ 구매확정 작업에 엉뚱한 이미지(other 0.99)여도 차단하지 않는다 = 참여 소각 방지', (() => {
  const v = inspect.precheckPolicy({ classified: CONFIRM_SHOT, slotKey: 'review', reviewType: 'confirm' });
  return v.verdict !== 'block' && v.blockable === false;
})());
t('★★ 역방향 — 리뷰 작업 자리에 구매확정 화면도 경고까지만(새 종류 도입으로 판정이 세지면 안 된다)', (() => {
  const v = inspect.precheckPolicy({ classified: CONFIRM_SHOT2, slotKey: 'review', reviewType: null });
  return v.verdict === 'warn' && v.code === 'purchase_confirm_on_review' && v.blockable === false;
})());
t('★ 잠금은 여전히 other 한 갈래뿐 = 무회귀', (() => {
  const v = inspect.precheckPolicy({ classified: CONFIRM_SHOT, expectedChannel: 'coupang',
                                     slotKey: 'review', reviewType: null });
  return v.verdict === 'block' && v.code === 'not_review';
})());
const INS2 = S('src/services/reviewInspect.service.js');
t('킬스위치 REVIEW_CONFIRM_VERIFY — 끄면 구매확정 갈래는 판정 자체를 건너뛴다',
  /REVIEW_CONFIRM_VERIFY/.test(INS2) && /if \(!CONFIRM_VERIFY\) return skip\('purchase_confirm_tab'\)/.test(INS2));

/* ── 13) 소비처 4곳이 전부 리뷰타입을 본다 ──────────────── */
console.log('\n13) 슬롯 소비처 4곳 (하나만 빠져도 제출이 깨진다)');
const SRCH = S('src/services/search.service.js');
const SUB = S('src/routes/submit.routes.js');
const RE = S('src/routes/reviewEdit.routes.js');
t('① 리뷰어 화면 슬롯 (search.service)',
  /effectiveCaptureSlots\(row\.captureSlots, row\.incomeType, _rtMap\.get/.test(SRCH));
t('② 제출 완료 판정 (submit.routes)',
  /requiredSlotKeys\(ctxRows\[0\]\?\.capture_slots, ctxRows\[0\]\?\.income_type, _rt\)/.test(SUB));
t('③ 업로드 폴더 라벨 + 검수 기대값 (diag review-upload)',
  /slotLabelOf\(tabRows\[0\]\?\.capture_slots, tabRows\[0\]\?\.income_type, slot, _tabReviewType\)/.test(DIAG)
  && /reviewType: _tabReviewType/.test(DIAG));
t('④ 교체요청 라벨 2곳 (reviewEdit)',
  (RE.match(/reviewTypeForTab\(/g) || []).length >= 2);
t('★ 조회는 단일 출처 서비스 하나 — 네 곳이 각자 SQL 을 쓰면 조용히 갈라진다',
  [SRCH, SUB, DIAG, RE].every(f => /reviewTypeContext\.service/.test(f)));
const RTC = S('src/services/reviewTypeContext.service.js');
t('★ 그 서비스도 판정은 utils/reviewType 에 맡긴다(규칙 사본 0)',
  /require\('\.\.\/utils\/reviewType'\)/.test(RTC) && /resolveReviewType\(/.test(RTC));
t('★ 조회 실패는 캐시에 넣지 않는다(일시 장애를 60초 굳히지 않는다)',
  /return null;\s*\/\/ ★ 캐시에 넣지 않는다/.test(RTC));

console.log(`\n✅ ${pass}건 통과\n`);
process.exit(0);
