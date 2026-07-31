/**
 * campaignGuideView.test.js — 참여형 캠페인 작업가이드 화면 정리 회귀가드
 * 실행: node tests/campaignGuideView.test.js
 *
 * 고정하는 것 (PRD: frontend/docs/prd-campaign-workguide-cleanup.html):
 *  ① 상품·옵션·결제금액 표시: 중복 "결제금액 N원" 제거 + 상품명↵금액 줄바꿈(금액 1종류일 때만 병합)
 *  ② 리뷰가이드: [리뷰등록 가이드] 섹션만 (유입 섹션·첨부 이미지 메타 제거) · 라벨 없으면 무변화
 *  ③ 유입 첨부 이미지: guide-image 프록시·Drive URL만 <img>화(그 외 URL 무시) · 기존 HTML 중복 스킵
 *  ④ 상품페이지 열기 버튼: inflowType==='link'(또는 불명)일 때만 · 서버 work-detail이 inflowType 반환
 *  ⑤ 카톡 팀채팅방: 제출확정 후에만(chatUrl 게이트) · 카카오 옐로(.btn.kakao) + 지정 라벨
 *  ⑥ [v1.1] 리뷰 내역 카드 → 참여상품 정보 시트(participation-brief 행 소유권 게이트) + 2버튼
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const readF = (p) => fs.readFileSync(path.join(__dirname, '..', '..', 'frontend', p), 'utf8');
const readS = (p) => fs.readFileSync(path.join(__dirname, '..', 'src', p), 'utf8');

const camp = readF('campaign.html');
const idx = readF('index.html');
const app = readF('js/index-app.js');
const rec = readF('js/index-recruit.js');
const campRoutes = readS('routes/campaign.routes.js');
const reviewEdit = readS('routes/reviewEdit.routes.js');

let passed = 0;
function ok(name, cond) { assert(cond, name); passed++; console.log('  ✓ ' + name); }

// ── 정규화 순수함수 검증 ──
//   이 헬퍼들은 campaign.html 인라인에서 공용 모듈(js/campaign-workdetail.js)로 이관됐다.
//   실제 리뷰어 화면과 관리자 미리보기가 같은 코드를 쓰게 하기 위함(모형/실물 분리 제거).
const wdSrc = readF('js/campaign-workdetail.js');
assert(wdSrc.indexOf('function fmtProduct(') > 0, '공용 렌더러에서 정규화 헬퍼를 찾지 못했습니다');
const _M = vm.runInNewContext(
  wdSrc + '; window.CampWorkDetail',
  { window: {}, document: { getElementById: () => null, createElement: () => ({}), head: { appendChild() {} } } }
);
const H = {
  _fmtProduct: _M.fmtProduct,
  _pickReviewOnly: _M.pickReviewOnly,
  _extractGuideImages: (raw, existing) => _M.extractGuideImages(raw, existing, 'https://api.example.test'),
  _driveId: _M.driveId,
  _escAttr: _M.escAttr,
};

// ① 상품·옵션·결제금액
ok('①-1 중복 결제금액 제거 + 줄바꿈',
  H._fmtProduct({ productLines: '장수돌침대 워셔블 전기매트 결제금액 78,000원 - 결제금액 78,000원' })
    === '장수돌침대 워셔블 전기매트\n결제금액 78,000원');
ok('①-2 이미 깨끗한 "- 결제금액" 도 상품명↵금액으로',
  H._fmtProduct({ productLines: '레노버 노트북 - 결제금액 489,000원' }) === '레노버 노트북\n결제금액 489,000원');
ok('①-3 상이 금액(다옵션)은 병합하지 않고 원문 보존',
  H._fmtProduct({ productLines: 'A 결제금액 10,000원\nB 결제금액 20,000원' }) === 'A 결제금액 10,000원\nB 결제금액 20,000원');
ok('①-4 라인 내 금액 없고 payAmount만 → 별도 줄',
  H._fmtProduct({ productLines: '상품명', payAmount: 50000 }) === '상품명\n결제금액 50,000원');
ok('①-5 빈 값 → 안내 문구',
  H._fmtProduct({}) === '(등록된 상품 정보가 없어요)');
ok('①-6 금액 없는 순수 상품명은 그대로(오작동 없음)',
  H._fmtProduct({ productLines: '그냥 상품명만' }) === '그냥 상품명만');

// ② 리뷰가이드 섹션 필터
const combined = [
  '[유입방식] 유입가이드', '', '[유입가이드]', '장수돌침대 전기매트', '',
  '[유입가이드 첨부 이미지]', '1. 0722 장수산업 유입.png (29KB, Drive 저장됨)',
  'https://sublime-magic-production-790b.up.railway.app/api/order/guide-image/1mdb2dR2Bz_4sX-2V251kl3XtdjyT6Q1J', '',
  '[리뷰등록 가이드]', '전체 별점 5건', '- 배송이 빠르다', '- 겨울맞이 미리 준비했다 등', '1~2줄 자연스러운 리뷰 작성희망',
].join('\n');
const reviewOnly = H._pickReviewOnly(combined);
ok('②-1 [리뷰등록 가이드] 내용만 추출', /전체 별점 5건/.test(reviewOnly) && /자연스러운 리뷰 작성희망/.test(reviewOnly));
ok('②-2 유입방식/유입가이드/첨부 이미지 섹션 제거', !/유입방식/.test(reviewOnly) && !/장수돌침대 전기매트/.test(reviewOnly) && !/guide-image/.test(reviewOnly) && !/저장됨/.test(reviewOnly));
ok('②-3 [라벨] 없는 평문 리뷰가이드는 전체 그대로(무변화)',
  H._pickReviewOnly('전체 별점 5건\n자연스럽게 작성') === '전체 별점 5건\n자연스럽게 작성');
ok('②-4 리뷰등록 섹션이 없으면 빈 문자열', H._pickReviewOnly('[유입가이드]\n내용') === '');

// ③ 유입 첨부 이미지 화이트리스트
const imgHtml = H._extractGuideImages(combined, '');
ok('③-1 guide-image → <img> (src는 신뢰 베이스 API_BASE_URL로 재구성 · 원본 호스트 미신뢰)',
  /<img src="https:\/\/api\.example\.test\/api\/order\/guide-image\/1mdb2dR2Bz_4sX-2V251kl3XtdjyT6Q1J" alt="유입가이드 이미지">/.test(imgHtml)
  && !/sublime-magic-production/.test(imgHtml));
ok('③-2 Drive 파일 URL → thumbnail <img>',
  /drive\.google\.com\/thumbnail\?id=/.test(H._extractGuideImages('https://drive.google.com/file/d/1AbcABCabc0123456789xyz/view', '')));
ok('③-3 일반(비이미지) URL은 <img> 미생성',
  H._extractGuideImages('참고 https://example.com/page 링크', '') === '');
ok('③-4 이미 유입 HTML에 있는 URL은 스킵(중복 방지)',
  H._extractGuideImages(combined, '<img src="https://x/api/order/guide-image/1mdb2dR2Bz_4sX-2V251kl3XtdjyT6Q1J">') === '');
ok('③-5 src 속성 escape(따옴표 breakout 차단)', H._escAttr('a"b<c>') === 'a&quot;b&lt;c&gt;');

// ④·⑤ campaign.html 구조 가드
// ★ 규칙 강화: 링크유입일 때만 노출. 가이드유입 공고에 버튼이 뜨면 리뷰어가 상품 페이지로
// 바로 들어가 유입가이드(검색어·경유 경로) 자체가 무의미해진다. 유입방식 불명이면 유입가이드
// 내용 유무로 판정 — 종전의 "불명이면 노출"은 수동 공고를 전부 새어나가게 했다.
ok('④ 상품페이지 열기 버튼은 링크유입일 때만(가이드유입이면 숨김)',
  /d\.inflowType === 'link' \|\| \(!d\.inflowType && !hasGuide\)/.test(wdSrc)
  && _M.cardsHtml({ workDetail: {}, landingUrl: 'https://x/p', inflowType: 'link' }).includes('data-cwd-landing')
  && !_M.cardsHtml({ workDetail: { inflowGuideHtml: '<b>검색</b>' }, landingUrl: 'https://x/p' }).includes('data-cwd-landing')
  && !_M.cardsHtml({ workDetail: {}, landingUrl: 'https://x/p', inflowType: 'guide' }).includes('data-cwd-landing'));
ok('⑤-1 카카오 버튼 스타일(.btn.kakao = #FEE500)', /\.btn\.kakao\{background:#FEE500/.test(camp));
ok('⑤-2 제출완료 카톡 버튼 라벨 = "이 캠페인의 카톡 팀채팅방 입장"', /이 캠페인의 카톡 팀채팅방 입장/.test(camp));
ok('⑤-3 참여 후(vJoined) 화면에서 chatBox 카드 제거', !/id="chatBox"/.test(camp));
ok('⑤-4 제출완료 화면 chatUrl은 재조회로 채움(_ensureDoneChat)', /_ensureDoneChat/.test(camp));

// ④·⑤ 서버 work-detail 게이트
ok('④ work-detail 응답에 inflowType(연결 작업오더 역조회)', /_lookupInflowType/.test(campRoutes) && /inflowType,/.test(campRoutes));
ok('⑤ chatUrl은 제출확정(isSubmitted) 후에만 반환', /chatUrl: isSubmitted \? \(camp\.chat_url \|\| ''\) : ''/.test(campRoutes));

// ⑥ [v1.1] 리뷰 내역 카드 → 참여상품 정보 시트 + participation-brief
// (배선 형태 갱신: 참여중·제출완료 카드가 한 코드로 통일되면서 done 여부를 인자로 넘긴다.
//  대기 건은 여전히 그룹 items 전체를, 완료 건은 그 행 1건만 시트에 전달한다.)
ok('⑥-1 리뷰 내역 대기 카드 클릭 → 참여상품 정보 시트(즉시 제출 직행 아님)',
  /openPartInfoSheet\(isDone \? \[item\] : items, \{ done: isDone \}\)/.test(idx) && !/card\.addEventListener\("click", \(\) => goToSubmit\(items\)\)/.test(idx));
ok('⑥-2 시트의 [리뷰제출하기]는 기존 goToSubmit 경유', /_partInfoSubmit[\s\S]{0,120}goToSubmit\(items\)/.test(idx));
ok('⑥-3 카카오 입장 버튼(#FEE500) + 지정 라벨', /background:#FEE500[\s\S]{0,220}이 캠페인의 카톡 팀채팅방 입장/.test(idx));
ok('⑥-4 상품 URL은 https만 링크화(scheme 가드)', /https\?:[\s\S]{0,12}test\(pu\)/.test(idx));
ok('⑥-5 participation-brief 엔드포인트(행 소유권 게이트 재사용)',
  /router\.get\('\/participation-brief'/.test(reviewEdit) && /_verifyRowOwnership\(phoneList, sheetId, tabName, rowIndex\)/.test(reviewEdit));
ok('⑥-5b gid는 서버가 tab_configs에서 재도출(클라이언트 gid 미신뢰 = 형제 캠페인 유출 차단)',
  /SELECT tab_gid FROM tab_configs WHERE sheet_id = \$1 AND tab_name = \$2/.test(reviewEdit)
  && !/const gid = String\(req\.query\.gid/.test(reviewEdit));
ok('⑥-6 공고 미연결 탭은 brief:null(카톡 없음 → 프론트 제출 버튼만)', /return res\.json\(\{ ok: true, brief: null \}\)/.test(reviewEdit));

// B: 발행 프리필 정화(신규 스냅샷 클린)
ok('B-1 프리필 wd_review는 _woPickSections로 리뷰등록만',
  /wd_review:\s*\(typeof _woPickSections === "function"[\s\S]{0,120}리뷰등록 가이드/.test(app));
ok('B-2 유입가이드 HTML에 review_guide 첨부 이미지 승격(_woBuildInflowHtml)',
  /_woBuildInflowHtml/.test(app) && /wd_inflow_html: _wdInflowHtml/.test(app));
ok('B-3 비링크 landing_url product_url 폴백 제거(유입가이드형에 버튼 안 뜸)',
  /o\.inflow_type === "link"\s*\n?\s*\?[\s\S]{0,140}: "",/.test(app));
ok('B-5 발행 저장 시 source_work_order_id 전송(신규+오더 프리필만)',
  /source_work_order_id: \(!_recruitEditId && _woPrefillOrderId\)/.test(rec));

console.log(`\n✅ campaignGuideView: ${passed}개 통과`);
