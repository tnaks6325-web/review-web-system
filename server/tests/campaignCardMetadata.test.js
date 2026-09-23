/** 카드의 유입방식·자동배지 표기가 저장된 작업 설정과 일치하는지 확인한다. */
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..', '..');
const cards = fs.readFileSync(path.join(root, 'frontend', 'js', 'campaign-cards.js'), 'utf8');
const routes = fs.readFileSync(path.join(root, 'server', 'src', 'routes', 'campaign.routes.js'), 'utf8');

/* ★ 검사 의미 불변 — 카드는 **저장된 work_detail 의 유입방식이 우선**이다.
   2026-08-21 부터 저장값이 없을 때만 서버가 실어 준 작업오더 폴백(`orderInflowType`)을 쓴다
   — 리뷰어 화면(work-detail)이 이미 같은 폴백을 쓰므로 카드만 '링크유입'으로 갈리지 않게. */
assert.match(cards, /const inflowType = \(_wd && _wd\.inflowType\) \|\| c\.orderInflowType \|\| ''/,
  '카드는 저장된 work_detail의 유입방식을 우선 사용해야 한다(없을 때만 작업오더 폴백)');
assert.match(cards, /inflowType === 'link'/,
  '카드는 링크유입을 가이드 내용보다 우선해야 한다');
assert.match(cards, /String\(b\) !== '사진 5장\+'/,
  '카드는 과거에 자동 저장된 사진 5장+ 배지를 숨긴다');
assert.match(routes, /const workDetail = sanitizeWorkDetail\(camp\.work_detail\)/,
  '목록 API는 공고에 저장된 유입방식의 정규화 원본을 사용해야 한다');

console.log('campaign card metadata: OK');
