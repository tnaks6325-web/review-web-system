/**
 * reviewSubmitReturnNavigation.test.js
 * 리뷰 제출 완료 후 레거시 검색화면에 갇히지 않고,
 * 하단 탭바가 있는 리뷰어 홈의 리뷰내역으로 복귀하는지 고정한다.
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const frontend = (file) => fs.readFileSync(path.join(__dirname, '..', '..', 'frontend', file), 'utf8');
const searchHtml = frontend('search.html');
const searchApp = frontend('js/search-app.js');
const indexHtml = frontend('index.html');

let passed = 0;
function ok(name, value) {
  assert.ok(value, name);
  passed++;
  console.log('  ✓ ' + name);
}

console.log('\n▶ 리뷰 제출 완료 복귀 내비게이션\n');

ok('완료 팝업은 레거시 resetApp이 아니라 리뷰 내역 복귀를 호출',
  /onclick="goToReviewerMain\('review'\)"/.test(searchHtml) &&
  !/<button class="btn-primary full-width" onclick="resetApp\(\)">/.test(searchHtml));
ok('버튼 문구와 아이콘이 이동 목적을 정확히 알림',
  /fa-clipboard-list"><\/i>\s*리뷰 내역으로/.test(searchHtml));
ok('리뷰 복귀는 index.html#review로 이동',
  /tab === "review" \? "index\.html#review" : "index\.html"/.test(searchApp));
ok('독립 검색 로그인의 인증을 리뷰어 홈 저장소로 승계',
  /function _syncReviewerHomeSessionForReturn\(\)[\s\S]*iad_reviewer_home_session[\s\S]*iad_reviewer_user/.test(searchApp) &&
  /_syncReviewerHomeSessionForReturn\(\);[\s\S]{0,200}window\.location\.href/.test(searchApp));
ok('관리자 홈 탭 인증은 sessionStorage 격리를 유지',
  /reviewerStore === sessionStorage[\s\S]{0,200}adminPreview: true/.test(searchApp));
ok('리뷰어 홈이 #review를 제출완료 서브탭으로 염',
  /location\.hash === "#review"[\s\S]{0,150}switchReviewSubTab\("done"\)[\s\S]{0,100}switchTab\("review"\)/.test(indexHtml));
ok('복귀 목적지에 하단 탭바와 리뷰내역 버튼이 존재',
  /<div class="tabbar">/.test(indexHtml) && /class="tab-review"[^>]*switchTab\('review'\)/.test(indexHtml));

console.log(`\n✅ reviewSubmitReturnNavigation: ${passed}개 통과\n`);
