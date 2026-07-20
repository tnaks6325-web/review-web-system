/**
 * campaignM2FrontGuards.test.js — M2 프론트(임베드·카드·상세) 구조 회귀가드 (소스 grep)
 * 실행: node tests/campaignM2FrontGuards.test.js
 *
 * 고정하는 것:
 *  - search-app.js 임베드 모드는 전부 가산적(embed=1 없으면 기존 구매양식 무영향)
 *  - 홀드 확정 문맥은 embed 진입에서만 제출 body에 포함
 *  - campaign.html postMessage 수신은 동일 오리진만 신뢰
 *  - 레거시 카드 소비처(index/recruit)가 참여형을 자체 신청폼으로 처리하지 않음(공용 카드로 분리)
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const readF = (p) => fs.readFileSync(path.join(__dirname, '..', '..', 'frontend', p), 'utf8');

const sapp = readF('js/search-app.js');
const cards = readF('js/campaign-cards.js');
const camp = readF('campaign.html');
const idx = readF('index.html');
const rec = readF('recruit.html');
const recjs = readF('js/index-recruit.js');

let passed = 0;
function ok(name, cond) { assert(cond, name); passed++; console.log('  ✓ ' + name); }

// ── search-app.js 임베드 가산성 ──
ok("embed: _EMBED_CTX는 ?embed=1일 때만 생성", /q\.get\("embed"\) !== "1"\) return null/.test(sapp));
ok('embed: postMessage는 _EMBED_CTX 게이트 뒤에서만', /_embedPost\(msg\) \{\s*\n\s*if \(_EMBED_CTX && window\.parent !== window\)/.test(sapp));
ok('embed: postMessage 대상 오리진 고정(location.origin)', /parent\.postMessage\(msg, location\.origin\)/.test(sapp));
ok('embed: 홀드 문맥은 embed+app 있을 때만 제출 body에 spread', /\.\.\.\(_EMBED_CTX && _EMBED_CTX\.app \? \{/.test(sapp));
ok('embed: 제출완료 시 부모 통지 + 저장 입력값 정리', /order-submitted/.test(sapp) && /sessionStorage\.removeItem\(_EMBED_FORM_KEY\)/.test(sapp));
ok('embed: 세션 부재 시 부모 위임(embed-need-login) — 자체 로그인 폴백 유지', /embed-need-login/.test(sapp));
ok('embed: 입력값 복원은 빈 칸만(기존 값 미덮어씀)', /이미 값 있으면 미덮어씀/.test(sapp));

// ── campaign.html 상세 ──
ok('campaign.html: message 수신 오리진 검증', /ev\.origin !== location\.origin\) return/.test(camp));
ok('campaign.html: 세션 키·포맷 = rapp_reviewer_auth(name/phone8/expAt)', /rapp_reviewer_auth/.test(camp) && /registeredMember:true/.test(camp));
ok('campaign.html: profile_missing → 내정보 안내(자리 미점유)', /profile_missing/.test(camp) && /renderMissing/.test(camp));
ok('campaign.html: 만료 화면 — 당일 재참여 불가 + 기구매 안내', /다시 참여할 수 없어요/.test(camp) && /이미 구매하셨나요/.test(camp));
ok('campaign.html: 폴링 + visibilitychange 복귀 재조회(새 창 제출 폴백)', /visibilitychange/.test(camp) && /setInterval\(pollOnce, 10000\)/.test(camp));
ok('campaign.html: work-detail 호출에 phone8+holdToken 이중 열쇠', /work-detail\?phone8=/.test(camp) && /holdToken=/.test(camp));

// ── 공용 카드 모듈 ──
ok('cards: 서버시간 오프셋 보정(setServerNow) 사용', /serverNow - Date\.now/.test(cards) || /_serverOffsetMs = t - Date\.now\(\)/.test(cards));
ok('cards: preopen 회색 오버레이 + 흰 굵은 카운트다운', /poverlay/.test(cards) && /data-camp-countdown/.test(cards));
ok('cards: 카드 탭 → campaign.html 이동(목록에서 신청 없음)', /campaign\.html\?id=/.test(cards));

// ── 소비처 분리(레거시 회귀 방지) ──
ok('index.html: 참여형은 CampCards로만 렌더(레거시 목록에서 제외)', /!c\.participation_mode\)/.test(idx) && /CampCards\.cardHtml/.test(idx));
ok('recruit.html: 참여형은 CampCards로만 렌더(레거시 목록에서 제외)', /!c\.participation_mode\)/.test(rec) && /CampCards\.cardHtml/.test(rec));
ok('index-recruit.js: 게시 전 자동 점검 = 서버 게이트와 동일 3항목', /participationCheckErrors/.test(recjs) && /gid/.test(recjs));
ok('index-recruit.js: active 저장 시 점검 실패면 차단(서버 게이트 이중화)', /payload\.status === "active"[\s\S]{0,200}participationCheckErrors\(\)/.test(recjs));

console.log(`\n✅ campaignM2FrontGuards: ${passed}개 통과`);
