/**
 * campaignMultiAccountFront.test.js — 타계정 추가참여 2단계(리뷰어 화면) 회귀가드 (063)
 * 실행: node tests/campaignMultiAccountFront.test.js
 *
 * 고정하는 것(1단계 심판이 2단계로 이관한 필수 계약):
 *  ① 홀드 저장 v2(명의별 맵) + **구키 파기 금지**(당일 재참여 0회 정책이라 토큰 유실 = 참여권 소각)
 *  ② 틀(iframe) 불변식 — ★ 결정 352(2026-11-07)로 "틀 1개"→"명의마다 틀 1개"로 바뀜.
 *     목적은 그대로: 한 틀에서 다른 명의의 제출이 나가지 않는다. 틀은 그 명의의 app·holdToken 주소로만 열리고,
 *     제출 완료는 "보낸 틀의 명의"로만 처리한다(지금 보고 있는 명의가 아니다).
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

// ── ② 틀(iframe) 불변식 — 결정 352: 명의마다 틀 하나 ──
ok('★ 명의 전환은 enterJoined() 재실행(그 명의의 틀을 고른다)',
  /async function switchAcct\(p8\)\{[\s\S]{0,600}setActiveP8\(p8\);\s*\n\s*await enterJoined\(\);/.test(camp));
ok('마크업의 틀은 #orderFrame 하나(추가 틀은 명의마다 코드로만)', (camp.match(/id="orderFrame"/g) || []).length === 1);
{
  const ff = camp.slice(camp.indexOf('function _frameFor(p8){'), camp.indexOf('function _activateFrame('));
  ok('★ 352: 새 틀은 _frameFor 한곳에서만 — 그 명의의 틀이 이미 있으면 그것을 쓴다(같은 명의 두 번째 틀 없음)',
    (camp.match(/createElement\('iframe'\)/g) || []).length === 1 && ff.includes("createElement('iframe')")
    && /let f = _frameByP8\(p8\); if\(f\) return f;/.test(ff) && /f\.dataset\.p8 = String\(p8 \|\| ''\);/.test(ff));
  ok('★ 352: 탭 화면의 제출 완료는 "보낸 틀"의 명의로만 정리(지금 보는 명의 아님)',
    /const _srcFr = _frameOfSource\(ev\.source\);/.test(camp)
    && /if\(d\.type === 'order-submitted' && !PREVIEW && _srcFr && _tabsOn\(\) && _onTabSubmitted\(_srcFr, d\)\) return;/.test(camp)
    && /function _onTabSubmitted\(frame, d\)\{ return _onTabSubmittedP8\(frame && frame\.dataset\.p8, d\); \}/.test(camp));
  ok('★ 352: 탭 넘기기만 같은 주소 재대입을 건너뛴다(그 명의 틀 유지) — 그 밖에는 종전처럼 다시 연다',
    /if\(!\(keepFrame && frame\.getAttribute\('src'\) === _src\)\)\{\s*\n\s*frame\.src = _src;/.test(camp));
  ok('★ 352: 만료된 틀 비우기는 제출 중이면 건드리지 않는다',
    /function _releaseFrame\(p8\)\{\s*\n\s*const f = _frameByP8\(p8\); if\(!f \|\| _frameSubmitting\(f\)\) return;/.test(camp));
}
// ── 결정 352: 여러 명의 한 번에 참여(고른 수까지만) ──
{
  const am = camp.slice(camp.indexOf('async function _applyMany('), camp.indexOf('function _applyReasonText('));
  ok('★ 352: 여러 개 체크는 「타계정 허용」 공고만(블로그·Q&A 제외)',
    /function _acctMultiPick\(\)\{ return multiEnabled\(\) && !isBlogCampaign\(\) && !isQnaCampaign\(\); \}/.test(camp));
  ok('★ 352: 체크한 명의마다 한 번씩만 자리 요청(고른 수를 넘지 않음) · 요청 칸은 _doApply 와 같다',
    /for\(let i = 0; i < sels\.length; i\+\+\)\{/.test(am) && (am.match(/\/apply'/g) || []).length === 1
    && /body\.subName = sub\.name; body\.subPhone = sub\.phone;/.test(am) && /if\(purchaseQty\) body\.purchaseQty = purchaseQty;/.test(am)
    && /if\(_applyManyBusy\) return;/.test(am));
  ok('★ 352: 아무 명의도 못 잡고 이유가 명의 탓이 아니면 종전 _doApply 안내 화면으로',
    /if\(firstGlobal\) return _doApply\(optionKey, firstGlobal\.sub, purchaseQty\);/.test(am));
  ok('★ 352: 여러 명의 공고는 나중에 명의를 더 붙이는 버튼을 숨긴다(고른 수까지만)',
    /addBtn\.style\.display = \(multiEnabled\(\) && !_acctMultiPick\(\) &&/.test(camp));
}

// ── ④ 비활성 공고 무영향 ──
// ★ 2026-10-05: 「1인 1회」(multi_account_mode=false)도 타계정 이름으로 참여할 수 있어 명의를 고른다.
ok('★ 명의 고르기는 1인 1회·타계정 허용 공통(acctChoiceEnabled) — multiEnabled 로 좁히지 않는다',
  /function _joinWithOption\(optionKey\)\{[\s\S]{0,200}if\(!acctChoiceEnabled\(\)\) return _doApply\(optionKey\);/.test(camp)
  && /function acctChoiceEnabled\(\)\{ return !!_camp; \}/.test(camp));
ok('★ 1인 1회 — 한 명의로 참여 중이면 나머지 명의를 잠근다(서버가 최종 권위)',
  /if\(!multiEnabled\(\) && rows\.some\(r => r\.state === 'joined'\)\)/.test(camp) && camp.includes("one_per_person:"));
ok('타계정 0개면 기존 흐름 그대로(명의 시트 미표시)', /if\(!\(_subs \|\| \[\]\)\.length\) return _doApply\(optionKey\);/.test(camp));
ok('추가참여 버튼은 참여형 타계정 공고에서만 노출', /addBtn\.style\.display = \(multiEnabled\(\) &&/.test(camp));

// ── UI 구성 ──
ok('명의 선택 시트 + 미등록 안내 시트 존재', /id="acctSheet"/.test(camp) && /id="acctEmpty"/.test(camp));
ok('참여 후 명의 카드·전환 칩·추가참여 버튼', /id="acctBox"/.test(camp) && /id="acctSwitch"/.test(camp) && /id="addSubBtn"/.test(camp));
ok('타계정 목록은 서명 세션 기반 secure profile API로 소유자 범위를 고정',
  /\/api\/reviewer\/profile\/secure/.test(camp) && /headers:_getAuthHeaders\(\)/.test(camp));
ok('secure profile 조회 실패는 타계정 0개로 취급하지 않고 최초 명의 선택을 차단',
  /let _subsLoadError = null/.test(camp)
  && /catch\(e\)\{ _subs = null; _subsLoadError = e; \}/.test(camp)
  && /if\(_subsLoadError\) return toast\('명의 정보를 불러오지 못했습니다/.test(camp));
ok('타계정이 있으면(1인 1회·타계정 허용 공통) 명의를 먼저 선택한 뒤 옵션으로 이동',
  /if\(acctChoiceEnabled\(\)\)[\s\S]{0,180}if\(\(_subs \|\| \[\]\)\.length\) return openAcctSheet\(null, 'option'\)/.test(camp)
  && /function _continueInitialAcct\(\)/.test(camp));
ok('제출 완료: 그 명의만 정리하고 남은 명의는 이어서 진행 CTA', /clearHold\(done\.phone8\)/.test(camp) && /doneNextBtn/.test(camp));

// ── 등록 유도 → 복귀 ──
ok('campaign: 등록 유도는 returnCamp 파라미터로 내정보 이동', /index\.html\?returnCamp=' \+ encodeURIComponent\(CAMP_ID\)/.test(camp));
ok('index: returnCamp 배너 + 형식 검증(오픈 리다이렉트 차단 — 캠페인 id만 허용)',
  /function showSubReturnBanner\(\)/.test(indexHtml) && /\/\^\[A-Za-z0-9_-\]\{1,64\}\$\/\.test\(id\)/.test(indexHtml));
ok('index: 복귀는 내부 campaign.html 경로로만 이동', /location\.href = 'campaign\.html\?id=' \+ encodeURIComponent\(id\)/.test(indexHtml));

console.log(`\n✅ campaignMultiAccountFront: ${passed}개 통과`);
