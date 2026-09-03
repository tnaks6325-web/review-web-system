/**
 * campaignMultiAccountFront.test.js — 타계정 추가참여 2단계(리뷰어 화면) 회귀가드 (063)
 * 실행: node tests/campaignMultiAccountFront.test.js
 *
 * 고정하는 것(1단계 심판이 2단계로 이관한 필수 계약):
 *  ① 홀드 저장 v2(명의별 맵) + **구키 파기 금지**(당일 재참여 0회 정책이라 토큰 유실 = 참여권 소각)
 *  ② 단일 #orderFrame 불변식 — 명의 전환도 enterJoined() 재실행(=iframe 재로드로 인플라이트 제출 파기)
 *  ③ apply 요청 subName/subPhone, 응답 phone8=명의 계약
 *  ④ multi_account_mode=false 공고는 화면·경로 100% 현행(조기 반환)
 *  ⑤ PREVIEW 격리(홀드 읽기·쓰기 0) 유지
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const readF = (p) => fs.readFileSync(path.join(__dirname, '..', '..', p), 'utf8');

const camp = readF('frontend/campaign.html');
const indexHtml = readF('frontend/index.html');

let passed = 0;
function ok(name, cond) { assert(cond, name); passed++; console.log('  ✓ ' + name); }

// ── ① 홀드 저장 v2 ──
ok('v2: 명의별 맵 키(camp_holds_) + 활성 포인터(camp_active_)', /HOLDS_KEY\s*=\s*'camp_holds_'/.test(camp) && /ACTIVE_KEY\s*=\s*'camp_active_'/.test(camp));
ok('v2: 구키(camp_hold_)를 읽어 승격', /_allHolds[\s\S]{0,700}localStorage\.getItem\(HOLD_KEY\)[\s\S]{0,300}m\[String\(old\.phone8\)\] = old/.test(camp));
ok('★ v2: _allHolds가 구키를 삭제하지 않음(참여권 소각 방지)',
  !/_allHolds[\s\S]{0,900}removeItem\(HOLD_KEY\)/.test(camp.slice(camp.indexOf('function _allHolds'), camp.indexOf('function _saveHolds'))));
ok('v2: getHold(p8) 인자 지원 + 무인자는 활성 명의', /function getHold\(p8\)\{[\s\S]{0,220}activeP8\(\)/.test(camp));
ok('v2: clearHold는 활성(또는 지정) 명의만 제거 — 다른 명의 홀드 보존',
  /function clearHold\(p8\)\{[\s\S]{0,400}delete m\[key\]/.test(camp) && !/function clearHold\(p8\)\{[\s\S]{0,400}localStorage\.removeItem\(HOLDS_KEY\)/.test(camp));
ok('v2: 어제 홀드 폐기는 맵 전체 순회(오늘 것은 명의 불문 보존)',
  /const today = kstDateStr\(CampCards\.serverNow\(\)\)[\s\S]{0,500}for\(const k of Object\.keys\(m\)\)/.test(camp));

// ── ⑤ PREVIEW 격리(기존 불변식 유지) ──
ok('PREVIEW: 홀드 읽기 차단', /function _allHolds\(\)\{\s*\n?\s*if\(PREVIEW\) return \{\}/.test(camp));
ok('PREVIEW: 홀드 쓰기 차단(save/set/clear/active 전부)',
  /function _saveHolds\(m\)\{ if\(PREVIEW\) return;/.test(camp) &&
  /function setHold\(h\)\{\s*\n?\s*if\(PREVIEW \|\| !h/.test(camp) &&
  /function clearHold\(p8\)\{\s*\n?\s*if\(PREVIEW\) return;/.test(camp) &&
  /function setActiveP8\(p8\)\{ if\(PREVIEW\) return;/.test(camp));

// ── ③ apply 계약 ──
ok('apply: 타계정이면 subName/subPhone 전송', /body\.subName = sub\.name; body\.subPhone = sub\.phone;/.test(camp));
ok('apply 응답: phone8=명의를 홀드 키로 저장 + participant/ownerPhone8 보존',
  /setHold\(\{ applicationId: j\.applicationId, holdToken: j\.holdToken, phone8: j\.phone8[\s\S]{0,420}ownerPhone8: j\.ownerPhone8/.test(camp));
for (const r of ['multi_disabled', 'sub_invalid', 'sub_shares_owner_phone', 'sub_not_registered',
                 'sub_is_registered_reviewer', 'owner_hold_cap', 'sub_daily_limit',
                 'blocked_by_other_owner', 'same_phone_other_name']) {
  ok(`apply 사유 안내문 존재: ${r}`, camp.includes(r + ':'));
}
ok('apply: 타계정 거절 시 그 명의만 잠그고 시트 재오픈(자리 미점유 · 재선택 유도)',
  /_acctBlocked\[p8\] = msg;\s*\n\s*renderAcctList\(\);/.test(camp));

// ── ② 단일 iframe 불변식 ──
ok('★ 명의 전환은 enterJoined() 재실행(iframe 재로드 = 인플라이트 제출 파기)',
  /async function switchAcct\(p8\)\{[\s\S]{0,300}setActiveP8\(p8\);\s*\n\s*await enterJoined\(\);/.test(camp));
ok('iframe은 여전히 단일 #orderFrame(추가 생성 없음)', (camp.match(/id="orderFrame"/g) || []).length === 1);

// ── ④ 비활성 공고 무영향 ──
ok('multi_account_mode=false면 명의 선택 없이 기존 경로(_doApply 즉시)',
  /function _joinWithOption\(optionKey\)\{[\s\S]{0,200}if\(!multiEnabled\(\)\) return _doApply\(optionKey\);/.test(camp));
ok('타계정 0개면 기존 흐름 그대로(명의 시트 미표시)', /if\(!\(_subs \|\| \[\]\)\.length\) return _doApply\(optionKey\);/.test(camp));
ok('추가참여 버튼은 참여형 타계정 공고에서만 노출', /addBtn\.style\.display = \(multiEnabled\(\) &&/.test(camp));

// ── UI 구성 ──
ok('명의 선택 시트 + 미등록 안내 시트 존재', /id="acctSheet"/.test(camp) && /id="acctEmpty"/.test(camp));
ok('참여 후 명의 카드·전환 칩·추가참여 버튼', /id="acctBox"/.test(camp) && /id="acctSwitch"/.test(camp) && /id="addSubBtn"/.test(camp));
ok('타계정 목록은 서명 세션 기반 secure profile API로 소유자 범위를 고정',
  /\/api\/reviewer\/profile\/secure/.test(camp) && /headers:_getAuthHeaders\(\)/.test(camp));
ok('타계정이 있는 허용 공고는 명의를 먼저 선택한 뒤 옵션으로 이동',
  /if\(multiEnabled\(\)\)[\s\S]{0,180}if\(\(_subs \|\| \[\]\)\.length\) return openAcctSheet\(null, 'option'\)/.test(camp)
  && /function _continueInitialAcct\(\)/.test(camp));
ok('제출 완료: 그 명의만 정리하고 남은 명의는 이어서 진행 CTA', /clearHold\(done\.phone8\)/.test(camp) && /doneNextBtn/.test(camp));

// ── 등록 유도 → 복귀 ──
ok('campaign: 등록 유도는 returnCamp 파라미터로 내정보 이동', /index\.html\?returnCamp=' \+ encodeURIComponent\(CAMP_ID\)/.test(camp));
ok('index: returnCamp 배너 + 형식 검증(오픈 리다이렉트 차단 — 캠페인 id만 허용)',
  /function showSubReturnBanner\(\)/.test(indexHtml) && /\/\^\[A-Za-z0-9_-\]\{1,64\}\$\/\.test\(id\)/.test(indexHtml));
ok('index: 복귀는 내부 campaign.html 경로로만 이동', /location\.href = 'campaign\.html\?id=' \+ encodeURIComponent\(id\)/.test(indexHtml));

console.log(`\n✅ campaignMultiAccountFront: ${passed}개 통과`);
