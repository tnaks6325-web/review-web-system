/**
 * campCardAdminEdit.test.js — 리뷰어 홈 공고카드 관리자 인라인 수정 회귀가드
 * (admin_token 보유 시 카드 클릭=수정 모달, 저장은 기존 PUT /api/campaign/admin/:id
 *  COALESCE 병합 재사용 = 관리자 대시보드와 동일 원장 즉시 동기화 · 서버 무변경)
 * 실행: node tests/campCardAdminEdit.test.js
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const cc = fs.readFileSync(path.join(__dirname, '..', '..', 'frontend', 'js', 'campaign-cards.js'), 'utf8');

let passed = 0;
function ok(name, cond) { assert(cond, name); passed++; console.log('  ✓ ' + name); }

ok('카드 클릭 = 리뷰어 화면 이동(수정 아님 — 요구사항)',
  /onclick="location\.href='campaign\.html\?id=\$\{encodeURIComponent\(c\.id\)\}'/.test(cc));
ok('수정은 카드의 [✏️ 관리자 수정] 버튼(openAdminEdit)으로만 — 클릭 전파 차단',
  /class="peditchip"[^>]*event\.stopPropagation\(\)[\s\S]*?openAdminEdit\('/.test(cc));
ok('관리자 게이트: admin_token(세션 → 로컬 폴백)',
  /sessionStorage\.getItem\('admin_token'\) \|\| localStorage\.getItem\('admin_token'\)/.test(cc));
ok('✏️ 수정 버튼은 토큰 있을 때만 렌더',
  /_adminTok\(\) \? `<button type="button" class="peditchip"/.test(cc));
ok('저장 = 기존 PUT /api/campaign/admin/:id 재사용(신규 서버 경로 없음)',
  /\/api\/campaign\/admin\/' \+ encodeURIComponent/.test(cc) && /method: 'PUT'/.test(cc));
ok('0-덮어쓰기 방어: 서버 `||0` 강제 필드(max_slots·sort_order)는 로드값 그대로 재전송',
  /max_slots: _caeLoaded\.max_slots/.test(cc) && /sort_order: _caeLoaded\.sort_order/.test(cc));
ok('COALESCE 유지: 모달 밖 필드(channel·work_detail·chat_url 등) 미전송',
  (() => { const save = cc.split('async function _caeSave')[1] || '';
    return !/work_detail/.test(save) && !/chat_url/.test(save) && !/channel_custom/.test(save); })());
ok('만료토큰 센티널: 공개뷰 응답(sort_order 부재)이면 모달 차단(부분 프리필 오염 방지)',
  /data\.sort_order === undefined/.test(cc));
ok('썸네일: guide-image imageUrl 분기 재사용(쿠팡 CDN 수집) + 파일 업로드',
  /\/api\/order\/guide-image/.test(cc) && /imageUrl: url/.test(cc) && /imageBase64: b64/.test(cc));
ok('시간창 빈값=유지(대시보드 폼과 동일 시맨틱 — 모달에서 자율주문 전환 불가 안내)',
  /window_start: _caeV\('cae_ws'\) \|\| null/.test(cc) && /시간창 비우기\(자율주문 전환\)는 대시보드에서/.test(cc));
ok('저장 성공 시 목록 재조회(_onNeedRefresh)',
  /_onNeedRefresh === 'function'/.test(cc));
// ── 요구사항: 닫기 버튼으로만 닫힘 ──
ok('팝업은 바깥 클릭으로 안 닫힘(오버레이 클릭 핸들러 제거)',
  !/ovl\.addEventListener\('click'/.test(cc));
ok('팝업은 [닫기] 버튼으로만 닫힘(caeClose → remove)',
  /#caeClose'\)\.addEventListener\('click', \(\) => ovl\.remove\(\)\)/.test(cc));
ok('저장해도 팝업 유지(저장 성공 경로에 ovl.remove 없음)',
  (() => { const save = cc.split('async function _caeSave')[1] || ''; return !/ovl\.remove\(\)/.test(save); })());
// ── 요구사항: 랜딩 URL 바로가기 버튼(썸네일용 상품페이지 열기) ──
ok('랜딩(상품) URL 바로가기 버튼 → 새 탭으로 상품페이지 열기',
  /id="caeLandingOpen"/.test(cc) && /#caeLandingOpen'\)\.addEventListener\('click'[\s\S]*?window\.open\(u, '_blank'/.test(cc));
ok('모달·토스트 자체 스타일 주입(호출 경로 무관 안전)',
  /function _caeEl\(\) \{\s*_injectStyles\(\);/.test(cc) && /function _toast\(msg, isErr\) \{\s*_injectStyles\(\);/.test(cc));

console.log(`\n✅ campCardAdminEdit: ${passed}개 통과`);
