/**
 * campaignOptionsFrontGuards.test.js — 참여형 상품옵션 2단계(리뷰어 화면) 프론트 회귀가드 (소스 grep)
 * 실행: node tests/campaignOptionsFrontGuards.test.js
 *
 * 고정하는 것:
 *  - campaign.html: 참여 전 옵션 잔여 표시, 참여 시 옵션 선택창(_doApply에 optionKey), 참여 후 옵션카드+변경,
 *    옵션변경 시 work-detail 재조회(iframe 재로드=인플라이트 제출 파기), iframe에 optionKey 전달
 *  - search-app.js embed: _EMBED_CTX.optionKey 잠금(_lockEmbedOption), 피커 무시, 참여형 카드추가 숨김
 *  - campaign-cards.js: 카드 옵션 요약칩(_optChip)
 *  - 목록 API: 배치 옵션(_fetchOptionsForCampaigns) + 카드 옵션명+잔여(_publicOptionView)
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const read = (p) => fs.readFileSync(path.join(__dirname, '..', '..', p), 'utf8');       // 프론트는 repo 루트 기준
const readSrv = (p) => fs.readFileSync(path.join(__dirname, '..', p), 'utf8');

const camp = read('frontend/campaign.html');
const searchApp = read('frontend/js/search-app.js');
const cards = read('frontend/js/campaign-cards.js');
const routes = readSrv('src/routes/campaign.routes.js');

let passed = 0;
function ok(name, cond) { assert(cond, name); passed++; console.log('  ✓ ' + name); }

// ── campaign.html ──
ok('campaign.html: 참여 전 옵션 잔여 표시(renderPreOptions)', /function renderPreOptions\(\)/.test(camp) && /renderPreOptions\(\)/.test(camp));
ok('campaign.html: 옵션 선택/변경 바텀시트 존재', /id="optSheet"/.test(camp) && /openOptSheet/.test(camp) && /openChangeOptSheet/.test(camp));
// ★ 063 2단계: 옵션 확정 후 _joinWithOption을 거친다(타계정 가능 공고면 명의 선택, 아니면 _doApply 즉시).
//   옵션 규칙 자체는 불변 — 1개면 자동, 2개+면 시트.
ok('campaign.html: 옵션 등록 캠페인은 선택 필수(1개면 자동)',
  /pickable\.length === 1\) return _joinWithOption\(pickable\[0\]\.optKey\)/.test(camp) && /return openOptSheet\(\)/.test(camp));
ok('campaign.html: 옵션 확정 → _joinWithOption → (타계정 미사용 시) _doApply 즉시',
  /function _joinWithOption\(optionKey\)\{[\s\S]{0,200}if\(!multiEnabled\(\)\) return _doApply\(optionKey\);/.test(camp));
ok('campaign.html: _doApply가 optionKey를 apply body에 실음', /function _doApply\(optionKey, sub\)[\s\S]*?if\(optionKey\) body\.optionKey = optionKey/.test(camp));
ok('campaign.html: 옵션 소진 사유 처리(재선택 유도)', /option_required','option_invalid','option_soldout','option_today_done','option_unavailable/.test(camp));
ok('campaign.html: 참여 후 옵션카드+변경(renderJoinedOption)', /function renderJoinedOption\(j\)/.test(camp) && /openChangeOptSheet\(\)/.test(camp));
ok('campaign.html: 단일상품 선택지(product 1개)는 중복 참여옵션 카드를 숨김',
  /function _isSingleProductUnitCampaign\(j\)/.test(camp)
  && /options\.length === 1/.test(camp)
  && /_isSingleProductUnitCampaign\(j\)/.test(camp));
ok('campaign.html: 옵션변경은 change-option 호출 + work-detail 재조회(iframe 재로드)', /\/change-option/.test(camp) && /_doChangeOption[\s\S]*?await enterJoined\(\)/.test(camp));
ok('campaign.html: iframe에 optionKey 전달(embed 잠금표시)', /if\(j\.application && j\.application\.optionKey\) qp\.set\('optionKey', j\.application\.optionKey\)/.test(camp));

// ── search-app.js embed 잠금 ──
ok('search-app: _EMBED_CTX에 optionKey', /optionKey: q\.get\("optionKey"\)/.test(searchApp));
ok('search-app: _lockEmbedOption(피커 대신 잠금표시)', /function _lockEmbedOption\(\)/.test(searchApp) && /참여한 옵션/.test(searchApp));
ok('search-app: 옵션 피커 렌더 시 embed optionKey면 잠금(피커 무시)', /if \(!_BATCH && _EMBED_CTX && _EMBED_CTX\.optionKey\) \{ _lockEmbedOption\(\); return; \}/.test(searchApp));
ok('search-app: 참여형 embed는 주문카드 추가 버튼 숨김', /addBtnEl2\.style\.display = _EMBED_CTX \? "none" : ""/.test(searchApp));

// ── campaign-cards.js ──
ok('campaign-cards: 카드 옵션 요약칩(_optChip)', /function _optChip\(c\)/.test(cards) && /\$\{_optChip\(c\)\}/.test(cards));

// ── 목록 API 옵션 ──
ok('list API: 배치 옵션 조회(_fetchOptionsForCampaigns)', /async function _fetchOptionsForCampaigns/.test(routes) && /optionsMap = await _fetchOptionsForCampaigns/.test(routes));
ok('list API: 카드에 옵션명+잔여(_publicOptionView, 금액 은닉)', /const optViews = opts\.map\(o => computeOptionView\(o\.row, o\.cnt, view\)\)/.test(routes) && /view\.options = optViews\.map\(_publicOptionView\)/.test(routes));
// ★ 공개 뷰도 apply 게이트와 같은 `liveOptions` 기준 — 살아있는 옵션 0이면 옵션 자체를 안 실어
//   카드 옵션칩·참여 전 옵션 목록이 "옵션 N종"이라 말하는데 참여는 옵션을 안 받는 불일치를 막는다.
ok('list/상세 API: 살아있는 옵션 0이면 옵션 미노출(liveOptions 게이트)', /if \(liveOptions\(optViews\)\.length\) view\.options = /.test(routes) && /if \(liveOptions\(opts\)\.length\) view\.options = opts\.map\(_publicOptionView\)/.test(routes));

console.log(`\n✅ campaignOptionsFrontGuards: ${passed}개 통과`);
