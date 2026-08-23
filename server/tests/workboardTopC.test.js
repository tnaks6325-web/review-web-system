/**
 * workboardTopC.test.js — 작업보드 상단 재구성(시안 C) 회귀가드
 * 실행: node tests/workboardTopC.test.js
 * 시안: frontend/docs/design-workboard-top-redesign.html (?v=C · 사용자 확정 2026-08-19)
 *
 * 이 화면이 깨지면 아픈 것 일곱 — 전부 "조용히 틀린 값을 보여주는" 종류다.
 *  ① **판정 사본** — 리뷰비·리뷰타입·현금영수증을 화면이나 서비스가 다시 세면 모집공고 카드·
 *     입금관리와 숫자가 갈린다. 전부 기존 단일 출처(campaignFee·reviewType·captureSlots)를 태운다.
 *  ② **광고주 누출** — 리뷰비·입금명은 내부 값이다. `condition` 은 내부 화면(showEdits)에만 실린다.
 *  ③ **0 을 미설정으로** — 리뷰비 0원은 이 계정에서 흔한 "무상 작업"이다. 근거(feeSource)가
 *     있으면 사람이 정한 0원이고, 없을 때만 미설정이라고 말한다.
 *  ④ **구매 캡처 짝짓기** — `campaign_participants.order_submission_id` 링크는 오염 사례가
 *     문서화돼 있다(2026-08-19 장수산업). 그것으로 붙이면 **남의 캡처가 이 줄에 뜬다** →
 *     짝짓기는 `sheet_row` 하나.
 *  ⑤ **묶음별 상한** — 전체 개수로 자르면 리뷰가 많은 줄에서 구매 캡처가 통째로 잘려
 *     "구매 캡처 없음" 으로 거짓 표시된다.
 *  ⑥ **넘김 줄 자리** — 1장일 때 줄을 없애면 두 칸의 이미지 높이가 어긋난다(나란히 대조 불가).
 *  ⑦ **방향키 충돌** — 내부 화면은 셀 범위 이동에 ↑↓ 를 쓴다. 미리보기가 가로채면 편집이 죽는다.
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const normalizeEol = s => s.replace(/\r\n/g, '\n');
const F = p => normalizeEol(fs.readFileSync(path.join(__dirname, '..', '..', 'frontend', p), 'utf8'));
const S = p => normalizeEol(fs.readFileSync(path.join(__dirname, '..', p), 'utf8'));

let pass = 0;
const t = (name, cond, extra) => { assert(cond, name + (extra ? ' → ' + extra : '')); pass++; console.log('  ✓ ' + name); };

const wd = F('workdesk.html');
const svc = S('src/services/trackB.service.js');
const doc = F('docs/design-workboard-top-redesign.html');

/** 함수 본문 잘라내기 — 최상위 함수는 열 0 의 `}` 로 닫힌다(레포 스타일).
 *  ★ 고정 길이 슬라이스 금지(함수가 자라면 가드가 조용히 빨개진다).
 *  ★ 중괄호 세기도 쓰지 않는다 — 시그니처의 구조분해(`{ a, b }`)가 먼저 0 으로 닫혀 본문을 놓친다. */
function fnBody(src, decl) {
  const i = src.indexOf(decl); if (i < 0) return '';
  const j = src.indexOf('\n}', i + decl.length);
  return j < 0 ? src.slice(i) : src.slice(i, j + 2);
}

console.log('\n── A. 서버: 작업 조건 요약(condition) ──');
const cond = fnBody(svc, 'async function tabConditionSummary(');
t('tabConditionSummary 가 있다', !!cond);
t('① 리뷰비 판정은 utils/campaignFee.resolveReviewFee 를 태운다(사본 금지)',
  /require\('\.\.\/utils\/campaignFee'\)/.test(cond) && /resolveReviewFee\(/.test(cond));
t('① 리뷰타입 판정은 utils/reviewType.resolveReviewType 을 태운다',
  /require\('\.\.\/utils\/reviewType'\)/.test(cond) && /resolveReviewType\(/.test(cond));
t('① 현금영수증 판정은 utils/captureSlots.hasCashReceiptSlot 을 태운다',
  /require\('\.\.\/utils\/captureSlots'\)/.test(cond) && /hasCashReceiptSlot\(/.test(cond));
t('③ 0 을 null 로 접지 않는다 — 빈 값만 null(무상 0원과 미설정을 구분)',
  /v == null \|\| v === ''/.test(cond));
t('③ feeSource 는 근거가 없을 때만 null(0원이라서가 아니다)',
  /campFee != null \? 'campaign'/.test(cond) && /tabFee != null \? 'tab' : null/.test(cond));
t('★ 공고 매칭은 이름 → gid 폴백이고 빈 gid 는 절을 켜지 않는다',
  /linked_tab_name = \$2 OR \(\$3 <> '' AND linked_tab_gid = \$3\)/.test(cond));
t('★ 공고가 여럿이면 살아있는 최신 하나 + campaignCount 로 사실을 말한다',
  /ORDER BY \(status = 'active'\) DESC, created_at DESC/.test(cond) && /campaignCount: camps\.length/.test(cond));
t('★ 구매채널은 서버가 URL 로 추측하지 않는다(판정 단일 출처는 프론트 공유 모듈)',
  !/coupang|smartstore|naver\.com/i.test(cond));
t('★ 어떤 실패에도 throw 하지 않는다 — null 을 돌려주고 화면이 사유를 말한다',
  /catch \(e\)[\s\S]*return null;/.test(cond));
t('② condition 은 내부 화면(showEdits)에서만 응답에 실린다(광고주 미노출)', (() => {
  /* ⚠ 2026-08-24: 총건수 초과 표시가 들어오며 `tabConditionSummary` 를 **루프 뒤 한 번** 부르고
     그 결과를 재사용하게 됐다(호출 2회면 cap 과 조건 카드가 갈릴 수 있다). 검사 의미는 그대로 —
     "condition 은 showEdits 안에서만 응답에 실린다" + 이제 **호출 1회**까지 함께 고정한다. */
  const i = svc.indexOf('res.condition =');
  if (i < 0) return false;
  if ((svc.match(/await tabConditionSummary\(/g) || []).length !== 1) return false;
  // ⚠ 고정 길이 슬라이스(i-700)로 보면 그 사이에 다른 줄이 늘어나는 순간 조용히 빨개진다
  //    (실제로 `res.statusCols` 가 들어오며 밟았다). 바로 앞의 `if (showEdits) {` 를 찾아 그 구간만 본다.
  const before = svc.slice(svc.lastIndexOf('if (showEdits) {', i), i);
  // 광고주 분기(else if) 블록 안에 condition 이 들어가지 않는다 — 전역 [\s\S]* 로 보면
  // 파일 앞쪽의 무관한 `role === 'advertiser'` 가 걸려 항상 참이 된다(약한 단언 금지).
  const advBlock = svc.slice(svc.indexOf("else if (role === 'advertiser') {"),
                             svc.indexOf("else if (role === 'advertiser') {") + 900);
  /* `res.condition` 이 몇 번 나오든(일정 등 파생 필드가 붙는다) **전부 showEdits 블록 안**이어야 한다.
     개수로 고정하면 필드가 늘 때마다 무관한 가드가 조용히 빨개진다. */
  const blockStart = svc.lastIndexOf('if (showEdits) {', i);
  const advStart = svc.indexOf("else if (role === 'advertiser') {");
  const all = []; for (let k = svc.indexOf('res.condition'); k >= 0; k = svc.indexOf('res.condition', k + 1)) all.push(k);
  return /if \(showEdits\) \{/.test(before) && !/res\.condition/.test(advBlock)
    && all.length > 0 && all.every(k => k > blockStart && k < advStart);
})());
t('★ 쓰기 쿼리 0 — 조건 요약은 읽기 전용', !/INSERT|UPDATE|DELETE/i.test(cond));

/* ★★ 값이 있는 최신 공고(campaignTabLateral 규율) — 차수 재발행 탭에서 **최신 공고의 빈 칸이
   옛 공고의 값을 가리면** 리뷰비 1,500원짜리 작업이 "미설정"으로, 구매확정 작업이 리뷰타입
   "—" 로 뜬다(리뷰타입에서 한 번 밟은 사고와 같은 자리). 0 은 값이다(무상 작업). */
t('★ 리뷰비·리뷰타입·입금명은 "값이 있는 최신 공고"에서 고른다', (() => {
  return /const pick = \(key\) => \{[\s\S]*?String\(v\)\.trim\(\) !== ''/.test(cond)
    && /const feeCamp = pick\('reviewFee'\)/.test(cond)
    && /const typeCamp = pick\('reviewType'\)/.test(cond)
    && /const memoCamp = pick\('transferMemo'\)/.test(cond)
    && /const campFee = num\(feeCamp && feeCamp\.reviewFee\)/.test(cond)
    /* ★ 판정은 **한 번만** 하고(rtKey) 판정값·표기값이 그것을 함께 쓴다(2026-08-23 혼합 표기 추가).
       종전엔 같은 호출이 두 곳(reviewType·reviewTypeLabel)이라 개수를 셌다 — 지금은 단일 계산이
       더 강한 보장이라 "그 계산이 typeCamp 를 보고, 두 필드가 모두 그것에서 나오는지"를 본다. */
    && (cond.match(/campaignType: typeCamp && typeCamp\.reviewType/g) || []).length === 1
    && /const rtKey = resolveReviewType\(\{ campaignType: typeCamp && typeCamp\.reviewType/.test(cond)
    && /\n      reviewType: rtKey,/.test(cond)
    && /reviewTypeLabel: rtKey \?/.test(cond)
    && /memoCamp && memoCamp\.transferMemo/.test(cond);
})());
t('★ 리뷰비 구간은 리뷰비를 준 그 공고 기준(금액과 구간이 갈리지 않게)',
  /const schedCamp = feeCamp \|\| c;/.test(cond) && /WHERE campaign_id = \$1[\s\S]{0,80}\[schedCamp\.id\]/.test(cond));
/* ★ 검사 의미 불변 — 정원은 "값이 있는 최신 공고"(pick) 폴백을 **쓰지 않고** 기준 공고 c 에서
   읽는다. 2026-08-21 부터 그 위에 **발주 정원 폴백**(공고 0 = 미설정이면 발주서 값)이 얹혔고,
   판정 규칙은 상태엔진과 같은 `displayRecruitTotal` 하나다(사본 금지). */
t('★ 정원(총건수·일건수·다계정)에는 그 폴백을 쓰지 않는다 — 카드·apply 게이트가 보는 그 공고여야 한다',
  /displayRecruitTotal\(c && c\.recruitTotal, wo && wo\.recruitCount\)/.test(cond)
  && /displayRecruitTotal\(c && c\.dailyLimit, wo && wo\.dailyCount\)/.test(cond)
  && !/displayRecruitTotal\(\s*pick\(/.test(cond)
  && /multiAccount: c \?/.test(cond));
t('★ 정원 폴백 규칙은 사본을 만들지 않는다 — linkedRecruitQuota 한 곳을 태운다',
  /require\('\.\/linkedRecruitQuota\.service'\)/.test(cond)
  && /recruitTotalSource: campQuota\.totalSource/.test(cond));

console.log('\n── B. 서버: 구매 캡처 묶음 ──');
const rv = fnBody(svc, 'async function reviewImagesForTab(');
t('④ 구매 캡처 짝짓기는 sheet_row 하나 — 오염된 링크(order_submission_id)로 붙이지 않는다',
  /FROM order_submissions/.test(rv) && /sheet_row IS NOT NULL/.test(rv)
  && !/FROM campaign_participants/.test(rv) && !/JOIN campaign_participants/.test(rv));
t('④ 삭제된 주문은 근거가 아니다', /deleted_at IS NULL/.test(rv));
t('★ 묶음 key 는 order_capture', /'order_capture'/.test(rv));
t('⑤ 상한은 묶음별로 센다(전체 개수로 자르면 나중 묶음이 통째로 잘린다)',
  /arr\.filter\(f => f\.slot === sl\)\.length >= _RV_MAX_PER_ROW/.test(svc));
t('★ fail-soft — 캡처 조회가 실패해도 리뷰 캡처는 나간다', /\.catch\(\(\) => \(\{ rows: \[\] \}\)\)/.test(rv));

console.log('\n── C. 화면: 상단 3분할 · 작업세부 폐지 · 정산 통합 ──');
t('★ 내부 렌더는 3분할(.tp3grid.c3) + 미리보기 칸 (+저장된 접힘 상태 복원)',
  /<div class="tp3grid c3\$\{_topFolded\(\)\?' fold':''\}">\$\{cond\}\$\{prog\}<aside class="rvpane" id="rvPane"><\/aside><\/div>/.test(wd));
/* ★ 정의 부재만 보면 **호출만 되살린 변이**를 놓친다(변이시험 실측) — 호출 0 까지 함께 고정. */
t('★ 작업세부 상시 펼침은 본문에서 사라졌다(정의·호출 모두)',
  !/function renderWorkOrderSection/.test(wd) && !/renderWorkOrderSection\(/.test(wd)
  && !/class="wodetail"[^`]*작업세부 펼치기/.test(wd));
t('★ 발주 전폭 띠(.wobar)를 그리지 않는다', !/<div class="wobar">/.test(wd));
t('★ 정산은 별도 칸이 아니라 진행 현황 하단 구역 — #setlCell·.setlsummary 계약 유지',
  /class="setlin\$\{STATE\.settleOpen\?' open':''\}" id="setlCell" onclick="toggleSettleDetail\(\)"/.test(wd)
  && !/tp3col setl/.test(wd)
  && /\$\('#setlCell \.setlsummary'\)/.test(wd));
t('★ 광고주 화면은 종전 4줄(.tp3kv) 그대로 — 10항목 조건표는 내부 전용', (() => {
  const m = fnBody(wd, 'function summaryStrip(wd,d,m,c){');
  return /isAdv\s*\?\s*`<div class="tp3col"><div class="tp3t">작업 조건<\/div><dl class="tp3kv">/.test(m)
    && /: _condCardHtml\(wd,d,m\)/.test(m);
})());
/* ⚠ 2026-08-19 사용자 확정: 진행 현황 폭을 작업 조건과 같게 맞추면서 2줄 배치의 근거
   (절반 폭 → 막대 26px)가 사라졌다. 게이지는 내부·광고주 **한 벌**로 되돌린다. */
t('★ 게이지는 내부·광고주 한 벌(사본 금지) — 2줄 배치 잔재 0', (() => {
  const m = fnBody(wd, 'function summaryStrip(wd,d,m,c){');
  return /const gg=g;/.test(m) && !/tp3g cmp/.test(wd) && !/\.tp3g\.cmp/.test(wd);
})());

console.log('\n── D. 화면: 작업 조건 10항목 ──');
const cc = fnBody(wd, 'function _condCardHtml(wd,d,m){');
t('_condCardHtml 이 있다', !!cc);
['총건수', '일건수', '결제금액', '구매채널', '유입방식', '다계정', '현금영수증', '리뷰비', '입금명', '리뷰타입']
  .forEach(k => t(`항목 "${k}" 이 있다`,
    new RegExp("\\['" + k + "'").test(cc) || new RegExp('<dt>' + k + '</dt>').test(cc)));
/* ★★ 값이 있으면 배지 없이 검은 글씨 · 배지는 미설정에만(사용자 확정 2026-08-20).
   종전 .yn(허용/해당없음/포토) 배지를 되살리면 "손봐야 하는 칸"으로 가야 할 눈이 흩어진다. */
t('★ 값이 있는 항목은 배지가 아니라 단순 텍스트(.yn 잔재 0)',
  !/class="yn/.test(wd) && !/\.yn\{/.test(wd)
  && !/<span class="cndbadge/.test(cc));   // 값 쪽에 배지 마크업이 다시 들어오지 않는다
t('★ [미설정]은 버튼이고 열 수 없으면 비활성 + 사유(눌러도 아무 일 없는 버튼 금지)',
  /class="cndset"[^`]*onclick="_cndFix\('\$\{kind\}'\)"/.test(cc)
  && /class="cndset off" disabled title="\$\{esc\(g\.tip\)\}"/.test(cc));
t('★ 결제금액은 1건당 금액(진행 현황의 합계와 다른 값) — 서버가 작업오더에서 싣는다',
  /payAmount: num\(wo && wo\.payAmount\)/.test(cond) && /<dt>결제금액<\/dt>/.test(cc));

/* ══ D4. 결제금액 v2 표기(사용자 확정 2026-08-20 시안 v2) ══════════════════════
   옵션 없음 = "상품결제금액 X원 / 총 Y원" 한 줄(총액 = 상품결제금액 × 총건수, 자동·비편집).
   옵션 있음 = "블랙 22,000원(500건), 그린 24,000원(300건)" 평문 + 아랫줄 총결제금액(Σ, 자동·비편집). */
console.log('\n── D4. 결제금액 v2 · 유입방식 · 일건수 공고 기준 · 접기/펼치기 ──');
t('★ 옵션 없음 = 한 줄 "상품결제금액 … / 총 …"',
  /<dt>결제금액<\/dt><dd>\$\{per\}\$\{tot\}<\/dd>/.test(cc)
  && /상품결제금액 \$\{clk\(won\(unitPay\)\)\}/.test(cc));
/* ★★★ 이 가드가 이 절의 존재 이유다 — `work_orders.pay_amount` 는 **결제합계**(문서
   prd-order-field-mapping: "일건수/모집건수/결제합계 → daily_count · recruit_count · pay_amount").
   그걸 1건당으로 읽고 총건수를 곱해 60건 작업에 93,240,000원을 찍은 사고(2026-08-21)가 있었다.
   **총액에 어떤 곱셈도 붙이지 않는다** — 되살리면 여기서 잡힌다. */
t('★★ 결제합계에 곱셈을 붙이지 않는다(payAmount × 건수 부활 금지)',
  !/payAmount\)?\s*\*/.test(cc) && !/\*\s*Number\(cd\.recruitTotal\)/.test(cc)
  && !/payTotal\s*\*/.test(cc));
t('★ 총액 = 작업오더 결제합계 그대로(계산값이 아니라고 툴팁이 말한다)',
  /const payTotal=n\(cd\.payAmount\);/.test(cc)
  && /작업오더의 결제합계입니다/.test(cc));
t('★ 1건당 금액 출처는 공유 모듈 `_woFirstProductInfo` 하나(판정 사본 0)',
  /_woFirstProductInfo\(\{product_options_json:/.test(cc)
  && /typeof _woFirstProductInfo!=='function'/.test(cc));
t('★ 단가를 못 읽으면 지어내지 않는다 — 총액÷건수 금지(차수로 총건수가 늘면 조용히 틀린다)',
  !/payAmount\s*\//.test(cc) && !/payTotal\s*\//.test(cc) && /return v>0\?v:null;/.test(cc));
t('★ 단가·총액 둘 다 없을 때만 [미설정]', /else if\(payTotal==null&&unitPay==null\)/.test(cc));
t('★ 옵션 있음 판정 = 서버 options 2종 이상(화면 재판정 0)',
  /Array\.isArray\(cd\.options\)/.test(cc) && /opts\.length>=2/.test(cc));
t('★ 옵션 있음 = 배지 없는 평문 "라벨 금액(건수)" 나열(콤마 연결)',
  /\$\{esc\(o\.label\)\} \$\{o\.pay!=null\?won\(o\.pay\)/.test(cc) && /\.join\(', '\)/.test(cc)
  && !/class="op"/.test(cc));
t('★ 옵션 총결제금액 = 작업오더 결제합계 우선, 없으면 Σ(금액×건수) 계산 + 그 사실을 툴팁으로',
  /const totHtml=payTotal!=null/.test(cc) && /opts\.every\(o=>o\.pay!=null&&o\.count>0\)/.test(cc)
  && /sm\+o\.pay\*o\.count/.test(cc)
  && /Σ\(옵션 결제금액 × 옵션 건수\)로 계산한 값입니다/.test(cc)
  && /작업오더 결제합계가 없고, 옵션별 금액·인원도 모두 있어야 계산할 수 있습니다/.test(cc));
t('★ 옵션 총결제금액 dd 에는 클릭 창구가 없다(자동계산 = 편집 대상 아님)', (() => {
  const i = cc.indexOf('<dt>총결제금액</dt>'); if (i < 0) return false;
  const seg = cc.slice(i, cc.indexOf('</dd>', i));
  return !/onclick/.test(seg) && !/_cndFix/.test(seg);
})());
t('★ 옵션 줄의 편집 창구는 공고 있으면 공고, 없으면 작업오더',
  /const kp=cd\.campaignId\?'camp':'order';/.test(cc));

// 서버: options 동봉 규칙
t('★ 서버 options = 살아있는 공고 옵션 우선(status <> \'closed\') → 작업오더 구조화 폴백 → 2종 미만은 빈 배열',
  /FROM campaign_options WHERE campaign_id = \$1 AND status <> 'closed'/.test(cond)
  && /if \(options\.length < 2 && wo\) options = _condWoOptions\(wo\.productOptionsJson\);/.test(cond)
  && /if \(options\.length < 2\) options = \[\];/.test(cond));
t('★ _condWoOptions 는 구조화 옵션만(라벨 필수 · 0 보존) — 이름뿐인 레거시는 제외', (() => {
  const b = fnBody(svc, 'function _condWoOptions(json) {');
  return !!b && /Array\.isArray\(p\.options\)/.test(b) && /if \(!label\) continue;/.test(b)
    && /x == null \|\| x === ''/.test(b);
})());

// 유입방식: 링크유입/가이드유입 둘 중 하나로만
t('★ 유입방식은 링크유입/가이드유입 둘 중 하나로만 — 키워드 병기 제거',
  /return '링크유입';/.test(cc) && /return '가이드유입';/.test(cc)
  && !/inflowKeyword/.test(cc));
t('★ 모르는 유입값은 강제 분류하지 않고 원문(오표기 금지)', /return t;\s*\}\)\(cd\.inflowType\);/.test(cc));

// 일건수 = 공고 기준(todayProgress.quota — 정원 판정 단일 출처의 값)
t('★ 일건수 = wd.todayProgress.quota(공고 기준 칩) — 재계산 사본 0, 못 받으면 종전 폴백',
  /wd\.todayProgress\.quota!=null\)/.test(cc) && /공고 기준<\/span>/.test(cc)
  && /n\(cd\.dailyLimit\)==null\?null/.test(cc));
t('★ 상품명 앞 [상품/옵션/금액] 라벨 제거(표시만 — 원본 무접촉)',
  /replace\(\/\^\\s\*\\\[상품\\\/옵션\\\/금액\\\]\\s\*\/,''\)/.test(cc));

// 접기/펼치기 — 세 박스 일괄 + 하단선 일치
t('★ 머리줄 3곳(작업조건 정상·폴백 / 진행현황 / 미리보기) 전부 _topToggle 로 수렴', (() => {
  const n = (wd.match(/onclick="_topToggle\(\)"/g) || []).length;
  return n === 4;   // 작업조건 2(정상+폴백) + 진행현황 1 + 미리보기(rvhd) 1
})());
/* ★★ 업체 뷰어도 같은 3분할·같은 접기(사용자 확정 2026-08-23) — 종전의 "광고주는 접기 없음"
   규칙은 폐기됐다. 다른 것은 작업 조건 카드의 **내용**(업체 4줄)과 정산 자리뿐이다. */
t('★ 진행 현황 머리줄은 내부·업체 한 벌(역할 분기 잔재 0)',
  /<div class="tp3t tp3h" onclick="_topToggle\(\)"[^>]*>진행 현황<span class="tp3hint">/.test(wd)
  && !/isAdv\?'':' tp3h"/.test(wd));
t('★ 업체 뷰어도 같은 3분할을 반환한다(전용 래퍼 advcondition/advprogress 폐기)',
  !/class="advcondition"/.test(wd) && !/class="advprogress"/.test(wd)
  && !/if\(isAdv\) return `<div class="advcondition"/.test(wd));
t('★ 접힘 상태는 localStorage 로 기억(작업 무관 공통) — 실패해도 무시',
  /localStorage\.getItem\('wd_top3_fold'\)/.test(wd) && /localStorage\.setItem\('wd_top3_fold','1'\)/.test(wd));
t('★ 토글은 CSS 클래스만 — 재렌더하지 않는다(미리보기 선택·스크롤 보존)', (() => {
  const b = fnBody(wd, 'function _topToggle(){');
  return !!b && /classList\.toggle\('fold',v\)/.test(b) && !/selTab|buildGrid|summaryStrip/.test(b);
})());
t('★ 접힘 CSS 한 벌: min-height 해제 + 본문 숨김 + rvfill static(하단선 일치)',
  /\.tp3grid\.c3\.fold \.tp3col,\.tp3grid\.c3\.fold \.rvpane\{min-height:0\}/.test(wd)
  && /\.tp3grid\.c3\.fold \.tp3col > :not\(\.tp3t\)\{display:none\}/.test(wd)
  && /\.tp3grid\.c3\.fold \.rvpane \.rvfill\{position:static/.test(wd)
  && /\.tp3grid\.c3\.fold \.rvfill > :not\(\.rvhd\)\{display:none\}/.test(wd));
t('★ 시각 신호: ∨ 회전 + 호버 배경 + 접기/펼치기 힌트',
  /\.tp3grid\.c3\.fold \.tp3chev\{transform:rotate\(-90deg\)\}/.test(wd)
  && /\.tp3h:hover\{background/.test(wd) && /tp3hint">접기\/펼치기</.test(wd));

console.log('\n── D2. [미설정] → 정식 창구 ──');
/* ★★ 새 저장 경로를 만들지 않는다(사용자 확정) — 저장처가 둘이 되면 작업오더·모집공고·입금관리가
   서로 다른 값을 보게 된다. 창구가 하나뿐이라 동기화가 구조적으로 보장된다. */
const gate = fnBody(wd, 'function _cndFixGate(cd,kind){');
const fix  = fnBody(wd, 'async function _cndFix(kind){');
const orderM = fnBody(wd, 'async function _cndOrderModal(cd){');
t('★ 정원(총건수·일건수)은 공고가 있으면 [📅 모집인원 조절] 창구로 — 차수·이월·날짜별 조절을 아는 유일한 곳',
  /if\(cd\.campaignId\) return openCurrentCampaignDailyPlan\(\);/.test(fix));
t('★ 공고 값은 모집공고 수정 모달로', /openRecruitModal\(String\(cd\.campaignId\)\)/.test(fix));
t('★ 작업오더 값은 작업오더 수정 모달로 + 저장 경로는 기존 편집 허용명단 게이트',
  /woAdminEditModal\(o,\{/.test(orderM) && /'\/api\/trackb\/work-orders\/edit'/.test(orderM));
/* ★ 문자열 존재만 보면 **호출을 죽인 변이**(const r=null)를 놓친다(실측) — 호출 형태를 고정한다. */
t('★ 모달에는 작업오더 **원본 행**을 넘긴다(작업보드 detail 은 camelCase 라 폼이 빈다)',
  /const r=await api\(`\/api\/trackb\/work-orders\?sheetId=/.test(orderM)
  && /const o=\(\(r&&r\.items\)\|\|\[\]\)\.find\(x=>String\(x\.id\)===String\(cd\.workOrderId\)\)/.test(orderM)
  && /woAdminEditModal\(o,/.test(orderM));
t('★ 이 화면에 새 저장 API 를 만들지 않았다(condition 전용 저장 경로 0)',
  !/condition\/save|\/api\/trackb\/condition/.test(wd));
t('★ 권한 없으면 비활성 + 발주 없는 order 는 비활성(사유)',
  /if\(!STATE\.canEdit\) return \{can:false/.test(gate)
  && /kind==='order'\) return cd\.workOrderId/.test(gate));

console.log('\n── D2b. 공고 없는 작업 — 막다른 길 제거(사용자 확정 2026-08-20) ──');
/* ★★ "동기화"를 코드로 잇지 않는다 — 판정 순서가 전부 공고 → 탭이라(리뷰비 resolveReviewFee
   128 · 입금명 campMemo→tabMemo · 리뷰타입 resolveReviewType), 탭에 넣은 값은 공고를 발행하는
   순간 자동으로 공고 값에 밀린다. 복사·동기화 코드를 두면 그 코드가 두 번째 진실이 된다. */
t('★ 리뷰비·입금명 — 공고 없으면 기존 입금관리 보완 API(transfer-setting)로 탭 저장',
  /if\(\(kind==='fee'\|\|kind==='memo'\)&&!cd\.campaignId\) return _cndTabValueModal\(kind,cd\);/.test(fix)
  && /'\/api\/trackb\/payment\/transfer-setting'/.test(fnBody(wd,'function _cndTabValueModal(kind,cd){')));
t('★ 리뷰비·입금명의 탭 저장은 admin/master 만(transfer-setting 이 adminOrMaster) — AE 는 사유',
  /kind==='fee'\|\|kind==='memo'/.test(gate) && /isAdmin\s*\n?\s*\?\s*\{can:true/.test(gate.replace(/\n/g,' ')) || (() => {
    return /return isAdmin/.test(gate) && /관리자만/.test(gate);
  })());
t('★ 리뷰타입 — 공고 없으면 탭 설정(POST /api/tab/config 프록시)에 저장', (() => {
  const m = fnBody(wd, 'function _cndRtypeModal(cd){');
  return /if\(kind==='rtype'&&!cd\.campaignId\) return _cndRtypeModal\(cd\);/.test(fix)
    && /'\/api\/trackb\/tab\/config'/.test(m) && /reviewType:sel\.dataset\.v/.test(m);
})());
t('★ 리뷰타입 선택지는 공유 표 RF_REVIEW_TYPE_LABELS — 사본 금지 · 혼합은 탭 창구에서 제외', (() => {
  const m = fnBody(wd, 'function _cndRtypeModal(cd){');
  return /RF_REVIEW_TYPE_LABELS\.filter\(\(\[k\]\)=>k!=='mixed'\)/.test(m)
    && !/\['photo',\s*'포토'\]/.test(wd);   // workdesk 에 라벨 표 사본을 새로 적지 않는다
})());
t('★ 구매채널·다계정 — 공고 없으면 발행 모달(탭·작업오더 프리필)로 유도', (() => {
  const m = fnBody(wd, 'async function _cndPublish(cd){');
  return /if\(!cd\.campaignId\) return _cndPublish\(cd\);/.test(fix)
    && /openRecruitModal\(null,_woCampaignPrefill\(o\),o\.id\)/.test(m)
    && /openRecruitModal\(null,\{linked_sheet_id:t\.sheetId,linked_tab_name:t\.tabName/.test(m)
    && /_loadCampPerm\(\)/.test(m);   // 발행 권한(편집 허용명단) 확인 — 눌러도 아무 일 없는 버튼 금지
})());
t('★ 정원 — 공고 없고 발주 있으면 작업오더 수정(발행 프리필의 원천), 둘 다 없으면 발행으로',
  /if\(cd\.workOrderId\) return _cndOrderModal\(cd\);/.test(fix)
  && /return _cndPublish\(cd\);\s*\/\/ 발주도 없으면/.test(fix.replace(/\u0020{2,}/g,' ')) || (() => {
    const i=fix.indexOf("if(kind==='quota'){"); const blk=fix.slice(i, fix.indexOf('}', i)+1);
    return /_cndOrderModal\(cd\)/.test(blk) && /_cndPublish\(cd\)/.test(blk);
  })());
t('★ 미니 팝업은 body 직속 · Esc 리스너는 닫을 때 해제 · 저장 실패는 팝업 유지', (() => {
  const m = fnBody(wd, 'function _cndMini({title,body,onSave}){');
  return /document\.body\.appendChild\(ov\)/.test(m)
    && /removeEventListener\('keydown',STATE\._cndMiniEsc\)/.test(wd)
    && /const ok=await onSave\(\);\s*\n?\s*if\(ok\)\{/.test(m);
})());
t('★★ 입금명 순서 = 공고 → 탭(입금관리 campMemo→tabMemo 와 같은 순서 — 공고를 만들면 공고가 이긴다)',
  /depositName: \(\(memoCamp && memoCamp\.transferMemo\) \|\| meta\.depositName \|\| ''\) \|\| null,/.test(cond));
/* ★ 값이 있어도 고칠 수 있어야 쓸모가 있다 — 모양은 검은 글씨 그대로(요구 ②),
   창구가 열리는 항목만 눌린다. 창구가 없으면 평범한 텍스트(죽은 버튼 금지). */
/* ★ 존재 검사만 하면 **함수 첫 줄에 early return 을 넣은 변이**를 놓친다(실측) —
   게이트 호출이 곧바로 오는지(= 판정을 실제로 거치는지) 형태로 고정한다. */
t('★ 값이 있는 항목도 창구가 있으면 누를 수 있다(모양은 검은 글씨 그대로)',
  /const val=\(html,kind\)=>\{\s*\n?\s*const g=_cndFixGate\(cd,kind\);/.test(cc)
  && /class="cndval"[^`]*onclick="_cndFix\('\$\{kind\}'\)"/.test(cc)
  && /: `<dd>\$\{html\}<\/dd>`/.test(cc)
  && /\.cndval\{[^}]*color:var\(--ink\)/.test(wd));

console.log('\n── D3. 현금영수증 설정(진행방식) ──');
const cash = fnBody(wd, 'function _cndCashModal(){');
t('★ 현금영수증도 이 화면에서 설정한다(tab 게이트가 열려 있다)',
  /kind==='tab'\) return \{can:true/.test(gate) && /if\(kind==='tab'\) return _cndCashModal\(\);/.test(fix));
t('★★ 저장은 기존 창구 하나(POST /api/tab/config {incomeType}) — 새 저장 경로 0',
  /'\/api\/trackb\/tab\/config'/.test(wd) && /incomeType:v/.test(wd)
  && !/income_type\s*=/.test(wd));
t('★ 진행방식 문자열을 화면이 대신 지어내지 않는다 — 사람이 보고 고친다', (() => {
  // 체크박스로 '현영'을 붙였다 뗐다 하면 '사업자현영' 같은 값이 망가진다(시스템이 못 하는 판단).
  return /<input id="cndIncome"/.test(cash) && /oninput="_cndCashPreview\(\)"/.test(cash);
})());
t('★ 지금 값이면 결과가 어떻게 되는지 실시간으로 말한다(판정 규칙 = 진행방식에 현영)',
  /const _CR_RE=\/현영\//.test(wd) && /_CR_RE\.test\(el\.value\|\|''\)/.test(wd));
t('★★ 캡처 칸이 직접 설정된 탭이면 "바꿔도 안 바뀐다"고 먼저 말한다(고쳤는데 그대로 방지)',
  /cd\.slotsPinned\?`<div class="cndwarnbox">/.test(cash)
  && /slotsPinned: Array\.isArray\(meta\.captureSlots\)/.test(cond));
t('★ 이 API 는 오류도 200 + {error} 로 온다 — 상태코드만 보고 성공으로 읽지 않는다',
  /if\(!r\|\|r\.error\)\{ _toast\('저장하지 못했습니다'/.test(wd));
t('★ 팝업은 body 직속 · 바깥 클릭으로 닫지 않는다(입력값 보호) · Esc 리스너는 닫을 때 해제',
  /document\.body\.appendChild\(ov\)/.test(cash) && !/ov\.onclick=/.test(cash)
  && /removeEventListener\('keydown',STATE\._cndCashEsc\)/.test(wd));
t('★ 저장 뒤 작업 조건을 다시 읽는다', /_cndCashClose\(\); _toast\('🧾 진행방식 저장됨'\); _cndReload\(\);/.test(wd));
t('★ 저장 뒤 작업 조건을 다시 읽는다 — 공고 저장 훅(CAMP_ON_SAVED)에도 합류(사본 금지)',
  /function _cndReload\(\)\{[\s\S]*?selTab\(i,\{nav:true\}\)/.test(wd)
  && /typeof _cndReload==='function'\) _cndReload\(\)/.test(wd)
  && (wd.match(/function _cndReload\(/g) || []).length === 1);
t('상품명은 별도 줄(2줄 허용)', /class="cndprod"/.test(cc));
t('① 값은 서버 condition 을 그리기만 한다 — 화면에서 리뷰비·현영·리뷰타입을 다시 판정하지 않는다',
  !/campaign_fee|hasCashReceiptSlot|resolveReviewType/.test(cc));
t('★ 구매채널만 예외 — 판정 단일 출처인 공유 모듈 _woChannelFromUrl 을 부른다',
  /typeof _woChannelFromUrl==='function'/.test(cc));
t('③ 리뷰비 0원을 미설정으로 말하지 않는다(근거 feeSource 로 가른다)',
  /cd\.feeSource\s*\?/.test(cc) && /미설정/.test(cc));
t('★ 서버가 못 주면 종전 4줄로 떨어지고 사유를 말한다(빈 값 위장 금지)',
  /if\(!cd\)\{/.test(cc) && /요약 없음/.test(cc));
/* ★ 2026-08-23: 혼합 표기가 붙으면서 렌더가 헬퍼(_cndRtypeHtml)로 빠졌다 — 검사 의미는 불변
   (라벨·조합 모두 서버가 준 값을 그리기만 하고, 화면에 리뷰타입 표 사본을 두지 않는다). */
const rth = fnBody(wd, 'function _cndRtypeHtml(cd){');
t('★ 리뷰타입 라벨은 서버가 준 값(프론트에 표 사본 금지)',
  /_cndRtypeHtml\(cd\)/.test(cc) && /cd\.reviewTypeLabel/.test(rth)
  && !/RF_REVIEW_TYPE_LABELS/.test(rth) && !/RF_REVIEW_TYPE_LABELS/.test(cc));

console.log('\n── E. 화면: 발주 줄 + 원문 팝업 ──');
const lk = fnBody(wd, 'function _woLinkedRow(wd){');
t('발주 줄이 카드 맨 아래 한 줄(.tp3wo.lk)', /class="tp3wo lk"/.test(lk));
/* ★★ 발주 줄의 조작은 **[원문] 하나**(사용자 확정 2026-08-23). 셋을 없앤 이유:
   · 명단 준비 = `prepareRosterSlots` 가 seq 900000 대역 + source='manual' + row_json 없이 넣어
     장부에서 제외되고 상태가 얼어붙는다(접수의 `createWorktableSlots` 가 이미 정확한 줄을 깐다).
   · 연결 해제 = Track B 링크만 지우는데 접수된 작업은 `work_orders.linked_tab_*` 폴백이 살아 있어
     **아무 일도 안 일어나고 "해제됨"이라고 말한다** — 진짜 해제는 홈 [작업 삭제].
   · 발주 변경 = 이 화면의 연결만 바꾸는 반쪽(작업오더 표시·작업표 줄·정원은 안 따라온다).
   되붙이면 그 사고가 그대로 재현되므로 **부재를 고정한다**(서버 라우트는 그대로 살아 있다). */
t('★ 발주 줄 조작은 [원문] 하나 — 항목이 하나면 [⋯] 껍데기를 두지 않는다',
  /openWoRawModal\(\)/.test(lk) && !/class="womenu"/.test(lk)
  && (lk.match(/<button/g) || []).length === 1);
t('★ 명단 준비·연결 해제·발주 변경은 화면에서 제거됐다(되붙이면 위 사고 재현)',
  !/onclick="prepareRoster/.test(wd) && !/onclick="unlinkWO/.test(wd)
  && !/>명단 준비/.test(wd) && !/>연결 해제/.test(wd) && !/>발주 변경/.test(wd)
  && !/function prepareRoster\(/.test(wd) && !/function unlinkWO\(/.test(wd)
  && !/function toggleWoRowMenu\(/.test(wd) && !/_woRowMenuBound/.test(wd)
  && !/\.womenu|\.womm/.test(wd));
t('★ openWorkOrderPicker 는 남는다 — 미연결 줄 [＋ 발주 연결]이 쓴다',
  /openWorkOrderPicker\(\)/.test(fnBody(wd, 'function _woUnlinkedRow(wd){'))
  && /async function openWorkOrderPicker\(\)/.test(wd));
t('★ 미연결 줄 안내가 사라진 기능을 시키지 않는다(명단 준비 문구 0)',
  !/명단을 준비할 수 있습니다/.test(wd));

/* ★★ 메인URL(사용자 확정 2026-08-23) — 일정 **위** 첫 줄. 아픈 자리 둘:
   ① `val()` 로 감싸면 <button> 안에 <a> 가 들어가 **링크 클릭이 수정 모달까지 연다**.
   ② 링크 조립을 손으로 하면 http(s) 스킴 검사가 사본이 되어 `javascript:` 가 새어든다. */
t('★ 메인URL 행이 일정 위 첫 줄이다', (() => {
  const m = fnBody(wd, 'function _condCardHtml(');
  return m.indexOf("['@murl'") > 0 && m.indexOf("['@murl'") < m.indexOf("['@sched'")
    && /k==='@murl'\?murlRow/.test(m);
})());
t('② 링크 렌더는 공유 모듈 _woLinkHtml 단일 출처(<a> 손조립 금지)', (() => {
  const m = fnBody(wd, 'function _condCardHtml(');
  const i = m.indexOf('const murlRow='), j = m.indexOf('const schedRow=', i);
  const blk = m.slice(i, j);
  return /_woLinkHtml\(/.test(blk) && !/<a\s/.test(blk);
})());
t('① 값이 있으면 val() 로 감싸지 않는다(링크 클릭이 수정 모달까지 열리지 않게)', (() => {
  const m = fnBody(wd, 'function _condCardHtml(');
  const i = m.indexOf('const murlRow='), j = m.indexOf('const schedRow=', i);
  const blk = m.slice(i, j);
  return !/val\(/.test(blk) && /unset\('order'\)/.test(blk);   // 미설정은 작업오더 수정 창구로
})());
t('★ _woLinkHtml 은 http(s) 만 링크화하고 escape·noopener 를 건다', (() => {
  const wod = F('js/work-order-detail.js');
  const m = fnBody(wod, 'function _woLinkHtml(url) {');
  return /\^https\?:\\\/\\\//.test(m) && /escHtml\(u\)/.test(m) && /rel="noopener/.test(m);
})());
t('★ 발주 원문 팝업이 종전 「작업세부」와 같은 값을 그린다(렌더러 이동)', (() => {
  const raw = fnBody(wd, 'function _woRawRowsHtml(d){');
  return /\['유입가이드',d\.inflowGuide\]/.test(raw) && /\['리뷰가이드',d\.reviewGuide\]/.test(raw)
    && /\['특이사항',d\.specialNotes\]/.test(raw)
    && /STATE\.role!=='advertiser'\?\[\['담당',d\.managerName\]\]/.test(raw);   // 담당자 실명은 내부만
})());

console.log('\n── F. 화면: 제출물 미리보기(좌 구매캡처 / 우 리뷰캡처) ──');
const r2 = fnBody(wd, 'function _rvRender2(pane){');
t('_rvRender2 가 있다', !!r2);
t('★ 두 칸 — 좌 구매 캡처 / 우 리뷰 캡처', /col\('cap'[\s\S]*col\('rev'/.test(r2));
t('★ 칸마다 한 장(.rvone)', /class="rvone"/.test(r2));
t('⑥ 넘김 줄은 1장일 때도 자리를 비워 둔다(visibility) — 없애면 두 칸 높이가 어긋난다',
  /n>1\?'':' style="visibility:hidden"'/.test(r2));
t('★ 끝에서 순환하지 않는다', /Math\.max\(0,Math\.min\(n-1,/.test(fnBody(wd, 'function _rvStep(kind,delta,n){')));
/* ★★ 칸 머리(🛒 구매 캡처 · 배지)는 그리지 않는다(사용자 확정 2026-08-23) — 그 한 줄을 비운
   만큼 캡처가 커진다. 장수는 **넘김 줄이 `i+1 / n` 으로** 말하고(2장 이상), 0장은 빈 상태
   문구가 말한다. 1장은 이미지 자체가 곧 답이라 조용한 누락이 아니다. */
t('★ 칸 머리 배지는 없다 — 장수는 넘김 줄과 빈 상태 문구가 말한다',
  !/class="cnt">/.test(r2) && !/rv2h/.test(r2)
  && /\$\{i\+1\} \/ \$\{n\}/.test(r2) && /캡처 없음|미등록/.test(r2));
t('★ "미제출"과 "이미지 미등록"을 구분해 말한다',
  /미제출/.test(r2) && /미등록/.test(r2) && /r\.submitted\?/.test(r2));
t('★ 행이 바뀌면 장 인덱스를 0으로 되돌린다 — 남의 2장째가 그대로 보이면 안 된다',
  /if\(String\(rid\)!==String\(STATE\.rvSel\)\) STATE\.rvIdx=\{\};/.test(wd));
t('★ 이미지 URL 은 신뢰 베이스 재구성(_rvUrl) — 파일ID 형식 검증 뒤에만',
  /function _rvUrl\(id\)\{ return \/\^\[-\\w\]\{20,\}\$\/\.test/.test(wd));
t('★ 미리보기 부팅·바인딩 판정은 "패널이 그려졌나" 하나(역할 문자열로 다시 나누지 않는다)',
  /if\(document\.getElementById\('rvPane'\)\) _rvBoot\(STATE\.cur\);/.test(wd)
  && !/STATE\.role!=='advertiser' \|\| !document\.getElementById\('rvPane'\)/.test(wd));
t('⑦ 셀 범위를 잡고 있으면 방향키는 셀 이동이 우선 — 미리보기가 가로채지 않는다',
  /if\(STATE\.gSelRange\) return;/.test(fnBody(wd, 'function _rvBind(){')));

console.log('\n── F2. 제목 행 정렬 ──');
/* ★ 남는 폭은 오른쪽(사용자 확정 2026-08-19) — 스페이서가 제목 뒤에 있으면 링크복사·모집인원조절·
   마감 안내·[마감]이 창 오른쪽 끝으로 밀려 제목과 멀어진다. 맨 뒤로 옮겨 전부 왼쪽에 붙인다. */
t('★ 제목 행 스페이서(.sp)는 버튼 묶음 뒤 — 맨 마지막에 한 번만', (() => {
  const mh = wd.slice(wd.indexOf('<div class="mh mh-wb">'), wd.indexOf('_scheduleBodyFlush();'));
  const sp = (mh.match(/<span class="sp" style="flex:1"><\/span>/g) || []).length;
  return sp === 1 && /<span class="sp" style="flex:1"><\/span><\/div>/.test(mh)
    && mh.indexOf('${shareBtn}') < mh.indexOf('<span class="sp"');
})());

console.log('\n── G. CSS 계약 ──');
t('★ 3분할 폭 = 439 / 439 / 659 비율 — 앞 두 칸은 같은 너비(고정 px 금지)',
  /\.tp3grid\.c3\{grid-template-columns:minmax\(230px,439fr\) minmax\(230px,439fr\) minmax\(330px,659fr\)/.test(wd));
t('★ 높이는 px 로 못박지 않는다 — min-height + stretch(내용이 넘치면 발주 줄이 겹친다)',
  /\.tp3grid\.c3 \.tp3col,\.tp3grid\.c3 \.rvpane\{min-height:330px\}/.test(wd)
  && !/\.tp3grid\.c3 \.tp3col\{height:330px\}/.test(wd));
t('★ 좁은 화면에서 세로로 접힌다', /@media\(max-width:1100px\)\{\.tp3grid\.c3\{grid-template-columns:1fr\}/.test(wd));
t('★ 미리보기 두 칸은 1fr 1fr', /\.rv2\{[^}]*grid-template-columns:1fr 1fr/.test(wd));
/* ★★ 캡처가 칸 높이를 밀어 올리지 않는다(실사용 신고 2026-08-19 · 모바일 전체 스크린샷 390×3200).
   내용을 절대배치 레이어로 빼야 grid 행 높이를 왼쪽 두 카드가 정한다 — 이게 없으면
   상단 카드가 화면 밖까지 늘어난다. 세로는 칸 안에서 스크롤(contain 으로 욱여넣으면 판독 불가). */
t('★ 미리보기 내용은 절대배치 레이어(.rvfill) 안에서만 흐른다',
  /\.tp3grid\.c3 \.rvpane\{position:relative;overflow:hidden;padding:0\}/.test(wd)
  && /\.tp3grid\.c3 \.rvpane \.rvfill\{position:absolute;inset:0/.test(wd));
t('★ 내부 미리보기 렌더는 반드시 _rvFill 을 거친다(한 갈래라도 새면 그 상태에서 높이가 튄다)', (() => {
  const m = fnBody(wd, 'function _rvRender2(pane){');
  return !!m && !/pane\.innerHTML=/.test(m) && (m.match(/_rvFill\(pane,/g) || []).length >= 4;
})());
t('★ 캡처는 폭에 맞춰 축소하고 세로는 칸 안에서 스크롤(contain 으로 욱여넣지 않는다)',
  /\.rv2 \.rvhold\{flex:1;min-height:0;[^}]*overflow-y:auto/.test(wd)
  && /\.rv2 \.rvone\{width:100%;height:auto;display:block\}/.test(wd));
/* ★★ 미리보기 렌더러는 **한 벌**(사용자 확정 2026-08-23) — `_rvRender` 는 이제 위임만 한다.
   종전에는 업체 뷰어가 세로 레일(pane.innerHTML 직접 조립)을 따로 그려 두 화면이 갈렸다.
   ★ 절대배치 래퍼(`_rvFill`)를 거쳐야 캡처 높이가 상단 카드를 밀어내지 않는다. */
t('★ 미리보기 렌더러 한 벌 — _rvRender 는 _rvRender2 위임만(세로 레일 조립 잔재 0)', (() => {
  const m = fnBody(wd, 'function _rvRender(){');
  return !!m && /return _rvRender2\(pane\);/.test(m) && !/pane\.innerHTML=/.test(m)
    && !/rvmedia|rvasset|_RV_SLOT/.test(wd);
})());

console.log('\n── I. 「일정」 행(사용자 확정 2026-08-23) ──');
/* 「일정」 = 표의 구매일자 중 **가장 이른 날 ~ 가장 늦은 날**. 아픈 자리 셋:
   ① `fallbackAnchor` 를 빼면 `8 / 15 (토)`(연도 없음)가 전 행 null 이 되어 조용히 「—」가 된다.
   ② 날짜 칸 찾기·해석을 여기서 다시 만들면 모집인원조절·정원 판정과 기준이 갈린다.
   ③ 못 읽었을 때 오늘로 지어내면 있지도 않은 일정이 사실처럼 보인다(사용자 확정: 비면 「—」). */
const schedSrc = fnBody(svc, 'function _condSchedule(');
t('서버에 _condSchedule 이 있다', !!schedSrc);
t('② 날짜 칸은 campaignSchedule.findDateColumnIndex 단일 출처',
  /require\('\.\/campaignSchedule\.service'\)/.test(schedSrc) && /findDateColumnIndex\(/.test(schedSrc));
t('② 해석은 utils/koreanDate.parseDateColumn 단일 출처',
  /require\('\.\.\/utils\/koreanDate'\)/.test(schedSrc) && /parseDateColumn\(/.test(schedSrc));
t('① fallbackAnchor 를 넘긴다(연도 없는 표기 보호)', /fallbackAnchor:/.test(schedSrc));
t('★ 표(정렬된 out)에서 파생한다 — 계획표를 따로 읽지 않는다',
  /res\.condition\.schedule = _condSchedule\(out, headers\)/.test(svc)
  && !/campaign_daily_plans/.test(schedSrc));

{ // vm 실행 — 실제 모듈을 태워 결과를 대조한다(정적 검사로는 ①③을 못 잡는다)
  const vm = require('vm');
  const map = { './campaignSchedule.service': '../src/services/campaignSchedule.service',
                '../utils/koreanDate': '../src/utils/koreanDate' };
  const sandbox = { require: (m) => { if (!map[m]) throw new Error('예상 밖 require: ' + m); return require(map[m]); }, module: {}, Date };
  vm.createContext(sandbox);
  vm.runInContext(schedSrc + '\n;this.__f=_condSchedule;', sandbox);
  const f = sandbox.__f;
  const H = ['번호', '구매일자', '수취인'];
  const rows = iso => iso.map(v => ({ rowJson: { '번호': 1, '구매일자': v, '수취인': 'ㅇ' } }));
  const r1 = f(rows(['9 / 11 (금)', '8 / 11 (화)', '8 / 20 (목)']), H);
  t('① 연도 없는 표기도 읽는다 — 가장 이른 날 ~ 가장 늦은 날',
    !!r1 && /^\d{4}-08-11$/.test(r1.start) && /^\d{4}-09-11$/.test(r1.end), JSON.stringify(r1));
  t('③ 날짜 칸이 없으면 null(지어내지 않는다)',
    f([{ rowJson: { '번호': 1, '수취인': 'ㅇ' } }], ['번호', '수취인']) === null);
  t('③ 날짜 칸은 있는데 값이 전부 비면 null',
    f(rows(['', '', '']), H) === null);
  t('★ 빈 표·잘못된 입력은 null(throw 하지 않는다)',
    f([], H) === null && f(null, null) === null);
  t('★ 한 줄뿐이면 시작 = 종료', (() => { const r = f(rows(['2026-08-11']), H); return r && r.start === '2026-08-11' && r.end === '2026-08-11'; })());
}

t('★ 화면은 서버 값을 그리기만 한다 — 총건수 위에 일정 행', (() => {
  const m = fnBody(wd, 'function _condCardHtml(');
  return /const schedRow=/.test(m) && /cd\.schedule/.test(m)
    && m.indexOf("['@sched'") > 0 && m.indexOf("['@sched'") < m.indexOf("['총건수'")
    && /k==='@sched'\?schedRow/.test(m)
    && !/findDateColumnIndex|parseDateColumn/.test(m);
})());
t('③ 값이 없으면 [미설정] 버튼이 아니라 「—」(고칠 창구가 없는 죽은 버튼 금지)', (() => {
  const m = fnBody(wd, 'function _condCardHtml(');
  const i = m.indexOf('const schedRow='), j = m.indexOf('const rows=[', i);
  const blk = m.slice(i, j);
  return /cnna/.test(blk) && !/unset\(/.test(blk);
})());

console.log('\n── H. 시안 문서 ──');
t('시안 문서에 C안이 있다', /id="secC"/.test(doc) && /\?v=C/.test(doc));

console.log(`\n✅ workboardTopC: ${pass} cases passed`);
process.exit(0);
