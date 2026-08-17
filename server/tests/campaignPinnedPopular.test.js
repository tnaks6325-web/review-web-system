/**
 * campaignPinnedPopular.test.js — 인기상품 게이트 회귀가드 (064)
 * 실행: node tests/campaignPinnedPopular.test.js
 * 고정하는 것: 별표 우선노출 제거 + 인기 ON/OFF 라우트(adminOrMaster, 스코프 토큰 도달 불가) ·
 *   인기 선행참여 게이트(명의별 1:1, 만료 환불, 게이트=INSERT 이전) · popular-status 라우트 순서 함정 ·
 *   공개필드 is_popular(양쪽) · 관리자/리뷰어 UI · sort_order UI 제거(null-safe)
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const readS = (p) => fs.readFileSync(path.join(__dirname, '..', p), 'utf8');
const readF = (p) => fs.readFileSync(path.join(__dirname, '..', '..', p), 'utf8');

const mig = readS('migrations/064_campaign_pin_popular.sql');
const routes = readS('src/routes/campaign.routes.js');
const auth = readS('src/middleware/auth.middleware.js');
const adminHtml = readF('frontend/js/recruit-modal.js') + '\n' + readF('frontend/admin.html');
const siandHtml = readF('frontend/admin-siand.html');
const recruit = readF('frontend/js/index-recruit.js');
const cards = readF('frontend/js/campaign-cards.js');
const campHtml = readF('frontend/campaign.html');

let passed = 0;
function ok(name, cond) { assert(cond, name); passed++; console.log('  ✓ ' + name); }

// ── 064 스키마 ──
ok('064: pinned_at TIMESTAMPTZ + is_popular 기본 FALSE', /pinned_at\s+TIMESTAMPTZ/.test(mig) && /is_popular BOOLEAN NOT NULL DEFAULT FALSE/.test(mig));
ok('064: idempotent(IF NOT EXISTS)', !/ADD COLUMN (?!IF NOT EXISTS)/.test(mig));
ok('064: sort_order 컬럼 드롭 없음(데이터 보존 = 롤백 안전)', !/DROP COLUMN/i.test(mig));

// ── 정렬: 별표 우선노출 제거 ──
{
  const list = routes.slice(routes.indexOf("router.get('/list'"), routes.indexOf("router.get('/popular-status'"));
  ok('/list: 정렬에서 sort_order 제거', !/ORDER BY[\s\S]{0,200}sort_order/.test(list));
  ok('/list: 별표 정렬을 쓰지 않고 생성일 순서를 사용', !/pinned_at IS NULL/.test(list) && /created_at DESC/.test(list));
  ok('/list SELECT에 인기 여부 포함(명시 컬럼 SELECT 함정)', /sub_hold_ttl_min, is_popular/.test(list));
  const admList = routes.slice(routes.indexOf("router.get('/admin/list'"), routes.indexOf("router.post('/admin/:id/flags'"));
  ok('/admin/list: 별표 정렬 없이 생성일 순서', !/pinned_at IS NULL/.test(admList) && /created_at DESC/.test(admList));
}

// ── flags 토글 라우트 ──
{
  const flags = routes.slice(routes.indexOf("router.post('/admin/:id/flags'"), routes.indexOf("router.post('/admin/create'"));
  ok('flags: authMiddleware + adminOrMaster', /authMiddleware, adminOrMasterMiddleware/.test(flags));
  ok('flags: 인기 ON/OFF만 저장하고 별표 값은 받지 않는다', /is_popular = \$2::boolean/.test(flags) && !/b\.pinned/.test(flags));
  ok('flags: 인기 값 없는 요청은 400', /popular 값이 필요합니다/.test(flags));
  // 스코프 토큰(via reviewer_campaign)은 PUT 끝앵커만 허용 → POST flags 도달 불가(격리 불변 확인)
  ok('auth: 스코프 토큰은 PUT /admin/:id 끝앵커만(POST /flags 차단)', /req\.method === 'PUT' && \/\^\\\/api\\\/campaign\\\/admin\\\/\[\^\/\]\+\$\//.test(auth));
}

// ── 인기 선행참여 게이트(apply) ──
{
  const applyBody = routes.slice(routes.indexOf('async function _applyParticipation'), routes.indexOf("router.post('/:id/apply'"));
  ok('apply: popular_locked 사유 존재', applyBody.includes("'popular_locked'"));
  ok('apply: 게이트는 camp.is_popular === true 에서만(일반 공고 무영향)', /if \(camp\.is_popular === true\)/.test(applyBody));
  ok('apply: 크레딧 = 일반(비인기) submitted, 소비 = 인기 submitted+유효홀드(만료·취소 자동 환불)',
    /rc\.is_popular IS NOT TRUE AND ca\.status = 'submitted'/.test(applyBody) &&
    /rc\.is_popular IS TRUE AND \(ca\.status = 'submitted' OR \(ca\.status = 'applied' AND ca\.expires_at > NOW\(\)\)\)/.test(applyBody));
  ok('apply: 명의 기준 판정(holdP8) — 타계정도 각 명의가 일반 1건 필요', /WHERE ca\.phone8 = \$1 AND rc\.participation_mode/.test(applyBody));
  ok('apply: 게이트가 홀드 INSERT 이전(자리 미점유)', applyBody.indexOf("'popular_locked'") < applyBody.indexOf('INSERT INTO campaign_applications'));
  ok('apply: 응답에 normalDone/popularUsed 동봉(프론트 모달 표기)', /reason: 'popular_locked', normalDone, popularUsed/.test(applyBody));
}

// ── popular-status(무인증 phone8 스코프) ──
ok('popular-status: /:id 보다 먼저 등록(라우트 삼킴 함정)', routes.indexOf("router.get('/popular-status'") < routes.indexOf("router.get('/:id'"));
ok('popular-status: 리미터 적용 + 게이트와 동일 계산', /router\.get\('\/popular-status', applyLimiter/.test(routes));

// ── 공개필드 ──
{
  const leg = (routes.match(/PUBLIC_FIELDS_LEGACY = \[[\s\S]*?\];/) || [''])[0];
  const part = (routes.match(/PUBLIC_FIELDS_PARTICIPATION = \[[\s\S]*?\];/) || [''])[0];
  ok('공개필드: is_popular 양쪽 노출(레거시 카드도 배지)', leg.includes("'is_popular'") && part.includes("'is_popular'"));
  ok('공개필드: 별표 상태는 노출하지 않는다', !part.includes("'pinned_at'") && !leg.includes("'pinned_at'"));
}

// ── 썸네일 좌상단 인기 ON/OFF(관리자 전용) ──
ok('cards: 인기 ON/OFF는 진짜 admin_token 또는 관리자 목록만',
  /function _realAdminTok\(\)/.test(cards)
  && /const popToggle = c\.participation_mode && \(admin \|\| _realAdminTok\(\)\)/.test(cards)
  && !/pstarchip/.test(cards));
ok('cards: 인기 아이콘은 썸네일 좌상단에서 클릭해 ON/OFF', /pt-pop-toggle/.test(cards) && /pt-topleft">\$\{popToggle\}/.test(cards) && /CampCards\.togglePopular/.test(cards));
ok('cards: togglePopular — /flags POST + 홈 재렌더(loadRecruitPreview)', /async function togglePopular\(campId, on\)/.test(cards) && /loadRecruitPreview === 'function'/.test(cards));
// ★★ 리뷰웹시스템[3버전](인트라넷 SSO `via:'intranet'`)은 authMiddleware가 `/api/trackb/*` 로만
//    도달을 허용하므로, togglePin이 `/api/campaign/admin/...` 을 하드코딩하면 별표만 403
//    ("인트라넷 연동 계정은 …Track B…에서만")으로 죽는다 — 호스트 재기준(CAMPAIGN_ADMIN_API) 고정.
ok('cards: togglePopular 경로는 호스트가 재기준(CAMPAIGN_ADMIN_API) — trackb에서도 인기 설정 동작',
  /window\.CAMPAIGN_ADMIN_API/.test(cards)
  && /function _flagsUrl\(campId\)/.test(cards)
  && /await fetch\(_flagsUrl\(campId\)/.test(cards)
  && !/['"]\/api\/campaign\/admin\/['"] ?\+ ?encodeURIComponent\(campId\) ?\+ ?['"]\/flags['"]/.test(cards));
ok('flags: 토글 직후 /list 캐시 무효화', /_listCache = \{ at: 0, rows: null, countsMap: null(, feeMap: null)? \};[\s\S]{0,200}isPopular/.test(routes));

// ── 관리자 UI ──
ok('admin.html: 노출 순서(rf_sort_order) 제거', !adminHtml.includes('rf_sort_order'));
ok('admin-siand.html: 노출 순서 제거', !siandHtml.includes('rf_sort_order'));
ok('index-recruit: sort_order 읽기 null-safe(+편집 로드값 재전송 = 0-덮어쓰기 방지)',
  !/getElementById\("rf_sort_order"\)\.value/.test(recruit) && /_recruitEditLoaded\?\.sort_order/.test(recruit));
ok('index-recruit: 새 공고 열 때 로드값 초기화(이전 편집값 누수 방지)', /window\._recruitEditLoaded = null/.test(recruit));
ok('index-recruit: 카드 토글은 🔥 인기만(참여형)', !/['"]pinned['"]/.test(recruit) && /c\.participation_mode \? `<button[^`]*'popular'/.test(recruit));
ok('index-recruit: toggleCampFlag → /flags POST + 목록 재정렬', /\/flags`/.test(recruit) && /await loadRecruitList\(\)/.test(recruit.slice(recruit.indexOf('function toggleCampFlag'), recruit.indexOf('function toggleCampFlag') + 1400)));

// ── 리뷰어 UI ──
ok('campaign-cards: [인기!] 배지(pt-pop) — is_popular === true 만', /c\.is_popular === true \? `<span class="pt-pop">/.test(cards) && /\.pcard \.pt-pop\{/.test(cards));
ok('campaign.html: popular_locked → 일반 목록 모달(openPopGate)', /popular_locked/.test(campHtml) && /openPopGate\(j\)/.test(campHtml));
ok('campaign.html: 인기 안내 카드(renderPopNotice) — 인기 공고만', /renderPopNotice/.test(campHtml) && /_camp\.is_popular === true/.test(campHtml));
ok('campaign.html: 일반 목록은 open·비인기·참여형·자기자신 제외 필터', /x\.participation_mode && x\.is_popular !== true && x\.state === 'open' && String\(x\.id\) !== String\(CAMP_ID\)/.test(campHtml));
ok('campaign.html: 복귀 CTA — pop_return_camp 기록 후 이동, 제출완료 화면에서 복귀 버튼', /pop_return_camp/.test(campHtml) && /popReturnBtn/.test(campHtml));
ok('campaign.html: 지각 접수(pendingConfirm)는 복귀 버튼 미노출(크레딧 아님)', /!pendingConfirm && !\$\('popReturnBtn'\)/.test(campHtml));

console.log(`\n✅ campaignPinnedPopular: ${passed}개 통과`);
