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
  const i = svc.indexOf('res.condition = await tabConditionSummary');
  if (i < 0) return false;
  const before = svc.slice(Math.max(0, i - 700), i);
  // 광고주 분기(else if) 블록 안에 condition 이 들어가지 않는다 — 전역 [\s\S]* 로 보면
  // 파일 앞쪽의 무관한 `role === 'advertiser'` 가 걸려 항상 참이 된다(약한 단언 금지).
  const advBlock = svc.slice(svc.indexOf("else if (role === 'advertiser') {"),
                             svc.indexOf("else if (role === 'advertiser') {") + 900);
  return /if \(showEdits\) \{/.test(before) && !/res\.condition/.test(advBlock)
    && (svc.match(/res\.condition/g) || []).length === 1;
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
    // ★ 개수를 센다 — reviewType·reviewTypeLabel 두 곳이라 존재만 보면 한 곳만 되돌린 변이를 놓친다(실측)
    && (cond.match(/campaignType: typeCamp && typeCamp\.reviewType/g) || []).length === 2
    && /memoCamp && memoCamp\.transferMemo/.test(cond);
})());
t('★ 리뷰비 구간은 리뷰비를 준 그 공고 기준(금액과 구간이 갈리지 않게)',
  /const schedCamp = feeCamp \|\| c;/.test(cond) && /WHERE campaign_id = \$1[\s\S]{0,80}\[schedCamp\.id\]/.test(cond));
t('★ 정원(총건수·일건수·다계정)에는 그 폴백을 쓰지 않는다 — 카드·apply 게이트가 보는 그 공고여야 한다',
  /recruitTotal: num\(c && c\.recruitTotal\)/.test(cond)
  && /dailyLimit:   num\(c && c\.dailyLimit\)/.test(cond)
  && /multiAccount: c \?/.test(cond));

console.log('\n── B. 서버: 구매 캡처 묶음 ──');
const rv = fnBody(svc, 'async function reviewImagesForTab(');
t('④ 구매 캡처 짝짓기는 sheet_row 하나 — 오염된 링크(order_submission_id)로 붙이지 않는다',
  /FROM order_submissions/.test(rv) && /sheet_row IS NOT NULL/.test(rv)
  && !/FROM campaign_participants/.test(rv) && !/JOIN campaign_participants/.test(rv));
t('④ 삭제된 주문은 근거가 아니다', /deleted_at IS NULL/.test(rv));
t('★ 묶음 key 는 order_capture', /'order_capture'/.test(rv));
t('⑤ 상한은 묶음별로 센다(전체 개수로 자르면 나중 묶음이 통째로 잘린다)',
  /arr\.filter\(f => f\.slot === sl\)\.length >= _RV_MAX_PER_ROW/.test(svc));
t('★ fail-soft — 캡처 조회가 실패해도 리뷰 이미지는 나간다', /\.catch\(\(\) => \(\{ rows: \[\] \}\)\)/.test(rv));

console.log('\n── C. 화면: 상단 3분할 · 작업세부 폐지 · 정산 통합 ──');
t('★ 내부 렌더는 3분할(.tp3grid.c3) + 미리보기 칸',
  /<div class="tp3grid c3">\$\{cond\}\$\{prog\}<aside class="rvpane" id="rvPane"><\/aside><\/div>/.test(wd));
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
  .forEach(k => t(`항목 "${k}" 이 있다`, new RegExp("\\['" + k + "'").test(cc)));
/* ★★ 값이 있으면 배지 없이 검은 글씨 · 배지는 미설정에만(사용자 확정 2026-08-20).
   종전 .yn(허용/해당없음/포토) 배지를 되살리면 "손봐야 하는 칸"으로 가야 할 눈이 흩어진다. */
t('★ 값이 있는 항목은 배지가 아니라 단순 텍스트(.yn 잔재 0)',
  !/class="yn/.test(wd) && !/\.yn\{/.test(wd) && /const val=\(html\)=>`<dd>\$\{html\}<\/dd>`/.test(cc));
t('★ [미설정]은 버튼이고 열 수 없으면 비활성 + 사유(눌러도 아무 일 없는 버튼 금지)',
  /class="cndset"[^`]*onclick="_cndFix\('\$\{kind\}'\)"/.test(cc)
  && /class="cndset off" disabled title="\$\{esc\(g\.tip\)\}"/.test(cc));
t('★ 결제금액은 1건당 금액(진행 현황의 합계와 다른 값) — 서버가 작업오더에서 싣는다',
  /payAmount: num\(wo && wo\.payAmount\)/.test(cond) && /\['결제금액','order'/.test(cc));

console.log('\n── D2. [미설정] → 정식 창구 ──');
/* ★★ 새 저장 경로를 만들지 않는다(사용자 확정) — 저장처가 둘이 되면 작업오더·모집공고·입금관리가
   서로 다른 값을 보게 된다. 창구가 하나뿐이라 동기화가 구조적으로 보장된다. */
const gate = fnBody(wd, 'function _cndFixGate(cd,kind){');
const fix  = fnBody(wd, 'async function _cndFix(kind){');
t('★ 정원(총건수·일건수)은 [📅 모집인원 조절] 창구로 — 차수·이월·날짜별 조절을 아는 유일한 곳',
  /if\(kind==='quota'\) return openCurrentCampaignDailyPlan\(\);/.test(fix));
t('★ 공고 값은 모집공고 수정 모달로', /openRecruitModal\(String\(cd\.campaignId\)\)/.test(fix));
t('★ 작업오더 값은 작업오더 수정 모달로 + 저장 경로는 기존 편집 허용명단 게이트',
  /woAdminEditModal\(o,\{/.test(fix) && /'\/api\/trackb\/work-orders\/edit'/.test(fix));
/* ★ 문자열 존재만 보면 **호출을 죽인 변이**(const r=null)를 놓친다(실측) — 호출 형태를 고정한다. */
t('★ 모달에는 작업오더 **원본 행**을 넘긴다(작업보드 detail 은 camelCase 라 폼이 빈다)',
  /const r=await api\(`\/api\/trackb\/work-orders\?sheetId=/.test(fix)
  && /const o=\(\(r&&r\.items\)\|\|\[\]\)\.find\(x=>String\(x\.id\)===String\(cd\.workOrderId\)\)/.test(fix)
  && /woAdminEditModal\(o,/.test(fix));
t('★ 이 화면에 새 저장 API 를 만들지 않았다(condition 전용 저장 경로 0)',
  !/condition\/save|\/api\/trackb\/condition/.test(wd));
t('★ 권한·연결이 없으면 비활성 + 사유(quota=공고, order=발주, tab=탭 설정)',
  /if\(!STATE\.canEdit\) return \{can:false/.test(gate)
  && /kind==='tab'\) return \{can:false/.test(gate)
  && /kind==='order'\) return cd\.workOrderId/.test(gate)
  && /kind==='quota'\) return cd\.campaignId/.test(gate));
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
t('★ 리뷰타입 라벨은 서버가 준 값(프론트에 표 사본 금지)',
  /cd\.reviewTypeLabel/.test(cc) && !/RF_REVIEW_TYPE_LABELS/.test(cc));

console.log('\n── E. 화면: 발주 줄 + 원문 팝업 ──');
const lk = fnBody(wd, 'function _woLinkedRow(wd){');
t('발주 줄이 카드 맨 아래 한 줄(.tp3wo.lk)', /class="tp3wo lk"/.test(lk));
t('★ 조작은 [⋯] 메뉴 안 — 주 화면에 파괴 버튼을 늘어놓지 않는다',
  /prepareRoster\(\)/.test(lk) && /openWorkOrderPicker\(\)/.test(lk) && /unlinkWO\(\)/.test(lk)
  && /class="womenu"/.test(lk));
t('★ 메뉴 조작은 admin/master 만(종전 계약 유지)', /STATE\.role==='master'\|\|STATE\.role==='admin'/.test(lk));
t('★ 바깥클릭·Esc 리스너는 최상위 1회만(열 때마다 걸면 겹쳐 쌓인다)',
  /_woRowMenuBound/.test(wd) && (wd.match(/STATE\._woRowMenuBound=true/g) || []).length === 1);
t('★ 발주 원문 팝업이 종전 「작업세부」와 같은 값을 그린다(렌더러 이동)', (() => {
  const raw = fnBody(wd, 'function _woRawRowsHtml(d){');
  return /\['유입가이드',d\.inflowGuide\]/.test(raw) && /\['리뷰가이드',d\.reviewGuide\]/.test(raw)
    && /\['특이사항',d\.specialNotes\]/.test(raw)
    && /STATE\.role!=='advertiser'\?\[\['담당',d\.managerName\]\]/.test(raw);   // 담당자 실명은 내부만
})());

console.log('\n── F. 화면: 제출물 미리보기(좌 구매캡처 / 우 리뷰이미지) ──');
const r2 = fnBody(wd, 'function _rvRender2(pane){');
t('_rvRender2 가 있다', !!r2);
t('★ 두 칸 — 좌 구매 캡처 / 우 리뷰 이미지', /col\('cap'[\s\S]*col\('rev'/.test(r2));
t('★ 칸마다 한 장(.rvone)', /class="rvone"/.test(r2));
t('⑥ 넘김 줄은 1장일 때도 자리를 비워 둔다(visibility) — 없애면 두 칸 높이가 어긋난다',
  /n>1\?'':' style="visibility:hidden"'/.test(r2));
t('★ 끝에서 순환하지 않는다', /Math\.max\(0,Math\.min\(n-1,/.test(fnBody(wd, 'function _rvStep(kind,delta,n){')));
t('★ 장수는 칸 머리 배지에 남긴다(조용한 누락 금지)', /class="cnt">\$\{n\}/.test(r2));
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
t('★ 광고주 뷰어(_rvRender)는 종전 그대로 — 이 래퍼는 내부 화면 전용', (() => {
  const m = fnBody(wd, 'function _rvRender(){');
  return !!m && !/_rvFill\(/.test(m) && /pane\.innerHTML=/.test(m);
})());

console.log('\n── H. 시안 문서 ──');
t('시안 문서에 C안이 있다', /id="secC"/.test(doc) && /\?v=C/.test(doc));

console.log(`\n✅ workboardTopC: ${pass} cases passed`);
process.exit(0);
