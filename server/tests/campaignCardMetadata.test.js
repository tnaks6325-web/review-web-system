/** 카드의 유입방식·자동배지 표기가 저장된 작업 설정과 일치하는지 확인한다. */
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..', '..');
const cards = fs.readFileSync(path.join(root, 'frontend', 'js', 'campaign-cards.js'), 'utf8');
const routes = fs.readFileSync(path.join(root, 'server', 'src', 'routes', 'campaign.routes.js'), 'utf8');

assert.match(cards, /c\.inflowType === 'link'/,
  '카드는 작업오더의 링크유입 설정을 가이드 내용보다 우선해야 한다');
assert.match(cards, /String\(b\) !== '사진 5장\+'/,
  '카드는 과거에 자동 저장된 사진 5장+ 배지를 숨긴다');
assert.match(routes, /_fetchInflowTypesForCampaigns/,
  '목록 API는 카드용 작업오더 유입방식을 함께 제공해야 한다');
assert.match(routes, /inflowType: inflowMap\.get\(r\.id\) \|\| ''/,
  '관리자 목록 응답에 공고별 유입방식이 포함돼야 한다');

console.log('campaign card metadata: OK');
